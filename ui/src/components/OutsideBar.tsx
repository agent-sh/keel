// A session another harness runs, in the composer's place: Keel shows what it
// writes and sends nothing to it. Its state from its own records, what it spent,
// the files its calls changed, and one press to go on with it in Keel (a copy
// that goes on here; the original keeps running where it runs).
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session, Usage } from "../../../src/core/types.ts";
import { shortPath } from "../../../src/core/tool-line.ts";
import { OUTSIDE_LABEL } from "../../../src/core/watch.ts";
import { api, failed, reportUnlessGone } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { clock, fmtSessionCost, fmtTokens } from "../lib/utils.ts";
import { useSessionState } from "../lib/watch.ts";
import { Mark } from "./Mark.tsx";

type Details = { harness: string; label: string; source_id: string; path: string; live: boolean; files: string[]; usage: { model: string; usage: Usage; cost: number | null }[] };

const tokensOf = (u: Usage) => u.input + u.output + u.cache_read + u.cache_write;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function OutsideBar({ session }: { session: Session }) {
  const o = session.outside!;
  const where = OUTSIDE_LABEL[o.harness] ?? o.harness;
  const st = useSessionState(session);
  const [d, setD] = useState<Details | null>(null);
  const [files, setFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // Read when the bar shows and again when what it shows changed (a file more, the state): the transcript catches up first.
  useEffect(() => {
    let live = true;
    api<Details>(`/api/sessions/${session.id}/outside`).then((r) => { if (live) setD(r); }, (e) => reportUnlessGone(e, { at: "OutsideBar" }));
    return () => { live = false; };
  }, [session.id, o.files, o.state, o.failures]);
  const go = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ session: { id: string } }>(`/api/sessions/${session.id}/outside/copy`, { method: "POST" });
      navigate({ name: "session", id: r.session.id });
    } catch (e) {
      setNote(failed(e, { at: "OutsideBar copy" }));
    } finally {
      setBusy(false);
    }
  };
  // Stale: it worked or waited and has written nothing since (no process vouches for it): said as that, in no state's colour.
  const said = o.state === "waiting" ? `Waits in ${where} for ${o.waiting_for ?? "your answer"}` : o.state === "working" ? `Working in ${where}` : o.state === "stale" ? `No record from ${where}` : `Done in ${where}`;
  const u = session.usage;
  const cost = typeof u.cost === "number" && !u.unpriced ? fmtSessionCost(u.cost) : typeof u.cost === "number" && u.cost > 0 ? `${fmtSessionCost(u.cost)} and more unpriced` : "";
  const spent = [o.model, tokensOf(u) ? `${fmtTokens(tokensOf(u))} tokens` : "", cost].filter(Boolean).join(" · ");
  return (
    <section className="k-outside" data-testid="outside-bar" data-state={o.state} data-harness={o.harness} aria-label={`${where} session`}>
      <div className="k-outside-head">
        <Mark w={st.watch} />
        <div className="min-w-0 flex-1">
          <p className="k-outside-state" data-testid="outside-state">
            {said}
            {o.since > 0 && <span className="k-outside-since" title={`Since ${clock(o.since, { seconds: true })}`}> since {clock(o.since)}</span>}
          </p>
          <p className="k-outside-facts" data-testid="outside-facts">
            {spent && <span data-testid="outside-spent">{spent}</span>}
            {o.files > 0 && (
              <button type="button" className="k-outside-files-btn" aria-expanded={files} data-testid="outside-files-toggle" onClick={() => setFiles((x) => !x)}>
                {files ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{plural(o.files, "file")} changed
              </button>
            )}
            {o.failures > 0 && <span className="k-outside-failed" data-testid="outside-failures">{plural(o.failures, "failed call")}</span>}
          </p>
        </div>
        <button type="button" className="k-btn k-btn-lg" data-ink data-testid="outside-copy" disabled={busy} onClick={go} title={`A copy goes on here; the session in ${where} keeps running there`}>
          <CornerDownRight aria-hidden="true" />Copy into Keel
        </button>
      </div>
      {files && d && (
        <ul className="k-outside-files" data-testid="outside-files">
          {d.files.map((f) => <li key={f} title={f}>{shortPath(f, session.workspace)}</li>)}
        </ul>
      )}
      <p className="k-outside-note">{note || `Read-only here: Keel sends nothing to ${where}. Copy into Keel makes a copy you work on here; the session there keeps running.`}</p>
    </section>
  );
}
