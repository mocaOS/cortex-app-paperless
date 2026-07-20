import { useEffect, useMemo, useRef, useState } from "react";
import { listCollections, type CortexCollection } from "../lib/cortex";
import { listAllDocuments, loadNameMaps } from "../lib/paperless";
import {
  loadSyncedFilenames,
  runSync,
  syncFilename,
  type SyncItem,
  type SyncState,
} from "../lib/sync";

const BADGE: Record<SyncState, { label: string; cls: string }> = {
  pending: { label: "pending", cls: "text-[--color-faint]" },
  syncing: { label: "syncing…", cls: "text-[--color-accent]" },
  done: { label: "synced", cls: "text-emerald-400" },
  skipped: { label: "in cortex", cls: "text-[--color-muted]" },
  error: { label: "error", cls: "text-red-400" },
};

export default function SyncPanel({ baseUrl }: { baseUrl: string }) {
  const [items, setItems] = useState<SyncItem[]>([]);
  const [collections, setCollections] = useState<CortexCollection[]>([]);
  const [collectionId, setCollectionId] = useState<string>("");
  const [names, setNames] = useState<Awaited<ReturnType<typeof loadNameMaps>> | null>(null);
  const [synced, setSynced] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState<string | null>("loading documents…");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading("loading paperless documents…");
        const [docs, nameMaps, syncedSet, cols] = await Promise.all([
          listAllDocuments(baseUrl, (n, total) =>
            setLoading(`loading paperless documents… ${n}/${total}`),
          ),
          loadNameMaps(baseUrl),
          loadSyncedFilenames(),
          listCollections().catch(() => [] as CortexCollection[]),
        ]);
        if (cancelled) return;
        setItems(
          docs.map((doc) => ({
            doc,
            state: syncedSet.has(syncFilename(doc)) ? "skipped" : "pending",
          })),
        );
        setNames(nameMaps);
        setSynced(syncedSet);
        setCollections(cols);
        setLoading(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const counts = useMemo(() => {
    const c = { pending: 0, syncing: 0, done: 0, skipped: 0, error: 0 };
    for (const item of items) c[item.state] += 1;
    return c;
  }, [items]);

  async function startSync() {
    if (running || !names || !synced) return;
    stopRef.current = false;
    setRunning(true);
    const targets = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.state === "pending" || item.state === "error");
    setItems((prev) =>
      prev.map((it) =>
        it.state === "error" ? { ...it, state: "pending", detail: undefined } : it,
      ),
    );
    await runSync(
      baseUrl,
      targets.map(({ item }) => item),
      names,
      synced,
      {
        collectionId: collectionId || undefined,
        concurrency: 2,
        shouldStop: () => stopRef.current,
        onUpdate: (targetIdx, state, detail) => {
          const realIndex = targets[targetIdx].index;
          setItems((prev) =>
            prev.map((it, i) => (i === realIndex ? { ...it, state, detail } : it)),
          );
        },
      },
    );
    setRunning(false);
  }

  if (loading) {
    return <p className="font-mono text-xs uppercase tracking-[0.1em] text-[--color-faint]">{loading}</p>;
  }
  if (error) {
    return <p className="font-mono text-xs text-red-400">{error}</p>;
  }

  const toSync = counts.pending + counts.error;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-4 border border-[--color-line] bg-[--color-card] p-4">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-[--color-muted]">
          {items.length} documents
        </span>
        <span className="font-mono text-xs text-[--color-faint]">
          {counts.skipped + counts.done} in cortex · {toSync} to sync
          {counts.error > 0 && <span className="text-red-400"> · {counts.error} failed</span>}
        </span>
        <div className="ml-auto flex items-center gap-3">
          {collections.length > 0 && (
            <select
              value={collectionId}
              onChange={(e) => setCollectionId(e.target.value)}
              disabled={running}
              className="border border-[--color-line] bg-[--color-bg] px-3 py-2 font-mono text-xs outline-none focus:border-[--color-accent]"
            >
              <option value="">default collection</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? c.id}
                </option>
              ))}
            </select>
          )}
          {running ? (
            <button
              onClick={() => {
                stopRef.current = true;
              }}
              className="border border-[--color-line] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-red-400 transition-colors hover:border-red-400"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={startSync}
              disabled={toSync === 0}
              className="border border-[--color-accent] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[--color-accent] transition-colors hover:bg-[--color-accent] hover:text-[--color-bg] disabled:opacity-40"
            >
              Sync {toSync > 0 ? toSync : "all"}
            </button>
          )}
        </div>
      </div>

      <ul className="mt-px max-h-[60vh] space-y-px overflow-y-auto">
        {items.map((item) => (
          <li
            key={item.doc.id}
            className="flex items-baseline gap-4 border border-[--color-line] px-4 py-2.5"
          >
            <span className="w-14 shrink-0 font-mono text-xs text-[--color-faint]">
              #{item.doc.id}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{item.doc.title}</span>
            <span className="hidden shrink-0 font-mono text-xs text-[--color-faint] md:inline">
              {item.doc.created?.slice(0, 10)}
            </span>
            <span
              className={`w-20 shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] ${BADGE[item.state].cls}`}
              title={item.detail}
            >
              {BADGE[item.state].label}
            </span>
          </li>
        ))}
      </ul>
      {counts.error > 0 && (
        <p className="mt-3 font-mono text-xs text-red-400">
          {items.find((i) => i.state === "error")?.detail}
        </p>
      )}
    </div>
  );
}
