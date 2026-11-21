// Settings > Experiments: A/B tests of Keel's own configuration. Each has a
// hypothesis, arms (configuration differences, the first is the control),
// the metric that judges them, guards and a stop rule. Offline ones run on a
// fixed task set through the bench runner; live ones split new sessions.
import { FlaskConical, Play, Plus, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { fmtPct, Panel } from "./UsagePanel.tsx";

type Interval = { estimate: number; lo: number; hi: number; n: number; method: string };
type Metric = string;
type MetricInfo = { label: string; better: "lower" | "higher"; unit: string };
type Arm = { name: string; weight?: number; tools_off?: string[]; settings?: Record<string, unknown>; system_append?: string; cache_life?: string; tool_text?: Record<string, string>; model?: string };
type Decision = { winner: string | null; verdict: "won" | "inconclusive" | "regression"; text: string; remove: string; ts: number };
export type Experiment = {
  id: string; name: string; hypothesis: string; mode: "offline" | "live"; template?: string; arms: Arm[]; primary: Metric;
  guards: { metric: Metric; mde: number; relative?: boolean }[]; stop: { sessions_per_arm?: number | null; alpha?: number; window_min?: number; reps?: number; tasks?: string[]; model?: string };
  state: "draft" | "running" | "stopped"; created_ms: number; started_ms?: number; stopped_ms?: number; stop_reason?: string; decision?: Decision;
  sessions: { arm: string; n: number }[]; runs: number;
};
type Template = Omit<Experiment, "id" | "state" | "created_ms" | "sessions" | "runs"> & { id: string; label: string };
type Report = {
  unit: string;
  arms: { arm: string; units: number; clusters: number; metrics: Record<Metric, Interval> }[];
  effects: { arm: string; metric: Metric; diff: Interval & { significant: boolean; relative: number | null }; better: boolean | null }[];
  guards: { arm: string; metric: Metric; lr: number; reject: boolean; diff: number; worse: boolean; n: [number, number] }[];
  threshold?: number; // the evidence a guard needs: 1 / alpha
  // Live: the evidence the stop rule reads (the average over the tests) and the families it read.
  guard?: { evidence: number; threshold: number; tests: number; window_min: number; fixed: number; pending: number };
  decision: Decision;
  final_ms?: number; // a stopped experiment: when its report was frozen
};
type List = { experiments: Experiment[]; templates: Template[]; metrics: Record<Metric, MetricInfo> };

const btn = "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-ui font-medium disabled:opacity-50";
const primaryBtn = cn(btn, "bg-accent text-accent-fg hover:bg-accent-hover");
const quietBtn = cn(btn, "border border-line bg-raised text-fg hover:bg-hover");
const field = "h-8 min-w-0 rounded-md border border-line bg-sunken px-2 text-ui outline-none placeholder:text-faint focus:border-accent";

// A metric value in its own unit.
export function fmtMetric(unit: string, v: number | null | undefined, signed = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "none";
  const s = signed && v > 0 ? "+" : "";
  if (unit === "usd") return `${s}${v < 0 ? "-" : ""}$${Math.abs(v) < 0.01 ? Math.abs(v).toFixed(5) : Math.abs(v).toFixed(4)}`;
  if (unit === "share") return `${s}${(v * 100).toFixed(Math.abs(v) < 0.1 && v !== 0 ? 1 : 0)}${signed ? " pt" : "%"}`;
  if (unit === "ms") return `${s}${(v / 1000).toFixed(1)} s`;
  if (unit === "tokens") return `${s}${Math.abs(v) >= 10_000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v)}`;
  return `${s}${v.toFixed(v % 1 ? 2 : 0)}`;
}
// The estimate, with its interval under it. `of`: the arm's units; when
// fewer of them have the metric (a cost with no price is left out, not
// counted as zero), the cell says how many it is over.
const iv = (unit: string, i: Interval | undefined, signed = false, of?: number) =>
  !i || !Number.isFinite(i.estimate) ? <span className="text-faint">none</span> : (
    <span className="inline-flex flex-col items-end whitespace-nowrap leading-tight">
      <span className="text-fg">{fmtMetric(unit, i.estimate, signed)}</span>
      {i.method !== "none" && <span className="text-micro text-faint">{fmtMetric(unit, i.lo, signed)} to {fmtMetric(unit, i.hi, signed)}</span>}
      {of !== undefined && i.n < of && <span className="text-micro text-faint" data-testid="metric-partial">over {i.n} of {of}</span>}
    </span>
  );

// Sequential evidence, as a ratio: 1 is none.
const fmtEvidence = (v: number) => (v >= 1000 ? "over 1000" : v.toFixed(1));
// A guard window in the largest whole unit.
const fmtWindow = (min: number) => (min >= 60 && min % 60 === 0 ? `${min / 60} h` : min >= 1 ? `${Number(min.toFixed(1))} min` : `${Math.round(min * 60)} s`);

function armDiff(a: Arm) {
  const parts: string[] = [];
  if (a.tools_off?.length) parts.push(`without ${a.tools_off.join(", ")}`);
  for (const [k, v] of Object.entries(a.settings ?? {})) parts.push(`${k}: ${JSON.stringify(v)}`);
  if (a.system_append) parts.push(`prompt addition (${a.system_append.length} chars)`);
  if (a.cache_life) parts.push(`${a.cache_life} cache`);
  if (a.tool_text) parts.push(`own text for ${Object.keys(a.tool_text).join(", ")}`);
  if (a.model) parts.push(a.model);
  return parts.join(", ") || "current configuration";
}

const STATE_TONE: Record<Experiment["state"], string> = { draft: "text-muted bg-sunken", running: "text-accent bg-accent-soft", stopped: "text-faint bg-sunken" };
function StateChip({ e }: { e: Experiment }) {
  return <span data-testid="experiment-state" className={cn("rounded-sm px-1.5 py-0.5 text-micro font-medium uppercase tracking-wide", STATE_TONE[e.state])}>{e.state}</span>;
}

export function ExperimentsPanel() {
  const [list, setList] = useState<List | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState<boolean | null>(null);
  const load = useCallback(() => api<List>("/api/experiments").then(setList).catch(reportError), []);
  useEffect(() => { void load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, [load]);
  if (!list) return <div className="text-ui text-faint">Reading the experiments.</div>;
  const current = list.experiments.find((e) => e.id === open) ?? list.experiments[0];
  const showForm = creating ?? !list.experiments.length;
  return (
    <div className="flex flex-col gap-4" data-testid="experiments-panel">
      <div className="flex items-start gap-4">
        <p className="max-w-3xl flex-1 text-ui text-muted">
          An experiment proves a change with numbers before it ships. Offline, its arms run over a fixed task set with repetitions; live, new sessions are split between the arms and a guard that gets worse stops it. When it ends it says which arm won, and the other arm's path is removed.
        </p>
        <button type="button" className={showForm ? quietBtn : primaryBtn} onClick={() => setCreating(!showForm)} data-testid="experiment-new">
          {showForm ? <><X className="size-4" />Close</> : <><Plus className="size-4" />New experiment</>}
        </button>
      </div>
      {showForm && <Create templates={list.templates} metrics={list.metrics} onMade={(e) => { setOpen(e.id); setCreating(false); void load(); }} />}
      <div className="grid grid-cols-[18rem_minmax(0,1fr)] gap-4">
        <nav className="flex flex-col gap-1" aria-label="Experiments" data-testid="experiment-list">
          {!list.experiments.length && <p className="px-2 py-3 text-caption text-faint">No experiments yet. Start from a template above.</p>}
          {list.experiments.map((e) => (
            <button key={e.id} type="button" onClick={() => setOpen(e.id)} data-testid="experiment-item"
              className={cn("flex flex-col gap-1 rounded-md border px-3 py-2 text-left", current?.id === e.id ? "border-line-strong bg-raised shadow-1" : "border-transparent hover:bg-hover")}>
              <span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-ui font-medium">{e.name}</span><StateChip e={e} /></span>
              <span className="text-caption text-faint">{e.mode} · {e.mode === "live" ? `${e.sessions.reduce((n, s) => n + s.n, 0)} families` : `${e.runs} runs`} · {ago(e.started_ms ?? e.created_ms)}</span>
            </button>
          ))}
        </nav>
        {current ? <Detail key={current.id} id={current.id} metrics={list.metrics} onChange={() => void load()} /> : <div />}
      </div>
    </div>
  );
}

function Create({ templates, metrics, onMade }: { templates: Template[]; metrics: Record<Metric, MetricInfo>; onMade: (e: Experiment) => void }) {
  const [tpl, setTpl] = useState(templates[0]?.id ?? "");
  const t = templates.find((x) => x.id === tpl);
  const [name, setName] = useState(t?.name ?? "");
  const [hypothesis, setHypothesis] = useState(t?.hypothesis ?? "");
  const [arms, setArms] = useState(JSON.stringify(t?.arms ?? [], null, 1));
  const [primary, setPrimary] = useState(t?.primary ?? "cost_usd");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = (id: string) => {
    const n = templates.find((x) => x.id === id);
    setTpl(id);
    if (!n) return;
    setName(n.name); setHypothesis(n.hypothesis); setArms(JSON.stringify(n.arms, null, 1)); setPrimary(n.primary); setError(null);
  };
  const make = async () => {
    setBusy(true); setError(null);
    try {
      const parsed = JSON.parse(arms);
      const r = await api<{ experiment: Experiment }>("/api/experiments", { method: "POST", body: JSON.stringify({ template: tpl, name, hypothesis, arms: parsed, primary }) });
      onMade(r.experiment);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Panel title="New experiment" hint={t ? `${t.mode} template` : undefined} testid="experiment-create">
      <div className="grid grid-cols-[14rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-ui">
        <label className="self-center text-muted" htmlFor="exp-template">Template</label>
        <div><Select value={tpl} onChange={(e) => pick(e.target.value)} aria-label="Template" data-testid="experiment-template">{templates.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></div>
        <label className="self-center text-muted" htmlFor="exp-name">Name</label>
        <input id="exp-name" className={field} value={name} onChange={(e) => setName(e.target.value)} data-testid="experiment-name" />
        <label className="pt-1.5 text-muted" htmlFor="exp-hyp">Hypothesis</label>
        <textarea id="exp-hyp" className={cn(field, "h-auto min-h-[3.5rem] resize-y py-1.5")} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} data-testid="experiment-hypothesis" />
        <label className="pt-1.5 text-muted" htmlFor="exp-arms">Arms <span className="block text-caption text-faint">the first is the control: tools_off, settings, system_append, cache_life, tool_text{t?.mode === "offline" ? ", model" : ""}</span></label>
        <textarea id="exp-arms" spellCheck={false} className={cn(field, "h-auto min-h-[7rem] resize-y py-1.5 font-mono text-caption")} value={arms} onChange={(e) => setArms(e.target.value)} data-testid="experiment-arms" />
        <label className="self-center text-muted" htmlFor="exp-primary">Judged by</label>
        <div><Select value={primary} onChange={(e) => setPrimary(e.target.value)} aria-label="Primary metric">{Object.entries(metrics).map(([k, m]) => <option key={k} value={k}>{m.label} ({m.better} is better)</option>)}</Select></div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className={primaryBtn} onClick={make} disabled={busy || !name.trim()} data-testid="experiment-make"><FlaskConical className="size-4" />Create</button>
        {error && <span className="text-caption text-danger" role="alert">{error}</span>}
      </div>
    </Panel>
  );
}

function Detail({ id, metrics, onChange }: { id: string; metrics: Record<Metric, MetricInfo>; onChange: () => void }) {
  const [d, setD] = useState<{ experiment: Experiment; report: Report } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ experiment: Experiment; report: Report }>(`/api/experiments/${id}`).then(setD).catch(reportError), [id]);
  useEffect(() => { void load(); const t = setInterval(load, 5_000); return () => clearInterval(t); }, [load]);
  if (!d) return <div className="text-ui text-faint">Reading the report.</div>;
  const { experiment: e, report: r } = d;
  const act = (path: string, method = "POST") => api(`/api/experiments/${e.id}${path}`, { method }).then(() => { setError(null); void load(); onChange(); }).catch((x) => setError((x as Error).message));
  const control = e.arms[0]!.name;
  const shown = [e.primary, ...e.guards.map((g) => g.metric), ...Object.keys(metrics)].filter((m, i, a) => a.indexOf(m) === i && r.arms.some((x) => x.metrics[m]));
  // What the guards really stop at: the report's own threshold (1 / alpha), 20 at the default alpha.
  const alpha = e.stop.alpha ?? 0.05;
  const stopsAt = Number((r.threshold ?? 1 / alpha).toFixed(1));
  const runCmd = `bun scripts/bench/run.ts --experiment ${e.id} --daemon ${location.origin}${e.stop.model ? "" : " --model <id>"}${e.stop.tasks?.length ? "" : " --tasks <ids>"}`;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="experiment-detail">
      <section className="rounded-lg border border-line bg-raised p-4 shadow-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><h3 className="truncate text-base font-medium">{e.name}</h3><StateChip e={e} /><span className="text-caption text-faint">{e.mode}</span></div>
            <p className="mt-1 text-ui text-muted">{e.hypothesis}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {e.state === "draft" && <button type="button" className={primaryBtn} onClick={() => act("/start")} data-testid="experiment-start"><Play className="size-4" />Start</button>}
            {e.state === "running" && <button type="button" className={quietBtn} onClick={() => act("/stop")} data-testid="experiment-stop"><Square className="size-4" />Stop and decide</button>}
            {e.state !== "running" && <button type="button" className={quietBtn} onClick={() => act("", "DELETE")} aria-label="Delete" title="Delete"><Trash2 className="size-4" /></button>}
          </div>
        </div>
        {error && <p className="mt-2 text-caption text-danger" role="alert">{error}</p>}
        <dl className="mt-3 grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
          <dt className="text-faint">Judged by</dt><dd>{metrics[e.primary]?.label} ({metrics[e.primary]?.better} is better)</dd>
          <dt className="text-faint">Guards</dt><dd>{e.guards.length ? e.guards.map((g) => `${metrics[g.metric]?.label} may not get worse by ${g.relative ? `${Math.round(g.mde * 100)}%` : metrics[g.metric]!.unit === "share" ? `${Math.round(g.mde * 100)} points` : fmtMetric(metrics[g.metric]!.unit, g.mde)}`).join("; ") : "none"}</dd>
          <dt className="text-faint">Stop rule</dt><dd>{e.mode === "live" ? `a guard regression (sequential evidence, at most ${Number((alpha * 100).toFixed(2))}% false stops over all guards, arms and looks)${e.stop.sessions_per_arm ? `, or ${e.stop.sessions_per_arm} session families per arm` : ", or the owner"}` : `${e.stop.reps ?? 3} repetitions per task and arm`}</dd>
          {e.mode === "offline" && <><dt className="text-faint">Run it</dt><dd><code className="block w-fit max-w-full select-all break-all rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-micro" data-testid="experiment-command">{runCmd}</code></dd></>}
          {e.stop_reason && <><dt className="text-faint">Stopped</dt><dd data-testid="experiment-stop-reason">{e.stop_reason}{e.stopped_ms ? `, ${ago(e.stopped_ms)}` : ""}</dd></>}
        </dl>
      </section>

      <Verdict d={e.decision ?? r.decision} final={!!e.decision} />

      <Panel title="Arms" hint={`${r.final_ms ? "final, frozen when it stopped; " : ""}each arm against ${control}; unit: ${r.unit}; 95% BCa bootstrap intervals`} testid="experiment-report">
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-ui">
            <thead>
              <tr className="border-b border-line text-caption text-faint">
                <th className="px-4 py-1.5 text-left font-normal">Metric</th>
                {r.arms.map((a) => <th key={a.arm} className="px-4 py-1.5 text-right font-normal">{a.arm} <span className="text-faint">n={a.units}{e.mode === "live" ? `, ${a.clusters} ${a.clusters === 1 ? "family" : "families"}` : ""}</span></th>)}
                {e.arms.slice(1).map((a) => <th key={a.name} className="px-4 py-1.5 text-right font-normal">{a.name} minus {control}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const info = metrics[m]!;
                return (
                  <tr key={m} className="border-b border-line/60 last:border-0" data-testid={`metric-${m}`}>
                    <td className="whitespace-nowrap px-4 py-1.5">{info.label}{m === e.primary && <span className="ml-2 rounded-sm bg-accent-soft px-1 text-micro text-accent">primary</span>}</td>
                    {r.arms.map((a) => <td key={a.arm} className="px-4 py-1.5 text-right tabular-nums text-muted">{iv(info.unit, a.metrics[m], false, a.units)}</td>)}
                    {e.arms.slice(1).map((a) => {
                      const f = r.effects.find((x) => x.arm === a.name && x.metric === m);
                      return (
                        <td key={a.name} className="px-4 py-1.5 text-right tabular-nums text-muted">
                          {f ? (
                            <span className="inline-flex items-center gap-2">
                              {f.diff.significant
                                ? <span className={cn("rounded-sm px-1 text-micro font-medium", f.better ? "bg-sunken text-ok" : "bg-danger-soft text-danger")}>{f.better ? "better" : "worse"}</span>
                                : <span className="text-micro text-faint">no difference</span>}
                              {iv(info.unit, f.diff, true)}
                            </span>
                          ) : <span className="text-faint">none</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!!r.guards.length && (
          <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-caption text-muted" data-testid="experiment-guards">
            {r.guard ? (
              <p>
                Guard evidence that an arm is worse: <span className="font-medium tabular-nums text-fg" data-testid="guard-evidence">{fmtEvidence(r.guard.evidence)}</span>, the average over {r.guard.tests} {r.guard.tests === 1 ? "test" : "tests"}; it stops the experiment at <span data-testid="guard-threshold">{stopsAt}</span>.
                {" "}{r.guard.fixed} session {r.guard.fixed === 1 ? "family" : "families"} read, each once, {fmtWindow(r.guard.window_min)} after it started{r.guard.pending ? `; ${r.guard.pending} still inside ${r.guard.pending === 1 ? "its" : "their"} window` : ""}.
              </p>
            ) : <p>Guards, read once over the runs (likelihood ratio; a guard is worse at <span data-testid="guard-threshold">{stopsAt}</span>):</p>}
            <p className="tabular-nums">{r.guards.map((g) => `${g.arm}, ${metrics[g.metric]?.label}: ${fmtEvidence(g.lr)}${g.worse ? " worse" : ""}`).join("; ")}</p>
          </div>
        )}
      </Panel>
      {e.mode === "live" && (
        <Panel title="Session families by arm" hint="a new top-level session draws its arm at its first turn; its subagents share the arm and count with it as one family">
          <div className="flex flex-wrap gap-6 text-ui" data-testid="experiment-sessions">
            {e.arms.map((a) => (
              <div key={a.name} className="flex flex-col">
                <span className="text-title font-semibold tabular-nums">{e.sessions.find((s) => s.arm === a.name)?.n ?? 0}</span>
                <span className="text-caption text-muted">{a.name}: {armDiff(a)}{a.weight === 0 && <span className="text-faint" data-testid="arm-off"> (weight 0: gets no sessions, not compared)</span>}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {e.mode === "offline" && (
        <Panel title="Arms as configured">
          <ul className="flex flex-col gap-1 text-ui">{e.arms.map((a) => <li key={a.name}><span className="font-medium">{a.name}</span><span className="text-muted">: {armDiff(a)}</span></li>)}</ul>
        </Panel>
      )}
    </div>
  );
}

function Verdict({ d, final }: { d: Decision; final: boolean }) {
  const tone = d.verdict === "regression" ? "border-danger/40 bg-danger-soft" : d.verdict === "won" ? "border-ok/40" : "border-line";
  return (
    <section className={cn("rounded-lg border bg-raised p-4 shadow-1", tone)} data-testid="experiment-decision">
      <div className="flex items-baseline gap-2">
        <h3 className="text-base font-medium">{final ? "Decision" : "Where it stands"}</h3>
        <span className={cn("text-caption font-medium", d.verdict === "regression" ? "text-danger" : d.verdict === "won" ? "text-ok" : "text-muted")}>
          {d.verdict === "won" ? `${d.winner} wins` : d.verdict === "regression" ? "regression" : "inconclusive"}
        </span>
      </div>
      <p className="mt-1 text-ui">{d.text}</p>
      <p className="mt-1 text-ui text-muted">{d.remove}</p>
    </section>
  );
}

export { fmtPct };
export default ExperimentsPanel;
