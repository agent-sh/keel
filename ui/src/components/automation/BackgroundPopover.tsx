import { Popover } from "@base-ui/react/popover";
import { Activity, ExternalLink, Pause, Play, Repeat, Timer, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { auto, inMs, isLive, openSession, useAuto, type LoopRecord, type WaitRecord } from "../../lib/automation.ts";
import { reportError, useStore } from "../../lib/store.ts";
import { ago, clock, cn } from "../../lib/utils.ts";
import { STATE_WORD } from "../../../../src/core/state-words.ts";
import { useToldStates } from "../../lib/watch.ts";
import { AgentMark, agentSaid, Empty, IconButton, SectionTitle, StopAgent } from "./bits.tsx";

export function waitLabel(w: WaitRecord): string {
  const s: any = w.spec;
  switch (w.kind) {
    case "timer": return `Timer ${clock(s.at_ms, { seconds: true })}`;
    case "file": return s.contains ? `File contains "${s.contains}" · ${s.path}` : `File exists · ${s.path}`;
    case "log": return `Log ${s.path} /${s.match}/`;
    case "http": return `HTTP ${s.status ?? "2xx/3xx"} · ${s.url}`;
    case "process": return `Process ${s.pid}`;
    case "monitor": return `Monitor ${s.command}`;
    case "websocket": return `Socket ${s.url}${s.match ? ` /${s.match}/` : ""}`;
    case "pr_checks": return `Checks of ${s.repo}#${s.pr_number}`;
    case "session": return `Until ${s.title || s.session} ${s.message_id ? "handles it" : "is at rest"}`;
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
          {l.schedule_text} · {l.enabled ? (l.next_ms ? `next ${inMs(l.next_ms)}` : (l.last_status === "running" ? STATE_WORD.work : STATE_WORD.wait).toLowerCase()) : (l.disabled_reason ?? "paused")} · {l.runs} run{l.runs === 1 ? "" : "s"}
        </div>
      </div>
      <IconButton title="Run now" onClick={() => act(auto.runLoop(l.id))}><Play className="size-3.5" /></IconButton>
      <IconButton title={l.enabled ? "Turn off" : "Turn on"} onClick={() => act(auto.patchLoop(l.id, { enabled: !l.enabled }))}>
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
  const out = agents.filter(isLive).length, on = loops.filter((l) => l.enabled).length;
  // What the count on the button counts, said on it: the agents still out, the waits armed and the loops turned on.
  const n = (k: number, one: string) => (k ? `${k} ${one}${k === 1 ? "" : "s"}` : "");
  const counts = [n(out, "agent"), n(waits.length, "wait"), n(on, "loop")].filter(Boolean).join(", ");
  return { agents, waits, loops, live: out + waits.length + on, counts };
}
// How much runs in the background now: the header says it when the button itself is folded away.
export const useBackgroundLive = (sessionId: string) => useBackground(sessionId).live;

// The session's background work: agents, waits and monitors, loops.
export function BackgroundButton({ sessionId }: { sessionId: string }) {
  const { agents, waits, loops, live, counts } = useBackground(sessionId);
  const sessions = useStore((s) => s.sessions);
  const told = useToldStates();
  if (!agents.length && !waits.length && !loops.length) return null;

  return (
    <Popover.Root>
      <Popover.Trigger
        data-testid="background-button"
        title={live ? `In the background: ${counts}` : "Background work of this session"}
        aria-label={live ? `${live} in background: ${counts}` : "Background work of this session"}
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
            {agents.map((a) => {
              // The agent's state in the word its tree row and its card use (src/core/state-words.ts).
              const st = agentSaid(a, told[a.session_id]);
              const title = sessions[a.session_id]?.title || a.title;
              return (
                // The row opens the agent; Stop is a control of its own beside it. Every row keeps Stop's place, so the words line up.
                <div key={a.id} className="flex items-center gap-1 rounded-lg pr-2 hover:bg-hover" data-testid="bg-agent" data-watch={st.watch}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => openSession(a.session_id)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(a.session_id); } }}
                    aria-label={`Open ${title}, ${st.title}`}
                    className="flex min-w-0 flex-1 cursor-default items-center gap-2 rounded-lg px-3 py-1.5 text-ui outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="bg-agent-open"
                  >
                    <AgentMark w={st.watch} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate" data-testid="bg-agent-title">{title}</div>
                      <div className="truncate text-micro text-faint" title={st.title}><span data-testid="bg-agent-state">{st.phrase}</span> · {a.type} · {ago(a.created)}</div>
                    </div>
                    <ExternalLink className="size-3.5 shrink-0 text-faint" />
                  </div>
                  <span className="grid size-6 shrink-0 place-items-center">{isLive(a) && <StopAgent a={a} title={title} testid="bg-agent-stop" />}</span>
                </div>
              );
            })}
            {waits.length > 0 && <SectionTitle>{STATE_WORD.wait} for</SectionTitle>}
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
