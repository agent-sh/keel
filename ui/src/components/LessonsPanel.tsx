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
import { Empty, Group, Item, List, Notice, Page, Status } from "./settings/kit.tsx";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
// What a cause is, in the owner's words.
const sourceWords = (l: Lesson) => (l.source === "tool" ? `${l.label} call` : l.source === "review" ? "review finding" : l.label.split(" ")[0] === "agent" ? "agent failure" : `${l.label.split(" ")[0]} failure`);
const rate = (v: number | null) => (v === null ? "not measured" : `${v === 0 ? "0" : (v * 100).toFixed(v * 100 < 10 ? 1 : 0)} per 100 trees`);
const armLine = (o: Outcome) => o.arms.map((a) => `${a.arm}: ${rate(a.per_tree)} (${plural(a.trees, "tree")})`).join(", ");
// What a trial of the cause would need, from the repository's own pace of agent trees.
function trialWords(e: Lesson["evidence"]): string {
  if (!e.repo_trees || e.rate === undefined || !e.per_arm) return "";
  const share = `${(e.rate * 100).toFixed(e.rate * 100 < 10 ? 1 : 0)}% of the repository's ${plural(e.repo_trees, "tree")} failed with it`;
  const days = e.trial_days === undefined || e.trial_days > 365 ? "more than a year" : `about ${plural(e.trial_days, "day")}`;
  return `${share}. A trial needs ${e.per_arm} trees an arm: ${days} at ${e.trees_a_day} trees a day.`;
}

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
      {trialWords(e) && <div className="text-caption text-faint tabular-nums" data-testid="lesson-trial">{trialWords(e)}</div>}
    </div>
  );
}

function Proposal({ l, busy, act }: { l: Lesson; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [text, setText] = useState(l.text);
  useEffect(() => setText(l.text), [l.text]);
  return (
    <div className="space-y-3 border-b border-line py-4 last:border-0" data-testid="lesson-proposal" data-lesson={l.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 text-ui font-medium [overflow-wrap:anywhere]">{l.repo_name}</span>
        <Status>{sourceWords(l)}</Status>
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
  if (l.state === "undecided") return `On trial, undecided: told to every agent of ${l.repo_name}. ${l.outcome ? `${armLine(l.outcome)}. ` : ""}${l.outcome?.text ?? ""}`.trim();
  return "";
}

function InUse({ l, busy, act }: { l: Lesson; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.text);
  return (
    <Item testid="lesson-live" data-lesson={l.id} data-state={l.state}
      name={editing
        ? <textarea className="k-field h-auto min-h-[3.5rem] w-full resize-y py-1.5 font-normal leading-snug" value={text} maxLength={600} onChange={(e) => setText(e.target.value)} data-testid="lesson-edit-text" />
        : <span className="font-normal leading-snug" data-testid="lesson-words">{l.text}</span>}
      sub={<>
        <div className="text-muted" data-testid="lesson-line">{lineOf(l)}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 tabular-nums">
          <span>{l.repo_name}, {sourceWords(l)}</span>
          <span data-testid="lesson-given">{l.given ? `Told to ${plural(l.given, "agent")}` : "Told to no agent yet"}</span>
          {l.accepted && <span>Accepted {ago(l.accepted)}</span>}
          {l.exp_id && <button type="button" className="k-link hover:underline" onClick={() => navigate({ name: "settings", section: "experiments" })}>Its trial</button>}
        </div>
      </>}
      actions={<>
        {editing
          ? <>
              <button type="button" className="k-btn" data-ink="" disabled={busy || !text.trim()} onClick={() => act(async () => { await editLesson(l.id, text); setEditing(false); })}>Save</button>
              <button type="button" className="k-btn" disabled={busy} onClick={() => { setText(l.text); setEditing(false); }}>Cancel</button>
            </>
          : l.state !== "trial" && <button type="button" className="k-btn" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
        <button type="button" className="k-btn" disabled={busy} data-testid="lesson-retire" onClick={() => act(() => dropLesson(l.id))}>Retire</button>
      </>} />
  );
}

// A group shown on asking: its head is the button that opens it.
function Folded({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Group testid={testid} title={
      <button type="button" className="k-btn" data-quiet="" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("transition-transform", open && "rotate-90")} />{title}
      </button>
    }>
      {open ? <List label={title}>{children}</List> : undefined}
    </Group>
  );
}

// A cause in a folded list: its repository and kind, an example, its counts, and the one act on it.
function Cause({ l, line, act, testid }: { l: Lesson; line: ReactNode; act: ReactNode; testid: string }) {
  return (
    <Item testid={testid} data-lesson={l.id} name={l.repo_name} status={<Status>{sourceWords(l)}</Status>} actions={act}
      sub={<>
        <div className="truncate font-mono text-micro text-muted" title={l.evidence.examples[0]}>{l.evidence.examples[0]}</div>
        <div className="mt-0.5 tabular-nums">{line}</div>
      </>} />
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
  const open = of("proposed"), drafting = of("drafting"), live = of("trial", "accepted", "undecided", "kept"), waiting = of("waiting"), quiet = of("quiet"), gone = of("dropped");
  return (
    <Page testid="lessons" intro={<>
      A failure that repeats the same way across agent trees of one repository becomes a proposed note for its agents, with the sessions and counts it was read from.
      An accepted note is told to the repository's agents at their start, never put in a system prompt, and a trial gives it to half of the new agent trees to show whether that failure falls.
    </>}>
      {err && <Notice tone="broken"><span role="alert">{err}</span></Notice>}
      <Group title="Proposed" count={open.length + drafting.length || undefined}
        hint={data?.mine && <span className="tabular-nums" data-testid="lessons-mined" title={when(data.mine.ts)}>Read {ago(data.mine.ts)}, {plural(data.mine.found, "cause")} over {data.days} days.</span>}
        actions={<button type="button" className="k-btn k-btn-lg" disabled={busy} data-testid="lessons-mine" onClick={() => act(mineLessons)}>Look again</button>}>
        {data === null ? <Empty>Reading.</Empty>
          : !open.length && !drafting.length ? <Empty testid="lessons-none">No lesson to decide. One is proposed when a failure repeats in three agent trees of a repository, often enough for a trial to decide within a week.</Empty>
          : <>
              {open.map((l) => <Proposal key={l.id} l={l} busy={busy} act={act} />)}
              {drafting.length > 0 && (
                <List label="Drafting">
                  {drafting.map((l) => <Item key={l.id} testid="lesson-drafting" name={l.repo_name} sub={`Drafting a note for a ${sourceWords(l)} that failed in ${plural(l.evidence.trees, "agent tree")}.`} />)}
                </List>
              )}
            </>}
      </Group>
      {waiting.length > 0 && (
        <Folded title={`${plural(waiting.length, "more cause")}, not drafted`} testid="lessons-waiting">
          {waiting.map((l) => (
            <Cause key={l.id} l={l} testid="lesson-waiting" line={<>{plural(l.evidence.failures, "failure")} in {plural(l.evidence.trees, "agent tree")}. {trialWords(l.evidence)}</>}
              act={<button type="button" className="k-btn" disabled={busy} onClick={() => act(() => proposeLesson(l.id))}>Draft</button>} />
          ))}
        </Folded>
      )}
      {live.length > 0 && (
        <Group title="In use" count={live.length}>
          <List label="In use">{live.map((l) => <InUse key={l.id} l={l} busy={busy} act={act} />)}</List>
        </Group>
      )}
      {quiet.length > 0 && (
        <Folded title={`${plural(quiet.length, "cause")} with no lesson to draft`} testid="lessons-quiet">
          {quiet.map((l) => (
            <Cause key={l.id} l={l} testid="lesson-quiet" line={<>{plural(l.evidence.failures, "failure")} in {plural(l.evidence.trees, "agent tree")}{l.why_none ? `. Not drafted: ${l.why_none}` : ""}</>}
              act={<button type="button" className="k-btn" disabled={busy} onClick={() => act(() => proposeLesson(l.id))}>Propose</button>} />
          ))}
        </Folded>
      )}
      {gone.length > 0 && (
        <Folded title={`${plural(gone.length, "lesson")} dropped`} testid="lessons-dropped">
          {gone.map((l) => (
            <Item key={l.id} testid="lesson-dropped" data-lesson={l.id} name={<span className="font-normal leading-snug">{l.text}</span>}
              sub={<span className="text-muted">{l.repo_name}, {sourceWords(l)}{l.ended ? `, dropped ${ago(l.ended)}` : ""}{l.outcome ? `. Its trial: ${armLine(l.outcome)}. ${l.outcome.text}` : ""}</span>}
              actions={<button type="button" className="k-btn" disabled={busy} onClick={() => act(() => acceptLesson(l.id, l.text))}>Accept again</button>} />
          ))}
        </Folded>
      )}
    </Page>
  );
}
