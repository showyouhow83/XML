/*
 * Read-only IMAP probe. Connects to ONE mailbox, finds recent invoice emails,
 * pairs XML + PDF, extracts the fields, and prints a summary. Pushes NOTHING to
 * any database — use it to confirm IMAP access + extraction on a real mailbox
 * before wiring up the full collector.
 *
 * Run:
 *   IMAP_USER="you@gmail.com" IMAP_PASS="app-password" npm run probe
 * Optional env: IMAP_HOST (default imap.gmail.com), IMAP_PORT (993), LOOKBACK_DAYS (30)
 *
 * Note: port 993 (IMAP over TLS) must be reachable from where you run this —
 * a normal laptop or GitHub Actions works; some locked-down sandboxes do not.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { buildRecords } from '../collector/core.ts';

const {
  IMAP_HOST = 'imap.gmail.com',
  IMAP_PORT = '993',
  IMAP_USER,
  IMAP_PASS,
  LOOKBACK_DAYS = '30',
} = process.env;

if (!IMAP_USER || !IMAP_PASS) {
  console.error('Set IMAP_USER and IMAP_PASS (optionally IMAP_HOST / IMAP_PORT / LOOKBACK_DAYS).');
  process.exit(1);
}

const lookback = Number(LOOKBACK_DAYS);
const money = (n: number | null, c: string | null) =>
  n == null ? '' : new Intl.NumberFormat('es-CR', { style: 'currency', currency: c || 'CRC' }).format(n);

async function main() {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: Number(IMAP_PORT),
    secure: IMAP_PORT !== '143',
    auth: { user: IMAP_USER!, pass: IMAP_PASS! },
    logger: false,
  });

  console.log(`Connecting to ${IMAP_HOST}:${IMAP_PORT} as ${IMAP_USER} …`);
  await client.connect();
  console.log('Connected + authenticated ✓');

  const lock = await client.getMailboxLock('INBOX');
  let xmlTotal = 0;
  let skippedTotal = 0;
  const rows: Array<Record<string, string>> = [];
  try {
    const since = new Date(Date.now() - lookback * 86400000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    console.log(`Emails in the last ${lookback} days: ${uids.length}`);
    if (uids.length) {
      for await (const msg of client.fetch(uids.join(','), { source: true, internalDate: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const atts = (parsed.attachments || []).map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: a.content as Buffer,
        }));
        const { records, xmlCount, skipped } = buildRecords(atts, {
          sourceAccount: IMAP_USER!,
          messageUid: String(msg.uid),
          receivedAt: (msg.internalDate || parsed.date || null)?.toISOString() ?? null,
        });
        xmlTotal += xmlCount;
        skippedTotal += skipped;
        for (const r of records) {
          rows.push({
            fecha: (r.fechaEmision || '').slice(0, 10),
            tipo: r.docType,
            emisor: (r.emisorNombre || '').slice(0, 28),
            moneda: r.moneda || '',
            total: money(r.totalComprobante, r.moneda),
            pdf: r.pdfContentBase64 ? 'yes' : 'no',
          });
        }
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();

  console.log(
    `\nXML attachments seen: ${xmlTotal} | acknowledgements skipped: ${skippedTotal} | invoices parsed: ${rows.length}`
  );
  if (rows.length) console.table(rows.slice(0, 25));
  console.log('\n(Read-only probe — nothing was written to any database.)');
}

main().catch((e) => {
  console.error('ERROR:', (e as Error).message);
  process.exit(1);
});
