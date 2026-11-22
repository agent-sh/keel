// What Usage answers about the past across sessions: spend ranked by session
// or by agent tree, the slowest requests of a range, and two turns of one
// session side by side with why one was dearer or slower. The figures are the
// ledger's (src/server/routes/usage.ts, telemetry.ts); the sentences of a
// turn comparison are the daemon's (src/admin/turn-compare.ts).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cacheShare, promptTokens, type SlowRequest, type TurnFacts, type TurnPick } from "../../../src/admin/turn-compare.ts";
import { openTrace, traceOfTurn } from "../lib/observe.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { clock, cn, fmtTokens, when } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Segmented } from "./Settings.tsx";
import { fmtMs, fmtPct, fmtUsd, Panel, RANGES, Table, type Range } from "./UsagePanel.tsx";
import { CLASS } from "./UsageViews.tsx";

function useGet<T>(path: string | null, deps: unknown[]): T | null {
  const [r, setR] = useState<T | null>(null);
  useEffect(() => {
    if (!path) { setR(null); return; }
    let live = true;
    const load = () => api<T>(path).then((x) => live && setR(x)).catch(reportError);
    load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); };
  }, deps);
  return r;
}

const LINK = "min-w-0 truncate rounded-sm text-left text-fg underline decoration-line-strong underline-offset-2 outline-none hover:decoration-fg focus-visible:ring-2 focus-visible:ring-ring";
const open = (id: string) => navigate({ name: "session", id });

// --- spend ranked
type Bucket = { key: string; priced_cost_usd: number; unpriced_calls: number; calls: number; total_tokens: number; own_cost_usd?: number; agents?: number; agents_cost_usd?: number };
type Ranked = { buckets: Bucket[]; has_more: boolean; total: { priced_cost_usd: number; calls: number }; sessions?: Record<string, { title: string; parent_id?: string; archived?: true }> };
const ROWS = 8;
export function SpendRank({ range }: { range: Range }) {
  const [by, setBy] = useState<"session" | "tree">("session");
  const [all, setAll] = useState(false);
  const r = useGet<Ranked>(`/api/usage?group=${by}&sort=cost&limit=200&since_ms=${Date.now() - RANGES[range]}`, [by, range]);
  const spent = r?.total.priced_cost_usd ?? 0;
  const rows = r ? (all ? r.buckets : r.buckets.slice(0, ROWS)) : [];
  const rest = r ? r.buckets.slice(rows.length) : [];
  const name = (b: Bucket) => {
    const s = r!.sessions?.[b.key];
    return (
      <span className="flex min-w-0 items-baseline gap-2">
        {s ? <button type="button" className={LINK} onClick={() => open(b.key)} title="Opens the session" data-testid="rank-open">{s.title || "Untitled"}</button> : <span className="text-faint">a removed session</span>}
        {s?.parent_id && by === "session" && <span className="shrink-0 text-caption text-faint">an agent</span>}
        {s?.archived && <span className="shrink-0 text-caption text-faint">archived</span>}
        {by === "tree" && !!b.agents && <span className="shrink-0 text-caption text-faint" data-testid="rank-agents">{fmtUsd(b.agents_cost_usd ?? 0)} of it in {b.agents} {b.agents === 1 ? "agent" : "agents"}</span>}
      </span>
    );
  };
  return (
    <Panel plain title="By session" hint={by === "tree" ? "a session with the agents under it, dearest first" : "each session's own requests, dearest first"} testid="usage-rank"
      aside={<Segmented<"session" | "tree"> label="Rank by" value={by} onChange={(v) => { setBy(v); setAll(false); }} options={[{ value: "session", label: "Sessions" }, { value: "tree", label: "Agent trees" }]} />}>
      {!r ? <p className="text-ui text-faint">Reading the ledger.</p> : !r.buckets.length ? <p className="k-empty">No requests in this range.</p> : (
        <>
          <Table head={["Session", "Spend", "Share", "Tokens", "Requests"]} wide={[3, 4]}
            rows={rows.map((b) => [
              name(b),
              <span data-testid="rank-cost">{b.unpriced_calls ? `${fmtUsd(b.priced_cost_usd)}+` : fmtUsd(b.priced_cost_usd)}</span>,
              spent > 0 ? (
                <span className="inline-flex items-center justify-end gap-2">
                  <span className="h-1.5 w-14 overflow-hidden rounded-full bg-sunken max-sm:hidden" aria-hidden><span className="block h-full rounded-full bg-series-1" style={{ width: `${Math.min(100, (100 * b.priced_cost_usd) / spent)}%` }} /></span>
                  <span className="w-9 text-right">{Math.round((100 * b.priced_cost_usd) / spent)}%</span>
                </span>
              ) : <span className="text-faint">none</span>,
              fmtTokens(b.total_tokens), b.calls,
            ])} />
          {rest.length > 0 && (
            <button type="button" className="mt-2 rounded-sm text-caption text-muted underline decoration-line-strong underline-offset-2 hover:text-fg" onClick={() => setAll(true)} data-testid="rank-more">
              {rest.length}{r.has_more ? " or more" : ""} more: {fmtUsd(rest.reduce((n, b) => n + b.priced_cost_usd, 0))} in all
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

// --- the slowest requests of the range, across sessions
export function SlowestRequests({ range }: { range: Range }) {
  const r = useGet<{ requests: SlowRequest[] }>(`/api/telemetry/slowest?limit=12&since_ms=${Date.now() - RANGES[range]}`, [range]);
  const models = useStore((s) => s.models);
  const model = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);
  return (
    <Panel plain title="Slowest requests" hint="across sessions, in this range; a row opens the trace of its turn" testid="usage-slowest">
      {!r ? <p className="text-ui text-faint">Reading the ledger.</p> : !r.requests.length ? <p className="k-empty">No timed request in this range.</p> : (
        <Table head={["Took", "First word", "When", "Session", "Model", "Ended"]} align={["r", "r", "l", "l", "l", "l"]}
          onRow={(i) => { const q = r.requests[i]!; if (q.turn_event) openTrace(q.session_id, traceOfTurn(q.turn_event)); else open(q.session_id); }}
          rows={r.requests.map((q) => [
            <span className="text-fg" data-testid="slow-took">{fmtMs(q.latency_ms)}</span>, fmtMs(q.ttft_ms),
            <span title={when(q.ts)}>{clock(q.ts, { date: true, seconds: true })}</span>,
            <span className="block max-w-64 truncate" data-testid="slow-session">{q.title ?? "a removed session"}</span>,
            <span title={q.model}>{model(q.model)}</span>,
            q.outcome === "ok" ? (q.purpose === "turn" ? "answered" : `answered (${q.purpose})`) : <span className="text-danger">{q.error_class ? CLASS[q.error_class] ?? q.error_class : q.outcome}</span>,
          ])} />
      )}
    </Panel>
  );
}

// --- two turns of one session
const pick = (t: TurnPick) => `Turn ${t.n}, ${clock(t.ts, { date: true, seconds: true })}, ${t.cost == null ? (t.requests ? "no price" : "$0") : fmtUsd(t.cost)}, ${fmtMs(t.ms)}${t.prompt ? `: ${t.prompt.replace(/\s+/g, " ").slice(0, 40)}` : ""}`;
type Pair = { a: TurnFacts; b: TurnFacts; diff: { cost: string; time: string; also: string[] } };
const SELECT = "h-8 min-w-0 max-w-full rounded-md border border-line-strong bg-raised px-2 text-ui text-fg";
export function TurnsCompare({ table }: { table: (heads: string[], rows: [string, ReactNode, ReactNode, ReactNode][]) => ReactNode }) {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).sort((a, b) => b.updated - a.updated).slice(0, 200), [sessions]);
  const [sid, setSid] = useState("");
  const session = sid || list[0]?.id || "";
  const turns = useGet<{ turns: TurnPick[] }>(session ? `/api/telemetry/turns?session_id=${session}` : null, [session])?.turns;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  // The newest turn against the one before it, until the owner picks.
  const ta = turns?.find((t) => t.turn_event === a) ?? turns?.[0];
  const tb = turns?.find((t) => t.turn_event === b) ?? turns?.[1];
  const r = useGet<Pair>(ta && tb ? `/api/telemetry/turns?session_id=${session}&a=${ta.turn_event}&b=${tb.turn_event}` : null, [session, ta?.turn_event, tb?.turn_event]);
  const turnSelect = (label: string, v: TurnPick | undefined, set: (id: string) => void) => (
    <Select aria-label={label} data-testid={`compare-${label}`} value={v?.turn_event ?? ""} onChange={(e) => set(e.target.value)} className={cn(SELECT, "w-[min(27rem,100%)]")}>
      {(turns ?? []).map((t) => <option key={t.turn_event} value={t.turn_event}>{pick(t)}</option>)}
    </Select>
  );
  // Counts and times differ by how much, in the unit of the row; lower is better for cost and time.
  const delta = (x: number | null, y: number | null, fmt: (v: number) => string, lowerBetter: boolean | null = true) => {
    if (x == null || y == null) return <span className="text-faint">none</span>;
    if (x === y) return <span className="text-faint">same</span>;
    const up = x > y;
    return <span className={cn(lowerBetter === null ? "" : up === lowerBetter ? "text-danger" : "text-ok")}>{up ? "+" : "-"}{fmt(Math.abs(x - y))}</span>;
  };
  const rows = (p: Pair): [string, ReactNode, ReactNode, ReactNode][] => {
    const { a: x, b: y } = p;
    const n = (v: number) => v.toLocaleString();
    const money = (v: number | null) => (v == null ? "no price" : fmtUsd(v));
    const zone = (k: "tools" | "system" | "history" | "tail", label: string): [string, ReactNode, ReactNode, ReactNode] =>
      [label, x.zones ? n(x.zones[k]) : "not measured", y.zones ? n(y.zones[k]) : "not measured", delta(x.zones?.[k] ?? null, y.zones?.[k] ?? null, n)];
    return [
      ["Cost", money(x.cost), money(y.cost), delta(x.cost, y.cost, fmtUsd)],
      ["Took", fmtMs(x.ms), fmtMs(y.ms), delta(x.ms, y.ms, (v) => fmtMs(v))],
      ["In model requests", fmtMs(x.request_ms), fmtMs(y.request_ms), delta(x.request_ms, y.request_ms, (v) => fmtMs(v))],
      ["In tools", fmtMs(x.tool_ms), fmtMs(y.tool_ms), delta(x.tool_ms, y.tool_ms, (v) => fmtMs(v))],
      ["Waiting", fmtMs(x.wait_ms), fmtMs(y.wait_ms), delta(x.wait_ms, y.wait_ms, (v) => fmtMs(v))],
      ["Requests", `${x.requests}${x.failed_attempts ? `, ${x.failed_attempts} failed` : ""}`, `${y.requests}${y.failed_attempts ? `, ${y.failed_attempts} failed` : ""}`, delta(x.requests, y.requests, n)],
      ["Prompt tokens sent", n(promptTokens(x)), n(promptTokens(y)), delta(promptTokens(x), promptTokens(y), n)],
      zone("history", "History"), zone("tail", "New messages"), zone("system", "System prompt"), zone("tools", "Tool schemas"),
      ["Read from cache", fmtPct(cacheShare(x)), fmtPct(cacheShare(y)), delta(cacheShare(x), cacheShare(y), (v) => `${Math.round(v * 100)} pts`, false)],
      ["Written to cache", n(x.cache_write), n(y.cache_write), delta(x.cache_write, y.cache_write, n)],
      ["Output tokens", n(x.output), n(y.output), delta(x.output, y.output, n)],
      ["Tool calls", `${x.tool_calls}${x.tool_errors ? `, ${x.tool_errors} failed` : ""}`, `${y.tool_calls}${y.tool_errors ? `, ${y.tool_errors} failed` : ""}`, delta(x.tool_calls, y.tool_calls, n, null)],
    ];
  };
  return (
    <>
      <div className="flex flex-col gap-2" data-testid="compare-turns">
        <label className="flex flex-wrap items-center gap-2 text-ui text-muted">
          In
          <Select aria-label="session" data-testid="compare-session" value={session} onChange={(e) => { setSid(e.target.value); setA(""); setB(""); }} className={cn(SELECT, "w-[min(24rem,100%)]")}>
            {list.map((s) => <option key={s.id} value={s.id}>{s.title || "Untitled"}</option>)}
          </Select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {turnSelect("turn-a", ta, setA)}<span className="text-ui text-muted">against</span>{turnSelect("turn-b", tb, setB)}
        </div>
      </div>
      <Panel title="Two turns" hint="the first turn against the second; what changed between them" testid="compare-table">
        {!turns ? <p className="text-ui text-faint">Reading the session's turns.</p>
          : turns.length < 2 ? <p className="k-empty">{turns.length ? "This session has one turn: there is nothing to set it against yet." : "This session has no finished turn yet."}</p>
          : !r ? <p className="text-ui text-faint">Reading the two turns.</p> : (
            <>
              <div className="mb-3 flex max-w-[52rem] flex-col gap-1.5 text-ui leading-relaxed text-fg" data-testid="compare-why">
                <p>{r.diff.cost}</p>
                <p>{r.diff.time}</p>
                {r.diff.also.length > 0 && <p className="text-muted">{r.diff.also.join(" ")}</p>}
              </div>
              {table([`Turn ${r.a.n}`, `Turn ${r.b.n}`], rows(r))}
            </>
          )}
      </Panel>
    </>
  );
}
