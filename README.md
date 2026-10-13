# Paperless Sync — a Cortex App

Sync your [paperless-ngx](https://docs.paperless-ngx.com/) document archive
into the [Cortex](https://github.com/mocaOS/cortex-app) knowledge graph —
on demand or on a schedule, fully server-side.

This app ships the **full documents** into Cortex: for each paperless
document it downloads the archived PDF (paperless's OCR'd, text-layered
version — or the original upload when no archive exists) and streams it
straight into Cortex ingestion. Docling parses the real document — layout,
tables, images — so your graph sees everything, not just the extracted text.
The paperless id and title stay in the Cortex filename
(`paperless-{id}-{filename}`).

> Requires a Cortex instance with binary passthrough upload (cortex-app
> ≥ 2.1 / July 2026 platform extensions). Documents the platform can't
> carry — file types Cortex ingestion doesn't accept, or files over the
> 20 MB transfer cap — are skipped with a visible reason and marked
> handled, so they never block the rest of the archive.
>
> Upgrading from ≤ 0.3.x: already-synced documents keep their markdown
> version (the dedup state protects them from re-upload). To re-ingest an
> existing archive as full documents, delete the old markdown documents in
> Cortex and uninstall + reinstall the app (uninstalling clears the app's
> sync state), then run a fresh sync.

Built from [cortex-app-template](https://github.com/mocaOS/cortex-app-template).
Type: `platform` — the sync itself runs **inside Cortex** as a declarative
platform task, not in your browser. Close the tab and it keeps going; give
it a schedule and it becomes a standing sync daemon with no browser anywhere.

## Install

1. `npm install && npm run package` → `paperless-sync-{version}.zip`
2. Cortex admin → **Settings → Apps → Install**, upload the zip.
   (Requires `ENABLE_APPS=true` on the instance.)
3. Configure the app (Settings → Apps → Configure):
   - `PAPERLESS_BASE_URL` — your paperless instance URL
   - `PAPERLESS_TOKEN` — a paperless API token (*My Profile → API Token*).
     Stored encrypted in Cortex, injected server-side on every call — it
     never reaches the browser, and paperless needs **no CORS setup**.
4. Open the app (`/apps` → Paperless Sync), pick a schedule (or stay
   manual) and a target collection, and hit **Sync**.

## How the sync works

The app submits one declarative task (`tasks` capability) that Cortex
executes in its own async loop:

- **setup** — reads the sync cursor from app storage and lists documents
  added *or edited* since it (`modified`), oldest first, capped at 2000 per run (the platform's
  fan-out limit) — larger archives drain batch by batch across runs, and
  the UI says so when a run hits the cap
- **per document** (2 in flight, per-item error isolation) — guards first:
  an unsupported file type or a file over the 20 MB transfer cap is marked
  handled and *skipped* (skips never block the cursor — only transient
  failures do, and those retry next run). Then a binary passthrough upload:
  Cortex downloads `/api/documents/{id}/download/` server-side (token
  injected from encrypted config; bytes never touch a browser) and streams
  it into `POST /api/upload` (`source=paperless-sync`), then marks the
  document synced in app storage (`synced/{id}:{modified}`) so an unchanged
  document is never uploaded twice. A document edited in paperless
  **replaces its Cortex document in place** (stable `source_key` + the
  previous document id from `docmap/{id}`): same document id, only the
  changed parts re-extracted. Since v0.5.0 — earlier versions never
  re-synced edits. Upgrading seeds `docmap/` from existing
  `paperless-{id}-…` filenames and starts the modified cursor at the old
  added cursor, so documents touched since then re-upload once into their
  existing document (a no-op in Cortex when the bytes are identical). On a
  Cortex backend without in-place replace, an edit uploads a new document
  and the previous one is deleted
- **finally** — advances the cursor past the listed batch, but only when
  nothing failed, so failed documents are retried by the next run

With a schedule (`every hour` / `6 hours` / `daily`), Cortex re-runs the
task on its own. The app UI is just a dashboard: live progress, pause /
cancel / retry-failed, and per-document errors. Runs survive Cortex
restarts (they resume on boot).

Cortex then runs its normal pipeline (chunking, embeddings, entity
extraction) on each document — watch progress on the Documents page.

Documents synced by pre-task versions of this app are recognized by their
deterministic filenames (`paperless-{id}-{slug}.md`) and seeded into the
dedup state on first load — nothing is uploaded twice across versions.

## Manifest notes

- `keyScope: read_write` — the app's minted key needs MANAGE for uploads
- `endpoints: ["upload", "documents", "collections"]` — everything else 403s
- `capabilities: http` (paperless calls, host-allowlisted to
  `${PAPERLESS_BASE_URL}`, token injected server-side), `tasks` (the sync
  engine), `storage` (cursor + dedup keys + shared UI preferences)

## Dev loop

```
cp .env.example .env   # CORTEX_DEV_URL + a cortex_rw_… key
npm run dev
```

The Vite proxy plays the hosting proxy's role in dev; platform calls hit
your configured dev instance.
