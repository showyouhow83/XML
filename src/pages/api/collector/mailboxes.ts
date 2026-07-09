import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, listMailboxesForCollector } from '../../../lib/db';

// Returns active mailboxes WITH decrypted passwords for the collector.
// Auth (bearer INGEST_TOKEN) is enforced in middleware for /api/collector/*.
export const GET: APIRoute = async () => {
  if (!env.TOKEN_ENC_KEY) {
    return Response.json({ error: 'TOKEN_ENC_KEY not configured' }, { status: 503 });
  }
  await ensureSchema(env.DB);
  const mailboxes = await listMailboxesForCollector(env.DB, env.TOKEN_ENC_KEY);
  return Response.json({ mailboxes });
};
