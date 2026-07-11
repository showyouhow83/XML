import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, upsertInvoice, recordSync, type IngestRecord } from '../../../lib/db';
import { putPdf } from '../../../lib/pdfs';

// Receives extracted invoices from the collector and stores them.
// Body: { mailboxId?, status?, syncedFrom?, lastUid?, uidvalidity?, records: IngestRecord[] }
export const POST: APIRoute = async ({ request }) => {
  await ensureSchema(env.DB);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const records: IngestRecord[] = Array.isArray(body?.records) ? body.records : [];
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  for (const r of records) {
    if (!r?.clave || typeof r.xmlContent !== 'string') {
      errors.push(`Skipped record missing clave/xmlContent (${r?.clave ?? 'unknown'})`);
      continue;
    }
    try {
      // Prefer R2 for the PDF; fall back to base64-in-D1 if the bucket isn't bound.
      let pdfInR2 = false;
      if (r.pdfContentBase64 && env.PDFS) {
        pdfInR2 = await putPdf(env.PDFS, r.sourceAccount, r.clave, r.pdfContentBase64);
      }
      const result = await upsertInvoice(env.DB, r, pdfInR2);
      if (result === 'inserted') inserted++;
      else updated++;
    } catch (err) {
      errors.push(`${r.clave}: ${(err as Error).message}`);
    }
  }

  if (typeof body?.mailboxId === 'number') {
    const status = body.status || (errors.length ? `partial: ${errors.length} error(s)` : 'ok');
    await recordSync(env.DB, body.mailboxId, {
      status,
      syncedAt: new Date().toISOString(),
      syncedFrom: typeof body?.syncedFrom === 'string' ? body.syncedFrom : null,
      lastUid: typeof body?.lastUid === 'number' ? body.lastUid : null,
      uidvalidity: typeof body?.uidvalidity === 'number' ? body.uidvalidity : null,
    });
  }

  return Response.json({ inserted, updated, failed: errors.length, errors });
};
