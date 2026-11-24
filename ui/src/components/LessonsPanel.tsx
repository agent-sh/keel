// Settings > Lessons: causes that failed the same way across a repository's
// agent trees (src/automation/lessons.ts), each proposed as a short note with
// its evidence. The owner accepts a note as drafted or in his own words, or
// drops it. An accepted one is told to the repository's agents at their start
// and proven by a trial (half of the new agent trees get it); its numbers are
// shown here, and so is what the trial decided.
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { acceptLesson, dropLesson, editLesson, listLessons, mineLessons, proposeLesson, type Lesson, type Lessons, type Outcome } from "../lib/lessons.ts";
import { failed, onFeature, scope, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { Card } from "./Settings.tsx";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const tag = "shrink-0 rounded-xs px-1.5 text-micro";
// What a cause is, in the owner's words.
const sourceWords = (l: Lesson) => (l.source === "tool" ? `${l.label} call` : l.source === "review" ? "review finding" : l.label.split(" ")[0] === "agent" ? "agent failure" : `${l.label.split(" ")[0]} failure`);
const rate = (v: number | null) => (v === null ? "not measured" : `${v === 0 ? "0" : (v * 100).toFixed(v * 100 < 10 ? 1 : 0)} per 100 trees`);
const armLine = (o: Outcome) => o.arms.map((a) => `${a.arm}: ${rate(a.per_tree)} (${plural(a.trees, "tree")})`).join(", ");

function Evidence({ l }: { l: Lesson }) {
  const sessions = useStore((s) => s.sessions);
  const e = l.evidence;
  const shown = e.evidence.slice(0, 6);
  return (
    <div className="space-y-2" data-testid="lesson-evidence">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-caption tabular-nums">
        <span className="text-fg" data-testid="lesson-counts">{plural(e.failures, "failure")} in {plural(e.trees, "agent tree")}, {plural(e.sessions, "session")}</span>
        <span className="text-muted" title={`${when(e.first_ts)} to ${when(e.last_ts)}`}>first {ago(e.first_ts)}, last {ago(e.last_ts)}</span>
      </div>
      {e.examples.length > 0 && (
        <div className="space-y-0.5 rounded-sm bg-sunken px-2.5 py-1.5 font-mono text-micro text-muted">
          {e.examples.map((x) => <div key={x} className="truncate" title={x}>{x}</div>)}
        </div>
      )}
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-caption text-muted">
        <span>Seen in</span>
        {shown.map((x) => (
          <button key={x.session} type="button" className="k-link max-w-56 truncate hover:underline" title={`${plural(x.n, "failure")}, last ${when(x.ts)}`} onClick={() => navigate({ name: "session", id: x.session })}>
            {sessions[x.session]?.title?.trim() || "a session"}
          </button>
        ))}
        {e.trees > shown.length && <span className="text-faint">and {plural(e.trees - shown.length, "more tree")}</span>}
      </div>
    </div>
  );
}

function Proposal({ l, busy, act }: { l: Lesson; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [text, setText] = useState(l.text);
  useEffect(() => setText(l.text), [l.text]);
  return (
    <div className="space-y-3 border-b border-line py-4 last:border-0" data-testid="lesson-proposal" data-lesson={l.id}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-ui font-medium">{l.repo_name}</span>
        <span className={cn(tag, "bg-sunken text-muted")}>{sourceWords(l)}</span>
      </div>
      <Evidence l={l} />
      <label className="block space-y-1">
        <span className="k-label">Note for its agents{l.drafted_by ? `, drafted by ${l.drafted_by}` : ""}</span>
        <textarea className="k-field h-auto min-h-[3.5rem] w-full resize-y py-1.5 leading-snug" value={text} maxLength={600} onChange={(e) => setText(e.target.value)} data-testid="lesson-text" />
      </label>
      <div className="flex items-center gap-2">
        <button type="button" className="k-btn" data-ink="" disabled={busy || !text.trim()} data-testid="lesson-accept" onClick={() => act(() => acceptLesson(l.id, text))}>Accept</button>
        <button type="button" className="k-btn" disabled={busy} data-testid="lesson-drop" onClick={() => act(() => dropLesson(l.id))}>Drop</button>
        <span className="ml-1 text-caption text-faint">Accepted, it is told to the agents of {l.repo_name} at their start; a trial then shows whether it cuts this failure.</span>
      </div>
    </div>
  );
}

// What a lesson in use is doing, in a line.
function lineOf(l: Lesson): string {
  if (l.state === "accepted") return `Told to every agent of ${l.repo_name}. Its trial starts when no other live experiment runs.`;
  if (l.state === "trial") {
    const p = l.progress;
    const size = l.trees_per_arm ? ` It is read at ${l.trees_per_arm} agent trees an arm.` : "";
    return `In its trial: half of the new agent trees of ${l.repo_name} are told it.${p ? ` ${armLine(p)}.` : ""}${size}`;
  }
  if (l.state === "kept") return `Kept for every agent of ${l.repo_name}: ${l.outcome ? `${armLine(l.outcome)}. ` : ""}${l.outcome?.text ?? ""}`.trim();
  return "";
}

function InUse({ l, busy, act }: { l: Lesson; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.text);
  return (
    <div className="flex items-start gap-4 border-b border-line py-3.5 last:border-0" data-testid="lesson-live" data-lesson={l.id} data-state={l.state}>
      <div className="min-w-0 flex-1 space-y-1">
        {editing
          ? <textarea className="k-field h-auto min-h-[3.5rem] w-full resize-y py-1.5 leading-snug" value={text} maxLength={600} onChange={(e) => setText(e.target.value)} data-testid="lesson-edit-text" />
          : <div className="text-ui leading-snug" data-testid="lesson-words">{l.text}</div>}
        <div className="text-caption text-muted" data-testid="lesson-line">{lineOf(l)}</div>
        <div className="flex flex-wrap gap-x-3 text-caption text-faint tabular-nums">
          <span>{l.repo_name}, {sourceWords(l)}</span>
          <span data-testid="lesson-given">{l.given ? `Told to ${plural(l.given, "agent")}` : "Told to no agent yet"}</span>
          {l.accepted && <span>Accepted {ago(l.accepted)}</span>}
          {l.exp_id && <button type="button" className="k-link hover:underline" onClick={() => navigate({ name: "settings", section: "experiments" })}>Its trial</button>}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {editing
          ? <>
              <button type="button" className="k-btn" data-ink="" disabled={busy || !text.trim()} onClick={() => act(async () => { await editLesson(l.id, text); setEditing(false); })}>Save</button>
              <button type="button" className="k-btn" disabled={busy} onClick={() => { setText(l.text); setEditing(false); }}>Cancel</button>
            </>
          : l.state !== "trial" && <button type="button" className="k-btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
        <button type="button" className="k-btn" disabled={busy} data-testid="lesson-retire" onClick={() => act(() => dropLesson(l.id))}>Retire</button>
      </div>
    </div>
  );
}

function Folded({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testid}>
      <button type="button" className="k-btn" data-quiet="" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("transition-transform", open && "rotate-90")} />{title}
      </button>
      {open && <Card>{children}</Card>}
    </div>
  );
}

export function LessonsPanel() {
  const [data, setData] = useState<Lessons | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => listLessons().then(setData).catch((e) => setErr(failed(e, { at: "LessonsPanel" }))), []);
  useEffect(() => {
    void load();
    const off = onFeature({ frame: (f) => { if (f.name === "lessons") void load(); }, reconnect: () => void load() });
    const heard = scope.feed("lessons"); // a lesson drafted or decided is told while this panel is up (lib/scope.ts)
    return () => { off(); heard(); };
  }, [load]);
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    f().then(load).catch((e) => setErr(failed(e, { at: "LessonsPanel" }))).finally(() => setBusy(false));
  };
  const all = data?.lessons ?? [];
  const of = (...states: Lesson["state"][]) => all.filter((l) => states.includes(l.state));
  const open = of("proposed"), drafting = of("drafting"), live = of("trial", "accepted", "kept"), quiet = of("quiet"), gone = of("dropped");
  return (
    <div className="flex flex-col gap-4" data-testid="lessons">
      <div className="flex items-start gap-4">
        <p className="min-w-0 flex-1 text-ui text-muted">
          A failure that repeats the same way across agent trees of one repository becomes a proposed note for its agents, with the sessions and counts it was read from.
          An accepted note is told to the repository's agents at their start, never put in a system prompt, and a trial gives it to half of the new agent trees to show whether that failure falls.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {data?.mine && <span className="text-caption text-faint tabular-nums" data-testid="lessons-mined" title={when(data.mine.ts)}>Read {ago(data.mine.ts)}, {plural(data.mine.found, "cause")} over {data.days} days</span>}
          <button type="button" className="k-btn" disabled={busy} data-testid="lessons-mine" onClick={() => act(mineLessons)}>Look again</button>
        </div>
      </div>
      {err && <p className="text-ui text-danger" role="alert">{err}</p>}
      <h3 className="k-label">Proposed</h3>
      <Card>
        {data === null ? <p className="py-4 text-ui text-muted">Reading...</p>
          : !open.length && !drafting.length ? <p className="py-4 text-ui text-muted" data-testid="lessons-none">No lesson to decide. One is proposed when a failure repeats in three agent trees of a repository.</p>
          : <>
              {open.map((l) => <Proposal key={l.id} l={l} busy={busy} act={act} />)}
              {drafting.map((l) => (
                <div key={l.id} className="flex items-baseline gap-2 border-b border-line py-3 text-ui text-muted last:border-0" data-testid="lesson-drafting">
                  <span className="font-medium text-fg">{l.repo_name}</span><span>Drafting a note for a {sourceWords(l)} that failed in {plural(l.evidence.trees, "agent tree")}.</span>
                </div>
              ))}
            </>}
      </Card>
      {live.length > 0 && (
        <>
          <h3 className="k-label">In use</h3>
          <Card>{live.map((l) => <InUse key={l.id} l={l} busy={busy} act={act} />)}</Card>
        </>
      )}
      {quiet.length > 0 && (
        <Folded title={`${plural(quiet.length, "cause")} with no lesson to draft`} testid="lessons-quiet">
          {quiet.map((l) => (
            <div key={l.id} className="flex items-start gap-4 border-b border-line py-3 last:border-0" data-testid="lesson-quiet" data-lesson={l.id}>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-baseline gap-2"><span className="text-ui font-medium">{l.repo_name}</span><span className={cn(tag, "bg-sunken text-muted")}>{sourceWords(l)}</span></div>
                <div className="truncate font-mono text-micro text-muted" title={l.evidence.examples[0]}>{l.evidence.examples[0]}</div>
                <div className="text-caption text-faint">{plural(l.evidence.failures, "failure")} in {plural(l.evidence.trees, "agent tree")}{l.why_none ? `. Not drafted: ${l.why_none}` : ""}</div>
              </div>
              <button type="button" className="k-btn shrink-0" disabled={busy} onClick={() => act(() => proposeLesson(l.id))}>Propose</button>
            </div>
          ))}
        </Folded>
      )}
      {gone.length > 0 && (
        <Folded title={`${plural(gone.length, "lesson")} dropped`} testid="lessons-dropped">
          {gone.map((l) => (
            <div key={l.id} className="flex items-start gap-4 border-b border-line py-3 last:border-0" data-testid="lesson-dropped" data-lesson={l.id}>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-ui leading-snug">{l.text}</div>
                <div className="text-caption text-muted">{l.repo_name}, {sourceWords(l)}{l.ended ? `, dropped ${ago(l.ended)}` : ""}{l.outcome ? `. Its trial: ${armLine(l.outcome)}. ${l.outcome.text}` : ""}</div>
              </div>
              <button type="button" className="k-btn shrink-0" disabled={busy} onClick={() => act(() => acceptLesson(l.id, l.text))}>Accept again</button>
            </div>
          ))}
        </Folded>
      )}
    </div>
  );
}
