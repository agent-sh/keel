import { useEffect, useState } from "react";
import { safety, useSafety, type Approval } from "../lib/safety.ts";
import { api, reportError } from "../lib/store.ts";

// The receipt of a closed approval. Never match a grant by its text or scope:
// another card can create the same rule after this one's grant is revoked.
export function ApprovalGrant({ sessionId, approvalId }: { sessionId: string; approvalId: string }) {
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const grants = useSafety((s) => s.grants);
  useEffect(() => {
    let live = true;
    void api<{ approval: Approval }>(`/api/sessions/${sessionId}/approvals/${approvalId}`).then(async ({ approval }) => {
      if (!approval.grant_ids?.length || !live) return;
      await safety.loadGrants();
      if (live) setIds(approval.grant_ids);
    }).catch((e) => { if (live && e.status !== 404) reportError(e); });
    return () => { live = false; };
  }, [sessionId, approvalId]);
  const active = grants.filter((g) => ids.includes(g.id));
  if (!active.length) return null;
  return (
    <div className="flex flex-col gap-1 text-caption" data-testid="approval-grants">
      <span className="text-muted">Revoke to ask again on future calls.</span>
      {active.map((g) => (
        <div key={g.id} className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 flex-1 break-all" title={g.pattern}>{g.pattern}</code>
          <button type="button" className="k-btn shrink-0" data-testid="revoke-approval-grant" disabled={busy !== undefined}
            onClick={async () => {
              setBusy(g.id);
              try { await safety.revoke(g.id); }
              catch (e) {
                if ((e as { status?: number }).status === 404) await safety.loadGrants().catch(reportError);
                else reportError(e);
              } finally { setBusy(undefined); }
            }}>Revoke grant</button>
        </div>
      ))}
    </div>
  );
}
