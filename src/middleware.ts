import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { bearerToken, safeEqual, verifySession, SESSION_COOKIE } from './lib/auth';

const PUBLIC_PATHS = new Set(['/login', '/api/login']);

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, locals, url, redirect, cookies } = context;
  const path = url.pathname;

  // Collector endpoints authenticate with a bearer token, bypassing the UI gate.
  if (path.startsWith('/api/collector/')) {
    if (!env.INGEST_TOKEN) {
      return new Response('INGEST_TOKEN is not configured', { status: 503 });
    }
    if (!safeEqual(bearerToken(request), env.INGEST_TOKEN)) {
      return new Response('Unauthorized', { status: 401 });
    }
    return next();
  }

  // Optional dashboard password gate.
  const appPassword = env.APP_PASSWORD;
  locals.isAuthed = true;
  if (appPassword) {
    const ok = await verifySession(cookies.get(SESSION_COOKIE)?.value, appPassword);
    locals.isAuthed = ok;
    if (!ok && !PUBLIC_PATHS.has(path) && !path.startsWith('/favicon')) {
      if (path.startsWith('/api/')) return new Response('Unauthorized', { status: 401 });
      return redirect('/login');
    }
  }

  return next();
});
