import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, getAttachment } from '../../lib/db';
import { getPdf, base64ToBytes } from '../../lib/pdfs';

function safeName(name: string | null, fallback: string): string {
  const n = (name || fallback).replace(/[^\w.\-]+/g, '_');
  return n || fallback;
}

export const GET: APIRoute = async ({ url }) => {
  await ensureSchema(env.DB);

  const clave = url.searchParams.get('clave') || '';
  const type = url.searchParams.get('type') === 'pdf' ? 'pdf' : 'xml';
  if (!clave) return new Response('Missing clave', { status: 400 });

  const att = await getAttachment(env.DB, clave);
  if (!att) return new Response('Not found', { status: 404 });

  if (type === 'xml') {
    if (att.xml_content == null) return new Response('No XML stored', { status: 404 });
    return new Response(att.xml_content, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'content-disposition': `attachment; filename="${safeName(att.xml_filename, clave + '.xml')}"`,
      },
    });
  }

  const pdfHeaders = {
    'content-type': 'application/pdf',
    'content-disposition': `attachment; filename="${safeName(att.pdf_filename, clave + '.pdf')}"`,
  };
  // Prefer R2 (mailbox folder, then legacy flat key); fall back to base64 in D1.
  if (env.PDFS) {
    const buf = await getPdf(env.PDFS, att.source_account, clave);
    if (buf) return new Response(buf, { headers: pdfHeaders });
  }
  if (att.pdf_content == null) return new Response('No PDF stored', { status: 404 });
  return new Response(base64ToBytes(att.pdf_content), { headers: pdfHeaders });
};
