import { ClipboardList, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlanCard as Card } from "../../../src/server/routes/plan.ts";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
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
    api<{ open: Card[] }>(`/api/sessions/${sessionId}/plan`).then((r) => setCards(r.open)).catch(reportError);
    return onFeature({
      frame: (f) => {
        if (f.name !== "plan" || f.session_id !== sessionId) return;
        setCards((l) => (f.data.state === "open" ? [...l.filter((c) => c.id !== f.data.card.id), f.data.card] : l.filter((c) => c.id !== f.data.card.id)));
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
        <button onClick={() => setEditing(!editing)} className="ml-auto inline-flex items-center gap-1 text-caption text-faint hover:text-fg" data-testid="plan-edit">
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
        <div className="flex flex-wrap items-center gap-1.5 px-4 py-3">
          <button data-testid="plan-approve" disabled={!plan.trim()} title={plan.trim() ? undefined : "The plan is empty: write it, or keep planning"} onClick={() => send({ approve: true, mode, plan })} className="h-8 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50">
            Approve and go on in
          </button>
          <Select value={mode} onChange={(e) => setMode(e.target.value)} data-testid="plan-mode" className="h-8 rounded-lg border border-line bg-raised px-2 text-ui outline-none">
            {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          <button data-testid="plan-back" onClick={() => setBack(true)} className="h-8 rounded-lg px-3 text-ui text-muted hover:bg-hover hover:text-fg">Keep planning</button>
          {err && <span className="ml-auto text-micro text-danger">{err}</span>}
        </div>
      )}
    </div>
  );
}
