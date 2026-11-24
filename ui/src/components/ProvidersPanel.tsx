// Settings > Providers: every provider with its listing state, the default
// model and the Grok plan sign-in; the plugins are linked to their own page.
import { ChevronDown, ChevronRight, ExternalLink, LogIn, Pencil, Plus, Puzzle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { actions, api, reportError, useStore, type ProvidersReport, failed } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";
import { navigate } from "../lib/ui.ts";
import { AddProviderHost, openAddProvider } from "./AddProvider.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { ProviderModels } from "./ProviderModels.tsx";
import { Card, SettingRow } from "./Settings.tsx";
import { ProblemNote, RouteProblemNote, WindowMeter } from "./Limits.tsx";

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
  if (p.problem) return p.problem.kind === "billing" ? "warn" : "danger";
  if (p.routes?.some((r) => !r.open)) return "warn";
  if (p.listing.state === "failed") return p.listing.models ? "warn" : "danger";
  return p.listing.models ? "ok" : "warn";
}

function GrokSignIn() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s?.state !== "pending") return;
    const t = setInterval(async () => {
      const next = await actions.grokSignInState().catch((e) => (reportError(e, { at: "sign-in state" }), null));
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
          try { setS(await actions.grokSignIn()); } catch (e) { setS({ state: "failed", error: failed(e, { at: "ProvidersPanel" }) }); } finally { setBusy(false); }
        }}
        className="k-btn"
      >
        <LogIn className="size-3.5" /> Sign in
      </button>
      {s?.state === "failed" && <span className="text-caption text-danger">{s.error}</span>}
    </div>
  );
}

// An entry of the owner's providers.toml is read only here; moved to a file of
// its own (the entry stays there as comments), it can be edited.
function MoveOut({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const move = async () => {
    setBusy(true); setErr("");
    try { await api(`/api/providers/endpoints/${id}/move`, { method: "POST" }); await actions.loadProviders(); }
    catch (e) { setErr(failed(e, { at: "moving an endpoint to its own file" })); } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" data-testid="provider-move-out" disabled={busy} onClick={move}
        title="Copies this entry to endpoints/ where it can be edited here; providers.toml keeps it as comments"
        className="rounded-md px-1.5 text-micro text-accent-ink hover:bg-hover disabled:opacity-50">
        {busy ? "Moving" : "Move to its own file"}
      </button>
      {err && <span className="text-micro text-danger" data-testid="provider-move-error">{err}</span>}
    </>
  );
}

function ProviderRow({ p }: { p: Row }) {
  const l = p.listing;
  const [open, setOpen] = useState(false);
  // An endpoint written by Keel, or a preset (an edit writes its own file over it).
  const editable = p.kind === "endpoint" && (p.source === "endpoints" || p.source === "preset");
  const all = useStore((s) => s.providers?.windows);
  const windows = useMemo(() => all?.filter((w) => w.provider === p.id) ?? [], [all, p.id]);
  // A refused credential found by the listing is said once, as the problem.
  const listingSaid = p.problem?.source === "listing";
  return (
    <div className="flex gap-3 border-b border-line py-3 last:border-0" data-testid="provider-row" data-provider={p.id}>
      <Dot tone={tone(p)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-base font-medium">{p.label}</span>
          <span className="rounded-xs bg-sunken px-1.5 text-micro uppercase tracking-wide text-faint">{WIRE[p.wire] ?? p.wire}</span>
          {p.kind !== "builtin" && <span className="text-micro text-faint">{p.server ?? p.kind}</span>}
          {p.source === "providers.toml" && <span className="text-micro text-faint">providers.toml</span>}
          {p.source === "providers.toml" && p.kind === "endpoint" && <MoveOut id={p.id} />}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-caption tabular-nums text-muted">
            {p.available && l.models > 0 ? (
              <button type="button" data-testid="provider-models-toggle" aria-expanded={open} onClick={() => setOpen(!open)} className="inline-flex min-h-ctl-sm items-center gap-0.5 rounded-md px-1.5 hover:bg-hover hover:text-fg">
                {l.models} model{l.models === 1 ? "" : "s"} {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              </button>
            ) : p.available ? "0 models" : "not set up"}
            {editable && (
              <button type="button" data-testid="provider-edit" aria-label={`Edit ${p.label}`} onClick={() => openAddProvider(p.id)} className="grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><Pencil className="size-3.5" /></button>
            )}
          </span>
        </div>
        {p.detail && <div className="truncate text-caption text-faint" title={p.detail}>{p.detail}{p.account ? ` · ${p.account}` : ""}</div>}
        {p.available && l.fetched_ms && l.state !== "failed" && <div className="text-micro text-faint">listed {ago(l.fetched_ms)}</div>}
        {p.available && p.problem && <ProblemNote p={p.problem} label={p.label} detail={p.problem.kind === "auth" ? p.detail : undefined} />}
        {p.available && p.routes?.map((r) => <RouteProblemNote key={r.route} p={r} provider={p.id} />)}
        {p.available && l.state === "failed" && !listingSaid && (
          <div className="mt-0.5 text-caption text-danger" data-testid="listing-error">
            {l.models ? "The listing failed; the last good list is kept: " : "The listing failed: "}
            <span className="break-words">{l.error}</span>
          </div>
        )}
        {p.available && windows.length > 0 && <div className="mt-1.5" data-testid="provider-windows">{windows.map((w) => <WindowMeter key={w.id} w={w} />)}</div>}
        {p.sign_in?.command && !p.available && <div className="mt-1 text-caption text-muted">Run <code className="rounded-xs bg-code px-1 font-mono">{p.sign_in.command}</code> in a terminal, then refresh.</div>}
        {p.id === "grok" && !p.available && <GrokSignIn />}
        {open && <ProviderModels provider={p.id} editable={editable} />}
      </div>
    </div>
  );
}

// How long after an answer that said the keys were unread the page asks again.
const KEYS_AGAIN_MS = 3000;

export function ProvidersSettings() {
  const report = useStore((s) => s.providers);
  const defaultModel = useStore((s) => s.defaultModel);
  const [busy, setBusy] = useState(false);
  useEffect(() => { actions.loadProviders().catch(reportError); }, []);
  // The daemon answers within a bound, also while a key is still being read
  // (a keyring that waits on an unlock, a helper that is slow): a provider
  // listed as set up may then be one nobody confirmed. The page says so and
  // reads again until the keys are read.
  const unread = report?.keys_read === false;
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(() => actions.loadProviders().catch(reportError), KEYS_AGAIN_MS);
    return () => clearTimeout(t);
  }, [unread, report]);
  const refresh = async () => {
    setBusy(true);
    try { await actions.loadProviders(true); } catch (e) { reportError(e); } finally { setBusy(false); }
  };
  const rows = report?.providers ?? [];
  const ready = rows.filter((p) => p.available);
  const idle = rows.filter((p) => !p.available);
  const heading = (t: string) => <h3 className="k-after-card mt-6 mb-2 k-label">{t}</h3>;

  return (
    <div data-testid="providers-panel">
      <AddProviderHost />
      <Card>
        <SettingRow label="New sessions start on" hint="Every model comes from its provider's own listing.">
          <ModelPicker value={report?.choices.default ?? defaultModel} onChange={(id) => actions.setDefaultModel(id).catch(reportError)} />
        </SettingRow>
        <SettingRow label="Add a provider" hint="Any OpenAI, Anthropic or Gemini compatible endpoint, a server on this machine, an aggregator. The key stays in a variable or the keyring.">
          <button
            type="button"
            data-testid="providers-add"
            onClick={() => openAddProvider()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover"
          >
            <Plus className="size-3.5" /> Add a provider
          </button>
        </SettingRow>
        <SettingRow label="Listings" hint="A provider whose listing fails keeps its last good list.">
          <button
            type="button"
            data-testid="providers-refresh"
            onClick={refresh}
            disabled={busy}
            className="k-btn k-btn-lg"
          >
            <RefreshCw className={cn("size-3.5", busy && "animate-spin")} /> {busy ? "Reading" : "Read again"}
          </button>
        </SettingRow>
      </Card>
      {!report && <p className="k-after-card k-empty py-4">Reading the providers.</p>}
      {unread && <p className="k-after-card k-empty py-4" role="status" data-testid="providers-keys-unread">Still reading the keys. A provider listed as set up may turn out to have none.</p>}
      {ready.length > 0 && heading("Set up")}
      {ready.length > 0 && <Card>{ready.map((p) => <ProviderRow key={p.id} p={p} />)}</Card>}
      {idle.length > 0 && heading("Not set up")}
      {idle.length > 0 && <Card>{idle.map((p) => <ProviderRow key={p.id} p={p} />)}</Card>}
      {!!report?.plugins.length && (
        // The plugins themselves (state, check, plugins.toml) are on their own page.
        <button type="button" className="k-after-card mt-4 flex w-full items-center gap-3 rounded-md border border-line bg-raised px-4 py-3 text-left hover:bg-hover" data-testid="providers-plugins-link" onClick={() => navigate({ name: "settings", section: "plugins" })}>
          <Puzzle className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ui">
            <span className="text-fg">{report.plugins.length} provider plugin{report.plugins.length === 1 ? "" : "s"}</span>
            <span className="text-muted">, {report.plugins.filter((x) => x.state === "ready").length} ready. Their state, the conformance check and plugins.toml are in Plugins.</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
