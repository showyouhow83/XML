import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, getCollectionSchedule } from '../../../lib/db';

// The collector reads this to decide whether a scheduled (cron) run is due today.
// Auth (bearer INGEST_TOKEN) is enforced in middleware for /api/collector/*.
export const GET: APIRoute = async () => {
  await ensureSchema(env.DB);
  const schedule = await getCollectionSchedule(env.DB);
  return Response.json({ schedule });
};
