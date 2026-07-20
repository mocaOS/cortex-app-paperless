# Paperless Sync — a Cortex App

Sync your [paperless-ngx](https://docs.paperless-ngx.com/) document archive
into the [Cortex](https://github.com/mocaOS/cortex-app) knowledge graph —
on demand or on a schedule, fully server-side.

Paperless has already OCR'd and extracted the text of every document — this
app ships that text into Cortex as markdown (with title, correspondent, type,
dates, and a backlink to the paperless document), so your archive becomes
searchable, graph-connected knowledge in seconds per document instead of
re-running OCR.

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

- **setup** — reads the sync cursor from app storage, lists documents added
  since it (paginated), and fetches correspondent/type name maps
- **per document** (2 in flight, per-item error isolation) — fetches the
  extracted text, skips documents without any, renders markdown, uploads it
  via `POST /api/upload` (`source=paperless-sync`), and marks the document
  synced in app storage (`synced/{id}`) so it is never uploaded twice
- **finally** — advances the cursor, but only when nothing failed, so failed
  documents are retried by the next run

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
