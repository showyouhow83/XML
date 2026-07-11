// "Ask AI" — natural-language questions over the invoices table.
//
// This drives accounting/tax data, so it's built to avoid silent wrong answers:
//   1. Claude (Opus) REASONS about the schema, then writes a read-only SELECT.
//   2. A second Claude pass REVIEWS that SQL for the classic traps (vendor vs.
//      client, mixing CRC+USD, wrong date window, wrong aggregate) and corrects it.
//   3. We validate the SQL is a single read-only SELECT over `invoices` only,
//      run it on D1 (one self-repair on a DB error), and
//   4. Claude summarizes the rows AND states the assumptions it made.
// If a question is genuinely ambiguous, Claude asks for clarification instead of
// guessing. The page always shows the SQL + rows so every number is auditable.
import Anthropic from '@anthropic-ai/sdk';

// Which model runs each of the three steps. Defaults to Opus everywhere (best
// accuracy). Configurable so we can A/B a cheaper setup — e.g. cheap SQL-gen +
// summary with an Opus review — via the ai-quiz harness or Worker env vars.
export interface ModelConfig {
  sql: string;
  review: string;
  summary: string;
}
export const DEFAULT_MODELS: ModelConfig = {
  sql: 'claude-opus-4-8',
  review: 'claude-opus-4-8',
  summary: 'claude-opus-4-8',
};

// Adaptive extended thinking is available on Opus/Sonnet 4.6+ (and Fable/Mythos 5).
// Older tiers (e.g. Haiku 4.5) reject `{type:'adaptive'}`, so omit thinking there.
function thinkingFor(model: string): Anthropic.ThinkingConfigParam | undefined {
  return /(opus-4-(6|7|8)|sonnet-(5|4-6)|fable-5|mythos-5)/.test(model) ? { type: 'adaptive' } : undefined;
}

// Described to the model so it can write correct SQL. Keep in sync with db.ts.
const SCHEMA_DOC = `Table: invoices  (SQLite dialect — this is the ONLY table you may query)

One row per Costa Rican electronic invoice (Hacienda comprobante) collected from a client mailbox.

Columns:
  clave           TEXT  50-digit Hacienda key (primary key)
  doc_type        TEXT  document type: 'Factura', 'Tiquete', 'Nota de Crédito', 'Nota de Débito'
  consecutivo     TEXT  the issuer's consecutive number
  fecha_emision   TEXT  issue date/time, ISO 8601 (e.g. '2025-06-15T10:30:00'). Compare as text or use substr()/strftime().
  emisor_nombre   TEXT  ISSUER / vendor / supplier name (who sent/created the invoice)
  emisor_id       TEXT  issuer's cédula (tax ID)
  emisor_email    TEXT
  receptor_nombre TEXT  RECIPIENT / customer name (your client, who received/paid it)
  receptor_id     TEXT  recipient's cédula
  receptor_email  TEXT
  moneda          TEXT  currency code: 'CRC' (colones) or 'USD' (dollars)
  tipo_cambio     REAL  exchange rate to CRC when moneda='USD'
  codigo_actividad TEXT economic-activity code
  condicion_venta TEXT  sale condition (e.g. contado, crédito)
  iva_rate        REAL  IVA (VAT) rate as a PERCENT — 13 means 13%, not 0.13
  total_gravado   REAL  taxable subtotal
  total_exento    REAL  tax-exempt subtotal
  total_exonerado REAL  exonerated subtotal
  total_descuentos REAL total discounts
  total_venta_neta REAL net sale (subtotal before tax)
  total_impuesto  REAL  total tax amount
  total_otros_cargos REAL other charges
  total_comprobante REAL GRAND TOTAL of the invoice
  source_account  TEXT  mailbox email the invoice was collected from
  has_pdf         INTEGER 1 if a matching PDF is stored, else 0
  received_at     TEXT  when the email arrived, ISO 8601
  detail_json     TEXT  JSON with line items / tax breakdown (prefer the columns above for reliable math)
  created_at      TEXT  when the row was stored

Rules that MUST be followed to avoid wrong numbers:
  - CURRENCY: every total_* amount is in that row's own \`moneda\`. NEVER SUM or compare amounts across
    currencies. Whenever you aggregate money, add moneda to the SELECT and GROUP BY moneda so CRC and USD
    stay separate.
  - VENDOR vs CLIENT: emisor_* = the vendor/supplier that issued the invoice; receptor_* = your client that
    received it. "proveedor/vendor/supplier/de quién compré" → group/filter by emisor. "cliente" → receptor.
  - DATES are TEXT ISO strings: a month is substr(fecha_emision,1,7)='2025-06'; a year is
    substr(fecha_emision,1,4)='2025'; a range uses fecha_emision >= '2025-01-01' AND fecha_emision < '2025-04-01'.
  - WHOSE INVOICES: these are documents your client RECEIVED (bought), so the receptor is your client's own
    cédula (usually just one or a few) and the emisor is the outside vendor. So when the user names a cédula or
    company and asks how much was "spent" / "gastos" / "paid" / "cost", they almost always mean a VENDOR — filter
    by emisor_id (or emisor_nombre). Treat a named cédula as the receptor ONLY if they explicitly say "my
    company", "buyer", "client", or "receptor". If filtering by one role returns no rows, the entity is probably
    the other role — switch emisor_id <-> receptor_id and try again.
    Do NOT ask the user to clarify vendor-vs-client for a spend question — default to the vendor (emisor) and
    answer. This applies equally in Spanish ("¿cuánto gasté con X?", "cuánto le compré a X", "gastos con X") and
    English ("how much did I spend with X").
  - Prefer aggregates (SUM, COUNT, AVG, GROUP BY) so results are compact and checkable.
  - Match names case-insensitively, e.g. emisor_nombre LIKE '%liberty%'.`;

const SQL_SYSTEM = `You translate a question about an invoice database into ONE read-only SQLite SELECT, then call the query_invoices tool with it. This is accounting data, so correctness matters more than anything.

${SCHEMA_DOC}

Think step by step before answering: which entity (emisor vs receptor), how to keep currencies separate, the exact date filter, and the right aggregate. Produce ONE SELECT (or WITH … SELECT) over the invoices table only — never write or touch any other table.

Earlier turns in this conversation are context — resolve references like "that vendor", "the first one", "just INS", or a bare cédula the user pulled from a previous answer against them (e.g. a cédula shown as an issuer in the last table is an emisor).

If the question is genuinely ambiguous or asks for something the schema can't answer, DO NOT guess: reply with a short clarifying question in plain text (in the user's own language) instead of calling the tool. Otherwise, always call query_invoices with your final SQL.`;

const REVIEW_SYSTEM = `You are a meticulous reviewer checking a SQLite SELECT before it runs against a Costa Rican invoice database used for tax/accounting. Given the schema, the user's question, and a candidate query, decide whether it correctly and completely answers the question.

${SCHEMA_DOC}

Scrutinize especially: emisor (vendor) vs receptor (client) mix-ups; summing across currencies without GROUP BY moneda; off-by-one or wrong date ranges; wrong aggregate (SUM vs COUNT vs AVG); missing or extra filters; wrong column. Only propose a change when there is a REAL error — if the query already answers the question, approve it unchanged. When you correct it, return a single read-only SELECT over invoices only. Call report_review with your verdict.`;

const SUMMARY_SYSTEM = `You answer the user's question using the SQL result rows provided.

- Reply in the SAME LANGUAGE as the user's question: if they ask in Spanish, answer in Spanish (Costa Rican Spanish is natural here); if in English, answer in English. Use that language for the table headers too.
- Be concise and direct; lead with the number or fact they asked for.
- When the result is a breakdown or list of several rows, present it as a compact **Markdown table** with a clear header row (the UI renders it), and give the headline total in a sentence next to it. For a single number, just state it.
- Monetary amounts are in each row's \`moneda\` (CRC = Costa Rican colones, USD = US dollars). Always state the currency and keep CRC and USD totals separate. Format large numbers readably (e.g. ₡1,234,567.89 or $1,234.56).
- iva_rate values are percentages (13 = 13%).
- End with a one-line "Assumptions:" note stating how you read the question (date range interpreted, vendor vs client, currency handling) so the user can catch a misread.
- If there are no rows, say plainly that no matching invoices were found.
- Never invent data that isn't in the rows. Don't print the SQL (the UI shows it separately).`;

const QUERY_TOOL: Anthropic.Tool = {
  name: 'query_invoices',
  description: 'Run one read-only SQLite SELECT against the invoices table and return the rows.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'A single read-only SQLite SELECT statement over the invoices table.' },
    },
    required: ['sql'],
  },
};

const REVIEW_TOOL: Anthropic.Tool = {
  name: 'report_review',
  description: 'Report whether the candidate SQL correctly answers the question.',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'true if the candidate SQL correctly and completely answers the question as-is' },
      corrected_sql: { type: 'string', description: 'If not ok, a corrected single read-only SELECT over invoices. Omit when ok.' },
      note: { type: 'string', description: 'Brief reason for the correction (optional).' },
    },
    required: ['ok'],
  },
};

export interface AskResult {
  answer: string;
  sql: string | null;
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  clarify?: boolean; // true when the model asked for clarification instead of answering
  error?: string;
}

// A prior exchange, passed back so follow-up questions have context.
export interface AskTurn {
  question: string;
  sql?: string | null;
  answer?: string;
}

type Validation = { ok: true; sql: string } | { ok: false; error: string };

// Guarantee the model's SQL is a single, read-only SELECT limited to `invoices`.
export function validateReadonlySelect(raw: string): Validation {
  let sql = (raw || '').trim();
  if (!sql) return { ok: false, error: 'No SQL was generated.' };
  sql = sql.replace(/;\s*$/, '').trim(); // allow one trailing semicolon

  if (sql.includes('--') || sql.includes('/*')) {
    return { ok: false, error: 'Generated SQL contained comments; rejected for safety.' };
  }

  // Analyze with string literals blanked so keywords/table names inside quoted
  // values (e.g. LIKE '%create%') don't trip the checks below.
  const analysis = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .toLowerCase();

  if (analysis.includes(';')) return { ok: false, error: 'Only a single statement is allowed.' };
  if (!/^\s*(select|with)\b/.test(analysis)) return { ok: false, error: 'Only SELECT queries are allowed.' };
  if (/\b(insert|update|delete|drop|alter|create|truncate|attach|detach|pragma|vacuum|reindex|grant|revoke)\b/.test(analysis)) {
    return { ok: false, error: 'Only read-only queries are allowed.' };
  }
  if (/\b(mailboxes|attachments)\b/.test(analysis) || analysis.includes('sqlite_')) {
    return { ok: false, error: 'Queries may only read the invoices table.' };
  }

  if (!/\blimit\b/.test(analysis)) sql += ' LIMIT 500';
  return { ok: true, sql };
}

const MAX_SUMMARY_ROWS = 100;

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function toolUseOf(res: Anthropic.Message, name: string): Anthropic.ToolUseBlock | undefined {
  return res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === name);
}

// Second opinion: let Claude review the candidate SQL and correct genuine errors.
async function reviewSql(client: Anthropic, question: string, sql: string, model: string): Promise<string> {
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 6000,
      thinking: thinkingFor(model),
      system: REVIEW_SYSTEM,
      tools: [REVIEW_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Question: ${question}\n\nCandidate SQL:\n${sql}` }],
    });
    const tool = toolUseOf(res, 'report_review');
    const input = tool?.input as { ok?: boolean; corrected_sql?: string } | undefined;
    if (input && input.ok === false && typeof input.corrected_sql === 'string') {
      const corrected = validateReadonlySelect(input.corrected_sql);
      if (corrected.ok) return corrected.sql; // only accept a valid correction
    }
  } catch {
    // Review is a best-effort safety net; on any failure keep the original SQL.
  }
  return sql;
}

async function summarize(
  client: Anthropic,
  question: string,
  sql: string,
  rows: Record<string, unknown>[],
  model: string
): Promise<string> {
  const shown = rows.slice(0, MAX_SUMMARY_ROWS);
  const truncated = rows.length > MAX_SUMMARY_ROWS;
  const res = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SUMMARY_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Question: ${question}\n\n` +
          `SQL executed:\n${sql}\n\n` +
          `Returned ${rows.length} row(s)${truncated ? ` (showing the first ${MAX_SUMMARY_ROWS})` : ''}:\n` +
          JSON.stringify(shown, null, 2),
      },
    ],
  });
  return textOf(res);
}

/**
 * Answer a natural-language question about the invoices.
 * Generates SQL (with reasoning), reviews it, runs it (one self-repair on a DB
 * error), then summarizes. Returns the answer plus the SQL and rows for display.
 */
export async function askInvoices(
  db: D1Database,
  apiKey: string,
  question: string,
  history: AskTurn[] = [],
  models: ModelConfig = DEFAULT_MODELS
): Promise<AskResult> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  const messages: Anthropic.MessageParam[] = [];
  // Seed prior turns so follow-ups ("that vendor", "just INS", a cédula from the
  // last table) resolve. Keep it compact: the question + how it was answered.
  for (const h of history.slice(-6)) {
    if (!h?.question) continue;
    messages.push({ role: 'user', content: String(h.question).slice(0, 500) });
    const note =
      [h.sql ? `I queried: ${h.sql}` : null, h.answer ? `I answered: ${String(h.answer).slice(0, 600)}` : null]
        .filter(Boolean)
        .join('\n') || '(answered)';
    messages.push({ role: 'assistant', content: note });
  }
  messages.push({ role: 'user', content: question });
  const empty = { sql: null, rows: [], rowCount: 0, truncated: false };
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const gen = await client.messages.create({
      model: models.sql,
      max_tokens: 6000,
      thinking: thinkingFor(models.sql),
      system: SQL_SYSTEM,
      tools: [QUERY_TOOL],
      tool_choice: { type: 'auto' },
      messages,
    });

    const genTool = toolUseOf(gen, 'query_invoices');
    if (!genTool) {
      // The model declined to guess and asked for clarification (or said nothing).
      const text = textOf(gen);
      return {
        answer: text || 'I need a bit more detail to answer that accurately.',
        ...empty,
        clarify: true,
      };
    }

    const valid = validateReadonlySelect(String((genTool.input as { sql?: unknown })?.sql ?? ''));
    if (!valid.ok) {
      return { answer: '', ...empty, sql: String((genTool.input as { sql?: unknown })?.sql ?? ''), error: valid.error };
    }

    // Second-opinion review + correction of genuine errors.
    const sql = await reviewSql(client, question, valid.sql, models.review);

    try {
      const { results } = await db.prepare(sql).all<Record<string, unknown>>();
      const rows = results ?? [];
      // Zero rows on the first try often means the entity was filtered under the
      // wrong role (emisor vs receptor) — let the model reconsider once.
      if (rows.length === 0 && attempt === 0) {
        messages.push(
          { role: 'assistant', content: gen.content },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: genTool.id,
                content: `The query I ran was:\n${sql}\nIt returned 0 rows. If you filtered by a cédula or company name, it may be the OTHER party (try swapping emisor_id <-> receptor_id) or the filter is too strict — reconsider and try again. If you are confident there is genuinely no matching data, run the same query again to confirm.`,
              },
            ],
          }
        );
        continue;
      }
      const answer = await summarize(client, question, sql, rows, models.summary);
      return { answer, sql, rows: rows.slice(0, MAX_SUMMARY_ROWS), rowCount: rows.length, truncated: rows.length > MAX_SUMMARY_ROWS };
    } catch (err) {
      lastError = (err as Error).message;
      // Feed the DB error back once so the model can correct the query.
      messages.push(
        { role: 'assistant', content: gen.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: genTool.id,
              content: `The query failed with: ${lastError}. Rewrite the SELECT to fix it.`,
              is_error: true,
            },
          ],
        }
      );
    }
  }

  return { answer: '', ...empty, error: `Could not run the query: ${lastError}` };
}
