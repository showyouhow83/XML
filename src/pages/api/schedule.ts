import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, setCollectionSchedule } from '../../lib/db';

export const prerender = false;

// Save the collection schedule from the Settings form. Session-gated (middleware).
export const POST: APIRoute = async ({ request, redirect }) => {
  await ensureSchema(env.DB);
  let raw: any = {};
  try {
    const form = await request.formData();
    raw = {
      frequency: form.get('frequency'),
      dayOfWeek: form.get('dayOfWeek'),
      dayOfMonth: form.get('dayOfMonth'),
    };
  } catch {
    try {
      raw = await request.json();
    } catch {
      // leave raw empty → normalizes to daily
    }
  }
  await setCollectionSchedule(env.DB, raw);
  return redirect('/settings?saved=schedule');
};
