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
 *
 * Flags:
 *   --dry-run  (or DRY_RUN=1)  connect + extract from every mailbox but store
 *                              NOTHING — prints what it would ingest. Use it to
 *                              rehearse the full run before writing to D1.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { buildRecords, type OutRecord } from './core.ts';
import { isDue, localDate } from '../src/lib/schedule.ts';

const here = dirname(fileURLToPath(import.meta.url));

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 5));
const LOOKBACK_OVERRIDE = process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) : undefined;
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
// Force a full re-scan of the look-back window instead of only fetching new mail.
// Use after an extractor change so old invoices are re-read with the new fields.
const FORCE_FULL =
  process.argv.includes('--full') || process.env.FULL_RESCAN === '1' || process.env.FULL_RESCAN === 'true';

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
  // Incremental-sync watermark from the app (absent for file-based mailboxes).
  lastUid?: number | null;
  uidvalidity?: number | null;
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

async function postIngest(
  mailbox: Mailbox,
  records: OutRecord[],
  status: string,
  opts: { syncedFrom?: string; lastUid?: number; uidvalidity?: number } = {}
) {
  if (!APP_URL || !INGEST_TOKEN) {
    console.warn('  (APP_URL/INGEST_TOKEN not set — cannot push to app; skipping ingest)');
    return;
  }
  const chunkSize = 25;
  for (let i = 0; i < Math.max(records.length, 1); i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= records.length;
    // The sync watermark + status ride along on the final chunk only.
    const res = await fetch(`${APP_URL}/api/collector/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        mailboxId: typeof mailbox.id === 'number' ? mailbox.id : undefined,
        status: isLast ? status : undefined,
        syncedFrom: isLast ? opts.syncedFrom : undefined,
        lastUid: isLast ? opts.lastUid : undefined,
        uidvalidity: isLast ? opts.uidvalidity : undefined,
        records: chunk,
      }),
    });
    if (!res.ok) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
  }
}

// Report run lifecycle so the shared collection lock reflects a real run:
// 'start'/'heartbeat' keep the dashboard's Collect button disabled while we work,
// 'finish' releases it. Best-effort — the lock also has a stale timeout.
async function postRun(event: 'start' | 'heartbeat' | 'finish') {
  if (!APP_URL || !INGEST_TOKEN) return;
  try {
    await fetch(`${APP_URL}/api/collector/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
  } catch {
    // best-effort
  }
}

// Report a live status for a mailbox (e.g. "collecting…") without marking it synced.
async function postStatus(mailbox: Mailbox, status: string) {
  if (!APP_URL || !INGEST_TOKEN || typeof mailbox.id !== 'number') return;
  try {
    await fetch(`${APP_URL}/api/collector/status`, {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mailboxId: mailbox.id, status }),
    });
  } catch {
    // status is best-effort
  }
}

async function collectMailbox(mailbox: Mailbox): Promise<{ found: number; error?: string }> {
  const name = mailbox.label || mailbox.email;
  const lookback = LOOKBACK_OVERRIDE ?? mailbox.lookbackDays ?? 30;
  const since = new Date(Date.now() - lookback * 86400000);
  const client = new ImapFlow({
    host: mailbox.host,
    port: mailbox.port || 993,
    secure: mailbox.useSsl !== false,
    auth: { user: mailbox.username || mailbox.email, pass: mailbox.password },
    logger: false,
  });

  const records: OutRecord[] = [];
  if (!DRY_RUN) {
    await postStatus(mailbox, 'collecting…');
    await postRun('heartbeat'); // keep the global lock fresh during long runs
  }
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    // UIDVALIDITY changes only when the server renumbers the folder; if it still
    // matches what we stored, UIDs are stable and we can fetch only new mail.
    const mb: any = client.mailbox;
    const currentUidValidity = mb && mb.uidValidity != null ? Number(mb.uidValidity) : 0;
    const canIncremental =
      !FORCE_FULL &&
      typeof mailbox.lastUid === 'number' &&
      typeof mailbox.uidvalidity === 'number' &&
      currentUidValidity !== 0 &&
      mailbox.uidvalidity === currentUidValidity;

    let uids: number[] = [];
    try {
      if (canIncremental) {
        // "N:*" always returns the highest UID even if none are >= N, so filter.
        const raw = (await client.search({ uid: `${mailbox.lastUid! + 1}:*` }, { uid: true })) || [];
        uids = raw.filter((u) => u > (mailbox.lastUid as number));
      } else {
        uids = (await client.search({ since }, { uid: true })) || [];
      }
      if (uids.length) {
        for await (const msg of client.fetch(
          uids.join(','),
          { source: true, internalDate: true },
          { uid: true }
        )) {
          const parsed = await simpleParser(msg.source as Buffer);
          const atts = (parsed.attachments || []).map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content as Buffer,
          }));
          const receivedAt = (msg.internalDate || parsed.date || null)?.toISOString() ?? null;
          const { records: recs } = buildRecords(atts, {
            sourceAccount: mailbox.email,
            messageUid: String(msg.uid),
            receivedAt,
          });
          records.push(...recs);
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();

    // New high-water mark. In a full scan we rebaseline from 0 (handles a changed
    // UIDVALIDITY); in an incremental run we can only move it forward.
    const base = canIncremental ? (mailbox.lastUid as number) : 0;
    const newMaxUid = uids.reduce((m, u) => (u > m ? u : m), base);
    const withPdf = records.filter((r) => r.pdfContentBase64).length;

    if (DRY_RUN) {
      const mode = canIncremental ? 'incremental' : FORCE_FULL ? 'full re-scan' : 'full';
      console.log(`  ○ ${name}: would store ${records.length} invoice(s) [${withPdf} with PDF] — ${mode}, dry run`);
    } else {
      await postIngest(mailbox, records, 'ok', {
        // Incremental runs only add new mail, so don't claim more history coverage.
        syncedFrom: canIncremental ? undefined : since.toISOString(),
        lastUid: canIncremental ? newMaxUid : uids.length ? newMaxUid : undefined,
        uidvalidity: currentUidValidity || undefined,
      });
      const suffix = canIncremental
        ? '(new mail only)'
        : `(full scan since ${since.toISOString().slice(0, 10)})`;
      console.log(`  ✓ ${name}: ${records.length} invoice(s) [${withPdf} with PDF] ${suffix}`);
    }
    return { found: records.length };
  } catch (err) {
    const message = (err as Error).message;
    console.error(`  ✖ ${name}: ${message}`);
    try {
      await client.close();
    } catch {}
    if (!DRY_RUN) {
      try {
        await postIngest(mailbox, [], `error: ${message}`);
      } catch {}
    }
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

// Fetch the collection schedule so a cron run can decide whether today is due.
async function fetchSchedule(): Promise<any | null> {
  if (!APP_URL || !INGEST_TOKEN) return null;
  try {
    const res = await fetch(`${APP_URL}/api/collector/schedule`, {
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { schedule?: any };
    return body.schedule ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // On scheduled (nightly cron) runs, honor the user's collection schedule; manual
  // runs (Collect now / workflow_dispatch) always proceed. Fail open if we can't
  // read the schedule, so collection never silently stops.
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const schedule = await fetchSchedule();
    if (schedule && !isDue(schedule, localDate(Date.now()))) {
      console.log(`Scheduled run skipped — not due today (schedule: ${schedule.frequency}).`);
      return;
    }
  }

  const mailboxes = await loadMailboxes();
  if (mailboxes.length === 0) {
    console.log('No mailboxes configured. Add some in the app or in mailboxes.json.');
    return;
  }
  console.log(
    `${DRY_RUN ? '[DRY RUN] ' : ''}Collecting from ${mailboxes.length} mailbox(es), ${CONCURRENCY} at a time` +
      `${FORCE_FULL ? ' — FULL RE-SCAN (ignoring saved position)' : ' (only new mail after the first run)'}…\n`
  );
  // Hold the shared lock for the whole run so only one collection runs at a time.
  if (!DRY_RUN) await postRun('start');
  try {
    const results = await pool(mailboxes, CONCURRENCY, collectMailbox);

    const totalInvoices = results.reduce((s, r) => s + r.found, 0);
    const errors = results.filter((r) => r.error).length;
    const verb = DRY_RUN ? 'found (not stored)' : 'collected';
    console.log(`\nDone. ${totalInvoices} invoice(s) ${verb}, ${errors} mailbox error(s).`);
    if (errors) process.exitCode = 1;
  } finally {
    if (!DRY_RUN) await postRun('finish'); // release the lock even if the run errored
  }
}

main().catch((err) => fail(err.message));
