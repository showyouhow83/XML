import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, getAttachment } from '../../lib/db';

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

  if (att.pdf_content == null) return new Response('No PDF stored', { status: 404 });
  const bin = atob(att.pdf_content);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${safeName(att.pdf_filename, clave + '.pdf')}"`,
    },
  });
};
