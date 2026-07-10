import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, setMailboxStatus } from '../../../lib/db';

// Lets the collector report a mailbox's live status (e.g. "collecting…") WITHOUT
// touching last_synced_at. Auth (bearer INGEST_TOKEN) enforced in middleware.
export const POST: APIRoute = async ({ request }) => {
  await ensureSchema(env.DB);
  const body: any = await request.json().catch(() => ({}));
  if (typeof body?.mailboxId === 'number' && typeof body?.status === 'string') {
    await setMailboxStatus(env.DB, body.mailboxId, body.status); // no syncedAt -> unchanged
  }
  return Response.json({ ok: true });
};
