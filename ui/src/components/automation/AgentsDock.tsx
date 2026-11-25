// The session's agents in the session itself, over its box: each live agent (at work, waiting, needing the owner,
// or failed and not looked at) by its name and its state's dot, a press on it opens that agent. The word Agents
// opens all of them (the background popup: each agent, its state, open, stop, the done ones too). The sidebar
// says nothing of how many agents a session has: its row only has a chevron that opens their tree.
import { Popover } from "@base-ui/react/popover";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { isCounted } from "../../../../src/core/agent-count.ts";
import { agentTally, backgroundOf, WAITING_ON_AGENTS } from "../../../../src/core/state-words.ts";
import type { Watch } from "../../../../src/core/watch.ts";
import { useAuto } from "../../lib/automation.ts";
import { useSessionState, useToldStates } from "../../lib/watch.ts";
import { useStore } from "../../lib/store.ts";
import { openSession } from "../../lib/automation.ts";
import { Mark } from "../Mark.tsx";
import { agentSaid } from "./bits.tsx";
import { BackgroundPopup, useBackground } from "./BackgroundPopover.tsx";
import { useFocus } from "../../lib/focus.ts";

// The tally of the agents the session's counts name (src/core/agent-count.ts), its tree's included; null with none.
// `shown` is what the line draws: only what is live or owed to the owner (needs you, working, waiting, and a failure
// the owner has not looked at). Done and stopped agents stay in the popup the line opens, and in `text`.
export function useAgentsTally(sessionId: string) {
  const { agents } = useBackground(sessionId);
  const told = useToldStates();
  const seen = useStore((s) => s.sessions[sessionId]?.settings.agents_fail_seen_ms ?? 0);
  return useMemo(() => {
    const counted = agents.filter((a) => isCounted(a)).map((a) => ({ a, w: agentSaid(a, told[a.session_id]).watch }));
    if (!counted.length) return null;
    const owed = counted.filter(({ a, w }) => (w === "fail" || w === "declined" ? (a.ended ?? 0) > seen : LINE.has(w)));
    return { ...agentTally(counted.map((c) => c.w)), shown: agentTally(owed.map((c) => c.w)).parts, named: owed.map(({ a, w }) => ({ id: a.session_id, title: a.title, w })) };
  }, [agents, told, seen]);
}
const LINE = new Set<Watch>(["need", "work", "wait", "resume"]);

export function AgentsDock({ sessionId }: { sessionId: string }) {
  const bg = useBackground(sessionId);
  const tally = useAgentsTally(sessionId);
  const session = useStore((s) => s.sessions[sessionId]);
  const titles = useStore((s) => s.sessions);
  const st = useSessionState(session);
  // The session's own turn is at rest and it waits on them: the line below says it, as its row's dot does.
  const waiting = backgroundOf(st) === "agents";
  // Focus: one quiet item, the word and how many are live; the names and their dots are in the popup it opens.
  const calm = useFocus();
  if (!tally) return null;
  if (calm) {
    return (
      <div className="k-docket-line k-agents-line" data-testid="dock-agents-line" data-calm="">
        <Popover.Root>
          <Popover.Trigger className="k-agents-all" data-testid="dock-agents" aria-label={`Agents: ${tally.text}`} aria-description={waiting ? WAITING_ON_AGENTS : undefined} title={tally.text}>
            <span className="k-agents-label">Agents</span>
            {tally.named.length > 0 && <span className="k-agents-count tabular-nums" data-testid="dock-agents-count">{tally.named.length}</span>}
            <ChevronRight className="k-docket-more" aria-hidden="true" />
          </Popover.Trigger>
          <BackgroundPopup sessionId={sessionId} agents={bg.agents} waits={bg.waits} loops={bg.loops} side="top" />
        </Popover.Root>
      </div>
    );
  }
  return (
    <div className="k-docket-line k-agents-line" data-testid="dock-agents-line">
      <Popover.Root>
        <Popover.Trigger className="k-agents-all" data-testid="dock-agents" aria-label={`Agents: ${tally.text}`} aria-description={waiting ? WAITING_ON_AGENTS : undefined} title={tally.text}>
          <span className="k-agents-label">Agents</span>
          <ChevronRight className="k-docket-more" aria-hidden="true" />
        </Popover.Trigger>
        <BackgroundPopup sessionId={sessionId} agents={bg.agents} waits={bg.waits} loops={bg.loops} side="top" />
      </Popover.Root>
      <span className="k-agents-parts" data-testid="dock-agents-summary">
        {tally.named.map((n) => {
          const title = titles[n.id]?.title || n.title || "Agent";
          return (
            <button key={n.id} type="button" className="k-agents-part" data-watch={n.w} data-testid="dock-agent" title={`Open ${title}`} onClick={() => openSession(n.id)}>
              <Mark w={n.w} /><span className="k-agents-name">{title}</span>
            </button>
          );
        })}
        {!tally.named.length && <span className="k-agents-none" data-testid="dock-agents-none">none running</span>}
      </span>
    </div>
  );
}
