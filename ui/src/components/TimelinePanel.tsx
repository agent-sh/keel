// The session's timeline: what it is doing now, pinned on top, then what
// happened, newest first, one line each. Turns are the spine: a turn's row is
// a node on a line that runs up through what happened inside it (an agent
// started, a wait set, an approval), so working time reads as a drawn course
// and idle time as a gap. A row opens its detail: a turn's receipt as a short
// chain of cause, with the way into its trace, its error and its place in the
// conversation.
import { Radio } from "@base-ui/react/radio";
import {
  Anchor, ArrowLeftRight, Bot, ClipboardCopy, CornerDownRight, FileClock, Flag, FoldVertical, Gauge, Hand, ListEnd, MessageCircleQuestionMark, MessagesSquare, Power, Repeat,
  Route, Timer, TriangleAlert, X, type LucideIcon,
} from "lucide-react";
import { Fragment, type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { dur, whoWords } from "../../../src/admin/timeline-rows.ts";
import type { Session } from "../../../src/core/types.ts";
import { openSession, useAuto } from "../lib/automation.ts";
import { copyBundle, openTrace, traceOfTurn } from "../lib/observe.ts";
import { reportError, useStore } from "../lib/store.ts";
import {
  fetchReceipt, fetchTimeline, keepView, mergeSince, refreshFrom, timelineFocus, viewOf,
  type Held, type Only, type Receipt, type TimelineKind, type TimelineNow, type TimelineRow,
} from "../lib/timeline.ts";
import { savePref, setUI } from "../lib/ui.ts";
import { cn, fmtCost, fmtTokens, when } from "../lib/utils.ts";
import { Choices } from "./Choices.tsx";

const MARK: Record<Exclude<TimelineKind, "turn">, LucideIcon> = {
  agent: Bot, wait: Timer, loop: Repeat, approval: Hand, question: MessageCircleQuestionMark, compaction: FoldVertical, model: ArrowLeftRight,
  restart: Power, error: TriangleAlert, goal: Flag, limit: Gauge, files: FileClock, queue: ListEnd, idle: Anchor,
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
  waiting: { word: "Waiting", dot: "border-2 border-muted" },
  idle: { word: "Idle", dot: "border-2 border-line-strong" },
};
const ink = (tone: TimelineRow["tone"], plain: string) => (tone === "failed" ? "text-st-fail" : tone === "owner" ? "text-st-need" : tone === "live" ? "text-st-work" : plain);
const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const seconds = (ts: number) => `:${String(new Date(ts).getSeconds()).padStart(2, "0")}`;
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
const flashOn = (el: HTMLElement) => { el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600); };
// Under 64rem the panel is a sheet over the conversation: what it points at there is behind it.
const overConversation = () => matchMedia("(max-width: 1023px)").matches;

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

// A turn's node says how it ended: ink when it finished, red when it failed,
// amber while it runs, a ring when it was stopped, cut or never began.
function Mark({ row }: { row: TimelineRow }) {
  if (row.kind === "turn") {
    return (
      <span
        className={cn(
          "size-2 rounded-full",
          row.tone === "failed" ? "bg-st-fail" : row.tone === "live" ? "bg-st-work animate-pulse-dot" : row.sub === "ok" ? "bg-fg" : "size-2.5 border-2 border-fg",
        )}
      />
    );
  }
  const Icon = MARK[row.kind];
  return <Icon className={cn("size-3.5", ink(row.tone, "text-faint"))} />;
}

// The card a "needs you" line is about: in this session's conversation when it
// is shown there, else in the agent's own session.
function toCard(l: TimelineRow) {
  const find = () =>
    (l.refs?.approval_id ? document.querySelector<HTMLElement>(`[data-testid="approval"][data-approval-id="${CSS.escape(l.refs.approval_id)}"]`) : null)
    ?? (l.refs?.call_id ? document.querySelector<HTMLElement>(`[data-call="${CSS.escape(l.refs.call_id)}"]`) : null)
    ?? (l.kind === "question" && !l.refs?.child_session ? document.querySelector<HTMLElement>('[data-testid="question"][data-state="open"]') : null);
  const show = () => {
    const el = find();
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    flashOn(el);
    (el.querySelector<HTMLElement>("button:not([disabled]), [tabindex]") ?? el).focus({ preventScroll: true });
    return true;
  };
  if (overConversation()) savePref("panel", null);
  requestAnimationFrame(() => {
    if (show()) return;
    if (l.refs?.child_session) return openSession(l.refs.child_session);
    // Scrolled away: the conversation's end holds the open cards.
    dispatchEvent(new Event("keel:end"));
    requestAnimationFrame(() => void show());
  });
}

function Panel({ session }: { session: Session }) {
  const id = session.id;
  const kept = useRef(viewOf(id)).current;
  const [only, setOnly] = useState<Only>(kept.only);
  const [list, setList] = useState<Held | null>(null);
  const [now, setNow] = useState<TimelineNow | null>(null);
  const [open, setOpen] = useState<string | null>(kept.open);
  // The row the arrows are on, by its id: rows that arrive above it do not move it.
  const [activeId, setActiveId] = useState<string | null>(kept.active);
  const [more, setMore] = useState(false);
  const focus = useSyncExternalStore(timelineFocus.subscribe, timelineFocus.get);
  // A turn another view asked for: its row opens when the list holds it, else its receipt shows above the list.
  const [asked, setAsked] = useState<string | null>(focus);
  const [apart, setApart] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const rowsEl = useRef<HTMLDivElement>(null);

  // What is held, for the next refresh: the list, when it was read and what was open then.
  const held = useRef<{ list: Held | null; asOf: number; now: TimelineNow | null }>({ list: null, asOf: 0, now: null });
  // A reply is taken only while its filter is the one shown, and never after a newer one.
  const gen = useRef(0);
  const sent = useRef(0);
  const applied = useRef(0);

  const load = useCallback((whole: boolean): Promise<void> => {
    const g = gen.current, n = ++sent.current;
    const since = !whole && held.current.list ? refreshFrom(held.current.asOf, held.current.now ?? undefined) : undefined;
    return fetchTimeline(id, { only, since }).then((p) => {
      if (g !== gen.current || n < applied.current) return;
      applied.current = n;
      const next: Held = since !== undefined && held.current.list
        ? mergeSince(held.current.list, p, since, held.current.asOf)
        : { rows: p.rows, next: p.next, scanned: p.scanned };
      held.current = { list: next, asOf: p.as_of, now: p.now ?? null };
      setList(next);
      setNow(p.now ?? null);
    });
  }, [id, only]);
  const loadNow = useRef(load);
  loadNow.current = load;

  const mounted = useRef(false);
  useEffect(() => {
    gen.current++;
    held.current = { list: null, asOf: 0, now: null };
    setList(null);
    // The first read restores what was open when the panel was left; a new filter starts clean.
    if (mounted.current) { setOpen(null); setActiveId(null); }
    mounted.current = true;
    load(true).catch((e) => reportError(e, { at: "timeline" }));
  }, [load]);

  // Live: what the bus brings for this session (an event, the turn's status,
  // the queue, an activity row, a failure, an agent or a wait of its own)
  // reads again what can have changed, at most four times a second, and never
  // from a hidden tab: one read when it shows again covers what it missed.
  const events = useStore((s) => s.events[id]?.length ?? 0);
  const status = useStore((s) => s.status[id]);
  const queued = useStore((s) => s.queues[id]);
  const failure = useStore((s) => { const e = s.errors.find((x) => x.session_id === id); return e ? `${e.id} ${e.ts} ${e.count ?? 1} ${e.resolved_ts ?? 0}` : ""; });
  const questions = useStore((s) => `${s.questionCalls[id]?.join() ?? ""} ${s.questionChildren[id]?.join() ?? ""}`);
  const act = useAuto((s) => (s.lastActivity?.session_id === id ? s.activityTick : 0));
  const agents = useAuto((s) => Object.values(s.agents).filter((a) => a.parent_id === id).map((a) => `${a.id} ${a.status}`).join());
  const waits = useAuto((s) => Object.values(s.waits).filter((w) => w.session_id === id).map((w) => `${w.id} ${w.status}`).join());
  const first = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const owed = useRef(false);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (document.hidden) { owed.current = true; return; }
    timer.current ??= setTimeout(() => { timer.current = null; loadNow.current(false).catch((e) => reportError(e, { at: "timeline live" })); }, 250);
  }, [events, status, queued, failure, questions, act, agents, waits, session.phase]);
  useEffect(() => {
    const shown = () => {
      if (document.hidden || !owed.current) return;
      owed.current = false;
      loadNow.current(false).catch((e) => reportError(e, { at: "timeline live" }));
    };
    document.addEventListener("visibilitychange", shown);
    return () => { document.removeEventListener("visibilitychange", shown); if (timer.current) clearTimeout(timer.current); };
  }, []);

  // Another view asked for a turn's receipt (an Activity row).
  useEffect(() => {
    if (!focus) return;
    setAsked(focus);
    setApart(null);
    timelineFocus.set(null);
  }, [focus]);

  // What "now" says is not a row too (the daemon leaves it out of the first page; an older page may hold it).
  const said = new Set((now?.lines ?? []).flatMap((l) => [l.kind === "turn" ? l.turn_event : undefined, l.kind === "approval" ? l.refs?.approval_id : undefined, l.refs?.note_id]).filter(Boolean));
  const rows = (list?.rows ?? []).filter((r) => !((r.open && ((r.kind === "turn" && said.has(r.id)) || (r.kind === "approval" && said.has(r.refs?.approval_id)))) || (r.kind === "restart" && said.has(r.id))));

  // The asked turn's own row opens and is shown; a turn the list does not hold keeps its receipt above it.
  useEffect(() => {
    if (!asked || !list) return;
    if (only) return setOnly("");
    const at = rows.findIndex((r) => r.id === asked);
    setAsked(null);
    if (at < 0) return setApart(asked);
    setOpen(asked);
    setActiveId(asked);
    requestAnimationFrame(() => {
      const el = rowsEl.current?.querySelector<HTMLElement>(`[data-row="${at}"]`);
      el?.closest<HTMLElement>('[data-testid="timeline-row"]')?.scrollIntoView({ block: "center" });
      if (el) { el.focus({ preventScroll: true }); flashOn(el); }
    });
  }, [asked, list, only]);

  // Kept for when the panel comes back: the filter, the open row, the row under the keys, the scroll.
  const view = useRef({ only, open, active: activeId, top: kept.top });
  view.current = { ...view.current, only, open, active: activeId };
  useEffect(() => () => keepView(id, view.current), [id]);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (!list || restored.current) return;
    restored.current = true;
    if (scroller.current && kept.top) scroller.current.scrollTop = kept.top;
  }, [list]);

  const older = () => {
    if (!list?.next || more) return;
    const g = gen.current, from = list.next;
    setMore(true);
    fetchTimeline(id, { only, before: from, now: false })
      .then((p) => {
        // The list moved on while this was read (a refresh replaced it): the page no longer joins its end.
        if (g !== gen.current || held.current.list?.next !== from) return;
        const cur = held.current.list;
        const have = new Set(cur.rows.map((r) => r.id));
        const next = { rows: [...cur.rows, ...p.rows.filter((r) => !have.has(r.id))], next: p.next, scanned: (cur.scanned ?? 0) + (p.scanned ?? 0) || undefined };
        held.current.list = next;
        setList(next);
      })
      .catch((e) => reportError(e, { at: "timeline older" }))
      .finally(() => setMore(false));
  };

  const active = Math.max(0, rows.findIndex((r) => r.id === activeId));
  const go = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActiveId(rows[n]?.id ?? null);
    rowsEl.current?.querySelector<HTMLElement>(`[data-row="${n}"]`)?.focus();
  };
  // One Tab stop: the arrows move between rows, Enter opens one. Escape closes
  // the open row from anywhere inside it and puts the keys back on its line.
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key === "Escape" && open) {
      const item = t.closest<HTMLElement>('[data-testid="timeline-row"]');
      if (item?.dataset.id !== open) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(null);
      item.querySelector<HTMLElement>("button[data-row]")?.focus();
      return;
    }
    if (!t.hasAttribute("data-row")) return;
    if (e.key === "ArrowDown") { e.preventDefault(); if (active === rows.length - 1) older(); else go(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); go(active - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(rows.length - 1); }
  };
  const closeApart = () => {
    setApart(null);
    (rowsEl.current?.querySelector<HTMLElement>(`[data-row="${active}"]`) ?? scroller.current)?.focus();
  };

  const today = Date.now();
  // The bound a filtered read stops at: nothing found is "none so far", not "none".
  const bounded = !!list?.next && !!list.scanned;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline-panel">
      <Now now={now} onTurn={(t) => { setApart(null); setAsked(t); }} />
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-2">
        <Choices value={only} onValueChange={(v) => setOnly(v as Only)} aria-label="Show" className="inline-flex rounded-md bg-sunken p-0.5 shadow-[inset_0_0_0_1px_var(--line)]">
          {FILTERS.map(([v, label]) => (
            <Radio.Root
              key={v}
              value={v}
              data-testid={`timeline-only-${v || "all"}`}
              className="flex h-6 cursor-default items-center rounded-sm px-2.5 text-caption font-medium text-muted data-checked:bg-raised data-checked:text-fg data-checked:shadow-1"
            >
              {label}
            </Radio.Root>
          ))}
        </Choices>
      </div>
      <div ref={scroller} tabIndex={-1} onScroll={(e) => { view.current.top = e.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-y-auto pb-3 outline-none" data-testid="timeline-scroll">
        {apart && <Apart turn={apart} sessionId={id} onClose={closeApart} />}
        {!list && <p className="px-4 py-10 text-center text-ui text-muted">Reading the timeline.</p>}
        {list && rows.length === 0 && (
          <p className="px-6 py-10 text-center text-ui text-muted" data-testid="timeline-empty">
            {bounded ? `No ${only === "failures" ? "failure" : "row"} in the newest ${list.scanned} rows.` : EMPTY[only]}
          </p>
        )}
        <div ref={rowsEl} role="list" aria-label="What happened, newest first" onKeyDown={keys} data-testid="timeline-rows">
          {rows.map((r, i) => {
            const above = rows[i - 1], below = rows[i + 1];
            const label = !above || day(above.ts, today) !== day(r.ts, today) ? day(r.ts, today) : null;
            const t = turnOf(r);
            const up = !!t && turnOf(above) === t;
            const down = !!t && r.kind !== "turn" && turnOf(below) === t;
            const isOpen = open === r.id;
            const turn = r.kind === "turn";
            const aside = r.turn?.branch === "other";
            // The minute once, then the seconds of what follows in it: a burst keeps its order.
            const sameMinute = !!above && !label && clock(above.ts) === clock(r.ts);
            const stamp = !sameMinute ? clock(r.ts) : seconds(above.ts) === seconds(r.ts) ? "" : seconds(r.ts);
            return (
              <Fragment key={r.id}>
                {label && (
                  <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-micro text-muted" data-testid="timeline-day">
                    <span className="font-medium">{label}</span><span className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div role="listitem" className={cn("relative", isOpen && "bg-raised shadow-1")} data-testid="timeline-row" data-kind={r.kind} data-sub={r.sub} data-tone={r.tone} data-id={r.id} data-turn={t} data-branch={aside ? "other" : undefined}>
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
                    <time dateTime={new Date(r.ts).toISOString()} title={when(r.ts)} className={cn("pt-px text-right font-inst text-micro leading-5 tabular-nums [font-stretch:87.5%]", sameMinute ? "text-faint" : "text-muted")}>
                      {stamp}
                    </time>
                    <span className={cn("grid h-5 place-items-center", aside && "opacity-50")} aria-hidden><Mark row={r} /></span>
                    <span className={cn("text-ui leading-5", ink(r.tone === "live" ? "plain" : r.tone, turn ? "text-fg" : "text-muted"), aside && "text-faint")}><Sentence row={r} /></span>
                    <span className="pt-px font-inst text-micro leading-5 tabular-nums text-muted [font-stretch:87.5%]">{turn ? (r.open ? <Since ts={r.ts} /> : r.ms ? dur(r.ms) : "") : ""}</span>
                  </button>
                  {isOpen && <Detail row={r} sessionId={id} />}
                </div>
              </Fragment>
            );
          })}
        </div>
        {list?.next && (
          <button type="button" onClick={older} disabled={more} className="mx-auto mt-3 block rounded-md border border-line px-3 py-1 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50" data-testid="timeline-older">
            {more ? "Reading" : bounded ? "Look further back" : "Older"}
          </button>
        )}
        {list && !list.next && rows.length > 0 && (
          <p className="px-3 pt-4 text-center text-caption text-muted" data-testid="timeline-end">
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

// What the session is doing and waiting on, pinned above the list. A line
// leads to what it is about: the card that waits on the owner, the running
// turn's receipt, the agent's session.
function Now({ now, onTurn }: { now: TimelineNow | null; onTurn: (turn: string) => void }) {
  const live = !!now?.lines.some((l) => l.open || l.until);
  const at = useTick(live);
  if (!now) return <div className="h-[4.25rem] shrink-0 border-b border-line bg-raised" />;
  const st = STATE[now.state];
  return (
    <section className="shrink-0 border-b border-line bg-raised px-3 pb-2.5 pt-2.5" aria-label="Now" data-testid="timeline-now" data-state={now.state}>
      <h3 className="flex items-center gap-2">
        <span className="grid w-12 place-items-end pr-0.5 font-inst text-micro text-muted [font-stretch:87.5%]">Now</span>
        <span className="grid w-6 place-items-center"><span className={cn("size-2 rounded-full", st.dot)} /></span>
        <span className={cn("font-inst text-base font-semibold tracking-tight [font-stretch:87.5%]", now.state === "owner" && "text-st-need")} data-testid="timeline-state">{st.word}</span>
      </h3>
      <ul className="mt-1 flex flex-col">
        {now.lines.map((l) => {
          const child = l.refs?.child_session;
          const card = l.kind === "approval" || l.kind === "question";
          const act = card ? () => toCard(l) : l.turn_event ? () => onTurn(l.turn_event!) : child ? () => openSession(child) : undefined;
          const hint = card ? (child ? "Go to the card, or to the agent's session" : "Go to the card") : l.turn_event ? "Show this turn's receipt" : "Open the agent's session";
          const timer = l.until ? (l.until > at ? `due in ${dur(l.until - at)}` : "due now") : l.open ? dur(Math.max(0, at - l.ts)) : l.kind === "idle" && l.ts < at - 1000 ? `since ${clock(l.ts)}` : "";
          const body = (
            <>
              <span className="w-12" />
              <span className="grid h-5 w-6 shrink-0 place-items-center" aria-hidden>
                {l.kind === "turn" ? <Route className="size-3.5 text-st-work" /> : <Mark row={l} />}
              </span>
              <span className={cn("min-w-0 flex-1 text-ui leading-5", ink(l.tone === "live" ? "plain" : l.tone, "text-fg"))}>{l.text}</span>
              <span className="shrink-0 pt-px font-inst text-micro leading-5 tabular-nums text-muted [font-stretch:87.5%]">{timer}</span>
            </>
          );
          return (
            <li key={l.id} data-testid="timeline-now-line" data-kind={l.kind} data-tone={l.tone}>
              {act ? (
                <button type="button" onClick={act} title={hint} className="-mx-3 flex w-[calc(100%+1.5rem)] items-start gap-2 px-3 py-0.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-offset-[-2px]">
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

// The receipt of a turn the list does not hold (the running one, one further back than what is loaded), above the list until it is closed.
function Apart({ turn, sessionId, onClose }: { turn: string; sessionId: string; onClose: () => void }) {
  const [start, setStart] = useState<number | null>(null);
  return (
    <div className="border-b border-line bg-raised pb-2 pl-[6.25rem] pr-2 pt-1.5" data-testid="timeline-asked" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <div className="flex items-center">
        <span className="text-caption font-medium">{start ? `The turn of ${new Date(start).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })}` : "The turn's receipt"}</span>
        <button type="button" onClick={onClose} aria-label="Close the receipt" className="ml-auto grid size-6 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>
      </div>
      <TurnReceipt turn={turn} sessionId={sessionId} onRead={(r) => setStart(r.start_ms)} />
    </div>
  );
}

function Fact({ k, children }: { k: string; children: ReactNode }) {
  if (children === undefined || children === null || children === "" || children === false) return null;
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  );
}

function Detail({ row, sessionId }: { row: TimelineRow; sessionId: string }) {
  const [receipt, setReceipt] = useState(false);
  const error = useStore((s) => (row.refs?.error_id ? s.errors.find((e) => e.id === row.refs!.error_id) : undefined));
  const child = row.refs?.child_session;
  return (
    <div className="flex flex-col gap-2 pb-2.5 pl-[6.25rem] pr-3 pt-0.5" data-testid="timeline-detail">
      {row.kind === "turn" ? <TurnReceipt turn={row.id} sessionId={sessionId} facts={row.turn} /> : (
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
                <button type="button" className={tool} onClick={() => openTrace(sessionId, traceOfTurn(row.turn_event!), row.refs?.span_id)} data-testid="timeline-error-trace">Trace</button>
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
const RECEIPT_MS = 2000;
const commas = (xs: ReactNode[]) => xs.reduce<ReactNode[]>((a, x, n) => (n ? [...a, ", ", x] : [x]), []);

// A turn's receipt as a short chain of cause: what started it, what it asked
// the model, what it ran, how it ended. Each failed link opens in the trace,
// and the turn in the conversation.
function TurnReceipt({ turn, sessionId, facts, onRead }: { turn: string; sessionId: string; facts?: TimelineRow["turn"]; onRead?: (r: Receipt) => void }) {
  const [r, setR] = useState<Receipt | null>(null);
  const [gone, setGone] = useState(false);
  const [copied, setCopied] = useState(false);
  const read = useCallback(() => fetchReceipt(turn).then((x) => { setR(x); onRead?.(x); }).catch((e) => (e?.status === 404 ? setGone(true) : reportError(e, { at: "turn receipt" }))), [turn]);
  useEffect(() => void read(), [read]);
  // A running turn's receipt grows: it is read again as the turn's events
  // arrive, at most once in RECEIPT_MS (a busy turn stores many a second and
  // each read walks the whole turn), and once more when the turn has ended.
  const events = useStore((s) => s.events[sessionId]?.length ?? 0);
  const running = !!r && !r.end;
  const due = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!running || document.hidden) return;
    due.current ??= setTimeout(() => { due.current = null; void read(); }, RECEIPT_MS);
  }, [events, running, read]);
  useEffect(() => () => { if (due.current) clearTimeout(due.current); }, []);
  if (gone) return <p className="text-caption text-muted" data-testid="timeline-receipt-gone">This turn is no longer in the session.</p>;
  if (!r) return <p className="text-caption text-muted">Reading the receipt.</p>;
  const failedRequests = r.requests.filter((q) => q.status === "error");
  // A call that ran and failed has a span to open. An error with no span never ran: a gate denied it, or it named no tool.
  const failedTools = r.tools.filter((x) => x.status === "error" && x.span_id);
  const neverRan = r.tools.filter((x) => x.status === "error" && !x.span_id).length;
  const denied = facts?.denied_tools ?? 0;
  // Calls the turn's stop or a restart reached: stopped, not failed.
  const stopped = r.tools.filter((x) => x.status === "interrupted").length;
  const errorId = failedRequests.find((q) => q.error_id)?.error_id;
  const span = (id: string | null, label: string, testid: string) =>
    id && r.trace_id ? (
      <button key={id} type="button" className="rounded-xs px-1 text-st-fail underline decoration-line-strong underline-offset-2 hover:bg-hover" onClick={() => openTrace(sessionId, r.trace_id!, id)} data-testid={testid}>{label}</button>
    ) : <span key={label} className="text-st-fail">{label}</span>;
  const link = "relative pb-2 pl-4 before:absolute before:left-0 before:top-[0.4375rem] before:size-1.5 before:rounded-full before:bg-line-strong after:absolute after:bottom-0 after:left-[0.1875rem] after:top-[0.9375rem] after:w-px after:-translate-x-1/2 after:bg-line last:pb-0 last:after:hidden";
  // The prompt it answers, else the turn itself: where the conversation shows it.
  const place = r.inputs[0]?.event_id ?? turn;
  const show = () => {
    if (overConversation()) savePref("panel", null);
    setUI({ focusEvent: place });
  };
  return (
    <div className="flex flex-col gap-2" data-testid="timeline-receipt" data-turn={turn}>
      <ol className="text-caption">
        <li className={link} data-testid="receipt-inputs">
          <span className="text-muted">Started {when(r.start_ms)} by </span>
          {r.inputs.length ? r.inputs.map((i, n) => <span key={i.event_id}>{n ? ", then " : ""}{whoWords(n === 0 && facts ? facts.origin : i.origin)}</span>) : "something not recorded"}
        </li>
        <li className={link} data-testid="receipt-requests">
          {r.requests.length ? (
            <>
              {count(r.requests.length, "model request")}
              {failedRequests.length > 0 && <>, {commas(failedRequests.map((q, n) => span(q.span_id, `${n ? "" : `${failedRequests.length} failed: `}attempt ${q.attempt ?? "?"}`, "receipt-failed-request")))}</>}
              {facts && (facts.input !== undefined || facts.output !== undefined) && <span className="text-muted">, {fmtTokens((facts.input ?? 0) + (facts.cache_read ?? 0))} tokens in, {fmtTokens(facts.output ?? 0)} out{facts.cost ? `, ${fmtCost(facts.cost)}` : ""}</span>}
            </>
          ) : <span className="text-muted">No model request is kept for this turn{facts ? ` (${count(facts.steps, "reply", "replies")})` : ""}</span>}
        </li>
        <li className={link} data-testid="receipt-tools">
          {r.tools.length ? (
            <>
              {count(r.tools.length, "tool call")}
              {failedTools.length > 0 && <>, {failedTools.length} failed: {commas(failedTools.map((x, n) => span(x.span_id, `call ${n + 1}`, "receipt-failed-tool")))}</>}
              {neverRan > 0 && (
                <span className="text-muted" data-testid="receipt-not-run">
                  {failedTools.length
                    ? ` (${neverRan} more ${neverRan === denied ? "denied" : denied ? `never ran, ${denied} of them denied` : "never ran: denied, or no such tool"})`
                    : `, ${neverRan === denied ? `${neverRan} denied` : denied ? `${neverRan} never ran, ${denied} of them denied` : `${neverRan} never ran (denied, or no such tool)`}`}
                </span>
              )}
              {stopped > 0 && <span className="text-muted" data-testid="receipt-stopped">, {stopped} stopped with the turn</span>}
            </>
          ) : <span className="text-muted">No tool call</span>}
        </li>
        <li className={link} data-testid="receipt-end">
          {r.end ? <>{ENDED[r.end.reason] ?? "Ended"}{r.end.end_ms > r.start_ms && <span className="text-muted"> after {dur(r.end.end_ms - r.start_ms)}</span>}</> : <span className="text-st-work">Still running</span>}
        </li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={tool} onClick={show} title="Scrolls the conversation to this turn's prompt" data-testid="receipt-show">
          <MessagesSquare className="size-3.5" /> Show in conversation
        </button>
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

// One panel per session: what it holds (rows, the open row, the filter) is that session's.
export function TimelinePanel({ session }: { session: Session }) {
  return <Panel key={session.id} session={session} />;
}

export default TimelinePanel;
