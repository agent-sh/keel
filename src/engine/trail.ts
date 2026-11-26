// The artifact trail of a compaction: what the work did, made from the
// events by the harness and not by the model. Model summaries keep little of
// it: on real sessions a summary and the messages it kept named about a tenth
// of the files the span wrote and a sixth of the identifiers that recur in it,
// as Compact-Bench (arXiv 2610.31710) measures for production harnesses
// (15.7% of recurring details) against 79.1% for mechanical extraction. So a
// compaction keeps, beside the summary: the files written and read with their
// last state, the commands run with their exit codes, the branches and
// commits made, and the identifiers that recur in the span and nothing else
// kept names. It carries the earlier trail on, newest first, within
// TRAIL_BYTES.
//
// The probe says how much a compaction kept, with no model: the share of the
// span's written files and of its recurring identifiers that the summary and
// the kept messages name (and with the trail), and the identifiers the
// summary names that nothing it read holds.
//
// Pure: no disk, no daemon (the read thread may load it).
import type { StoredEvent } from "../core/types.ts";
import { fileReads, resultText, segments } from "./work-calls.ts";

// The most UTF-8 bytes of the trail's text: 15% of the median compacted
// context measured on real sessions (summary, kept messages and fixed
// context, about 34 KB), about 2,000 tokens.
export const TRAIL_BYTES = 5_000;
// A command is shown up to this many characters.
const COMMAND_CHARS = 160;
// What the trail keeps in its stored form, beyond what its text shows: the
// text is made again from it at the next compaction, merged with that span.
const KEEP = { files: 120, commands: 40, commits: 30, branches: 20, ids: 250 };

export type TrailFile = { path: string; created?: boolean; edits?: number; writes?: number; reads?: number; deleted?: boolean; moved_to?: string };
// `stopped`: killed or cut before it ended (a timeout, a stop, a steer): it has no exit code.
export type TrailCommand = { cmd: string; exit: number | null; runs: number; stopped?: boolean };
export type Trail = { files: TrailFile[]; commands: TrailCommand[]; commits: { sha: string; branch?: string; subject: string }[]; branches: string[]; ids: string[] };
export type Probe = {
  files: number; files_summary: number; files_kept: number;
  anchors: number; anchors_summary: number; anchors_kept: number;
  ids: number; unsupported: number; unsupported_ids?: string[];
  trail_bytes: number;
};

// Identifiers a summary should keep word for word: paths, file names,
// hashes, PR and issue numbers, CONSTANT names (Compact-Bench's details, as
// the research probe on real sessions read them).
// Try a path only at the start of its run, or just after a matched issue
// number (which may have used up its first segment). Starting again at every
// character or segment rescans the same suffix when there is no extension.
const ANCHOR = /(?:(?<![\w.-]|[\w.-]\/)|(?<=#\d{2,6}\b\/?))(?:[\w.-]+\/)+[\w.-]+\.\w{1,5}|\b[\w-]+\.(?:ts|tsx|rs|py|go|md|json|sh|css|toml|yaml|yml|tsv)\b|\b[0-9a-f]{8,40}\b|#\d{2,6}\b|\b[A-Z][A-Z0-9_]{5,}\b/g;
// A secret's placeholder (its hex name is not the work's) and a bare run of
// digits (a time, a count) are not identifiers.
export const anchorsOf = (text: string): Set<string> => new Set((text.replace(/\[secret:[0-9a-f]+\]/g, " ").match(ANCHOR) ?? []).filter((a) => !/^\d+$/.test(a)));
// An anchor recurs when this many messages of the span hold it.
const RECURS = 3;

const WRITERS: Record<string, string> = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path", write_file: "file_path", replace: "file_path" };
const SHELLS: Record<string, string> = { Bash: "command", run_shell_command: "command", exec_command: "cmd" };
const PATCH = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

// The strings of a call's input as they were written (JSON would turn a line end into `\n`, read as part of a word).
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

// The text of an event as the probe reads it: words, thinking, a call's input, a result.
function eventText(e: StoredEvent): string {
  if (e.kind === "user") return String(e.data.text ?? "");
  if (e.kind === "assistant") return (e.data.blocks ?? []).map((b: any) => b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : b.type === "tool_use" ? [b.name, ...strings(b.input)].join("\n") : "").join("\n");
  if (e.kind === "tool_result") return (e.data.results ?? []).map((r: any) => resultText(r.content)).join("\n");
  return "";
}

// The exit code a shell result reports: 0 for a plain success, null while it runs on.
function exitOf(name: string, text: string, isError: boolean): number | null {
  const m = text.match(/^Exit code (-?\d+)/m) ?? text.match(/^Process exited with code (-?\d+)/m) ?? text.match(/^Exit Code: (-?\d+)/m);
  if (m) return Number(m[1]);
  if (/^(Command running in background|Command did not complete|Command moved to the background|Process running with session ID)/m.test(text)) return null;
  if (name === "exec_command" && !isError) return null;
  return isError ? 1 : 0;
}

const shellWords = (s: string) => s.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean);
// A word that names a file: a path or a name with an extension, nothing a shell expands or code holds.
const plainPath = (p: string) => /^[\w.~/-]+$/.test(p) && /\w/.test(p) && !p.startsWith("-") && !p.startsWith("/dev/") && !p.startsWith("/proc/") && (p.includes("/") || /\.\w{1,8}$/.test(p));

// What a shell command did to files and branches, read from its words.
type Effects = { deleted: string[]; written: string[]; moved: [string, string][]; branches: string[]; dropped: string[]; amend: boolean; reset?: string };
function shellEffects(command: string): Effects {
  const fx: Effects = { deleted: [], written: [], moved: [], branches: [], dropped: [], amend: false };
  // (Quoted words are left out: what a quote holds is an argument's text, not a file the command writes.)
  for (const seg of segments(command.replace(/'[^'\n]*'|"(?:[^"\\\n]|\\.)*"/g, "_"))) {
    for (const m of seg.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|]+)/g)) if (plainPath(m[1]!.replace(/^['"]|['"]$/g, ""))) fx.written.push(m[1]!.replace(/^['"]|['"]$/g, ""));
    const w = shellWords(seg.replace(/\d?>{1,2}\s*\S+/g, ""));
    const at = w.findIndex((x) => !/^\w+=/.test(x) && x !== "sudo");
    const prog = (w[at] ?? "").split("/").pop();
    const args = w.slice(at + 1);
    const plain = (xs: string[]) => xs.filter((a) => !a.startsWith("-"));
    // mv A B, mv A B DIR/: each source to the destination, or into it when it is a folder.
    const move = (xs: string[]) => {
      const p = plain(xs);
      if (p.length < 2 || !p.every(plainPath) && !p.every((x) => /^[\w.~/-]+$/.test(x))) return;
      const to = p.at(-1)!, from = p.slice(0, -1);
      const into = from.length > 1 || to.endsWith("/");
      for (const f of from) fx.moved.push([f, into ? `${to.replace(/\/$/, "")}/${f.split("/").pop()}` : to]);
    };
    if (prog === "rm") for (const a of args) if (plainPath(a) || /^[\w.~/-]+$/.test(a) && a.includes("/")) fx.deleted.push(a.replace(/\/$/, ""));
    if (prog === "mv") move(args);
    if (prog === "tee") for (const a of args) if (plainPath(a)) fx.written.push(a);
    if (prog !== "git") continue;
    let sub = 0;
    while (sub < args.length && args[sub]!.startsWith("-")) sub += /^-[Cc]$/.test(args[sub]!) ? 2 : 1;
    const verb = args[sub], rest = args.slice(sub + 1);
    if (verb === "rm") for (const a of rest) if (plainPath(a)) fx.deleted.push(a);
    if (verb === "mv") move(rest);
    const flag = (f: string[]) => { const k = rest.findIndex((a) => f.includes(a)); return k >= 0 ? rest[k + 1] : undefined; };
    const made = verb === "checkout" ? flag(["-b", "-B"]) : verb === "switch" ? flag(["-c", "-C", "--create"]) : verb === "worktree" && rest[0] === "add" ? flag(["-b", "-B"])
      : verb === "branch" && rest.length && !rest[0]!.startsWith("-") ? rest[0] : undefined;
    if (made && /^[\w./-]+$/.test(made)) fx.branches.push(made);
    // A branch deleted here or on the remote.
    if (verb === "branch" && rest.some((a) => /^(-d|-D|--delete)$/.test(a))) fx.dropped.push(...plain(rest));
    if (verb === "push" && rest.some((a) => a === "--delete" || a === "-d")) fx.dropped.push(...plain(rest).slice(1));
    if (verb === "push") for (const a of plain(rest).slice(1)) if (/^:[\w./-]+$/.test(a)) fx.dropped.push(a.slice(1));
    if (verb === "commit" && rest.includes("--amend")) fx.amend = true;
    if (verb === "reset" && rest.includes("--hard")) fx.reset = plain(rest)[0] ?? "HEAD";
  }
  return fx;
}

// What a span (the events a summary covers) did, and its text as the probe reads it.
export type Span = { trail: Trail; recurring: string[]; text: string; events: readonly StoredEvent[] };
export function spanOf(span: readonly StoredEvent[]): Span {
  const texts = span.map(eventText);
  // Identifiers that recur in the span, most often first.
  const count = new Map<string, number>();
  for (const t of texts) for (const a of anchorsOf(t)) count.set(a, (count.get(a) ?? 0) + 1);
  const recurring = [...count].filter(([, n]) => n >= RECURS).sort((a, b) => b[1] - a[1]).map(([a]) => a);
  return { trail: { ...walk(span), ids: recurring }, recurring, text: texts.join("\n"), events: span };
}

// The trail of `span` carried on from `prior`: the span is walked on from
// the earlier trail's state (a file it deletes, a branch it drops, a commit
// a reset takes back were the earlier span's), its entries the newest.
export function trailOf(span: readonly StoredEvent[] | Span, prior?: Trail): Trail {
  const s = "events" in span ? span : spanOf(span);
  const t = prior ? walk(s.events, prior) : s.trail;
  return {
    files: t.files.slice(-KEEP.files),
    commands: t.commands.slice(-KEEP.commands),
    commits: t.commits.slice(-KEEP.commits),
    branches: t.branches.slice(-KEEP.branches),
    ids: [...new Set([...s.trail.ids, ...(prior?.ids ?? [])])].slice(0, KEEP.ids),
  };
}

// How a shell command ended, from its result: its exit code, null while it
// runs on, "stopped" when it was killed or cut (a timeout, a stop, a steer),
// "not run" when it was cut before it ran.
function endOf(name: string, text: string, isError: boolean): number | null | "stopped" | "not run" {
  if (/^Interrupted\b[^\n]*before this tool ran/.test(text)) return "not run";
  if (/^(Interrupted\b|Command was (killed|interrupted|stopped)|Command timed out|Error: Command timed out|Killed by )/.test(text.trimStart())) return "stopped";
  return exitOf(name, text, isError);
}

// A command as the trail shows it: its first line, cut at a word's end.
function commandLine(shell: string): string {
  const first = shell.trim().split("\n")[0]!.replace(/\s+/g, " ");
  const more = shell.trim().includes("\n");
  if (first.length <= COMMAND_CHARS) return first + (more ? " ..." : "");
  const cut = first.slice(0, COMMAND_CHARS + 1);
  const end = cut.lastIndexOf(" ");
  return `${(end > COMMAND_CHARS / 2 ? cut.slice(0, end) : first.slice(0, COMMAND_CHARS)).trimEnd()} ...`;
}

// The files, commands, commits and branches of a span, oldest first, walked
// on from `seed` (an earlier trail) when given.
function walk(span: readonly StoredEvent[], seed?: Omit<Trail, "ids">): Omit<Trail, "ids"> {
  const files = new Map<string, TrailFile>((seed?.files ?? []).map((f) => [f.path, { ...f }]));
  const commands = new Map<string, TrailCommand>((seed?.commands ?? []).map((c) => [c.cmd, { ...c }]));
  let commits: Trail["commits"] = [...(seed?.commits ?? [])];
  const branches: string[] = [...(seed?.branches ?? [])];
  let current: string | undefined = commits.at(-1)?.branch;
  const file = (path: string) => {
    const f = files.get(path) ?? { path };
    files.delete(path); // newest last
    files.set(path, f);
    return f;
  };
  const branch = (b: string) => { const k = branches.indexOf(b); if (k >= 0) branches.splice(k, 1); branches.push(b); };
  // The calls in the order the replies made them, each with its result:
  // results are stored as they finish (a batch's in another order each run,
  // some in a later event), so a result is read where its call was made.
  // (A server that sends no call ids can give two steps' calls one id: they take its results in turn.)
  const results = new Map<string, any[]>();
  for (const e of span) if (e.kind === "tool_result") for (const r of e.data.results ?? []) results.set(r.tool_use_id, [...(results.get(r.tool_use_id) ?? []), r]);
  const made: { call: { name: string; input: any }; r: any }[] = [];
  for (const e of span) if (e.kind === "assistant") for (const b of e.data.blocks ?? []) {
    const r = b.type === "tool_use" ? results.get(b.id)?.shift() : undefined;
    if (r) made.push({ call: { name: b.name, input: b.input }, r });
  }
  for (const { call, r } of made) {
    const text = resultText(r.content);
    const { name, input } = call;
    if (r.verdict === "denied" || r.verdict === "none") continue; // it did not run
    for (const p of fileReads(name, input)) if (!r.is_error) { const f = file(p); f.reads = (f.reads ?? 0) + 1; }
    const key = WRITERS[name];
    if (key && typeof input?.[key] === "string" && !r.is_error) {
      const f = file(input[key]);
      if (/^(File created successfully|Created new file)/.test(text)) { f.created = true; delete f.deleted; }
      else f.edits = (f.edits ?? 0) + 1;
      continue;
    }
    const patch = name === "apply_patch" ? String(typeof input === "string" ? input : input?.input ?? input?.patch ?? "") : "";
    const shell = SHELLS[name] && typeof input?.[SHELLS[name]!] === "string" ? String(input[SHELLS[name]!]) : "";
    const body = patch || (/\*\*\* Begin Patch/.test(shell) ? shell : "");
    if (body) {
      if (r.is_error) continue;
      let last: TrailFile | undefined;
      for (const m of body.matchAll(PATCH)) {
        if (m[3]) { if (last) { last.moved_to = m[3].trim(); file(m[3].trim()).created = true; } continue; }
        last = file(m[2]!.trim());
        if (m[1] === "Add") { last.created = true; delete last.deleted; }
        else if (m[1] === "Delete") last.deleted = true;
        else last.edits = (last.edits ?? 0) + 1;
      }
      continue;
    }
    if (!shell) continue;
    const end = endOf(name, text, !!r.is_error);
    if (end === "not run") continue;
    const cmd = commandLine(shell);
    const c = commands.get(cmd);
    commands.delete(cmd);
    commands.set(cmd, { cmd, exit: end === "stopped" ? null : end, ...(end === "stopped" ? { stopped: true } : {}), runs: (c?.runs ?? 0) + 1 });
    if (end !== 0 && end !== null) continue;
    const fx = shellEffects(shell);
    for (const p of fx.deleted) {
      file(p).deleted = true;
      // A folder deleted: every file the trail knows under it with it.
      for (const f of files.values()) if (f.path.startsWith(`${p}/`)) f.deleted = true;
    }
    for (const p of fx.written) { const f = file(p); f.writes = (f.writes ?? 0) + 1; delete f.deleted; }
    for (const [from, to] of fx.moved) { file(from).moved_to = to; const t = file(to); t.created = true; delete t.deleted; }
    for (const b of fx.branches) branch(b);
    for (const b of fx.dropped) { const k = branches.indexOf(b); if (k >= 0) branches.splice(k, 1); }
    for (const m of text.matchAll(/^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm)) {
      const made = { sha: m[2]!, branch: m[1], subject: m[3]!.slice(0, 100) };
      // An amend replaces the commit it amends: the last one on its branch.
      const k = fx.amend ? commits.findLastIndex((x) => x.branch === made.branch) : -1;
      if (k >= 0) commits.splice(k, 1);
      commits.push(made);
      branch(m[1]!);
      current = m[1];
    }
    for (const m of text.matchAll(/Switched to (?:a new )?branch '([^']+)'/g)) { branch(m[1]!); current = m[1]; }
    // A hard reset takes back the commits after its target on the branch it is on.
    if (fx.reset) {
      const at = text.match(/HEAD is now at ([0-9a-f]{7,40})/)?.[1];
      const k = at ? commits.findLastIndex((x) => x.sha.startsWith(at) || at.startsWith(x.sha)) : -1;
      const back = fx.reset.match(/^HEAD(?:~(\d+)|(\^+))$/);
      const on = k >= 0 ? commits[k]!.branch : current;
      if (k >= 0) commits = commits.filter((x, i) => i <= k || x.branch !== on);
      else if (back) {
        let n = back[1] ? Number(back[1]) : back[2]!.length;
        for (let i = commits.length - 1; i >= 0 && n > 0; i--) if (commits[i]!.branch === on) { commits.splice(i, 1); n--; }
      }
    }
  }
  return { files: [...files.values()], commands: [...commands.values()], commits, branches };
}

const utf8 = (s: string) => Buffer.byteLength(s);

function fileLine(f: TrailFile): string {
  const what: string[] = [];
  if (f.created) what.push("created");
  if (f.edits) what.push(`edited${f.edits > 1 ? ` ${f.edits} times` : ""}`);
  if (f.writes) what.push(`written by a command${f.writes > 1 ? ` ${f.writes} times` : ""}`);
  if (f.moved_to) what.push(`moved to ${f.moved_to}`);
  if (f.deleted) what.push(what.length ? "then deleted" : "deleted");
  return `${f.path} (${what.join(", ")})`;
}

// The trail as the model reads it, within `budget` bytes: each part gets its
// share first (written files a third, the identifiers a quarter, the commands
// a fifth, reads, commits and branches the rest), newest first within it; what
// a part leaves goes to the next, and what is left out is counted.
// `named`: text already kept (the summary, the kept messages): an identifier
// it holds is not repeated.
export function trailText(t: Trail, named = "", budget = TRAIL_BYTES): string {
  const written = t.files.filter((f) => f.created || f.edits || f.writes || f.deleted || f.moved_to);
  const read = t.files.filter((f) => !written.includes(f) && f.reads);
  // Identifiers last: one that an earlier part shows already is not repeated.
  const parts: { head: string; items: string[]; share: number; join?: string; ids?: boolean }[] = [
    { head: "Files written (newest first):", items: written.slice().reverse().map(fileLine), share: 0.3 },
    { head: "Commits (newest first):", items: t.commits.slice().reverse().map((c) => `${c.sha.slice(0, 12)} ${c.subject}${c.branch ? ` (${c.branch})` : ""}`), share: 0.05 },
    { head: "Branches:", items: t.branches.slice().reverse(), share: 0.02 },
    { head: "Commands run (newest first, exit code):", items: t.commands.slice().reverse().map((c) => `${c.cmd} -> ${c.stopped ? "stopped" : c.exit === null ? "still running when last seen" : c.exit}${c.runs > 1 ? ` (${c.runs} runs)` : ""}`), share: 0.18 },
    { head: "Files read (newest first):", items: read.slice().reverse().map((f) => `${f.path}${(f.reads ?? 0) > 1 ? ` (${f.reads} reads)` : ""}`), share: 0.12 },
    { head: "Identifiers that recur in the work and nothing above names:", items: t.ids.filter((a) => !named.includes(a)), share: 0.33, join: ", ", ids: true },
  ].filter((p) => p.items.length);
  if (!parts.length) return "";
  const intro = "[Artifact trail of the work before this point, made from the events by the harness (not by the model):]";
  const room = budget - utf8(intro) - 200; // the line that counts what was left out
  const take = parts.map(() => [] as string[]);
  const spent = parts.map(() => 0);
  let spare = room;
  // Each part up to its share first, then what is left, in their order.
  for (const pass of [0, 1]) {
    parts.forEach((p, k) => {
      const cap = pass === 0 ? p.share * room : Infinity;
      let shown = p.ids ? take.flat().join("\n") : "";
      for (let i = take[k]!.length; i < p.items.length; i++) {
        if (p.ids && shown.includes(p.items[i]!)) { p.items.splice(i--, 1); continue; }
        if (p.ids) shown += `\n${p.items[i]}`;
        const n = utf8(p.items[i]!) + 3 + (take[k]!.length === 0 ? utf8(p.head) + 2 : 0);
        if (n > spare || spent[k]! + n > cap) break;
        take[k]!.push(p.items[i]!);
        spent[k] = spent[k]! + n;
        spare -= n;
      }
    });
  }
  const left = parts.reduce((n, p, k) => n + p.items.length - take[k]!.length, 0);
  const lines = [intro];
  parts.forEach((p, k) => {
    if (!take[k]!.length) return;
    lines.push(p.join ? `${p.head} ${take[k]!.join(p.join)}` : `${p.head}\n${take[k]!.map((x) => `- ${x}`).join("\n")}`);
  });
  if (left) lines.push(`(${left} more ${left > 1 ? "entries" : "entry"} past the trail's ${budget}-byte bound left out; the stored history keeps them.)`);
  // A blank line between parts (counted in the room left above for the last line).
  return lines.join("\n\n");
}

// How much a compaction kept of its span, by rule. `kept`: the summary and
// the messages kept with it; `trail`: the trail's text; `support`: every text
// the summary could have taken an identifier from (the span, the earlier
// summary, its trail and kept messages, the fixed context).
// What a compaction needs of its span, made where the span's events are
// read (the read thread reads them for the summary's check, so the loop
// never walks them): the trail carried on from `prior`, the files the span
// wrote, its recurring identifiers, and the identifiers of the summary that
// neither the span nor `support` (what the context held before it) holds.
export type Work = { trail: Trail; written: string[]; recurring: string[]; ids: number; unsupported: string[] };
export function workOf(events: readonly StoredEvent[], prior: Trail | undefined, summary: string, support: string): Work {
  const span = spanOf(events);
  const ids = [...anchorsOf(summary)];
  return {
    trail: trailOf(span, prior),
    written: span.trail.files.filter((f) => f.created || f.edits || f.writes || f.deleted || f.moved_to).map((f) => f.path),
    recurring: span.recurring, ids: ids.length,
    // (A word in capitals alone a summary may write as emphasis: IMPORTANT, CRITICAL. A name the span holds is matched above.)
    unsupported: ids.filter((a) => !span.text.includes(a) && !support.includes(a) && !/^[A-Z]+$/.test(a)),
  };
}

export function probeOf(work: Work, summary: string, kept: string, text: string): Probe {
  const { written, recurring, unsupported } = work;
  const base = (p: string) => p.split("/").pop() ?? p;
  const names = (p: string, t: string) => t.includes(p) || t.includes(base(p));
  const have = `${summary}\n${kept}`, all = `${have}\n${text}`;
  return {
    files: written.length, files_summary: written.filter((p) => names(p, have)).length, files_kept: written.filter((p) => names(p, all)).length,
    anchors: recurring.length, anchors_summary: recurring.filter((a) => have.includes(a)).length, anchors_kept: recurring.filter((a) => all.includes(a)).length,
    ids: work.ids, unsupported: unsupported.length, ...(unsupported.length ? { unsupported_ids: unsupported.slice(0, 10) } : {}),
    trail_bytes: utf8(text),
  };
}

// The share of a probe's files or anchors kept, null when the span had none.
export const share = (kept: number, of: number): number | null => (of > 0 ? kept / of : null);

// A compaction that keeps less than this share of its span's written files or
// recurring identifiers (with the trail) is named: the median a summary and
// its kept messages held of recurring identifiers on real sessions before
// the trail (15%, as Compact-Bench reports for production harnesses). A
// session under it keeps no more than a summary alone did.
export const KEPT_LOW = 0.15;

// The probe's numbers in words, for a row that may show no text of the session.
export function probeWords(p: Partial<Probe> | null | undefined): string {
  if (!p || typeof p.files !== "number") return "";
  const parts: string[] = [];
  if (p.files) parts.push(`${p.files_kept} of ${p.files} file${p.files > 1 ? "s" : ""} written`);
  if (p.anchors) parts.push(`${p.anchors_kept} of ${p.anchors} recurring identifier${p.anchors > 1 ? "s" : ""}`);
  const alone = [p.files ? p.files_summary : null, p.anchors ? p.anchors_summary : null].filter((n) => n !== null);
  const words = parts.length ? `kept ${parts.join(" and ")}${alone.length ? ` (without the trail ${alone.join(" and ")})` : ""}` : "";
  const unsupported = p.unsupported ? `${p.unsupported} identifier${p.unsupported > 1 ? "s" : ""} of the summary found in nothing it read` : "";
  return [words, unsupported].filter(Boolean).join("; ");
}

// What the compactions of a range kept, by their probes: the median shares
// (with the trail, and of the summary and kept messages alone), how many named
// an identifier nothing they read holds, and the sessions whose compactions
// keep less than KEPT_LOW of their files or identifiers (by the median of
// each session's compactions).
export type KeptTotals = {
  measured: number; threshold: number; unsupported: number;
  files_kept: number | null; anchors_kept: number | null; files_summary: number | null; anchors_summary: number | null;
  low: { session_id: string; title?: string; compactions: number; files_kept: number | null; anchors_kept: number | null }[];
};
export function keptTotals(list: readonly { session_id: string; title?: string; probe?: Partial<Probe> | null }[]): KeptTotals {
  const ps = list.filter((x): x is { session_id: string; title?: string; probe: Probe } => typeof x.probe?.files === "number");
  const median = (v: (number | null)[]) => { const s = v.filter((x): x is number => x !== null).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : null; };
  const of = (xs: typeof ps, k: "files" | "anchors", by: "kept" | "summary") => median(xs.map((x) => share(x.probe[`${k}_${by}`], x.probe[k])));
  const sessions = new Map<string, typeof ps>();
  for (const x of ps) sessions.set(x.session_id, [...(sessions.get(x.session_id) ?? []), x]);
  const low: KeptTotals["low"] = [];
  for (const [id, xs] of sessions) {
    const files = of(xs, "files", "kept"), anchors = of(xs, "anchors", "kept");
    if ((files ?? 1) < KEPT_LOW || (anchors ?? 1) < KEPT_LOW) low.push({ session_id: id, ...(xs[0]!.title ? { title: xs[0]!.title } : {}), compactions: xs.length, files_kept: files, anchors_kept: anchors });
  }
  return {
    measured: ps.length, threshold: KEPT_LOW, unsupported: ps.filter((x) => x.probe.unsupported > 0).length,
    files_kept: of(ps, "files", "kept"), anchors_kept: of(ps, "anchors", "kept"), files_summary: of(ps, "files", "summary"), anchors_summary: of(ps, "anchors", "summary"),
    low,
  };
}
