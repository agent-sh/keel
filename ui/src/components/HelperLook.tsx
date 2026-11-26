// The helper's look at an error, under its row in the Errors panel (src/helper/looks.ts): what it is in a line or
// two, whose it is (Keel's, the owner's setup, a provider's), the step that fixes it, and for a bug of Keel's a
// task the owner can read, edit and start an agent on. Nothing starts by itself; the cost of the look is shown.
import { Bot, RotateCw } from "lucide-react";
import { useState } from "react";
import { askLook, lookOf, useHelper, type Look } from "../lib/helper.ts";
import { fixThis, useFixOf } from "../lib/observe.ts";
import { reportError } from "../lib/store.ts";
import { fmtSessionCost } from "../lib/utils.ts";
import { HelperFace, useHelperName } from "./HelperFace.tsx";

const WHOSE: Record<string, string> = { keel: "A bug in Keel", setup: "Your setup", provider: "The provider", unknown: "Not clear" };

const costOf = (l: Look) => [l.model, l.cost === null || l.cost === undefined ? "no price known, or your plan" : fmtSessionCost(l.cost), l.tokens ? `${l.tokens} tokens` : ""].filter(Boolean).join(" · ");

export function HelperLook({ errorId }: { errorId: string }) {
  const look = useHelper((s) => lookOf(s.looks, errorId));
  const name = useHelperName();
  const [task, setTask] = useState<{ cause: string; text: string }>();
  const [starting, setStarting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState("");
  // A session already started for this cause: the press opens it instead of starting another (one fix a cause).
  const fixOpen = useFixOf(errorId);
  if (!look) return null;
  // The look stands under the first row of its cause; the others say they are the same.
  if (look.error_ids[0] !== errorId && look.state === "done") {
    return (
      <div className="k-look" data-testid="helper-look-same">
        <HelperFace size="voice" testid="helper-look-face" />
        <p className="k-look-line">{name}: the same cause as another error here, which has the look.{look.what ? <span className="text-muted"> {look.what}</span> : null}</p>
      </div>
    );
  }
  const text = task?.cause === look.cause ? task.text : look.task ?? "";
  const ask = () => { setAsking(true); askLook(look.cause).catch(reportError).finally(() => setAsking(false)); };
  const start = () => {
    setStarting(true); setErr("");
    fixThis({ error_id: errorId, task: text, repo: "keel" }).catch((e) => setErr(e instanceof Error ? e.message : String(e))).finally(() => setStarting(false));
  };
  return (
    <div className="k-look" data-testid="helper-look" data-state={look.state} data-blame={look.blame}>
      <HelperFace size="voice" testid="helper-look-face" />
      <div className="k-look-body">
        <div className="k-look-head">
          <span className="font-medium text-fg" data-testid="helper-look-name">{name}</span>
          {look.state === "done" && look.blame && <span className="k-look-whose" data-testid="helper-look-whose">{WHOSE[look.blame]}</span>}
        </div>
        {look.state === "looking" && <p className="k-look-line" data-testid="helper-look-wait"><span className="k-mark" data-watch="work" aria-hidden /> Reading this error.</p>}
        {look.state === "held" && (
          <p className="k-look-line" data-testid="helper-look-held">Not read yet: the hour's looks are spent. <button type="button" className="k-look-link" disabled={asking} onClick={ask} data-testid="helper-look-now">Look now</button></p>
        )}
        {look.state === "failed" && (
          <p className="k-look-line" data-testid="helper-look-error">The look did not work ({look.error}). <button type="button" className="k-look-link" disabled={asking} onClick={ask} data-testid="helper-look-again"><RotateCw className="size-3" /> Look again</button></p>
        )}
        {look.state === "done" && (
          <>
            <p className="k-look-line" data-testid="helper-look-what">{look.what}</p>
            {look.step && <p className="k-look-line" data-testid="helper-look-step"><span className="text-muted">Next step:</span> {look.step}</p>}
            {look.blame === "keel" && look.task && (
              <div className="k-look-task">
                <label className="k-pick-label" htmlFor={`look-task-${look.cause}`}>A task for an agent in Keel's repository</label>
                <textarea id={`look-task-${look.cause}`} className="k-field k-pick-prompt" rows={4} value={text} onChange={(e) => setTask({ cause: look.cause, text: e.target.value })} data-testid="helper-look-task" />
                <div className="k-look-acts">
                  <button type="button" className="k-btn" disabled={starting || !text.trim()} onClick={start} data-testid="helper-look-start"><Bot className="size-3.5" />{starting ? (fixOpen ? "Opening" : "Starting") : fixOpen ? "Open the agent on this" : "Start an agent on this"}</button>
                  <span className="k-pick-note">It starts only when you press this.</span>
                </div>
                {err && <p className="k-pick-note" role="alert" data-testid="helper-look-start-error">{err}</p>}
              </div>
            )}
            <p className="k-look-cost" data-testid="helper-look-cost" title="What this look cost: one small request, once for this cause">Look: {costOf(look)}</p>
          </>
        )}
      </div>
    </div>
  );
}
