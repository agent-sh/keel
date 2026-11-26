// The pace of a session's unattended turns (src/automation/pace.ts), opened from the session's menu and from the
// dock's line while inputs wait: what it does, the choice (the owner's default, off, or minutes), what waits now,
// and the session's own day of turns by what started them (GET /api/sessions/:id/pace).
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { PaceDay } from "../../../src/automation/pace-read.ts";
import { actions, api, onFeature, reportError, useStore } from "../lib/store.ts";
import { clockOf, paceWords, type PaceView } from "../lib/pace.ts";
import { fmtCost } from "../lib/utils.ts";
import { Seg } from "./surfaces/kit.tsx";

let current: string | null = null;
const subs = new Set<() => void>();
const set = (id: string | null) => { current = id; subs.forEach((f) => f()); };

let mounted = false;
export function openPace(sessionId: string) {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(<Host />);
  }
  set(sessionId);
}

type Answer = PaceView & { day: PaceDay };
type Choice = "default" | "0" | "1" | "2" | "3" | "5" | "10" | "15";
const CHOICES: Choice[] = ["0", "1", "2", "3", "5", "10", "15"];

// What started a turn, in the page's words.
const KIND: Record<string, string> = {
  wake: "Several inputs at once", subagent: "An agent's report", loop: "A loop's run", wait: "A wait", harness: "A note of Keel's",
  failures: "A failure notice", goal: "A goal's next turn", helper_digest: "The helper's digest", restart: "A restart", peer: "Another session",
};

function Host() {
  const id = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  const session = useStore((s) => (id ? s.sessions[id] : undefined));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const own = session?.settings.pace_min;
  const load = () => {
    if (!id) return;
    api<Answer>(`/api/sessions/${id}/pace`).then(setAnswer, (e) => setError((e as Error).message));
  };
  useEffect(() => { setAnswer(null); setError(null); load(); }, [id, own]);
  useEffect(() => (id ? onFeature({ frame: (f) => { if (f.name === "pace" && f.session_id === id) setAnswer((a) => (a ? { ...a, ...(f.data as PaceView) } : a)); } }) : undefined), [id]);
  const choose = async (v: Choice) => {
    if (!id) return;
    setError(null);
    try {
      await actions.patch(id, { settings: { pace_min: v === "default" ? null : Number(v) } as any });
    } catch (e) {
      setError((e as Error).message);
      reportError(e, { at: "pace" });
    }
  };
  const agent = !!session?.parent_id;
  const value: Choice = own === undefined ? "default" : (String(own) as Choice);
  const options: [Choice, string][] = [
    ...(agent ? [] : [["default", answer && answer.from === "default" ? `Default, ${paceWords(answer.pace_min)}` : "Default"] as [Choice, string]]),
    ...CHOICES.map((c) => [c, c === "0" ? "Off" : `${c} min`] as [Choice, string]),
  ];
  const day = answer?.day;
  return (
    <Dialog.Root open={!!id} onOpenChange={(o) => !o && set(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="pace-dialog" className="k-dialog rounded-xl border border-line bg-raised shadow-3">
          <Dialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">Unattended pace</Dialog.Title>
          <div className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] pb-1">
            <Dialog.Description className="text-ui text-muted">
              Each turn nobody started (an agent's report, a wake, a loop's run, a monitor's batch, a goal's next turn) reads the whole context again. One that comes within the pace of the last such turn's end waits, and what waited goes as one input: never past its own deadline (a loop's next run, a wait's timeout) or the cache's lifetime. Your own messages go at once, and what waits goes right after your turn. An agent's question, failure or stop, a failure notice and a timer that is up go at once and take what waits with them.
            </Dialog.Description>
            <div className="mt-4 flex flex-col gap-2 text-ui">
              <span>Pace for this session</span>
              <Seg value={value} options={options} onChange={(v) => void choose(v)} label="Pace for this session" />
            </div>
            {answer && (
              <p className="mt-3 text-ui text-muted" data-testid="pace-now">
                {answer.waiting > 0 && answer.at
                  ? `${answer.waiting === 1 ? "One input waits" : `${answer.waiting} inputs wait`} for the pace, until ${clockOf(answer.at)}.`
                  : answer.pace_min > 0 ? "Nothing waits now." : agent && answer.from === "agent" ? "An agent keeps no pace unless it is set here: its parent waits on it." : "Off: every input starts a turn when the session is free."}
                {answer.waited > 0 && ` Since the daemon started, ${answer.waited} ${answer.waited === 1 ? "input" : "inputs"} waited and ${answer.joined} ${answer.joined === 1 ? "turn was" : "turns were"} not started.`}
              </p>
            )}
            {day && (
              <table className="mt-4 w-full text-ui tabular-nums" data-testid="pace-day">
                <thead>
                  <tr className="text-caption text-muted">
                    <th className="py-1 text-left font-normal">Last 24 hours</th>
                    <th className="py-1 text-right font-normal">Turns</th>
                    <th className="py-1 text-right font-normal">Dollars</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line">
                    <td className="py-1.5 text-muted">Your messages</td>
                    <td className="py-1.5 text-right">{day.owner.turns}</td>
                    <td className="py-1.5 text-right">{fmtCost(day.owner.usd)}</td>
                  </tr>
                  <tr className="border-t border-line">
                    <td className="py-1.5 text-muted">Nobody's</td>
                    <td className="py-1.5 text-right">{day.unattended.turns}</td>
                    <td className="py-1.5 text-right">{fmtCost(day.unattended.usd)}</td>
                  </tr>
                  {day.kinds.slice(0, 5).map((k) => (
                    <tr key={k.kind} className="border-t border-line">
                      <td className="py-1.5 pl-4 text-faint">{KIND[k.kind] ?? k.kind}</td>
                      <td className="py-1.5 text-right text-faint">{k.turns}</td>
                      <td className="py-1.5 text-right text-faint">{fmtCost(k.usd)}</td>
                    </tr>
                  ))}
                  {answer!.pace_min > 0 && (
                    <tr className="border-t border-line">
                      <td className="py-1.5 text-muted">Began within {paceWords(answer!.pace_min)} of the turn before</td>
                      <td className="py-1.5 text-right">{day.unattended.close}</td>
                      <td className="py-1.5 text-right">{fmtCost(day.unattended.close_usd)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-caption text-faint">
              A turn that takes a second input costs about half a turn more, not a second turn. The default is Settings' pace.unattended_min, for the sessions you talk to.
            </p>
            {error && <p className="mt-2 text-caption text-danger" role="alert">{error}</p>}
          </div>
          <div className="k-dialog-foot px-[var(--k-dialog-pad)] pb-[var(--k-dialog-pad)] pt-3">
            <Dialog.Close className="k-btn k-btn-lg" data-testid="pace-close">Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
