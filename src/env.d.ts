/// <reference types="@cloudflare/workers-types" />
/// <reference path="../.astro/types.d.ts" />

// Cloudflare bindings, accessed via `import { env } from "cloudflare:workers"`.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    SESSION: KVNamespace;
    IMAGES: ImagesBinding;
    // 32-byte base64 key used to encrypt IMAP passwords at rest.
    TOKEN_ENC_KEY: string;
    // Shared secret the GitHub Actions collector uses to authenticate.
    INGEST_TOKEN: string;
    // Optional password gate for the dashboard UI.
    APP_PASSWORD?: string;
    // Optional: GitHub token (Actions read+write) so the "Collect now" button can
    // trigger the collector workflow. Plus the "owner/repo" it lives in.
    GH_DISPATCH_TOKEN?: string;
    GITHUB_REPO?: string;
  }
}

interface Env extends Cloudflare.Env {}

declare namespace App {
  // Merges with the adapter's `Locals extends Runtime` to add our own field.
  interface Locals {
    isAuthed: boolean;
  }
}
