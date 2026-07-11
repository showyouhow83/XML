# Financing Inbox — project guide

Living doc for this project. Keeps us on the same page: what it is, where we are,
where we're going. Update the **Changelog** and **Roadmap** as we work.

## What this is

A tool for a Costa Rica accounting / financing workflow: automatically pull
**electronic invoices** (Hacienda comprobantes — Factura, Tiquete, Nota de
Crédito/Débito) from client email inboxes, extract every field, store them in a
database, and browse / filter / group / export them. Eventually an AI agent to
query the data in natural language.

Replaces a manual Python IMAP script that just downloaded XML attachments to a
folder.

## Live deployment

- **App:** https://xml.showyouhow83.workers.dev
- **Cloudflare Worker:** `xml` (account `f2cb7f9c07dd4587efbd7772ff8e324f`)
- **D1 database:** `xml-db` (`c067759f-d1ee-44d8-8987-da4ff0ffd01f`)
- **KV (Astro sessions):** `SESSION` (`45ae82c006684626bb5fb721799de4ea`)
- **Repo:** github.com/showyouhow83/XML (default branch `main`)
- **Deploy:** push to `main` → Cloudflare **Workers Builds** auto-builds & deploys
  (`npm run build` then `wrangler deploy`). No manual deploy step.

## Architecture

```
Cloudflare Worker (Astro SSR + D1)             GitHub Actions (Node collector)
- Dashboard: browse / filter / group / export  - imapflow: connect to each mailbox
- /invoice/<clave> detail pages                - mailparser: XML + matching PDF
- Mailboxes admin (IMAP creds, encrypted)      - extract CR factura fields
- /api/collector/* (bearer-auth ingest)  <---- - POST results to the Worker → D1
- "Collect now" button → dispatches Action --> triggers this workflow
```

**Why split?** Cloudflare Workers can't open raw IMAP (TCP) sockets, so IMAP runs
in a Node "collector" on GitHub Actions (nightly cron + on-demand dispatch).

## Key decisions (and why)

- **IMAP, not Gmail OAuth** — the user holds IMAP passwords for many client
  mailboxes; OAuth-per-client is impractical and not all clients are Gmail.
- **Collector on GitHub Actions** — Workers can't do IMAP; Actions gives free
  Node + cron + on-demand `workflow_dispatch`.
- **Cloudflare D1** — native SQLite that binds straight to the Worker.
- **Bindings pinned by id** in `wrangler.jsonc` (SESSION KV, DB D1) — auto-
  provisioning tried to *re-create* existing resources and the deploy failed.
- **Astro 7 / `@astrojs/cloudflare` v14** — access bindings with
  `import { env } from "cloudflare:workers"` (NOT `Astro.locals.runtime.env`,
  which was removed in Astro 6).

## Data model (D1)

- **mailboxes** — id, label, email, host, port, username, `password_enc`
  (AES-GCM), use_ssl, lookback_days, active, last_synced_at, last_status,
  `synced_from` (oldest date covered), `last_uid` + `uidvalidity` (incremental
  IMAP watermark — highest UID already pulled, so re-runs fetch only new mail).
- **invoices** — `clave` (PK), doc_type, consecutivo, fecha_emision, emisor_* ,
  receptor_* , moneda, tipo_cambio, `iva_rate`, condicion_venta, codigo_actividad,
  totals (gravado / exento / exonerado / descuentos / venta_neta / impuesto /
  otros_cargos / comprobante), source_account, message_uid, has_pdf, received_at,
  `detail_json`, created_at.
- **attachments** — `clave` (PK), xml_content (raw XML), pdf_content (base64).
- **app_state** — tiny key/value flags. Holds the **collection lock** (`collection_run`):
  set while a collection is running so only one runs at a time across all clients;
  released on finish, or auto-freed after a 60-min stale timeout.
- `detail_json` holds line items, otros cargos, tax breakdown, and the
  `<Otros><OtroTexto codigo="…">` key/values (Periodo Facturado, etc.).

Extraction lives in `src/lib/invoice.ts` (pure, shared by the Worker and the
collector). It skips Hacienda acceptance messages (`_respuesta` /
MensajeReceptor / MensajeHacienda).

## Secrets (names only — values live in the platforms, never in the repo)

Worker (Cloudflare → `xml` → Settings → Variables and Secrets):
- `TOKEN_ENC_KEY` — AES-GCM key encrypting IMAP passwords at rest.
- `INGEST_TOKEN` — shared secret authenticating the collector ↔ app.
- `APP_PASSWORD` — dashboard login gate (optional).
- `GH_DISPATCH_TOKEN` — GitHub fine-grained token (Actions read+write) so the
  "Collect now" button can trigger the workflow.
- `ANTHROPIC_API_KEY` — Claude API key powering the **Ask AI** page (optional; the
  page shows a "not configured" notice until it's set).

GitHub repo → Settings → Secrets → Actions:
- `APP_URL` = https://xml.showyouhow83.workers.dev
- `INGEST_TOKEN` = same value as the Worker's.

## Current state (works today)

- Deployed and collecting from `realifecr@gmail.com`.
- Full extraction of CR v4.x facturas: IVA rate, line items, otros cargos, `Otros`
  fields, all totals.
- Dashboard: sortable table; filters (search, mailbox, type, currency, **cédula**,
  date range, PDF); per-currency totals; **Group by issuer (cédula)** summary; CSV
  export; per-invoice **detail page** (with XML + PDF download).
- **Collect now** button with a **"how far back" picker** (30 days – 5 years);
  nightly cron defaults to 2 years.
- Mailboxes page: invoice count per mailbox + live **⟳ collecting… / ✓ up to
  date** status (auto-refreshes during a run).
- Collection runs on GitHub's servers (safe to leave the page). After a mailbox's
  first pull it syncs **incrementally** — only new mail (by IMAP `UID`) — so
  nothing already stored is re-fetched; `clave` also guarantees no duplicates. A
  **“re-scan all”** toggle forces a full re-read.
- **Only one collection runs at a time**, globally: while a run is in progress the
  **Collect now** button is disabled on every client (shared D1 lock), and the
  GitHub Actions workflow has a `concurrency` group so a second trigger queues
  instead of running concurrently — no racing, no double-pulling.
- **Ivan** — a floating **Ask AI chat** (bottom-right on every page): ask in plain
  Spanish/English → Claude writes a read-only SQL query over `invoices`, runs it
  on D1, and explains the answer in your language (renders tables; shows SQL +
  rows). The conversation **persists across navigation** (sessionStorage), so you
  can open an invoice while chatting. Needs the `ANTHROPIC_API_KEY` secret.
- Nav is organized as **Dashboard / Settings**; **Mailboxes** lives under
  **Settings**. Layout is responsive (usable on phones).

## Roadmap (where we're going)

Near-term:
- [ ] Per-mailbox editable "how far back" (not only the global picker).
- [ ] In-app live progress (emails found / imported) — needs the collector to
      stream progress to an endpoint the dashboard polls.
- [x] Faster nightly runs — scheduled runs use a 30-day rolling window; the deep
      backfill is on demand.
- [x] **True incremental sync** — after a mailbox's first pull, runs fetch only
      new mail by IMAP `UID` (guarded by `UIDVALIDITY`); nothing already stored is
      re-downloaded or re-written. A **“re-scan all”** toggle forces a full
      re-read (use after extractor changes).
- [x] "Customer data complete through <date>" — Mailboxes shows **covers back to
      <date>** per customer (`synced_from`).

Later:
- [x] **AI agent** to query the data in natural language ("total IVA paid to
      Liberty in Q2", "gastos by vendor this month") — the **Ask AI** page
      (text→SQL→answer). Next refinements: charts, saved questions, multi-step
      reasoning across line items.
- [ ] Line-item-level table + CSV (analysis across all invoices).
- [ ] Reporting / period summaries per client (for tax filing).
- [ ] R2 for PDF storage at scale (currently base64 in D1).
- [ ] Onboard many client mailboxes.

## How to work on it

- Dev server: `astro dev --background` (manage with `astro dev stop|status|logs`).
  Needs `.dev.vars` with the secrets; local D1 comes from wrangler.
- Tests: `npm run test:extract`, `npm run test:collect` (extractor + XML↔PDF
  pairing, incl. a real Grupo ICE email layout).
- Probe one mailbox, read-only: `IMAP_USER=… IMAP_PASS=… npm run probe`.
- Typecheck: `npm run check`. Build: `npm run build`.
- **Ship:** develop on branch `claude/financing-data-retrieval-ui-76hf9r` → PR →
  merge to `main` → Workers Builds auto-deploys. After extractor/schema changes,
  **re-run the collector** so already-stored invoices re-extract with new fields.

## Changelog (newest first)

- **#16** **Ivan chat widget + Settings + responsive** — Ask AI became **Ivan**, a
  floating chat available on every page (`src/components/AskWidget.astro` in the
  layout) whose conversation persists across navigation via `sessionStorage`;
  answers reply in the user's language (Spanish/English) and render Markdown
  tables. Nav reorganized to **Dashboard / Settings** with a new `/settings` hub
  and Mailboxes moved under it; the old `/ask` page redirects to `/`. Mobile/
  responsive CSS pass.
- **#15** **Single-run collection lock** — only one collection can run at a time
  across all clients. A shared D1 lock (`app_state.collection_run`) disables the
  **Collect now** button everywhere while a run is in progress (auto-freed after a
  60-min stale timeout), the collector reports start/heartbeat/finish
  (`/api/collector/run`), and the workflow gains a `concurrency` group so a second
  trigger queues instead of double-running.
- **#14** **Incremental collection** — the collector now remembers the highest
  IMAP `UID` pulled per mailbox (`last_uid` + `uidvalidity`) and, after the first
  sync, fetches only newer messages. No re-downloading or re-writing of invoices
  you already have; `clave` still guarantees no duplicates. New **“re-scan all”**
  dashboard toggle (+ `full_rescan` workflow input) forces a full re-read after
  extractor changes.
- **#13** **Ask AI** page — natural-language questions over the invoices. Claude
  (`claude-opus-4-8`) writes a read-only `SELECT` (validated: single statement,
  `invoices` table only, no writes/creds/blobs), runs it on D1, and summarizes
  the rows. New: `src/lib/ai.ts`, `/api/ask`, `/ask`. Needs `ANTHROPIC_API_KEY`.
  Later refined: answers render real Markdown **tables**, the page is **multi-turn**
  (follow-ups keep context via a `history` param), and a smarter default treats a
  named cédula as the **vendor** (with an auto-retry of the other role on 0 rows).
- **#12** Faster nightly sync (30-day rolling window) + per-mailbox "covers back
  to <date>" signal (`synced_from`).
- **#10** Collect date picker (how-far-back) + live per-mailbox status/progress.
- **#9** "Collect now" button (dashboard-triggered) + group/filter by issuer cédula.
- **#8** Collector looks back 2 years by default (backfill history).
- **#7** Full invoice extraction (IVA rate, line items, otros cargos, Otros
  fields) + per-invoice detail page + wider CSV.
- **#5 / #4** Fix Cloudflare deploy: pin SESSION KV + DB D1 by id; drop the
  redundant GitHub Actions deploy path.
- **#3** Initial app: IMAP collector + Cloudflare dashboard + D1.
