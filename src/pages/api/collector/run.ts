import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, touchCollectionLock, releaseCollectionLock } from '../../../lib/db';

// The collector reports its lifecycle so the shared collection lock reflects a
// real run: 'start'/'heartbeat' keep the lock fresh (covers scheduled runs and
// long backfills), 'finish' releases it so the dashboard button re-enables.
// Auth (bearer INGEST_TOKEN) is enforced in middleware for /api/collector/*.
// Body: { event: 'start' | 'heartbeat' | 'finish' }
export const POST: APIRoute = async ({ request }) => {
  await ensureSchema(env.DB);

  let body: any;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const event = body?.event;
  if (event === 'finish') {
    await releaseCollectionLock(env.DB);
  } else if (event === 'start' || event === 'heartbeat') {
    await touchCollectionLock(env.DB, 'collector');
  } else {
    return Response.json({ error: 'unknown event' }, { status: 400 });
  }
  return Response.json({ ok: true });
};
