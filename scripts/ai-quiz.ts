/*
 * Ivan accuracy quiz. Seeds a synthetic invoice set with KNOWN answers, then asks
 * Ivan (askInvoices) a battery of questions under different model configs and
 * grades each against ground truth computed from the same data.
 *
 * Run (needs your Anthropic key):
 *   ANTHROPIC_API_KEY=sk-ant-... npm run ai-quiz            # opus + hybrid
 *   ANTHROPIC_API_KEY=sk-ant-... npm run ai-quiz -- hybrid  # just one
 *   ANTHROPIC_API_KEY=sk-ant-... npm run ai-quiz -- opus hybrid sonnet haiku
 *
 * Configs:
 *   opus   — Opus for all 3 steps (current default; the accuracy baseline)
 *   hybrid — cheap SQL-gen + summary, Opus verification in the middle
 *   sonnet — Sonnet for all 3
 *   haiku  — Haiku for all 3
 *
 * Each question runs the full pipeline (write SQL → review → run → summarize), so
 * this costs real API tokens. Grading checks the returned rows + answer text
 * contain the expected number(s) within tolerance.
 */
import { DatabaseSync } from 'node:sqlite';
import { askInvoices, DEFAULT_MODELS, type ModelConfig } from '../src/lib/ai.ts';

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error('Set ANTHROPIC_API_KEY to run the quiz.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Synthetic data (we know every value, so we can compute exact answers).
// total_comprobante = the invoice total ("spend"); IVA = 13% of it.
// ---------------------------------------------------------------------------
const VEND: Record<string, string> = { ACME: '3101000001', GLOBEX: '3101000002', INITECH: '3101000003' };
const RECEPTOR = { nombre: 'MI EMPRESA S.A.', id: '3101999999' };

interface Inv { clave: string; v: string; id: string; cur: string; date: string; total: number; type: string }
const mk = (v: string, cur: string, date: string, total: number, type = 'Factura'): Inv => ({ clave: '', v, id: VEND[v], cur, date, total, type });

const INV: Inv[] = [
  mk('ACME', 'CRC', '2025-01-10', 100000),
  mk('ACME', 'CRC', '2025-02-10', 150000),
  mk('ACME', 'CRC', '2025-03-10', 200000),
  mk('ACME', 'CRC', '2025-04-10', 250000),
  mk('ACME', 'CRC', '2025-05-10', 120000),
  mk('ACME', 'CRC', '2025-06-10', 180000),
  mk('ACME', 'CRC', '2024-11-10', 90000),
  mk('ACME', 'CRC', '2024-12-10', 110000),
  mk('GLOBEX', 'USD', '2025-02-15', 1000),
  mk('GLOBEX', 'USD', '2025-04-15', 2000),
  mk('GLOBEX', 'USD', '2025-06-15', 1500),
  mk('GLOBEX', 'USD', '2025-08-15', 500),
  mk('INITECH', 'CRC', '2025-03-20', 50000),
  mk('INITECH', 'CRC', '2025-07-20', 75000),
  mk('INITECH', 'CRC', '2025-09-20', 25000),
];
INV.forEach((x, i) => { x.clave = '506' + String(i).padStart(47, '0'); });

const year = (d: string) => Number(d.slice(0, 4));
const ym = (d: string) => d.slice(0, 7);
const round2 = (n: number) => Math.round(n * 100) / 100;
const spend = (f: (x: Inv) => boolean) => INV.filter(f).reduce((s, x) => s + x.total, 0);
const iva = (f: (x: Inv) => boolean) => round2(INV.filter(f).reduce((s, x) => s + x.total * 0.13, 0));
const count = (f: (x: Inv) => boolean) => INV.filter(f).length;

const INVOICES_DDL = `CREATE TABLE invoices (
  clave TEXT PRIMARY KEY, doc_type TEXT, doc_type_raw TEXT, consecutivo TEXT,
  fecha_emision TEXT, emisor_nombre TEXT, emisor_id TEXT, emisor_email TEXT,
  receptor_nombre TEXT, receptor_id TEXT, receptor_email TEXT, moneda TEXT,
  tipo_cambio REAL, codigo_actividad TEXT, condicion_venta TEXT, iva_rate REAL,
  total_gravado REAL, total_exento REAL, total_exonerado REAL,
  total_descuentos REAL, total_venta_neta REAL, total_impuesto REAL,
  total_otros_cargos REAL, total_comprobante REAL, source_account TEXT,
  message_uid TEXT, xml_filename TEXT, pdf_filename TEXT,
  has_pdf INTEGER NOT NULL DEFAULT 0, received_at TEXT, detail_json TEXT,
  created_at TEXT NOT NULL
)`;

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(INVOICES_DDL);
  const stmt = db.prepare(
    `INSERT INTO invoices (clave, doc_type, consecutivo, fecha_emision, emisor_nombre, emisor_id,
       receptor_nombre, receptor_id, moneda, iva_rate, total_venta_neta, total_impuesto,
       total_comprobante, has_pdf, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  INV.forEach((x, i) => {
    const tax = round2(x.total * 0.13);
    stmt.run(x.clave, x.type, String(1000 + i), x.date + 'T10:00:00', x.v + ' S.A.', x.id,
      RECEPTOR.nombre, RECEPTOR.id, x.cur, 13, round2(x.total - tax), tax, x.total, 0, '2026-01-01');
  });
  return db;
}

// Minimal D1-shaped adapter over node:sqlite so askInvoices can run unchanged.
function d1(db: DatabaseSync): any {
  return {
    prepare(sql: string) {
      let args: any[] = [];
      return {
        bind(...a: any[]) { args = a; return this; },
        async all() { return { results: db.prepare(sql).all(...args), success: true, meta: {} }; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
      };
    },
    async batch(stmts: any[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
  };
}

// ---------------------------------------------------------------------------
// Questions + expected answers (computed from INV, so no hand math to get wrong).
// ---------------------------------------------------------------------------
interface Q { q: string; nums: number[]; contains?: string[] }
const QUESTIONS: Q[] = [
  { q: '¿Cuánto gasté con ACME en 2025?', nums: [spend((x) => x.v === 'ACME' && year(x.date) === 2025)] },
  { q: 'How much did I spend with GLOBEX in 2025?', nums: [spend((x) => x.v === 'GLOBEX' && year(x.date) === 2025)] },
  { q: 'How many invoices are there in total?', nums: [INV.length] },
  { q: 'How many invoices are dated in 2025?', nums: [count((x) => year(x.date) === 2025)] },
  { q: 'Total IVA paid in 2025 in colones (CRC)', nums: [iva((x) => year(x.date) === 2025 && x.cur === 'CRC')] },
  { q: 'What is my total spend in 2025, grouped by currency?', nums: [spend((x) => year(x.date) === 2025 && x.cur === 'CRC'), spend((x) => year(x.date) === 2025 && x.cur === 'USD')] },
  { q: 'Which vendor did I spend the most with in 2025 (in colones)?', nums: [spend((x) => x.v === 'ACME' && year(x.date) === 2025)], contains: ['acme'] },
  { q: 'How many invoices from ACME are there in total?', nums: [count((x) => x.v === 'ACME')] },
  { q: 'What was my total spend in 2024?', nums: [spend((x) => year(x.date) === 2024)] },
  { q: 'How many invoices are dated March 2025?', nums: [count((x) => ym(x.date) === '2025-03')] },
  { q: 'How much did I spend with vendor cédula 3101000001 in 2025?', nums: [spend((x) => x.id === '3101000001' && year(x.date) === 2025)] },
  { q: 'How many different vendors are there?', nums: [new Set(INV.map((x) => x.id)).size] },
  { q: 'What is the largest single invoice total in 2025 in colones?', nums: [Math.max(...INV.filter((x) => year(x.date) === 2025 && x.cur === 'CRC').map((x) => x.total))] },
  { q: 'Total spend with INITECH (all time)', nums: [spend((x) => x.v === 'INITECH')] },
  { q: 'How much did I spend in total in colones (CRC), all years?', nums: [spend((x) => x.cur === 'CRC')] },
  { q: 'Average invoice total in 2025 in colones', nums: [round2(spend((x) => year(x.date) === 2025 && x.cur === 'CRC') / count((x) => year(x.date) === 2025 && x.cur === 'CRC'))] },
  { q: 'Show total spend per vendor in 2025 (colones only)', nums: [spend((x) => x.v === 'ACME' && year(x.date) === 2025 && x.cur === 'CRC'), spend((x) => x.v === 'INITECH' && year(x.date) === 2025 && x.cur === 'CRC')], contains: ['acme', 'initech'] },
  { q: 'How much IVA did I pay to ACME in 2025?', nums: [iva((x) => x.v === 'ACME' && year(x.date) === 2025)] },
];

function extractNums(answer: string, rows: any[]): number[] {
  const out: number[] = [];
  for (const r of rows || []) for (const k in r) if (typeof r[k] === 'number') out.push(r[k]);
  const txt = String(answer || '').replace(/[,₡$]/g, '');
  for (const m of txt.match(/-?\d+(?:\.\d+)?/g) || []) out.push(Number(m));
  return out;
}
const near = (cands: number[], e: number) => cands.some((v) => Math.abs(v - e) <= Math.max(0.5, Math.abs(e) * 0.005));

const CONFIGS: Record<string, ModelConfig> = {
  opus: DEFAULT_MODELS,
  hybrid: { sql: 'claude-sonnet-5', review: 'claude-opus-4-8', summary: 'claude-haiku-4-5' },
  sonnet: { sql: 'claude-sonnet-5', review: 'claude-sonnet-5', summary: 'claude-sonnet-5' },
  haiku: { sql: 'claude-haiku-4-5', review: 'claude-haiku-4-5', summary: 'claude-haiku-4-5' },
};

async function main() {
  const asked = process.argv.slice(2).filter((a) => CONFIGS[a]);
  const configs = asked.length ? asked : ['opus', 'hybrid'];
  console.log(`Quiz: ${QUESTIONS.length} questions × ${configs.length} config(s) [${configs.join(', ')}]\n`);

  // A clarification (Ivan asks vendor-vs-client instead of answering) is a SAFE
  // non-answer, not a wrong answer — so we bucket correct / clarified / wrong.
  const summary: Record<string, { correct: number; clarified: number; wrong: number }> = {};
  for (const name of configs) {
    const models = CONFIGS[name];
    console.log(`\n=== ${name.toUpperCase()}  (sql=${models.sql}, review=${models.review}, summary=${models.summary}) ===`);
    const db = d1(seedDb());
    let correct = 0, clarified = 0, wrong = 0;
    for (const Q of QUESTIONS) {
      try {
        const r = await askInvoices(db, KEY!, Q.q, [], models);
        if (r.clarify) {
          clarified++;
          console.log(`~ ${Q.q}  (asked to clarify — not wrong)`);
          continue;
        }
        const cands = extractNums(r.answer, r.rows as any[]);
        const numsOk = Q.nums.every((e) => near(cands, e));
        const hay = (String(r.answer) + ' ' + JSON.stringify(r.rows)).toLowerCase();
        const contOk = (Q.contains || []).every((s) => hay.includes(s));
        if (!r.error && numsOk && contOk) {
          correct++;
          console.log(`✓ ${Q.q}`);
        } else {
          wrong++;
          console.log(`✗ ${Q.q}`);
          console.log(`    want ${JSON.stringify(Q.nums)}${Q.contains ? ' + ' + JSON.stringify(Q.contains) : ''} | sql: ${r.sql ?? r.error} | got: ${(r.answer || '').replace(/\n/g, ' ').slice(0, 140)}`);
        }
      } catch (e) {
        wrong++;
        console.log(`✗ ${Q.q}  — ERROR ${(e as Error).message}`);
      }
    }
    summary[name] = { correct, clarified, wrong };
    console.log(`→ ${name}: ${correct} correct · ${clarified} clarified · ${wrong} wrong  (of ${QUESTIONS.length})`);
  }

  console.log('\n===== SUMMARY (correct · clarified · wrong) =====');
  for (const name of configs) {
    const s = summary[name];
    console.log(`${name.padEnd(8)} ${s.correct} correct · ${s.clarified} clarified · ${s.wrong} wrong`);
  }
  console.log('\n(what matters most: "wrong" = an actually incorrect number. clarified = safely asked instead of guessing.)');
}

main().catch((e) => { console.error(e); process.exit(1); });
