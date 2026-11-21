import { Bot } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { isLive, openSession, useAuto } from "../../lib/automation.ts";
import { safety, useSafety } from "../../lib/safety.ts";
import { useStore } from "../../lib/store.ts";
const Approvals = lazy(() => import("../ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

// The cards the session's agents wait on: approvals are answered here and
// questions open the asking agent's transcript.
export function ChildApprovals({ parentId }: { parentId: string }) {
  const all = useAuto((s) => s.agents);
  const kids = useMemo(() => Object.values(all).filter((a) => a.parent_id === parentId && isLive(a)), [all, parentId]);
  const open = useSafety((s) => s.approvals);
  const questions = useStore((s) => s.questionChildren[parentId]);
  const sessions = useStore((s) => s.sessions);
  const ids = kids.map((k) => k.session_id).join(",");
  useEffect(() => {
    const release = ids.split(",").filter(Boolean).map((id) => safety.watch(id));
    return () => release.forEach((f) => f());
  }, [ids]);
  const asking = new Set([...kids.filter((k) => open[k.session_id]?.length).map((k) => k.session_id), ...(questions ?? [])]);
  if (!asking.size) return null;
  return (
    <div data-testid="child-approvals" className="k-child-approvals">
      {[...asking].map((id) => {
        const title = kids.find((k) => k.session_id === id)?.title || sessions[id]?.title;
        const agent = title ? `Agent ${title}` : "Subagent";
        return (
          <div key={id}>
            <button
              type="button"
              onClick={() => openSession(id)}
              className="mb-1 flex items-center gap-1.5 text-caption text-muted hover:text-fg"
            >
              <Bot className="size-3.5 text-accent" /> {agent} {questions?.includes(id) ? "is waiting for your answer" : "asks"}
            </button>
            {!!open[id]?.length && <Suspense fallback={null}><Approvals sessionId={id} asker={agent} /></Suspense>}
          </div>
        );
      })}
    </div>
  );
}
