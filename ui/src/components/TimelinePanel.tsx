// The session's timeline: what it is doing now, pinned on top, then what
// happened, newest first, one line each. Turns are the spine: a turn's row is
// a node on a line that runs up through what happened inside it (an agent
// started, a wait set, an approval), so working time reads as a drawn course
// and idle time as a gap. A row opens its detail: a turn's receipt as a short
// chain of cause, with the way into its trace and its error.
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  Anchor, ArrowLeftRight, Bot, ClipboardCopy, CornerDownRight, Flag, FoldVertical, Gauge, Hand, ListEnd, MessageCircleQuestionMark, Power, Repeat, Route, Timer,
  TriangleAlert, X, type LucideIcon,
} from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { dur, whoWords } from "../../../src/admin/timeline-rows.ts";
import type { Session } from "../../../src/core/types.ts";
import { openSession, useAuto } from "../lib/automation.ts";
import { copyBundle, openTrace } from "../lib/observe.ts";
import { reportError, useStore } from "../lib/store.ts";
import { fetchReceipt, fetchTimeline, mergeHead, type Only, type Receipt, type TimelineKind, type TimelineNow, type TimelineRow, timelineFocus } from "../lib/timeline.ts";
import { setUI } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens, when } from "../lib/utils.ts";

const MARK: Record<Exclude<TimelineKind, "turn">, LucideIcon> = {
  agent: Bot, wait: Timer, loop: Repeat, approval: Hand, question: MessageCircleQuestionMark, compaction: FoldVertical, model: ArrowLeftRight,
  restart: Power, error: TriangleAlert, goal: Flag, limit: Gauge, queue: ListEnd, idle: Anchor,
};
const FILTERS: [Only, string][] = [["", "Everything"], ["failures", "Failures"], ["turns", "Turns"], ["agents", "Agents"]];
const EMPTY: Record<Only, string> = {
  "": "Nothing has happened here yet. The first prompt starts the first turn.",
  failures: "Nothing has failed in this session.",
  turns: "No turn has run in this session yet.",
  agents: "This session has started no agents.",
};
const STATE: Record<TimelineNow["state"], { word: string; dot: string }> = {
  working: { word: "Working", dot: "bg-st-work animate-pulse-dot" },
  owner: { word: "Needs you", dot: "bg-st-need" },
  waiting: { word: "Waiting", dot: "border-[1.5px] border-muted" },
  idle: { word: "Idle", dot: "border-[1.5px] border-line-strong" },
};
const ink = (tone: TimelineRow["tone"], plain: string) => (tone === "failed" ? "text-st-fail" : tone === "owner" ? "text-st-need" : tone === "live" ? "text-st-work" : plain);
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = 86_400_000;
function day(ts: number, now: number): string {
  const start = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const back = Math.round((start(now) - start(ts)) / DAY);
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  return new Date(ts).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(back > 300 ? { year: "numeric" } : {}) });
}
// The turn a row sits in: a turn's own row, and what happened inside one.
const turnOf = (r: TimelineRow | undefined) => r?.turn_event;
const tool = "flex h-7 items-center gap-1.5 rounded-md border border-line px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50";

// A clock for what is still going on: one tick a second while the panel shows something open.
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// The sentence, with the part that went wrong inside a row that is otherwise fine in the failure color.
function Sentence({ row }: { row: TimelineRow }) {
  const at = row.bad ? row.text.indexOf(row.bad) : -1;
  if (at < 0) return <>{row.text}</>;
  return <>{row.text.slice(0, at)}<span className="text-st-fail" data-testid="timeline-bad">{row.bad}</span>{row.text.slice(at + row.bad!.length)}</>;
}

function Mark({ row }: { row: TimelineRow }) {
  if (row.kind === "turn") {
    const sub = row.sub;
    return (
      <span
        className={cn(
          "size-2 rounded-full",
          row.tone === "failed" ? "bg-st-fail" : row.tone === "live" ? "bg-st-work animate-pulse-dot" : sub === "ok" ? "bg-fg" : "border-[1.5px] border-muted",
        )}
      />
    );
  }
  const Icon = MARK[row.kind];
  return <Icon className={cn("size-3.5", ink(row.tone, "text-faint"))} />;
}

export function TimelinePanel({ session }: { session: Session }) {
  const id = session.id;
  const [only, setOnly] = useState<Only>("");
  const [list, setList] = useState<{ rows: TimelineRow[]; next: string | null } | null>(null);
  const [now, setNow] = useState<TimelineNow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The row the arrows are on, by its id: rows that arrive above it do not move it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const focus = useSyncExternalStore(timelineFocus.subscribe, timelineFocus.get);
  const [asked, setAsked] = useState<string | null>(focus);
  const rowsEl = useRef<HTMLDivElement>(null);
  // A reply is taken only while its session and filter are the ones shown.
  const gen = useRef(0);

  const head = useCallback(() => {
    const g = gen.current;
    return fetchTimeline(id, { only }).then((p) => {
      if (g !== gen.current) return;
      setList((cur) => mergeHead(cur, p));
      setNow(p.now ?? null);
    });
  }, [id, only]);

  useEffect(() => {
    gen.current++;
    setList(null);
    setOpen(null);
    setActiveId(null);
    head().catch((e) => reportError(e, { at: "timeline" }));
  }, [head]);

  // Live: whatever the bus brings for this session (an event, the turn's
  // status, the queue, an activity row, an error) reads the first page again,
  // at most a few times a second.
  const events = useStore((s) => s.events[id]?.length ?? 0);
  const status = useStore((s) => s.status[id]);
  const queued = useStore((s) => s.queues[id]);
  const failure = useStore((s) => s.errors[0]);
  const questions = useStore((s) => s.questionCalls);
  const act = useAuto((s) => (s.lastActivity?.session_id === id ? s.activityTick : 0));
  const agents = useAuto((s) => s.agents);
  const waits = useAuto((s) => s.waits);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => head().catch((e) => reportError(e, { at: "timeline live" })), 250);
    return () => clearTimeout(t);
  }, [events, status, queued, failure, questions, act, agents, waits, session.phase]);

  // Another view asked for a turn's receipt (an Activity row).
  useEffect(() => {
    if (!focus) return;
    setAsked(focus);
    timelineFocus.set(null);
  }, [focus]);

  const older = () => {
    if (!list?.next || more) return;
    const g = gen.current;
    setMore(true);
    fetchTimeline(id, { only, before: list.next, now: false })
      .then((p) => { if (g === gen.current) setList((cur) => (cur ? { rows: [...cur.rows, ...p.rows.filter((r) => !cur.rows.some((x) => x.id === r.id))], next: p.next } : cur)); })
      .catch((e) => reportError(e, { at: "timeline older" }))
      .finally(() => setMore(false));
  };

  const rows = list?.rows ?? [];
  const active = Math.max(0, rows.findIndex((r) => r.id === activeId));
  const go = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActiveId(rows[n]?.id ?? null);
    rowsEl.current?.querySelector<HTMLElement>(`[data-row="${n}"]`)?.focus();
  };
  // One Tab stop: the arrows move between rows, Enter opens one, Escape closes it.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).hasAttribute("data-row")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); if (active === rows.length - 1) older(); else go(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(rows.length - 1); }
    else if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(null); }
  };

  const today = Date.now();
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline-panel">
      <Now now={now} onTurn={(t) => setAsked(t)} />
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
        <RadioGroup value={only} onValueChange={(v) => setOnly(v as Only)} aria-label="Show" className="inline-flex rounded-md bg-sunken p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
          {FILTERS.map(([v, label]) => (
            <Radio.Root
              key={v}
              value={v}
              data-testid={`timeline-only-${v || "all"}`}
              className="flex h-6 cursor-default items-center rounded-sm px-2.5 text-caption font-medium text-muted outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-raised data-checked:text-fg data-checked:shadow-1"
            >
              {label}
            </Radio.Root>
          ))}
        </RadioGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3" data-testid="timeline-scroll">
        {asked && <Asked turn={asked} sessionId={id} onClose={() => setAsked(null)} />}
        {!list && <p className="px-4 py-10 text-center text-ui text-faint">Reading the timeline.</p>}
        {list && rows.length === 0 && <p className="px-6 py-10 text-center text-ui text-faint" data-testid="timeline-empty">{EMPTY[only]}</p>}
        <div ref={rowsEl} role="list" aria-label="What happened, newest first" onKeyDown={keys} data-testid="timeline-rows">
          {rows.map((r, i) => {
            const above = rows[i - 1], below = rows[i + 1];
            const label = !above || day(above.ts, today) !== day(r.ts, today) ? day(r.ts, today) : null;
            const t = turnOf(r);
            const up = !!t && turnOf(above) === t;
            const down = !!t && r.kind !== "turn" && turnOf(below) === t;
            const isOpen = open === r.id;
            const turn = r.kind === "turn";
            return (
              <Fragment key={r.id}>
                {label && (
                  <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-micro text-faint" data-testid="timeline-day">
                    <span className="font-medium">{label}</span><span className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div role="listitem" className={cn("relative", isOpen && "bg-raised shadow-1")} data-testid="timeline-row" data-kind={r.kind} data-sub={r.sub} data-tone={r.tone} data-id={r.id} data-turn={t}>
                  {/* The course line: up to what happened later in the same turn, down to the turn's start. */}
                  {up && <span aria-hidden className={cn("pointer-events-none absolute left-[5rem] top-0 w-px -translate-x-1/2 bg-line-strong", turn ? "h-[0.5rem]" : "h-[0.3125rem]")} />}
                  {down && <span aria-hidden className="pointer-events-none absolute bottom-0 left-[5rem] top-[1.4375rem] w-px -translate-x-1/2 bg-line-strong" />}
                  <button
                    type="button"
                    data-row={i}
                    tabIndex={i === active ? 0 : -1}
                    aria-expanded={isOpen}
                    onFocus={() => setActiveId(r.id)}
                    onClick={() => { setActiveId(r.id); setOpen(isOpen ? null : r.id); }}
                    className="grid w-full grid-cols-[3rem_1.5rem_minmax(0,1fr)_auto] items-start gap-x-2 px-3 py-1 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]"
                  >
                    <time dateTime={new Date(r.ts).toISOString()} title={when(r.ts)} className="pt-px text-right font-inst text-micro leading-5 tabular-nums text-faint [font-stretch:87.5%]">
                      {above && !label && clock(above.ts) === clock(r.ts) ? "" : clock(r.ts)}
                    </time>
                    <span className="grid h-5 place-items-center" aria-hidden><Mark row={r} /></span>
                    <span className={cn("text-ui leading-5", ink(r.tone === "live" ? "plain" : r.tone, turn ? "text-fg" : "text-muted"))}><Sentence row={r} /></span>
                    <span className="pt-px font-inst text-micro leading-5 tabular-nums text-faint [font-stretch:87.5%]">{turn ? (r.open ? <Since ts={r.ts} /> : r.ms !== undefined ? dur(r.ms) : "") : ""}</span>
                  </button>
                  {isOpen && <Detail row={r} sessionId={id} />}
                </div>
              </Fragment>
            );
          })}
        </div>
        {list?.next && (
          <button type="button" onClick={older} disabled={more} className="mx-auto mt-3 block rounded-md px-3 py-1 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50" data-testid="timeline-older">
            {more ? "Reading" : "Older"}
          </button>
        )}
        {list && !list.next && rows.length > 0 && (
          <p className="px-3 pt-4 text-center text-micro text-faint" data-testid="timeline-end">
            {only ? "That is all of them." : `The session began ${when(session.created)}.`}
            {!only && session.created < today - 30 * DAY ? " Agents, waits, loops and approvals are kept for 30 days." : ""}
          </p>
        )}
      </div>
    </div>
  );
}

function Since({ ts }: { ts: number }) {
  const now = useTick(true);
  return <>{dur(Math.max(0, now - ts))}</>;
}

// What the session is doing and waiting on, pinned above the list.
function Now({ now, onTurn }: { now: TimelineNow | null; onTurn: (turn: string) => void }) {
  const live = !!now?.lines.some((l) => l.open || l.until);
  const at = useTick(live);
  if (!now) return <div className="h-[4.25rem] shrink-0 border-b border-line bg-raised" />;
  const st = STATE[now.state];
  return (
    <section className="shrink-0 border-b border-line bg-raised px-3 pb-2.5 pt-2.5" aria-label="Now" data-testid="timeline-now" data-state={now.state}>
      <h3 className="flex items-center gap-2">
        <span className="grid w-12 place-items-end pr-0.5 font-inst text-micro text-faint [font-stretch:87.5%]">Now</span>
        <span className="grid w-6 place-items-center"><span className={cn("size-2 rounded-full", st.dot)} /></span>
        <span className={cn("font-inst text-base font-semibold tracking-tight [font-stretch:87.5%]", now.state === "owner" && "text-st-need")} data-testid="timeline-state">{st.word}</span>
      </h3>
      <ul className="mt-1 flex flex-col">
        {now.lines.map((l) => {
          const child = l.refs?.child_session;
          const act = l.turn_event ? () => onTurn(l.turn_event!) : child ? () => openSession(child) : undefined;
          const timer = l.until ? (l.until > at ? `due in ${dur(l.until - at)}` : "due now") : l.open ? dur(Math.max(0, at - l.ts)) : l.kind === "idle" && l.ts < at - 1000 ? `since ${clock(l.ts)}` : "";
          const body = (
            <>
              <span className="w-12" />
              <span className="grid h-5 w-6 shrink-0 place-items-center" aria-hidden>
                {l.kind === "turn" ? <Route className="size-3.5 text-st-work" /> : <Mark row={l} />}
              </span>
              <span className={cn("min-w-0 flex-1 text-ui leading-5", ink(l.tone === "live" ? "plain" : l.tone, "text-fg"))}>{l.text}</span>
              <span className="shrink-0 pt-px font-inst text-micro leading-5 tabular-nums text-faint [font-stretch:87.5%]">{timer}</span>
            </>
          );
          return (
            <li key={l.id} data-testid="timeline-now-line" data-kind={l.kind} data-tone={l.tone}>
              {act ? (
                <button type="button" onClick={act} title={l.turn_event ? "Show this turn's receipt" : "Open the agent's session"} className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-2 px-3 py-0.5 text-left outline-none hover:bg-hover focus-visible:bg-hover">
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-2 py-0.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// A receipt another view asked for, above the list until it is closed.
function Asked({ turn, sessionId, onClose }: { turn: string; sessionId: string; onClose: () => void }) {
  return (
    <div className="border-b border-line bg-raised pb-2 pl-[6.25rem] pr-2 pt-1.5" data-testid="timeline-asked">
      <div className="flex items-center">
        <span className="text-caption font-medium">The turn's receipt</span>
        <button type="button" onClick={onClose} aria-label="Close the receipt" className="ml-auto grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>
      </div>
      <TurnReceipt turn={turn} sessionId={sessionId} />
    </div>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  if (children === undefined || children === null || children === "" || children === false) return null;
  return (
    <>
      <dt className="text-faint">{k}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}

function Detail({ row, sessionId }: { row: TimelineRow; sessionId: string }) {
  const [receipt, setReceipt] = useState(false);
  const error = useStore((s) => (row.refs?.error_id ? s.errors.find((e) => e.id === row.refs!.error_id) : undefined));
  const t = row.turn;
  const child = row.refs?.child_session;
  return (
    <div className="flex flex-col gap-2 pb-2.5 pl-[6.25rem] pr-3 pt-0.5" data-testid="timeline-detail">
      {row.kind === "turn" ? <TurnReceipt turn={row.id} sessionId={sessionId} facts={t} /> : (
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-0.5 text-caption">
          <Fact k="When">{when(row.ts)}</Fact>
          <Fact k="Took">{row.ms !== undefined && dur(row.ms)}</Fact>
          <Fact k="Due">{row.until && when(row.until)}</Fact>
          <Fact k="Failure">{error && <span className="break-words text-st-fail" data-testid="timeline-error-text">{error.message.split("\n")[0]!.slice(0, 300)}</span>}</Fact>
        </dl>
      )}
      {row.kind !== "turn" && (
        <div className="flex flex-wrap gap-2">
          {child && (
            <button type="button" className={tool} onClick={() => openSession(child)} data-testid="timeline-open-agent">
              <CornerDownRight className="size-3.5" /> Open the agent's session
            </button>
          )}
          {row.turn_event && (
            <button type="button" className={tool} aria-expanded={receipt} onClick={() => setReceipt(!receipt)} data-testid="timeline-its-turn">
              <Route className="size-3.5" /> {receipt ? "Hide its turn" : "The turn it happened in"}
            </button>
          )}
          {row.refs?.error_id && (
            <>
              {row.turn_event && (
                <button type="button" className={tool} onClick={() => openTrace(sessionId, row.turn_event!.replace(/-/g, ""), row.refs?.span_id)} data-testid="timeline-error-trace">Trace</button>
              )}
              <button type="button" className={tool} onClick={() => setUI({ errors: true })} data-testid="timeline-open-errors">Open in Errors</button>
            </>
          )}
        </div>
      )}
      {receipt && row.turn_event && <TurnReceipt turn={row.turn_event} sessionId={sessionId} />}
    </div>
  );
}

const ENDED: Record<string, string> = {
  end_turn: "Finished", error: "Failed", interrupted: "Stopped", restart: "Cut by a daemon restart", max_steps: "Out of its step budget", max_tokens: "Hit the output limit",
  refusal: "The model declined", stop_sequence: "Finished", tool_use: "Ended at a tool call", pause_turn: "Paused", model_context_window_exceeded: "The context was too long", other: "Ended",
};
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A turn's receipt as a short chain of cause: what started it, what it asked
// the model, what it ran, how it ended. Each failed link opens in the trace.
function TurnReceipt({ turn, sessionId, facts }: { turn: string; sessionId: string; facts?: TimelineRow["turn"] }) {
  const [r, setR] = useState<Receipt | null>(null);
  const [gone, setGone] = useState(false);
  const [copied, setCopied] = useState(false);
  // A running turn's receipt grows: read again as its events arrive.
  const events = useStore((s) => s.events[sessionId]?.length ?? 0);
  useEffect(() => {
    let live = true;
    fetchReceipt(turn).then((x) => live && setR(x)).catch((e) => (e?.status === 404 ? live && setGone(true) : reportError(e, { at: "turn receipt" })));
    return () => { live = false; };
  }, [turn, r && !r.end ? events : 0]);
  if (gone) return <p className="text-caption text-faint" data-testid="timeline-receipt-gone">This turn is no longer in the session.</p>;
  if (!r) return <p className="text-caption text-faint">Reading the receipt.</p>;
  const failedRequests = r.requests.filter((q) => q.status === "error");
  const failedTools = r.tools.filter((x) => x.status === "error");
  // A failed call that ran has a span to open; one that was refused before it ran has none.
  const ran = failedTools.filter((x) => x.span_id);
  const errorId = failedRequests.find((q) => q.error_id)?.error_id;
  const span = (id: string | null, label: string, testid: string) =>
    id && r.trace_id ? (
      <button key={id} type="button" className="rounded-xs px-1 text-st-fail underline decoration-line-strong underline-offset-2 hover:bg-hover" onClick={() => openTrace(sessionId, r.trace_id!, id)} data-testid={testid}>{label}</button>
    ) : <span key={label} className="text-st-fail">{label}</span>;
  const link = "relative pb-2 pl-4 before:absolute before:left-0 before:top-[0.4375rem] before:size-1.5 before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[0.1875rem] after:top-[0.9375rem] after:w-px after:-translate-x-1/2 after:bg-line last:pb-0 last:after:hidden";
  return (
    <div className="flex flex-col gap-2" data-testid="timeline-receipt" data-turn={turn}>
      <ol className="text-caption">
        <li className={link} data-testid="receipt-inputs">
          <span className="text-faint">Started {when(r.start_ms)} by </span>
          {r.inputs.length ? r.inputs.map((i, n) => <span key={i.event_id}>{n ? ", then " : ""}{whoWords(i.origin === "other" ? "" : i.origin)}</span>) : "something not recorded"}
        </li>
        <li className={link} data-testid="receipt-requests">
          {r.requests.length ? (
            <>
              {count(r.requests.length, "model request")}
              {failedRequests.length > 0 && <>, {failedRequests.map((q, n) => span(q.span_id, `${n ? "" : `${failedRequests.length} failed: `}attempt ${q.attempt ?? "?"}`, "receipt-failed-request")).reduce<ReactNode[]>((a, x, n) => (n ? [...a, ", ", x] : [x]), [])}</>}
              {facts && (facts.input !== undefined || facts.output !== undefined) && <span className="text-faint">, {fmtTokens((facts.input ?? 0) + (facts.cache_read ?? 0))} tokens in, {fmtTokens(facts.output ?? 0)} out{facts.cost ? `, ${fmtCost(facts.cost)}` : ""}</span>}
            </>
          ) : <span className="text-faint">No model request is kept for this turn{facts ? ` (${count(facts.steps, "step")})` : ""}</span>}
        </li>
        <li className={link} data-testid="receipt-tools">
          {r.tools.length ? (
            <>
              {count(r.tools.length, "tool call")}
              {failedTools.length > 0 && <>, {failedTools.length} failed{ran.length ? ": " : ""}{ran.map((x, n) => span(x.span_id, `call ${n + 1}`, "receipt-failed-tool")).reduce<ReactNode[]>((a, x, n) => (n ? [...a, ", ", x] : [x]), [])}</>}
              {failedTools.length > ran.length && <span className="text-faint" data-testid="receipt-not-run"> ({ran.length ? `${failedTools.length - ran.length} more` : failedTools.length === 1 ? "it" : "they"} never ran: refused, or no such tool)</span>}
            </>
          ) : <span className="text-faint">No tool call</span>}
        </li>
        <li className={link} data-testid="receipt-end">
          {r.end ? <>{ENDED[r.end.reason] ?? "Ended"} <span className="text-faint">after {dur(r.end.end_ms - r.start_ms)}</span></> : <span className="text-st-work">Still running</span>}
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        {r.trace_id && (
          <button type="button" className={tool} onClick={() => openTrace(sessionId, r.trace_id!, r.span_id ?? undefined)} data-testid="receipt-trace">
            <Route className="size-3.5" /> Trace
          </button>
        )}
        {errorId && <button type="button" className={tool} onClick={() => setUI({ errors: true })} data-testid="receipt-error"><TriangleAlert className="size-3.5" /> Its error</button>}
        <button
          type="button"
          className={tool}
          onClick={() => copyBundle({ session_id: sessionId, turn_event: turn, error_id: errorId ?? undefined }).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(reportError)}
          data-testid="receipt-bundle"
        >
          <ClipboardCopy className="size-3.5" /> {copied ? "Copied" : "Copy debug bundle"}
        </button>
      </div>
    </div>
  );
}

export default TimelinePanel;
