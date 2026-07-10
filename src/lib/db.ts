// D1 data-access layer: schema bootstrap + all queries for mailboxes and invoices.
import type { ExtractedInvoice } from './invoice';
import { encryptSecret, decryptSecret } from './crypto';

// ---------------------------------------------------------------------------
// Schema (mirrors migrations/0001_init.sql so the app also works if the user
// never runs `wrangler d1 migrations apply`).
// ---------------------------------------------------------------------------
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT, email TEXT UNIQUE NOT NULL, host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 993, username TEXT NOT NULL,
    password_enc TEXT NOT NULL, use_ssl INTEGER NOT NULL DEFAULT 1,
    lookback_days INTEGER NOT NULL DEFAULT 30, active INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT, last_status TEXT, synced_from TEXT,
    last_uid INTEGER, uidvalidity INTEGER, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invoices (
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
  )`,
  `CREATE TABLE IF NOT EXISTS attachments (
    clave TEXT PRIMARY KEY, xml_content TEXT, pdf_content TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_fecha ON invoices(fecha_emision)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_emisor ON invoices(emisor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_account ON invoices(source_account)`,
];

// Columns added after the first release — applied to pre-existing invoices tables
// via ALTER (ignored if already present). Keeps older databases in sync.
const ADDED_INVOICE_COLUMNS: Array<[string, string]> = [
  ['emisor_email', 'TEXT'], ['receptor_email', 'TEXT'], ['tipo_cambio', 'REAL'],
  ['codigo_actividad', 'TEXT'], ['condicion_venta', 'TEXT'], ['iva_rate', 'REAL'],
  ['total_exonerado', 'REAL'], ['total_otros_cargos', 'REAL'], ['detail_json', 'TEXT'],
];

const ADDED_MAILBOX_COLUMNS: Array<[string, string]> = [
  ['synced_from', 'TEXT'], ['last_uid', 'INTEGER'], ['uidvalidity', 'INTEGER'],
];

let schemaReady = false;
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const alters: Array<[string, string, string]> = [
    ...ADDED_INVOICE_COLUMNS.map(([c, t]) => ['invoices', c, t] as [string, string, string]),
    ...ADDED_MAILBOX_COLUMNS.map(([c, t]) => ['mailboxes', c, t] as [string, string, string]),
  ];
  for (const [table, col, type] of alters) {
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
    } catch {
      // column already exists — fine
    }
  }
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------
export interface MailboxRow {
  id: number;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  use_ssl: number;
  lookback_days: number;
  active: number;
  last_synced_at: string | null;
  last_status: string | null;
  synced_from: string | null;
  created_at: string;
}

export interface MailboxInput {
  label?: string;
  email: string;
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
  lookbackDays: number;
}

const MAILBOX_PUBLIC_COLS =
  'id, label, email, host, port, username, use_ssl, lookback_days, active, last_synced_at, last_status, synced_from, created_at';

export async function listMailboxes(db: D1Database): Promise<MailboxRow[]> {
  const { results } = await db
    .prepare(`SELECT ${MAILBOX_PUBLIC_COLS} FROM mailboxes ORDER BY label, email`)
    .all<MailboxRow>();
  return results ?? [];
}

export async function createMailbox(db: D1Database, input: MailboxInput, encKey: string): Promise<void> {
  const passwordEnc = await encryptSecret(input.password, encKey);
  await db
    .prepare(
      `INSERT INTO mailboxes (label, email, host, port, username, password_enc, use_ssl, lookback_days, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(email) DO UPDATE SET
         label=excluded.label, host=excluded.host, port=excluded.port,
         username=excluded.username, password_enc=excluded.password_enc,
         use_ssl=excluded.use_ssl, lookback_days=excluded.lookback_days, active=1`
    )
    .bind(
      input.label ?? null,
      input.email,
      input.host,
      input.port,
      input.username,
      passwordEnc,
      input.useSsl ? 1 : 0,
      input.lookbackDays,
      new Date().toISOString()
    )
    .run();
}

export async function deleteMailbox(db: D1Database, id: number): Promise<void> {
  await db.prepare(`DELETE FROM mailboxes WHERE id = ?`).bind(id).run();
}

/** How many invoices we've stored per mailbox address. */
export async function mailboxInvoiceCounts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(`SELECT source_account AS email, COUNT(*) AS n FROM invoices WHERE source_account IS NOT NULL GROUP BY source_account`)
    .all<{ email: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results ?? []) out[r.email] = r.n;
  return out;
}

export interface CollectorMailbox {
  id: number;
  label: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl: boolean;
  lookbackDays: number;
  lastSyncedAt: string | null;
  // Incremental-sync watermark: highest IMAP UID already collected, and the
  // folder's UIDVALIDITY when we recorded it (if it changes, re-scan fully).
  lastUid: number | null;
  uidvalidity: number | null;
}

/** Active mailboxes with DECRYPTED passwords — only for the authenticated collector. */
export async function listMailboxesForCollector(db: D1Database, encKey: string): Promise<CollectorMailbox[]> {
  const { results } = await db
    .prepare(
      `SELECT id, label, email, host, port, username, password_enc, use_ssl, lookback_days,
              last_synced_at, last_uid, uidvalidity
       FROM mailboxes WHERE active = 1 ORDER BY id`
    )
    .all<any>();
  const out: CollectorMailbox[] = [];
  for (const r of results ?? []) {
    out.push({
      id: r.id,
      label: r.label,
      email: r.email,
      host: r.host,
      port: r.port,
      username: r.username,
      password: await decryptSecret(r.password_enc, encKey),
      useSsl: r.use_ssl === 1,
      lookbackDays: r.lookback_days,
      lastSyncedAt: r.last_synced_at,
      lastUid: r.last_uid ?? null,
      uidvalidity: r.uidvalidity ?? null,
    });
  }
  return out;
}

export async function setMailboxStatus(
  db: D1Database,
  id: number,
  status: string,
  syncedAt?: string
): Promise<void> {
  await db
    .prepare(`UPDATE mailboxes SET last_status = ?, last_synced_at = COALESCE(?, last_synced_at) WHERE id = ?`)
    .bind(status.slice(0, 300), syncedAt ?? null, id)
    .run();
}

/** Finalize a sync: set status + last_synced_at, and extend synced_from backward
 * to the oldest date this run covered (so we know how far the history goes). */
export async function recordSync(
  db: D1Database,
  id: number,
  opts: {
    status: string;
    syncedAt: string;
    syncedFrom?: string | null;
    lastUid?: number | null;
    uidvalidity?: number | null;
  }
): Promise<void> {
  const from = opts.syncedFrom ?? null;
  const lastUid = typeof opts.lastUid === 'number' ? opts.lastUid : null;
  const uidvalidity = typeof opts.uidvalidity === 'number' ? opts.uidvalidity : null;
  await db
    .prepare(
      `UPDATE mailboxes SET last_status = ?, last_synced_at = ?,
         synced_from = CASE
           WHEN ? IS NULL THEN synced_from
           WHEN synced_from IS NULL OR ? < synced_from THEN ?
           ELSE synced_from END,
         last_uid = COALESCE(?, last_uid),
         uidvalidity = COALESCE(?, uidvalidity)
       WHERE id = ?`
    )
    .bind(opts.status.slice(0, 300), opts.syncedAt, from, from, from, lastUid, uidvalidity, id)
    .run();
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export interface IngestRecord extends ExtractedInvoice {
  sourceAccount: string;
  messageUid: string | null;
  xmlFilename: string | null;
  xmlContent: string;
  pdfFilename: string | null;
  pdfContentBase64: string | null;
  receivedAt: string | null;
}

/** Insert or update one invoice + its attachments. Returns 'inserted' or 'updated'. */
export async function upsertInvoice(db: D1Database, r: IngestRecord): Promise<'inserted' | 'updated'> {
  const existing = await db.prepare(`SELECT 1 FROM invoices WHERE clave = ?`).bind(r.clave).first();
  const now = new Date().toISOString();
  const hasPdf = r.pdfContentBase64 ? 1 : 0;
  const detailJson = r.detail ? JSON.stringify(r.detail) : null;

  await db.batch([
    db
      .prepare(
        `INSERT INTO invoices (
           clave, doc_type, doc_type_raw, consecutivo, fecha_emision,
           emisor_nombre, emisor_id, emisor_email, receptor_nombre, receptor_id,
           receptor_email, moneda, tipo_cambio, codigo_actividad, condicion_venta,
           iva_rate, total_gravado, total_exento, total_exonerado, total_descuentos,
           total_venta_neta, total_impuesto, total_otros_cargos, total_comprobante,
           source_account, message_uid, xml_filename, pdf_filename, has_pdf,
           received_at, detail_json, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(clave) DO UPDATE SET
           doc_type=excluded.doc_type, doc_type_raw=excluded.doc_type_raw,
           consecutivo=excluded.consecutivo, fecha_emision=excluded.fecha_emision,
           emisor_nombre=excluded.emisor_nombre, emisor_id=excluded.emisor_id,
           emisor_email=excluded.emisor_email, receptor_nombre=excluded.receptor_nombre,
           receptor_id=excluded.receptor_id, receptor_email=excluded.receptor_email,
           moneda=excluded.moneda, tipo_cambio=excluded.tipo_cambio,
           codigo_actividad=excluded.codigo_actividad, condicion_venta=excluded.condicion_venta,
           iva_rate=excluded.iva_rate, total_gravado=excluded.total_gravado,
           total_exento=excluded.total_exento, total_exonerado=excluded.total_exonerado,
           total_descuentos=excluded.total_descuentos, total_venta_neta=excluded.total_venta_neta,
           total_impuesto=excluded.total_impuesto, total_otros_cargos=excluded.total_otros_cargos,
           total_comprobante=excluded.total_comprobante, source_account=excluded.source_account,
           message_uid=excluded.message_uid, detail_json=excluded.detail_json,
           pdf_filename=COALESCE(excluded.pdf_filename, invoices.pdf_filename),
           has_pdf=CASE WHEN excluded.has_pdf=1 THEN 1 ELSE invoices.has_pdf END,
           received_at=COALESCE(excluded.received_at, invoices.received_at)`
      )
      .bind(
        r.clave, r.docType, r.docTypeRaw, r.consecutivo, r.fechaEmision,
        r.emisorNombre, r.emisorId, r.emisorEmail, r.receptorNombre, r.receptorId,
        r.receptorEmail, r.moneda, r.tipoCambio, r.codigoActividad, r.condicionVenta,
        r.ivaRate, r.totalGravado, r.totalExento, r.totalExonerado, r.totalDescuentos,
        r.totalVentaNeta, r.totalImpuesto, r.totalOtrosCargos, r.totalComprobante,
        r.sourceAccount, r.messageUid, r.xmlFilename, r.pdfFilename, hasPdf,
        r.receivedAt, detailJson, now
      ),
    db
      .prepare(
        `INSERT INTO attachments (clave, xml_content, pdf_content, created_at)
         VALUES (?,?,?,?)
         ON CONFLICT(clave) DO UPDATE SET
           xml_content=excluded.xml_content,
           pdf_content=COALESCE(excluded.pdf_content, attachments.pdf_content)`
      )
      .bind(r.clave, r.xmlContent, r.pdfContentBase64, now),
  ]);

  return existing ? 'updated' : 'inserted';
}

export interface InvoiceFilters {
  q?: string;
  account?: string;
  docType?: string;
  moneda?: string;
  emisorId?: string;
  receptorId?: string;
  from?: string;
  to?: string;
  hasPdf?: boolean;
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// Whitelist of sortable columns (prevents SQL injection via the sort param).
const SORT_COLUMNS: Record<string, string> = {
  fecha: 'fecha_emision',
  total: 'total_comprobante',
  impuesto: 'total_impuesto',
  emisor: 'emisor_nombre',
  received: 'received_at',
  created: 'created_at',
};

function buildWhere(f: InvoiceFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (f.q) {
    clauses.push(
      `(emisor_nombre LIKE ? OR emisor_id LIKE ? OR receptor_nombre LIKE ? OR clave LIKE ? OR consecutivo LIKE ?)`
    );
    const like = `%${f.q}%`;
    binds.push(like, like, like, like, like);
  }
  if (f.account) { clauses.push(`source_account = ?`); binds.push(f.account); }
  if (f.docType) { clauses.push(`doc_type = ?`); binds.push(f.docType); }
  if (f.moneda) { clauses.push(`moneda = ?`); binds.push(f.moneda); }
  if (f.emisorId) { clauses.push(`emisor_id = ?`); binds.push(f.emisorId); }
  if (f.receptorId) { clauses.push(`receptor_id = ?`); binds.push(f.receptorId); }
  if (f.from) { clauses.push(`fecha_emision >= ?`); binds.push(f.from); }
  if (f.to) { clauses.push(`fecha_emision <= ?`); binds.push(f.to + 'T23:59:59'); }
  if (f.hasPdf === true) clauses.push(`has_pdf = 1`);
  if (f.hasPdf === false) clauses.push(`has_pdf = 0`);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds };
}

export interface InvoiceListRow {
  clave: string;
  doc_type: string;
  consecutivo: string;
  fecha_emision: string;
  emisor_nombre: string;
  emisor_id: string;
  receptor_nombre: string;
  moneda: string;
  iva_rate: number | null;
  total_impuesto: number;
  total_comprobante: number;
  source_account: string;
  has_pdf: number;
}

export interface CurrencyTotal {
  moneda: string;
  count: number;
  total: number;
  impuesto: number;
}

export async function listInvoices(db: D1Database, f: InvoiceFilters) {
  const { sql: where, binds } = buildWhere(f);
  const col = SORT_COLUMNS[f.sort ?? 'fecha'] ?? 'fecha_emision';
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);

  const rowsP = db
    .prepare(
      `SELECT clave, doc_type, consecutivo, fecha_emision, emisor_nombre, emisor_id,
              receptor_nombre, moneda, iva_rate, total_impuesto, total_comprobante,
              source_account, has_pdf
       FROM invoices ${where} ORDER BY ${col} ${dir}, created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...binds, limit, offset)
    .all<InvoiceListRow>();

  const countP = db.prepare(`SELECT COUNT(*) AS n FROM invoices ${where}`).bind(...binds).first<{ n: number }>();

  const sumsP = db
    .prepare(
      `SELECT moneda, COUNT(*) AS count, SUM(total_comprobante) AS total, SUM(total_impuesto) AS impuesto
       FROM invoices ${where} GROUP BY moneda ORDER BY moneda`
    )
    .bind(...binds)
    .all<CurrencyTotal>();

  const [rows, count, sums] = await Promise.all([rowsP, countP, sumsP]);
  return {
    rows: rows.results ?? [],
    total: count?.n ?? 0,
    currencyTotals: sums.results ?? [],
    limit,
    offset,
  };
}

/** Distinct values to populate filter dropdowns. */
export async function filterOptions(db: D1Database) {
  const accountsP = db.prepare(`SELECT DISTINCT source_account AS v FROM invoices WHERE source_account IS NOT NULL ORDER BY v`).all<{ v: string }>();
  const typesP = db.prepare(`SELECT DISTINCT doc_type AS v FROM invoices WHERE doc_type IS NOT NULL ORDER BY v`).all<{ v: string }>();
  const monedasP = db.prepare(`SELECT DISTINCT moneda AS v FROM invoices WHERE moneda IS NOT NULL ORDER BY v`).all<{ v: string }>();
  const emisoresP = db.prepare(`SELECT emisor_id AS id, MAX(emisor_nombre) AS nombre, COUNT(*) AS n FROM invoices WHERE emisor_id IS NOT NULL GROUP BY emisor_id ORDER BY nombre`).all<{ id: string; nombre: string; n: number }>();
  const [accounts, types, monedas, emisores] = await Promise.all([accountsP, typesP, monedasP, emisoresP]);
  return {
    accounts: (accounts.results ?? []).map((r) => r.v),
    docTypes: (types.results ?? []).map((r) => r.v),
    monedas: (monedas.results ?? []).map((r) => r.v),
    emisores: emisores.results ?? [],
  };
}

export interface IssuerGroup {
  emisor_id: string;
  emisor_nombre: string;
  moneda: string;
  count: number;
  impuesto: number;
  total: number;
}

/** Invoices summed per issuer (cédula) + currency — the "group and add up" view. */
export async function groupByIssuer(db: D1Database, f: InvoiceFilters): Promise<IssuerGroup[]> {
  const { sql: where, binds } = buildWhere(f);
  const { results } = await db
    .prepare(
      `SELECT emisor_id, MAX(emisor_nombre) AS emisor_nombre, moneda, COUNT(*) AS count,
              SUM(total_impuesto) AS impuesto, SUM(total_comprobante) AS total
       FROM invoices ${where}
       GROUP BY emisor_id, moneda ORDER BY total DESC`
    )
    .bind(...binds)
    .all<IssuerGroup>();
  return results ?? [];
}

/** Full rows for CSV export (respects filters, ignores pagination). */
export async function exportRows(db: D1Database, f: InvoiceFilters) {
  const { sql: where, binds } = buildWhere(f);
  const col = SORT_COLUMNS[f.sort ?? 'fecha'] ?? 'fecha_emision';
  const dir = f.dir === 'asc' ? 'ASC' : 'DESC';
  const { results } = await db
    .prepare(
      `SELECT fecha_emision, doc_type, consecutivo, clave, emisor_nombre, emisor_id,
              emisor_email, receptor_nombre, receptor_id, receptor_email, moneda,
              tipo_cambio, condicion_venta, iva_rate, total_gravado, total_exento,
              total_exonerado, total_descuentos, total_venta_neta, total_impuesto,
              total_otros_cargos, total_comprobante, source_account, has_pdf
       FROM invoices ${where} ORDER BY ${col} ${dir} LIMIT 50000`
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  return results ?? [];
}

export async function getAttachment(db: D1Database, clave: string) {
  return db
    .prepare(
      `SELECT a.xml_content, a.pdf_content, i.xml_filename, i.pdf_filename
       FROM attachments a JOIN invoices i ON i.clave = a.clave WHERE a.clave = ?`
    )
    .bind(clave)
    .first<{ xml_content: string | null; pdf_content: string | null; xml_filename: string | null; pdf_filename: string | null }>();
}

/** Every stored column for one invoice, with detail_json parsed. For the detail page. */
export async function getInvoiceFull(
  db: D1Database,
  clave: string
): Promise<(Record<string, any> & { detail: any }) | null> {
  const row = await db.prepare(`SELECT * FROM invoices WHERE clave = ?`).bind(clave).first<Record<string, any>>();
  if (!row) return null;
  let detail: any = null;
  try {
    detail = row.detail_json ? JSON.parse(row.detail_json) : null;
  } catch {
    detail = null;
  }
  return { ...row, detail };
}

export async function overviewStats(db: D1Database) {
  const invoicesP = db.prepare(`SELECT COUNT(*) AS n, SUM(has_pdf) AS pdfs FROM invoices`).first<{ n: number; pdfs: number }>();
  const mailboxesP = db.prepare(`SELECT COUNT(*) AS n FROM mailboxes WHERE active = 1`).first<{ n: number }>();
  const [inv, mb] = await Promise.all([invoicesP, mailboxesP]);
  return {
    invoices: inv?.n ?? 0,
    withPdf: inv?.pdfs ?? 0,
    mailboxes: mb?.n ?? 0,
  };
}
