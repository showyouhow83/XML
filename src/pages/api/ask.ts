import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema } from '../../lib/db';
import { askInvoices, type AskTurn } from '../../lib/ai';

export const prerender = false;

// POST { question, history? } -> { answer, sql, rows, rowCount, truncated, error? }
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

  // Prior turns (from the client) so follow-up questions keep context.
  const history: AskTurn[] = Array.isArray(body?.history)
    ? body.history
        .filter((h: any) => h && typeof h.question === 'string')
        .slice(-6)
        .map((h: any) => ({
          question: String(h.question),
          sql: typeof h.sql === 'string' ? h.sql : null,
          answer: typeof h.answer === 'string' ? h.answer : undefined,
        }))
    : [];

  try {
    await ensureSchema(env.DB);
    const result = await askInvoices(env.DB, env.ANTHROPIC_API_KEY, question, history);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: `Ask failed: ${(err as Error).message}` }, { status: 500 });
  }
};
