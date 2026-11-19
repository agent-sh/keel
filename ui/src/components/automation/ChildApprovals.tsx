import { Bot } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo } from "react";
import { isLive, openSession, useAuto } from "../../lib/automation.ts";
import { safety, useSafety } from "../../lib/safety.ts";
const Approvals = lazy(() => import("../ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

// The cards the session's agents wait on, answered here: the owner never has
// to go looking through child sessions for them.
export function ChildApprovals({ parentId }: { parentId: string }) {
  const all = useAuto((s) => s.agents);
  const kids = useMemo(() => Object.values(all).filter((a) => a.parent_id === parentId && isLive(a)), [all, parentId]);
  const open = useSafety((s) => s.approvals);
  const ids = kids.map((k) => k.session_id).join(",");
  useEffect(() => {
    const release = ids.split(",").filter(Boolean).map((id) => safety.watch(id));
    return () => release.forEach((f) => f());
  }, [ids]);
  const asking = kids.filter((k) => (open[k.session_id]?.length ?? 0) > 0);
  if (!asking.length) return null;
  return (
    <div data-testid="child-approvals">
      {asking.map((k) => (
        <div key={k.id}>
          <button
            type="button"
            onClick={() => openSession(k.session_id)}
            className="mb-1 flex items-center gap-1.5 text-caption text-muted hover:text-fg"
          >
            <Bot className="size-3.5 text-accent" /> Agent {k.title} asks
          </button>
          <Suspense fallback={null}><Approvals sessionId={k.session_id} asker={`Agent ${k.title}`} /></Suspense>
        </div>
      ))}
    </div>
  );
}
