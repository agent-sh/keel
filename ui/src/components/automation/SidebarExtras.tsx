import { Bell, ChevronRight, Repeat } from "lucide-react";
import { useMemo, useState } from "react";
import { auto, isLive, openSession, useAuto } from "../../lib/automation.ts";
import { useStore } from "../../lib/store.ts";
import { cn } from "../../lib/utils.ts";
import { AgentStatus, IconButton, StopIcon } from "./bits.tsx";
import { InboxPanel } from "./InboxPanel.tsx";
import { LoopsPanel } from "./LoopsPanel.tsx";

// Under a session row: the agents it started, live, with stop. Children never
// appear in the top-level list and never count as unread on their own.
export function SessionChildren({ parentId, current }: { parentId: string; current: string | null }) {
  const onPick = openSession;
  const all = useAuto((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  const kids = useMemo(() => Object.values(all).filter((a) => a.parent_id === parentId).sort((a, b) => a.created - b.created), [all, parentId]);
  const live = kids.filter(isLive).length;
  const holdsCurrent = kids.some((k) => k.session_id === current);
  const [open, setOpen] = useState<boolean | null>(null);
  if (!kids.length) return null;
  const expanded = open ?? (live > 0 || holdsCurrent || current === parentId);
  return (
    <div className="ml-3 border-l border-line pl-2" data-testid="session-children">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-caption text-faint hover:text-muted"
      >
        <ChevronRight className={cn("size-3 transition-transform", expanded && "rotate-90")} />
        {kids.length} agent{kids.length > 1 ? "s" : ""}
        {live > 0 && <span className="text-accent">· {live} running</span>}
      </button>
      {expanded && kids.map((a) => (
        <div
          key={a.id}
          role="button"
          tabIndex={0}
          data-testid="child-session"
          onClick={() => onPick(a.session_id)}
          onKeyDown={(e) => e.key === "Enter" && onPick(a.session_id)}
          className={cn(
            "group/child flex items-center gap-2 rounded-md px-1.5 py-1 text-caption cursor-default outline-none",
            "hover:bg-raised",
            current === a.session_id && "bg-raised shadow-1",
          )}
        >
          <AgentStatus status={a.status} />
          <span className={cn("min-w-0 flex-1 truncate", !isLive(a) && "text-muted")}>{sessions[a.session_id]?.title || a.title}</span>
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
  return (
    <>
      {(loops || waits) && <Repeat className="size-3 shrink-0 text-faint" aria-label="Scheduled work" />}
      {unread > 0 && <span data-testid="unread-dot" title={`${unread} unread`} className="size-2 shrink-0 rounded-full bg-accent" />}
    </>
  );
}

// Inbox and Loops buttons with their panels.
export function AutomationFooter() {
  const [inbox, setInbox] = useState(false);
  const [loops, setLoops] = useState(false);
  return (
    <>
      <FooterButtons onInbox={() => setInbox(true)} onLoops={() => setLoops(true)} />
      <InboxPanel open={inbox} onOpenChange={setInbox} />
      <LoopsPanel open={loops} onOpenChange={setLoops} />
    </>
  );
}

function FooterButtons({ onInbox, onLoops }: { onInbox: () => void; onLoops: () => void }) {
  const unread = useAuto((s) => s.unread.total);
  const loops = useAuto((s) => Object.values(s.loops).filter((l) => l.enabled).length);
  return (
    <>
      <button
        type="button"
        data-testid="inbox-button"
        onClick={onInbox}
        title="Inbox"
        className={cn("relative flex items-center gap-1.5 rounded-md px-2 py-1 text-caption hover:bg-raised", unread ? "text-fg" : "text-faint")}
      >
        <Bell className="size-3.5" />
        {unread > 0 && <span data-testid="inbox-count" className="rounded-full bg-accent px-1.5 text-micro font-semibold leading-4 text-accent-fg tabular-nums">{unread}</span>}
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
