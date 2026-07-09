import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { safeEqual, sessionToken, SESSION_COOKIE } from '../../lib/auth';

export const POST: APIRoute = async ({ request, redirect, cookies, url }) => {
  const form = await request.formData();
  const password = String(form.get('password') || '');

  if (!env.APP_PASSWORD || !safeEqual(password, env.APP_PASSWORD)) {
    return redirect('/login?error=1');
  }

  cookies.set(SESSION_COOKIE, await sessionToken(env.APP_PASSWORD), {
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return redirect('/');
};
