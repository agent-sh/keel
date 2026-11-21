import { ClipboardList, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlanCard as Card } from "../../../src/server/routes/plan.ts";
import { api, onFeature, reportUnlessGone, failed } from "../lib/store.ts";
import { Markdown } from "./Markdown.tsx";
import { Select } from "./Select.tsx";

const MODES = [
  { id: "ask", label: "Ask" },
  { id: "auto-edits", label: "Auto edits" },
  { id: "auto", label: "Auto" },
  { id: "reviewer", label: "Reviewer" },
  { id: "full-auto", label: "Full auto" },
];

// A plan the model presents in plan mode, above the composer: approve it (as
// it is or edited) and pick the mode the work goes on in, or say what to change.
export function PlanCards({ sessionId }: { sessionId: string }) {
  const [cards, setCards] = useState<Card[]>([]);
  useEffect(() => {
    type F = { state: "open" | "closed"; card: Card };
    const step = (l: Card[], f: F) => (f.state === "open" ? [...l.filter((c) => c.id !== f.card.id), f.card] : l.filter((c) => c.id !== f.card.id));
    // Frames that came while a load was on its way are newer than its answer: applied on top of it.
    let since: F[] | null = null;
    // A session deleted while the page was cut off answers 404: a state its station shows, no failure.
    const load = () => {
      const mine: F[] = (since = []);
      api<{ open: Card[] }>(`/api/sessions/${sessionId}/plan`).then((r) => setCards(mine.reduce(step, r.open))).catch(reportUnlessGone).finally(() => { if (since === mine) since = null; });
    };
    load();
    return onFeature({
      // A plan put back up after a daemon restart may have opened before this socket did.
      reconnect: load,
      frame: (f) => {
        if (f.name !== "plan" || f.session_id !== sessionId) return;
        since?.push(f.data);
        setCards((l) => step(l, f.data));
      },
    });
  }, [sessionId]);
  if (!cards.length) return null;
  return <div className="mb-2 flex flex-col gap-2">{cards.map((c) => <Plan key={c.id} c={c} />)}</div>;
}

function Plan({ c }: { c: Card }) {
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(c.plan);
  const [mode, setMode] = useState("auto-edits");
  const [feedback, setFeedback] = useState("");
  const [back, setBack] = useState(false);
  const [err, setErr] = useState("");
  const send = (b: object) => api(`/api/sessions/${c.session_id}/plan/${c.id}`, { method: "POST", body: JSON.stringify(b) }).catch((e) => setErr(failed(e, { at: "PlanCard" })));
  return (
    <div className="animate-in overflow-hidden rounded-2xl border border-accent/40 bg-raised shadow-2" data-testid="plan-card">
      <div className="flex items-center gap-2.5 px-4 pt-3">
        <span className="grid size-6 place-items-center rounded-md bg-accent-soft text-accent"><ClipboardList className="size-3.5" /></span>
        <span className="text-ui font-medium">{c.title || "The model's plan"}</span>
        <button onClick={() => setEditing(!editing)} className="ml-auto inline-flex min-h-ctl-sm items-center gap-1 text-caption text-faint hover:text-fg" data-testid="plan-edit">
          <Pencil className="size-3" /> {editing ? "Done editing" : "Edit"}
        </button>
      </div>
      <div className="mx-4 mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-bg px-3 py-2 text-ui" data-testid="plan-text">
        {editing
          ? <textarea value={plan} onChange={(e) => setPlan(e.target.value)} rows={12} className="w-full resize-y bg-transparent font-mono text-caption outline-none" />
          : <Markdown text={plan} />}
      </div>
      {back ? (
        <form className="flex items-center gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); send({ approve: false, feedback }); }}>
          <input autoFocus value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="What to change in the plan" data-testid="plan-feedback"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong" />
          <button type="submit" className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover">Send back</button>
          <button type="button" onClick={() => setBack(false)} className="h-8 rounded-lg px-2 text-ui text-faint hover:text-fg">Cancel</button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          {/* One unit: the mode the work goes on in, named, and the approval that starts it. They wrap inside it, never apart. */}
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-line bg-sunken p-1" role="group" aria-label="Approve the plan" data-testid="plan-approval">
            <span className="flex min-w-0 flex-[1_1_auto] flex-wrap items-center gap-x-2 gap-y-1">
              <span className="shrink-0 pl-1.5 text-caption text-muted" aria-hidden>Work goes on in</span>
              <Select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Work goes on in" data-testid="plan-mode" className="h-7 w-[7.5rem] grow rounded-md border border-line bg-raised px-2 text-ui outline-none">
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            </span>
            <button data-testid="plan-approve" disabled={!plan.trim()} title={plan.trim() ? undefined : "The plan is empty: write it, or keep planning"} onClick={() => send({ approve: true, mode, plan })} className="h-7 grow whitespace-nowrap rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">
              Approve plan
            </button>
          </div>
          <button data-testid="plan-back" onClick={() => setBack(true)} className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg">Keep planning</button>
          {err && <span className="ml-auto text-micro text-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}
