import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, pdfInvoiceBatch, pdfInvoiceCount, clearD1Pdf } from '../../lib/db';
import { putPdf, foldPdf } from '../../lib/pdfs';

export const prerender = false;

const BATCH = 20;

// Get every PDF into R2, grouped into its mailbox folder (`<mailbox>/<clave>.pdf`).
// Handles both cases: base64 still in D1 → upload + clear D1; already in R2 at the
// legacy flat key → move into the mailbox folder. Idempotent + resumable: pass an
// offset, it processes a batch and returns the next offset.
// Body: { offset?: number }
export const POST: APIRoute = async ({ request }) => {
  if (!env.PDFS) {
    return Response.json({ error: 'R2 bucket (PDFS) is not configured on the Worker.' }, { status: 503 });
  }
  await ensureSchema(env.DB);

  let offset = 0;
  try {
    const b: any = await request.json();
    if (Number.isFinite(b?.offset)) offset = Math.max(0, Math.floor(b.offset));
  } catch {
    // no body — start at 0
  }

  const total = await pdfInvoiceCount(env.DB);
  const batch = await pdfInvoiceBatch(env.DB, BATCH, offset);
  let moved = 0;
  const failed: string[] = [];
  for (const row of batch) {
    try {
      if (row.pdf_content) {
        // Base64 still in D1 → upload to the mailbox folder, then drop the D1 copy.
        if (await putPdf(env.PDFS, row.source_account, row.clave, row.pdf_content)) {
          await clearD1Pdf(env.DB, row.clave);
          moved++;
        } else {
          failed.push(row.clave);
        }
      } else {
        // Already in R2 (possibly at the legacy flat key) → ensure it's foldered.
        if ((await foldPdf(env.PDFS, row.source_account, row.clave)) === 'moved') moved++;
      }
    } catch {
      failed.push(row.clave);
    }
  }

  const nextOffset = offset + batch.length;
  const done = batch.length === 0 || nextOffset >= total;
  return Response.json({ processed: batch.length, moved, offset: nextOffset, total, done, failed: failed.length });
};
