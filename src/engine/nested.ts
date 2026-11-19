// Instruction files below the session's folder, loaded when the work reaches
// them. The system prompt carries the AGENTS.md (else CLAUDE.md) of each folder
// from the root down to the session's folder; a repository with an AGENTS.md
// in a subfolder (a package, a crate, a service) has rules there the prompt
// does not carry. When a call reads, lists, edits or runs in a folder under the
// session's folder, the instruction files between that folder and the session's
// folder that the model has not seen yet are appended to the call's result,
// nearest the session's folder first, once each. An edit outside the session's
// folder, in a repository, brings that repository's files from its root down.
//
// Claude Code, OpenCode and Gemini CLI load nested instruction files the same
// way (on a read, write or listing in that area). Once each means: while an
// earlier copy is in what the model reads. A compaction that summarized it
// away, or a rewind to before it, lets the next call there load it again.
// The text goes through the same trust filter as the prompt's files.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import type { Session, StoredEvent, ToolResultBlock } from "../core/types.ts";
import type { Tool } from "../tools/types.ts";
import { checkpointAt } from "./compact.ts";
import { instructionFilter, instructionPaths } from "./turn.ts";
import { rootOf } from "../safety/trust.ts";

const NAMES = ["AGENTS.md", "CLAUDE.md"]; // AGENTS.md wins in one folder, as in the prompt
const LIMIT = 40_000; // what the prompt includes of one file
const OPEN = '<nested-instructions path="';
const MARK = /<nested-instructions path="([^"]+)">/g;

const PATH_KEYS = ["file_path", "absolute_path", "path", "notebook_path", "dir_path", "filePath"];
const READERS = new Set(["cat", "head", "tail", "sed", "nl", "less", "more", "bat", "wc", "awk"]);

// The paths a call names: its path fields, the files a patch touches, the
// shell's working folder, and the file of a one-file read command.
export function targetsOf(tool: Pick<Tool, "name" | "kind">, input: any, cwd: string): { paths: string[]; edit: boolean } {
  const out: string[] = [];
  const edit = tool.kind === "edit";
  if (input && typeof input === "object") {
    for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k]) out.push(input[k]);
    for (const k of ["workdir", "cwd", "directory"]) if (typeof input[k] === "string" && input[k]) out.push(input[k]);
  }
  const patch = typeof input === "string" ? input : typeof input?.input === "string" ? input.input : typeof input?.patch === "string" ? input.patch : "";
  if (edit && patch) for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2])!.trim());
  if (tool.kind === "shell") {
    const cmd = typeof input?.command === "string" ? input.command : typeof input?.cmd === "string" ? input.cmd : Array.isArray(input?.command) ? input.command.at(-1) : "";
    // One simple command (no pipes or chains): the reader's last word that is not a flag.
    if (typeof cmd === "string" && !/[|;&<>`$]/.test(cmd)) {
      const words = cmd.trim().split(/\s+/);
      if (READERS.has(words[0]!) && words.length > 1) {
        const last = words.at(-1)!.replace(/^['"]|['"]$/g, "");
        if (!last.startsWith("-")) out.push(last);
      }
    }
  }
  return { paths: out.map((p) => (isAbsolute(p) ? p : resolve(cwd, p.replace(/^~(?=\/)/, process.env.HOME ?? "~")))), edit };
}

const fileIn = (dir: string) => NAMES.map((n) => join(dir, n)).find((p) => existsSync(p));
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// The instruction files a target brings, outermost first, leaving out those
// the system prompt already carries and the target itself (a read of the file).
export function filesFor(target: string, cwd: string, edit: boolean, inPrompt: Set<string>): string[] {
  const start = isDir(target) ? target : dirname(target);
  let stop: string | null = null;
  if (contains(cwd, start)) stop = cwd;
  else if (edit) {
    const root = rootOf(start);
    if (root) stop = dirname(root); // the repository's root folder counts
  }
  if (!stop) return [];
  const found: string[] = [];
  for (let d = start; d !== stop && contains(stop, d) && d !== dirname(d); d = dirname(d)) {
    const f = fileIn(d);
    if (f && f !== target && !inPrompt.has(f)) found.unshift(f);
  }
  return found;
}

// Which nested files the model reads now: marked in the results after the
// last compaction on the session's branch. Kept per session and read on from
// where it stopped while the branch only grows; anything else reads it again.
type Seen = { cp: string; upto: number; lastId: string | null; paths: Set<string> };
const seen = new Map<string, Seen>();
// Loaded in the step running now, before its results are stored.
const pending = new Map<string, Set<string>>();

function textsOf(e: StoredEvent): string[] {
  if (e.kind === "tool_result") return (e.data.results ?? []).flatMap((r: ToolResultBlock) => (typeof r.content === "string" ? [r.content] : r.content.filter((b) => b.type === "text").map((b: any) => b.text)));
  if (e.kind === "note" && e.data.model) return [e.data.text];
  return [];
}

export function loadedPaths(store: Store, sessionId: string): Set<string> {
  const s = store.session(sessionId);
  const events = lineage(store.events(sessionId), s?.head ?? null);
  const cp = checkpointAt(events);
  const cpId = cp.at >= 0 ? events[cp.at]!.id : "";
  let st = seen.get(sessionId);
  const grows = st && st.cp === cpId && st.upto <= events.length && (st.upto === 0 ? true : events[st.upto - 1]!.id === st.lastId);
  if (!st || !grows) st = { cp: cpId, upto: Math.max(0, cp.at >= 0 ? cp.keepFrom : 0), lastId: null, paths: new Set() };
  for (let i = st.upto; i < events.length; i++) {
    for (const t of textsOf(events[i]!)) if (t.includes(OPEN)) for (const m of t.matchAll(MARK)) st.paths.add(m[1]!);
  }
  st.upto = events.length;
  st.lastId = events.at(-1)?.id ?? null;
  seen.set(sessionId, st);
  return new Set([...st.paths, ...(pending.get(sessionId) ?? [])]);
}

export function block(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const text = instructionFilter.file ? instructionFilter.file(path, raw) : raw;
  if (text === null || !text.trim()) return null;
  const cut = text.length > LIMIT ? `${text.slice(0, LIMIT)}\n(cut at ${LIMIT} characters)` : text;
  return `${OPEN}${path}">\nInstructions for the files under ${dirname(path)}, from its ${path.slice(dirname(path).length + 1)}. They add to the project's other instruction files.\n\n${cut.trimEnd()}\n</nested-instructions>`;
}

// The blocks to append to one call's result; marks them loaded for this step.
export function nestedFor(store: Store, s: Session, tool: Tool, input: any, toolCwd?: string): string[] {
  if (s.machine) return []; // the files are on the session's machine
  const cwd = s.workspace;
  const { paths, edit } = targetsOf(tool, input, toolCwd ?? cwd);
  if (!paths.length) return [];
  const inPrompt = new Set(instructionPaths(cwd).map((f) => f.path));
  let loaded: Set<string> | null = null;
  const out: string[] = [];
  for (const p of paths) {
    for (const f of filesFor(p, cwd, edit, inPrompt)) {
      loaded ??= loadedPaths(store, s.id);
      if (loaded.has(f)) continue;
      const b = block(f);
      loaded.add(f);
      if (!b) continue;
      out.push(b);
      (pending.get(s.id) ?? pending.set(s.id, new Set()).get(s.id)!).add(f);
    }
  }
  return out;
}

export const stepStored = (sessionId: string) => void pending.delete(sessionId);
export const forget = (sessionId: string) => { pending.delete(sessionId); seen.delete(sessionId); };
