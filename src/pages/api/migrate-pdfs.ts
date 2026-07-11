import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, nextD1PdfBatch, clearD1Pdf, pdfsInD1Count } from '../../lib/db';
import { putPdf } from '../../lib/pdfs';

export const prerender = false;

// Move a batch of PDFs out of D1 (base64) and into R2, then drop the D1 copy.
// Call repeatedly until { remaining: 0 }. Gated by the dashboard session (middleware).
export const POST: APIRoute = async () => {
  if (!env.PDFS) {
    return Response.json({ error: 'R2 bucket (PDFS) is not configured on the Worker.' }, { status: 503 });
  }
  await ensureSchema(env.DB);

  const batch = await nextD1PdfBatch(env.DB, 20);
  let migrated = 0;
  const failed: string[] = [];
  for (const row of batch) {
    if (!row.pdf_content) continue;
    const ok = await putPdf(env.PDFS, row.clave, row.pdf_content);
    if (ok) {
      await clearD1Pdf(env.DB, row.clave);
      migrated++;
    } else {
      failed.push(row.clave);
    }
  }

  const remaining = await pdfsInD1Count(env.DB);
  return Response.json({ migrated, remaining, failed: failed.length });
};
