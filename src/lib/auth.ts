// Lightweight auth helpers: a bearer check for the collector endpoints and an
// optional password gate for the dashboard. For stronger protection, put the
// deployment behind Cloudflare Access (see README).

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time-ish string comparison.
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const SESSION_COOKIE = 'app_session';

/** Derive the session-cookie value from the configured app password. */
export function sessionToken(password: string): Promise<string> {
  return sha256Hex(`financing-invoices:v1:${password}`);
}

export async function verifySession(cookieValue: string | undefined, password: string): Promise<boolean> {
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await sessionToken(password));
}

/** Extract a Bearer token from the Authorization header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}
