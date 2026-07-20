# Paperless Sync — a Cortex App

Sync your [paperless-ngx](https://docs.paperless-ngx.com/) document archive
into the [Cortex](https://github.com/mocaOS/cortex-app) knowledge graph.

Paperless has already OCR'd and extracted the text of every document — this
app ships that text into Cortex as markdown (with title, correspondent, tags,
dates, and a backlink to the paperless document), so your archive becomes
searchable, graph-connected knowledge in seconds per document instead of
re-running OCR.

Built from [cortex-app-template](https://github.com/mocaOS/cortex-app-template).
Type: `static` (runs entirely in the browser, sandboxed inside your instance).

## Install

1. `npm install && npm run package` → `paperless-sync-{version}.zip`
2. Cortex admin → **Settings → Apps → Install**, upload the zip.
3. Configure the app (Settings → Apps → Configure): set `PAPERLESS_BASE_URL`
   to your paperless instance — this whitelists the origin in the app's CSP.
4. On the **paperless side**, allow your Cortex origin to call its API:

   ```
   PAPERLESS_CORS_ALLOWED_HOSTS=https://your-cortex-host
   ```

5. Open the app (`/apps` → Paperless Sync), enter your paperless URL + API
   token (created in paperless under *My Profile → API Token*). The token is
   kept in your browser's localStorage only — it is never uploaded.

## What syncing does

- Lists every paperless document (paginated, newest first)
- Skips documents already in Cortex — filenames are deterministic
  (`paperless-{id}-{slug}.md`), so re-running only uploads what's new
- For each new document: fetches the extracted text, renders markdown with
  metadata (correspondent/tags/type resolved to names) + a source link, and
  uploads it via `POST /api/upload` (`source=paperless-sync`)
- 2 documents in flight, stoppable mid-run, per-document status + errors

Cortex then runs its normal pipeline (chunking, embeddings, entity
extraction) on each document — watch progress on the Documents page.

## Manifest notes

- `keyScope: read_write` — the app's minted key needs MANAGE for uploads
- `endpoints: ["upload", "documents", "collections"]` — everything else 403s
- Paperless is called browser-direct (declared via `externalHosts`); the API
  token never touches the Cortex server. When Cortex platform apps land,
  this can move server-side (secret-injected `platform/http`) for
  headless/background syncs.

## Dev loop

```
cp .env.example .env   # CORTEX_DEV_URL + a cortex_rw_… key
npm run dev
```

In dev there is no CSP, but paperless CORS still applies to the Vite origin
(`http://localhost:5173`).
