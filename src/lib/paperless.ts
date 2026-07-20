/**
 * paperless-ngx client — via the Cortex platform `http` capability.
 *
 * Every call executes SERVER-side inside the Cortex instance: the app posts
 * an envelope to ./api/platform/http, and the backend performs the request
 * with the admin-configured PAPERLESS_TOKEN injected as an auth header.
 *
 * Consequences (all good):
 *  - no CORS configuration needed on paperless,
 *  - the token never exists in the browser (encrypted at rest in app config),
 *  - the only setup is the app's Cortex config (Settings → Apps → Configure).
 *
 * The base URL is read from the same config via ./api/platform/config
 * (non-secret values only) — used both for API calls and backlinks.
 */

import { platform } from "./cortex";

export interface PaperlessDocument {
  id: number;
  title: string;
  created: string;
  added: string;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
  archive_serial_number: number | null;
  original_file_name?: string;
  content?: string;
}

export interface PaperlessPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

/** The admin-configured paperless base URL, or null if not configured yet. */
export async function getBaseUrl(): Promise<string | null> {
  const res = await platform("config");
  if (!res.ok) return null;
  const data = await res.json();
  const url: string | undefined = data.values?.PAPERLESS_BASE_URL;
  return url ? url.replace(/\/+$/, "") : null;
}

async function pget(baseUrl: string, path: string): Promise<Response> {
  return platform("http", {
    method: "POST",
    body: JSON.stringify({ method: "GET", url: `${baseUrl}/api/${path}` }),
  });
}

/** Connectivity + auth check. Throws a human-oriented message. */
export async function testConnection(baseUrl: string): Promise<number> {
  const res = await pget(baseUrl, "documents/?page_size=1");
  if (res.status === 503) {
    throw new Error(
      "This app isn't configured yet — an admin must set PAPERLESS_BASE_URL " +
        "and PAPERLESS_TOKEN under Settings → Apps → Paperless Sync → Configure.",
    );
  }
  if (res.status === 401 || res.status === 403) {
    const detail = (await res.json().catch(() => null))?.detail ?? "";
    throw new Error(
      detail.includes("Blocked") || detail.includes("hosts")
        ? `Cortex refused the target: ${detail}`
        : "paperless rejected the token (401/403). Check PAPERLESS_TOKEN in the app config.",
    );
  }
  if (res.status === 502) {
    throw new Error("Cortex could not reach paperless — check PAPERLESS_BASE_URL.");
  }
  if (!res.ok) throw new Error(`paperless answered ${res.status}`);
  const data: PaperlessPage<PaperlessDocument> = await res.json();
  return data.count;
}

