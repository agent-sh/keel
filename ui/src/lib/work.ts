// The work of a turn as the transcript shows it: its tool calls in steps. A
// step is a run of calls of one family (looking things up, changing files,
// running commands, other tools), begun anew by what the model says in
// passing. What a step's line says is read from its calls and their results,
// never from the model's words.
// Pure: rows.ts keeps the steps of a row with these, a call at a time.
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { commandOf } from "../../../src/core/command.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import { HOOK_BLOCKED, RESTART_CUT, notRun, stopKind, stoppedRunning, turnedAway } from "../../../src/core/stops.ts";
import { patchFiles, resultText, shellStatus, toolKind, type ToolKind, splitDiagnostics, splitMemory, splitNested } from "./tools.ts";
import { NEEDS, STATE_WORD, countWord } from "../../../src/core/state-words.ts";
import { agentTitle } from "../../../src/automation/agent-title.ts";
import { errorLine } from "./error-line.ts";

// `card`: a call with a card of its own (a question, code, readers): always a step by itself, as is a plan update.
// `agents`: agents started; the ones started one after another are one step, also across the few words
// the model says between them (a coordinator that starts twelve says twelve lines).
export type Family = "explore" | "change" | "run" | "use" | "card" | "agents" | "plan" | "said";
export type WorkItem =
  | { t: "call"; id: string; use: ToolUseBlock; result?: ToolResultBlock; event: string }
  | { t: "note"; id: string; text: string; event: string }
  | { t: "thought"; id: string; text: string; event: string };
// `key`: the id of the step's first item, for the page's list. `said`: a step
// that holds no call yet (what the model said or thought on the way to one).
export type Step = { key: string; family: Family; items: WorkItem[] };

const FAMILY: Partial<Record<ToolKind, Family>> = {
  read: "explore", search: "explore", glob: "explore", list: "explore", web: "explore", fetch: "explore",
  edit: "change", write: "change", patch: "change", notebook: "change",
  shell: "run", stdin: "run", stop: "run",
  ask: "card", plan: "plan",
};
const CARDS = new Set(["run_code", "AskReaders", "ask_readers"]);
const AGENTS = new Set(["Agent", "spawn_agent"]);
export const familyOf = (name: string): Family => (AGENTS.has(name) ? "agents" : CARDS.has(name) ? "card" : FAMILY[toolKind(name)] ?? "use");
const ALONE = new Set<Family>(["card", "plan"]);

// A line the model says in passing (one short paragraph of plain words) stands
// on the rail with the step it leads to. Anything longer or shaped (a list, a
// table, code, a heading) is a reply: it keeps the reading size.
export const ASIDE_MAX = 240;
export const isAside = (text: string): boolean => {
  const t = text.trim();
  return t.length <= ASIDE_MAX && !/\n\s*\n/.test(t) && !/(^|\n)\s*([-*+] |\d+[.)] |#{1,6} |>|\|)|```/.test(t);
};
// Words short enough to stand beside the call they lead to, on its row.
export const BESIDE_MAX = 28;
export const isBeside = (text: string): boolean => { const t = text.trim(); return t.length <= BESIDE_MAX && !t.includes("\n"); };
type Note = Extract<WorkItem, { t: "note" }>;
// The words of a step that could stand beside its line: its one short note.
export function besideOf(step: Step): Note | undefined {
  const notes = step.items.filter((i): i is Note => i.t === "note");
  return notes.length === 1 && isBeside(notes[0]!.text) && step.items.some((i) => i.t === "call") ? notes[0] : undefined;
}
// A run is set as a table (what was said, what was done) when the model said a
// few words before most of its steps: one short line in a long run stands
// above its step instead, and the run keeps its whole width.
export const isTable = (steps: Step[]): boolean => {
  const did = steps.filter((st) => st.items.some((i) => i.t === "call"));
  return did.length > 0 && did.filter((st) => besideOf(st)).length * 2 >= did.length;
};

const isCall = (i: WorkItem): i is Extract<WorkItem, { t: "call" }> => i.t === "call";

// The calls of one reply in the order the rail shows them: by family, in the
// order each family first appears. The model sent them together, so their
// order inside the reply explains nothing, and a hundred mixed calls are a
// few lines instead of a line each.
export function byFamily(uses: ToolUseBlock[]): ToolUseBlock[] {
  if (uses.length < 3) return uses;
  const order: Family[] = [];
  for (const u of uses) { const f = familyOf(u.name); if (!order.includes(f)) order.push(f); }
  return order.length === uses.length || order.length === 1 ? uses : order.flatMap((f) => uses.filter((u) => familyOf(u.name) === f));
}

// The steps with one more call. A call of the last step's family joins it; any
// other starts a step, and takes with it what the model thought since the last
// step's last call.
export function addCall(steps: Step[], use: ToolUseBlock, event: string): Step[] {
  const item: WorkItem = { t: "call", id: use.id, use, event };
  const family = familyOf(use.name);
  const last = steps.at(-1);
  if (!last) return [{ key: item.id, family, items: [item] }];
  // An agent started after a few words of the model's (no more than an aside) joins the agents started just before them.
  const before = steps.at(-2);
  if (family === "agents" && last.family === "said" && before?.family === "agents" && last.items.every((i) => i.t === "thought" || (i.t === "note" && isAside(i.text))))
    return [...steps.slice(0, -2), { ...before, items: [...before.items, ...last.items, item] }];
  if (last.family === "said") return [...steps.slice(0, -1), { ...last, family, items: [...last.items, item] }];
  if (last.family === family && !ALONE.has(family)) return [...steps.slice(0, -1), { ...last, items: [...last.items, item] }];
  let cut = last.items.length;
  while (cut > 0 && last.items[cut - 1]!.t === "thought") cut--;
  const lead = last.items.slice(cut);
  const head = lead.length ? [...steps.slice(0, -1), { ...last, items: last.items.slice(0, cut) }] : steps;
  return [...head, { key: (lead[0] ?? item).id, family, items: [...lead, item] }];
}

// What the model said in passing starts a step: its words lead the calls that
// follow. What it thought goes with the step before until a call says which
// step it led to.
export function addMeta(steps: Step[], item: WorkItem): Step[] {
  const last = steps.at(-1);
  if (last && (last.family === "said" || (item.t === "thought" && !ALONE.has(last.family)))) return [...steps.slice(0, -1), { ...last, items: [...last.items, item] }];
  return [...steps, { key: item.id, family: "said", items: [item] }];
}

// The steps with a call's result, or null when the call is not among them.
export function setResult(steps: Step[], id: string, result: ToolResultBlock): Step[] | null {
  for (let s = steps.length - 1; s >= 0; s--) {
    const k = steps[s]!.items.findIndex((i) => i.t === "call" && i.id === id);
    if (k < 0) continue;
    const items = steps[s]!.items.slice();
    items[k] = { ...(items[k] as Extract<WorkItem, { t: "call" }>), result };
    const out = steps.slice();
    out[s] = { ...steps[s]!, items };
    return out;
  }
  return null;
}

export const callsOf = (step: Step) => step.items.filter(isCall);

// Two steps that show the same: the same items, each call with the same result.
export const sameStep = (a: Step, b: Step) =>
  a === b || (a.key === b.key && a.family === b.family && a.items.length === b.items.length && a.items.every((it, k) => {
    const o = b.items[k]!;
    return it === o || (it.t === o.t && it.id === o.id && (it.t !== "call" || (it.use === (o as typeof it).use && it.result === (o as typeof it).result)));
  }));

// How a call ended, as its record says: done; failed (it ran and failed); turned
// away before it ran, by the owner on its card (denied) or by the policy, the
// reviewer or the judge (refused); or ended under it by the owner's stop or a
// restart. Only the first of these is a failure. Without a result it still runs.
// `unrun`: the turn did not run it for a reason of its own (its reply was cut at the output limit inside it).
export type CallState = "running" | "ok" | "error" | "denied" | "refused" | "stopped" | "cut" | "unrun";
export const callState = (result?: ToolResultBlock): CallState =>
  !result ? "running" : result.is_error ? (stopKind(result.content) ?? turnedAway(resultText(result)) ?? (notRun(result.content) ? "unrun" : "error")) : "ok";

// How a call looks, with what the page knows beyond the record: a call with no
// result runs only while its session works; it waits when its approval card is
// open; in an idle session it has no result and never will. A call the page
// knows was refused (the list of refusals) is refused whatever its result says.
export type Look = "running" | "waiting" | "unfinished" | "ok" | "error" | "denied" | "refused" | "stopped" | "cut" | "unrun";
// `own`: the calls shown on lines of their own under the step, which the step's line does not name again.
// `cwd`: the session's folder, for naming a changed file under a hidden folder with that folder.
export type Live = { working: boolean; waiting?: ReadonlySet<string>; refused?: ReadonlySet<string>; own?: ReadonlySet<string>; cwd?: string };
export const lookOf = (c: { id: string; result?: ToolResultBlock }, live: Live): Look =>
  c.result ? (live.refused?.has(c.id) ? "refused" : callState(c.result)) : live.waiting?.has(c.id) ? "waiting" : live.working ? "running" : "unfinished";
// A call to a tool the session does not have: it did not run.
export const noSuchTool = (result?: ToolResultBlock): boolean => !!result?.is_error && /^No tool named /.test(resultText(result));
// Whether the call was carried out, in whole or in part: it ran, runs, or was ended while it ran.
// `change`: the call changes a file: one that failed changed nothing (a command that failed did run).
export const ranOf = (look: Look, result?: ToolResultBlock, change = false): boolean =>
  look === "ok" || (look === "error" && !change && !noSuchTool(result)) || look === "running" || (look === "stopped" && stoppedRunning(result?.content)) || (look === "cut" && result?.content === RESTART_CUT);

const base = (p: string) => p.replace(/\/+$/, "").split("/").at(-1) || p;
// A changed file as a step's line names it: its name, and for a file under a
// hidden folder of the session's folder (.github/workflows/ci.yml) the path
// from that folder on: there the name alone does not say what the file is.
export function changedName(path: string, cwd?: string): string {
  const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : null;
  const parts = rel?.split("/") ?? [];
  const hidden = parts.findIndex((seg, i) => i < parts.length - 1 && seg.startsWith(".") && seg !== "." && seg !== "..");
  return hidden >= 0 ? parts.slice(hidden).join("/") : base(path);
}
const linesOf = (s: string) => s.split("\n").filter((l) => l.trim());
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const patchText = (input: any) => (typeof input === "string" ? input : String(input?.input ?? input?.patch ?? ""));

// The command of a shell call as text, and how many lines of it follow the first.
export const commandText = (use: ToolUseBlock): string => commandOf(use.input) ?? "";
export const moreLines = (use: ToolUseBlock): number => Math.max(0, linesOf(commandText(use)).length - 1);

// The files a change call names, and how many lines it adds and removes.
const changes = new WeakMap<object, { files: string[]; added: number; removed: number }>();
export function changeOf(use: ToolUseBlock): { files: string[]; added: number; removed: number } {
  const had = changes.get(use);
  if (had) return had;
  const input: any = use.input ?? {};
  const kind = toolKind(use.name);
  let out = { files: [] as string[], added: 0, removed: 0 };
  if (kind === "patch") {
    const files = patchFiles(patchText(input));
    const lines = files.flatMap((f) => f.lines);
    out = { files: files.map((f) => f.moveTo ?? f.path), added: lines.filter((l) => l[0] === "+").length, removed: lines.filter((l) => l[0] === "-").length };
  } else {
    const path = input.file_path ?? input.notebook_path ?? input.path;
    const files = typeof path === "string" && path ? [path] : [];
    if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
      const ops = diffLines(splitLines(input.old_string), splitLines(input.new_string));
      out = { files, added: ops.filter((o) => o.t === "+").length, removed: ops.filter((o) => o.t === "-").length };
    } else if (kind === "write" && typeof input.content === "string") out = { files, added: splitLines(input.content).length, removed: 0 };
    else out = { files, added: 0, removed: 0 };
  }
  changes.set(use, out);
  return out;
}

// The lines a small change adds and removes, to show under its closed line:
// nothing when it changes more than SMALL lines (its line says how many).
export const SMALL = 6;
export function smallChange(use: ToolUseBlock): { t: "+" | "-"; text: string }[] | null {
  const input: any = use.input ?? {};
  const kind = toolKind(use.name);
  const { added, removed } = changeOf(use);
  if (!(added + removed) || added + removed > SMALL) return null;
  if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string")
    return diffLines(splitLines(input.old_string), splitLines(input.new_string)).filter((o) => o.t !== " ").map((o) => ({ t: o.t as "+" | "-", text: o.line }));
  if (kind === "write" && typeof input.content === "string") return splitLines(input.content).map((text) => ({ t: "+" as const, text }));
  if (kind === "patch") return patchFiles(patchText(input)).flatMap((f) => f.lines).filter((l) => l[0] === "+" || l[0] === "-").map((l) => ({ t: l[0] as "+" | "-", text: l.slice(1) }));
  return null;
}

// What an agent was started for: the first line of its task.
// The name its agent is listed by (src/automation/agent-title.ts), before the agent is known.
export const agentTask = (use: ToolUseBlock): string => { const i: any = use.input ?? {}; return agentTitle({ title: typeof i.description === "string" ? i.description : undefined, task_name: typeof i.task_name === "string" ? i.task_name : undefined, prompt: String(i.message ?? i.prompt ?? "") }); };

// What a call was made on, as its line names it: a file, a pattern, a command.
export function targetOf(use: ToolUseBlock): string {
  const input: any = use.input ?? {};
  switch (toolKind(use.name)) {
    case "read": case "edit": case "write": case "notebook": case "list": return String(input.file_path ?? input.notebook_path ?? input.dir_path ?? input.path ?? "");
    case "patch": return changeOf(use).files.join(", ");
    case "search": case "glob": return String(input.pattern ?? "");
    case "web": return String(input.query ?? "");
    case "fetch": return String(input.url ?? "");
    case "shell": return linesOf(commandText(use))[0]?.trim() ?? "";
    default: return "";
  }
}

// Who turned a call away and why, from its result's own words, without what was written there for the
// model alone (what to do next).
export function refusalOf(result?: ToolResultBlock): { by: string; why: string } {
  const text = resultText(result).trim();
  const body = (t: string) => t.split(/\s+Do not (?:retry|try)\b/)[0]!.split("\n")[0]!.trim().slice(0, 300);
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^The reviewer refused this call(?: \([^)]*\))?: ([\s\S]*)$/))) return { by: "Reviewer", why: body(m[1]!) };
  if ((m = text.match(/^Refused by the (\w+)(?: \([^)]*\))?: ([\s\S]*)$/))) return { by: m[1]![0]!.toUpperCase() + m[1]!.slice(1), why: body(m[2]!) };
  if ((m = text.match(/^Refused: ([\s\S]*)$/))) return { by: "Keel", why: body(m[1]!) };
  if (text.startsWith(`${HOOK_BLOCKED}: `)) return { by: "Hook", why: body(text.slice(HOOK_BLOCKED.length + 2)) };
  if ((m = text.match(/^This session is (read-only|in plan mode)[:,]? ?([\s\S]*)$/))) return { by: m[1] === "read-only" ? "Read only" : "Plan mode", why: body(m[2]!) };
  return { by: "Keel", why: body(text) };
}

// Why a call failed, in one line of its own output: the first line that names
// an error, else the first line it printed. A line longer than the row shows
// ends at a word, with a mark that it goes on (the whole of it is in the open
// call): cut in the middle of a word it read as the end of what was said.
const LINE_MAX = 200;
// A line's paths as the transcript writes them: under the session's folder from it, under a home from ~.
export const shortPaths = (line: string, cwd?: string) => (cwd ? line.replaceAll(`${cwd}/`, "") : line).replace(/\/home\/[^/\s]+\//g, "~/");
// `cwd`: the session's folder. Paths are shortened before the line is cut: a long folder (a deep checkout,
// a test machine's scratch folder) would otherwise cut the name of the file the line is about.
export function failureLine(result?: ToolResultBlock, cwd?: string): string {
  // The tool's own output: not what a hook or the harness put into the result for the model (memory,
  // instructions that were loaded, what a language server found).
  const own = splitNested(splitDiagnostics(splitMemory(resultText(result)).text).text).text.replace(/<memory [^>]*>[\s\S]*?(<\/memory>|$)/g, "");
  const lines = own.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^(Exit code|Exit Code:|Process exited with code) ?-?\d+$/.test(l));
  const line = shortPaths(body[errorLine(body)] ?? body[0] ?? lines[0] ?? "", cwd);
  if (line.length <= LINE_MAX) return line;
  const head = line.slice(0, LINE_MAX);
  // Back to the last whole word, unless that gives up most of the line (one long path or token).
  const at = head.search(/\s+\S*$/);
  return `${(at > LINE_MAX / 2 ? head.slice(0, at) : head).replace(/[\s,;:(]+$/, "")}…`;
}

// The verb of a call, or of a step, the turn did not run for a reason of its own.
export const NOT_RUN = "Not run";
export type StepSummary = {
  ran: number;        // the calls carried out, in whole or in part
  soft: boolean;      // looking around: a call of it that failed is a note, not an alarm
  label: string;      // what was done, as one verb
  counts: string;     // how much, in words; empty when the targets say it
  targets: string[];  // to what: files, commands, patterns, tools (set in the code face)
  more: number;       // targets not named
  code: boolean;      // the targets are code (a path, a command), not words
  added: number; removed: number;
  calls: number;
  unrun?: string;     // why its calls that were not run were not (the first one's reason)
  looks: Record<Look, number>;
  exit?: number;      // a lone command's exit code when it failed
  thoughts: number;   // what the model thought on the way, behind the fold
};

// How many targets a line names before it says how many more there are. Changed
// files are named up to a dozen (the line wraps for them): which files a step
// changed is what its line is for.
const NAMED = 4, NAMED_CHANGES = 12;
const uniq = (list: string[]) => [...new Set(list.filter(Boolean))];
const TARGET_MAX = 96;
const clip = (t: string) => (t.length > TARGET_MAX ? `${t.slice(0, TARGET_MAX - 1).trimEnd()}\u2026` : t);

// `live.own`: the calls shown on lines of their own under the step (what the
// policy marks, what waits, failed or was turned away): they are counted, and
// never among the targets named or left out as "+N", so nothing is said twice
// and "+N" is exactly what the line does not show.
export function summarize(step: Step, live: Live = { working: true }): StepSummary {
  const work = callsOf(step);
  const looks: Record<Look, number> = { running: 0, waiting: 0, unfinished: 0, ok: 0, error: 0, denied: 0, refused: 0, stopped: 0, cut: 0, unrun: 0 };
  let ran = 0;
  let unrun: string | undefined;
  for (const c of work) {
    const look = lookOf(c, live);
    looks[look]++;
    if (ranOf(look, c.result, step.family === "change")) ran++;
    if (look === "unrun") unrun ??= notRun(c.result?.content);
  }
  const s: StepSummary = { ...(unrun ? { unrun } : {}), ran, soft: step.family === "explore", label: "", counts: "", targets: [], more: 0, code: true, added: 0, removed: 0, calls: work.length, looks, thoughts: step.items.filter((i) => i.t === "thought").length };
  const named = live.own?.size ? work.filter((c) => !live.own!.has(c.id)) : work;
  // A target is named whole up to a length: past it, it is cut in its own text, where the cut shows.
  const name = (list: string[], max = NAMED) => { const all = uniq(list); s.targets = all.slice(0, max).map(clip); s.more = all.length - s.targets.length; };
  const kinds = work.map((c) => toolKind(c.use.name));
  const count = (...ks: ToolKind[]) => kinds.filter((k) => ks.includes(k)).length;
  if (step.family === "explore") {
    const parts = [
      count("read") && plural(count("read"), "file", "files"),
      count("search", "glob") && plural(count("search", "glob"), "search", "searches"),
      count("list") && plural(count("list"), "folder", "folders"),
      count("web") && plural(count("web"), "web search", "web searches"),
      count("fetch") && plural(count("fetch"), "page", "pages"),
    ].filter(Boolean) as string[];
    const only = parts.length === 1 ? kinds[0]! : null;
    s.label = only === "read" ? "Read" : only === "search" || only === "glob" ? "Searched" : only === "list" ? "Listed" : only === "web" ? "Searched the web" : only === "fetch" ? "Fetched" : "Explored";
    // One call is named by its target; several by how many, then the files read.
    if (work.length > 1) s.counts = only === "search" || only === "glob" || only === "web" ? plural(work.length, "time", "times") : parts.join(", ");
    const reads = named.filter((c) => toolKind(c.use.name) === "read").map((c) => base(targetOf(c.use)));
    name(work.length === 1 || !reads.length ? named.map((c) => (["read", "list"].includes(toolKind(c.use.name)) ? base(targetOf(c.use)) : targetOf(c.use))) : reads);
  } else if (step.family === "change") {
    const all = work.map((c) => changeOf(c.use));
    s.label = work.every((c) => toolKind(c.use.name) === "write") ? "Wrote" : "Edited";
    // The lines of a change that was made, or is being made: one that failed or was turned away changed nothing.
    const made = work.filter((c) => { const look = lookOf(c, live); return look === "ok" || look === "running"; }).map((c) => changeOf(c.use));
    s.added = made.reduce((n, c) => n + c.added, 0);
    s.removed = made.reduce((n, c) => n + c.removed, 0);
    const files = uniq(all.flatMap((c) => c.files));
    if (files.length > 1) s.counts = plural(files.length, "file", "files");
    name(named.flatMap((c) => changeOf(c.use).files.map((f) => changedName(f, live.cwd))), NAMED_CHANGES);
  } else if (step.family === "run") {
    const commands = work.filter((c) => toolKind(c.use.name) === "shell");
    s.label = commands.length || !work.length ? "Ran" : toolKind(work[0]!.use.name) === "stop" ? "Stopped" : "Sent input";
    if (commands.length > 1) s.counts = plural(commands.length, "command", "commands");
    // A command of several lines is named by its first, with how many follow.
    name(named.filter((c) => toolKind(c.use.name) === "shell").map((c) => { const more = moreLines(c.use); return more ? `${targetOf(c.use)} (+${more} ${more === 1 ? "line" : "lines"})` : targetOf(c.use); }));
    if (commands.length === 1 && work.length === 1 && looks.error) s.exit = shellStatus(resultText(commands[0]!.result)).exit;
  } else if (step.family === "agents") {
    // Named by their tasks' titles: what each was started for.
    s.label = "Started";
    s.code = false;
    s.counts = plural(work.length, "agent", "agents");
    name(named.map((c) => agentTask(c.use)));
  } else {
    s.label = "Used";
    s.code = false;
    const names = new Map<string, number>();
    for (const c of named) names.set(c.use.name, (names.get(c.use.name) ?? 0) + 1);
    name([...names].map(([n, k]) => (k > 1 ? `${n} (${k} times)` : n)));
  }
  // None of its calls was run (its reply was cut at the output limit inside them): the verb says so.
  if (work.length && looks.unrun === work.length) s.label = NOT_RUN;
  return s;
}

// The state of a step in words, beside its verb: what waits, failed, was turned
// away, was cut or stopped, each said as what it is and in its own tone. A
// step that only ran, or still runs, has none. The tones: `need` waits on the
// owner; `fail` ran and failed; `note` failed while looking around (a missing
// file: a note, not an alarm); `own` the owner's own denial; `warn` the
// policy's refusal and a restart's cut; `idle` stopped, or never answered.
export type Word = { text: string; tone: "need" | "fail" | "note" | "own" | "warn" | "idle" };
export function stateWords(s: StepSummary): Word[] {
  const out: Word[] = [];
  const { waiting, error, denied, refused, cut, stopped, unfinished, unrun } = s.looks;
  // Said of every call of the step without a number, of some with how many.
  const n = (count: number, all: string, some = all) => (count === s.calls ? all : `${count} ${some}`);
  if (waiting) out.push({ text: waiting === s.calls ? NEEDS_APPROVAL : countWord("need", waiting), tone: "need" });
  if (error) out.push({ text: s.calls === 1 && s.exit !== undefined ? `exit ${s.exit}` : n(error, CALL_FAILED), tone: s.soft ? "note" : "fail" });
  if (denied) out.push({ text: n(denied, "denied by you"), tone: "own" });
  if (refused) out.push({ text: n(refused, "refused"), tone: "warn" });
  if (cut) out.push({ text: n(cut, "cut by a restart"), tone: "warn" });
  if (stopped) out.push({ text: n(stopped, CALL_STOPPED), tone: "idle" });
  if (unfinished) out.push({ text: n(unfinished, "no result", "with no result"), tone: "idle" });
  // A step none of whose calls ran says so in its verb (NOT_RUN): the word is why.
  if (unrun) out.push({ text: unrun === s.calls ? s.unrun ?? "not run" : `${unrun} not run${s.unrun ? `: ${s.unrun}` : ""}`, tone: "idle" });
  return out;
}

// What waits on the owner, in the words of the one state vocabulary (src/core/state-words.ts:
// "Needs you", with what), in a line's own case. A call that failed or was stopped says so in the
// state's word too. (What a tool does keeps its own line: "Running <command>", "Stopped <command>".)
export const NEEDS_APPROVAL = `${STATE_WORD.need.toLowerCase()}: ${NEEDS.approval}`;
export const NEEDS_ANSWER = `${STATE_WORD.need.toLowerCase()}: ${NEEDS.owner}`;
export const CALL_FAILED = STATE_WORD.fail.toLowerCase();
export const CALL_STOPPED = STATE_WORD.stop.toLowerCase();

// Whether any call of the step was carried out: a step none of whose calls was (they wait, were
// turned away, or never got a result) says what was to be done, not that it was.
export const carriedOut = (s: StepSummary): boolean => s.ran > 0;

// The color of a step's part of the rail: what most needs a look. A failure
// while looking around leaves the rail as it is: its line says it.
export type Edge = "need" | "running" | "error" | "warn" | "ok";
export const edgeOf = (looks: Record<Look, number>, soft = false): Edge =>
  looks.waiting ? "need" : looks.running ? "running" : looks.error && !soft ? "error" : looks.refused || looks.cut ? "warn" : "ok";

// The line as one sentence, for a screen reader.
export function sentence(s: StepSummary, words: Word[] = stateWords(s)): string {
  const what = [s.label, s.counts, s.targets.join(", ") + (s.more ? ` and ${s.more} more` : "")].filter(Boolean).join(" ");
  const delta = s.added || s.removed ? `, ${s.added} added, ${s.removed} removed` : "";
  const state = s.looks.running ? ", running" : "";
  return `${what}${delta}${state}${words.map((w) => `, ${w.text}`).join("")}`;
}
