// Settings > Logs and traces: the daemon's log, live, with a level and a
// filter; where its files are; and sending the traces to an OpenTelemetry
// collector (Phoenix, Langfuse, Jaeger, any OTLP/HTTP endpoint).
import { Pause, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { cn, when } from "../lib/utils.ts";
import { Card, Segmented, SettingRow } from "./Settings.tsx";
import { useSettings } from "./StoragePanel.tsx";

type Line = { ts: number; level: "debug" | "info" | "warn" | "error"; text: string };
type Export = { endpoint: string | null; from: "setting" | "env" | null; sent: number; dropped: number; failures: number; last_ok_ms: number | null; last_error: string | null; queued: number };
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
      <SettingRow
        label="Send traces"
        hint="Each turn, model request and tool call as OpenTelemetry spans with the GenAI names (OTLP/HTTP JSON). Shapes, timings, tokens and failures only: never prompts, replies or tool input. Empty uses OTEL_EXPORTER_OTLP_ENDPOINT when the daemon has it."
      >
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(value.trim() || null).catch(reportError); }}>
          <input
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://localhost:6006/v1/traces"
            aria-label="OTLP traces endpoint"
            data-testid="otlp-endpoint"
            className="h-8 w-80 rounded-md border border-line bg-sunken px-2.5 font-mono text-caption outline-none focus:border-ring"
          />
          <button type="submit" className={btn} disabled={draft === null || draft.trim() === saved} data-testid="otlp-save">Save</button>
        </form>
      </SettingRow>
      <SettingRow label="Export" hint={err || st.last_error || (st.endpoint ? `To ${st.endpoint}${st.from === "env" ? " (from the environment)" : ""}.` : "Off.")}>
        <span className={cn("text-ui tabular-nums", st.last_error ? "text-danger" : "text-muted")} data-testid="otlp-state">
          {st.endpoint ? `${st.sent} sent${st.queued ? `, ${st.queued} waiting` : ""}${st.dropped ? `, ${st.dropped} dropped` : ""}${st.last_ok_ms ? `, last ${when(st.last_ok_ms)}` : ""}` : "Off"}
        </span>
      </SettingRow>
    </Card>
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
          {shown.length === 0 && <p className="p-3 text-faint">No lines at this level{q ? " with that text" : ""}.</p>}
          {shown.map((l, i) => (
            <div key={`${l.ts}-${i}`} className="flex gap-3 whitespace-pre-wrap break-all" data-level={l.level}>
              <span className="shrink-0 tabular-nums text-faint">{new Date(l.ts).toLocaleTimeString("en-GB", { hourCycle: "h23" })}</span>
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
