// The session's agents in the session itself, over its box: how many work, wait, need the owner, failed or are
// done, each as the state's dot and its count, in the words of the one vocabulary. A press opens the agents (the
// background popup: each agent, its state, open, stop). The sidebar says nothing of how many agents a session
// has: its row only has a chevron that opens their tree.
import { Popover } from "@base-ui/react/popover";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { isCounted } from "../../../../src/core/agent-count.ts";
import { agentTally, backgroundOf, WAITING_ON_AGENTS } from "../../../../src/core/state-words.ts";
import { useAuto } from "../../lib/automation.ts";
import { useSessionState, useToldStates } from "../../lib/watch.ts";
import { useStore } from "../../lib/store.ts";
import { Mark } from "../Mark.tsx";
import { agentSaid } from "./bits.tsx";
import { BackgroundPopup, useBackground } from "./BackgroundPopover.tsx";

// The tally of the agents the session's counts name (src/core/agent-count.ts), its tree's included; null with none.
export function useAgentsTally(sessionId: string) {
  const { agents } = useBackground(sessionId);
  const told = useToldStates();
  return useMemo(() => {
    const counted = agents.filter((a) => isCounted(a));
    return counted.length ? agentTally(counted.map((a) => agentSaid(a, told[a.session_id]).watch)) : null;
  }, [agents, told]);
}

export function AgentsDock({ sessionId }: { sessionId: string }) {
  const bg = useBackground(sessionId);
  const tally = useAgentsTally(sessionId);
  const session = useStore((s) => s.sessions[sessionId]);
  const st = useSessionState(session);
  // The session's own turn is at rest and it waits on them: the line says it, as its row's dot does.
  const waiting = backgroundOf(st) === "agents";
  if (!tally) return null;
  return (
    <Popover.Root>
      <Popover.Trigger className="k-docket-line k-agents-line" data-testid="dock-agents" aria-label={tally.text} aria-description={waiting ? WAITING_ON_AGENTS : undefined} title={tally.text}>
        <span className="k-agents-label">Agents</span>
        <span className="k-agents-parts" data-testid="dock-agents-summary">
          {tally.parts.map((p) => (
            <span key={p.w} className="k-agents-part" data-watch={p.w} data-count={p.n} data-testid="dock-agents-part">
              <Mark w={p.w} />{p.text}
            </span>
          ))}
        </span>
        {waiting && <span className="k-agents-waits" data-testid="dock-agents-waiting">{WAITING_ON_AGENTS}</span>}
        <ChevronRight className="k-docket-more" aria-hidden="true" />
      </Popover.Trigger>
      <BackgroundPopup sessionId={sessionId} agents={bg.agents} waits={bg.waits} loops={bg.loops} side="top" />
    </Popover.Root>
  );
}
