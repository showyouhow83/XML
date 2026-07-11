import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, clientPdfList } from '../../lib/db';
import { getPdfObject } from '../../lib/pdfs';
import { downloadZip } from 'client-zip';

export const prerender = false;

function safe(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file.pdf';
}

// Stream a zip of every PDF for one mailbox. Session-gated by middleware.
export const GET: APIRoute = async ({ url }) => {
  const account = url.searchParams.get('account') || '';
  if (!account) return new Response('Missing account', { status: 400 });
  if (!env.PDFS) return new Response('PDF storage (R2) is not configured', { status: 503 });

  await ensureSchema(env.DB);
  const rows = await clientPdfList(env.DB, account);
  if (!rows.length) return new Response('No PDFs found for this mailbox', { status: 404 });

  const bucket = env.PDFS;
  const seen = new Set<string>();
  async function* files() {
    for (const r of rows) {
      const obj = await getPdfObject(bucket, account, r.clave);
      if (!obj) continue;
      let name = safe(r.pdf_filename || `${r.consecutivo || 'factura'}.pdf`);
      if (seen.has(name)) name = safe(`${r.clave}_${name}`);
      seen.add(name);
      yield { name, input: obj.body as ReadableStream };
    }
  }

  const zip = downloadZip(files());
  return new Response(zip.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${safe(account)}-pdfs.zip"`,
    },
  });
};
