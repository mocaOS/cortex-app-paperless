/**
 * The sync, as a Cortex platform task.
 *
 * Instead of a browser-side loop, the whole paperless → Cortex pipeline is a
 * declarative step-queue that Cortex executes server-side:
 *
 *   setup    read the sync cursor, list documents MODIFIED since it —
 *            OLDEST FIRST, capped at one batch (BATCH_PAGES pages) per run
 *   items    fan out over the listing, deduped against storage keys
 *            (synced/{id}:{modified}) — the modified timestamp is the change
 *            marker, so unchanged documents never transfer twice and
 *            documents edited in paperless re-sync (before v0.5.0 the key
 *            was synced/{id} and edits never reached Cortex)
 *   steps    guards first — a document whose filename extension Cortex
 *            ingestion doesn't accept, or whose file exceeds the platform's
 *            20 MB transfer cap, is marked handled in storage and SKIPPED
 *            (visible reason in the panel). Skips don't count as failures,
 *            so they can never wedge the cursor. Then the binary
 *            passthrough upload — Cortex downloads the actual document
 *            from paperless (/api/documents/{id}/download/, the OCR'd
 *            archive PDF when one exists, the original upload otherwise)
 *            and streams it straight into /api/upload, REPLACING the
 *            document's existing Cortex document in place (source_key +
 *            replace_document_id — same document id, only the changed
 *            parts are re-extracted) → record docmap + mark synced
 *   finally  advance the cursor to the last listed document (only when
 *            nothing failed, so failed documents are retried by the next
 *            run)
 *
 * Batching (v0.4.1): the platform caps a fan-out at 2000 items, so one run
 * syncs at most one batch and the cursor advances only past that batch —
 * archives of any size drain across consecutive (scheduled or manual) runs.
 * The cursor filter is modified__gte + dedup, not __gt, so documents sharing
 * the boundary timestamp are re-listed and skipped instead of lost.
 *
 * Cursor migration (v0.5.0): the modified cursor (sync/cursor-modified)
 * starts from the old added cursor (sync/cursor). Every document added
 * after it, or edited since, is listed — so nothing is missed; documents
 * already in Cortex re-upload once into their existing document, which
 * Cortex treats as a no-op when the bytes are identical.
 *
 * Submit it once with a schedule and the sync runs forever, headless —
 * the browser tab is just a dashboard.
 *
 * Since v0.4.0 Cortex ingests the FULL document, not a markdown re-render
 * of paperless's extracted text: Docling parses the real PDF (layout,
 * tables, images), so the graph sees everything — not just the OCR layer.
 * Paperless-side metadata (correspondent/type names) no longer rides along;
 * the document itself carries its content, and the paperless id + title
 * stay in the filename.
 */

import { listCortexDocuments } from "./cortex";
import { storageGet, storageKeys, storagePut } from "./platform";

export const SYNC_TASK_NAME = "paperless-sync";

// Kept in lock-step with app.json "version" — scripts/validate.mjs fails the
// release build when they drift. The value is stamped into the submitted
// task (setup step "appVersion"): a task definition lives ON in Cortex after
// the app is updated, silently re-running old logic on its schedule, so the
// panel compares this stamp and resubmits stale tasks automatically.
export const APP_VERSION = "0.5.0";

/** The app version that submitted a task definition (null for pre-0.4.3). */
export function taskDefinitionVersion(definition: unknown): string | null {
  const setup = (
    definition as { setup?: Array<{ id?: string; template?: { text?: string } }> } | null
  )?.setup;
  return setup?.find((s) => s.id === "appVersion")?.template?.text ?? null;
}

// One run handles at most BATCH_PAGES × PAGE_SIZE documents — sized to the
// platform's 2000-item fan-out cap. The cursor in `finally` advances only
// past the listed batch, so larger backlogs drain across runs.
const PAGE_SIZE = 100;
const BATCH_PAGES = 20;

/** Max documents one run can list — when a run's total+deduped reaches this,
 * the listing was truncated and another run is needed to drain the rest. */
export const BATCH_LIMIT = PAGE_SIZE * BATCH_PAGES;

// Extensions Cortex ingestion accepts (backend allowed_extensions). Space-
// padded so a `contains` check on " {ext} " can't match a substring of
// another entry. A document that would 400 on upload is a PERMANENT failure,
// and permanent failures must skip, not fail — a failed item keeps the
// cursor from advancing, deadlocking the sync on the same batch forever.
const SUPPORTED_EXTS =
  " pdf docx doc xlsx xls pptx ppt html htm txt md mdx markdown rst" +
  " png jpg jpeg tiff tif bmp wav mp3 webvtt vtt tex latex xml epub ";

// The platform buffers a fromUrl fetch and rejects responses over 20 MB;
// guard a bit under it so those documents skip instead of failing mid-run.
const TRANSFER_CAP_BYTES = 19_000_000;

// no extension at all also 400s on upload ("" resolves to no suffix)
const UNSUPPORTED_TYPE = {
  or: [
    { eq: ["{vars.filename|ext}", ""] },
    { not: { contains: [SUPPORTED_EXTS, " {vars.filename|ext} "] } },
  ],
};

// /download/ serves the archive when one exists — mirror that for the size
const OVERSIZED = {
  gt: [
    "{meta.body.archive_size|default:{meta.body.original_size}}",
    TRANSFER_CAP_BYTES,
  ],
};

/** The Cortex document a paperless document was synced into earlier, if any. */
const PREV_DOC_ID = "{prev.value.docId|default:{legacy.value.docId}}";

export interface SyncTaskOptions {
  /** paperless base URL (already trailing-slash-stripped) */
  baseUrl: string;
  /** Cortex collection to upload into ("" = instance default) */
  collectionId?: string;
  /** re-run interval; omit for a one-shot run */
  everyMinutes?: number;
}

export function buildSyncTask(opts: SyncTaskOptions): Record<string, unknown> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const uploadParams = new URLSearchParams({
    start_processing: "true",
    source: "paperless-sync",
  });
  if (opts.collectionId) uploadParams.set("collection_id", opts.collectionId);
  // paperless ids are only unique within one instance
  const sourceKeyPrefix = encodeURIComponent(`paperless:${base}:`);
  const uploadPath =
    `upload?${uploadParams.toString()}` +
    `&source_key=${sourceKeyPrefix}{vars.id|urlencode}` +
    `&replace_document_id=${PREV_DOC_ID.slice(0, -1)}|urlencode}`;

  return {
    name: SYNC_TASK_NAME,
    ...(opts.everyMinutes ? { schedule: { everyMinutes: opts.everyMinutes } } : {}),
    concurrency: 2,
    setup: [
      // version stamp — no runtime effect; lets the panel detect a task
      // submitted by an older app build (see taskDefinitionVersion)
      { id: "appVersion", template: { text: APP_VERSION } },
      // pre-0.5.0 "added" cursor — seeds the modified cursor on first run
      { id: "cursor", store: { get: "sync/cursor" } },
      { id: "cursorModified", store: { get: "sync/cursor-modified" } },
      {
        id: "docs",
        http: {
          method: "GET",
          // oldest first: the batch is the OLDEST pending changes, so the
          // cursor can safely advance past it. __gte (not __gt) + dedup keeps
          // documents that share the boundary timestamp from being skipped.
          url:
            `${base}/api/documents/?ordering=modified&page_size=${PAGE_SIZE}` +
            `&fields=id,title,added,modified,archived_file_name,original_file_name` +
            `&modified__gte={cursorModified.value|default:{cursor.value}|default:1970-01-01T00:00:00Z|urlencode}`,
          paginate: { items: "results", next: "next", maxPages: BATCH_PAGES },
        },
      },
    ],
    items: {
      from: "$setup.docs.items",
      vars: {
        id: "{item.id}",
        title: "{item.title}",
        added: "{item.added}",
        modified: "{item.modified}",
        // real filename → correct extension → correct Docling parser.
        // /download/ serves the archive PDF when one exists, else the
        // original — mirror that preference for the name.
        filename:
          "{item.archived_file_name|default:{item.original_file_name}|default:{item.title|slug}.pdf}",
      },
      skipIfStored: "synced/{item.id}:{item.modified}",
    },
    steps: [
      // guard: file type Cortex can't ingest (e.g. a paperless original
      // named "…._1" with no archive PDF) → record it under synced/{id}:{modified} so
      // every later run dedups it, then skip with a visible reason
      {
        store: {
          put: "synced/{vars.id}:{vars.modified}",
          value: {
            at: "{run.startedAt}",
            filename: "{vars.filename}",
            skipped: "unsupported file type",
          },
        },
        when: UNSUPPORTED_TYPE,
      },
      {
        skipItem: {
          when: UNSUPPORTED_TYPE,
          reason: "unsupported file type: {vars.filename}",
        },
      },
      // guard: the platform rejects transfers over 20 MB — one metadata
      // call tells us the download size up front, oversized docs skip
      { id: "meta", http: { method: "GET", url: `${base}/api/documents/{vars.id}/metadata/` } },
      {
        store: {
          put: "synced/{vars.id}:{vars.modified}",
          value: {
            at: "{run.startedAt}",
            filename: "{vars.filename}",
            skipped: "exceeds transfer cap",
          },
        },
        when: OVERSIZED,
      },
      {
        skipItem: {
          when: OVERSIZED,
          reason:
            "{meta.body.archive_size|default:{meta.body.original_size}} bytes — " +
            "exceeds the platform's 20 MB transfer cap",
        },
      },
      // the document's Cortex document, if it was synced before: docmap
      // (v0.5.0+, also seeded from Cortex filenames by seedDocmapOnce) or
      // the docId pre-0.5.0 runs recorded under the legacy synced/{id} key
      { id: "prev", store: { get: "docmap/{vars.id}" } },
      { id: "legacy", store: { get: "synced/{vars.id}" } },
      // binary passthrough: Cortex downloads the actual document from
      // paperless server-side (PAPERLESS_TOKEN injected from config) and
      // streams the bytes straight into the upload — full PDF, not a
      // markdown re-render of the OCR text. An edited document REPLACES
      // its Cortex document in place (same id, only changes re-extracted).
      {
        id: "up",
        cortex: {
          method: "POST",
          path: uploadPath,
          multipart: {
            fromUrl: `${base}/api/documents/{vars.id}/download/`,
            filename: "paperless-{vars.id}-{vars.filename}",
          },
        },
      },
      // compatibility: a Cortex backend without in-place replace ignores the
      // replace params and creates a new document (its response has no
      // "replaced" field) — delete the superseded one so edits never
      // duplicate
      {
        cortex: { method: "DELETE", path: `documents/${PREV_DOC_ID}` },
        when: {
          and: [
            { notEmpty: PREV_DOC_ID },
            { eq: ["{up.body.replaced}", ""] },
            { neq: ["{up.body.document_id}", PREV_DOC_ID] },
          ],
        },
      },
      {
        store: {
          put: "docmap/{vars.id}",
          value: {
            docId: "{up.body.document_id}",
            modified: "{vars.modified}",
            at: "{run.startedAt}",
          },
        },
      },
      {
        store: {
          put: "synced/{vars.id}:{vars.modified}",
          value: {
            at: "{run.startedAt}",
            filename: "paperless-{vars.id}-{vars.filename}",
            docId: "{up.body.document_id}",
          },
        },
      },
    ],
    finally: [
      // ordering=added → the LAST listed item is the newest of this batch;
      // advancing only to it (not to paperless's overall newest) is what
      // makes >1-batch backlogs drain instead of being skipped
      {
        store: { put: "sync/cursor-modified", value: "{setup.docs.items.-1.modified}" },
        when: {
          and: [
            { eq: ["$run.failedCount", 0] },
            { notEmpty: "$setup.docs.items" },
          ],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// One-time migration: pre-task installs deduped by listing Cortex filenames.
// Seed those as storage keys so the task's skipIfStored recognizes documents
// that were synced by the old client-side loop.
// ---------------------------------------------------------------------------

const MIGRATED_KEY = "settings/dedup-migrated";
const FILENAME_RE = /^paperless-(\d+)-/;

export async function seedDedupKeysOnce(): Promise<number> {
  if (await storageGet<boolean>(MIGRATED_KEY)) return 0;
  let seeded = 0;
  try {
    const [docs, existing] = await Promise.all([
      listCortexDocuments(),
      storageKeys("synced/"),
    ]);
    for (const doc of docs) {
      const match = FILENAME_RE.exec(doc.filename ?? "");
      if (!match || existing.has(`synced/${match[1]}`)) continue;
      await storagePut(`synced/${match[1]}`, {
        migrated: true,
        filename: doc.filename,
      });
      seeded += 1;
    }
  } finally {
    // mark done even when the library is empty — the check is one GET
    await storagePut(MIGRATED_KEY, true);
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// One-time migration (v0.5.0): map paperless ids to their Cortex documents.
// Edited documents now replace their Cortex document in place, which needs
// its id. Runs record it in docmap/{id}; documents synced before v0.5.0 are
// recognized by their "paperless-{id}-" filename. Cortex lists newest first,
// so a paperless id with several Cortex documents maps to the newest one.
// Must run before the task is (re)submitted — SyncPanel awaits it first.
// ---------------------------------------------------------------------------

const DOCMAP_MIGRATED_KEY = "settings/docmap-migrated";

export async function seedDocmapOnce(): Promise<number> {
  if (await storageGet<boolean>(DOCMAP_MIGRATED_KEY)) return 0;
  const [docs, existing] = await Promise.all([
    listCortexDocuments(),
    storageKeys("docmap/"),
  ]);
  let seeded = 0;
  for (const doc of docs) {
    const match = FILENAME_RE.exec(doc.filename ?? "");
    if (!match || existing.has(`docmap/${match[1]}`)) continue;
    existing.add(`docmap/${match[1]}`);
    await storagePut(`docmap/${match[1]}`, { docId: doc.id, migrated: true });
    seeded += 1;
  }
  // only after a complete pass — a failed listing retries on the next load
  await storagePut(DOCMAP_MIGRATED_KEY, true);
  return seeded;
}

// UI preferences, persisted server-side so every device sees the same setup.
export interface SyncPrefs {
  collectionId?: string;
  everyMinutes?: number;
}

const PREFS_KEY = "settings/prefs";

export async function loadPrefs(): Promise<SyncPrefs> {
  return (await storageGet<SyncPrefs>(PREFS_KEY)) ?? {};
}

export async function savePrefs(prefs: SyncPrefs): Promise<void> {
  await storagePut(PREFS_KEY, prefs);
}
