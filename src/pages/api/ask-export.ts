import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema } from '../../lib/db';
import { validateReadonlySelect } from '../../lib/ai';

export const prerender = false;

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Export the rows behind an Ivan answer as CSV. The client posts the SQL Ivan
// generated; we re-validate it as a single read-only SELECT over `invoices`
// (same guard as /api/ask — no new exposure) and stream the full result (≤500).
// Session-gated by middleware.
export const POST: APIRoute = async ({ request }) => {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON body', { status: 400 });
  }

  const v = validateReadonlySelect(String(body?.sql ?? ''));
  if (!v.ok) return new Response(v.error, { status: 400 });

  await ensureSchema(env.DB);
  let rows: Record<string, unknown>[];
  try {
    const res = await env.DB.prepare(v.sql).all<Record<string, unknown>>();
    rows = res.results ?? [];
  } catch (err) {
    return new Response(`Query failed: ${(err as Error).message}`, { status: 400 });
  }
  if (!rows.length) return new Response('No rows to export', { status: 404 });

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
  const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="ivan-datos-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
