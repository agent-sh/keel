// Settings > Providers: every provider with its listing state, the plugins,
// the default model and the Grok plan sign-in.
import { ExternalLink, LogIn, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { actions, reportError, useStore, type ProvidersReport } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Card, SettingRow } from "./Settings.tsx";

type Row = ProvidersReport["providers"][number];

const WIRE: Record<string, string> = {
  anthropic_messages: "Messages",
  openai_responses: "Responses",
  chat_completions: "Chat",
  gemini_generate_content: "Gemini",
};

function Dot({ tone }: { tone: "ok" | "warn" | "danger" | "off" }) {
  return <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", off: "bg-line-strong" }[tone])} />;
}

function tone(p: Row): "ok" | "warn" | "danger" | "off" {
  if (!p.available) return p.sign_in ? "warn" : "off";
  if (p.listing.state === "failed") return p.listing.models ? "warn" : "danger";
  return p.listing.models ? "ok" : "warn";
}

function GrokSignIn() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s?.state !== "pending") return;
    const t = setInterval(async () => {
      const next = await actions.grokSignInState().catch(() => null);
      if (next && next.state !== "pending") { setS(next); actions.loadProviders(true).catch(reportError); }
    }, 3000);
    return () => clearInterval(t);
  }, [s?.state]);
  if (s?.state === "pending") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-line bg-sunken px-3 py-2 text-ui">
        <span className="text-muted">Approve on xAI's page with the code</span>
        <code className="rounded-xs bg-code px-2 py-0.5 font-mono tracking-widest">{s.user_code}</code>
        <a className="inline-flex items-center gap-1 text-accent-ink hover:underline" href={s.verification_uri_complete ?? s.verification_uri} target="_blank" rel="noreferrer">
          Open <ExternalLink className="size-3" />
        </a>
      </div>
    );
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        data-testid="grok-sign-in"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { setS(await actions.grokSignIn()); } catch (e) { setS({ state: "failed", error: (e as Error).message }); } finally { setBusy(false); }
        }}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-2.5 text-ui font-medium hover:bg-hover disabled:opacity-50"
      >
        <LogIn className="size-3.5" /> Sign in
      </button>
      {s?.state === "failed" && <span className="text-caption text-danger">{s.error}</span>}
    </div>
  );
}

function ProviderRow({ p }: { p: Row }) {
  const l = p.listing;
  return (
    <div className="flex gap-3 border-b border-line py-3 last:border-0" data-testid="provider-row" data-provider={p.id}>
      <Dot tone={tone(p)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-base font-medium">{p.label}</span>
          <span className="rounded-xs bg-sunken px-1.5 text-micro uppercase tracking-wide text-faint">{WIRE[p.wire] ?? p.wire}</span>
          {p.kind !== "builtin" && <span className="text-micro text-faint">{p.kind}</span>}
          <span className="ml-auto shrink-0 text-caption tabular-nums text-muted">
            {p.available ? `${l.models} model${l.models === 1 ? "" : "s"}` : "not set up"}
          </span>
        </div>
        {p.detail && <div className="truncate text-caption text-faint" title={p.detail}>{p.detail}{p.account ? ` · ${p.account}` : ""}</div>}
        {p.available && l.state === "failed" && (
          <div className="mt-0.5 text-caption text-danger" data-testid="listing-error">
            {l.models ? "The listing failed; the last good list is kept: " : "The listing failed: "}
            <span className="break-words">{l.error}</span>
          </div>
        )}
        {p.available && l.fetched_ms && l.state !== "failed" && <div className="text-micro text-faint">listed {ago(l.fetched_ms)}</div>}
        {p.sign_in?.command && !p.available && <div className="mt-1 text-caption text-muted">Run <code className="rounded-xs bg-code px-1 font-mono">{p.sign_in.command}</code> in a terminal, then refresh.</div>}
        {p.id === "grok" && !p.available && <GrokSignIn />}
      </div>
    </div>
  );
}

export function ProvidersSettings() {
  const report = useStore((s) => s.providers);
  const defaultModel = useStore((s) => s.defaultModel);
  const [busy, setBusy] = useState(false);
  useEffect(() => { actions.loadProviders().catch(reportError); }, []);
  const refresh = async () => {
    setBusy(true);
    try { await actions.loadProviders(true); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const rows = report?.providers ?? [];
  const ready = rows.filter((p) => p.available);
  const idle = rows.filter((p) => !p.available);
  const heading = (t: string) => <h3 className="mt-6 mb-2 text-micro font-medium uppercase tracking-wide text-faint">{t}</h3>;

  return (
    <div data-testid="providers-panel">
      <Card>
        <SettingRow label="New sessions start on" hint="Every model comes from its provider's own listing.">
          <ModelPicker value={report?.choices.default ?? defaultModel} onChange={(id) => actions.setDefaultModel(id).catch(reportError)} />
        </SettingRow>
        <SettingRow label="Listings" hint="A provider whose listing fails keeps its last good list.">
          <button
            type="button"
            data-testid="providers-refresh"
            onClick={refresh}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> {busy ? "Reading" : "Read again"}
          </button>
        </SettingRow>
      </Card>
      {!report && <p className="py-8 text-center text-ui text-faint">Reading the providers.</p>}
      {ready.length > 0 && heading("Set up")}
      {ready.length > 0 && <Card>{ready.map((p) => <ProviderRow key={p.id} p={p} />)}</Card>}
      {idle.length > 0 && heading("Not set up")}
      {idle.length > 0 && <Card>{idle.map((p) => <ProviderRow key={p.id} p={p} />)}</Card>}
      {!!report?.plugins.length && (
        <>
          {heading("Plugins, protocol v1")}
          <Card>
            {report.plugins.map((pl) => (
              <div key={pl.id} className="flex gap-3 border-b border-line py-3 last:border-0" data-testid="plugin-row" data-plugin={pl.id}>
                <Dot tone={pl.state === "ready" ? "ok" : pl.state === "stopped" ? "off" : "warn"} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-base font-medium">{pl.name ?? pl.id}</span>
                    {pl.version && <span className="text-caption text-faint">{pl.version}</span>}
                    <span className="ml-auto text-caption text-muted">{pl.state.replace("_", " ")}</span>
                  </div>
                  {pl.reason && <div className="text-caption text-faint">{pl.reason}</div>}
                  {pl.violations.count > 0 && <div className="text-caption text-warn">{pl.violations.count} protocol violations, the last: {pl.violations.last}</div>}
                  {pl.stderr_tail && <pre className="mt-1 max-h-24 overflow-auto rounded-md bg-code p-2 font-mono text-micro text-muted whitespace-pre-wrap">{pl.stderr_tail}</pre>}
                </div>
              </div>
            ))}
          </Card>
          {report.plugins_file && <p className="mt-2 text-micro text-faint">from {report.plugins_file}</p>}
        </>
      )}
    </div>
  );
}
