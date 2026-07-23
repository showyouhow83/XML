import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, clientPdfList, clientXmlList, getXmlContent } from '../../lib/db';
import { getPdfObject } from '../../lib/pdfs';
import { downloadZip } from 'client-zip';

export const prerender = false;

function safe(name: string, fallbackExt: string): string {
  const n = name.replace(/[^\w.\-]+/g, '_').slice(0, 120);
  return n || `file.${fallbackExt}`;
}

// Stream a zip of every XML (from D1) or PDF (from R2) for one mailbox, so a
// client's files download as one archive instead of one-by-one.
// GET ?account=<email>&type=xml|pdf  (default pdf). Session-gated by middleware.
export const GET: APIRoute = async ({ url }) => {
  const account = url.searchParams.get('account') || '';
  if (!account) return new Response('Missing account', { status: 400 });
  const type = url.searchParams.get('type') === 'xml' ? 'xml' : 'pdf';

  await ensureSchema(env.DB);

  if (type === 'xml') {
    const rows = await clientXmlList(env.DB, account);
    if (!rows.length) return new Response('No invoices found for this mailbox', { status: 404 });
    const enc = new TextEncoder();
    const seen = new Set<string>();
    async function* files() {
      for (const r of rows) {
        const xml = await getXmlContent(env.DB, r.clave);
        if (xml == null) continue;
        let name = safe(r.xml_filename || `${r.consecutivo || r.clave}.xml`, 'xml');
        if (!/\.xml$/i.test(name)) name += '.xml';
        if (seen.has(name)) name = safe(`${r.clave}_${name}`, 'xml');
        seen.add(name);
        yield { name, input: enc.encode(xml) };
      }
    }
    const zip = downloadZip(files());
    return new Response(zip.body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${safe(account, 'zip')}-xml.zip"`,
      },
    });
  }

  // type === 'pdf' — served from R2
  if (!env.PDFS) return new Response('PDF storage (R2) is not configured', { status: 503 });
  const rows = await clientPdfList(env.DB, account);
  if (!rows.length) return new Response('No PDFs found for this mailbox', { status: 404 });

  const bucket = env.PDFS;
  const seen = new Set<string>();
  async function* files() {
    for (const r of rows) {
      const obj = await getPdfObject(bucket, account, r.clave);
      if (!obj) continue;
      let name = safe(r.pdf_filename || `${r.consecutivo || 'factura'}.pdf`, 'pdf');
      if (seen.has(name)) name = safe(`${r.clave}_${name}`, 'pdf');
      seen.add(name);
      yield { name, input: obj.body as ReadableStream };
    }
  }

  const zip = downloadZip(files());
  return new Response(zip.body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${safe(account, 'zip')}-pdfs.zip"`,
    },
  });
};
