import { Checkbox } from "@base-ui/react/checkbox";
import { Check, ChevronRight, CircleDot, ExternalLink, Flag, ListChecks, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { auto, openSession, useAuto, type Goal, type Task } from "../../lib/automation.ts";
import { remoteId, splitId } from "../../lib/fleet-ids.ts";
import { composing } from "../../lib/keys.ts";
import { planLine, planState, turnsSince, useMinute } from "../../lib/plan-age.ts";
import { reportError, failed, useStore, useModels } from "../../lib/store.ts";
import { cn, fmtTokens } from "../../lib/utils.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { Empty, IconButton, SectionTitle } from "./bits.tsx";

const GOAL_LABEL: Record<Goal["status"], string> = {
  pursuing: "Working on it", paused: "Paused", achieved: "Met", impossible: "Not reachable", budget: "Budget spent", stalled: "Stalled",
};
const GOAL_TONE: Record<Goal["status"], string> = {
  pursuing: "bg-accent-soft text-accent", paused: "bg-sunken text-muted", achieved: "bg-sunken text-ok", impossible: "bg-danger-soft text-danger", budget: "bg-sunken text-warn", stalled: "bg-sunken text-warn",
};
const field = "k-field h-auto w-full py-2";
const button = "k-btn";

function NewGoal({ sid, replace }: { sid: string; replace: boolean }) {
  const [objective, setObjective] = useState("");
  const [turns, setTurns] = useState("");
  const [err, setErr] = useState("");
  return (
    <form
      className="flex flex-col gap-2 px-3"
      data-testid="goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        setErr("");
        auto.setGoal(sid, { objective, max_turns: turns ? Number(turns) : null, replace }).catch((x) => setErr(failed(x, { at: "TasksPanel" })));
      }}
    >
      <textarea
        data-testid="goal-objective"
        className={cn(field, "min-h-20 resize-y")}
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="What done looks like, in a way the conversation can show: the tests pass, the file exists, the output reads..."
      />
      <div className="flex items-center gap-2">
        <input data-testid="goal-turns" value={turns} onChange={(e) => setTurns(e.target.value.replace(/\D/g, ""))} placeholder="Max turns (optional)" className={cn(field, "w-40")} />
        <button type="submit" disabled={!objective.trim()} data-ink="" className="k-btn k-btn-lg ml-auto">
          {replace ? "Replace goal" : "Start goal"}
        </button>
      </div>
      {err && <p className="text-caption text-danger">{err}</p>}
      <p className="text-micro text-faint">Setting a goal starts a turn. After each turn a judge on this session's model reads the conversation; when it says met, an independent verifier checks the work itself before the goal counts. Until then the next turn starts.</p>
    </form>
  );
}

function GoalCard({ g, sid }: { g: Goal; sid: string }) {
  const [edit, setEdit] = useState(false);
  const act = (p: Promise<unknown>) => p.catch(reportError);
  const live = g.status === "pursuing";
  const open = g.status !== "achieved" && g.status !== "impossible";
  if (edit) return <><NewGoal sid={sid} replace /><button type="button" onClick={() => setEdit(false)} className="mx-3 mt-1 text-caption text-muted hover:text-fg">Cancel</button></>;
  return (
    <div className="mx-3 rounded-lg border border-line bg-raised px-3 py-2.5 shadow-1" data-testid="goal-card" data-status={g.status}>
      <div className="flex items-center gap-2">
        <span className={cn("rounded px-1.5 py-px text-micro font-medium", GOAL_TONE[g.status])} data-testid="goal-status">{GOAL_LABEL[g.status]}</span>
        <span className="text-micro text-faint tabular-nums">{g.turns} turn{g.turns === 1 ? "" : "s"}{g.max_turns ? ` of ${g.max_turns}` : ""} · {fmtTokens(g.tokens_used)} tokens</span>
        <span className="ml-auto flex items-center">
          {live && <IconButton title="Pause the goal" onClick={() => act(auto.patchGoal(sid, { status: "paused" }))} testid="goal-pause"><Pause className="size-3.5" /></IconButton>}
          {!live && open && <IconButton title="Resume the goal" onClick={() => act(auto.patchGoal(sid, { status: "pursuing" }))} testid="goal-resume"><Play className="size-3.5" /></IconButton>}
          <IconButton title="Clear the goal" danger onClick={() => act(auto.clearGoal(sid))} testid="goal-clear"><X className="size-3.5" /></IconButton>
        </span>
      </div>
      <p className="mt-1.5 text-ui whitespace-pre-wrap" data-testid="goal-text">{g.objective}</p>
      <VerifierModel g={g} sid={sid} />
      {(g.last_reason || g.status_reason) && (
        <p className="mt-1.5 text-caption text-muted" data-testid="goal-reason">
          {g.status_reason && g.status !== "pursuing" ? g.status_reason : g.last_reason}
        </p>
      )}
      {(g.verifying || g.evidence?.length || g.verified) && (
        <div className="mt-2 border-t border-line pt-2" data-testid="goal-verify" data-state={g.verifying ? "running" : g.verified ? "met" : "not_met"}>
          <div className="flex items-center gap-1.5 text-caption">
            {g.verifying ? <CircleDot className="size-3.5 text-brass animate-pulse-dot" /> : g.verified ? <Check className="size-3.5 text-ok" /> : <X className="size-3.5 text-warn" />}
            <span className={g.verified ? "text-fg" : "text-muted"}>{g.verifying ? "An independent check of the work is running" : g.verified ? "Confirmed by an independent check of the work" : "The independent check found work missing"}</span>
            {g.verifier_session && (
              <button type="button" onClick={() => openSession(g.verifier_session!)} title="Open the verifier's session" className="ml-auto text-faint hover:text-fg" data-testid="goal-verifier-open"><ExternalLink className="size-3.5" /></button>
            )}
          </div>
          {!!g.evidence?.length && (
            <ul className="mt-1 flex flex-col gap-0.5 pl-5 text-micro text-muted" data-testid="goal-evidence">
              {g.evidence.map((e, i) => <li key={i} className="list-disc break-words font-mono">{e}</li>)}
            </ul>
          )}
        </div>
      )}
      {!open && <button type="button" onClick={() => setEdit(true)} className="k-link mt-2 text-caption text-accent hover:underline">Set a new goal</button>}
    </div>
  );
}

// The model of the independent check before the goal counts as met. None of
// its own: the judge's model, else the session's (src/automation/verify.ts).
function VerifierModel({ g, sid }: { g: Goal; sid: string }) {
  const fallback = useStore((s) => g.judge_model ?? s.sessions[sid]?.model ?? "");
  const name = useModels().find((m) => m.id === fallback)?.name ?? fallback;
  const set = (m: string | null) => auto.patchGoal(sid, { verifier_model: m }).catch(reportError);
  const same = `Same as the ${g.judge_model ? "judge" : "session"}${name ? ` (${name})` : ""}`;
  return (
    <div className="mt-1.5 flex items-center gap-1 text-caption text-muted" data-testid="goal-verifier-model" data-model={g.verifier_model ?? ""}>
      <span className="shrink-0 text-faint">Checked by</span>
      <ModelPicker compact value={g.verifier_model ?? ""} onChange={(m) => set(m)} placeholder={same} />
      {g.verifier_model && (
        <button type="button" onClick={() => set(null)} className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-hover hover:text-fg" data-testid="goal-verifier-reset" title={same}>
          Use the {g.judge_model ? "judge's" : "session's"}
        </button>
      )}
    </div>
  );
}

function TaskRow({ t, sid }: { t: Task; sid: string }) {
  // The draft starts from the text as it is when editing starts (not when the
  // row first showed), and an edit names that text: a rename that landed
  // meanwhile is never undone by leaving the editor.
  const [text, setText] = useState(t.text);
  const [base, setBase] = useState(t.text);
  const [editing, setEditing] = useState(false);
  // The owner's draft against a row that changed under it. `theirs`: the text
  // the daemon refused the edit with, when the page had not heard of the
  // change yet (the other edit's frame was still on its way).
  const [conflict, setConflict] = useState<{ mine: string; theirs?: string } | null>(null);
  const act = (p: Promise<unknown>) => p.catch(reportError);
  const done = t.status === "completed" || t.status === "cancelled";
  // Its own session was deleted, by the daemon's word: what the tasks answer
  // listed as gone, or a delete this page was told of. A session the page
  // merely does not list (an archived one) is still the row's link.
  const from = splitId(sid);
  const dest = t.dest_session ? (from ? remoteId(from.machine, t.dest_session) : t.dest_session) : null;
  const listedGone = useAuto((s) => !!t.dest_session && !!s.goneDests[t.dest_session]);
  const destGone = useStore((s) => !!dest && !!s.gone[dest]) || listedGone;
  const linked = !!dest && !destGone;
  const [starting, setStarting] = useState(false);
  const start = () => {
    setStarting(true);
    auto.startTask(sid, t.id).then((r) => openSession(r.session_id)).catch(reportError).finally(() => setStarting(false));
  };
  const begin = () => { setText(t.text); setBase(t.text); setConflict(null); setEditing(true); };
  // A rename the daemon refused (the row changed meanwhile) is the owner's
  // choice, not an error: the chooser opens with the daemon's text and the draft kept.
  const save = (mine: string, was: string) => act(auto.editTask(sid, t.id, { text: mine, was }).then(() => setConflict(null), (e) => {
    const current = (e as { status?: number; body?: { current?: Task } }).status === 409 ? (e as { body?: { current?: Task } }).body?.current : undefined;
    if (!current) throw e;
    setConflict({ mine, theirs: current.text });
  }));
  const leave = () => {
    setEditing(false);
    const mine = text.trim();
    if (!mine || mine === base) return; // nothing typed: nothing sent
    if (t.text !== base) setConflict({ mine }); // it changed meanwhile: the owner chooses
    else save(mine, base);
  };
  // What the row reads now: as the page has it once it moved off the text the
  // draft started from, else as the daemon answered.
  const theirs = t.text !== base ? t.text : conflict?.theirs ?? t.text;
  return (
    <div className="group flex flex-col rounded-md px-3 py-1.5 hover:bg-hover" data-testid="task-row" data-status={t.status} data-task-id={t.id}>
      <div className="flex items-start gap-2">
        <Checkbox.Root
          checked={t.status === "completed"}
          onCheckedChange={(on) => act(auto.editTask(sid, t.id, { status: on ? "completed" : "pending" }))}
          aria-label={`Done: ${t.text}`}
          data-testid="task-check"
          className="mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-line-strong bg-bg outline-none data-[checked]:border-accent data-[checked]:bg-accent"
        >
          <Checkbox.Indicator><Check className="size-3 text-accent-fg" /></Checkbox.Indicator>
        </Checkbox.Root>
        {t.status === "in_progress" && <CircleDot className="mt-0.5 size-4 shrink-0 text-brass" aria-label="In progress" />}
        {editing ? (
          <input
            autoFocus
            data-testid="task-edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={leave}
            onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setText(base); setEditing(false); } }}
            className="min-w-0 flex-1 rounded border border-line bg-bg px-1.5 text-ui outline-none"
          />
        ) : (
          <span data-testid="task-text" onDoubleClick={begin} className={cn("min-w-0 flex-1 text-ui", done && "text-faint line-through", t.status === "in_progress" && "font-medium")}>{t.text}</span>
        )}
        {t.by === "owner" && <span className="mt-0.5 shrink-0 rounded bg-sunken px-1 text-micro text-faint">you</span>}
        <span className={cn("shrink-0 items-center", linked ? "flex" : "hidden group-hover:flex")}>
          {linked ? (
            <IconButton title="Open its session" onClick={() => openSession(dest!)} testid="task-open"><ExternalLink className="size-3.5" /></IconButton>
          ) : !done && !destGone && (
            <IconButton title="Do it in a session of its own" onClick={start} testid="task-start"><ExternalLink className="size-3.5" /></IconButton>
          )}
          <IconButton title="Remove" danger onClick={() => act(auto.removeTask(sid, t.id))} testid="task-remove"><Trash2 className="size-3.5" /></IconButton>
        </span>
      </div>
      {editing && t.text !== base && <p className="mt-1 pl-6 text-caption text-warn" data-testid="task-changed">Changed meanwhile: it now reads "{t.text}".</p>}
      {destGone && (
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-caption" data-testid="task-dest-gone">
          <span className="text-muted">Its session was deleted.</span>
          {!done && <button type="button" disabled={starting} className={cn(button, "disabled:opacity-40")} onClick={start} data-testid="task-restart">Start it again</button>}
        </div>
      )}
      {conflict !== null && (
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-caption" data-testid="task-conflict">
          <span className="text-warn">It was changed to "{theirs}" while you edited.</span>
          <button type="button" className={button} onClick={() => save(conflict.mine, theirs)} data-testid="task-keep-mine">Use "{conflict.mine}"</button>
          <button type="button" className={button} onClick={() => setConflict(null)} data-testid="task-keep-theirs">Keep it</button>
        </div>
      )}
    </div>
  );
}

// The side panel: the session's goal and the task list it shares with the model.
export function TasksPanel({ session }: { session: Session }) {
  const sid = session.id;
  const goal = useAuto((s) => s.goals[sid]);
  const list = useAuto((s) => s.tasks[sid]);
  const [text, setText] = useState("");
  useEffect(() => void auto.loadSessionPlan(sid).catch(reportError), [sid]);
  const done = list?.filter((t) => t.status === "completed").length ?? 0;
  // A list left alone while the session went on, or with every item done, is one quiet line (lib/plan-age.ts).
  const events = useStore((s) => s.events[sid]);
  const clock = useMinute();
  const [unfolded, setUnfolded] = useState(false);
  const at = list?.length ? Math.max(...list.map((t) => t.updated_ms)) : 0;
  const state = list?.length ? planState({ at, turns: events ? turnsSince(events, at) : 0, now: clock, working: session.phase === "working", items: list, endedAt: session.archived ? Number.MAX_SAFE_INTEGER : session.settings.done_ms }) : "live";
  useEffect(() => setUnfolded(false), [sid, state, at]);
  const folded = state !== "live" && !unfolded;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3" data-testid="tasks-panel">
      <SectionTitle right={<Flag className="size-3.5 text-faint" />}>Goal</SectionTitle>
      {goal === undefined ? null : goal ? <GoalCard g={goal} sid={sid} /> : <NewGoal sid={sid} replace={false} />}
      <SectionTitle right={list?.length ? <span className="text-micro text-faint tabular-nums">{done}/{list.length}</span> : null}>Tasks</SectionTitle>
      <div data-testid="task-list">
        {list?.length === 0 && <Empty>No tasks yet. The model's plan shows here, and so do yours.</Empty>}
        {state !== "live" && list?.length ? (
          <div className="px-2">
            <button type="button" className="k-docket-line" data-testid="task-fold" data-state={state} aria-expanded={!folded} onClick={() => setUnfolded(!unfolded)}>
              <ListChecks className="k-docket-glyph" />
              <span className="min-w-0 truncate text-faint">{planLine(state, { at, now: clock, items: list })}</span>
              <ChevronRight className={cn("k-docket-more ml-auto transition-transform", !folded && "rotate-90")} />
            </button>
          </div>
        ) : null}
        {!folded && list?.map((t) => <TaskRow key={t.id} t={t} sid={sid} />)}
      </div>
      <form
        className="px-3 pt-2"
        onSubmit={(e) => { e.preventDefault(); if (text.trim()) auto.addTask(sid, text).then(() => setText("")).catch(reportError); }}
      >
        <input data-testid="task-add" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a task; the model sees it before its next step" className={field} />
      </form>
    </div>
  );
}
