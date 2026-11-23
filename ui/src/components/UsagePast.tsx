// What Usage answers about the past across sessions: spend ranked by session
// or by agent tree, the slowest requests of a range, and two turns of one
// session side by side with why one was dearer or slower. The figures are the
// ledger's (src/server/routes/usage.ts, telemetry.ts); the sentences of a
// turn comparison are the daemon's (src/admin/turn-compare.ts).
import { Popover } from "@base-ui/react/popover";
import { ChevronsUpDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cacheShare, promptTokens, SAME, type SlowRequest, type TurnFacts, type TurnPick } from "../../../src/admin/turn-compare.ts";
import { composing } from "../lib/keys.ts";
import { openTrace, traceOfTurn } from "../lib/observe.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { clock, cn, fmtTokens, when } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Segmented } from "./Settings.tsx";
import { popupClass } from "./ui.tsx";
import { fmtMs, fmtPct, fmtUsd, Panel, RANGES, Table, type Range } from "./UsagePanel.tsx";
import { CLASS } from "./UsageViews.tsx";

// What a path answers, read again every half minute. The answer is kept with what it was asked
// for: when that changes (another session, another range) the old answer is not shown under the
// new question, so nothing is asked of the new one with the old one's ids.
function useGet<T>(path: string | null, deps: unknown[]): T | null {
  const key = JSON.stringify(deps);
  const [r, setR] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!path) { setR(null); return; }
    let live = true;
    const load = () => api<T>(path).then((x) => live && setR({ key, value: x })).catch(reportError);
    load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); };
  }, deps);
  return r && r.key === key ? r.value : null;
}

// A name that opens its session: it reads as the row's text, and says it is a link under the pointer or the focus.
const LINK = "min-w-0 truncate rounded-sm text-left text-fg underline-offset-2 outline-none decoration-line-strong hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring";
const open = (id: string) => navigate({ name: "session", id });

// --- spend ranked
type Bucket = { key: string; priced_cost_usd: number; unpriced_calls: number; calls: number; total_tokens: number; own_cost_usd?: number; agents?: number; agents_cost_usd?: number };
type Ranked = { buckets: Bucket[]; has_more: boolean; total: { priced_cost_usd: number; calls: number }; sessions?: Record<string, { title: string; parent_id?: string; archived?: true }> };
const ROWS = 15;
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
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {s ? <button type="button" className={LINK} onClick={() => open(b.key)} title="Opens the session" data-testid="rank-open">{s.title || "Untitled"}</button> : <span className="text-faint">a removed session</span>}
        {s?.parent_id && by === "session" && <span className="shrink-0 text-caption text-faint">an agent</span>}
        {s?.archived && <span className="shrink-0 text-caption text-faint">archived</span>}
        {by === "tree" && !!b.agents && <span className="shrink-0 text-caption text-faint" data-testid="rank-agents">{fmtUsd(b.agents_cost_usd ?? 0)} of it in {b.agents} {b.agents === 1 ? "agent" : "agents"}</span>}
        {/* A phone has room for three columns: the other two stand here, under the name. */}
        <span className="hidden basis-full text-caption text-faint max-sm:block" data-testid="rank-phone">{fmtTokens(b.total_tokens)} tokens, {b.calls.toLocaleString()} {b.calls === 1 ? "request" : "requests"}</span>
      </span>
    );
  };
  return (
    <Panel plain title="Spend by session" hint={by === "tree" ? "a session with the agents under it, dearest first" : "each session's own requests, dearest first"} testid="usage-rank"
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
const short = (t: TurnPick) => `Turn ${t.n.toLocaleString()}`;
const facts = (t: TurnPick) => `${clock(t.ts, { date: true, seconds: true })}, ${t.cost == null ? (t.requests ? "no price" : "$0") : fmtUsd(t.cost)}, ${fmtMs(t.ms)}`;
type Pair = { a: TurnFacts; b: TurnFacts; diff: { cost: string; time: string; also: string[] } };
const SELECT = "min-w-0 max-w-full";
const SHOWN = 60;

// One turn of a session, picked from all of them: the list opens at the newest, and a number or
// words of a prompt narrow it. A session of a thousand turns has every one of them within a few keys.
function TurnPicker({ label, turns, total, value, onPick }: { label: string; turns: TurnPick[]; total: number; value: TurnPick | undefined; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const found = useMemo(() => {
    const w = q.trim().toLowerCase();
    if (!w) return turns;
    const n = /^#?(\d[\d,]*)$/.exec(w)?.[1]?.replace(/,/g, "");
    // A number is a turn's number first (the one named, then the ones that start with it); words are its prompt.
    if (n) return [...turns.filter((t) => String(t.n) === n), ...turns.filter((t) => String(t.n) !== n && String(t.n).startsWith(n))];
    return turns.filter((t) => t.prompt.toLowerCase().includes(w));
  }, [turns, q]);
  const shown = found.slice(0, SHOWN);
  const choose = (t: TurnPick | undefined) => { if (!t) return; onPick(t.turn_event); setOpen(false); };
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [at]);
  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (o) { setQ(""); setAt(0); } }}>
      <Popover.Trigger aria-label={label} data-testid={`compare-${label}`} data-value={value?.turn_event ?? ""} className={cn("k-select k-field", SELECT, "w-[min(27rem,100%)]")}>
        <span className="min-w-0 flex-1 truncate">
          {value ? <><span className="font-medium tabular-nums">{short(value)}</span><span className="text-muted">, {facts(value)}</span></> : "No turn"}
        </span>
        <ChevronsUpDown className="size-3.5 flex-none text-faint" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" sideOffset={4} className="z-[70] outline-none">
          <Popover.Popup className={cn(popupClass, "flex max-h-[min(var(--available-height),26rem)] w-[min(34rem,calc(100vw-1rem))] flex-col p-0")} data-testid="turn-picker">
            <input
              autoFocus
              value={q}
              onChange={(e) => { setQ(e.target.value); setAt(0); }}
              onKeyDown={(e) => {
                if (composing(e)) return; // the arrows and Enter are the input method's while a word is composed
                if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => Math.min(shown.length - 1, i + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); choose(shown[at]); }
              }}
              role="combobox" aria-expanded aria-controls="turn-picker-list" aria-autocomplete="list" aria-label={`Find a turn for ${label}`}
              placeholder={`A turn's number, or words of its prompt (${total.toLocaleString()} ${total === 1 ? "turn" : "turns"})`}
              data-testid="turn-picker-input"
              className="h-10 flex-none border-b border-line bg-transparent px-3 text-ui text-fg outline-none placeholder:text-faint"
            />
            <div ref={list} id="turn-picker-list" role="listbox" aria-label="Turns" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {!shown.length && <p className="px-2.5 py-3 text-ui text-muted">No turn of this session matches. A number finds a turn by its number; words find it by its prompt.</p>}
              {shown.map((t, i) => (
                <button
                  key={t.turn_event} type="button" role="option" aria-selected={t.turn_event === value?.turn_event} data-active={i === at} data-value={t.turn_event} data-testid="turn-option"
                  onPointerMove={() => setAt(i)} onClick={() => choose(t)}
                  className="grid w-full grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-2.5 rounded-md px-2.5 py-1.5 text-left text-ui outline-none data-[active=true]:bg-hover aria-selected:text-accent-ink"
                >
                  <span className="text-right font-medium tabular-nums">{t.n.toLocaleString()}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-fg" dir="auto">{t.prompt ? t.prompt.replace(/\s+/g, " ") : <span className="text-faint">no prompt of the owner's</span>}</span>
                    <span className="block truncate text-caption tabular-nums text-faint">{facts(t)}</span>
                  </span>
                </button>
              ))}
              {found.length > shown.length && <p className="px-2.5 py-2 text-caption text-faint">{(found.length - shown.length).toLocaleString()} older {found.length - shown.length === 1 ? "turn" : "turns"}: a number or a word of the prompt finds it.</p>}
              {total > turns.length && <p className="px-2.5 py-2 text-caption text-faint">The newest {turns.length.toLocaleString()} of {total.toLocaleString()} turns can be picked here.</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function TurnsCompare({ table }: { table: (heads: string[], rows: [string, ReactNode, ReactNode, ReactNode][]) => ReactNode }) {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).sort((a, b) => b.updated - a.updated).slice(0, 200), [sessions]);
  const [sid, setSid] = useState("");
  const session = sid || list[0]?.id || "";
  // Every turn of the session can be picked (the route's bound is its own).
  const got = useGet<{ turns: TurnPick[]; counts: { turns: number } }>(session ? `/api/telemetry/turns?session_id=${session}&limit=5000` : null, [session]);
  const turns = got?.turns;
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  // The newest turn against the one before it, until the owner picks.
  const ta = turns?.find((t) => t.turn_event === a) ?? turns?.[0];
  const tb = turns?.find((t) => t.turn_event === b) ?? turns?.[1];
  const r = useGet<Pair>(ta && tb ? `/api/telemetry/turns?session_id=${session}&a=${ta.turn_event}&b=${tb.turn_event}` : null, [session, ta?.turn_event, tb?.turn_event]);
  const turnSelect = (label: string, v: TurnPick | undefined, set: (id: string) => void) => <TurnPicker label={label} turns={turns ?? []} total={got?.counts.turns ?? turns?.length ?? 0} value={v} onPick={set} />;
  // Counts and times differ by how much, in the unit of the row; lower is better for cost and time.
  // A difference too small to matter (`same`) is said in the row's own figures and carries no color:
  // red and green are for a change a person would act on.
  const delta = (x: number | null, y: number | null, fmt: (v: number) => string, lowerBetter: boolean | null = true, same = 0) => {
    if (x == null || y == null) return <span className="text-faint">none</span>;
    const d = Math.abs(x - y);
    if (x === y || d < same) return <span className="text-faint">same</span>;
    const up = x > y;
    // Small beside what it is a change of: said, not colored.
    const slight = d < 0.02 * Math.max(Math.abs(x), Math.abs(y));
    return <span className={cn(lowerBetter === null || slight ? "text-muted" : up === lowerBetter ? "text-danger" : "text-ok")}>{up ? "+" : "-"}{fmt(d)}</span>;
  };
  const rows = (p: Pair): [string, ReactNode, ReactNode, ReactNode][] => {
    const { a: x, b: y } = p;
    const n = (v: number) => v.toLocaleString();
    const money = (v: number | null) => (v == null ? "no price" : fmtUsd(v));
    const zone = (k: "tools" | "system" | "history" | "tail", label: string): [string, ReactNode, ReactNode, ReactNode] =>
      [label, x.zones ? n(x.zones[k]) : "not measured", y.zones ? n(y.zones[k]) : "not measured", delta(x.zones?.[k] ?? null, y.zones?.[k] ?? null, n)];
    return [
      ["Cost", money(x.cost), money(y.cost), delta(x.cost, y.cost, fmtUsd, true, SAME.cost)],
      ["Took", fmtMs(x.ms), fmtMs(y.ms), delta(x.ms, y.ms, (v) => fmtMs(v), true, SAME.ms)],
      ["In model requests", fmtMs(x.request_ms), fmtMs(y.request_ms), delta(x.request_ms, y.request_ms, (v) => fmtMs(v), true, SAME.ms)],
      ["In tools", fmtMs(x.tool_ms), fmtMs(y.tool_ms), delta(x.tool_ms, y.tool_ms, (v) => fmtMs(v), true, SAME.ms)],
      ["Outside requests and tools", fmtMs(x.wait_ms), fmtMs(y.wait_ms), delta(x.wait_ms, y.wait_ms, (v) => fmtMs(v), true, SAME.ms)],
      ["Requests", `${x.requests}${x.failed_attempts ? `, ${x.failed_attempts} failed` : ""}`, `${y.requests}${y.failed_attempts ? `, ${y.failed_attempts} failed` : ""}`, delta(x.requests, y.requests, n)],
      ["Prompt tokens sent", n(promptTokens(x)), n(promptTokens(y)), delta(promptTokens(x), promptTokens(y), n)],
      zone("history", "History"), zone("tail", "New messages"), zone("system", "System prompt"), zone("tools", "Tool schemas"),
      ["Read from cache", fmtPct(cacheShare(x)), fmtPct(cacheShare(y)), delta(cacheShare(x), cacheShare(y), (v) => `${Math.round(v * 100)} pts`, false, SAME.share)],
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
              {/* The figures stand beside their labels: a table as wide as its three columns of numbers, not as the page. */}
              <div className="max-w-[46rem]">{table([`Turn ${r.a.n.toLocaleString()}`, `Turn ${r.b.n.toLocaleString()}`], rows(r))}</div>
            </>
          )}
      </Panel>
    </>
  );
}
