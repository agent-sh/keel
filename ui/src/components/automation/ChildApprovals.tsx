import { Bot } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { isLive, openSession, useAuto } from "../../lib/automation.ts";
import { safety, useSafety } from "../../lib/safety.ts";
import { useStore } from "../../lib/store.ts";
import { stateWords } from "../../../../src/core/state-words.ts";
const Approvals = lazy(() => import("../ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

// The cards the session's agents wait on: approvals are answered here and
// questions open the asking agent's transcript.
export function ChildApprovals({ parentId }: { parentId: string }) {
  const all = useAuto((s) => s.agents);
  const kids = useMemo(() => Object.values(all).filter((a) => a.parent_id === parentId && isLive(a)), [all, parentId]);
  const open = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionChildren[parentId]);
  const sessions = useStore((s) => s.sessions);
  // An agent's cards come by frames, as every session's do (the page reads all the open cards
  // when its socket opens): nothing is read for an agent that asks nothing. One that asks is
  // watched while it asks, so a reconnect reads its cards again, and only the ones that began
  // or stopped asking are touched: twelve agents turning over read nothing.
  const asks = kids.filter((k) => open[k.session_id]?.length).map((k) => k.session_id).sort().join(",");
  const watched = useRef(new Map<string, () => void>());
  useEffect(() => {
    const want = new Set(asks.split(",").filter(Boolean));
    for (const [id, release] of watched.current) if (!want.has(id)) { release(); watched.current.delete(id); }
    for (const id of want) if (!watched.current.has(id)) watched.current.set(id, safety.watch(id));
  }, [asks]);
  useEffect(() => () => { for (const release of watched.current.values()) release(); watched.current.clear(); }, []);
  const asking = new Set([...kids.filter((k) => open[k.session_id]?.length).map((k) => k.session_id), ...(questions ?? [])]);
  if (!asking.size) return null;
  return (
    <div data-testid="child-approvals" className="k-child-approvals">
      {[...asking].map((id) => {
        const kid = kids.find((k) => k.session_id === id);
        const title = kid?.title || sessions[id]?.title;
        const agent = title ? `Agent ${title}` : "Subagent";
        // The agent's folder, when it is not this session's: its own worktree, on its branch.
        const folder = kid?.worktree || sessions[id]?.workspace;
        const where = folder && folder !== sessions[parentId]?.workspace ? { folder, branch: kid?.branch } : undefined;
        return (
          <div key={id}>
            <button
              type="button"
              onClick={() => openSession(id)}
              className="mb-1 flex items-center gap-1.5 text-caption text-muted hover:text-fg"
            >
              <Bot className="size-3.5 text-accent" /> {agent} {stateWords({ watch: "need", why: questions?.includes(id) ? "question" : "approval" }).phrase.toLowerCase()}
            </button>
            {!!open[id]?.length && <Suspense fallback={null}><Approvals sessionId={id} asker={agent} where={where} /></Suspense>}
          </div>
        );
      })}
    </div>
  );
}
