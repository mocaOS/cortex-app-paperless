import { useCallback, useEffect, useRef, useState } from "react";
import { listCollections, type CortexCollection } from "../lib/cortex";
import {
  deleteTask,
  getTask,
  listTasks,
  submitTask,
  taskAction,
  type TaskDetail,
  type TaskItem,
} from "../lib/platform";
import {
  APP_VERSION,
  BATCH_LIMIT,
  buildSyncTask,
  loadPrefs,
  savePrefs,
  seedDedupKeysOnce,
  SYNC_TASK_NAME,
  taskDefinitionVersion,
} from "../lib/syncTask";

const SCHEDULES: Array<{ label: string; minutes?: number }> = [
  { label: "manual only" },
  { label: "every hour", minutes: 60 },
  { label: "every 6 hours", minutes: 360 },
  { label: "daily", minutes: 1440 },
];

const STATUS_CLS: Record<string, string> = {
  running: "text-[var(--color-accent)]",
  pending: "text-[var(--color-accent)]",
  paused: "text-amber-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-[var(--color-muted)]",
};

const ACTIVE = new Set(["running", "pending"]);

export default function SyncPanel({ baseUrl }: { baseUrl: string }) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [collections, setCollections] = useState<CortexCollection[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [scheduleMinutes, setScheduleMinutes] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState<string | null>("loading…");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<TaskDetail | null> => {
    const tasks = await listTasks();
    const managed = tasks.find((t) => t.name === SYNC_TASK_NAME);
    if (!managed) {
      setTask(null);
      return null;
    }
    const detail = await getTask(managed.task_id);
    setTask(detail);
    return detail;
  }, []);

  // initial load: prefs + collections + existing task + one-time dedup seed
  // (documents synced by the pre-task version of this app are recognized via
  // their filenames and marked in storage so they're never re-uploaded)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [prefs, cols] = await Promise.all([
          loadPrefs(),
          listCollections().catch(() => [] as CortexCollection[]),
        ]);
        await seedDedupKeysOnce();
        if (cancelled) return;
        setCollections(cols);
        setCollectionId(prefs.collectionId ?? "");
        setScheduleMinutes(prefs.everyMinutes);
        const detail = await refresh();
        // a task definition keeps running server-side after the app is
        // updated — silently re-running outdated logic on its schedule.
        // When the stored task came from an older build and is idle,
        // upgrade it in place (delete + resubmit with the same prefs).
        if (
          detail &&
          !ACTIVE.has(detail.status) &&
          taskDefinitionVersion(detail.definition) !== APP_VERSION
        ) {
          await deleteTask(detail.task_id);
          await submitTask(
            buildSyncTask({
              baseUrl,
              collectionId: prefs.collectionId || undefined,
              everyMinutes: prefs.everyMinutes,
            }),
          );
          if (!cancelled) {
            setNotice(
              `sync task was submitted by an older app build — upgraded to v${APP_VERSION} and restarted`,
            );
          }
          await refresh();
        }
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
  }, [refresh, baseUrl]);

  // poll while a run is active
  useEffect(() => {
    if (!task || !ACTIVE.has(task.status)) return;
    pollRef.current = window.setTimeout(() => {
      void refresh().catch(() => undefined);
    }, 2500);
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [task, refresh]);

  async function withBusy(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** (Re)submit the managed task with the current settings. Submitting always
   * starts a run immediately, so this doubles as "sync now". */
  function syncNow() {
    void withBusy(async () => {
      await savePrefs({
        collectionId: collectionId || undefined,
        everyMinutes: scheduleMinutes,
      });
      const existing = task;
      if (existing && ACTIVE.has(existing.status)) return; // already running
      if (existing) await deleteTask(existing.task_id);
      await submitTask(
        buildSyncTask({
          baseUrl,
          collectionId: collectionId || undefined,
          everyMinutes: scheduleMinutes,
        }),
      );
    });
  }

  function act(action: "pause" | "resume" | "cancel" | "retryFailed") {
    if (!task) return;
    void withBusy(() => taskAction(task.task_id, action));
  }

  if (loading) {
    return (
      <p className="font-mono text-xs uppercase tracking-[0.1em] text-[var(--color-faint)]">
        {loading}
      </p>
    );
  }

  const counts = task?.counts ?? {};
  const active = task ? ACTIVE.has(task.status) : false;
  // total (fanned out) + deduped = documents listed; hitting the batch cap
  // means the archive has more pending than one run can carry
  const batchFull =
    (counts.total ?? 0) + (counts.deduped ?? 0) >= BATCH_LIMIT;
  const staleDefinition =
    task !== null && taskDefinitionVersion(task.definition) !== APP_VERSION;
  const failedItems: TaskItem[] = (task?.items ?? []).filter((i) => i.status === "failed");
  const skippedItems: TaskItem[] = (task?.items ?? []).filter((i) => i.status === "skipped");

  return (
    <div>
      {/* controls */}
      <div className="flex flex-wrap items-center gap-3 border border-[var(--color-line)] bg-[var(--color-card)] p-4">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-muted)]">
          Sync
        </span>
        <select
          value={scheduleMinutes ?? ""}
          onChange={(e) =>
            setScheduleMinutes(e.target.value ? Number(e.target.value) : undefined)
          }
          disabled={busy || active}
          className="border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
        >
          {SCHEDULES.map((s) => (
            <option key={s.label} value={s.minutes ?? ""}>
              {s.label}
            </option>
          ))}
        </select>
        {collections.length > 0 && (
          <select
            value={collectionId}
            onChange={(e) => setCollectionId(e.target.value)}
            disabled={busy || active}
            className="border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">default collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.id}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3">
          {active ? (
            <>
              <button
                onClick={() => act("pause")}
                disabled={busy}
                className="border border-[var(--color-line)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-amber-400 hover:text-amber-400 disabled:opacity-40"
              >
                Pause
              </button>
              <button
                onClick={() => act("cancel")}
                disabled={busy}
                className="border border-[var(--color-line)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-red-400 transition-colors hover:border-red-400 disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {task?.status === "paused" && (
                <button
                  onClick={() => act("resume")}
                  disabled={busy}
                  className="border border-[var(--color-line)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
                >
                  Resume
                </button>
              )}
              {(counts.failed ?? 0) > 0 && (
                <button
                  onClick={() => act("retryFailed")}
                  disabled={busy}
                  className="border border-[var(--color-line)] px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
                >
                  Retry failed
                </button>
              )}
              <button
                onClick={syncNow}
                disabled={busy}
                className="border border-[var(--color-accent)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)] disabled:opacity-40"
              >
                {scheduleMinutes ? "Save schedule & sync" : "Sync now"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* status */}
      {task && (
        <div className="mt-px border border-[var(--color-line)] bg-[var(--color-card)] p-4">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
            <span
              className={`font-mono text-xs font-semibold uppercase tracking-[0.2em] ${
                STATUS_CLS[task.status] ?? "text-[var(--color-muted)]"
              }`}
            >
              {task.status}
            </span>
            <span className="font-mono text-xs text-[var(--color-muted)]">{task.message}</span>
            {task.schedule?.everyMinutes && (
              <span className="font-mono text-xs text-[var(--color-faint)]">
                repeats every{" "}
                {task.schedule.everyMinutes >= 60
                  ? `${task.schedule.everyMinutes / 60}h`
                  : `${task.schedule.everyMinutes}m`}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
            <span className="text-emerald-400">{counts.done ?? 0} synced</span>
            <span className="text-[var(--color-muted)]">{counts.skipped ?? 0} skipped</span>
            <span className="text-[var(--color-faint)]">
              {counts.deduped ?? 0} already in cortex
            </span>
            {(counts.failed ?? 0) > 0 && (
              <span className="text-red-400">{counts.failed} failed</span>
            )}
          </div>
          {task.error && (
            <p className="mt-3 font-mono text-xs text-red-400">{task.error}</p>
          )}
          {staleDefinition && active && (
            <p className="mt-3 font-mono text-xs text-amber-400">
              this run was started by an older version of this app — it will
              be upgraded to v{APP_VERSION} automatically once it finishes
              (reload this page or hit Sync)
            </p>
          )}
          {batchFull && !active && (
            <p className="mt-3 font-mono text-xs text-amber-400">
              batch limit reached ({BATCH_LIMIT} documents per run) — more are
              pending; {task.schedule?.everyMinutes
                ? "the next scheduled run continues where this one stopped"
                : "hit Sync again to continue where this run stopped"}
            </p>
          )}
          {task.last_run?.finished_at && !active && (
            <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
              last run {new Date(task.last_run.finished_at).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {!task && (
        <p className="mt-4 font-mono text-xs text-[var(--color-faint)]">
          No sync has run yet. Pick a schedule (or leave it manual) and hit the
          button — the sync runs inside Cortex and keeps going even if you
          close this tab.
        </p>
      )}

      {/* problem items */}
      {(failedItems.length > 0 || skippedItems.length > 0) && (
        <ul className="mt-px max-h-[40vh] space-y-px overflow-y-auto">
          {failedItems.map((item, i) => (
            <li
              key={`f${i}`}
              className="flex items-baseline gap-4 border border-[var(--color-line)] px-4 py-2.5"
            >
              <span className="w-14 shrink-0 font-mono text-xs text-[var(--color-faint)]">
                #{String(item.vars.id ?? "?")}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {String(item.vars.title ?? "")}
              </span>
              <span
                className="max-w-[40%] shrink-0 truncate text-right font-mono text-[10px] uppercase tracking-[0.1em] text-red-400"
                title={item.error}
              >
                {item.error ?? "failed"}
              </span>
            </li>
          ))}
          {skippedItems.map((item, i) => (
            <li
              key={`s${i}`}
              className="flex items-baseline gap-4 border border-[var(--color-line)] px-4 py-2.5"
            >
              <span className="w-14 shrink-0 font-mono text-xs text-[var(--color-faint)]">
                #{String(item.vars.id ?? "?")}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-muted)]">
                {String(item.vars.title ?? "")}
              </span>
              <span className="shrink-0 text-right font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--color-faint)]">
                {item.reason ?? "skipped"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {notice && (
        <p className="mt-3 font-mono text-xs text-[var(--color-accent)]">{notice}</p>
      )}
      {error && <p className="mt-3 font-mono text-xs text-red-400">{error}</p>}
    </div>
  );
}
