import { Bell, Bot, Coffee, Hand, Moon, Repeat, Search, Timer, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { auto, openSession, useAuto, type Activity } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn } from "../../lib/utils.ts";
import { Empty } from "./bits.tsx";

const KIND: Record<Activity["kind"], { label: string; icon: typeof Bell }> = {
  alert: { label: "Alerts", icon: Bell },
  turn: { label: "Turns", icon: Workflow },
  agent: { label: "Agents", icon: Bot },
  loop: { label: "Loops", icon: Repeat },
  wait: { label: "Waits", icon: Timer },
  approval: { label: "Approvals", icon: Hand },
  awake: { label: "Awake", icon: Coffee },
  snooze: { label: "Snooze", icon: Moon },
};
const KINDS = Object.keys(KIND) as Activity["kind"][];

const bad = (a: Activity) => /fail|error|refused/.test(a.sub) || a.sub === "denied";

// Everything that happened, across sessions, newest first: filter by kind,
// session and words; a row opens its session.
export function ActivityList({ onClose }: { onClose: () => void }) {
  const [kinds, setKinds] = useState<Activity["kind"][]>([]);
  const [sid, setSid] = useState("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(false);
  const tick = useAuto((s) => s.activityTick);
  const sessions = useStore((s) => s.sessions);
  const tops = useMemo(() => Object.values(sessions).filter((s) => !s.parent_id).sort((a, b) => b.updated - a.updated).slice(0, 100), [sessions]);

  useEffect(() => {
    const t = setTimeout(() => {
      auto.activity({ kind: kinds, session_id: sid || undefined, q: q || undefined }).then((r) => { setItems(r.items); setMore(r.has_more); }).catch(reportError);
    }, q ? 200 : 0);
    return () => clearTimeout(t);
  }, [kinds, sid, q, tick]);

  const loadMore = () =>
    auto.activity({ kind: kinds, session_id: sid || undefined, q: q || undefined, before: items.at(-1)?.ts }).then((r) => { setItems([...items, ...r.items]); setMore(r.has_more); }).catch(reportError);
  const toggle = (k: Activity["kind"]) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="activity">
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <div className="flex gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 focus-within:border-line-strong">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input data-testid="activity-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity" className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-faint" />
          </label>
          <select
            data-testid="activity-session"
            value={sid}
            onChange={(e) => setSid(e.target.value)}
            className="h-8 w-40 rounded-lg border border-line bg-bg px-2 text-caption text-muted outline-none focus:border-line-strong"
          >
            <option value="">All sessions</option>
            {tops.map((s) => <option key={s.id} value={s.id}>{(s.title || "Untitled").slice(0, 40)}</option>)}
          </select>
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
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5" data-testid="activity-list">
        {items.length === 0 && <Empty>Nothing yet.</Empty>}
        {items.map((a) => {
          const Icon = KIND[a.kind]?.icon ?? Bell;
          const title = a.session_id ? sessions[a.session_id]?.title : undefined;
          return (
            <div
              key={a.id}
              role={a.session_id ? "button" : undefined}
              tabIndex={a.session_id ? 0 : undefined}
              data-testid="activity-item"
              data-kind={a.kind}
              onClick={() => { if (a.session_id) { openSession(a.data?.child_session ?? a.session_id); onClose(); } }}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
              className={cn("flex gap-2.5 rounded-lg px-2.5 py-1.5 outline-none", a.session_id && "cursor-default hover:bg-hover")}
            >
              <Icon className={cn("mt-0.5 size-3.5 shrink-0", bad(a) ? "text-danger" : "text-faint")} />
              <div className="min-w-0 flex-1">
                <p className="text-caption leading-snug">{a.text}</p>
                {title && <p className="truncate text-micro text-faint">{title}</p>}
              </div>
              <span className="shrink-0 text-micro text-faint tabular-nums" title={new Date(a.ts).toLocaleString()}>{ago(a.ts)}</span>
            </div>
          );
        })}
        {more && (
          <button type="button" onClick={loadMore} className="mx-auto my-2 block rounded-md px-3 py-1 text-caption text-muted hover:bg-hover hover:text-fg">
            Older
          </button>
        )}
      </div>
    </div>
  );
}
