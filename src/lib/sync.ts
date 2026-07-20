/**
 * The sync engine: paperless document → markdown → Cortex upload.
 *
 * Filenames are deterministic (`paperless-{id}-{slug}.md`) so already-synced
 * documents are detected by listing Cortex documents — re-running the sync
 * only uploads what's new.
 */

import { listCortexDocuments, uploadMarkdown } from "./cortex";
import { getDocument, type PaperlessDocument } from "./paperless";

export type SyncState = "pending" | "syncing" | "done" | "skipped" | "error";

export interface SyncItem {
  doc: PaperlessDocument;
  state: SyncState;
  detail?: string;
}

export function syncFilename(doc: PaperlessDocument): string {
  const slug = doc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
  return `paperless-${doc.id}-${slug}.md`;
}

/** Filenames already present in Cortex (any collection this key can see). */
export async function loadSyncedFilenames(): Promise<Set<string>> {
  const docs = await listCortexDocuments();
  return new Set(
    docs
      .map((d) => d.filename ?? "")
      .filter((f) => f.startsWith("paperless-")),
  );
}

export function toMarkdown(
  doc: PaperlessDocument,
  names: {
    tags: Map<number, string>;
    correspondents: Map<number, string>;
    documentTypes: Map<number, string>;
  },
  baseUrl: string,
): string {
  const tagNames = doc.tags.map((t) => names.tags.get(t) ?? `#${t}`);
  const correspondent =
    doc.correspondent != null
      ? names.correspondents.get(doc.correspondent) ?? String(doc.correspondent)
      : null;
  const docType =
    doc.document_type != null
      ? names.documentTypes.get(doc.document_type) ?? String(doc.document_type)
      : null;

  const meta = [
    `- Source: paperless-ngx document ${doc.id} (${baseUrl.replace(/\/+$/, "")}/documents/${doc.id}/)`,
    `- Created: ${doc.created?.slice(0, 10) ?? "unknown"}`,
    correspondent ? `- Correspondent: ${correspondent}` : null,
    docType ? `- Type: ${docType}` : null,
    tagNames.length ? `- Tags: ${tagNames.join(", ")}` : null,
    doc.archive_serial_number != null ? `- Archive serial: ${doc.archive_serial_number}` : null,
    doc.original_file_name ? `- Original file: ${doc.original_file_name}` : null,
  ].filter(Boolean);

  return `# ${doc.title}\n\n${meta.join("\n")}\n\n---\n\n${doc.content ?? ""}\n`;
}

export interface SyncOptions {
  collectionId?: string;
  concurrency?: number;
  onUpdate: (index: number, state: SyncState, detail?: string) => void;
  shouldStop: () => boolean;
}

/** Run the sync over `items` (mutates nothing; reports via onUpdate). */
export async function runSync(
  baseUrl: string,
  items: SyncItem[],
  names: Parameters<typeof toMarkdown>[1],
  synced: Set<string>,
  opts: SyncOptions,
): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const workers = Math.max(1, Math.min(opts.concurrency ?? 2, 4));

  async function worker(): Promise<void> {
    for (;;) {
      const next = queue.shift();
      if (!next || opts.shouldStop()) return;
      const { item, index } = next;
      const filename = syncFilename(item.doc);

      if (synced.has(filename)) {
        opts.onUpdate(index, "skipped", "already in Cortex");
        continue;
      }
      opts.onUpdate(index, "syncing");
      try {
        const full = await getDocument(baseUrl, item.doc.id);
        if (!full.content?.trim()) {
          opts.onUpdate(index, "skipped", "no extracted text in paperless");
          continue;
        }
        const res = await uploadMarkdown(
          filename,
          toMarkdown(full, names, baseUrl),
          opts.collectionId,
        );
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Cortex upload ${res.status}: ${body.slice(0, 120)}`);
        }
        synced.add(filename);
        opts.onUpdate(index, "done");
      } catch (err) {
        opts.onUpdate(index, "error", err instanceof Error ? err.message : String(err));
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
}
