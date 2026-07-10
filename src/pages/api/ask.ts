import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema } from '../../lib/db';
import { askInvoices } from '../../lib/ai';

export const prerender = false;

// POST { question } -> { answer, sql, rows, rowCount, truncated, error? }
export const POST: APIRoute = async ({ request }) => {
  if (!env.ANTHROPIC_API_KEY) {
    return Response.json(
      { error: 'AI is not configured. Add an ANTHROPIC_API_KEY secret to the Worker to enable Ask AI.' },
      { status: 503 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return Response.json({ error: 'Please enter a question.' }, { status: 400 });
  if (question.length > 2000) return Response.json({ error: 'Question is too long.' }, { status: 400 });

  try {
    await ensureSchema(env.DB);
    const result = await askInvoices(env.DB, env.ANTHROPIC_API_KEY, question);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: `Ask failed: ${(err as Error).message}` }, { status: 500 });
  }
};
