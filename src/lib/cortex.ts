/**
 * Cortex app client — the only place your app talks to the outside world.
 *
 * Contract (do not work around it):
 *  - All requests are RELATIVE (`./api/…`). Hosted apps live under
 *    /apps/{slug}/ and absolute paths break there. `npm run validate`
 *    rejects absolute API paths.
 *  - Your app never holds a Cortex API key. In production the hosting proxy
 *    attaches the app's server-side key; the browser only ever sees a
 *    short-lived app token, delivered by the launcher via postMessage.
 *  - In `npm run dev`, the Vite proxy plays the hosting proxy's role using
 *    CORTEX_DEV_URL / CORTEX_DEV_KEY from your .env (see vite.config.ts).
 */

// ---------------------------------------------------------------------------
// Types (mirroring the Cortex REST API)
// ---------------------------------------------------------------------------

export interface SearchResult {
  document_id: string;
  chunk_id: string;
  content: string;
  score: number;
  metadata: { filename?: string; chunk_index?: number; [k: string]: unknown };
  /** present in streaming `sources` events; matches [src_N] citations */
  sid?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_results: number;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AskOptions {
  top_k?: number;
  collection_id?: string;
  conversation_history?: ConversationMessage[];
  /** Deep Research mode — multi-step agentic reasoning (slower, thorough) */
  use_agentic?: boolean;
  /** vector-only fast path (fastest, no graph) */
  use_fast_search?: boolean;
}

/**
 * One SSE frame from /api/ask/stream. Frames are discriminated by which key
 * is present — check them in this order in your UI loop.
 */
export interface AskStreamEvent {
  /** answer token delta — append to the answer text */
  content?: string;
  /** agentic reasoning step text */
  thinking?: string;
  /** retrieval progress line, e.g. "Found 12 sources" */
  retrieval?: string;
  /** pipeline stage */
  status?: { stage: string; message?: string };
  /** retrieved sources; arrive before/while the answer streams */
  sources?: SearchResult[];
  /** client-safe error message (stream ends after this) */
  error?: string;
  /** terminal frame */
  done?: boolean;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// App token handshake (production: sandboxed iframe inside the launcher)
// ---------------------------------------------------------------------------

const API_BASE = new URL("./api/", document.baseURI);
const inLauncher = window.parent !== window;

let appToken: string | null = null;
let waiters: Array<() => void> = [];

if (inLauncher) {
  window.addEventListener("message", (event: MessageEvent) => {
    const d = event.data;
    if (d && typeof d === "object" && d.type === "cortex:token" && typeof d.token === "string") {
      appToken = d.token;
      for (const w of waiters) w();
      waiters = [];
    }
  });
  window.parent.postMessage({ type: "cortex:ready" }, "*");
}

function awaitToken(timeoutMs = 3000): Promise<void> {
  if (!inLauncher || appToken) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
    setTimeout(resolve, timeoutMs); // never deadlock in unexpected hosts
  });
}

function requestRenewal(): void {
  appToken = null;
  if (inLauncher) window.parent.postMessage({ type: "cortex:token:renew" }, "*");
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function appFetch(path: string, init: RequestInit): Promise<Response> {
  await awaitToken();
  // FormData bodies must NOT get a manual Content-Type — the browser sets
  // the multipart boundary itself.
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const doFetch = () =>
    fetch(new URL(path, API_BASE), {
      ...init,
      headers: {
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(appToken ? { Authorization: `Bearer ${appToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch();
  if (res.status === 401 && inLauncher) {
    // token expired — ask the launcher for a fresh one and retry once
    requestRenewal();
    await awaitToken();
    res = await doFetch();
  }
  return res;
}

/** Raw access to allowlisted Cortex API endpoints (path relative to /api/). */
export function cortex(path: string, init: RequestInit = {}): Promise<Response> {
  return appFetch(`cortex/${path}`, init);
}

/** Platform capabilities (type: "platform" apps only — declare them in app.json). */
export function platform(path: string, init: RequestInit = {}): Promise<Response> {
  return appFetch(`platform/${path}`, init);
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/** Hybrid search (vector + keyword + graph). */
export async function search(
  query: string,
  opts: { top_k?: number; collection_id?: string } = {},
): Promise<SearchResponse> {
  const res = await cortex("search", {
    method: "POST",
    body: JSON.stringify({
      query,
      top_k: opts.top_k ?? 5,
      ...(opts.collection_id ? { filters: { collection_id: opts.collection_id } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`search failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Streaming Q&A. Yields AskStreamEvent frames until `done` or `error`.
 *
 *   for await (const ev of askStream("What is …?")) {
 *     if (ev.content) answer += ev.content;
 *     if (ev.sources) sources = ev.sources;
 *     if (ev.error) throw new Error(ev.error);
 *   }
 */
export async function* askStream(
  question: string,
  opts: AskOptions = {},
): AsyncGenerator<AskStreamEvent> {
  const res = await cortex("ask/stream", {
    method: "POST",
    body: JSON.stringify({ question, top_k: opts.top_k ?? 5, ...opts }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`ask failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; each data line is JSON.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue; // ": ping" keep-alives etc.
        try {
          const event = JSON.parse(line.slice(6)) as AskStreamEvent;
          yield event;
          if (event.done || event.error) return;
        } catch {
          // tolerate malformed keep-alive noise; never crash the stream
        }
      }
    }
  }
}

/** Search knowledge-graph entities by name/description. */
export async function searchEntities(
  searchTerm: string,
  opts: { limit?: number; entity_type?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ search: searchTerm, limit: String(opts.limit ?? 50) });
  if (opts.entity_type) params.set("entity_type", opts.entity_type);
  return cortex(`graph/entities?${params}`);
}

// ---------------------------------------------------------------------------
// Sync helpers (paperless-sync app)
// ---------------------------------------------------------------------------

export interface CortexCollection {
  id: string;
  name?: string;
  [k: string]: unknown;
}

export interface CortexDocument {
  id: string;
  filename?: string;
  collection_id?: string;
  status?: string;
  [k: string]: unknown;
}

export async function listCollections(): Promise<CortexCollection[]> {
  const res = await cortex("collections");
  if (!res.ok) throw new Error(`collections failed: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.collections ?? []);
}

export async function listCortexDocuments(): Promise<CortexDocument[]> {
  const res = await cortex("documents");
  if (!res.ok) throw new Error(`documents failed: ${res.status}`);
  const data = await res.json();
  return data.documents ?? [];
}

/** Upload a markdown document into the knowledge base. */
export async function uploadMarkdown(
  filename: string,
  content: string,
  collectionId?: string,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/markdown" }), filename);
  const params = new URLSearchParams({ start_processing: "true", source: "paperless-sync" });
  if (collectionId) params.set("collection_id", collectionId);
  return cortex(`upload?${params}`, { method: "POST", body: form });
}
