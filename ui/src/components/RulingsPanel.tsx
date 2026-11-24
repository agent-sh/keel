// Customize > Rulings: the answers the owner kept for questions like them
// (src/automation/rulings.ts). Each says what was asked, what the owner said,
// where it holds, and how often it answered an agent since. A ruling is
// revoked here: from then on the agents of its scope get the card again.
// Revoked ones stay listed under the rest, so what answered before is known.
import { Gavel } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { listRulings, revokeRuling, type Ruling } from "../lib/rulings.ts";
import { failed } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago } from "../lib/utils.ts";
import { Card } from "./Settings.tsx";

const where = (r: Ruling) => (r.scope === "everywhere" ? "Everywhere" : r.scope === "repo" ? `In ${r.scope_name}` : `In the tree of ${r.scope_name}`);
const used = (r: Ruling) => (r.uses ? `Answered ${r.uses === 1 ? "once" : `${r.uses} times`}${r.last_used ? `, last ${ago(r.last_used)}` : ""}` : "Not used yet");

export function RulingsPanel() {
  const [list, setList] = useState<Ruling[] | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => listRulings().then(setList).catch((e) => setErr(failed(e, { at: "RulingsPanel" }))), []);
  useEffect(() => { void load(); }, [load]);
  const revoke = async (id: string) => {
    setBusy(id);
    setErr("");
    try { await revokeRuling(id); await load(); } catch (e) { setErr(failed(e, { at: "RulingsPanel" })); } finally { setBusy(""); }
  };
  const live = list?.filter((r) => r.revoked === null) ?? [];
  const gone = list?.filter((r) => r.revoked !== null) ?? [];
  const row = (r: Ruling) => (
    <div key={r.id} className="flex items-start gap-4 border-b border-line py-3.5 last:border-0" data-testid="ruling-row" data-ruling={r.id} data-state={r.revoked === null ? "live" : "revoked"}>
      <Gavel className="mt-0.5 size-4 shrink-0 text-faint" />
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium leading-snug" data-name={r.question}>{r.question}</div>
        <div className="mt-1 text-ui"><span className="text-muted">You said </span><span className="font-medium" data-testid="ruling-words">{r.words}</span></div>
        <div className="mt-1 flex flex-wrap gap-x-3 text-caption text-muted">
          <span data-testid="ruling-where">{where(r)}</span>
          <span data-testid="ruling-uses">{used(r)}</span>
          <span>Kept {ago(r.created)}</span>
          {r.revoked !== null && <span>Revoked {ago(r.revoked)}</span>}
          <button type="button" className="k-link hover:underline" onClick={() => navigate({ name: "session", id: r.session_id })}>Where it was answered</button>
        </div>
      </div>
      {r.revoked === null && <button type="button" className="k-btn shrink-0" disabled={busy === r.id} data-testid="ruling-revoke" onClick={() => void revoke(r.id)}>Revoke</button>}
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui text-muted">An answer you keep under a question an agent asked answers the same question from later agents of its scope, with no card. Each answer names its ruling, and the session's timeline shows each use. A permission card is never answered from a ruling.</p>
      {err && <p className="text-ui text-danger" role="alert">{err}</p>}
      <Card>
        {list === null ? <p className="py-4 text-ui text-muted">Reading...</p>
          : !live.length ? <p className="py-4 text-ui text-muted" data-testid="rulings-none">No ruling is kept. Keep one from the line under an answer you gave.</p>
          : live.map(row)}
      </Card>
      {gone.length > 0 && (
        <>
          <h3 className="k-label">Revoked</h3>
          <Card>{gone.map(row)}</Card>
        </>
      )}
    </div>
  );
}
