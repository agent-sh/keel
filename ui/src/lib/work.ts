// The work of a turn as the transcript shows it: its tool calls in steps. A
// step is a run of calls of one family (looking things up, changing files,
// running commands, other tools), begun anew by what the model says in
// passing. What a step's line says is read from its calls and their results,
// never from the model's words.
// Pure: rows.ts keeps the steps of a row with these, a call at a time.
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import { stopKind } from "../../../src/core/stops.ts";
import { patchFiles, resultText, shellStatus, toolKind, type ToolKind } from "./tools.ts";

// `card`: a call with a card of its own (a question, an agent, code, readers): always a step by itself, as is a plan update.
export type Family = "explore" | "change" | "run" | "use" | "card" | "plan" | "said";
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
const CARDS = new Set(["Agent", "spawn_agent", "run_code", "AskReaders", "ask_readers"]);
export const familyOf = (name: string): Family => (CARDS.has(name) ? "card" : FAMILY[toolKind(name)] ?? "use");
const ALONE = new Set<Family>(["card", "plan"]);

// A line the model says in passing (one short paragraph of plain words) is set
// quietly on the rail, before the step it leads to. Anything longer or shaped
// (a list, a table, code, a heading) is a reply: it keeps the reading size.
export const ASIDE_MAX = 240;
export const isAside = (text: string): boolean => {
  const t = text.trim();
  return t.length <= ASIDE_MAX && !/\n\s*\n/.test(t) && !/(^|\n)\s*([-*+] |\d+[.)] |#{1,6} |>|\|)|```/.test(t);
};

const isCall = (i: WorkItem): i is Extract<WorkItem, { t: "call" }> => i.t === "call";

// The steps with one more call. A call of the last step's family joins it; any
// other starts a step, and takes with it what the model thought since the last
// step's last call.
export function addCall(steps: Step[], use: ToolUseBlock, event: string): Step[] {
  const item: WorkItem = { t: "call", id: use.id, use, event };
  const family = familyOf(use.name);
  const last = steps.at(-1);
  if (!last) return [{ key: item.id, family, items: [item] }];
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

// How a call ended: still running, done, failed, refused by a rule, or ended
// under it by the owner's stop or a restart (not a failure).
export type CallState = "running" | "ok" | "error" | "stopped" | "cut";
export const callState = (result?: ToolResultBlock): CallState =>
  !result ? "running" : result.is_error ? (stopKind(result.content) ?? "error") : "ok";

const base = (p: string) => p.replace(/\/+$/, "").split("/").at(-1) || p;
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const patchText = (input: any) => (typeof input === "string" ? input : String(input?.input ?? input?.patch ?? ""));

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

// What a call was made on, as its line names it: a file, a pattern, a command.
export function targetOf(use: ToolUseBlock): string {
  const input: any = use.input ?? {};
  switch (toolKind(use.name)) {
    case "read": case "edit": case "write": case "notebook": case "list": return String(input.file_path ?? input.notebook_path ?? input.dir_path ?? input.path ?? "");
    case "patch": return changeOf(use).files.join(", ");
    case "search": case "glob": return String(input.pattern ?? "");
    case "web": return String(input.query ?? "");
    case "fetch": return String(input.url ?? "");
    case "shell": return firstLine(String(input.cmd ?? input.command ?? ""));
    default: return "";
  }
}

// Why a call failed, in one line of its own output: the first line that names
// an error, else the first line it printed.
export function failureLine(result?: ToolResultBlock): string {
  const lines = resultText(result).replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^(Exit code|Exit Code:|Process exited with code) ?-?\d+$/.test(l));
  return (body.find((l) => /\b(error|failed|failure|cannot|not found|no such|denied|refused|does not exist|timed out|killed)\b/i.test(l)) ?? body[0] ?? lines[0] ?? "").slice(0, 200);
}

export type StepSummary = {
  label: string;      // what was done, as one verb
  counts: string;     // how much, in words; empty when the targets say it
  targets: string[];  // to what: files, commands, patterns, tools (set in the code face)
  more: number;       // targets not named
  code: boolean;      // the targets are code (a path, a command), not words
  added: number; removed: number;
  calls: number; failed: number; running: number; stopped: number;
  exit?: number;      // a lone command's exit code when it failed
};

const NAMED = 4;
const uniq = (list: string[]) => [...new Set(list.filter(Boolean))];

export function summarize(step: Step): StepSummary {
  const calls = callsOf(step);
  const work = calls;
  const states = work.map((c) => callState(c.result));
  const s: StepSummary = {
    label: "", counts: "", targets: [], more: 0, code: true, added: 0, removed: 0, calls: work.length,
    failed: states.filter((x) => x === "error").length, running: states.filter((x) => x === "running").length, stopped: states.filter((x) => x === "stopped" || x === "cut").length,
  };
  const name = (list: string[]) => { const all = uniq(list); s.targets = all.slice(0, NAMED); s.more = all.length - s.targets.length; };
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
    if (work.length > 1) s.counts = only === "search" || only === "glob" ? plural(work.length, "time", "times") : only === "web" ? plural(work.length, "time", "times") : parts.join(", ");
    const reads = work.filter((c) => toolKind(c.use.name) === "read").map((c) => base(targetOf(c.use)));
    name(work.length === 1 || !reads.length ? work.map((c) => (["read", "list"].includes(toolKind(c.use.name)) ? base(targetOf(c.use)) : targetOf(c.use))) : reads);
  } else if (step.family === "change") {
    const all = work.map((c) => changeOf(c.use));
    s.label = work.every((c) => toolKind(c.use.name) === "write") ? "Wrote" : "Edited";
    s.added = all.reduce((n, c) => n + c.added, 0);
    s.removed = all.reduce((n, c) => n + c.removed, 0);
    name(all.flatMap((c) => c.files.map(base)));
    if (s.more) s.counts = plural(s.targets.length + s.more, "file", "files");
  } else if (step.family === "run") {
    const commands = work.filter((c) => toolKind(c.use.name) === "shell");
    s.label = commands.length || !work.length ? "Ran" : toolKind(work[0]!.use.name) === "stop" ? "Stopped" : "Sent input";
    if (commands.length > 1) s.counts = plural(commands.length, "command", "commands");
    name(commands.map((c) => targetOf(c.use)));
    if (commands.length === 1 && states[work.indexOf(commands[0]!)] === "error") s.exit = shellStatus(resultText(commands[0]!.result)).exit;
  } else {
    s.label = "Used";
    s.code = false;
    const names = new Map<string, number>();
    for (const c of work) names.set(c.use.name, (names.get(c.use.name) ?? 0) + 1);
    name([...names].map(([n, k]) => (k > 1 ? `${n} (${k} times)` : n)));
  }
  return s;
}

// The line as one sentence, for a screen reader and for Copy.
export function sentence(s: StepSummary): string {
  const what = [s.label, s.counts, s.targets.join(", ") + (s.more ? ` and ${s.more} more` : "")].filter(Boolean).join(" ");
  const delta = s.added || s.removed ? `, ${s.added} added, ${s.removed} removed` : "";
  const state = s.running ? ", running" : s.failed ? `, ${s.failed === s.calls ? "failed" : `${s.failed} failed`}${s.exit !== undefined ? ` with exit code ${s.exit}` : ""}` : s.stopped ? ", stopped" : "";
  return `${what}${delta}${state}`;
}
