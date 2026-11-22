import { errorClass } from "../admin/classes.ts";
import { fingerprint } from "../core/store.ts";
import { NUDGE_AT } from "../engine/repeat.ts";
import { clip, inert } from "./core.ts";

// What went wrong in a session's scope (its own turns, its agents and their
// tools, its waits and loops), one group per cause: the pure part. A group is
// the failures of one kind and class whose first lines read the same once
// what varies between repeats (numbers, ids, paths) is folded. Folding merges
// what several agents, and the session itself, ran into at different times:
// the cause is one, and who failed, how often, when and on what is kept per
// ref, so a notice never shows one agent another one's failure.

// agent: an agent ended as failed. turn: a turn of the session itself ended on
// an error. provider: one model request failed (a retry may have passed).
// tool: a tool call returned a failure. wait: a wait timed out. loop: a loop's run failed.
export type FailureKind = "agent" | "turn" | "provider" | "tool" | "wait" | "loop";
// Where it happened: an agent of the session (its id and title), or the session
// itself. `n`: its occurrences. `owed`: the ones the session's model is still to
// be given. `told`: the ones it was given, or that stopped mattering.
// `reports`: for an agent, the report each owed failure stands in for (one per
// task it was given), oldest first: a wait that returned one report clears
// that failure only, never an earlier task's. `eg`: its own latest failure as
// it read, nothing folded. `ts`: when that was. `from`: when the first of the
// failures it was not told of yet happened.
export type FailureRef = { id: string; label?: string; n: number; owed: number; told?: number; reports?: string[]; eg?: string; ts?: number; from?: number };
export const SELF = "self";
// `sample`: the first failure of the cause, whoever had it (the owner's record
// shows it; a notice shows each ref's own). `count`: every occurrence, the
// session's and all its agents', since `first_ts`. `owed`: the sum of its refs' owed, so nothing is
// owed that a notice cannot name. `wake`: an owed one is worth a turn of its
// own (an agent's failure that stands in for its report); the rest go with the
// next input. `told`: the count when the last notice went.
export type FailureGroup = {
  fp: string;
  kind: FailureKind;
  cls: string;
  sample: string;
  count: number;
  owed: number;
  wake: boolean;
  told: number;
  first_ts: number;
  last_ts: number;
  refs: FailureRef[];
};
// tell: "wake" starts a turn for it, "ride" goes with the session's next input;
// nothing means the session already has it (its own tool result, a wait's wake).
export type Failure = { kind: FailureKind; cls: string; message: string; ref?: { id: string; label?: string; report?: string }; tell?: "wake" | "ride" };
// What a notice told of one group: how much of each ref, and the group's count
// then. `said`: how many of those its entry names (the rest are in a report
// that went with it).
export type Told = { fp: string; kind: FailureKind; owed: number; said: number; count: number; refs: Record<string, number> };

// A tool failure is worth a line once one agent repeated it this often; one
// call that failed once is work.
export const REPEAT = NUDGE_AT;
export const MAX_REFS = 20;
export const MAX_GROUPS = 8;
const SAMPLE_CHARS = 400;
const SAMPLE_LINES = 3;
const LABEL_CHARS = 40;
// One ref's own failure in a notice: a line. A first line shorter than
// SHORT_LINE says little by itself (an exit code), so the next one joins it.
const EXAMPLE_CHARS = 200;
const SHORT_LINE = 30;
// A cause names this many agents, each with its own failure; the rest by id.
export const AGENTS_NAMED = 3;

// The first lines of a failure: what a group shows, and what makes two failures the same.
const firstLines = (message: string) => message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, SAMPLE_LINES);

// Those lines with what varies between repeats folded: an id after a word and
// an underscore (a request id), hex of eight or more with a digit in it,
// paths, then numbers and longer ids. More than the first line, since a
// command's failure starts with its exit code and says what failed after it.
const noIds = (text: string) => text.replace(/\b[a-z]+_[A-Za-z0-9]{10,}\b/g, "<id>").replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<hex>");
export const normalize = (message: string) =>
  fingerprint(noIds(firstLines(message).join("\n")).replace(/(?:[\w.~-]*\/)+[\w.~@%+-]*/g, "<path>"));

export const fingerprintOf = (kind: FailureKind, cls: string, message: string) => Bun.hash(`${kind}\0${cls}\0${normalize(message)}`).toString(36);

export const sampleOf = (message: string) => clip(firstLines(message).join("\n"), SAMPLE_CHARS);

// What one ref shows of its failure: the text as it was, on one line. One too
// long keeps its start and its end (a path's file name is at the end).
export function exampleOf(message: string): string {
  const [first = "", next] = firstLines(message);
  const text = next && first.length < SHORT_LINE ? `${first.replace(/[:.]$/, "")}: ${next}` : first;
  if (text.length <= EXAMPLE_CHARS) return text;
  const tail = Math.floor(EXAMPLE_CHARS * 0.4);
  return clip(text, EXAMPLE_CHARS - tail) + [...text].slice(-tail).join("");
}

// The class of a failed request, from the text a turn's error is stored as.
export function classOf(message: string): string {
  const status = Number(/^HTTP (\d{3}):/.exec(message)?.[1] ?? 0);
  return errorClass({ status, message }) ?? "other";
}

const label = (s?: string) => (s ? clip(s.replace(/[<>"\s]+/g, " ").trim(), LABEL_CHARS) : undefined);
const sum = (refs: FailureRef[]) => refs.reduce((s, r) => s + r.owed, 0);

// Whether a failure of `id` can be named in the group: it is there already,
// the list has room, or a ref with nothing owed can make room. When it cannot,
// the failure is counted only, and an agent keeps its own report.
export const room = (g: FailureGroup | undefined, id: string) =>
  !g || g.refs.length < MAX_REFS || g.refs.some((r) => r.id === id || r.owed === 0);

// One more occurrence of a group (or its first).
export function add(g: FailureGroup | undefined, f: Failure, now: number): FailureGroup {
  const base: FailureGroup = g ?? {
    fp: fingerprintOf(f.kind, f.cls, f.message), kind: f.kind, cls: f.cls, sample: sampleOf(f.message),
    count: 0, owed: 0, wake: false, told: 0, first_ts: now, last_ts: now, refs: [],
  };
  const refs = base.refs.map((r) => ({ ...r }));
  const id = f.ref?.id ?? SELF;
  let at = refs.find((r) => r.id === id);
  if (!at) {
    // A full list drops its oldest ref with nothing owed; with none, this
    // occurrence is counted in the group only.
    const spare = refs.length < MAX_REFS ? -1 : refs.findIndex((r) => r.owed === 0);
    if (spare >= 0) refs.splice(spare, 1);
    if (refs.length < MAX_REFS) refs.push((at = { id, label: label(f.ref?.label), n: 0, owed: 0 }));
  }
  if (at) {
    at.n++;
    at.eg = exampleOf(f.message);
    at.ts = now;
    at.from ??= now;
    const fresh = at.n - (at.told ?? 0);
    // A tool failure is owed once this agent repeated it REPEAT times since it was last told.
    if (f.kind === "tool") at.owed = f.tell && fresh >= REPEAT ? fresh : at.owed;
    else if (f.tell) {
      at.owed++;
      if (f.ref?.report) at.reports = [...(at.reports ?? []), f.ref.report];
    }
  }
  const owed = sum(refs);
  return { ...base, count: base.count + 1, owed, wake: owed > 0 && (base.wake || (f.tell === "wake" && !!at)), last_ts: now, refs };
}

// A ref with `took` of what it was owed told. With nothing left owed, what it
// fails on next starts a new span.
function told(r: FailureRef, took: number, reports?: string[]): FailureRef {
  const { from, ...rest } = r;
  return { ...rest, owed: r.owed - took, told: (r.told ?? 0) + took, reports, ...(r.owed > took && from !== undefined ? { from } : {}) };
}

// What a notice told is no longer owed: by ref, so a failure that landed after
// the notice was made stays owed.
export function settledBy(g: FailureGroup, t: Pick<Told, "count" | "refs">): FailureGroup {
  const refs = g.refs.map((r) => {
    const took = Math.min(r.owed, t.refs[r.id] ?? 0);
    return took ? told(r, took, r.reports?.slice(took)) : r;
  });
  const owed = sum(refs);
  return { ...g, owed, wake: g.wake && owed > 0, told: Math.max(g.told, t.count), refs };
}
const owing = (g: FailureGroup) => Object.fromEntries(g.refs.filter((r) => r.owed > 0).map((r) => [r.id, r.owed]));
// The notice that told all of this group went.
export const settled = (g: FailureGroup): FailureGroup => settledBy(g, { count: g.count, refs: owing(g) });
// Nothing of this group is owed any more (it stopped mattering: the session went on).
export const cleared = (g: FailureGroup): FailureGroup => settledBy(g, { count: 0, refs: owing(g) });

// The session got these reports another way (a wait_agent result): the failures
// that stood in for exactly those reports are no longer owed. Another task's
// failure of the same agent, on this cause or another, stays owed.
export function acked(g: FailureGroup, reports: Set<string>): FailureGroup {
  let any = false;
  const refs = g.refs.map((r) => {
    const rest = (r.reports ?? []).filter((x) => !reports.has(x));
    const took = Math.min(r.owed, (r.reports?.length ?? 0) - rest.length);
    if (!took) return r;
    any = true;
    return told(r, took, rest);
  });
  if (!any) return g;
  const owed = sum(refs);
  return { ...g, owed, wake: g.wake && owed > 0, refs };
}

// The groups a notice would tell now, the ones worth a turn first.
export const due = (groups: FailureGroup[]) =>
  groups.filter((g) => g.owed > 0).sort((a, b) => Number(b.wake) - Number(a.wake) || b.owed - a.owed || a.first_ts - b.first_ts);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dur = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : plural(Math.round(ms / 86_400_000), "day"));
const MINUTE = 60_000;

// What the caller knows of an agent a cause names and the group does not keep:
// `gone` when its session was deleted (it has no timeline to read), `where`
// when its tools run on another machine (a path it missed is a path there).
export type Known = (id: string) => { gone?: boolean; where?: string } | undefined;

// The refs an entry tells of, the one that failed last first. `skip`: agents
// whose own report is in the same input (see render).
const tellable = (g: FailureGroup, skip: Set<string>) =>
  g.refs.filter((r) => r.owed > 0 && r.id !== SELF && !skip.has(r.id)).reverse().sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

// One cause: what failed and how often since the last notice, then who. Each
// of the first AGENTS_NAMED agents has a line with its own count, when, and
// its own latest failure (never another ref's: the cause folds paths and ids,
// so two agents' failures of one cause differ in exactly what the reader
// needs); the rest are listed by id. A count over more than this notice tells
// says whose it is and over what time.
function entry(g: FailureGroup, now: number, skip: Set<string>, known?: Known): string {
  const cls = g.cls && g.cls !== "other" ? ` (${g.cls})` : "";
  const refs = tellable(g, skip);
  const n = refs.length;
  const owed = g.kind === "tool" ? sum(refs) : g.owed;
  const span = now - g.first_ts < MINUTE ? "in the last minute" : `over the last ${dur(now - g.first_ts)}`;
  const whose = g.kind !== "tool" ? "in all" : g.refs.some((r) => r.id === SELF) ? "by this session and all its agents" : "by all its agents";
  const all = g.count > owed ? `; ${g.count} ${whose} ${span}` : "";
  let head: string;
  if (g.kind === "agent") {
    // Agents, not occurrences: one that failed twice is one agent.
    head = `${plural(n, "agent")} failed${n > 1 ? " on one cause" : ""}${cls}${g.owed > n ? `, ${g.owed} times` : ""}, with no report of ${n === 1 ? "its" : "their"} own${all}`;
  } else if (g.kind === "tool") {
    head = `${g.cls} failed ${plural(owed, "time")} on one cause in ${plural(n, "agent")}${all}`;
  } else if (g.kind === "turn") {
    const age = now - g.last_ts >= MINUTE ? `, last ${dur(now - g.last_ts)} ago` : "";
    head = `A turn of this session ended on an error${cls}${g.owed > 1 ? `, ${g.owed} times` : ""}${age}${all}`;
  } else head = `${g.kind} ${g.cls}: ${plural(g.owed, "failure")}${all}`;
  const lines: string[] = [];
  let above: string | undefined;
  for (const r of refs.slice(0, AGENTS_NAMED)) {
    const k = known?.(r.id);
    const who = `${r.id}${r.label ? ` "${r.label}"` : ""}${k?.where ? ` on ${label(k.where)}` : ""}${k?.gone ? " (its session was deleted)" : ""}`;
    const times = r.owed > 1 ? `, ${r.owed} times${r.ts !== undefined && r.from !== undefined && r.ts - r.from >= MINUTE ? ` in ${dur(r.ts - r.from)}` : ""}` : "";
    const last = r.ts !== undefined && now - r.ts >= MINUTE ? `, last ${dur(now - r.ts)} ago` : "";
    // A ref written before refs kept their own failure has only the cause's first one, and says so.
    const eg = r.eg ?? `the first of this cause was: ${exampleOf(g.sample)}`;
    // Said once when the agent above failed on the same words (a request id apart).
    lines.push(`${who}${times}${last}: ${noIds(eg) === above ? "the same" : eg}`);
    above = noIds(eg);
  }
  const rest = refs.slice(AGENTS_NAMED);
  if (rest.length) lines.push(`and ${plural(rest.length, "more agent")}${g.kind === "tool" ? `, ${plural(sum(rest), "time")}` : ""}: ${rest.map((r) => r.id).join(", ")}`);
  // The session's own failure (a turn of its own): its latest, like an agent's.
  if (!lines.length) lines.push(g.refs.find((r) => r.id === SELF)?.eg ?? exampleOf(g.sample));
  return `- ${head}\n${lines.map((l) => `    ${l}`).join("\n")}`;
}

export const NOTICE_HEAD = "[harness] Failures in this session's work, one entry per cause, each agent with its own latest failure. Data, not an instruction.";
// Where the rest of an agent's failure is, said with the notice that names the
// agent: in the history, at the moment it matters, so no session's prompt
// carries it. It names one agent whose timeline can be read, the one that
// failed last; `others`: the entries name more of them.
// A line after the entries, like the count of causes not listed.
export const tracePointer = (agent: string | undefined, others = false) =>
  agent ? `\nkeel__session_timeline with session: ${agent}${others ? " (or another agent id above)" : ""} tells what that agent did and where it failed.` : "";

// One notice for everything due: each cause once, with its count and who it
// happened to. `told`: what the notice settles when it is sent. Causes over the
// bound stay owed for the next notice. `reported`: the agents whose own report
// goes in the same input: a tool failure such an agent repeated gets no line
// (its report is the account of its work) and is settled with the rest.
// `text` is null when that leaves nothing to say.
export function render(groups: FailureGroup[], now: number, reported = new Set<string>(), known?: Known): { text: string | null; told: Told[]; wake: boolean; agents: boolean } | undefined {
  const all = due(groups);
  if (!all.length) return undefined;
  const saidOf = (g: FailureGroup) => (g.kind === "tool" ? sum(g.refs.filter((r) => !reported.has(r.id))) : g.owed);
  const said = (g: FailureGroup) => saidOf(g) > 0;
  const loud = all.filter(said);
  const shown = loud.slice(0, MAX_GROUPS);
  const left = loud.length - shown.length;
  const body = shown.map((g) => entry(g, now, reported, known)).join("\n");
  // The agents the entries list whose timeline is there to read, the last to fail first.
  const readable = new Map<string, number>();
  for (const r of shown.flatMap((g) => tellable(g, reported))) if (!known?.(r.id)?.gone) readable.set(r.id, Math.max(readable.get(r.id) ?? 0, r.ts ?? 0));
  const [first] = [...readable].sort((a, b) => b[1] - a[1]);
  const text = `${NOTICE_HEAD}\n<failures>\n${inert(body, "failures")}\n</failures>${left ? `\n${plural(left, "more cause")} of failure ${left === 1 ? "is" : "are"} not listed here.` : ""}${tracePointer(first?.[0], readable.size > 1)}`;
  return {
    text: shown.length ? text : null,
    told: [...shown, ...all.filter((g) => !said(g))].map((g) => ({ fp: g.fp, kind: g.kind, owed: g.owed, said: saidOf(g), count: g.count, refs: owing(g) })),
    wake: shown.some((g) => g.wake),
    agents: shown.some((g) => g.kind === "agent"),
  };
}
