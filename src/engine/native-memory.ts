// Native memory: what each model family's own harness keeps, read and written
// where and how that harness does, so the owner's memory is one across Keel and
// the tool the model was trained in. Before this, every session read the one
// AGENTS.md (else CLAUDE.md) of each folder and the owner's Keel file, which
// held a one-time copy of both harnesses' user files; auto memory and Codex's
// memories were not read and nothing wrote them.
//
// Claude family (code.claude.com/docs/en/memory):
// - instructions: ~/.claude/CLAUDE.md, then for each folder from the home down
//   to the working folder CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md
//   (the local file last). AGENTS.md is read only when none of those three
//   exists in the working folder or above (the user file does not count).
// - auto memory: <config>/projects/<slug>/memory/. The slug is the project's
//   path with every character that is not a letter or a digit made a dash;
//   the project is the repository (all its worktrees share one folder), else
//   the working folder. MEMORY.md is the index: its first 200 lines or 25 KB
//   are in the prompt, topic files are read on demand with Read. The model
//   writes them itself with Write and Edit, one file per memory with
//   name/description/type frontmatter, and a line for it in MEMORY.md.
//   Subagents do not load it. Off by CLAUDE_CODE_DISABLE_AUTO_MEMORY or
//   autoMemoryEnabled false in the user settings; autoMemoryDirectory moves it.
//
// GPT family (developers.openai.com/codex/guides/agents-md and /memories):
// - instructions: $CODEX_HOME/AGENTS.override.md else AGENTS.md (the first
//   non-empty one), then from the repository root down to the working folder
//   the first non-empty of AGENTS.override.md, AGENTS.md and the fallback names
//   of config.toml, one file a folder, the project files together within
//   project_doc_max_bytes (32 KiB).
// - memories: off unless config.toml has [features] memories = true. Codex
//   writes them itself in the background (its own extraction and consolidation
//   of past sessions): memories_v2/ on a fresh home, memories/ where that
//   folder exists, or memories.version. The prompt carries memory_summary.md
//   (the first 2,500 tokens) and where the rest is; the model searches
//   MEMORY.md and the rollout summaries with its shell when the work calls for
//   it. The generated files are never edited by hand: an explicit "remember",
//   "forget" or correction request is one small note under
//   <memories>/extensions/ad_hoc/notes/, which Codex's next consolidation
//   applies. Keel writes only that note, through the tool the family is
//   trained on (apply_patch or the shell).
//
// Other families keep the chain they had. A Keel session never writes what
// another harness generates.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { locate } from "../core/git.ts";
import { ownerEnv, ownerHome } from "../core/paths.ts";
import type { Session } from "../core/types.ts";
import type { Family } from "../providers/types.ts";
import { memoryHead, neutralMemory, MEMORY_BYTES, MEMORY_LINES } from "../automation/agent-memory.ts";
import { noteMark, type Marks } from "./instruction-marks.ts";
import { CLAUDE_AGENTS_FILES, CLAUDE_FILES, CODEX_FILES } from "../safety/instruction-files.ts";

export type Roots = { home: string; claude: string; codex: string };
export type Entry = { path: string; scope: "owner" | "parent" | "folder"; limit?: number };

// Where the harnesses keep their files for this daemon: the owner's, or the
// scratch home a daemon that may not read his was given (core/paths.ts).
export function nativeRoots(): Roots {
  const home = process.env.KEEL_IMPORT_HOME ?? ownerHome();
  const own = !process.env.KEEL_IMPORT_HOME;
  return { home, claude: (own && ownerEnv("CLAUDE_CONFIG_DIR")) || join(home, ".claude"), codex: (own && ownerEnv("CODEX_HOME")) || join(home, ".codex") };
}

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = (p: string): any => { try { return JSON.parse(read(p) ?? ""); } catch { return null; } };
const present = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const filled = (p: string) => { try { return statSync(p).isFile() && !!readFileSync(p, "utf8").trim(); } catch { return false; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// The folders of the walk from `cwd` up, outermost first: to the home folder, or for a
// folder outside it to the root (what is above the home belongs to other accounts).
function walk(cwd: string, home: string): string[] {
  const out: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    out.unshift(d);
    if (dirname(d) === d || d === home) break;
  }
  return out;
}

// --- Claude: instructions ---------------------------------------------------

const CLAUDE_NAMES: readonly string[] = CLAUDE_FILES;
const AGENTS_NAMES: readonly string[] = CLAUDE_AGENTS_FILES;

export function claudeChain(cwd: string, roots: Roots, marks?: Marks): Entry[] {
  const dirs = walk(cwd, roots.home);
  for (const d of dirs) for (const n of [...CLAUDE_NAMES, ...AGENTS_NAMES]) noteMark(marks, join(d, n));
  const user = join(roots.claude, "CLAUDE.md");
  noteMark(marks, user);
  // AGENTS.md stands in for CLAUDE.md only where no CLAUDE.md file counts, anywhere on the way.
  // (The home folder's own .claude/CLAUDE.md is the user file: it is read once and does not count.)
  const found = (d: string, n: string) => join(d, n) !== user && present(join(d, n));
  const counts = dirs.some((d) => CLAUDE_NAMES.some((n) => found(d, n)));
  const names = counts ? CLAUDE_NAMES : AGENTS_NAMES;
  const out: Entry[] = [];
  if (present(user)) out.push({ path: user, scope: "owner" });
  for (const d of dirs) for (const n of names) if (found(d, n)) out.push({ path: join(d, n), scope: d === cwd ? "folder" : "parent" });
  return out;
}

// --- Codex: instructions and config -----------------------------------------

export type CodexConfig = { memories: boolean; use: boolean; version?: "v1" | "v2"; docMax: number; fallback: string[] };
export const DOC_MAX_BYTES = 32 * 1024;
// The summary the prompt carries: Codex's own bound, 2,500 tokens, at four bytes a token.
export const SUMMARY_TOKENS = 2_500;

export function codexConfig(roots: Roots): CodexConfig {
  let t: any = {};
  const text = read(join(roots.codex, "config.toml"));
  if (text !== null) try { t = Bun.TOML.parse(text); } catch {}
  const m = t?.memories ?? {};
  const names = Array.isArray(t?.project_doc_fallback_filenames) ? t.project_doc_fallback_filenames.filter((n: unknown) => typeof n === "string" && n && !/[\\/]/.test(n)) : [];
  const max = Number(t?.project_doc_max_bytes);
  return {
    memories: t?.features?.memories === true,
    use: m.use_memories !== false,
    version: m.version === "v1" || m.version === "v2" ? m.version : undefined,
    docMax: Number.isFinite(max) && max >= 0 ? Math.floor(max) : DOC_MAX_BYTES,
    fallback: names,
  };
}

export function codexChain(cwd: string, roots: Roots, cfg = codexConfig(roots), marks?: Marks): Entry[] {
  const out: Entry[] = [];
  const g = CODEX_FILES.map((n) => join(roots.codex, n));
  for (const p of g) noteMark(marks, p);
  const global = g.find(filled);
  if (global) out.push({ path: global, scope: "owner" });
  const top = locate(cwd)?.top;
  const root = top && (cwd === top || cwd.startsWith(`${top}/`)) ? top : cwd;
  const dirs: string[] = [];
  for (let d = cwd; ; d = dirname(d)) { dirs.unshift(d); if (d === root || dirname(d) === d) break; }
  let left = cfg.docMax;
  for (const d of dirs) {
    const names = [...CODEX_FILES, ...cfg.fallback];
    for (const n of names) noteMark(marks, join(d, n));
    const hit = names.map((n) => join(d, n)).find(filled);
    if (!hit || left <= 0) continue;
    const size = statSync(hit).size;
    out.push({ path: hit, scope: d === cwd ? "folder" : "parent", limit: left });
    left -= size;
  }
  return out;
}

// --- Claude: auto memory -----------------------------------------------------

// The folder name Claude Code gives a project: its path, every character that is not a letter or a digit a dash.
export const slugOf = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");

// The project of a folder as auto memory means it: the repository's main folder (a worktree is its
// repository), else the folder itself.
export function projectOf(cwd: string): string {
  const w = locate(cwd);
  if (!w) return real(cwd);
  return basename(w.common) === ".git" ? dirname(w.common) : w.top ?? w.common;
}

const truthy = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";

// The auto memory folder of a project, or why there is none.
export function autoMemory(cwd: string, roots: Roots, env: Record<string, string | undefined> = process.env): { dir: string } | { off: string } {
  if (truthy(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY)) return { off: "CLAUDE_CODE_DISABLE_AUTO_MEMORY is set" };
  const s = json(join(roots.claude, "settings.json"));
  if (s?.autoMemoryEnabled === false) return { off: "autoMemoryEnabled is false in the Claude Code settings" };
  // Only the user's own settings may move it: a repository's settings file would aim the model's writes anywhere.
  const moved = typeof s?.autoMemoryDirectory === "string" ? s.autoMemoryDirectory : "";
  if (moved.startsWith("/")) return { dir: moved.replace(/\/+$/, "") };
  if (moved.startsWith("~/")) return { dir: join(roots.home, moved.slice(2)).replace(/\/+$/, "") };
  const name = env.CLAUDE_CODE_PROJECT_DIR_NAME?.trim();
  return { dir: join(roots.claude, "projects", name && !/[\\/]/.test(name) ? name : slugOf(projectOf(cwd)), "memory") };
}

const TYPES = "user (their role, expertise and way of working), feedback (corrections they gave you and approaches they confirmed), project (ongoing work, deadlines and decisions the code and git history do not show) and reference (where to find something outside the project, such as a tracker or a dashboard)";

// What a memory store the owner keeps for every tool is told to the model, so a fact is held once.
const STORE_RULE = [
  "The owner also keeps a memory store that every tool of theirs reads: its facts arrive in <memory source=\"tacit\"> blocks. Hold each fact in one place:",
  "- a rule, decision, preference or past mistake that holds across projects and tools belongs in that store (its tools, when connected), not here;",
  "- what only this project's later sessions need (where things are, what is in flight, who asked for what) belongs here;",
  "- never save here what a <memory> block or the instruction files already say, and never save the same fact in both.",
].join("\n");

const CODEX_STORE_RULE = "The owner also keeps a memory store that every tool of theirs reads: its facts arrive in <memory source=\"tacit\"> blocks. A rule, decision or preference that holds across projects goes to that store (its tools, when connected), not to a note here, and what a <memory> block already says is never noted again.";

export function claudeBlock(dir: string, index: string | null, more: boolean, store: boolean): string {
  const head = index === null ? null : memoryHead(index, more);
  return [
    `# Auto memory`,
    `You have a persistent memory folder at ${dir}. It outlives this session, belongs to this project and is shared by every worktree of its repository. What you save there, you read at the start of later sessions.`,
    `Save what a later session would need and cannot get from the code or git history, as you work and when the owner asks you to remember something. Four kinds: ${TYPES}. Skip what the code, the git history or the instruction files already say, a fix you can read in the diff, and secrets. When asked to forget something, remove it.`,
    `One file for each memory, named by kind and topic (feedback_testing.md), starting with frontmatter (name, description, type: user, feedback, project or reference) and then the note. Add one line for it to MEMORY.md, the index: "- [Title](file.md): a hook of one line". Write both with the Write and Edit tools. Merge or drop a stale entry instead of adding a second one.`,
    `Only the first ${MEMORY_LINES} lines or ${MEMORY_BYTES / 1024} KB of MEMORY.md are given to you at a start: keep it short, move detail into the topic files, and read a topic file with the Read tool when its line applies to the work.`,
    ...(store ? [STORE_RULE] : []),
    head === null ? "MEMORY.md does not exist yet."
      : `MEMORY.md now${head.cut ? ", cut at that bound: shorten it so what matters stays within it" : ""}:\n${neutralMemory(head.text).trim() || "(empty)"}`,
  ].join("\n");
}

// --- Codex: memories --------------------------------------------------------

// The folder of Codex's memories for this home, and whether the model is to use them.
export function codexMemories(roots: Roots, cfg = codexConfig(roots)): { base: string; version: "v1" | "v2" } | null {
  if (!cfg.memories || !cfg.use) return null;
  const version = cfg.version ?? (existsSync(join(roots.codex, "memories")) ? "v1" : "v2");
  return { base: join(roots.codex, version === "v1" ? "memories" : "memories_v2"), version };
}

// A summary cut at Codex's bound, at a line end where one is near.
export function cutSummary(text: string, tokens = SUMMARY_TOKENS): string {
  const max = tokens * 4;
  if (text.length <= max) return text;
  const nl = text.lastIndexOf("\n", max);
  return `${text.slice(0, nl > max / 2 ? nl : max).trimEnd()}\n[cut: the summary goes on in memory_summary.md]`;
}

export function codexBlock(base: string, version: "v1" | "v2", summary: string, store: boolean): string {
  const notes = join(base, "extensions", "ad_hoc", "notes");
  return [
    "## Memory",
    version === "v1"
      ? [`You have a memory folder from earlier work at ${base}. Use it when the request names this workspace, asks for earlier decisions, or is not self-contained; skip it for a request that is. Quick pass: take keywords from the summary below, search ${join(base, "MEMORY.md")} for them, open only the one or two rollout summaries or skills it points to under ${join(base, "rollout_summaries")} or ${join(base, "skills")}, and stop when there is no hit. Keep the pass to a few steps.`].join("")
      : `Use the summary below as history: the owner's preferences, corrections and decisions. Read a matching file under ${join(base, "rollout_summaries")} only when its evidence could change your answer; do not search the history speculatively.`,
    "Memory is not proof of current behavior: check what can have changed, and say when you answer from memory alone.",
    `Do not edit the generated files. When the owner explicitly asks you to remember, forget or correct something, write one small Markdown note, with apply_patch or the shell, to ${notes}/YYYY-MM-DDTHH-MM-SS-<slug>.md (UTC time; the slug 1 to 80 lowercase letters, digits or hyphens). Codex applies such notes the next time it consolidates its memories. Never put a secret in one.`,
    ...(store ? [CODEX_STORE_RULE] : []),
    "========= MEMORY_SUMMARY BEGINS =========",
    neutralMemory(summary),
    "========= MEMORY_SUMMARY ENDS =========",
  ].join("\n");
}

// What the daemon wires in: whether the owner's memory store is connected for a session (so the
// facts are divided), and a note of each load, for the sweep (src/integrations/native-log.ts).
export const nativeContext: { store?: (s: Session) => boolean; loaded?: (s: Session, n: Native) => void } = {};

// --- the session's native memory ---------------------------------------------

export type Native = {
  family: Family;
  // The block of the prompt, and what changes its meaning (its files' content).
  text: string; data: string;
  // The folders the model may write without being asked, and the files it is given in the prompt.
  writes: string[]; files: string[];
  // The folder of the memory: the auto memory folder, Codex's memories folder.
  dir: string;
  system: "claude" | "codex";
};

// `top`: a session no agent started; an agent does not load its parent's auto memory.
// The index and the summary are read when the prompt is made and not watched: the model writes the index itself, and a
// session reads it again where Claude Code does, at a start and after a compaction.
// `store`: the owner's memory store is connected, so the facts are divided between it and this.
export function nativeMemory(family: Family, cwd: string, o: { top: boolean; store?: boolean; roots?: Roots; env?: Record<string, string | undefined> }): Native | null {
  const roots = o.roots ?? nativeRoots();
  if (family === "claude" && o.top) {
    const m = autoMemory(cwd, roots, o.env);
    if ("off" in m) return null;
    const file = join(m.dir, "MEMORY.md");
    let index: string | null = null, more = false;
    try {
      const buf = Buffer.alloc(MEMORY_BYTES + 1);
      const fd = openSync(file, "r");
      try { const n = readSync(fd, buf, 0, buf.length, 0); more = n > MEMORY_BYTES; index = buf.subarray(0, n).toString("utf8"); } finally { closeSync(fd); }
    } catch {}
    return { family, system: "claude", dir: m.dir, text: claudeBlock(m.dir, index, more, !!o.store), data: index ?? "", writes: [m.dir], files: index === null ? [] : [file] };
  }
  if (family === "gpt" && o.top) {
    const cfg = codexConfig(roots);
    const mem = codexMemories(roots, cfg);
    if (!mem) return null;
    const file = join(mem.base, "memory_summary.md");
    const summary = (read(file) ?? "").trim();
    if (!summary) return null;
    return { family, system: "codex", dir: mem.base, text: codexBlock(mem.base, mem.version, cutSummary(summary), !!o.store), data: summary, writes: [join(mem.base, "extensions", "ad_hoc", "notes")], files: [file] };
  }
  return null;
}

// The folders a session of this family and folder may write for memory, without a card, from the files alone.
export function nativeWrites(family: Family, cwd: string, roots = nativeRoots()): string[] {
  if (family === "claude") { const m = autoMemory(cwd, roots); return "dir" in m ? [m.dir] : []; }
  if (family === "gpt") { const m = codexMemories(roots); return m ? [join(m.base, "extensions", "ad_hoc", "notes")] : []; }
  return [];
}

// The folders a session of this family reads memory from and writes it to (a Codex session reads the
// whole memories folder and writes only its notes folder).
export function nativePlaces(family: Family, cwd: string, roots = nativeRoots()): { read: string[]; write: string[] } {
  if (family === "gpt") { const m = codexMemories(roots); return m ? { read: [m.base], write: [join(m.base, "extensions", "ad_hoc", "notes")] } : { read: [], write: [] }; }
  const w = nativeWrites(family, cwd, roots);
  return { read: w, write: w };
}

// The names of a family's native files for the walk: what the prompt of Keel's own chain
// (turn.ts) calls the owner's, the parents' and the folder's.
export function chainOf(family: Family, cwd: string, roots: Roots, marks?: Marks): Entry[] | null {
  if (family === "claude") return claudeChain(cwd, roots, marks);
  if (family === "gpt") return codexChain(cwd, roots, undefined, marks);
  return null;
}

// The port blocks of the owner's Keel file that a family's own files replace: Keel's import
// copied each harness's user file into it once, and a session of that family now reads the file.
const PORTED = { claude: ["instructions:claude", "instructions:codex"], gpt: ["instructions:claude", "instructions:codex"] } as const;
export function withoutPorted(text: string, family: Family, nativeUser: boolean): string {
  if (!nativeUser || (family !== "claude" && family !== "gpt")) return text;
  let out = text;
  for (const id of PORTED[family]) out = out.replace(new RegExp(`<!-- keel port: ${id} -->\\n[\\s\\S]*?\\n?<!-- /keel port: ${id} -->\\n?`, "g"), "");
  return out;
}

// What the sweep and the gate need of a path: which native file it is.
export function nativeKind(path: string, dirs: readonly string[]): "index" | "note" | null {
  for (const d of dirs) {
    if (path === join(d, "MEMORY.md")) return "index";
    if (path.startsWith(`${d}/`)) return "note";
  }
  return null;
}

// The topic files of an auto memory folder, with their size and age, and what the index says of them.
export type NoteFile = { file: string; bytes: number; mtime: number; type: string | null; indexed: boolean };
export function notesOf(dir: string): { notes: NoteFile[]; index: { lines: number; bytes: number; over: boolean; missing: string[] } | null } {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort(); } catch { return { notes: [], index: null }; }
  const idx = read(join(dir, "MEMORY.md"));
  const linked = new Set<string>();
  if (idx !== null) for (const m of idx.matchAll(/\]\(([^)\s]+\.md)\)/g)) linked.add(m[1]!.replace(/^\.\//, ""));
  const notes: NoteFile[] = [];
  for (const file of names) {
    try {
      const st = statSync(join(dir, file));
      if (!st.isFile()) continue;
      const head = (read(join(dir, file)) ?? "").slice(0, 600);
      const type = /^---\n[\s\S]*?\ntype:\s*([a-z]+)/.exec(head)?.[1] ?? null;
      notes.push({ file, bytes: st.size, mtime: st.mtimeMs, type, indexed: linked.has(file) });
    } catch {}
  }
  const index = idx === null ? null : { lines: idx.replace(/\n+$/, "").split("\n").length, bytes: Buffer.byteLength(idx), over: memoryHead(idx).cut, missing: [...linked].filter((f) => !names.includes(f)) };
  return { notes, index };
}
