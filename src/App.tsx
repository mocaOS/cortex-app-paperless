import { useEffect, useState } from "react";
import SyncPanel from "./components/SyncPanel";
import { getBaseUrl, testConnection } from "./lib/paperless";

type Status =
  | { kind: "checking" }
  | { kind: "unconfigured" }
  | { kind: "error"; message: string }
  | { kind: "ready"; baseUrl: string; count: number };

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  async function check() {
    setStatus({ kind: "checking" });
    try {
      const baseUrl = await getBaseUrl();
      if (!baseUrl) {
        setStatus({ kind: "unconfigured" });
        return;
      }
      const count = await testConnection(baseUrl);
      setStatus({ kind: "ready", baseUrl, count });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
          Cortex App
        </p>
        <h1 className="mt-3 text-5xl font-bold tracking-[-0.04em] md:text-6xl">
          Paperless Sync
        </h1>
        <p className="mt-4 max-w-xl text-[var(--color-muted)]">
          Bring your paperless-ngx archive into the knowledge graph. Syncing
          ships the full documents — Cortex parses the real PDFs (layout,
          tables, images), so the graph sees everything, not just the OCR
          text layer.
        </p>
      </header>

      <div className="space-y-6">
        {status.kind === "checking" && (
          <p className="font-mono text-xs uppercase tracking-[0.1em] text-[var(--color-faint)]">
            checking connection…
          </p>
        )}

        {status.kind === "unconfigured" && (
          <div className="border border-[var(--color-line)] bg-[var(--color-card)] p-6">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
              Setup required
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--color-muted)]">
              An instance admin needs to configure this app once under{" "}
              <span className="text-[var(--color-fg)]">
                Settings → Apps → Paperless Sync → Configure
              </span>
              : the paperless URL (<code className="font-mono text-xs">PAPERLESS_BASE_URL</code>)
              and an API token (<code className="font-mono text-xs">PAPERLESS_TOKEN</code>,
              created in paperless under <em>My Profile → API Token</em>). The
              token is stored encrypted and used only server-side — no CORS or
              browser exposure involved.
            </p>
            <button
              onClick={() => void check()}
              className="mt-5 border border-[var(--color-line)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Re-check
            </button>
          </div>
        )}

        {status.kind === "error" && (
          <div className="border border-[var(--color-line)] bg-[var(--color-card)] p-6">
            <p className="font-mono text-xs text-red-400">{status.message}</p>
            <button
              onClick={() => void check()}
              className="mt-5 border border-[var(--color-line)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Retry
            </button>
          </div>
        )}

        {status.kind === "ready" && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border border-[var(--color-line)] bg-[var(--color-card)] p-4">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-muted)]">
                Connected
              </span>
              <span className="font-mono text-sm">{status.baseUrl}</span>
              <span className="font-mono text-xs text-[var(--color-accent)]">
                {status.count} documents
              </span>
            </div>
            <SyncPanel baseUrl={status.baseUrl} />
          </>
        )}
      </div>

      <footer className="mt-10 font-mono text-xs text-[var(--color-faint)]">
        POWERED BY CORTEX — SYNC RUNS SERVER-SIDE, EVEN WITH THIS TAB CLOSED
      </footer>
    </div>
  );
}
