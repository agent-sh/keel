import { Checkbox } from "@base-ui/react/checkbox";
import { Check, CircleDot, ExternalLink, Flag, Pause, Play, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { auto, openSession, useAuto, type Goal, type Task } from "../../lib/automation.ts";
import { reportError, failed } from "../../lib/store.ts";
import { cn, fmtTokens } from "../../lib/utils.ts";
import { Empty, IconButton, SectionTitle } from "./bits.tsx";

const GOAL_LABEL: Record<Goal["status"], string> = {
  pursuing: "Working on it", paused: "Paused", achieved: "Met", impossible: "Not reachable", budget: "Budget spent", stalled: "Stalled",
};
const GOAL_TONE: Record<Goal["status"], string> = {
  pursuing: "bg-accent-soft text-accent", paused: "bg-panel text-muted", achieved: "bg-panel text-ok", impossible: "bg-danger-soft text-danger", budget: "bg-panel text-warn", stalled: "bg-panel text-warn",
};
const field = "w-full rounded-lg border border-line bg-bg px-3 py-2 text-ui outline-none focus:border-line-strong placeholder:text-faint";
const button = "flex h-7 items-center gap-1.5 rounded-md border border-line px-2.5 text-caption hover:bg-hover hover:text-fg";

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
        <button type="submit" disabled={!objective.trim()} className="ml-auto h-8 rounded-lg bg-accent px-3.5 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-40">
          {replace ? "Replace goal" : "Start goal"}
        </button>
      </div>
      {err && <p className="text-caption text-danger">{err}</p>}
      <p className="text-micro text-faint">Setting a goal starts a turn. After each turn a judge on this session's model reads the conversation and says whether it is met; if not, the next turn starts.</p>
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
      {(g.last_reason || g.status_reason) && (
        <p className="mt-1.5 text-caption text-muted" data-testid="goal-reason">
          {g.status_reason && g.status !== "pursuing" ? g.status_reason : g.last_reason}
        </p>
      )}
      {!open && <button type="button" onClick={() => setEdit(true)} className="mt-2 text-caption text-accent hover:underline">Set a new goal</button>}
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
  const [conflict, setConflict] = useState<string | null>(null);
  const act = (p: Promise<unknown>) => p.catch(reportError);
  const done = t.status === "completed" || t.status === "cancelled";
  const begin = () => { setText(t.text); setBase(t.text); setConflict(null); setEditing(true); };
  const save = (mine: string, was: string) => act(auto.editTask(sid, t.id, { text: mine, was }).then(() => setConflict(null)));
  const leave = () => {
    setEditing(false);
    const mine = text.trim();
    if (!mine || mine === base) return; // nothing typed: nothing sent
    if (t.text !== base) setConflict(mine); // it changed meanwhile: the owner chooses
    else save(mine, base);
  };
  return (
    <div className="group flex flex-col rounded-md px-3 py-1.5 hover:bg-hover" data-testid="task-row" data-status={t.status}>
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
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setText(base); setEditing(false); } }}
            className="min-w-0 flex-1 rounded border border-line bg-bg px-1.5 text-ui outline-none"
          />
        ) : (
          <span data-testid="task-text" onDoubleClick={begin} className={cn("min-w-0 flex-1 text-ui", done && "text-faint line-through", t.status === "in_progress" && "font-medium")}>{t.text}</span>
        )}
        {t.by === "owner" && <span className="mt-0.5 shrink-0 rounded bg-panel px-1 text-micro text-faint">you</span>}
        <span className={cn("shrink-0 items-center", t.dest_session ? "flex" : "hidden group-hover:flex")}>
          {t.dest_session ? (
            <IconButton title="Open its session" onClick={() => openSession(t.dest_session!)} testid="task-open"><ExternalLink className="size-3.5" /></IconButton>
          ) : !done && (
            <IconButton title="Do it in a session of its own" onClick={() => auto.startTask(sid, t.id).then((r) => openSession(r.session_id)).catch(reportError)} testid="task-start"><ExternalLink className="size-3.5" /></IconButton>
          )}
          <IconButton title="Remove" danger onClick={() => act(auto.removeTask(sid, t.id))} testid="task-remove"><Trash2 className="size-3.5" /></IconButton>
        </span>
      </div>
      {editing && t.text !== base && <p className="mt-1 pl-6 text-caption text-warn" data-testid="task-changed">Changed meanwhile: it now reads "{t.text}".</p>}
      {conflict !== null && (
        <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-caption" data-testid="task-conflict">
          <span className="text-warn">It was changed to "{t.text}" while you edited.</span>
          <button type="button" className={button} onClick={() => save(conflict, t.text)} data-testid="task-keep-mine">Use "{conflict}"</button>
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3" data-testid="tasks-panel">
      <SectionTitle right={<Flag className="size-3.5 text-faint" />}>Goal</SectionTitle>
      {goal === undefined ? null : goal ? <GoalCard g={goal} sid={sid} /> : <NewGoal sid={sid} replace={false} />}
      <SectionTitle right={list?.length ? <span className="text-micro text-faint tabular-nums">{done}/{list.length}</span> : null}>Tasks</SectionTitle>
      <div data-testid="task-list">
        {list?.length === 0 && <Empty>No tasks yet. The model's plan shows here, and so do yours.</Empty>}
        {list?.map((t) => <TaskRow key={t.id} t={t} sid={sid} />)}
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
