import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { ensureSchema, setAiModel } from '../../lib/db';
import { isValidAiModel } from '../../lib/ai';

export const prerender = false;

// Save Ivan's model choice from the AI settings page. Session-gated (middleware).
// An empty / "default" value clears the override (falls back to deploy defaults).
export const POST: APIRoute = async ({ request, redirect }) => {
  await ensureSchema(env.DB);

  let model = '';
  try {
    const form = await request.formData();
    model = String(form.get('model') || '');
  } catch {
    try {
      const body: any = await request.json();
      model = String(body?.model || '');
    } catch {
      // leave empty → clears the override
    }
  }

  if (model === '' || model === 'default') {
    await setAiModel(env.DB, null);
  } else if (isValidAiModel(model)) {
    await setAiModel(env.DB, model);
  } else {
    return redirect('/ai?error=model');
  }
  return redirect('/ai?saved=model');
};
