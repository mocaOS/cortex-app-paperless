/**
 * The sync, as a Cortex platform task.
 *
 * Instead of a browser-side loop, the whole paperless → Cortex pipeline is a
 * declarative step-queue that Cortex executes server-side:
 *
 *   setup    read the sync cursor, list documents added since it (paginated),
 *            fetch correspondent/type name maps (keyBy joins)
 *   items    fan out over the listing, deduped against storage keys
 *            (synced/{id}) so nothing is ever uploaded twice
 *   steps    fetch full text → skip if empty → render markdown → multipart
 *            upload into Cortex → mark synced
 *   finally  advance the cursor (only when nothing failed, so failed
 *            documents are retried by the next run)
 *
 * Submit it once with a schedule and the sync runs forever, headless —
 * the browser tab is just a dashboard.
 *
 * Deliberate difference from the old client loop: tag names are not resolved
 * (a doc has a LIST of tag ids, which the template language can't map);
 * correspondent and document type are single ids and ARE resolved by name.
 */

import { listCortexDocuments } from "./cortex";
import { storageGet, storageKeys, storagePut } from "./platform";

export const SYNC_TASK_NAME = "paperless-sync";

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

  return {
    name: SYNC_TASK_NAME,
    ...(opts.everyMinutes ? { schedule: { everyMinutes: opts.everyMinutes } } : {}),
    concurrency: 2,
    setup: [
      { id: "cursor", store: { get: "sync/cursor" } },
      {
        id: "docs",
        http: {
          method: "GET",
          url:
            `${base}/api/documents/?ordering=-added&page_size=100` +
            `&fields=id,title,created,added,correspondent,document_type,archive_serial_number,original_file_name` +
            `&added__gt={cursor.value|default:1970-01-01T00:00:00Z|urlencode}`,
          paginate: { items: "results", next: "next", maxPages: 50 },
        },
      },
      {
        id: "correspondents",
        http: {
          method: "GET",
          url: `${base}/api/correspondents/?page_size=100`,
          paginate: { items: "results", next: "next", keyBy: "id" },
        },
      },
      {
        id: "doctypes",
        http: {
          method: "GET",
          url: `${base}/api/document_types/?page_size=100`,
          paginate: { items: "results", next: "next", keyBy: "id" },
        },
      },
    ],
    items: {
      from: "$setup.docs.items",
      vars: { id: "{item.id}", title: "{item.title}", added: "{item.added}" },
      skipIfStored: "synced/{item.id}",
    },
    steps: [
      { id: "full", http: { method: "GET", url: `${base}/api/documents/{vars.id}/` } },
      {
        skipItem: {
          when: { empty: "$full.body.content" },
          reason: "no extracted text in paperless",
        },
      },
      {
        id: "md",
        template: {
          lines: [
            "# {full.body.title}",
            "",
            `- Source: paperless-ngx document {vars.id} (${base}/documents/{vars.id}/)`,
            "- Created: {full.body.created|truncate:10}",
            {
              text: "- Correspondent: {setup.correspondents.map.{full.body.correspondent}.name}",
              when: { notEmpty: "$setup.correspondents.map.{full.body.correspondent}.name" },
            },
            {
              text: "- Type: {setup.doctypes.map.{full.body.document_type}.name}",
              when: { notEmpty: "$setup.doctypes.map.{full.body.document_type}.name" },
            },
            {
              text: "- Archive serial: {full.body.archive_serial_number}",
              when: { notEmpty: "$full.body.archive_serial_number" },
            },
            {
              text: "- Original file: {full.body.original_file_name}",
              when: { notEmpty: "$full.body.original_file_name" },
            },
            "",
            "---",
            "",
            "{full.body.content}",
          ],
        },
      },
      {
        id: "up",
        cortex: {
          method: "POST",
          path: `upload?${uploadParams.toString()}`,
          multipart: {
            content: "$md.text",
            filename: "paperless-{vars.id}-{vars.title|slug}.md",
            contentType: "text/markdown",
          },
        },
      },
      {
        store: {
          put: "synced/{vars.id}",
          value: {
            at: "{run.startedAt}",
            filename: "paperless-{vars.id}-{vars.title|slug}.md",
          },
        },
      },
    ],
    finally: [
      {
        store: { put: "sync/cursor", value: "{setup.docs.items.0.added}" },
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
