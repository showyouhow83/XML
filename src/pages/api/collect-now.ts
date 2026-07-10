import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Triggers the "Collect invoices" GitHub Actions workflow so the user can pull
// new invoices from the dashboard instead of opening GitHub. Requires a GitHub
// token (Actions read+write) in the GH_DISPATCH_TOKEN secret.
export const POST: APIRoute = async ({ redirect, request }) => {
  const token = env.GH_DISPATCH_TOKEN;
  const repo = env.GITHUB_REPO || 'showyouhow83/XML';
  if (!token) return redirect('/?collect=notoken');

  let lookback = '730';
  let fullRescan = '0';
  try {
    const form = await request.formData();
    const v = Number(form.get('lookback'));
    if (Number.isFinite(v) && v > 0) lookback = String(Math.floor(v));
    if (form.get('full')) fullRescan = '1';
  } catch {
    // no form body — use default
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/collect.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'financing-inbox',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { lookback_days: lookback, full_rescan: fullRescan } }),
      }
    );
    return redirect(res.status === 204 ? '/?collect=queued' : '/?collect=error');
  } catch {
    return redirect('/?collect=error');
  }
};
