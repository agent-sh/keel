// Settings > Usage: what the model calls cost and how they behaved, measured
// on this machine. The overview answers first: what was spent, and where the
// tokens went (by what they were, then by model and purpose). How the calls
// behaved over time comes after. Spend and tokens come from the usage report
// (prices from the listings; an unknown price stays unknown), timings, cache
// and error rates from the local telemetry.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Group, Help } from "./settings/kit.tsx";
import { composing } from "../lib/keys.ts";
import { api, reportError, useStore, useModels } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { ago, clock, cn, fmtTokens, when } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { MemoryUsage, type MemoryTab } from "./MemoryUsage.tsx";
import { Seg } from "./Seg.tsx";
import { SlowestRequests, SpendRank } from "./UsagePast.tsx";
import { CostDrivers } from "./CostDrivers.tsx";
import { ReviewYield } from "./ReviewYield.tsx";
import { Segmented } from "./Settings.tsx";
import { PART, Split, Stat, Stats } from "./Stat.tsx";
import { KINDS, KIND_LABEL, addCosts, bucketName, kindCosts, noCosts, spendDrivers, type Costs } from "../lib/spend.ts";
import { SettingTrials } from "./SettingTrials.tsx";
import { CompactionsView, CompareView, ErrorsView, TokensView } from "./UsageViews.tsx";

type Stats = {
  calls: number; errors: number; interrupted: number; error_rate: number; failed: number; failed_share: number;
  latency_p50: number | null; latency_p95: number | null; ttft_p50: number | null; ttft_p95: number | null;
  output_tokens_per_s: number | null; speed_sample: { calls: number; output_tokens: number }; first_text_p50: number | null;
  step_latency_p50: number | null; step_latency_p95: number | null; retried_steps: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  cache_hit_ratio: number | null; priced_cost_usd: number; unpriced_calls: number; cost_usd: number | null;
  tool_calls: number; tool_errors: number; tool_error_rate: number;
};
// `as_of_ms`: when the daemon read its ledger for these numbers; `refreshing`: it is reading it again now.
type Report = {
  as_of_ms?: number; refreshing?: boolean;
  since_ms: number; until_ms: number; bucket_ms: number; total: Stats;
  series: (Stats & { t_ms: number; last_ms?: number })[];
  by_model: (Stats & { model: string })[];
  tools: { tool: string; tool_calls: number; tool_errors: number; tool_error_rate: number; p50_ms: number | null; p95_ms: number | null; timed: number; total_ms: number | null }[];
  error_kinds: { message: string; count: number; last_ms: number }[];
  breaks: { cause: string; count: number; last_ms: number | null; uncached_tokens: number; details?: { detail: string; count: number }[] }[];
  spend: { day: Spend; month: Spend };
};
type Spend = { since_ms: number; usd: number; unpriced_calls: number; limit_usd: number | null };
type Example = { session_id: string; ts: number; tool: string; ms: number | null; error: string | null; session_title?: string; session_gone: boolean; event_id?: string };

export const CAUSE: Record<string, string> = {
  expired: "the cache lifetime passed",
  warm_missed: "the warm requests sent during a wait did not keep the cache",
  model_switch: "the model changed",
  compaction: "a compaction rewrote the history",
  branch_switch: "the session showed another branch",
  prefix_changed: "the prompt prefix changed",
  provider_miss: "the provider's cache missed an unchanged prefix",
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
  if (!list.length) return <p className="k-empty py-2">No failed calls.</p>;
  return (
    <div className="flex flex-col" data-testid="tool-failures">
      {list.map((e, i) => (
        <div key={i} className="flex items-baseline gap-3 py-1 text-caption">
          <span className="w-12 shrink-0 tabular-nums text-faint" title={when(e.ts)}>{ago(e.ts)}</span>
          {!tool && <span className="shrink-0 font-mono text-muted">{e.tool}</span>}
          <span className="min-w-0 flex-1 truncate font-mono text-muted" title={e.error ?? ""}>{e.error || "failed"}</span>
          {!session && (e.session_gone ? <span className="shrink-0 text-faint">deleted session</span> : (
            <button type="button" className="k-link max-w-48 shrink-0 truncate text-accent hover:underline" onClick={() => { if (e.event_id) setUI({ focusEvent: e.event_id }); navigate({ name: "session", id: e.session_id }); }}>
              {e.session_title || "the session"}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function MoneyField({ value, onSave, label, testid, hours }: { value: number | null; onSave: (v: number | null) => Promise<unknown>; label: string; testid?: string; hours?: boolean }) {
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
      {hours ? null : <span className="text-muted">$</span>}
      <input aria-label={label} data-testid={testid} inputMode="decimal" value={text} placeholder="None" onChange={(e) => setText(e.target.value)} onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && !composing(e) && (e.currentTarget as HTMLInputElement).blur()} className="w-16 bg-transparent text-right tabular-nums outline-none placeholder:text-faint" />
      {hours ? <span className="text-muted">hours</span> : null}
    </label>
  );
}

// The daemon's spend cap over a rolling window (src/automation/window-cap.ts): off until both numbers are set.
type WindowRead = { cap: { usd: number; hours: number } | null; spent: number; level: "off" | "ok" | "warn" | "spent"; pct: number; rolls_at: number | null };
function SpendWindow() {
  const [set, setSet] = useState<{ usd: number | null; hours: number | null } | null>(null);
  const [now, setNow] = useState<WindowRead | null>(null);
  const read = () => api<WindowRead>("/api/spend-window").then(setNow).catch(reportError);
  useEffect(() => {
    api<{ settings: any }>("/api/settings").then((x) => setSet(x.settings.spend_window)).catch(reportError);
    read();
    const iv = setInterval(read, 15_000);
    return () => clearInterval(iv);
  }, []);
  const save = (key: "usd" | "hours", v: number | null) =>
    api<{ settings: any }>("/api/settings", { method: "PATCH", body: JSON.stringify({ spend_window: { [key]: v } }) }).then((x) => { setSet(x.settings.spend_window); read(); });
  if (!set) return null;
  const half = (set.usd === null) !== (set.hours === null);
  const hold = now?.level === "spent";
  return (
    <Panel plain title="Spend window" hint="one cap for the whole daemon over the last N hours: loops, wakes, monitors and agents wait at it, your own messages run" testid="usage-window">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 text-ui text-muted">
        <label className="flex items-center gap-2.5">Spend at most
          <MoneyField label="Spend window: dollars" testid="window-usd" value={set.usd} onSave={(v) => save("usd", v)} />
        </label>
        <label className="flex items-center gap-2.5">over
          <MoneyField hours label="Spend window: hours" testid="window-hours" value={set.hours} onSave={(v) => save("hours", v)} />
        </label>
      </div>
      <p className="mt-2.5 text-caption text-faint" data-testid="window-state">
        {!now?.cap ? (half ? "Set both numbers to turn it on." : "Off.")
          : hold ? `Reached: ${fmtUsd(now.spent)} of ${fmtUsd(now.cap.usd)}. New requests of unattended turns wait${now.rolls_at ? ` until about ${clock(now.rolls_at, { date: new Date(now.rolls_at).toDateString() !== new Date().toDateString() })}` : " until the window rolls under it"}.`
          : `${fmtUsd(now.spent)} of ${fmtUsd(now.cap.usd)} in the last ${now.cap.hours === 1 ? "hour" : `${now.cap.hours} hours`}, every session counted.`}
      </p>
      {now?.cap ? <div className="mt-1.5 h-1 w-64 max-w-full rounded-full bg-sunken" data-testid="window-bar"><div className={cn("h-1 rounded-full", hold ? "bg-danger" : now.level === "warn" ? "bg-warn" : "bg-series-1")} style={{ width: `${Math.min(100, now.pct * 100)}%` }} /></div> : null}
    </Panel>
  );
}

// A range as it is said: 30 days is not "this month".
const PAST: Record<string, string> = { hour: "the past hour", day: "the past 24 hours", week: "the past 7 days", month: "the past 30 days" };
export const RANGES = { hour: 3_600_000, day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
export type Range = keyof typeof RANGES;
// The ranges every Usage view offers, shortest first.
export const RANGE_OPTIONS: { value: Range; label: string }[] = [{ value: "hour", label: "Hour" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }];

// A duration as a person says it: milliseconds, seconds, then minutes and hours (not 5462.6 s).
export const fmtMs = (v: number | null | undefined) => {
  if (v == null) return "none";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
  const min = Math.round(v / 60_000);
  if (min < 60) { const sec = Math.round((v % 60_000) / 1000); return v < 600_000 && sec && sec < 60 ? `${Math.floor(v / 60_000)} min ${sec} s` : `${min} min`; }
  return min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min / 60} h`;
};
export const fmtPct = (v: number | null | undefined) => (v == null ? "none" : `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0)}%`);
// A spend that some calls are missing from (no known price, or usage that never
// arrived) is a lower bound, or unknown when nothing in it was priced.
type Cost = { priced_cost_usd: number; unpriced_calls: number; incomplete_calls?: number; calls?: number; total_tokens?: number };
export const fmtSpend = (c: Cost) => (c.unpriced_calls || c.incomplete_calls ? (c.priced_cost_usd ? `${fmtUsd(c.priced_cost_usd)}+` : "unknown") : fmtUsd(c.priced_cost_usd));
// An amount in a table: the priced part alone. What is missing from it is said once, under the page's figure.
const amount = (c: Cost | undefined) => (!c ? "none" : c.priced_cost_usd ? fmtUsd(c.priced_cost_usd) : c.unpriced_calls ? "not priced" : "$0");
const PURPOSE: Record<string, string> = { turn: "Turns", summary: "Summaries", side: "Side questions", advisor: "Advisor", consult: "Consults", reader: "Reader", judge: "Safety checks" };
export const fmtUsd = (v: number) => (v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

// A boxed card, or with `plain` a section of the page itself: a hairline, a
// heading and what it holds, with no box around it.
// A part of a figures page, on the Settings kit: boxed, a group (its head over its box); `plain`, the
// same head standing on the page under a hairline (the overview's answer reads as one page).
export function Panel({ title, hint, children, testid, aside, plain, className }: { title: string; hint?: string; children: ReactNode; testid?: string; aside?: ReactNode; plain?: boolean; className?: string }) {
  if (!plain) return <Group title={title} hint={hint} actions={aside} pad testid={testid} className={className}>{children}</Group>;
  return (
    <section className={cn("k-set-group min-w-0 border-t border-line px-4 pt-4", className)} data-testid={testid}>
      <div className="k-set-head">
        {/* (Its line beside the name, as before: two panels side by side keep their tables on one line.) */}
        <div className="k-set-title flex-wrap"><h3>{title}</h3>{hint && <span className="k-set-count">{hint}</span>}</div>
        {aside && <div className="k-set-actions">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

// `wide`: columns (by index) a narrow table leaves out (a phone, a half of the page at 1366), so the ones
// that matter (the money) stay in view with no sideways scroll.
export function Table({ head, rows, align, onRow, expanded, wide }: { head: string[]; rows: ReactNode[][]; align?: ("l" | "r")[]; onRow?: (i: number) => void; expanded?: (i: number) => ReactNode; wide?: number[] }) {
  const phone = (i: number) => (wide?.includes(i) ? "@max-[30rem]/table:hidden" : "");
  return (
    // (A phone gives the columns the room: the gap between two is half of a desk's, the edges the same.)
    <div className="k-scroll-x @container/table -mx-4 max-sm:px-2">
      <table className="w-full text-ui">
        <thead>
          <tr className="border-b border-line text-caption text-faint">
            {head.map((h, i) => <th key={h} className={cn("px-4 py-1.5 font-normal max-sm:px-2", phone(i), (align?.[i] ?? (i ? "r" : "l")) === "r" ? "text-right" : "text-left")}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const more = expanded?.(i);
            return [
              <tr key={i} className={cn("border-b border-line/60 last:border-0", onRow && "cursor-default hover:bg-hover")} onClick={() => onRow?.(i)}>
                {r.map((c, j) => <td key={j} className={cn("px-4 py-1.5 tabular-nums max-sm:px-2", phone(j), (align?.[j] ?? (j ? "r" : "l")) === "r" ? "whitespace-nowrap text-right text-muted" : "max-w-64 truncate text-left")}>{c}</td>)}
              </tr>,
              more ? <tr key={`${i}-more`} className="border-b border-line/60"><td colSpan={r.length} className="bg-sunken/50 px-4 py-2">{more}</td></tr> : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

type View = "overview" | "causes" | "sessions" | "calls" | "tokens" | "errors" | "compactions" | "yield" | "memory" | "compare" | "trials";

// The sections of Settings > Usage. The overview is what a person opens the page to learn: what
// was spent, what drove it, where it went, and whether anything is wrong. Each further question
// has a view of its own (why it cost this, which sessions and agent trees spent it, how fast calls and tools were, token zones, errors, compactions, how far each model's work and reviews held, memory).
// A link may name the view to open (?view=memory, with the session it is about); one followed while
// this page is already open is told by an event (USAGE_LINK), since nothing mounts again.
export const USAGE_LINK = "keel-usage-link";
const linked = () => { const q = new URLSearchParams(location.search); return { memory: q.get("view") === "memory", session: q.get("session") ?? "", sweep: q.get("tab") === "sweep" }; };
export function UsagePanel() {
  const [link, setLink] = useState(() => ({ ...linked(), n: 0 }));
  const [view, setView] = useState<View>(link.memory ? "memory" : "overview");
  const [range, setRange] = useState<Range>("week");
  // The range sums what the Memory view's Usage and Never named show; Given and Search do not read it.
  const [memoryTab, setMemoryTab] = useState<MemoryTab>(link.sweep ? "sweep" : link.memory ? "given" : "usage");
  useEffect(() => {
    const follow = () => { const l = linked(); if (!l.memory) return; setLink((was) => ({ ...l, n: was.n + 1 })); setMemoryTab(l.sweep ? "sweep" : "given"); setView("memory"); };
    addEventListener(USAGE_LINK, follow);
    return () => removeEventListener(USAGE_LINK, follow);
  }, []);
  const ranged = view !== "compare" && view !== "trials" && !(view === "memory" && (memoryTab === "given" || memoryTab === "search" || memoryTab === "sweep"));
  return (
    <div className="flex flex-col gap-4" data-testid="usage-panel">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3">
        {/* Eleven views in four groups: where they do not fit one line (a phone) they go on to the next, whole, not cut mid-word behind a scroll. */}
        <Seg<View> wrap label="View" value={view} onChange={setView} options={[
          { value: "overview", label: "Overview" }, { value: "causes", label: "Causes" }, { value: "sessions", label: "Sessions" },
          { value: "calls", label: "Speed and tools", before: GROUP_GAP }, { value: "tokens", label: "Token zones" }, { value: "errors", label: "Errors" },
          { value: "compactions", label: "Compactions", before: GROUP_GAP }, { value: "yield", label: "Review yield" }, { value: "memory", label: "Memory" },
          { value: "compare", label: "Compare", before: GROUP_GAP }, { value: "trials", label: "Trials" },
        ]} />
        {ranged && <Segmented<Range> label="Range" value={range} onChange={setRange} options={RANGE_OPTIONS} />}
        <Help label="where it is measured">Measured on this machine. Nothing is sent anywhere.</Help>
      </div>
      {view === "overview" ? <Overview range={range} go={setView} /> : view === "causes" ? <CostDrivers range={range} /> : view === "sessions" ? <SpendRank range={range} /> : view === "calls" ? <CallsView range={range} /> : view === "tokens" ? <TokensView range={range} />
        : view === "errors" ? <ErrorsView range={range} /> : view === "compactions" ? <CompactionsView range={range} /> : view === "yield" ? <ReviewYield range={range} /> : view === "memory" ? <MemoryView key={link.n} range={range} session={link.session} given={link.memory} sweep={link.sweep} onTab={setMemoryTab} /> : view === "trials" ? <SettingTrials /> : <CompareView />}
    </div>
  );
}

// The telemetry report of a range, read again every half minute; an older answer landing late is dropped.
function useReport(range: Range, also?: (since: number, n: number) => void): Report | null {
  const [r, setR] = useState<Report | null>(null);
  const extra = useRef(also);
  extra.current = also;
  useEffect(() => {
    let live = true;
    let sent = 0;
    let got = 0;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      const n = ++sent;
      const since = Date.now() - RANGES[range];
      // A report answered from what the daemon keeps while it reads its ledger again: asked for once more in a moment.
      api<Report>(`/api/telemetry?since_ms=${since}`).then((t) => { if (live && n > got) { got = n; setR(t); if (t.refreshing) again = setTimeout(load, 2500); } }).catch(reportError);
      extra.current?.(since, n);
    };
    load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); clearTimeout(again); };
  }, [range]);
  return r;
}

function Overview({ range, go }: { range: Range; go: (v: View) => void }) {
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
  const [cost, setCost] = useState<Record<string, Cost> | null>(null);
  const [usage, setUsage] = useState<{ total: Cost; by_purpose: (Cost & { purpose: string })[] } | null>(null);
  const [costFailed, setCostFailed] = useState<number | null>(null);
  const models = useModels();
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);

  // Telemetry and prices load on their own: a failed price lookup leaves fresh
  // measurements in place and marks only the Spend cells. Each source keeps the
  // answer of its latest poll; an older one landing late is dropped.
  const gotUsage = useRef(0);
  useEffect(() => { gotUsage.current = 0; }, [range]);
  const r = useReport(range, (since, n) => {
    const of = range;
    api<any>(`/api/usage?group=model&since_ms=${since}&limit=200`)
      .then((u) => { if (of === rangeNow.current && n > gotUsage.current) { gotUsage.current = n; setCost(Object.fromEntries(u.buckets.map((b: any) => [b.key, b]))); setUsage(u); setCostFailed(null); } })
      .catch((e) => { if (of === rangeNow.current && n > gotUsage.current) setCostFailed(Date.now()); reportError(e); });
  });
  const rangeNow = useRef(range);
  rangeNow.current = range;

  const series = useMemo(() => r?.series ?? [], [r]);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  const t = r.total;
  const costShown = fmtSpend({ priced_cost_usd: t.priced_cost_usd, unpriced_calls: t.unpriced_calls, incomplete_calls: usage?.total.incomplete_calls });
  const prompt = t.input_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const calls = (n: number) => `${n.toLocaleString()} ${n === 1 ? "call" : "calls"}`;
  const missing = [t.unpriced_calls ? `${calls(t.unpriced_calls)} with no known price` : "", usage?.total.incomplete_calls ? `${calls(usage.total.incomplete_calls)} that ended before reporting usage` : ""].filter(Boolean);
  const tokens: Costs = { read: t.cache_read_tokens, written: t.cache_write_tokens, full: t.input_tokens, output: t.output_tokens };
  // Money by kind: each model's spend cut at its own price. Known only when every model's is.
  const kinds = !cost || t.unpriced_calls ? null : r.by_model.reduce<Costs | null>((all, m) => {
    const c = kindCosts({ input: m.input_tokens, output: m.output_tokens, cache_read: m.cache_read_tokens, cache_write: m.cache_write_tokens }, models.find((x) => x.id === m.model)?.price, cost[m.model]?.priced_cost_usd);
    return all && c ? addCosts(all, c) : null;
  }, noCosts());
  // What drove the spend, in sentences (lib/spend.ts).
  const spent = t.priced_cost_usd;
  const drivers = spendDrivers({
    spent, bucket_ms: r.bucket_ms, usd: fmtUsd,
    models: cost ? r.by_model.map((m) => ({ name: name(m.model), usd: cost[m.model]?.priced_cost_usd ?? 0 })) : [],
    purposes: usage ? usage.by_purpose.map((x) => ({ purpose: x.purpose, usd: x.priced_cost_usd })) : [],
    buckets: series.map((x) => ({ t: x.t_ms, usd: x.priced_cost_usd })),
    at: (ts, day) => (day ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : clock(ts, { date: true })),
  });
  // A share of the spend as a short bar and its figure, the same in both lists.
  const Share = ({ usd }: { usd: number | undefined }) => (usd === undefined || !(spent > 0) ? <span className="text-faint">none</span> : (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-sunken @max-[30rem]/table:hidden" aria-hidden><span className="block h-full rounded-full bg-series-1" style={{ width: `${Math.min(100, (100 * usd) / spent)}%` }} /></span>
      <span className="w-9 text-right">{Math.round((100 * usd) / spent)}%</span>
    </span>
  ));
  const WENT = ["Spend", "Share", "Tokens", "Requests"];
  const breaks = r.breaks.reduce((n, b) => n + b.count, 0);
  const modelRows = [...r.by_model].sort((a, b) => (cost?.[b.model]?.priced_cost_usd ?? 0) - (cost?.[a.model]?.priced_cost_usd ?? 0) || b.calls - a.calls);

  return (
    <div className="flex flex-col gap-6" data-testid="usage-overview">
      {/* On a long ledger the daemon answers from the numbers it read last and reads again behind the answer: their age is said until the new ones come. */}
      {r.refreshing && r.as_of_ms && <div className="px-4 text-caption text-faint" data-testid="usage-as-of" title={when(r.as_of_ms)}>Numbers from {ago(r.as_of_ms) === "now" ? "a moment" : ago(r.as_of_ms)} ago. The ledger is being read again.</div>}

      {/* The answer: what was spent, what drove it, and what it was spent on. The page's one figure in the display size. */}
      <section className="grid gap-x-12 gap-y-6 px-4 md:grid-cols-2" data-testid="usage-answer">
        <div className="min-w-0" data-testid="tile-spend">
          <div className="text-caption text-muted">Spent in {PAST[range]}</div>
          <div className="mt-1 text-display font-semibold tabular-nums">{costShown}</div>
          <div className="mt-1.5 text-caption text-faint" data-testid="usage-counted">
            {t.calls.toLocaleString()} model calls.
            {/* The plus on the figure, named: what is not in it. */}
            {missing.length > 0 && <> The + is for {missing.join(" and ")}: their cost is not counted.</>}
          </div>
          {drivers.length > 0 && <p className="mt-3 max-w-[34rem] text-ui leading-relaxed text-muted" data-testid="usage-drivers">{drivers.join(" ")}</p>}
          {/* The calendar's own pair, said here and nowhere else: today and this calendar month, against their limits when set. */}
          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3" data-testid="usage-calendar">
            {([["Today", r.spend.day], ["This calendar month", r.spend.month]] as const).map(([label, sp]) => (
              <div key={label} className="min-w-28">
                <div className="text-caption text-faint">{label}</div>
                <div className="mt-0.5 text-ui tabular-nums"><span className="text-fg">{fmtUsd(sp.usd)}</span>{sp.limit_usd ? <span className="text-faint"> of {fmtUsd(sp.limit_usd)}</span> : null}</div>
                {sp.limit_usd ? <div className="mt-1.5 h-1 rounded-full bg-sunken"><div className={cn("h-1 rounded-full", sp.usd >= sp.limit_usd ? "bg-danger" : "bg-series-1")} style={{ width: `${Math.min(100, (sp.usd / sp.limit_usd) * 100)}%` }} /></div> : null}
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-base font-medium">{kinds ? "Where the money went" : "Where the tokens went"}</h3>
            {/* The cache hit rate, said here and nowhere else on the page (a model's own is in its row). */}
            <span className="text-caption text-faint" data-testid="tile-cache">{fmtTokens(prompt + t.output_tokens)} tokens; {fmtPct(t.cache_hit_ratio)} of the prompt was read from cache</span>
          </div>
          <Split format={kinds ? fmtUsd : fmtTokens} heads={kinds ? ["Cost", "Tokens", "of cost"] : ["Tokens", "", "of tokens"]} testid="usage-split"
            parts={KINDS.map((k) => ({ label: KIND_LABEL[k], color: PART[k], value: kinds ? kinds[k] : tokens[k], also: kinds ? fmtTokens(tokens[k]) : undefined }))} />
        </div>
      </section>

      {/* The cap and how far the spend is from it, beside the figure it limits: in view at 1040 px, not under the charts. */}
      <SpendWindow />

      {/* Where it went: who and what took the spend, in two lists of the same columns, and when. */}
      <div className="grid gap-x-6 gap-y-6 xl:grid-cols-2">
        <Panel plain title="By model" hint={costFailed && cost ? `spend as of the last price lookup; it failed ${ago(costFailed)} ago` : undefined} testid="usage-models">
          {modelRows.length ? (
            <Table
              head={["Model", ...WENT]} wide={[3, 4]}
              rows={modelRows.map((m) => {
                const c = cost?.[m.model];
                return [
                  <span title={m.model}>{name(m.model)}</span>,
                  !cost ? (costFailed ? <span className="text-faint" title="the price lookup failed">unavailable</span> : "") : amount(c),
                  <Share usd={c?.priced_cost_usd} />,
                  fmtTokens(m.input_tokens + m.cache_read_tokens + m.cache_write_tokens + m.output_tokens), m.calls,
                ];
              })}
            />
          ) : <p className="k-empty">No model calls in this range.</p>}
        </Panel>
        <Panel plain title="By purpose" hint="turns, and the requests beside them" testid="usage-purposes">
          {usage?.by_purpose.length ? (
            <Table head={["Purpose", ...WENT]} wide={[3, 4]}
              rows={[...usage.by_purpose].sort((a, b) => b.priced_cost_usd - a.priced_cost_usd || (b.calls ?? 0) - (a.calls ?? 0)).map((x) => [PURPOSE[x.purpose] ?? x.purpose, amount(x), <Share usd={x.priced_cost_usd} />, fmtTokens(x.total_tokens ?? 0), x.calls ?? 0])} />
          ) : <p className="k-empty">No requests in this range.</p>}
        </Panel>
      </div>
      <Panel plain title="Spend over time" hint={`per ${bucketName(r.bucket_ms)}`} testid="chart-spend">
        <TimeChart
          kind="bars" label="Spend over time" height={150}
          data={series.map((x) => ({ t: x.t_ms, at: x.last_ms, values: [x.priced_cost_usd] }))}
          series={[{ label: "Spend", color: "var(--series-1)" }]}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={fmtUsd}
        />
      </Panel>

      {/* Is anything wrong: three figures, each the door to its own view. */}
      <Panel plain title="Is anything wrong" testid="usage-health">
        <Stats plain>
          <Stat testid="tile-breaks" label="Cache breaks" value={String(breaks)}
            sub={breaks ? r.breaks.map((b) => `${b.count} ${CAUSE[b.cause] ?? b.cause}`).join("; ") : "every request read at least as much from the cache as the one before"} />
          <Stat testid="tile-errors" label="Failed or refused" value={fmtPct(t.failed_share)} tone={t.failed_share >= 0.05 ? "danger" : undefined}
            sub={`${t.failed} of ${t.calls.toLocaleString()} requests${r.error_kinds[0] ? `, most often ${r.error_kinds[0].message}` : ""}`} />
          <Stat testid="tile-ttft" label="Wait for the first word" value={fmtMs(t.ttft_p50)} sub={`in half of the requests; a whole reply takes ${fmtMs(t.step_latency_p50)}`} />
        </Stats>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-caption">
          <button type="button" className={LINK} data-testid="usage-go-causes" onClick={() => go("causes")}>Why it cost this, and what changes it</button>
          <button type="button" className={LINK} data-testid="usage-go-sessions" onClick={() => go("sessions")}>Spend by session and agent tree</button>
          <button type="button" className={LINK} data-testid="usage-go-calls" onClick={() => go("calls")}>Speed, cache and tools</button>
          <button type="button" className={LINK} data-testid="usage-go-errors" onClick={() => go("errors")}>Errors by kind</button>
          <button type="button" className={LINK} onClick={() => go("tokens")}>What the prompt is made of</button>
        </div>
      </Panel>

      {budget && (
        <Panel plain title="Spend limits" hint="a turn stops before a request once a limit is reached; calls with no known price are not counted" testid="usage-budget">
          <div className="flex flex-wrap gap-x-10 gap-y-3">
            {([["daily_usd", "A day", r.spend.day], ["monthly_usd", "A calendar month", r.spend.month]] as const).map(([key, label, sp]) => (
              <label key={key} className="flex items-center gap-2.5 text-ui text-muted">
                {label}
                <MoneyField label={`${label}: spend limit`} testid={`budget-${key}`} value={budget[key]} onSave={(v) => saveBudget(key, v)} />
                {sp.unpriced_calls ? <span className="text-caption text-faint">{calls(sp.unpriced_calls)} not counted</span> : null}
              </label>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

// A rule between the groups of views (money, requests, context, experiments); a phone's wrapped rows go without.
const GROUP_GAP = <span className="block h-4 w-px self-center bg-line-strong max-md:hidden" data-testid="usage-view-gap" aria-hidden />;
const LINK = "k-link rounded-sm text-accent-ink outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

// How fast the calls and the tools were, and whether the cache held, over the range.
function CallsView({ range }: { range: Range }) {
  const r = useReport(range);
  const [openTool, setOpenTool] = useState<string | null>(null);
  const models = useModels(); // every model the range's calls ran on, not only the ones sessions run on now
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  const t = r.total;
  const series = r.series;
  const span = bucketName(r.bucket_ms);
  const buckets = series.filter((x) => x.calls > 0).length;
  return (
    <div className="flex flex-col gap-6" data-testid="usage-calls">
      <section className="px-4" data-testid="chart-latency">
        <Stats plain className="mb-4">
          <Stat testid="tile-ttft" label="Wait for the first word" value={fmtMs(t.ttft_p50)} sub={`in half of the requests; first text after ${fmtMs(t.first_text_p50)}; 1 in 20 waits over ${fmtMs(t.ttft_p95)}`} />
          <Stat testid="tile-step" label="A whole reply" value={fmtMs(t.step_latency_p50)}
            sub={`in half of the requests; 1 in 20 takes over ${fmtMs(t.step_latency_p95)}; ${fmtMs(t.latency_p50)} without retries${t.retried_steps ? `, ${t.retried_steps} were retried` : ""}`} />
          <Stat testid="tile-speed" label="Writing speed" value={t.output_tokens_per_s ? `${Math.round(t.output_tokens_per_s)} tokens/s` : "none"} sub={`measured on ${t.speed_sample.calls.toLocaleString()} of ${t.calls.toLocaleString()} requests`} />
        </Stats>
        <TimeChart
          label="Wait for the first word and for a whole request over time" height={150}
          data={series.map((x) => ({ t: x.t_ms, at: x.last_ms, values: [x.ttft_p50, x.latency_p50] }))}
          series={[{ label: "First word", color: "var(--series-1)" }, { label: "Whole request", color: "var(--series-2)" }]}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={fmtMs}
        />
        {r.by_model.length > 1 && (
          <div className="mt-4" data-testid="usage-speed">
            <Table head={["Model", "First word", "Tokens/s", "Read from cache", "Failed"]}
              rows={[...r.by_model].sort((a, b) => b.calls - a.calls).map((m) => [<span title={m.model}>{name(m.model)}</span>, fmtMs(m.ttft_p50), m.output_tokens_per_s ? Math.round(m.output_tokens_per_s) : "none", fmtPct(m.cache_hit_ratio), m.errors ? <span className="text-danger">{m.errors}</span> : 0])} />
          </div>
        )}
      </section>

      <SlowestRequests range={range} />

      <Panel plain title="Is the cache holding" hint={`how much of the prompt was read from the provider's cache, not paid in full, per ${span}`} testid="chart-cache">
        {buckets > 1 ? (
          <TimeChart
            label="Share of the prompt read from cache over time" height={150}
            data={series.map((x) => ({ t: x.t_ms, at: x.last_ms, values: [x.cache_hit_ratio] }))}
            series={[{ label: "Read from cache", color: "var(--series-1)" }]}
            bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} max={1} format={(v) => `${Math.round(v * 100)}%`}
          />
        ) : <p className="text-ui text-faint" data-testid="chart-cache-one">{/^\w+$/.test(span) ? `One ${span}` : `One span of ${span}`} of data so far: {fmtPct(t.cache_hit_ratio)} of its prompt was read from cache. A trend shows from the second.</p>}
        <div className={cn("text-caption text-muted", buckets > 1 ? "mt-3" : "mt-2")} data-testid="cache-breaks">
          {r.breaks.length === 0 ? "No request in this range read less from the cache than the one before it." : (
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {r.breaks.map((b) => (
                <span key={b.cause}>
                  <span className="font-medium tabular-nums text-fg">{b.count}</span> {b.count > 1 ? "breaks" : "break"}: {CAUSE[b.cause] ?? b.cause}
                  {!!b.details?.length && <span data-testid="break-details"> ({b.details.map((d) => (d.count > 1 ? `${d.detail}, ${d.count} times` : d.detail)).join("; ")})</span>}
                  <span className="text-faint">, {fmtTokens(b.uncached_tokens)} tokens sent again</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </Panel>

      <div className="grid gap-x-6 gap-y-6 xl:grid-cols-2">
        <Panel plain title="Tools" hint="calls that ran, after any approval; a row with failures opens them" testid="usage-tools">
          {r.tools.length ? (
            <Table
              head={["Tool", "Calls", "Failed", "Usual time", "Slow 1 in 20", "All together"]}
              onRow={(i) => r.tools[i]!.tool_errors ? setOpenTool(openTool === r.tools[i]!.tool ? null : r.tools[i]!.tool) : undefined}
              expanded={(i) => (openTool === r.tools[i]!.tool ? <Failures tool={openTool} since={r.since_ms} until={r.until_ms} count={r.tools[i]!.tool_errors} /> : null)}
              rows={r.tools.map((x) => [
                <span className="font-mono text-caption">{x.tool}</span>, x.tool_calls,
                x.tool_errors ? <span className={x.tool_error_rate >= 0.15 ? "text-danger" : undefined}>{fmtPct(x.tool_error_rate)}</span> : "0%",
                fmtMs(x.p50_ms), fmtMs(x.p95_ms),
                x.total_ms == null ? <span className="text-faint">not measured</span> : x.timed < x.tool_calls ? <span title={`${x.tool_calls - x.timed} calls have no duration`}>{fmtMs(x.total_ms)} <span className="text-faint">({x.timed} of {x.tool_calls})</span></span> : fmtMs(x.total_ms),
              ])}
            />
          ) : <p className="k-empty">No tool calls in this range.</p>}
        </Panel>
        {r.error_kinds.length > 0 && (
          <Panel plain title="Why requests failed" testid="usage-failures">
            <Table head={["Error", "Times"]} rows={r.error_kinds.map((e) => [<span title={e.message}>{e.message}</span>, e.count])} />
          </Panel>
        )}
      </div>
    </div>
  );
}

// What the agent was told to remember and what it cost. Opened from the page it starts on what
// recall added over the range; opened by a link (a session's memory chip, /memory, the palette) it
// starts on what that session was given.
function MemoryView({ range, session, given, sweep, onTab }: { range: Range; session: string; given: boolean; sweep: boolean; onTab: (t: MemoryTab) => void }) {
  const since = useMemo(() => Date.now() - RANGES[range], [range]);
  return <MemoryUsage since={since} session={session} tab={sweep ? "sweep" : given ? "given" : "usage"} onTab={onTab} />;
}
