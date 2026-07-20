/**
 * Platform tasks + storage client — thin wrappers over the app proxy's
 * platform capabilities (declare "tasks" and "storage" in app.json).
 *
 * Tasks are declarative step-queues executed SERVER-side by Cortex: submit a
 * JSON program once and the work survives a closed tab; add a schedule and
 * it re-runs with no browser at all. Storage is the app's private key/value
 * store (per-app SQLite inside the instance).
 */

import { platform } from "./cortex";

// ---------------------------------------------------------------------------
// Types (mirroring /apps/{id}/api/platform/tasks responses)
// ---------------------------------------------------------------------------

export interface TaskCounts {
  total?: number;
  done?: number;
  failed?: number;
  skipped?: number;
  deduped?: number;
}

export interface TaskRunSummary {
  run_id: string;
  started_at: string;
  finished_at?: string;
  status: string;
  counts?: TaskCounts;
  error?: string | null;
}

export interface TaskSummary {
  task_id: string;
  name: string;
  status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  schedule?: { everyMinutes: number } | null;
  created_at?: string;
  created_by?: string;
  counts: TaskCounts;
  error?: string | null;
  message?: string;
  last_run?: TaskRunSummary | null;
}

export interface TaskItem {
  vars: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  error?: string;
  reason?: string;
}

export interface TaskDetail extends TaskSummary {
  items: TaskItem[];
  definition?: unknown;
}

export type TaskAction = "pause" | "resume" | "cancel" | "retryFailed" | "runNow";

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async function ok<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    const issues = detail?.detail?.issues;
    throw new Error(
      Array.isArray(issues)
        ? `${what}: ${issues.join("; ")}`
        : `${what} failed: ${res.status} ${detail?.detail ?? ""}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function listTasks(): Promise<TaskSummary[]> {
  const data = await ok<{ tasks: TaskSummary[] }>(await platform("tasks"), "list tasks");
  return data.tasks;
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  return ok(await platform(`tasks/${taskId}`), "get task");
}

export async function submitTask(definition: unknown): Promise<TaskSummary> {
  return ok(
    await platform("tasks", { method: "POST", body: JSON.stringify(definition) }),
    "submit task",
  );
}

export async function taskAction(taskId: string, action: TaskAction): Promise<TaskSummary> {
  return ok(
    await platform(`tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ action }) }),
    action,
  );
}

export async function deleteTask(taskId: string): Promise<void> {
  const res = await platform(`tasks/${taskId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`delete task failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function storageGet<T>(key: string): Promise<T | null> {
  const res = await platform(`storage/${key}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage get failed: ${res.status}`);
  const data = await res.json();
  return (data.value ?? null) as T | null;
}

export async function storagePut(key: string, value: unknown): Promise<void> {
  const res = await platform(`storage/${key}`, {
    method: "PUT",
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`storage put failed: ${res.status}`);
}

/** All stored keys under a prefix (follows the listing's keyset pagination). */
export async function storageKeys(prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let after = "";
  for (;;) {
    const params = new URLSearchParams({ prefix, limit: "500", after });
    const res = await platform(`storage?${params}`);
    if (!res.ok) throw new Error(`storage list failed: ${res.status}`);
    const data: { keys: Array<{ key: string }>; next: string | null } = await res.json();
    for (const entry of data.keys) keys.add(entry.key);
    if (!data.next) break;
    after = data.next;
  }
  return keys;
}
