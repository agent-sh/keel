// Settings > Logs and traces: the daemon's log, live, with a level and a
// filter; where its files are; and sending the traces to an OpenTelemetry
// collector (Phoenix, Langfuse, Jaeger, any OTLP/HTTP endpoint).
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { clock, cn, when } from "../lib/utils.ts";
import { Card, Segmented, SettingRow } from "./Settings.tsx";
import { Toggle } from "./surfaces/kit.tsx";
import { useSettings } from "./StoragePanel.tsx";

type Line = { ts: number; level: "debug" | "info" | "warn" | "error"; text: string };
type HeadersShown = { label: string; from: "setting" | "env"; names: string[]; missing: boolean };
type HeaderRef = { env?: string; cred?: string };
type Sent = { endpoint: string | null; from: "setting" | "env" | null; headers: HeadersShown | null; sent: number; dropped: number; failures: number; last_ok_ms: number | null; last_error: string | null; queued: number };
type Export = Sent & { metrics: Sent; events: Sent };
const LEVELS = ["debug", "info", "warn", "error"] as const;
const KEEP = 1000;
const btn = "h-8 shrink-0 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";

function Exporter() {
  const [settings, patch] = useSettings();
  const [st, setSt] = useState<Export | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<Export>("/api/debug/export").then(setSt).catch(reportError);
  useEffect(() => { load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, []);
  if (!settings || !st) return null;
  const saved = settings.observe?.otlp_endpoint ?? "";
  const value = draft ?? saved;
  const save = (v: string | null) => patch({ observe: { otlp_endpoint: v } }).then(() => { setDraft(null); setErr(""); load(); }).catch((e) => setErr(e.message));
  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-line py-4">
        <div>
          <div className="text-base font-medium">Send traces</div>
          <div className="mt-0.5 text-ui text-muted">Each turn, model request and tool call as OpenTelemetry spans with the GenAI names (OTLP/HTTP JSON) to Phoenix, Langfuse, Jaeger or any collector. Shapes, timings, tokens and failure classes only: never prompts, replies or tool input. Empty uses OTEL_EXPORTER_OTLP_ENDPOINT when the daemon has it. Spans still waiting for a collector are dropped when another one is set or the export is turned off.</div>
        </div>
        <form className="flex min-w-0 items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(value.trim() || null).catch(reportError); }}>
          <input
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://localhost:6006/v1/traces"
            aria-label="OTLP traces endpoint"
            data-testid="otlp-endpoint"
            className="h-8 min-w-0 max-w-xl flex-1 rounded-md border border-line bg-sunken px-2.5 font-mono text-caption outline-none focus:border-ring"
          />
          <button type="submit" className={btn} disabled={draft === null || draft.trim() === saved} data-testid="otlp-save">Save</button>
        </form>
      </div>
      <AuthHeaders saved={settings.observe?.otlp_headers ?? null} shown={st.headers} patch={patch} onSaved={load} />
      <SettingRow label="Export" hint={err || st.last_error || (st.endpoint ? `To ${st.endpoint}${st.from === "env" ? " (from the environment)" : ""}.` : "Off.")}>
        <span className={cn("text-ui tabular-nums", st.last_error ? "text-danger" : "text-muted")} data-testid="otlp-state">
          {st.endpoint ? `${st.sent} sent${st.queued ? `, ${st.queued} waiting` : ""}${st.dropped ? `, ${st.dropped} dropped` : ""}${st.last_ok_ms ? `, last ${when(st.last_ok_ms)}` : ""}` : "Off"}
        </span>
      </SettingRow>
      <Signal id="metrics" label="Send metrics" what="Counts, durations, tokens and cost per model and tool, to /v1/metrics at the same collector. No session ids, no text." on={settings.observe?.otlp_metrics ?? null} st={st.metrics} traces={saved} set={(v) => patch({ observe: { otlp_metrics: v } }).then(load).catch(reportError)} />
      <Signal id="events" label="Send events" what="One event per prompt, model request, tool call and turn, to /v1/logs, each with its trace. Lengths, names and failure classes: never the words." on={settings.observe?.otlp_events ?? null} st={st.events} traces={saved} set={(v) => patch({ observe: { otlp_events: v } }).then(load).catch(reportError)} />
    </Card>
  );
}

// One more signal to the collector: on or off, where it goes and how it went.
// `on` null: the daemon's environment decides (the OpenTelemetry selectors).
function Signal({ id, label, what, on, st, traces, set }: { id: string; label: string; what: string; on: boolean | null; st: Sent; traces: string; set: (v: boolean) => void }) {
  const active = on ?? !!st.endpoint;
  const state = st.last_error ? st.last_error
    : st.endpoint ? `To ${st.endpoint}${st.from === "env" ? " (from the environment)" : ""}.`
    : active ? (traces ? "On, with nowhere to send: the traces address does not end in /v1/traces." : "On, with nowhere to send: set the traces address.")
    : "";
  return (
    <SettingRow label={label} hint={<>{what}{state && <span className={cn("mt-1 block", st.last_error ? "text-danger" : "")} data-testid={`otlp-${id}-where`}>{state}</span>}</>}>
      <span className="flex items-center gap-3">
        {st.endpoint && <span className="text-ui tabular-nums text-muted" data-testid={`otlp-${id}-state`}>{st.sent} sent{st.queued ? `, ${st.queued} waiting` : ""}{st.dropped ? `, ${st.dropped} dropped` : ""}</span>}
        <Toggle on={active} label={label} testid={`otlp-${id}`} onChange={set} />
      </span>
    </SettingRow>
  );
}

// The collector's auth headers, by reference: the name of a daemon environment
// variable or a keyring entry holding `k=v` pairs. The value never comes here;
// the daemon reports the header names it found.
function AuthHeaders({ saved, shown, patch, onSaved }: { saved: HeaderRef | null; shown: HeadersShown | null; patch: (p: any) => Promise<unknown>; onSaved: () => void }) {
  const savedKind = saved?.cred ? "cred" : "env";
  const savedName = saved?.cred ?? saved?.env ?? "";
  const [kind, setKind] = useState<"env" | "cred">(savedKind);
  const [name, setName] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const value = name ?? savedName;
  const dirty = value.trim() !== savedName || (value.trim() !== "" && kind !== savedKind);
  const save = (ref: HeaderRef | null) =>
    patch({ observe: { otlp_headers: ref ? { env: ref.env ?? null, cred: ref.cred ?? null } : null } })
      .then(() => { setName(null); setErr(""); onSaved(); })
      .catch((e) => setErr(e.message));
  const submit = () => {
    const n = value.trim();
    return save(n ? (kind === "env" ? { env: n } : { cred: n }) : null);
  };
  return (
    <div className="flex flex-col gap-3 border-b border-line py-4" data-testid="otlp-headers">
      <div>
        <div className="text-base font-medium">Auth headers</div>
        <div className="mt-0.5 text-ui text-muted">Named here, never stored here: an environment variable of the daemon or a keyring entry whose value is <span className="font-mono text-caption">key=value</span> pairs, comma separated, as in OTEL_EXPORTER_OTLP_HEADERS (for example <span className="font-mono text-caption">Authorization=Bearer …</span>). Empty uses OTEL_EXPORTER_OTLP_HEADERS when the daemon has it.</div>
      </div>
      <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); submit().catch(reportError); }}>
        <Segmented label="Where the headers are" value={kind} onChange={setKind} options={[{ value: "env", label: "Environment" }, { value: "cred", label: "Keyring" }]} />
        <input
          value={value}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === "env" ? "COLLECTOR_HEADERS" : "otlp-collector"}
          aria-label={kind === "env" ? "Environment variable name" : "Keyring entry name"}
          spellCheck={false}
          autoComplete="off"
          data-testid="otlp-headers-name"
          className="h-8 min-w-0 max-w-xs flex-1 rounded-md border border-line bg-sunken px-2.5 font-mono text-caption outline-none focus:border-ring"
        />
        <button type="submit" className={btn} disabled={!dirty} data-testid="otlp-headers-save">Save</button>
        {saved && <button type="button" className={btn} onClick={() => save(null).catch(reportError)} data-testid="otlp-headers-clear">Clear</button>}
      </form>
      <div className={cn("text-ui", err || shown?.missing ? "text-danger" : "text-muted")} data-testid="otlp-headers-state">
        {err ? err
          : !shown ? "No auth headers are sent."
          : shown.missing ? `${shown.label} ${shown.label.startsWith("keyring") ? "has no value in the keyring" : "is not set in the daemon's environment"}: no headers are sent.`
          : (
            <>
              Sends{" "}
              {shown.names.map((n, i) => (
                <span key={n}>{i ? ", " : ""}<span className="font-mono text-caption text-fg">{n}: ••••••</span></span>
              ))}
              {shown.names.length ? " " : "the headers "}from {shown.label}{shown.from === "env" ? " (the environment default)" : ""}.
            </>
          )}
      </div>
    </div>
  );
}

function LiveLog() {
  const [lines, setLines] = useState<Line[]>([]);
  const [dir, setDir] = useState("");
  const [level, setLevel] = useState<(typeof LEVELS)[number]>("info");
  const [q, setQ] = useState("");
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const held = useRef<Line[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    api<{ lines: Line[]; dir: string }>(`/api/logs?level=debug&limit=${KEEP}`).then((r) => { if (alive) { setLines(r.lines); setDir(r.dir); } }).catch(reportError);
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (m) => {
      const l = JSON.parse(m.data) as Line;
      if (pausedRef.current) { held.current.push(l); return; }
      setLines((xs) => [...xs, l].slice(-KEEP));
    };
    return () => { alive = false; es.close(); };
  }, []);
  useEffect(() => {
    if (!paused && held.current.length) { const h = held.current; held.current = []; setLines((xs) => [...xs, ...h].slice(-KEEP)); }
  }, [paused]);

  const shown = useMemo(() => {
    const min = LEVELS.indexOf(level);
    const f = q.toLowerCase();
    return lines.filter((l) => LEVELS.indexOf(l.level) >= min && (!f || l.text.toLowerCase().includes(f)));
  }, [lines, level, q]);
  useEffect(() => { if (!paused) box.current?.scrollTo({ top: box.current.scrollHeight }); }, [shown, paused]);

  return (
    <Card>
      <div className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui font-medium">Daemon log</span>
          <span className="text-caption text-faint">live; files per day in <span className="font-mono">{dir || "the state folder"}</span></span>
          <span className="ml-auto" />
          <Segmented label="Level" value={level} onChange={setLevel} options={LEVELS.map((l) => ({ value: l, label: l[0]!.toUpperCase() + l.slice(1) }))} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter the log" data-testid="log-filter" className="h-8 w-44 rounded-md border border-line bg-sunken px-2.5 text-caption outline-none focus:border-ring" />
          <button type="button" className={cn(btn, "grid w-8 place-items-center px-0")} onClick={() => setPaused((p) => !p)} aria-label={paused ? "Follow the log" : "Pause the log"}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </button>
        </div>
        <div ref={box} className="h-[26rem] overflow-auto rounded-md border border-line bg-code p-2 font-mono text-micro leading-relaxed" data-testid="log-lines">
          {shown.length === 0 && <p className="k-empty p-3">No lines at this level{q ? " with that text" : ""}.</p>}
          {shown.map((l, i) => (
            <div key={`${l.ts}-${i}`} className="flex gap-3 whitespace-pre-wrap break-all" data-level={l.level}>
              <span className="shrink-0 tabular-nums text-faint">{clock(l.ts, { seconds: true })}</span>
              <span className={cn("w-10 shrink-0 uppercase", l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warn" : "text-faint")}>{l.level}</span>
              <span className={cn("min-w-0", l.level === "error" ? "text-fg" : "text-muted")}>{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function LogsSettings() {
  return (
    <div className="flex flex-col gap-4" data-testid="logs-settings">
      <LiveLog />
      <Exporter />
    </div>
  );
}

export default LogsSettings;
