import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, exportRows, type InvoiceFilters } from '../../lib/db';

function csvCell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const GET: APIRoute = async ({ url }) => {
  await ensureSchema(env.DB);
  const p = url.searchParams;

  const filters: InvoiceFilters = {
    q: p.get('q') || undefined,
    account: p.get('account') || undefined,
    docType: p.get('docType') || undefined,
    moneda: p.get('moneda') || undefined,
    from: p.get('from') || undefined,
    to: p.get('to') || undefined,
    hasPdf: p.get('hasPdf') === '1' ? true : p.get('hasPdf') === '0' ? false : undefined,
    sort: p.get('sort') || 'fecha',
    dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
  };

  const rows = await exportRows(env.DB, filters);
  const headers = [
    'fecha_emision', 'doc_type', 'consecutivo', 'clave', 'emisor_nombre', 'emisor_id',
    'emisor_email', 'receptor_nombre', 'receptor_id', 'receptor_email', 'moneda',
    'tipo_cambio', 'condicion_venta', 'iva_rate', 'total_gravado', 'total_exento',
    'total_exonerado', 'total_descuentos', 'total_venta_neta', 'total_impuesto',
    'total_otros_cargos', 'total_comprobante', 'source_account', 'has_pdf',
  ];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell((r as any)[h])).join(','));
  const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="invoices-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
};
