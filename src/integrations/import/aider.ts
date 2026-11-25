// Aider: no central store. Each project folder (its git root, else the folder Aider ran in) holds
// `.aider.chat.history.md` and `.aider.input.history`. The history is Markdown that Aider's
// InputOutput class appends to (aider/io.py, append_chat_history; its own reader is
// aider/utils.py, split_chat_history_markdown):
//
//   "\n# aider chat started at YYYY-MM-DD HH:MM:SS\n\n"   one run, in the writer's local time
//   "> text  "      a line Aider printed (version, model, repo, applied edits, commits, questions,
//                   warnings): tool output, every line ending in two spaces
//   "\n#### text  " what the owner typed, one such line for each line of the input ("#### <blank>"
//                   for an empty one); slash commands are typed lines too
//   anything else   the model's reply, as it wrote it (Aider has no tool calls: an edit is a
//                   SEARCH/REPLACE block in the reply, and "Applied edit to ..." follows it)
//
// `.aider.input.history` is prompt_toolkit's FileHistory: "\n# YYYY-MM-DD HH:MM:SS.ffffff\n"
// then "+line" for each line of an input. It gives each typed input its time.
//
// A history file holds many runs, so a run is a session: its path is `<file>#<start of the run>`.
// By default the owner's project folders (~/projects) are scanned to three folders down; a
// `--chat-history-file` named elsewhere is not found. Source: aider 0.86 (aider/io.py,
// aider/utils.py, aider/coders/base_coder.py), read from the installed program, 2026-11-21.
// Nothing here writes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { ownerHome } from "../../core/paths";
import type { SideStore } from "./more.ts";
import { Builder, clip, type Found, type Read } from "./types.ts";

export const aiderDir = () => process.env.KEEL_IMPORT_AIDER_DIR ?? join(ownerHome(), "projects");

const HISTORY = ".aider.chat.history.md";
const INPUT = ".aider.input.history";
const DEPTH = 3;
const BUDGET_MS = 40;
const WALK_EVERY_MS = 30_000;
const FILE_MAX = 256 * 1024 * 1024;
const SKIP = new Set(["node_modules", "target", "dist", "build", "venv", "__pycache__"]);
const HEADER = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[ \t]*$/gm;

type Run = { stamp: string; start: number; startByte: number; endByte: number; prompts: number; first?: string; last?: string; model?: string; headed: boolean };
type FileRuns = { size: number; mtime: number; runs: Run[]; rows?: Found[] };

const localMs = (t: string) => new Date(t.replace(" ", "T")).getTime();
const stampOf = (t: string) => t.replace(" ", "T").replaceAll(":", "-");

type Item = { kind: "user" | "assistant" | "tool"; text: string };
const unspace = (l: string) => (l.endsWith("  ") ? l.slice(0, -2) : l);

// A run's text as the items Aider's reader finds in it: the owner's inputs, the model's replies and
// the lines Aider printed. A line starting "#" that is not the run's header is the model's own text.
function parse(text: string): { items: Item[]; model?: string } {
  const items: Item[] = [];
  type Open = { kind: Item["kind"]; lines: string[] };
  let cur = null as Open | null;
  const flush = () => {
    if (!cur) return;
    const t = cur.kind === "assistant" ? cur.lines.join("\n").trim() : cur.lines.join("\n").replace(/^\n+|\n+$/g, "");
    if (t.trim() && !(cur.kind === "user" && t.trim() === "<blank>")) items.push({ kind: cur.kind, text: t });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    HEADER.lastIndex = 0;
    if (HEADER.test(line)) { flush(); continue; }
    const kind: Item["kind"] | null = /^####( |$)/.test(line) ? "user" : line.startsWith("> ") || line === ">" ? "tool" : null;
    if (kind) {
      if (cur?.kind !== kind) { flush(); cur = { kind, lines: [] }; }
      cur!.lines.push(unspace(line.slice(kind === "user" ? 5 : 2)));
    } else if (cur?.kind === "assistant") cur.lines.push(line);
    else { flush(); cur = { kind: "assistant", lines: [line] }; }
  }
  flush();
  let model: string | undefined;
  for (const i of items) if (i.kind === "tool") model = /^(?:Main model|Model):\s*(\S+)/m.exec(i.text)?.[1] ?? model;
  return { items, model };
}

function runOf(text: string, stamp: string, start: number, startByte: number, endByte: number, headed: boolean): Run {
  const { items, model } = parse(text);
  const asked = items.filter((i) => i.kind === "user");
  return { stamp, start, startByte, endByte, prompts: asked.length, first: asked[0]?.text, last: asked.at(-1)?.text, model, headed };
}

// The runs of a file. An append-only file read before is read again from where its last run began.
function scan(path: string, mtime: number, prev?: FileRuns): FileRuns {
  const buf = readFileSync(path);
  let from = 0;
  let keep: Run[] = [];
  const last = prev?.runs.at(-1);
  if (prev && last && buf.length >= prev.size && (!last.headed || buf.toString("latin1", last.startByte, last.startByte + 24) === "# aider chat started at ")) {
    from = last.startByte;
    keep = prev.runs.slice(0, -1);
  }
  const text = buf.subarray(from).toString("utf8");
  const heads = [...text.matchAll(HEADER)].map((m) => ({ at: m.index!, time: m[1]! }));
  const byte = (i: number) => from + Buffer.byteLength(text.slice(0, i));
  const runs = keep;
  const taken = new Set(runs.map((r) => r.stamp));
  const unique = (s: string) => { let k = s, n = 2; while (taken.has(k)) k = `${s}-${n++}`; taken.add(k); return k; };
  const startAt = heads[0]?.at ?? text.length;
  // What stands before the first header (older files, or a file started with no header).
  if (from === 0 && text.slice(0, startAt).trim()) runs.push(runOf(text.slice(0, startAt), unique("start"), mtime, 0, byte(startAt), false));
  heads.forEach((h, i) => {
    const end = heads[i + 1]?.at ?? text.length;
    runs.push(runOf(text.slice(h.at, end), unique(stampOf(h.time)), localMs(h.time), byte(h.at), byte(end), true));
  });
  return { size: buf.length, mtime, runs };
}

// ---- the walk: the folders to depth three that hold a history, a slice at a time ----

let rootNow = "";
let files: string[] = [];
let building: { queue: [string, number][]; found: string[] } | null = null;
let walkedAt = 0;
const known = new Map<string, FileRuns | null>();
let left = 0;

function walk(until: number) {
  const root = aiderDir();
  if (root !== rootNow) { rootNow = root; files = []; building = null; walkedAt = 0; known.clear(); }
  if (!building && Date.now() - walkedAt > WALK_EVERY_MS) building = { queue: [[root, 0]], found: [] };
  while (building && building.queue.length && performance.now() < until) {
    const [dir, depth] = building.queue.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name === HISTORY) building.found.push(join(dir, e.name));
      else if (e.isDirectory() && depth < DEPTH && !e.name.startsWith(".") && !SKIP.has(e.name)) building.queue.push([join(dir, e.name), depth + 1]);
    }
  }
  if (building && !building.queue.length) { files = building.found; building = null; walkedAt = Date.now(); const keep = new Set(files); for (const p of known.keys()) if (!keep.has(p)) known.delete(p); }
}

function rowsOf(path: string, k: FileRuns): Found[] {
  const dir = dirname(path);
  const tag = createHash("sha1").update(dir).digest("hex").slice(0, 8);
  return k.runs.flatMap((r, i) => !r.prompts ? [] : [{
    harness: "aider" as const, id: `${r.stamp}-${tag}`, path: `${path}#${r.stamp}`, cwd: dir,
    title: clip(r.first!, 120), first_prompt: clip(r.first!), last_prompt: clip(r.last!),
    updated_ms: Math.round(k.runs[i + 1]?.start ?? k.mtime), size_bytes: r.endByte - r.startByte,
    ...(r.model ? { model: r.model } : {}), kind: "interactive" as const,
  }]);
}

function list(): Found[] {
  const until = performance.now() + BUDGET_MS;
  walk(until);
  const out: Found[] = [];
  let pending = building ? building.queue.length : 0;
  for (const path of building ? [...new Set([...files, ...building.found])] : files) {
    let st;
    try { st = statSync(path); } catch { known.delete(path); continue; }
    const mtime = Math.round(st.mtimeMs);
    let k = known.get(path);
    if (k === undefined || (k && (k.size !== st.size || k.mtime !== mtime))) {
      if (performance.now() > until) { pending++; if (k === undefined) continue; }
      else {
        let next: FileRuns | null = null;
        try { next = st.size > FILE_MAX ? null : scan(path, mtime, k ?? undefined); } catch {}
        known.set(path, (k = next));
      }
    }
    if (!k) continue;
    // The rows of a file are made once, until the file changes.
    k.rows ??= rowsOf(path, k);
    out.push(...k.rows);
  }
  left = pending;
  return out.sort((a, b) => b.updated_ms - a.updated_ms);
}

// ---- reading ----

// The inputs the owner typed, with their times, from the input history beside the file.
function inputs(dir: string): { ts: number; text: string }[] {
  let text = "";
  try { text = readFileSync(join(dir, INPUT), "utf8"); } catch { return []; }
  const out: { ts: number; text: string }[] = [];
  let cur: { ts: number; lines: string[] } | null = null;
  for (const l of text.split("\n")) {
    const m = /^# (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*$/.exec(l);
    if (m) { if (cur) out.push({ ts: cur.ts, text: cur.lines.join("\n") }); cur = { ts: localMs(m[1]!) + (m[2] ? Math.floor(Number(`0.${m[2]}`) * 1000) : 0), lines: [] }; }
    else if (cur && l.startsWith("+")) cur.lines.push(l.slice(1));
  }
  if (cur) out.push({ ts: cur.ts, text: cur.lines.join("\n") });
  return out;
}

async function read(f: Found): Promise<Read> {
  const [path, stamp] = [f.path.slice(0, f.path.lastIndexOf("#")), f.path.slice(f.path.lastIndexOf("#") + 1)];
  const st = statSync(path);
  const all = scan(path, Math.round(st.mtimeMs));
  const at = all.runs.findIndex((r) => r.stamp === stamp);
  if (at < 0) throw new Error("the run is no longer in the history file");
  const run = all.runs[at]!;
  const buf = readFileSync(path);
  const { items, model } = parse(buf.subarray(run.startByte, run.endByte).toString("utf8"));
  const end = all.runs[at + 1]?.start ?? Infinity;
  const typed = inputs(dirname(path)).filter((e) => e.ts >= run.start && e.ts < end);
  const b = new Builder();
  let ts = run.start, p = 0, startup = 0, seenPrompt = false;
  for (const i of items) {
    if (i.kind === "user") {
      seenPrompt = true;
      // The input history's entry for these words, in order; without one, a moment after the last event.
      const hit = typed.findIndex((e, k) => k >= p && e.text.trim() === i.text.trim());
      if (hit >= 0) { p = hit + 1; ts = Math.max(ts + 1, typed[hit]!.ts); } else ts += 1;
      b.user(i.text, ts);
    } else if (i.kind === "assistant") b.assistant([{ type: "text", text: i.text }], ++ts, model, true);
    else if (!seenPrompt) { startup += i.text.split("\n").length; b.counts.skipped += i.text.split("\n").length; }
    else b.note(i.text, ++ts);
  }
  const notes: string[] = [];
  if (startup) notes.push(`${startup} start-up lines Aider printed (version, model, repository) are left out.`);
  if (items.some((i) => i.kind === "tool")) notes.push("Lines Aider printed during the session (applied edits, commits, questions, warnings) are kept as notes beside the conversation; the model does not read them.");
  if (!typed.length) notes.push("No input history was found for this run, so its times are counted from the run's start.");
  return { found: model && !f.model ? { ...f, model } : f, events: b.events, counts: b.counts, notes };
}

export const aiderStore: SideStore = {
  harness: "aider",
  label: "Aider",
  store: aiderDir,
  list,
  read,
  pending: () => left,
};
