import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// Triggers the "Collect invoices" GitHub Actions workflow so the user can pull
// new invoices from the dashboard instead of opening GitHub. Requires a GitHub
// token (Actions read+write) in the GH_DISPATCH_TOKEN secret.
export const POST: APIRoute = async ({ redirect }) => {
  const token = env.GH_DISPATCH_TOKEN;
  const repo = env.GITHUB_REPO || 'showyouhow83/XML';
  if (!token) return redirect('/?collect=notoken');

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
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    return redirect(res.status === 204 ? '/?collect=queued' : '/?collect=error');
  } catch {
    return redirect('/?collect=error');
  }
};
