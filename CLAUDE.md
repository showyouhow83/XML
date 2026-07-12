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
- **R2 bucket (invoice PDFs):** `xml-pdfs` (binding `PDFS`) — raw PDF bytes live
  here, not base64 in D1, grouped into a **folder per mailbox**
  (`<mailbox-email>/<clave>.pdf`) so each client's PDFs sit together. Create it
  once: `wrangler r2 bucket create xml-pdfs`.
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
- **attachments** — `clave` (PK), xml_content (raw XML in D1), pdf_content
  (legacy base64 — PDFs now live in **R2** as raw bytes under
  `<mailbox-email>/<clave>.pdf`, a folder per mailbox; old objects were flat at
  `pdf/<clave>.pdf` and reads still fall back to that key). This column is nulled
  once a PDF is migrated to R2, and is only a fallback for not-yet-migrated PDFs.
- **app_state** — tiny key/value flags. Holds the **collection lock** (`collection_run`):
  set while a collection is running so only one runs at a time across all clients;
  released on finish, or auto-freed after a 60-min stale timeout. Also holds the
  **collection schedule** (`collection_schedule`): how often the nightly run
  actually collects (daily / weekly / biweekly / monthly-on-day). And **Ivan's
  model** (`ai_model`): the in-app override for which Claude model powers Ask AI
  (applies to all 3 steps; unset → the `AI_MODEL_*` deploy defaults).
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
- `AI_MODEL_SQL` / `AI_MODEL_REVIEW` / `AI_MODEL_SUMMARY` — per-step model for Ivan.
  Set to `claude-sonnet-5` in `wrangler.jsonc` **vars** (proven ==Opus at ~½ cost
  by the quiz), so they deploy from the repo — no dashboard step. Delete a key to
  fall back to Opus for that step; the code default is Opus.

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
- **Editable collection schedule** (Settings): the nightly cron fires every night,
  but the collector only actually runs when the chosen schedule is due — **daily /
  weekly / every 2 weeks / monthly on a chosen day** (Costa Rica time). Manual
  **Collect now** always runs regardless.
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
- [x] **R2 for PDF storage** — PDFs are stored in R2 (raw bytes) instead of
      base64 in D1, **grouped into a folder per mailbox** (`<email>/<clave>.pdf`);
      ingest uploads to R2, download reads R2 (D1 fallback), a Settings button
      migrates/organizes existing PDFs, and each Mailboxes row can **download all
      its PDFs as a zip**. Keeps D1 lean + off the 10 GB cap.
- [ ] Onboard many client mailboxes.

## How to work on it

- Dev server: `astro dev --background` (manage with `astro dev stop|status|logs`).
  Needs `.dev.vars` with the secrets; local D1 comes from wrangler.
- Tests: `npm run test:extract`, `npm run test:collect` (extractor + XML↔PDF
  pairing, incl. a real Grupo ICE email layout).
- Ivan model quiz: `ANTHROPIC_API_KEY=… npm run ai-quiz [-- opus hybrid sonnet haiku]`
  — grades model configs on a synthetic invoice set with known answers.
- Probe one mailbox, read-only: `IMAP_USER=… IMAP_PASS=… npm run probe`.
- Typecheck: `npm run check`. Build: `npm run build`.
- **Ship:** develop on branch `claude/financing-data-retrieval-ui-76hf9r` → PR →
  merge to `main` → Workers Builds auto-deploys. After extractor/schema changes,
  **re-run the collector** so already-stored invoices re-extract with new fields.

## Changelog (newest first)

- **#27** **Dashboard restyle to match the new design language** — the dashboard
  now shares the Settings look: **icon-tile KPI cards** (🧾 invoices / 📎 with PDF /
  📥 mailboxes / 💰 per-currency totals), a **harmonized 12px radius** across cards,
  panels and the table (bumped the global `--radius`), and a **roomier table**
  (more padding, softer header). Pure styling + KPI-card markup; no behavior change.
  Verified with light/dark/mobile screenshots on seeded sample data.
- **#26** **Settings hub redesign + rename to “Recibos XML” + IVA filter** — the
  Settings page is now a **grouped list** (icon · title/description · current value ·
  chevron) instead of a flat card grid, so it reads like real settings; the sub-pages
  are unchanged. The app is renamed **Recibos XML** (nav brand, page titles, login),
  and the **brand in the top nav links to the dashboard**. On the dashboard, the
  **Currency** filter (everything is colones) is replaced by an **IVA %** filter
  (distinct `iva_rate` values); CSV export honors it too. New CSS: `.settings-list` /
  `.set-row*`; db: `InvoiceFilters.ivaRate` + `filterOptions().ivaRates`. Verified
  against a running dev server (settings screenshots + 5/5 filter checks).
- **#25** **Ivan gets its own AI page + in-app model picker** — the **Ivan · Ask AI**
  card now opens a dedicated **`/ai`** page (breadcrumb `Settings › Ivan · AI`), like
  Mailboxes and Collection. There you pick which **Claude** model powers Ivan —
  **Haiku 4.5 / Sonnet 5 (default) / Opus 4.8 / Fable 5**, or “Deployment default” —
  so you can bump to a stronger model when you want. The choice persists in
  `app_state.ai_model` and applies to all 3 Ivan steps, overriding the `AI_MODEL_*`
  deploy vars; the Settings card summarizes the effective model. New: `src/pages/ai.astro`,
  `/api/ai-model`, `getAiModel`/`setAiModel`, and `AI_MODEL_CHOICES`/`isValidAiModel`/
  `aiModelLabel` in `ai.ts`. **Gemini/GPT are intentionally not wired** — each would
  need its own API key **and** a pass through the `ai-quiz` accuracy harness before it
  touches the financial data; the page says so. Verified against a running dev server
  (14/14 across two runs).
- **#24** **Collection gets its own page under Settings** — the collection
  **schedule** editor moved off the Settings page onto a dedicated **`/collection`**
  page (breadcrumb `Settings › Collection`), so the **Collection** card now opens
  its own page exactly like the **Client mailboxes** card — consistent Settings
  IA instead of a form dumped inline. The card still summarizes the active cadence;
  `/api/schedule` now redirects to `/collection?saved=schedule`. Verified against a
  running dev server (9/9).
- **#23** **“Organize PDFs” button hides once the work is done** — it used to show
  whenever any PDFs existed (keyed to the total count), so it reappeared on every
  reload even after everything was already grouped by mailbox. It's now gated on
  **work actually remaining**: base64 still in D1 (`pdfsInD1Count`) **or** objects
  still at the old flat R2 keys (new `hasLegacyPdfObjects`, an R2 `list` on the
  `pdf/` prefix). Once everything is foldered both are zero and the button/message
  flips to “stored in R2, grouped by mailbox ✓”; new invoices arrive foldered via
  ingest, so they never re-trigger it. Verified with a mock-R2 harness (8/8).
- **#22** **Instant button/action feedback + Collection card links to its schedule**
  — every button now shows its press was captured and, when it starts async work
  (a form POST/redirect, a fetch, a file download), a **spinner + disabled busy
  state** until it finishes, so the app never looks frozen while something runs in
  the background (this is why the PDF-organize button felt dead). It's global: a
  small script in `Base.astro` busies the submitting button on any form submit
  (skipping `data-no-busy` forms like Ivan's, and cancelled/`confirm()` submits),
  gives download links (`/api/…`) a transient spinner, and exposes
  `window.__setBusy(el,on,label)` (used by the PDF-organize button). Press/focus/
  busy styles live in `app.css`. Also: the **Collection** settings card is now a
  link to the **Collection schedule** section (`#collection-schedule`) — like the
  Mailboxes card — and keeps summarizing the active cadence (e.g. “Every other
  Thursday”). Verified with a headless-Chromium harness (13/13).
- **#21** **PDFs grouped by mailbox + per-mailbox download** — R2 objects now live
  in a **folder per mailbox** (`<mailbox-email>/<clave>.pdf`) instead of a flat
  `pdf/<clave>.pdf`, so each client's PDFs sit together (browsable in the R2
  dashboard, and zippable). New **⬇ PDFs** button on each Mailboxes row streams a
  zip of that mailbox's PDFs (`/api/download-client`, via `client-zip`). The
  Settings PDF button became **“Move / organize PDFs by mailbox”** — an idempotent,
  resumable (offset-paged) pass that both uploads any base64 still in D1 and folds
  legacy flat-key objects into their mailbox folder. Reads fall back to the legacy
  key, so nothing breaks mid-migration. New: `src/lib/pdfs.ts` foldering
  (`pdfKey`/`legacyPdfKey`/`foldPdf`), `/api/download-client`; dep `client-zip`.
- **#20** **Ivan runs on Sonnet** — the quiz showed **sonnet, hybrid and opus all
  18/18** (haiku 17 + 1 clarify, 0 wrong), so Ivan's three steps now default to
  `claude-sonnet-5` via `wrangler.jsonc` vars (≈½ the Opus cost, no dashboard
  step; deletes → Opus). Also: the quiz grader now scores **clarify vs wrong**
  separately (a clarification is a safe non-answer), and a prompt nudge stops Ivan
  asking vendor-vs-client on Spanish spend questions ("¿cuánto gasté con X?").
- **#19** **Ivan model A/B + quiz** — Ivan's three steps (write SQL / review /
  summarize) each take a configurable model (default Opus everywhere), overridable
  via `AI_MODEL_SQL` / `AI_MODEL_REVIEW` / `AI_MODEL_SUMMARY` Worker vars. New
  `npm run ai-quiz` grades configs (opus / hybrid / sonnet / haiku) against a
  synthetic invoice set with known answers, so a cheaper setup can be proven
  before switching Ivan — runnable locally or from the **Ivan model quiz** GitHub
  Action (needs an `ANTHROPIC_API_KEY` repo secret). New: `scripts/ai-quiz.ts`,
  `.github/workflows/ai-quiz.yml`.
- **#18** **Editable collection schedule** — Settings now lets you choose how often
  the automatic collection runs: **daily / weekly / every 2 weeks / monthly on a
  day** (Costa Rica time). The nightly GitHub cron still fires each night, but the
  collector reads the schedule (`app_state.collection_schedule`, served via
  `/api/collector/schedule`) and only runs when today is due; **Collect now**
  always runs. New: `src/lib/schedule.ts` (shared pure logic), `/api/schedule`.
- **#17** **PDFs in R2** — invoice PDFs now live in an R2 bucket (`xml-pdfs`,
  binding `PDFS`) as raw bytes instead of base64 in D1: ingest uploads to R2,
  `/api/download` serves from R2 (falling back to any base64 still in D1), and a
  **“Move PDFs to R2”** button on Settings migrates existing ones (R2‑first, clears
  the D1 copy only after the upload succeeds). New: `src/lib/pdfs.ts`,
  `/api/migrate-pdfs`. Keeps D1 small and off the 10 GB‑per‑database cap.
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
