import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, upsertInvoice, setMailboxStatus, type IngestRecord } from '../../../lib/db';

// Receives extracted invoices from the collector and stores them.
// Body: { mailboxId?: number, status?: string, records: IngestRecord[] }
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
      const result = await upsertInvoice(env.DB, r);
      if (result === 'inserted') inserted++;
      else updated++;
    } catch (err) {
      errors.push(`${r.clave}: ${(err as Error).message}`);
    }
  }

  if (typeof body?.mailboxId === 'number') {
    const status = body.status || (errors.length ? `partial: ${errors.length} error(s)` : 'ok');
    await setMailboxStatus(env.DB, body.mailboxId, status, new Date().toISOString());
  }

  return Response.json({ inserted, updated, failed: errors.length, errors });
};
