// Settings > Usage: what the model calls cost and how they behaved, measured
// on this machine. Spend and tokens come from the usage report (prices from
// the listings; an unknown price stays unknown), timings, cache and error
// rates from the local telemetry.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, reportError, useStore } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { Card, Segmented } from "./Settings.tsx";

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
};

const RANGES = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
type Range = keyof typeof RANGES;

export const fmtMs = (v: number | null | undefined) => (v == null ? "none" : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`);
const fmtPct = (v: number | null | undefined) => (v == null ? "none" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
export const fmtUsd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

function Tile({ label, value, sub, tone, testid }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger"; testid?: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised px-4 py-3 shadow-1" data-testid={testid}>
      <div className="text-caption text-muted">{label}</div>
      <div className={cn("mt-1 text-title font-semibold tabular-nums tracking-[-0.01em]", tone === "danger" && "text-danger")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-caption text-faint">{sub}</div>}
    </div>
  );
}

function Panel({ title, hint, children, testid }: { title: string; hint?: string; children: ReactNode; testid?: string }) {
  return (
    <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid={testid}>
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        {hint && <span className="text-caption text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, rows, align }: { head: string[]; rows: ReactNode[][]; align?: ("l" | "r")[] }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full text-ui">
        <thead>
          <tr className="border-b border-line text-caption text-faint">
            {head.map((h, i) => <th key={h} className={cn("px-4 py-1.5 font-normal", (align?.[i] ?? (i ? "r" : "l")) === "r" ? "text-right" : "text-left")}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {r.map((c, j) => <td key={j} className={cn("px-4 py-1.5 tabular-nums", (align?.[j] ?? (j ? "r" : "l")) === "r" ? "text-right text-muted" : "max-w-64 truncate text-left")}>{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsagePanel() {
  const [range, setRange] = useState<Range>("week");
  const [r, setR] = useState<Report | null>(null);
  const [cost, setCost] = useState<Record<string, { cost_usd?: number; priced_cost_usd: number; unpriced_calls: number }>>({});
  const models = useStore((s) => s.models);
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);

  useEffect(() => {
    let live = true;
    const load = () => {
      const since = Date.now() - RANGES[range];
      Promise.all([api<Report>(`/api/telemetry?since_ms=${since}`), api<any>(`/api/usage?group=model&since_ms=${since}`)])
        .then(([t, u]) => {
          if (!live) return;
          setR(t);
          setCost(Object.fromEntries(u.buckets.map((b: any) => [b.key, b])));
        })
        .catch(reportError);
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
    <div className="flex flex-col gap-4" data-testid="usage-panel">
      <div className="flex items-center gap-3">
        <Segmented<Range> label="Range" value={range} onChange={setRange} options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }]} />
        <span className="text-caption text-faint">Measured on this machine. Nothing is sent anywhere.</span>
      </div>

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

      <Panel title="By model" testid="usage-models">
        {r.by_model.length ? (
          <Table
            head={["Model", "Calls", "Cache hit", "First token", "Tokens/s", "Failed", "Spend"]}
            rows={r.by_model.map((m) => {
              const c = cost[m.model];
              return [
                <span title={m.model}>{name(m.model)}</span>, m.calls, fmtPct(m.cache_hit_ratio), fmtMs(m.ttft_p50),
                m.output_tokens_per_s ? Math.round(m.output_tokens_per_s) : "none", m.errors ? <span className="text-danger">{m.errors}</span> : 0,
                c ? (c.unpriced_calls ? "unknown" : fmtUsd(c.priced_cost_usd)) : "none",
              ];
            })}
          />
        ) : <p className="text-ui text-faint">No model calls in this range.</p>}
      </Panel>

      <Panel title="Tools" hint="calls that ran, after any approval" testid="usage-tools">
        {r.tools.length ? (
          <Table
            head={["Tool", "Calls", "Failed", "Median", "95th", "Total time"]}
            rows={r.tools.map((x) => [
              <span className="font-mono text-caption">{x.tool}</span>, x.tool_calls,
              x.tool_errors ? <span className={x.tool_error_rate >= 0.15 ? "text-danger" : undefined}>{fmtPct(x.tool_error_rate)}</span> : "0%",
              fmtMs(x.p50_ms), fmtMs(x.p95_ms), fmtMs(x.total_ms),
            ])}
          />
        ) : <p className="text-ui text-faint">No tool calls in this range.</p>}
      </Panel>

      {r.error_kinds.length > 0 && (
        <Panel title="Why requests failed" testid="usage-failures">
          <Table head={["Error", "Times"]} rows={r.error_kinds.map((e) => [<span title={e.message}>{e.message}</span>, e.count])} />
        </Panel>
      )}
    </div>
  );
}
