// Settings > Observability: is each feature paying off, and is anything
// degrading. Turns grouped by how a feature stood (readers used or not, the
// cache lifetime asked for, the tool set offered...), what a feature saved
// against its counterfactual where it computes one, daily trends, and the
// regression check on the daily values.
import { useEffect, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { fmtMetric } from "./ExperimentsPanel.tsx";
import { Segmented } from "./Settings.tsx";
import { fmtMs, fmtPct, fmtUsd, Panel, RANGES, Table, Tile, type Range } from "./UsagePanel.tsx";

type Interval = { estimate: number; lo: number; hi: number; n: number; method: string };
type Stats = {
  turns: number; sessions: number; ok_rate: number | null; error_rate: number | null; stopped_by_owner: number; refusals: number;
  cost_per_turn: Interval | null; priced_turns: number; cache_read_share: number | null; ms_p50: number | null; tool_error_rate: number | null;
  retried_steps: number; thumbs_up: number; thumbs_down: number;
};
type Dimension = { id: string; label: string; note: string; unrecorded: number; groups: (Stats & { value: string })[] };
type Saving = { feature: string; calls: number; priced: number; cost_usd: number; counterfactual_usd: number; saved_usd: number; saved_per_call: Interval; tokens: number; counterfactual_tokens: number; counterfactual: string };
type Regression = { metric: string; label: string; bad: "high" | "low"; value: number | null; n: number; baseline_days: number; needs_days: number; limits: { mean: number; lower: number; upper: number } | null; status: string; regression: boolean };
type Report = {
  since_ms: number; until_ms: number; turns: number; outcomes: Record<string, number>; total: Stats; dimensions: Dimension[]; savings: Saving[];
  trend: { t_ms: number; turns: number; cost_per_turn: number | null; error_rate: number; cache_read_share: number | null; readers_share: number; run_code_share: number }[];
  regressions: Regression[];
};

const OUTCOME: Record<string, string> = {
  ok: "ended normally", error: "error", refusal: "refused", stopped_by_owner: "stopped by you", stopped_by_parent: "stopped by its parent", cut: "cut by a restart", budget: "step or output budget",
};
const cost = (i: Interval | null) => (!i ? "unknown" : (
  <span className="whitespace-nowrap"><span className="text-fg">{fmtMetric("usd", i.estimate)}</span>{i.method !== "none" && <span className="text-faint"> [{fmtMetric("usd", i.lo)}, {fmtMetric("usd", i.hi)}]</span>}</span>
));
const regValue = (m: string, v: number | null | undefined) => (v === null || v === undefined ? "none" : m === "cost_per_turn" ? fmtMetric("usd", v) : fmtPct(v));

export function ObservabilityPanel() {
  const [range, setRange] = useState<Range>("week");
  const [r, setR] = useState<Report | null>(null);
  const [dim, setDim] = useState("readers");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api<Report>(`/api/features?period=${range}`).then((x) => live && setR(x)).catch(reportError);
    void load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [range]);
  const check = () => {
    setChecking(true);
    api<{ regressions: Regression[] }>("/api/features/check", { method: "POST" }).then((x) => setR((p) => (p ? { ...p, regressions: x.regressions } : p))).catch(reportError).finally(() => setChecking(false));
  };
  if (!r) return <div className="text-ui text-faint">Reading the turns.</div>;
  const t = r.total;
  const d = r.dimensions.find((x) => x.id === dim) ?? r.dimensions[0]!;
  return (
    <div className="flex flex-col gap-4" data-testid="observability-panel">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Range> label="Range" value={range} onChange={setRange} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        <span className="text-caption text-faint">One row per turn, measured on this machine. A turn that ended normally is not proof the work was right: rate replies, or prove a change with an experiment.</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Tile testid="obs-turns" label="Turns" value={t.turns} sub={`${t.sessions} sessions`} />
        <Tile label="Ended normally" value={fmtPct(t.ok_rate)} sub={`${r.outcomes.error ?? 0} errors, ${r.outcomes.refusal ?? 0} refused`} />
        <Tile label="Stopped by you" value={t.stopped_by_owner} sub={`${r.outcomes.cut ?? 0} cut by a restart`} />
        <Tile testid="obs-cost" label="Cost per turn" value={t.cost_per_turn ? fmtMetric("usd", t.cost_per_turn.estimate) : "unknown"} sub={t.cost_per_turn && t.cost_per_turn.method !== "none" ? `95%: ${fmtUsd(t.cost_per_turn.lo)} to ${fmtUsd(t.cost_per_turn.hi)}` : `${t.priced_turns} priced`} />
        <Tile label="Cache read share" value={fmtPct(t.cache_read_share)} sub={`${t.retried_steps} retried steps`} />
        <Tile testid="obs-ratings" label="Replies you rated up" value={t.thumbs_up} sub={`${t.thumbs_down} rated down`} />
      </div>

      <Panel title="Regressions" hint="the last 24 hours against the 14 days before, on a control chart of daily values" testid="obs-regressions"
        aside={<button type="button" onClick={check} disabled={checking} className="h-7 rounded-md border border-line px-2.5 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50" data-testid="obs-check">Check now</button>}>
        <Table head={["Metric", "Last 24 h", "Normal range", "Baseline", "State"]} rows={r.regressions.map((g) => [
          g.label, regValue(g.metric, g.value),
          g.limits ? `${regValue(g.metric, Math.max(0, g.limits.lower))} to ${regValue(g.metric, g.limits.upper)}` : "none yet",
          `${g.baseline_days} of 14 days`,
          <span className={cn(g.regression ? "font-medium text-danger" : g.status === "ok" ? "text-ok" : "text-faint")} data-testid={`reg-${g.metric}`}>
            {g.regression ? `regression (${g.bad === "high" ? "above" : "below"} its range)` : g.status === "baseline too short" ? `needs ${g.needs_days} days of history` : g.status === "high" || g.status === "low" ? `${g.status}, the good side` : g.status}
          </span>,
        ])} />
      </Panel>

      <Panel title="Savings against the counterfactual" hint="where a feature prices what it replaced" testid="obs-savings">
        {!r.savings.length ? <p className="k-empty">No readers job in this range. A readers job prices the working model reading the same material; others are measured by experiments.</p> : (
          <>
            <Table head={["Feature", "Jobs", "Cost", "Counterfactual", "Saved", "Saved per job", "Tokens read"]} rows={r.savings.map((s) => [
              s.feature, `${s.calls}${s.priced < s.calls ? ` (${s.priced} priced)` : ""}`, fmtUsd(s.cost_usd), fmtUsd(s.counterfactual_usd),
              <span className={s.saved_usd >= 0 ? "text-ok" : "text-danger"}>{fmtUsd(Math.abs(s.saved_usd))}{s.saved_usd < 0 ? " more" : ""}</span>, cost(s.saved_per_call),
              `${fmtTokens(s.tokens)} by readers, ${fmtTokens(s.counterfactual_tokens)} would have entered the working context`,
            ])} />
            <p className="mt-2 text-caption text-faint">The counterfactual is {r.savings[0]!.counterfactual}.</p>
          </>
        )}
      </Panel>

      <Panel title="By feature" hint={`${d.note}. Observational: the turns differ in task too; an experiment gives the causal answer.`} testid="obs-features">
        <div className="mb-3">
          <Segmented label="Feature" value={d.id} onChange={setDim} options={r.dimensions.map((x) => ({ value: x.id, label: x.label }))} />
        </div>
        {!d.groups.length ? <p className="k-empty">No turns recorded this.</p> : (
          <Table head={["Value", "Turns", "Sessions", "Ended normally", "Errors", "Cost per turn, 95%", "Cache read", "Median time", "Tool failures", "Ratings"]}
            rows={d.groups.map((g) => [
              <span data-testid="obs-group">{g.value}</span>, g.turns, g.sessions, fmtPct(g.ok_rate), fmtPct(g.error_rate), cost(g.cost_per_turn),
              fmtPct(g.cache_read_share), fmtMs(g.ms_p50), fmtPct(g.tool_error_rate), `${g.thumbs_up} up, ${g.thumbs_down} down`,
            ])} />
        )}
        {d.unrecorded > 0 && <p className="mt-2 text-caption text-faint">{d.unrecorded} turns from before this was recorded are left out.</p>}
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Cost per turn by day" testid="obs-trend-cost">
          <TimeChart label="Cost per turn by day" data={r.trend.map((p) => ({ t: p.t_ms, values: [p.cost_per_turn] }))} series={[{ label: "Cost per turn", color: "var(--series-1)" }]}
            bucket={86_400_000} since={r.until_ms - RANGES[range]} until={r.until_ms} format={(v) => fmtMetric("usd", v)} />
        </Panel>
        <Panel title="Shares of turns by day" testid="obs-trend-share">
          <TimeChart label="Shares of turns by day" data={r.trend.map((p) => ({ t: p.t_ms, values: [p.error_rate, p.readers_share, p.run_code_share] }))}
            series={[{ label: "Errors", color: "var(--series-1)" }, { label: "Used readers", color: "var(--series-2)" }, { label: "Used run_code", color: "var(--series-3)" }]}
            bucket={86_400_000} since={r.until_ms - RANGES[range]} until={r.until_ms} max={1} format={(v) => `${Math.round(v * 100)}%`} />
        </Panel>
      </div>
      <Panel title="How turns ended" testid="obs-outcomes">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-ui">
          {Object.entries(r.outcomes).map(([k, n]) => (
            <span key={k}><span className="font-semibold tabular-nums">{n}</span> <span className="text-muted">{OUTCOME[k] ?? k}</span></span>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export default ObservabilityPanel;
