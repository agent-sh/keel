import { Bot } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { openSession, useAuto } from "../../lib/automation.ts";
import { below } from "../../lib/agent-tree.ts";
import { safety, useSafety } from "../../lib/safety.ts";
import { useStore } from "../../lib/store.ts";
import { stateWords } from "../../../../src/core/state-words.ts";
const Questions = lazy(() => import("../QuestionCard.tsx").then((m) => ({ default: m.Questions })));
const Approvals = lazy(() => import("../ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

// What the session's whole tree of agents waits on, each card named by the agent that asks and its
// place in the tree (the agents between this session and it): approvals and questions are answered
// here, as in the agent's own pane, with the same keys and the same permission. The cards come by the
// frames every page hears (an approval, the open questions, the agents' records); what an agent's card
// needs beyond them is read from the daemon only while that agent asks.
export function ChildApprovals({ parentId }: { parentId: string }) {
  const all = useAuto((s) => s.agents);
  const open = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionCalls);
  // The tree is walked only while something waits: agents' records change all the time.
  const waiting = Object.values(open).some((l) => l.length) || Object.values(questions).some((l) => l.length);
  const tree = useMemo(() => (waiting ? below(all, parentId) : []), [all, parentId, waiting]);
  const sessions = useStore((s) => s.sessions);
  // An agent's cards come by frames, as every session's do (the page reads all the open cards
  // when its socket opens): nothing is read for an agent that asks nothing. One that asks is
  // watched while it asks, so a reconnect reads its cards again, and only the ones that began
  // or stopped asking are touched: twelve agents turning over read nothing.
  const asks = tree.filter((n) => open[n.agent.session_id]?.length).map((n) => n.agent.session_id).sort().join(",");
  const watched = useRef(new Map<string, () => void>());
  useEffect(() => {
    const want = new Set(asks.split(",").filter(Boolean));
    for (const [id, release] of watched.current) if (!want.has(id)) { release(); watched.current.delete(id); }
    for (const id of want) if (!watched.current.has(id)) watched.current.set(id, safety.watch(id));
  }, [asks]);
  useEffect(() => () => { for (const release of watched.current.values()) release(); watched.current.clear(); }, []);
  const asking = tree.filter((n) => open[n.agent.session_id]?.length || questions[n.agent.session_id]?.length);
  if (!asking.length) return null;
  const firstQuestion = asking.findIndex((n) => questions[n.agent.session_id]?.length);
  return (
    <div data-testid="child-approvals" className="k-child-approvals">
      {asking.map(({ agent: kid, path }, i) => {
        const id = kid.session_id;
        const names = path.map((p) => p.title || sessions[p.session_id]?.title || "agent");
        const agent = `Agent ${names.join(" › ")}`;
        const asks = !!questions[id]?.length;
        // The agent's folder, when it is not this session's: its own worktree, on its branch.
        const folder = kid.worktree || sessions[id]?.workspace;
        const where = folder && folder !== sessions[parentId]?.workspace ? { folder, branch: kid.branch } : undefined;
        return (
          <div key={id} data-testid="child-asks" data-agent={id} data-depth={path.length}>
            <button
              type="button"
              onClick={() => openSession(id)}
              className="mb-1 flex max-w-full items-center gap-1.5 text-caption text-muted hover:text-fg"
            >
              <Bot className="size-3.5 shrink-0 text-accent" />
              <span className="min-w-0 truncate" data-testid="child-path" title={agent}>{path.length > 1 ? <>{names.slice(0, -1).join(" › ")} › <span className="text-fg">{names.at(-1)}</span></> : <>Agent <span className="text-fg">{names[0]}</span></>}</span>
              <span className="shrink-0">{stateWords({ watch: "need", why: asks && !open[id]?.length ? "question" : "approval" }).phrase.toLowerCase()}</span>
            </button>
            {!!open[id]?.length && <Suspense fallback={null}><Approvals sessionId={id} asker={agent} where={where} /></Suspense>}
            {asks && <Suspense fallback={null}><Questions sessionId={id} agent lead={i === firstQuestion} /></Suspense>}
          </div>
        );
      })}
    </div>
  );
}
