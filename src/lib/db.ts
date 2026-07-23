// D1 data-access layer: schema bootstrap + all queries for mailboxes and invoices.
import type { ExtractedInvoice } from './invoice';
import { encryptSecret, decryptSecret } from './crypto';
import { normalizeSchedule, DEFAULT_SCHEDULE, type CollectionSchedule } from './schedule';

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
  `CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL
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

/** Actual receipt coverage per mailbox, from the stored data (not the search
 *  window): invoice count + oldest/newest receipt date (by fecha_emision). */
export interface MailboxCoverage {
  count: number;
  oldest: string | null;
  newest: string | null;
}
export async function mailboxCoverage(db: D1Database): Promise<Record<string, MailboxCoverage>> {
  const { results } = await db
    .prepare(
      `SELECT source_account AS email, COUNT(*) AS n,
              MIN(fecha_emision) AS oldest, MAX(fecha_emision) AS newest
       FROM invoices WHERE source_account IS NOT NULL GROUP BY source_account`
    )
    .all<{ email: string; n: number; oldest: string | null; newest: string | null }>();
  const out: Record<string, MailboxCoverage> = {};
  for (const r of results ?? []) out[r.email] = { count: r.n, oldest: r.oldest, newest: r.newest };
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
// App state — a shared key/value flag store (used for the global collection lock)
// ---------------------------------------------------------------------------

// A collection run holds this lock so only ONE runs at a time across all clients.
// If a run dies without releasing, the lock is treated as free after this long.
const COLLECTION_KEY = 'collection_run';
export const COLLECTION_LOCK_TTL_MS = 60 * 60 * 1000; // 60 minutes

export interface CollectionLock {
  active: boolean;
  startedAt: string | null;
  startedBy: string | null;
}

export async function getCollectionLock(db: D1Database): Promise<CollectionLock> {
  const row = await db
    .prepare(`SELECT value, updated_at FROM app_state WHERE key = ?`)
    .bind(COLLECTION_KEY)
    .first<{ value: string | null; updated_at: string }>();
  if (!row?.updated_at) return { active: false, startedAt: null, startedBy: null };
  const age = Date.now() - Date.parse(row.updated_at);
  const active = Number.isFinite(age) && age >= 0 && age < COLLECTION_LOCK_TTL_MS;
  return { active, startedAt: row.updated_at, startedBy: row.value ?? null };
}

/** Take the lock only if it is free (or its holder went stale). Returns true if acquired. */
export async function acquireCollectionLock(db: D1Database, startedBy: string): Promise<boolean> {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - COLLECTION_LOCK_TTL_MS).toISOString();
  const res = await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE app_state.updated_at < ?`
    )
    .bind(COLLECTION_KEY, startedBy.slice(0, 120), now, cutoff)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Refresh the lock's timestamp so a long, healthy run doesn't look stale. */
export async function touchCollectionLock(db: D1Database, startedBy: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .bind(COLLECTION_KEY, startedBy.slice(0, 120), now)
    .run();
}

export async function releaseCollectionLock(db: D1Database): Promise<void> {
  await db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(COLLECTION_KEY).run();
}

const SCHEDULE_KEY = 'collection_schedule';

/** How often the nightly collector should actually run (default: every night). */
export async function getCollectionSchedule(db: D1Database): Promise<CollectionSchedule> {
  const row = await db
    .prepare(`SELECT value FROM app_state WHERE key = ?`)
    .bind(SCHEDULE_KEY)
    .first<{ value: string | null }>();
  if (!row?.value) return DEFAULT_SCHEDULE;
  try {
    return normalizeSchedule(JSON.parse(row.value));
  } catch {
    return DEFAULT_SCHEDULE;
  }
}

export async function setCollectionSchedule(db: D1Database, raw: unknown): Promise<CollectionSchedule> {
  const schedule = normalizeSchedule(raw);
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SCHEDULE_KEY, JSON.stringify(schedule), now)
    .run();
  return schedule;
}

const AI_MODEL_KEY = 'ai_model';

/** In-app override for which model Ivan uses (applied to all 3 steps). null → use
 *  the deployment defaults (AI_MODEL_* env vars, else the code default). */
export async function getAiModel(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM app_state WHERE key = ?`)
    .bind(AI_MODEL_KEY)
    .first<{ value: string | null }>();
  return row?.value ?? null;
}

/** Set (or clear, with null) Ivan's model override. Caller validates the id. */
export async function setAiModel(db: D1Database, model: string | null): Promise<void> {
  if (!model) {
    await db.prepare(`DELETE FROM app_state WHERE key = ?`).bind(AI_MODEL_KEY).run();
    return;
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(AI_MODEL_KEY, model, now)
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
export async function upsertInvoice(
  db: D1Database,
  r: IngestRecord,
  pdfInR2 = false
): Promise<'inserted' | 'updated'> {
  const existing = await db.prepare(`SELECT 1 FROM invoices WHERE clave = ?`).bind(r.clave).first();
  const now = new Date().toISOString();
  // A PDF counts whether it's stored in R2 or as base64 in D1.
  const hasPdf = r.pdfContentBase64 || pdfInR2 ? 1 : 0;
  // When the PDF is in R2, don't also store the base64 in D1.
  const pdfForD1 = pdfInR2 ? null : r.pdfContentBase64;
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
      .bind(r.clave, r.xmlContent, pdfForD1, now),
  ]);

  return existing ? 'updated' : 'inserted';
}

export interface InvoiceFilters {
  q?: string;
  account?: string;
  docType?: string;
  moneda?: string;
  ivaRate?: number;
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
  if (f.ivaRate !== undefined) { clauses.push(`iva_rate = ?`); binds.push(f.ivaRate); }
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
  const ivaRatesP = db.prepare(`SELECT DISTINCT iva_rate AS v FROM invoices WHERE iva_rate IS NOT NULL ORDER BY v`).all<{ v: number }>();
  const emisoresP = db.prepare(`SELECT emisor_id AS id, MAX(emisor_nombre) AS nombre, COUNT(*) AS n FROM invoices WHERE emisor_id IS NOT NULL GROUP BY emisor_id ORDER BY nombre`).all<{ id: string; nombre: string; n: number }>();
  const [accounts, types, monedas, ivaRates, emisores] = await Promise.all([accountsP, typesP, monedasP, ivaRatesP, emisoresP]);
  return {
    accounts: (accounts.results ?? []).map((r) => r.v),
    docTypes: (types.results ?? []).map((r) => r.v),
    monedas: (monedas.results ?? []).map((r) => r.v),
    ivaRates: (ivaRates.results ?? []).map((r) => r.v),
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
      `SELECT a.xml_content, a.pdf_content, i.xml_filename, i.pdf_filename, i.source_account
       FROM attachments a JOIN invoices i ON i.clave = a.clave WHERE a.clave = ?`
    )
    .bind(clave)
    .first<{ xml_content: string | null; pdf_content: string | null; xml_filename: string | null; pdf_filename: string | null; source_account: string | null }>();
}

// --- PDF storage helpers (D1 base64 -> R2, and organizing R2 into mailbox folders) ---

/** How many PDFs are still stored as base64 in D1 (i.e. not yet moved to R2). */
export async function pdfsInD1Count(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM attachments WHERE pdf_content IS NOT NULL`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Drop a PDF's base64 from D1 once it's safely in R2. */
export async function clearD1Pdf(db: D1Database, clave: string): Promise<void> {
  await db.prepare(`UPDATE attachments SET pdf_content = NULL WHERE clave = ?`).bind(clave).run();
}

/** Total invoices that have a PDF (in R2 and/or D1). */
export async function pdfInvoiceCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE has_pdf = 1`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** A page of invoices with PDFs, plus their mailbox + any base64 still in D1 —
 *  used to move PDFs into R2 and group them into mailbox folders. */
export async function pdfInvoiceBatch(
  db: D1Database,
  limit: number,
  offset: number
): Promise<{ clave: string; source_account: string | null; pdf_content: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT i.clave, i.source_account, a.pdf_content
       FROM invoices i LEFT JOIN attachments a ON a.clave = i.clave
       WHERE i.has_pdf = 1 ORDER BY i.clave LIMIT ? OFFSET ?`
    )
    .bind(limit, offset)
    .all<{ clave: string; source_account: string | null; pdf_content: string | null }>();
  return results ?? [];
}

/** Every PDF for one mailbox (for the per-mailbox zip download). */
export async function clientPdfList(
  db: D1Database,
  account: string
): Promise<{ clave: string; pdf_filename: string | null; consecutivo: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT clave, pdf_filename, consecutivo FROM invoices
       WHERE has_pdf = 1 AND source_account = ? ORDER BY fecha_emision`
    )
    .bind(account)
    .all<{ clave: string; pdf_filename: string | null; consecutivo: string | null }>();
  return results ?? [];
}

/** Every invoice (with its XML filename) for one mailbox — for the per-mailbox
 *  XML zip. All invoices have XML, so this is just the mailbox's invoices. */
export async function clientXmlList(
  db: D1Database,
  account: string
): Promise<{ clave: string; xml_filename: string | null; consecutivo: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT clave, xml_filename, consecutivo FROM invoices
       WHERE source_account = ? ORDER BY fecha_emision`
    )
    .bind(account)
    .all<{ clave: string; xml_filename: string | null; consecutivo: string | null }>();
  return results ?? [];
}

/** The raw XML for one invoice (stored in D1). Fetched per-clave so the zip
 *  streams instead of loading every XML into memory at once. */
export async function getXmlContent(db: D1Database, clave: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT xml_content FROM attachments WHERE clave = ?`)
    .bind(clave)
    .first<{ xml_content: string | null }>();
  return row?.xml_content ?? null;
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
