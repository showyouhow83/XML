import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, deleteMailbox } from '../../../lib/db';

export const POST: APIRoute = async ({ request, redirect }) => {
  await ensureSchema(env.DB);
  const form = await request.formData();
  const id = Number(form.get('id'));
  if (Number.isFinite(id)) await deleteMailbox(env.DB, id);
  return redirect('/mailboxes?deleted=1');
};
