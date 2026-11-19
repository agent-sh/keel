// Settings > Usage: what the model calls cost and how they behaved, measured
// on this machine. Spend and tokens come from the usage report (prices from
// the listings; an unknown price stays unknown), timings, cache and error
// rates from the local telemetry.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { ago, cn, fmtTokens, when } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { Segmented } from "./Settings.tsx";
import { CompactionsView, CompareView, ErrorsView, TokensView } from "./UsageViews.tsx";

type Stats = {
  calls: number; errors: number; interrupted: number; error_rate: number;
  latency_p50: number | null; latency_p95: number | null; ttft_p50: number | null; ttft_p95: number | null;
  output_tokens_per_s: number | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  cache_hit_ratio: number | null; priced_cost_usd: number; unpriced_calls: number; cost_usd: number | null;
  tool_calls: number; tool_errors: number; tool_error_rate: number;
};
type Report = {
  since_ms: number; until_ms: number; bucket_ms: number; total: Stats;
  series: (Stats & { t_ms: number })[];
  by_model: (Stats & { model: string })[];
  tools: { tool: string; tool_calls: number; tool_errors: number; tool_error_rate: number; p50_ms: number | null; p95_ms: number | null; total_ms: number }[];
  error_kinds: { message: string; count: number; last_ms: number }[];
  breaks: { cause: string; count: number; last_ms: number | null; uncached_tokens: number }[];
  spend: { day: Spend; month: Spend };
};
type Spend = { since_ms: number; usd: number; unpriced_calls: number; limit_usd: number | null };
type Example = { session_id: string; ts: number; tool: string; ms: number | null; error: string | null; session_title?: string; session_gone: boolean; event_id?: string };

export const CAUSE: Record<string, string> = {
  expired: "the cache lifetime passed",
  model_switch: "the model changed",
  compaction: "a compaction rewrote the history",
  prefix_changed: "the prompt prefix changed",
};

// The last failures of one tool, each linked to its session at the call.
// Inside a report, `since`/`until` are its interval and `count` its failure
// count: the examples are the ones it counted, and load again with each report.
export function Failures({ tool, session, since, until, count }: { tool?: string; session?: string; since?: number; until?: number; count?: number }) {
  const [list, setList] = useState<Example[] | null>(null);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({
      limit: "8", ...(tool ? { tool } : {}), ...(session ? { session_id: session } : {}),
      ...(since !== undefined ? { since_ms: String(since) } : {}), ...(until !== undefined ? { until_ms: String(until) } : {}),
    });
    api<{ examples: Example[] }>(`/api/telemetry/examples?${q}`).then((r) => live && setList(r.examples)).catch(reportError);
    return () => { live = false; };
  }, [tool, session, since, until, count]);
  if (!list) return null;
  if (!list.length) return <p className="py-2 text-caption text-faint">No failed calls.</p>;
  return (
    <div className="flex flex-col" data-testid="tool-failures">
      {list.map((e, i) => (
        <div key={i} className="flex items-baseline gap-3 py-1 text-caption">
          <span className="w-12 shrink-0 tabular-nums text-faint" title={when(e.ts)}>{ago(e.ts)}</span>
          {!tool && <span className="shrink-0 font-mono text-muted">{e.tool}</span>}
          <span className="min-w-0 flex-1 truncate font-mono text-muted" title={e.error ?? ""}>{e.error || "failed"}</span>
          {!session && (e.session_gone ? <span className="shrink-0 text-faint">deleted session</span> : (
            <button type="button" className="max-w-48 shrink-0 truncate text-accent hover:underline" onClick={() => { if (e.event_id) setUI({ focusEvent: e.event_id }); navigate({ name: "session", id: e.session_id }); }}>
              {e.session_title || "the session"}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function MoneyField({ value, onSave, label, testid }: { value: number | null; onSave: (v: number | null) => Promise<unknown>; label: string; testid?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const save = () => {
    const t = text.trim().replace(/^\$/, "");
    const v = t === "" ? null : Number(t);
    if (v !== null && !(v > 0)) return setBad(true);
    setBad(false);
    if (v !== value) onSave(v).catch((e) => { setBad(true); reportError(e); });
  };
  return (
    <label className={cn("flex h-8 items-center gap-1 rounded-md border bg-raised px-2.5 text-ui", bad ? "border-danger" : "border-line-strong")}>
      <span className="text-muted">$</span>
      <input aria-label={label} data-testid={testid} inputMode="decimal" value={text} placeholder="None" onChange={(e) => setText(e.target.value)} onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} className="w-16 bg-transparent text-right tabular-nums outline-none placeholder:text-faint" />
    </label>
  );
}

export const RANGES = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;

export const fmtMs = (v: number | null | undefined) => (v == null ? "none" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`);
export const fmtPct = (v: number | null | undefined) => (v == null ? "none" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
export const fmtUsd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

export function Tile({ label, value, sub, tone, testid }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger"; testid?: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised px-4 py-3 shadow-1" data-testid={testid}>
      <div className="text-caption text-muted">{label}</div>
      <div className={cn("mt-1 text-title font-semibold tabular-nums tracking-[-0.01em]", tone === "danger" && "text-danger")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-caption text-faint">{sub}</div>}
    </div>
  );
}

export function Panel({ title, hint, children, testid }: { title: string; hint?: string; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid={testid}>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="shrink-0 text-base font-medium">{title}</h3>
        {hint && <span className="text-caption text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Table({ head, rows, align, onRow, expanded }: { head: string[]; rows: ReactNode[][]; align?: ("l" | "r")[]; onRow?: (i: number) => void; expanded?: (i: number) => ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full text-ui">
        <thead>
          <tr className="border-b border-line text-caption text-faint">
            {head.map((h, i) => <th key={h} className={cn("px-4 py-1.5 font-normal", (align?.[i] ?? (i ? "r" : "l")) === "r" ? "text-right" : "text-left")}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const more = expanded?.(i);
            return [
              <tr key={i} className={cn("border-b border-line/60 last:border-0", onRow && "cursor-default hover:bg-hover")} onClick={() => onRow?.(i)}>
                {r.map((c, j) => <td key={j} className={cn("px-4 py-1.5 tabular-nums", (align?.[j] ?? (j ? "r" : "l")) === "r" ? "whitespace-nowrap text-right text-muted" : "max-w-64 truncate text-left")}>{c}</td>)}
              </tr>,
              more ? <tr key={`${i}-more`} className="border-b border-line/60"><td colSpan={r.length} className="bg-sunken/50 px-4 py-2">{more}</td></tr> : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

type View = "overview" | "tokens" | "errors" | "compactions" | "compare";

// The sections of Settings > Usage: the overview, then one view per question.
export function UsagePanel() {
  const [view, setView] = useState<View>("overview");
  const [range, setRange] = useState<Range>("week");
  return (
    <div className="flex flex-col gap-4" data-testid="usage-panel">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<View> label="View" value={view} onChange={setView} options={[
          { value: "overview", label: "Overview" }, { value: "tokens", label: "Token zones" }, { value: "errors", label: "Errors" },
          { value: "compactions", label: "Compactions" }, { value: "compare", label: "Compare" },
        ]} />
        {view !== "compare" && <Segmented<Range> label="Range" value={range} onChange={setRange} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />}
        <span className="text-caption text-faint">Measured on this machine. Nothing is sent anywhere.</span>
      </div>
      {view === "overview" ? <Overview range={range} /> : view === "tokens" ? <TokensView range={range} /> : view === "errors" ? <ErrorsView range={range} />
        : view === "compactions" ? <CompactionsView range={range} /> : <CompareView />}
    </div>
  );
}

function Overview({ range }: { range: Range }) {
  const [r, setR] = useState<Report | null>(null);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [budget, setBudget] = useState<{ daily_usd: number | null; monthly_usd: number | null } | null>(null);
  useEffect(() => { api<{ settings: any }>("/api/settings").then((x) => setBudget(x.settings.budget)).catch(reportError); }, []);
  // Each limit takes only its own answer, and only the answer to its latest
  // save: an older reply arriving last does not put back the other field.
  const budgetSeq = useRef<Record<string, number>>({});
  const saveBudget = (key: "daily_usd" | "monthly_usd", v: number | null) => {
    const n = (budgetSeq.current[key] = (budgetSeq.current[key] ?? 0) + 1);
    return api<{ settings: any }>("/api/settings", { method: "PATCH", body: JSON.stringify({ budget: { [key]: v } }) })
      .then((x) => { if (budgetSeq.current[key] === n) setBudget((b) => (b ? { ...b, [key]: x.settings.budget[key] } : x.settings.budget)); });
  };
  const [cost, setCost] = useState<Record<string, { cost_usd?: number; priced_cost_usd: number; unpriced_calls: number }> | null>(null);
  const [costFailed, setCostFailed] = useState<number | null>(null);
  const models = useStore((s) => s.models);
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);

  // Telemetry and prices load on their own: a failed price lookup leaves fresh
  // measurements in place and marks only the Spend cells. Each source keeps the
  // answer of its latest poll; an older one landing late is dropped.
  useEffect(() => {
    let live = true;
    let sent = 0;
    const got = { t: 0, u: 0 };
    const load = () => {
      const n = ++sent;
      const since = Date.now() - RANGES[range];
      api<Report>(`/api/telemetry?since_ms=${since}`)
        .then((t) => { if (live && n > got.t) { got.t = n; setR(t); } })
        .catch(reportError);
      api<any>(`/api/usage?group=model&since_ms=${since}`)
        .then((u) => { if (live && n > got.u) { got.u = n; setCost(Object.fromEntries(u.buckets.map((b: any) => [b.key, b]))); setCostFailed(null); } })
        .catch((e) => { if (live && n > got.u) setCostFailed(Date.now()); reportError(e); });
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); };
  }, [range]);

  const series = useMemo(() => r?.series ?? [], [r]);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  const t = r.total;
  const costShown = t.unpriced_calls ? (t.priced_cost_usd ? `${fmtUsd(t.priced_cost_usd)}+` : "unknown") : fmtUsd(t.priced_cost_usd);
  const prompt = t.input_tokens + t.cache_read_tokens + t.cache_write_tokens;

  return (
    <div className="flex flex-col gap-4" data-testid="usage-overview">

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile testid="tile-spend" label="Spend" value={costShown} sub={t.unpriced_calls ? `${t.unpriced_calls} calls have no known price` : `${t.calls} model calls`} />
        <Tile label="Tokens" value={fmtTokens(prompt + t.output_tokens)} sub={`${fmtTokens(prompt)} in, ${fmtTokens(t.output_tokens)} out`} />
        <Tile testid="tile-cache" label="Cache hit rate" value={fmtPct(t.cache_hit_ratio)} sub={`${fmtTokens(t.cache_read_tokens)} read from cache`} />
        <Tile testid="tile-ttft" label="First token, median" value={fmtMs(t.ttft_p50)} sub={`95th percentile ${fmtMs(t.ttft_p95)}`} />
        <Tile label="Request time, median" value={fmtMs(t.latency_p50)} sub={t.output_tokens_per_s ? `${Math.round(t.output_tokens_per_s)} tokens/s while streaming` : `95th percentile ${fmtMs(t.latency_p95)}`} />
        <Tile
          testid="tile-errors"
          label="Failed requests"
          value={fmtPct(t.error_rate)}
          tone={t.error_rate >= 0.05 ? "danger" : undefined}
          sub={`${t.errors} requests, ${t.tool_errors} of ${t.tool_calls} tool calls`}
        />
      </div>

      <Panel title="Cache hit rate" hint="share of the prompt read from the provider's cache" testid="chart-cache">
        <TimeChart
          label="Cache hit rate over time"
          data={series.map((p) => ({ t: p.t_ms, values: [p.cache_hit_ratio] }))}
          series={[{ label: "Cache hit rate", color: "var(--series-1)" }]}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} max={1} format={(v) => `${Math.round(v * 100)}%`}
        />
        <div className="mt-3 border-t border-line pt-3 text-caption text-muted" data-testid="cache-breaks">
          {r.breaks.length === 0 ? "No request in this range read less from the cache than the one before it." : (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {r.breaks.map((b) => (
                <span key={b.cause}>
                  <span className="font-medium tabular-nums text-fg">{b.count}</span> {b.count > 1 ? "breaks" : "break"}: {CAUSE[b.cause] ?? b.cause}
                  <span className="text-faint">, {fmtTokens(b.uncached_tokens)} tokens sent again</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Response time" hint="median per bucket" testid="chart-latency">
        <TimeChart
          label="Time to first token and request time over time"
          data={series.map((p) => ({ t: p.t_ms, values: [p.ttft_p50, p.latency_p50] }))}
          series={[{ label: "First token", color: "var(--series-1)" }, { label: "Whole request", color: "var(--series-2)" }]}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={fmtMs}
        />
      </Panel>

      <Panel title="Tokens" hint="per bucket" testid="chart-tokens">
        <TimeChart
          kind="bars"
          label="Tokens over time"
          data={series.map((p) => ({ t: p.t_ms, values: [p.cache_read_tokens, p.input_tokens + p.cache_write_tokens, p.output_tokens] }))}
          series={[{ label: "Read from cache", color: "var(--series-1)" }, { label: "New input", color: "var(--series-2)" }, { label: "Output", color: "var(--series-3)" }]}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={fmtTokens}
        />
      </Panel>

      <Panel title="By model" hint={costFailed && cost ? `spend as of the last price lookup; it failed ${ago(costFailed)} ago` : undefined} testid="usage-models">
        {r.by_model.length ? (
          <Table
            head={["Model", "Calls", "Cache hit", "First token", "Tokens/s", "Failed", "Spend"]}
            rows={r.by_model.map((m) => {
              const c = cost?.[m.model];
              return [
                <span title={m.model}>{name(m.model)}</span>, m.calls, fmtPct(m.cache_hit_ratio), fmtMs(m.ttft_p50),
                m.output_tokens_per_s ? Math.round(m.output_tokens_per_s) : "none", m.errors ? <span className="text-danger">{m.errors}</span> : 0,
                !cost ? (costFailed ? <span className="text-faint" title="the price lookup failed">unavailable</span> : "") : c ? (c.unpriced_calls ? (c.priced_cost_usd ? `${fmtUsd(c.priced_cost_usd)}+` : "unknown") : fmtUsd(c.priced_cost_usd)) : "none",
              ];
            })}
          />
        ) : <p className="text-ui text-faint">No model calls in this range.</p>}
      </Panel>

      <Panel title="Tools" hint="calls that ran, after any approval" testid="usage-tools">
        {r.tools.length ? (
          <Table
            head={["Tool", "Calls", "Failed", "Median", "95th", "Total time"]}
            onRow={(i) => r.tools[i]!.tool_errors ? setOpenTool(openTool === r.tools[i]!.tool ? null : r.tools[i]!.tool) : undefined}
            expanded={(i) => (openTool === r.tools[i]!.tool ? <Failures tool={openTool} since={r.since_ms} until={r.until_ms} count={r.tools[i]!.tool_errors} /> : null)}
            rows={r.tools.map((x) => [
              <span className="font-mono text-caption">{x.tool}</span>, x.tool_calls,
              x.tool_errors ? <span className={x.tool_error_rate >= 0.15 ? "text-danger" : undefined}>{fmtPct(x.tool_error_rate)}</span> : "0%",
              fmtMs(x.p50_ms), fmtMs(x.p95_ms), fmtMs(x.total_ms),
            ])}
          />
        ) : <p className="text-ui text-faint">No tool calls in this range.</p>}
      </Panel>

      {budget && (
        <Panel title="Spend limits" hint="a turn stops before a request once the limit is reached; calls without a known price are not counted" testid="usage-budget">
          <div className="flex flex-col gap-3 sm:flex-row sm:gap-8">
            {([["daily_usd", "Today", r.spend.day], ["monthly_usd", "This month", r.spend.month]] as const).map(([key, label, sp]) => (
              <div key={key} className="flex flex-1 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-ui font-medium">{label}</div>
                  <div className="text-caption text-muted tabular-nums">
                    {fmtUsd(sp.usd)} spent{sp.limit_usd ? ` of ${fmtUsd(sp.limit_usd)}` : ""}{sp.unpriced_calls ? `, ${sp.unpriced_calls} calls without a price` : ""}
                  </div>
                  {sp.limit_usd ? (
                    <div className="mt-1.5 h-1.5 rounded-full bg-sunken">
                      <div className={cn("h-1.5 rounded-full", sp.usd >= sp.limit_usd ? "bg-danger" : "bg-series-1")} style={{ width: `${Math.min(100, (sp.usd / sp.limit_usd) * 100)}%` }} />
                    </div>
                  ) : null}
                </div>
                <MoneyField label={`${label} limit`} testid={`budget-${key}`} value={budget[key]} onSave={(v) => saveBudget(key, v)} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {r.error_kinds.length > 0 && (
        <Panel title="Why requests failed" testid="usage-failures">
          <Table head={["Error", "Times"]} rows={r.error_kinds.map((e) => [<span title={e.message}>{e.message}</span>, e.count])} />
        </Panel>
      )}
    </div>
  );
}
