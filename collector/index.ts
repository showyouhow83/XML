/*
 * IMAP collector. Runs in Node (locally or in GitHub Actions) — Cloudflare
 * Workers cannot open raw IMAP sockets, so this piece lives outside the Worker.
 *
 * It:
 *   1. loads the mailbox list (a local mailboxes.json, or the app's API),
 *   2. connects to each mailbox over IMAP — a few at a time (default 5),
 *   3. downloads invoice XML + the matching PDF from each recent email,
 *   4. extracts the financial fields, and
 *   5. POSTs everything to the app's /api/collector/ingest endpoint (-> D1).
 *
 * Env:
 *   APP_URL        base URL of the deployed app (or http://localhost:4321)   [required]
 *   INGEST_TOKEN   shared secret; must match the Worker's INGEST_TOKEN        [required]
 *   MAILBOXES_FILE path to a JSON mailbox list (default: collector/mailboxes.json if present)
 *   CONCURRENCY    mailboxes processed in parallel (default 5)
 *   LOOKBACK_DAYS  override how many days back to search (per-mailbox value wins)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { extractInvoice } from '../src/lib/invoice.ts';

const here = dirname(fileURLToPath(import.meta.url));

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const LOOKBACK_OVERRIDE = process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) : undefined;

interface Mailbox {
  id?: number;
  label?: string | null;
  email: string;
  host: string;
  port: number;
  username: string;
  password: string;
  useSsl?: boolean;
  lookbackDays?: number;
}

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function loadMailboxes(): Promise<Mailbox[]> {
  const explicit = process.env.MAILBOXES_FILE;
  const candidate = explicit
    ? isAbsolute(explicit) ? explicit : join(process.cwd(), explicit)
    : join(here, 'mailboxes.json');

  if (existsSync(candidate)) {
    console.log(`Loading mailboxes from ${candidate}`);
    const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
    const list: Mailbox[] = Array.isArray(parsed) ? parsed : parsed.mailboxes;
    if (!Array.isArray(list)) fail('mailboxes.json must be an array (or { "mailboxes": [...] })');
    return list;
  }

  if (!APP_URL || !INGEST_TOKEN) {
    fail('No mailboxes.json found and APP_URL / INGEST_TOKEN not set — nothing to collect from.');
  }
  console.log(`Loading mailboxes from ${APP_URL}/api/collector/mailboxes`);
  const res = await fetch(`${APP_URL}/api/collector/mailboxes`, {
    headers: { authorization: `Bearer ${INGEST_TOKEN}` },
  });
  if (!res.ok) fail(`Failed to fetch mailboxes: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { mailboxes: Mailbox[] };
  return body.mailboxes || [];
}

interface OutRecord {
  clave: string;
  docType: string;
  docTypeRaw: string;
  consecutivo: string | null;
  fechaEmision: string | null;
  emisorNombre: string | null;
  emisorId: string | null;
  receptorNombre: string | null;
  receptorId: string | null;
  moneda: string | null;
  totalGravado: number | null;
  totalExento: number | null;
  totalDescuentos: number | null;
  totalVentaNeta: number | null;
  totalImpuesto: number | null;
  totalComprobante: number | null;
  sourceAccount: string;
  messageUid: string | null;
  xmlFilename: string | null;
  xmlContent: string;
  pdfFilename: string | null;
  pdfContentBase64: string | null;
  receivedAt: string | null;
}

const isXml = (a: { filename?: string; contentType?: string }) =>
  /\.xml$/i.test(a.filename || '') || /xml/i.test(a.contentType || '');
const isPdf = (a: { filename?: string; contentType?: string }) =>
  /\.pdf$/i.test(a.filename || '') || /pdf/i.test(a.contentType || '');

const baseName = (name = '') => name.replace(/\.[^.]+$/, '').toLowerCase();

// Find the PDF that belongs to a given XML attachment.
function matchPdf(
  xmlName: string,
  clave: string,
  consecutivo: string | null,
  pdfs: Array<{ filename?: string; content: Buffer }>
) {
  if (pdfs.length === 0) return null;
  const base = baseName(xmlName);
  const sameName = pdfs.find((p) => baseName(p.filename) === base);
  if (sameName) return sameName;
  if (pdfs.length === 1) return pdfs[0];
  const byKey = pdfs.find(
    (p) => (clave && (p.filename || '').includes(clave)) || (consecutivo && (p.filename || '').includes(consecutivo))
  );
  return byKey || null;
}

async function postIngest(mailbox: Mailbox, records: OutRecord[], status: string) {
  if (!APP_URL || !INGEST_TOKEN) {
    console.warn('  (APP_URL/INGEST_TOKEN not set — cannot push to app; skipping ingest)');
    return;
  }
  const chunkSize = 25;
  for (let i = 0; i < Math.max(records.length, 1); i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= records.length;
    const res = await fetch(`${APP_URL}/api/collector/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mailboxId: typeof mailbox.id === 'number' ? mailbox.id : undefined,
        status: isLast ? status : undefined,
        records: chunk,
      }),
    });
    if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
  }
}

async function collectMailbox(mailbox: Mailbox): Promise<{ found: number; error?: string }> {
  const name = mailbox.label || mailbox.email;
  const lookback = LOOKBACK_OVERRIDE ?? mailbox.lookbackDays ?? 30;
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port || 993,
    secure: mailbox.useSsl !== false,
    auth: { user: mailbox.username || mailbox.email, pass: mailbox.password },
    logger: false,
  });

  const records: OutRecord[] = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - lookback * 86400000);
      const uids = (await client.search({ since }, { uid: true })) || [];
      if (uids.length) {
        for await (const msg of client.fetch(
          uids.join(','),
          { source: true, internalDate: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source as Buffer);
          const atts = parsed.attachments || [];
          const xmls = atts.filter(isXml);
          const pdfs = atts.filter(isPdf).map((p) => ({ filename: p.filename, content: p.content as Buffer }));
          if (xmls.length === 0) continue;

          const receivedAt = (msg.internalDate || parsed.date || null)?.toISOString() ?? null;

          for (const xml of xmls) {
            const xmlText = (xml.content as Buffer).toString('utf8');
            const result = extractInvoice(xmlText);
            if (result.status !== 'invoice') continue;
            const inv = result.invoice;
            const pdf = matchPdf(xml.filename || '', inv.clave, inv.consecutivo, pdfs);
            records.push({
              ...inv,
              sourceAccount: mailbox.email,
              messageUid: String(msg.uid),
              xmlFilename: xml.filename || null,
              xmlContent: xmlText,
              pdfFilename: pdf?.filename || null,
              pdfContentBase64: pdf ? pdf.content.toString('base64') : null,
              receivedAt,
            });
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    await postIngest(mailbox, records, 'ok');
    console.log(`  ✓ ${name}: ${records.length} invoice(s)`);
    return { found: records.length };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`  ✖ ${name}: ${message}`);
    try {
      await client.close();
    } catch {}
    try {
      await postIngest(mailbox, [], `error: ${message}`);
    } catch {}
    return { found: 0, error: message };
  }
}

// Bounded-concurrency pool.
async function pool<T, R>(items: T[], n: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const mailboxes = await loadMailboxes();
  if (mailboxes.length === 0) {
    console.log('No mailboxes configured. Add some in the app or in mailboxes.json.');
    return;
  }
  console.log(`Collecting from ${mailboxes.length} mailbox(es), ${CONCURRENCY} at a time…\n`);
  const results = await pool(mailboxes, CONCURRENCY, collectMailbox);

  const totalInvoices = results.reduce((s, r) => s + r.found, 0);
  const errors = results.filter((r) => r.error).length;
  console.log(`\nDone. ${totalInvoices} invoice(s) collected, ${errors} mailbox error(s).`);
  if (errors) process.exitCode = 1;
}

main().catch((err) => fail(err.message));
