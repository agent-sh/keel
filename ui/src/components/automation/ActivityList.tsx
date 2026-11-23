import { Bell, Bot, Brain, Coffee, Hand, Moon, Power, ReceiptText, Repeat, Search, Timer, TriangleAlert, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activityTarget, auto, openSession, placeName, useAuto, type Activity, type Alert } from "../../lib/automation.ts";
import { onInboxView, takeInboxView } from "../../lib/inbox-view.ts";
import { reportError, scope, useStore } from "../../lib/store.ts";
import { saidOf } from "../../../../src/automation/activity-words.ts";
import { openReceipt } from "../../lib/timeline.ts";
import { ago, cn, when } from "../../lib/utils.ts";
import { type Restart, restartSummary, restartTurnLine } from "../../../../src/admin/life-rows.ts";
import { ALERT_LABEL, AlertIcon, Empty } from "./bits.tsx";
import { Select } from "../Select.tsx";

const KIND: Record<Activity["kind"], { label: string; icon: typeof Bell }> = {
  alert: { label: "Alerts", icon: Bell },
  turn: { label: "Turns", icon: Workflow },
  agent: { label: "Agents", icon: Bot },
  loop: { label: "Loops", icon: Repeat },
  wait: { label: "Waits", icon: Timer },
  approval: { label: "Approvals", icon: Hand },
  awake: { label: "Awake", icon: Coffee },
  snooze: { label: "Snooze", icon: Moon },
  daemon: { label: "Daemon", icon: Power },
  memory: { label: "Memory", icon: Brain },
};
const KINDS = Object.keys(KIND) as Activity["kind"][];
// The alerts a turn's end raises: each is on its turn's row (src/automation/activity.ts).
const END_ALERTS = new Set(["finished", "failed", "limit", "declined"]);

// Across sessions a session shows its newest rows and counts the rest: one busy session does not fill the list.
const CAP = 3;
const SINCE: { value: string; label: string }[] = [{ value: "", label: "Any time" }, { value: "1h", label: "Last hour" }, { value: "1d", label: "Last day" }, { value: "7d", label: "Last week" }];
const SINCE_MS: Record<string, number> = { "1h": 3_600_000, "1d": 86_400_000, "7d": 7 * 86_400_000 };

const bad = (a: Activity) => /fail|error|refused|refusal|declined/.test(a.sub) || a.sub === "denied" || (a.kind === "daemon" && (a.sub === "killed" || a.sub === "crash"));

// Everything that happened, across sessions, newest first, one row a turn:
// filter by kind, session, words, a time range and what went wrong; a row
// opens its session (or the agent inside it).
export function ActivityList({ onClose }: { onClose: () => void }) {
  const [kinds, setKinds] = useState<Activity["kind"][]>([]);
  const [sid, setSid] = useState("");
  const [q, setQ] = useState("");
  // What a command asked the list to open on (the palette's "Show what went wrong").
  const [failures, setFailures] = useState(() => !!takeInboxView()?.activity?.failures);
  const [since, setSince] = useState("");
  useEffect(() => onInboxView(() => { const a = takeInboxView(); if (a?.tab === "activity") setFailures(!!a.activity?.failures); }), []);
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const [notes, setNotes] = useState<Record<string, { text: string; parent?: string | null }>>({});
  const [places, setPlaces] = useState<{ session_id: string; last: number }[]>([]);
  const last = useAuto((s) => s.lastActivity);
  const sessions = useStore((s) => s.sessions);
  // The filter as one query: a reply is taken only while its query is current.
  const query = useRef({ kinds, sid, q, failures, since, gen: 0 });
  const asked = (before?: string) => ({ kind: kinds, session_id: sid || undefined, q: q || undefined, since: since || undefined, failures, cap: sid ? undefined : CAP, before });

  useEffect(() => {
    auto.activitySessions().then((r) => setPlaces(r.sessions)).catch(reportError);
  }, []);
  // New rows of every session are sent to this page while the list is up (lib/scope.ts).
  useEffect(() => scope.feed("activity"), []);

  useEffect(() => {
    const gen = ++query.current.gen;
    query.current = { kinds, sid, q, failures, since, gen };
    const ctl = new AbortController();
    const t = setTimeout(() => {
      auto.activity(asked(), { signal: ctl.signal })
        .then((r) => { if (query.current.gen === gen) { setItems(r.items); setMore(r.has_more); } })
        .catch((e) => { if (!ctl.signal.aborted) reportError(e); });
    }, q ? 200 : 0);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [kinds, sid, q, failures, since]);

  // A new row joins the list when it matches the filter; anything else leaves
  // the loaded pages as they are. A turn's alert is on the turn's row: it
  // joins that row and is no row of its own. A session held to its newest
  // rows gives up its oldest shown and counts it.
  useEffect(() => {
    if (!last) return;
    const f = query.current;
    const fold = !f.kinds.length || (f.kinds.includes("turn") && f.kinds.includes("alert"));
    if (fold && last.kind === "alert" && END_ALERTS.has(last.sub) && last.turn_event) {
      setItems((cur) => cur.map((x) => (x.kind === "turn" && x.turn_event === last.turn_event && x.session_id === last.session_id && !x.said ? { ...x, said: last.text } : x)));
      return;
    }
    if (f.failures && !bad(last)) return;
    if (f.since && last.ts < Date.now() - SINCE_MS[f.since]!) return;
    if (f.kinds.length && !f.kinds.includes(last.kind)) return;
    if (f.sid && last.session_id !== f.sid) return;
    if (f.q.trim() && !last.text.toLowerCase().includes(f.q.trim().toLowerCase())) return;
    setItems((cur) => {
      if (cur.some((x) => x.id === last.id)) return cur;
      if (f.sid) return [last, ...cur];
      // The rows shown of its session (or of its kind, for a row of no session), newest first.
      const group = (x: Activity) => x.session_id ?? x.kind;
      const mine = cur.filter((x) => group(x) === group(last));
      if (mine.length < CAP) return [last, ...cur];
      const drop = mine.at(-1)!, keep = mine.at(-2);
      return [last, ...cur.filter((x) => x !== drop).map((x) => (x === keep ? { ...x, more: (drop.more ?? 0) + 1 } : x))];
    });
    if (last.session_id && !places.some((p) => p.session_id === last.session_id)) setPlaces((p) => [{ session_id: last.session_id!, last: last.ts }, ...p]);
  }, [last]);

  const loadMore = () => {
    const gen = query.current.gen;
    const end = items.at(-1);
    auto.activity(asked(end ? `${end.ts}:${end.id}` : undefined))
      .then((r) => {
        if (query.current.gen !== gen) return;
        setItems((cur) => { const have = new Set(cur.map((x) => x.id)); return [...cur, ...r.items.filter((x) => !have.has(x.id))]; });
        setMore(r.has_more);
      })
      .catch(reportError);
  };
  const toggle = (k: Activity["kind"]) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);

  // Where the row leads is checked first: a deleted agent offers its parent
  // instead, and the panel stays open to say so.
  const open = async (a: Activity) => {
    setNotes(({ [a.id]: _, ...rest }) => rest);
    try {
      const t = await activityTarget(a.id);
      const say = (text: string, parent?: string | null) => setNotes((n) => ({ ...n, [a.id]: { text, parent } }));
      if (t.child_deleted) return say("This agent was deleted.", t.parent);
      if (!t.open) return say("This session was deleted.");
      openSession(t.open);
      onClose();
    } catch (e) {
      reportError(e, { at: "activity open" });
    }
  };

  const options = places.filter((p) => !sessions[p.session_id]?.parent_id);
  if (sid && !options.some((p) => p.session_id === sid)) options.unshift({ session_id: sid, last: 0 });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="activity">
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        {/* A phone has no room for the three in a row: the words get a row of their own, the two ranges share the next. */}
        <div className="flex gap-2 max-sm:flex-wrap">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 focus-within:border-line-strong max-sm:basis-full">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input data-testid="activity-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity" className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
          </label>
          <Select data-testid="activity-since" aria-label="Time range" value={since} onChange={(e) => setSince(e.target.value)} className="k-field w-28 text-caption text-muted max-sm:w-auto max-sm:flex-1">
            {SINCE.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <Select
            data-testid="activity-session"
            aria-label="Session"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            className="k-field w-44 text-caption text-muted max-sm:w-auto max-sm:flex-1"
          >
            <option value="">All sessions</option>
            {options.map((p) => <option key={p.session_id} value={p.session_id}>{(sessions[p.session_id]?.title || `Session ${p.session_id.slice(-6)}`).slice(0, 40)}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            data-testid="activity-failures"
            aria-pressed={failures}
            onClick={() => setFailures(!failures)}
            title="Only what went wrong: failed and declined turns, failed agents, loops and waits, refused calls, a daemon that went down"
            className={cn("flex h-6 items-center gap-1 rounded-md border px-2 text-micro", failures ? "border-st-fail/50 bg-danger-soft text-fg" : "border-line text-muted hover:bg-hover")}
          >
            <TriangleAlert className="size-3" /> Failures
          </button>
          <span className="mx-0.5 w-px self-stretch bg-line" aria-hidden />
          {KINDS.map((k) => {
            const Icon = KIND[k].icon;
            const on = kinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                data-testid={`activity-kind-${k}`}
                aria-pressed={on}
                onClick={() => toggle(k)}
                className={cn("flex h-6 items-center gap-1 rounded-md border px-2 text-micro", on ? "border-accent/50 bg-accent-soft text-fg" : "border-line text-muted hover:bg-hover")}
              >
                <Icon className="size-3" /> {KIND[k].label}
              </button>
            );
          })}
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5" data-testid="activity-list">
        {items.length === 0 && <li><Empty>{failures ? `Nothing went wrong${since ? ` in the ${SINCE.find((o) => o.value === since)!.label.toLowerCase()}` : ""}.` : kinds.length || sid || q || since ? "Nothing matches." : "Nothing yet."}</Empty></li>}
        {items.map((a) => {
          const Icon = KIND[a.kind]?.icon ?? Bell;
          const place = a.session_id ? placeName(sessions, a.session_id, a.data?.child_session, { child_title: a.data?.child_title }) : "";
          // A daemon restart: the sentence in this page's own time zone, then a line for each turn it cut, which opens its session.
          const restart = a.kind === "daemon" ? (a.data?.restart as Restart | undefined) : undefined;
          // An alert's row carries its kind's own mark and word, and its session's title once: under the text.
          const alert = a.kind === "alert" && a.sub in ALERT_LABEL ? (a.sub as Alert["kind"]) : null;
          const title = a.session_id ? sessions[a.session_id]?.title : undefined;
          const at = alert && title ? a.text.indexOf(`${title}: `) : -1;
          const cut = at >= 0 && at <= 40 ? a.text.slice(0, at) + a.text.slice(at + title!.length + 2) : a.text;
          const text = alert && cut.toLowerCase().startsWith(`${ALERT_LABEL[alert].toLowerCase()}: `) ? cut.slice(ALERT_LABEL[alert].length + 2) : cut;
          // A turn's row carries what the turn said at its end (the alert its end raised is this row, not another).
          // What it said leads; how it ended stands beside the session's name under it, so the name is said once.
          const said = a.kind === "turn" ? saidOf(a, title) : "";
          const ended = a.kind === "turn" && title && a.text.startsWith(`${title}: `) ? a.text.slice(title.length + 2) : "";
          const lead = said || (ended ? ended.charAt(0).toUpperCase() + ended.slice(1) : text);
          const body = (
            <>
              {alert
                ? <span className="mt-0.5 shrink-0"><AlertIcon kind={alert} read={!bad(a)} /></span>
                : <Icon className={cn("mt-0.5 size-3.5 shrink-0", bad(a) ? "text-danger" : "text-faint")} aria-hidden />}
              <span className="min-w-0 flex-1">
                <span dir="auto" className={cn("block text-caption leading-snug", a.kind === "turn" && "line-clamp-2")} data-testid={said ? "activity-said" : undefined}>
                  {restart ? restartSummary(restart) : <>{alert && <span className="text-muted" data-testid="activity-word">{ALERT_LABEL[alert]} </span>}{lead}</>}
                </span>
                {restart?.turns.map((t) => (
                  <button
                    key={t.end_event}
                    type="button"
                    data-testid="activity-cut-turn"
                    onClick={() => { openSession(t.session_id); onClose(); }}
                    className={cn("-mx-1 mt-0.5 block min-h-ctl-sm w-full rounded-md px-1 py-1 text-left text-micro leading-snug outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring", t.state === "held" ? "text-warn" : "text-muted")}
                  >
                    {restartTurnLine(t)}
                  </button>
                ))}
                {(place || (said && ended)) && (
                  <span className="block truncate text-micro text-faint">
                    <span data-testid="activity-place">{place}</span>
                    {said && ended && <span className={bad(a) ? "text-st-fail" : undefined} data-testid="activity-ended">{place ? ", " : ""}{ended}</span>}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-micro text-faint tabular-nums" title={when(a.ts)}>{ago(a.ts)}</span>
            </>
          );
          const n = notes[a.id];
          return (
            <li key={a.id} data-testid="activity-item" data-kind={a.kind} data-activity={a.id}>
              {a.session_id ? (
                <div className="flex items-start gap-0.5">
                  <button type="button" onClick={() => void open(a)} className="flex min-w-0 flex-1 gap-2.5 rounded-lg px-2.5 py-1 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
                    {body}
                  </button>
                  {/* The turn it happened in, kept with the row: later turns never change it. */}
                  {a.turn_event && (
                    <button
                      type="button"
                      onClick={() => { openReceipt(a.session_id!, a.turn_event!); onClose(); }}
                      aria-label="The receipt of the turn it happened in"
                      title="The receipt of the turn it happened in"
                      data-testid="activity-receipt"
                      className="k-line-act mt-0.5"
                    >
                      <ReceiptText className="size-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2.5 px-2.5 py-1">{body}</div>
              )}
              {!!a.more && (
                <button
                  type="button"
                  data-testid="activity-more"
                  onClick={() => (a.session_id ? setSid(a.session_id) : setKinds([a.kind]))}
                  title={a.session_id ? "Lists this session alone, every row" : "Lists this kind alone"}
                  className="mb-1 ml-8 block rounded-md px-1.5 py-0.5 text-left text-micro text-muted underline decoration-line-strong underline-offset-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {a.more} more {a.session_id ? `in ${title || "this session"}` : `of this kind`}
                </button>
              )}
              {n && (
                <p role="status" data-testid="activity-note" className="flex items-center gap-2 px-2.5 pb-1.5 pl-8 text-caption text-muted">
                  {n.text}
                  {n.parent && (
                    <button type="button" onClick={() => { openSession(n.parent!); onClose(); }} className="rounded-md px-1.5 py-0.5 text-accent hover:bg-raised outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Open parent
                    </button>
                  )}
                </p>
              )}
            </li>
          );
        })}
        {more && (
          <li>
            <button type="button" onClick={loadMore} className="mx-auto my-2 block rounded-md px-3 py-1 text-caption text-muted hover:bg-hover hover:text-fg">
              Older
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
