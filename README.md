# Financing Inbox

Collect electronic-invoice **XML** files (and their matching **PDF**) from your
clients' email inboxes, extract the financial data, and store it in a database
you can sort, filter, and export.

This replaces a manual IMAP script: instead of downloading XML files to a folder,
the app pulls from **many mailboxes**, pairs each invoice XML with its PDF,
parses the amounts (Costa Rica Hacienda comprobantes: Factura, Nota de Crédito,
Tiquete, …), and saves everything to a dashboard.

## Architecture

```
┌─ Cloudflare Worker (Astro + D1) ──────────────┐     ┌─ GitHub Actions (cron) ─┐
│  • Dashboard: sort / filter / export invoices │◀────│  Node collector          │
│  • Mailboxes: IMAP creds, encrypted at rest   │     │  imapflow + mailparser   │
│  • /api/collector/* (bearer-auth ingest)      │────▶│  → pair XML + PDF        │
└───────────────────────────────────────────────┘     │  → extract → push to D1  │
                                                       └──────────────────────────┘
```

Why the split? Cloudflare Workers can't open raw IMAP (TCP) connections, so the
IMAP part runs in Node — on a schedule via GitHub Actions, or on demand locally.
Everything else (UI, database, extraction, downloads) runs on Cloudflare.

## Prerequisites

- Node.js 22+
- A [Cloudflare account](https://dash.cloudflare.com) (free tier is fine)
- `npx wrangler login` (authenticates the Cloudflare CLI)

## 1. Install

```sh
npm install
```

## 2. Create the D1 database

```sh
npm run db:create          # npx wrangler d1 create financing-invoices
```

Copy the printed `database_id` into **`wrangler.jsonc`** (replace
`REPLACE_WITH_YOUR_D1_DATABASE_ID`). Then create the tables:

```sh
npm run db:migrate         # remote (production) database
npm run db:migrate:local   # local database used by `npm run dev`
```

(The app also creates tables on first use via `CREATE TABLE IF NOT EXISTS`, so
migrations are optional but recommended.)

## 3. Configure secrets

Generate two secrets:

```sh
openssl rand -base64 32    # -> TOKEN_ENC_KEY  (encrypts IMAP passwords at rest)
openssl rand -hex 32       # -> INGEST_TOKEN   (collector <-> app shared secret)
```

**Local dev** — copy `.dev.vars.example` to `.dev.vars` and fill in:

```
TOKEN_ENC_KEY="…"
INGEST_TOKEN="…"
APP_PASSWORD=""            # optional: password-gate the dashboard
```

**Production** — set the same values as Worker secrets:

```sh
npx wrangler secret put TOKEN_ENC_KEY
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put APP_PASSWORD      # optional
```

## 4. Run locally

```sh
npm run dev                # http://localhost:4321
```

## 5. Deploy

```sh
npm run deploy             # astro build && wrangler deploy -c dist/server/wrangler.json
```

The `SESSION` KV namespace and `IMAGES` binding the adapter adds are provisioned
automatically on first deploy. Note your Worker URL — it's your `APP_URL`.

Optional GitHub Actions deploy (`.github/workflows/deploy.yml`) runs on pushes to
`main` if you set repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 6. Add client mailboxes

Two options — use either or both:

**A. In the app** — open **Mailboxes**, add each client's IMAP host, user, and
password. Passwords are AES-GCM encrypted before they hit the database.

**B. A JSON file** — copy `collector/mailboxes.example.json` to
`collector/mailboxes.json` (git-ignored) and list your mailboxes there. Handy for
bulk setup. The collector uses this file if present, otherwise it reads the list
from the app.

> **Gmail / Workspace:** use an **app password** (needs 2-step verification), not
> the account's login password.

## 7. Collect

**Test one mailbox first (read-only, no database):**

```sh
IMAP_USER="you@gmail.com" IMAP_PASS="app-password" npm run probe
```

This connects, finds recent invoice emails, pairs XML + PDF, extracts the fields,
and prints a summary — pushing nothing anywhere. Great for confirming IMAP access
and parsing on a real mailbox. (Requires port 993 to be reachable from where you
run it — a laptop or GitHub Actions works.)

**On demand (local, full pipeline into D1):**

```sh
APP_URL="https://your-worker.workers.dev" INGEST_TOKEN="…" npm run collect
```

Add `--dry-run` to rehearse the full multi-mailbox run — it connects and extracts
from every mailbox but **stores nothing**, printing what it would ingest:

```sh
npm run collect -- --dry-run          # with a collector/mailboxes.json, needs no app at all
```

**Automatically (GitHub Actions cron):** the workflow in
`.github/workflows/collect.yml` runs daily. Add these repository secrets:

| Secret           | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| `APP_URL`        | your deployed Worker URL                                     |
| `INGEST_TOKEN`   | same value as the Worker secret                              |
| `MAILBOXES_JSON` | *(optional)* a full JSON array of mailboxes (option B above) |

Mailboxes are processed **5 at a time** (`CONCURRENCY`, default 5) to avoid
tripping provider rate limits / suspensions.

## How extraction & PDF matching work

For each recent email with an XML attachment, the collector:

1. reads every XML and PDF attachment,
2. pairs each XML with its PDF — same base filename first, else the sole PDF in
   the email, else a PDF whose name contains the invoice's `clave`/consecutivo,
3. parses the XML (`src/lib/invoice.ts`) into: clave, document type,
   consecutivo, date, issuer/receiver name + ID, currency, and totals
   (gravado, exento, descuentos, venta neta, impuesto, comprobante),
4. skips Hacienda acknowledgement messages (`MensajeReceptor`),
5. pushes the rows + raw XML + PDF to the app, which upserts them into D1
   (deduplicated by `clave`).

## Security notes

- IMAP passwords are encrypted at rest (AES-GCM) with `TOKEN_ENC_KEY`.
- The collector endpoints require the `INGEST_TOKEN` bearer secret.
- Set `APP_PASSWORD` to gate the dashboard, and/or put the Worker behind
  [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  for real authentication.
- If an IMAP/app password is ever shared or leaked, revoke and regenerate it.

## Project layout

```
src/
  lib/invoice.ts      XML -> structured invoice (pure, unit-tested)
  lib/db.ts           D1 schema + queries
  lib/crypto.ts       AES-GCM encrypt/decrypt for stored passwords
  lib/auth.ts         bearer + session helpers
  middleware.ts       collector bearer auth + optional dashboard gate
  pages/              dashboard, mailboxes, login, and /api/* endpoints
collector/
  index.ts            IMAP collector (Node; runs in CI or locally)
  mailboxes.example.json
migrations/           D1 schema
scripts/              extractor tests + sample XML
```

## Useful commands

| Command                | Action                                          |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | Local dev server                                |
| `npm run build`        | Build the Worker                                |
| `npm run deploy`       | Build + deploy to Cloudflare                    |
| `npm run collect`      | Run the IMAP collector (full pipeline into D1)  |
| `npm run probe`        | Read-only test of one mailbox (no database)     |
| `npm run test:extract` | Validate the XML extractor against sample files |
| `npm run test:collect` | Validate XML/PDF pairing on a real-email layout |
| `npm run check`        | Type-check the app                              |
