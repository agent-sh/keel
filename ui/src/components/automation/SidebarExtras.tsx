import { Bell, BellOff, ChevronRight, Moon, Repeat } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { auto, isLive, openSession, snoozeText, useAuto } from "../../lib/automation.ts";
import { useStore } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { AgentStatus, ALERT_STATE, IconButton, StopIcon } from "./bits.tsx";
import { Mark } from "../Mark.tsx";
import { Where } from "../Where.tsx";

// The panels load the first time they open.
const InboxPanel = lazy(() => import("./InboxPanel.tsx").then((m) => ({ default: m.InboxPanel })));
const LoopsPanel = lazy(() => import("./LoopsPanel.tsx").then((m) => ({ default: m.LoopsPanel })));

// Under a session row: the agents it started, live, with stop. Children never
// appear in the top-level list and never count as unread on their own. The
// list is folded to its count until the owner opens it; their choice is kept
// per session. Folded, a working agent shows as a turning mark on the count.
const OPEN_KEY = "keel.agentsOpen";
const openKept = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}"); } catch { return {}; } };
export function SessionChildren({ parentId, current }: { parentId: string; current: string | null }) {
  const onPick = openSession;
  const all = useAuto((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  // Which agent the parent's unread alerts came from (looking is not reading).
  const unread = useAuto((s) => s.unread.children ?? {});
  const kids = useMemo(() => Object.values(all).filter((a) => a.parent_id === parentId).sort((a, b) => a.created - b.created), [all, parentId]);
  // The summary says how many run and how many wait.
  const running = kids.filter((k) => k.status === "running").length;
  const waiting = kids.filter((k) => k.status === "waiting").length;
  const viewing = kids.find((k) => k.session_id === current);
  const [expanded, setExpanded] = useState(() => openKept()[parentId] === true);
  const setOpen = (o: boolean) => {
    setExpanded(o);
    const m = openKept();
    if (o) m[parentId] = true; else delete m[parentId];
    localStorage.setItem(OPEN_KEY, JSON.stringify(m));
  };
  if (!kids.length) return null;
  return (
    <div className="ml-3 border-l border-line pl-2" data-testid="session-children">
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="children-toggle"
        onClick={() => setOpen(!expanded)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-caption text-faint hover:text-muted"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")} />
        {!expanded && running > 0 && <Mark w="work" className="size-2 border-[1.5px]" />}
        <span className="shrink-0">{kids.length} agent{kids.length > 1 ? "s" : ""}</span>
        {running > 0 && <span className="shrink-0 text-accent">· {running} running</span>}
        {waiting > 0 && <span className="shrink-0 text-warn">· {waiting} waiting</span>}
        {!expanded && viewing && <span className="min-w-0 truncate text-fg" data-testid="children-viewing">· viewing {sessions[viewing.session_id]?.title || viewing.title}</span>}
      </button>
      {expanded && kids.map((a) => (
        <div
          key={a.id}
          role="button"
          tabIndex={0}
          data-testid="child-session"
          onClick={() => onPick(a.session_id)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onPick(a.session_id);
          }}
          className={cn(
            "group/child flex items-center gap-2 rounded-md px-1.5 py-1 text-caption cursor-default outline-none",
            "hover:bg-raised",
            current === a.session_id && "bg-raised shadow-1",
          )}
        >
          <AgentStatus status={a.status} />
          <span className={cn("min-w-0 flex-1 truncate", !isLive(a) && !unread[a.session_id] && "text-muted", unread[a.session_id] && "font-medium text-fg")}>{sessions[a.session_id]?.title || a.title}</span>
          {/* Its parent's section says where it runs; only an agent placed elsewhere names its machine. */}
          {(sessions[a.session_id]?.machine ?? a.machine ?? undefined) !== (sessions[parentId]?.machine ?? undefined) && <Where s={{ machine: sessions[a.session_id]?.machine ?? a.machine }} />}
          {unread[a.session_id] ? (
            <span data-testid="child-unread" title={`${unread[a.session_id]} unread`} className="flex shrink-0 items-center">
              <span className="size-1.5 rounded-full bg-accent" aria-hidden />
              <span className="sr-only">{unread[a.session_id]} unread</span>
            </span>
          ) : null}
          {isLive(a) && (
            <span className="hidden group-hover/child:block">
              <IconButton title="Stop agent" danger onClick={() => auto.stopAgent(a)} testid="child-stop"><StopIcon /></IconButton>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// On a session row: unread alerts and scheduled work.
export function SessionBadges({ sessionId }: { sessionId: string }) {
  const unread = useAuto((s) => s.unread.sessions[sessionId] ?? 0);
  const loops = useAuto((s) => Object.values(s.loops).some((l) => l.session_id === sessionId && l.enabled));
  const waits = useAuto((s) => Object.values(s.waits).some((w) => w.session_id === sessionId && w.status === "active"));
  const snoozed = useAuto((s) => s.snoozes[sessionId]);
  return (
    <>
      {snoozed && !snoozed.suspended && <Moon data-testid="snoozed-mark" className="size-3 shrink-0 text-faint" aria-label={`Snoozed ${snoozeText(snoozed)}`} />}
      {(loops || waits) && <Repeat className="size-3 shrink-0 text-faint" aria-label="Scheduled work" />}
      {unread > 0 && <span data-testid="unread-dot" title={`${unread} unread`} className="size-2 shrink-0 rounded-full bg-accent" />}
    </>
  );
}

// Inbox and Loops buttons with their panels.
export function AutomationFooter() {
  const [inbox, setInbox] = useState(false);
  const [loops, setLoops] = useState(false);
  const [seen, setSeen] = useState({ inbox: false, loops: false });
  if ((inbox && !seen.inbox) || (loops && !seen.loops)) setSeen({ inbox: seen.inbox || inbox, loops: seen.loops || loops });
  return (
    <>
      <FooterButtons onInbox={() => setInbox(true)} onLoops={() => setLoops(true)} />
      <Suspense fallback={null}>
        {seen.inbox && <InboxPanel open={inbox} onOpenChange={setInbox} />}
        {seen.loops && <LoopsPanel open={loops} onOpenChange={setLoops} />}
      </Suspense>
    </>
  );
}

function FooterButtons({ onInbox, onLoops }: { onInbox: () => void; onLoops: () => void }) {
  const unread = useAuto((s) => s.unread.total);
  const loops = useAuto((s) => Object.values(s.loops).filter((l) => l.enabled).length);
  const held = useAuto((s) => !!s.snoozes["*"]);
  // The count takes the color of the most urgent unread alert.
  const top = useAuto((s) => {
    const ws = new Set(s.alerts.filter((a) => !a.read).map((a) => ALERT_STATE[a.kind]));
    return (["need", "fail", "work", "done"] as const).find((w) => ws.has(w)) ?? "idle";
  });
  return (
    <>
      <button
        type="button"
        data-testid="inbox-button"
        onClick={onInbox}
        title={held ? "Inbox: alerts are snoozed" : "Inbox"}
        className={cn("relative flex items-center gap-1.5 rounded-md px-2 py-1 text-caption hover:bg-raised", unread ? "text-fg" : "text-faint")}
      >
        {held ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
        {unread > 0 && <span data-testid="inbox-count" data-watch={top} className="k-inbox-count tabular-nums">{unread}</span>}
      </button>
      <button
        type="button"
        data-testid="loops-button"
        onClick={onLoops}
        title="Loops"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-caption text-faint hover:bg-raised hover:text-fg"
      >
        <Repeat className="size-3.5" />
        {loops > 0 && <span className="tabular-nums">{loops}</span>}
      </button>
    </>
  );
}
