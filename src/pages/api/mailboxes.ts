import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, createMailbox } from '../../lib/db';

export const POST: APIRoute = async ({ request, redirect }) => {
  if (!env.TOKEN_ENC_KEY) {
    return redirect('/mailboxes?error=' + encodeURIComponent('TOKEN_ENC_KEY is not configured'));
  }
  await ensureSchema(env.DB);

  const form = await request.formData();
  const email = String(form.get('email') || '').trim();
  const host = String(form.get('host') || '').trim();
  const username = String(form.get('username') || '').trim() || email;
  const password = String(form.get('password') || '');
  const port = Number(form.get('port') || 993);
  const lookbackDays = Number(form.get('lookbackDays') || 30);

  if (!email || !host || !password) {
    return redirect('/mailboxes?error=' + encodeURIComponent('Email, host and password are required'));
  }

  try {
    await createMailbox(
      env.DB,
      {
        label: String(form.get('label') || '').trim() || undefined,
        email,
        host,
        port: Number.isFinite(port) ? port : 993,
        username,
        password,
        useSsl: String(form.get('useSsl') || '1') === '1',
        lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 30,
      },
      env.TOKEN_ENC_KEY
    );
  } catch (err) {
    return redirect('/mailboxes?error=' + encodeURIComponent((err as Error).message));
  }
  return redirect('/mailboxes?added=1');
};
