// Native memory: what each model family's own harness keeps, read and written
// where and how that harness does, so the owner's memory is one across Keel and
// the tool the model was trained in.
//
// Instruction files are one chain for every model, whatever its family: the
// CLAUDE.md files Claude Code reads and the AGENTS.md files Codex reads, each
// file once (instructionChain below). A repository written for either tool, or
// for both, gives every session the same rules.
// - Claude Code (code.claude.com/docs/en/memory): ~/.claude/CLAUDE.md, then
//   each folder from the root down to the working folder: CLAUDE.md,
//   .claude/CLAUDE.md, CLAUDE.local.md. Its default reads AGENTS.md and
//   .claude/AGENTS.md only where no CLAUDE.md file is in the folder or above;
//   its claude-md-and-agents-md setting reads both, each folder's CLAUDE.md
//   files first, and skips an AGENTS.md a CLAUDE.md imports or links to.
//   Subfolders' files load when the work reaches them.
// - Codex (developers.openai.com/codex/guides/agents-md): $CODEX_HOME's
//   AGENTS.override.md else AGENTS.md (the first non-empty), then from the
//   repository root down one file a folder: AGENTS.override.md, AGENTS.md, then
//   the fallback names of config.toml, within project_doc_max_bytes.
// - OpenCode (opencode.ai/docs/rules): AGENTS.md of each folder, CLAUDE.md where
//   a folder has none, ~/.claude/CLAUDE.md where its own global file is missing.
// Keel reads the union as Claude Code's both-files setting does, with Codex's
// override rule for the AGENTS.md slot of a folder. What changed: a Claude
// session no longer drops AGENTS.md when a CLAUDE.md exists, a GPT session
// reads CLAUDE.md files and the folders above the repository, and any other
// family reads both files of a folder instead of AGENTS.md alone. Codex's byte
// budget gives way to Keel's own per-file bound, sized by the model's window.
//
// Claude family (code.claude.com/docs/en/memory):
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
// GPT family (developers.openai.com/codex/memories):
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
// Other families have no memory of their own harness here. A Keel session never
// writes what another harness generates.
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { locate } from "../core/git.ts";
import { ownerEnv, ownerHome } from "../core/paths.ts";
import type { Session } from "../core/types.ts";
import type { Family } from "../providers/types.ts";
import { memoryHead, neutralMemory, MEMORY_BYTES, MEMORY_LINES } from "../automation/agent-memory.ts";
import { noteMark, type Marks } from "./instruction-marks.ts";
import { CLAUDE_AGENTS_FILES, CLAUDE_FILES, CODEX_FILES } from "../safety/instruction-files.ts";
import { Carried, norm } from "./sections.ts";

export type Roots = { home: string; claude: string; codex: string };
// `same`: a file the chain holds already (the path it is one with, or the files it only imports): listed, not read again.
export type Same = { of: string; imports: boolean };
export type Entry = { path: string; scope: "owner" | "parent" | "folder"; same?: Same };

// Where the harnesses keep their files for this daemon: the owner's, or the
// scratch home a daemon that may not read his was given (core/paths.ts).
export function nativeRoots(): Roots {
  const home = process.env.KEEL_IMPORT_HOME ?? ownerHome();
  const own = !process.env.KEEL_IMPORT_HOME;
  return { home, claude: (own && ownerEnv("CLAUDE_CONFIG_DIR")) || join(home, ".claude"), codex: (own && ownerEnv("CODEX_HOME")) || join(home, ".codex") };
}

const read = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const json = (p: string): any => { try { return JSON.parse(read(p) ?? ""); } catch { return null; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

// --- instructions: one chain for every family -------------------------------

// Each folder's files, in the order they are read: Claude Code's CLAUDE.md files, then the AGENTS.md
// slot (Codex's override, else AGENTS.md, else the fallback names of its config: the first that holds
// anything), then Claude Code's .claude/AGENTS.md.
const CLAUDE_NAMES: readonly string[] = CLAUDE_FILES;
const AGENTS_SLOT: readonly string[] = CODEX_FILES;
const DOT_AGENTS = CLAUDE_AGENTS_FILES.filter((n) => !AGENTS_SLOT.includes(n));

// What a file holds for the chain: its text, null when it cannot be read (it is still listed, and the
// prompt says it could not be read), undefined when it is not a file.
function textOf(p: string): string | null | undefined {
  try { if (!statSync(p).isFile()) return undefined; } catch { return undefined; }
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// The files of one folder the chain reads, before the chain's own dedupe. Every path looked for is
// noted with its mark, so a file made later is noticed.
export function folderFiles(dir: string, fallback: readonly string[] = [], marks?: Marks): { path: string; text: string | null }[] {
  const out: { path: string; text: string | null }[] = [];
  const take = (n: string) => {
    const p = join(dir, n);
    noteMark(marks, p);
    const t = textOf(p);
    if (t === undefined) return false;
    out.push({ path: p, text: t });
    return true;
  };
  for (const n of CLAUDE_NAMES) take(n);
  for (const n of [...AGENTS_SLOT, ...fallback.filter((f) => !AGENTS_SLOT.includes(f))]) {
    const p = join(dir, n);
    noteMark(marks, p);
    const t = textOf(p);
    // (An empty file gives the slot to the next name, as in Codex; an unreadable one keeps it.)
    if (t === undefined || (t !== null && !t.trim())) continue;
    out.push({ path: p, text: t });
    break;
  }
  for (const n of DOT_AGENTS) take(n);
  return out;
}

// How the chain tells that two files are one: the same file on disk (a link, either kind: its device
// and inode), the same text (spacing and line ends aside), or a file that only imports files the chain
// holds or will hold (a CLAUDE.md that is "@AGENTS.md" beside the AGENTS.md it imports). What a file
// brings in by its imports is carried too (`carried`, filled as the prompt expands each file): a
// section another file says again is left out of it where it stands (src/engine/sections.ts).
export class OnceSet {
  private ids = new Map<string, string>();
  private texts: Map<string, string>;
  readonly carried: Carried;
  // `held`: a chain the model holds already (a moved session's prompt): its texts and sections count as
  // said, its paths do not (the chain lists them, as the files it shares).
  constructor(held?: OnceSet) {
    this.texts = new Map(held?.texts);
    this.carried = held?.carried ?? new Carried();
  }
  static id(p: string): string { try { const s = statSync(p); return `${s.dev}:${s.ino}`; } catch { return real(p); } }
  static norm = norm;
  // The file it is one with (a path held, or the files it only imports), null for an empty file,
  // undefined for a file of its own. `beside`: the files the chain takes with this one (its folder's): an import
  // of one of them counts too.
  sameAs(p: string, text: string | null, beside: readonly string[] = []): Same | null | undefined {
    const byId = this.ids.get(OnceSet.id(p));
    if (byId !== undefined) return { of: byId, imports: false };
    if (text === null) return undefined;
    const n = OnceSet.norm(text);
    if (!n) return null;
    const byText = this.texts.get(n);
    // (A held chain's text under the same path is that file again: it is listed, as the chain shares it.)
    if (byText !== undefined && byText !== p) return { of: byText, imports: false };
    // Only imports, each of a file held (or taken with it, and not itself).
    const near = new Map(beside.filter((b) => b !== p).map((b) => [OnceSet.id(b), b] as const));
    const lines = n.split("\n").filter((l) => l.trim());
    const of: string[] = [];
    for (const l of lines) {
      const m = /^@(\S+)\s*$/.exec(l.trim());
      if (!m || m[1]!.startsWith("~")) return undefined;
      const id = OnceSet.id(join(dirname(p), m[1]!));
      const held = id === OnceSet.id(p) ? undefined : this.ids.get(id) ?? near.get(id);
      if (held === undefined) return undefined;
      of.push(held);
    }
    return { of: of.join(", "), imports: true };
  }
  has(p: string, text: string | null, beside: readonly string[] = []): boolean { return this.sameAs(p, text, beside) !== undefined; }
  add(p: string, text: string | null) {
    const id = OnceSet.id(p);
    if (!this.ids.has(id)) this.ids.set(id, p);
    if (text !== null) { const n = OnceSet.norm(text); if (!this.texts.has(n)) this.texts.set(n, p); }
  }
  // Takes the file when it is not one already held; whether it was taken.
  take(p: string, text: string | null, beside: readonly string[] = []): boolean {
    if (this.has(p, text, beside)) return false;
    this.add(p, text);
    return true;
  }
}

// The folders of the walk from `cwd` up, outermost first: to the home folder, or for a folder outside
// it to the root (what is above the home belongs to other accounts). `skip`: a folder whose files are
// not this daemon's (a scratch daemon's view of the account's home).
function walk(cwd: string, homes: readonly string[], skip?: string | null): string[] {
  const out: string[] = [];
  for (let d = cwd; ; d = dirname(d)) {
    if (!skip || real(d) !== real(skip)) out.unshift(d);
    if (dirname(d) === d || homes.includes(d)) break;
  }
  return out;
}

// The owner's own files of each harness: Claude Code's user file, Codex's (its override, else its
// AGENTS.md: the first that holds anything).
export function ownerFiles(roots: Roots, marks?: Marks): { path: string; text: string | null; of: "claude" | "codex" }[] {
  const out: { path: string; text: string | null; of: "claude" | "codex" }[] = [];
  const user = join(roots.claude, "CLAUDE.md");
  noteMark(marks, user);
  const u = textOf(user);
  if (u !== undefined) out.push({ path: user, text: u, of: "claude" });
  for (const n of CODEX_FILES) {
    const p = join(roots.codex, n);
    noteMark(marks, p);
    const t = textOf(p);
    if (t === undefined || (t !== null && !t.trim())) continue;
    out.push({ path: p, text: t, of: "codex" });
    break;
  }
  return out;
}

// The chain every session reads, outermost first: the owner's files of both harnesses, then each
// folder's files from the home (or the root) down to `cwd`, each file once (OnceSet). `once` may come
// with files already taken (Keel's own file). `homes`: where the walk stops going up.
export function instructionChain(cwd: string, roots: Roots, o: { marks?: Marks; once?: OnceSet; homes?: readonly string[]; skip?: string | null } = {}): (Entry & { of?: "claude" | "codex" })[] {
  const once = o.once ?? new OnceSet();
  const out: (Entry & { of?: "claude" | "codex" })[] = [];
  // A file one with another is kept as an entry that says so (`same`), an empty one is not.
  const put = (e: Entry & { of?: "claude" | "codex" }, text: string | null, beside?: readonly string[]) => {
    const same = once.sameAs(e.path, text, beside);
    if (same === undefined) { once.add(e.path, text); out.push(e); }
    // (The one file again by its own path, as the home's .claude/CLAUDE.md is Claude Code's user file: nothing to say.)
    else if (same && same.of !== e.path) out.push({ ...e, same });
  };
  for (const f of ownerFiles(roots, o.marks)) put({ path: f.path, scope: "owner", of: f.of }, f.text);
  const fallback = codexConfig(roots).fallback;
  for (const d of walk(cwd, o.homes ?? [roots.home], o.skip)) {
    const files = folderFiles(d, fallback, o.marks);
    const paths = files.map((f) => f.path);
    for (const f of files) put({ path: f.path, scope: d === cwd ? "folder" : "parent" }, f.text, paths);
  }
  return out;
}

// --- Codex: config ------------------------------------------------------------

export type CodexConfig = { memories: boolean; use: boolean; version?: "v1" | "v2"; dualWrite?: boolean; fallback: string[] };
// The summary the prompt carries: Codex's own bound, 2,500 tokens, at four bytes a token.
export const SUMMARY_TOKENS = 2_500;

export function codexConfig(roots: Roots): CodexConfig {
  let t: any = {};
  const text = read(join(roots.codex, "config.toml"));
  if (text !== null) try { t = Bun.TOML.parse(text); } catch {}
  const m = t?.memories ?? {};
  const names = Array.isArray(t?.project_doc_fallback_filenames) ? t.project_doc_fallback_filenames.filter((n: unknown) => typeof n === "string" && n && !/[\\/]/.test(n)) : [];
  return {
    memories: t?.features?.memories === true,
    use: m.use_memories !== false,
    version: m.version === "v1" || m.version === "v2" ? m.version : undefined,
    ...(typeof m.dual_write === "boolean" ? { dualWrite: m.dual_write } : {}),
    fallback: names,
  };
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
  // As Codex's config load chooses: an explicit version; else v1 when dual-write is turned off or a v1
  // folder exists (a profile with v1 context keeps it); else, a fresh profile, v2.
  const version = cfg.version ?? (cfg.dualWrite === false || existsSync(join(roots.codex, "memories")) ? "v1" : "v2");
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

// The port blocks of the owner's Keel file that a harness's own user file replaces: Keel's import
// copied each harness's user file into it once, and every session now reads the files themselves.
export function withoutPorted(text: string, read: { claude?: boolean; codex?: boolean }): string {
  let out = text;
  for (const [id, on] of [["instructions:claude", read.claude], ["instructions:codex", read.codex]] as const) {
    if (on) out = out.replace(new RegExp(`<!-- keel port: ${id} -->\\n[\\s\\S]*?\\n?<!-- /keel port: ${id} -->\\n?`, "g"), "");
  }
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
export function notesOf(dir: string): { notes: NoteFile[]; index: { lines: number; bytes: number; mtime?: number; over: boolean; missing: string[] } | null } {
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
  let mtime: number | undefined;
  try { mtime = statSync(join(dir, "MEMORY.md")).mtimeMs; } catch {}
  const index = idx === null ? null : { lines: idx.replace(/\n+$/, "").split("\n").length, bytes: Buffer.byteLength(idx), ...(mtime !== undefined ? { mtime } : {}), over: memoryHead(idx).cut, missing: [...linked].filter((f) => !names.includes(f)) };
  return { notes, index };
}
