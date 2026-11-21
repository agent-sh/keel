import { Bell, Bot, Coffee, Hand, Moon, Power, ReceiptText, Repeat, Search, Timer, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { activityTarget, auto, openSession, placeName, useAuto, type Activity, type Alert } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
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
};
const KINDS = Object.keys(KIND) as Activity["kind"][];

const bad = (a: Activity) => /fail|error|refused/.test(a.sub) || a.sub === "denied" || (a.kind === "daemon" && (a.sub === "killed" || a.sub === "crash"));

// Everything that happened, across sessions, newest first: filter by kind,
// session and words; a row opens its session (or the agent inside it).
export function ActivityList({ onClose }: { onClose: () => void }) {
  const [kinds, setKinds] = useState<Activity["kind"][]>([]);
  const [sid, setSid] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const [notes, setNotes] = useState<Record<string, { text: string; parent?: string | null }>>({});
  const [places, setPlaces] = useState<{ session_id: string; last: number }[]>([]);
  const last = useAuto((s) => s.lastActivity);
  const sessions = useStore((s) => s.sessions);
  // The filter as one query: a reply is taken only while its query is current.
  const query = useRef({ kinds, sid, q, gen: 0 });

  useEffect(() => {
    auto.activitySessions().then((r) => setPlaces(r.sessions)).catch(reportError);
  }, []);

  useEffect(() => {
    const gen = ++query.current.gen;
    query.current = { kinds, sid, q, gen };
    const ctl = new AbortController();
    const t = setTimeout(() => {
      auto.activity({ kind: kinds, session_id: sid || undefined, q: q || undefined }, { signal: ctl.signal })
        .then((r) => { if (query.current.gen === gen) { setItems(r.items); setMore(r.has_more); } })
        .catch((e) => { if (!ctl.signal.aborted) reportError(e); });
    }, q ? 200 : 0);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [kinds, sid, q]);

  // A new row joins the list when it matches the filter; anything else leaves
  // the loaded pages as they are.
  useEffect(() => {
    if (!last) return;
    const f = query.current;
    if (f.kinds.length && !f.kinds.includes(last.kind)) return;
    if (f.sid && last.session_id !== f.sid) return;
    if (f.q.trim() && !last.text.toLowerCase().includes(f.q.trim().toLowerCase())) return;
    setItems((cur) => (cur.some((x) => x.id === last.id) ? cur : [last, ...cur]));
    if (last.session_id && !places.some((p) => p.session_id === last.session_id)) setPlaces((p) => [{ session_id: last.session_id!, last: last.ts }, ...p]);
  }, [last]);

  const loadMore = () => {
    const gen = query.current.gen;
    const end = items.at(-1);
    auto.activity({ kind: kinds, session_id: sid || undefined, q: q || undefined, before: end ? `${end.ts}:${end.id}` : undefined })
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
        <div className="flex gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 focus-within:border-line-strong">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input data-testid="activity-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity" className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
          </label>
          <Select
            data-testid="activity-session"
            aria-label="Session"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            className="h-8 w-44 rounded-lg border border-line bg-bg px-2 text-caption text-muted outline-none focus:border-line-strong"
          >
            <option value="">All sessions</option>
            {options.map((p) => <option key={p.session_id} value={p.session_id}>{(sessions[p.session_id]?.title || `Session ${p.session_id.slice(-6)}`).slice(0, 40)}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap gap-1">
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
        {items.length === 0 && <li><Empty>Nothing yet.</Empty></li>}
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
          const body = (
            <>
              {alert
                ? <span className="mt-0.5 shrink-0"><AlertIcon kind={alert} read={!bad(a)} /></span>
                : <Icon className={cn("mt-0.5 size-3.5 shrink-0", bad(a) ? "text-danger" : "text-faint")} aria-hidden />}
              <span className="min-w-0 flex-1">
                <span dir="auto" className="block text-caption leading-snug">{restart ? restartSummary(restart) : <>{alert && <span className="text-muted" data-testid="activity-word">{ALERT_LABEL[alert]} </span>}{text}</>}</span>
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
                {place && <span className="block truncate text-micro text-faint" data-testid="activity-place">{place}</span>}
              </span>
              <span className="shrink-0 text-micro text-faint tabular-nums" title={when(a.ts)}>{ago(a.ts)}</span>
            </>
          );
          const n = notes[a.id];
          return (
            <li key={a.id} data-testid="activity-item" data-kind={a.kind} data-activity={a.id}>
              {a.session_id ? (
                <div className="flex items-start gap-0.5">
                  <button type="button" onClick={() => void open(a)} className="flex min-w-0 flex-1 gap-2.5 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
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
                      className="mt-1 grid size-6 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ReceiptText className="size-3.5" />
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2.5 px-2.5 py-1.5">{body}</div>
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
