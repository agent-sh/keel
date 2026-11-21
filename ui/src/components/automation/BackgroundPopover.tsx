import { Popover } from "@base-ui/react/popover";
import { Activity, ExternalLink, Pause, Play, Repeat, Timer, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { auto, inMs, isLive, openSession, useAuto, type LoopRecord, type WaitRecord } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, cn } from "../../lib/utils.ts";
import { AgentStatus, Empty, IconButton, SectionTitle, STATUS_LABEL, StopIcon } from "./bits.tsx";

export function waitLabel(w: WaitRecord): string {
  const s: any = w.spec;
  switch (w.kind) {
    case "timer": return `Timer ${new Date(s.at_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    case "file": return s.contains ? `File contains "${s.contains}" · ${s.path}` : `File exists · ${s.path}`;
    case "log": return `Log ${s.path} /${s.match}/`;
    case "http": return `HTTP ${s.status ?? "2xx/3xx"} · ${s.url}`;
    case "process": return `Process ${s.pid}`;
    case "monitor": return `Monitor ${s.command}`;
    case "websocket": return `Socket ${s.url}${s.match ? ` /${s.match}/` : ""}`;
    case "pr_checks": return `Checks of ${s.repo}#${s.pr_number}`;
    case "session": return `${s.message_id ? "Handled by" : "Idle"} ${s.title || s.session}`;
  }
}

function LoopRow({ l }: { l: LoopRecord }) {
  const act = (p: Promise<unknown>) => p.catch(reportError);
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-ui hover:bg-hover" data-testid="bg-loop">
      <Repeat className={cn("size-3.5 shrink-0", l.enabled ? "text-accent" : "text-faint")} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{l.name}</div>
        <div className="truncate text-micro text-faint">
          {l.schedule_text} · {l.enabled ? (l.next_ms ? `next ${inMs(l.next_ms)}` : l.last_status === "running" ? "running" : "waiting") : (l.disabled_reason ?? "paused")} · {l.runs} run{l.runs === 1 ? "" : "s"}
        </div>
      </div>
      <IconButton title="Run now" onClick={() => act(auto.runLoop(l.id))}><Play className="size-3.5" /></IconButton>
      <IconButton title={l.enabled ? "Pause" : "Resume"} onClick={() => act(auto.patchLoop(l.id, { enabled: !l.enabled }))}>
        {l.enabled ? <Pause className="size-3.5" /> : <Repeat className="size-3.5" />}
      </IconButton>
      <IconButton title="Delete loop" danger onClick={() => act(auto.deleteLoop(l.id))}><Trash2 className="size-3.5" /></IconButton>
    </div>
  );
}

// A session's background work, and how much of it runs now.
function useBackground(sessionId: string) {
  const allAgents = useAuto((s) => s.agents);
  const allWaits = useAuto((s) => s.waits);
  const allLoops = useAuto((s) => s.loops);
  const agents = useMemo(() => Object.values(allAgents).filter((a) => a.parent_id === sessionId).sort((a, b) => b.created - a.created), [allAgents, sessionId]);
  const waits = useMemo(() => Object.values(allWaits).filter((w) => w.session_id === sessionId && w.status === "active"), [allWaits, sessionId]);
  const loops = useMemo(() => Object.values(allLoops).filter((l) => l.session_id === sessionId), [allLoops, sessionId]);
  return { agents, waits, loops, live: agents.filter(isLive).length + waits.length + loops.filter((l) => l.enabled).length };
}
// How much runs in the background now: the header says it when the button itself is folded away.
export const useBackgroundLive = (sessionId: string) => useBackground(sessionId).live;

// The session's background work: agents, waits and monitors, loops.
export function BackgroundButton({ sessionId }: { sessionId: string }) {
  const { agents, waits, loops, live } = useBackground(sessionId);
  const sessions = useStore((s) => s.sessions);
  if (!agents.length && !waits.length && !loops.length) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="background-button"
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption outline-none transition-colors",
          live ? "border-accent/40 bg-accent-soft text-accent" : "border-line text-faint hover:text-fg",
                  )}
      >
        {live ? <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" /> : <Activity className="size-3.5" />}
        {live ? `${live} in background` : "Background"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup
            data-testid="background-popup"
            className={cn(
              "w-[min(26rem,calc(100vw-1rem))] max-h-[70vh] overflow-y-auto rounded-lg border border-line bg-raised pb-2 shadow-3 outline-none",
              "origin-[var(--transform-origin)] transition-[scale,opacity] duration-150 data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0",
            )}
          >
            <SectionTitle>Agents</SectionTitle>
            {agents.length === 0 && <Empty>No agents.</Empty>}
            {agents.map((a) => (
              <div
                key={a.id}
                role="button"
                tabIndex={0}
                onClick={() => openSession(a.session_id)}
                onKeyDown={(e) => e.key === "Enter" && openSession(a.session_id)}
                className="flex cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-ui hover:bg-hover"
                data-testid="bg-agent"
              >
                <AgentStatus status={a.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate" data-testid="bg-agent-title">{sessions[a.session_id]?.title || a.title}</div>
                  <div className="truncate text-micro text-faint">{STATUS_LABEL[a.status]} · {a.type} · {ago(a.created)}</div>
                </div>
                {isLive(a) && <IconButton title="Stop agent" danger onClick={() => auto.stopAgent(a).catch(reportError)} testid="bg-agent-stop"><StopIcon /></IconButton>}
                <ExternalLink className="size-3.5 shrink-0 text-faint" />
              </div>
            ))}
            {waits.length > 0 && <SectionTitle>Waiting on</SectionTitle>}
            {waits.map((w) => (
              <div key={w.id} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-ui hover:bg-hover" data-testid="bg-wait">
                <Timer className="size-3.5 shrink-0 text-warn" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-caption">{waitLabel(w)}</div>
                  <div className="truncate text-micro text-faint">
                    {w.note || "no note"} · {w.kind === "monitor" || w.kind === "websocket" ? `${w.events} events · ` : ""}
                    {/* A timer fires at its time (on the next check), it does not give up. */}
                    {w.kind === "timer" ? `due ${inMs((w.spec as any).at_ms)}, fires on the next check` : `gives up ${inMs(w.deadline)}`}{w.last_error ? ` · ${w.last_error}` : ""}
                  </div>
                </div>
                <IconButton title="Cancel" danger onClick={() => auto.cancelWait(w.id).catch(reportError)}><X className="size-3.5" /></IconButton>
              </div>
            ))}
            {loops.length > 0 && <SectionTitle>Loops</SectionTitle>}
            {loops.map((l) => <LoopRow key={l.id} l={l} />)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export { LoopRow };
