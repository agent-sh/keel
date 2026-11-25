// agnix, the linter of agent configs (github.com/agent-sh/agnix): CLAUDE.md, AGENTS.md, skills, hooks,
// MCP and plugin files. When a session's prompt is made in a folder (its start, and again after one of
// its instruction files changed), Keel runs `agnix --format json` on that folder's agent configs, in
// the background: niced, one run at a time across the daemon, bounded in time, and only when the
// files' contents differ from the last run's (the key: every file's bytes, and the program's own
// mark). The findings are quiet: a line on Settings > Health per folder and in the folder's
// instruction-files view, never on the session. Errors (not warnings) reach a session of the folder
// once, as a harness note at its next turn, so the model can fix them when the owner asks.
// When agnix is not installed, Health says so once and nothing else runs.
//
// Only the folder's own agent configs are named on the command line (agnix then checks those paths,
// not a walk of the whole folder): a session started in the home folder lints its configs, not the home.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homeDir } from "../core/paths.ts";
import { readText } from "../core/proc.ts";
import { instructionNames } from "../safety/instruction-files.ts";

export type Level = "error" | "warning" | "info";
export type Finding = { level: Level; rule: string; file: string; line: number; message: string };
export type Lint = {
  folder: string; key: string; at: number; ms: number; version: string;
  files: number; errors: number; warnings: number; info: number;
  // The errors and warnings, errors first (info is counted, not kept).
  findings: Finding[];
  // Why there are no findings to trust: the run timed out, failed, or printed what is not its JSON.
  failed?: string;
};

// What else a folder holds that agnix checks, beside the instruction files (the trust pin's names): the
// config files and folders by their own paths, never a harness's whole folder (a home's .claude and .codex
// hold every transcript).
export const CONFIG_PATHS = [
  ".claude/settings.json", ".claude/settings.local.json", ".claude/skills", ".claude/agents", ".claude/commands", ".claude/rules", ".claude/hooks",
  ".codex/config.toml", ".codex/skills", ".codex/agents", ".agents/skills",
  ".cursor/rules", ".cursor/mcp.json", ".gemini/settings.json", "GEMINI.md", ".mcp.json", ".claude-plugin", ".agnix.toml",
];
// The bounds: a run's time, the files a key reads, and the bytes of one file it reads whole.
export const RUN_MS = 30_000;
export const KEY_FILES = 2_000;
export const KEY_FILE_BYTES = 1_048_576;
export const KEY_BYTES = 16 * 1_048_576;
// The findings a folder keeps, and the folders kept.
export const KEEP_FINDINGS = 50;
export const KEEP_FOLDERS = 200;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".venv"]);

// Where the program is: KEEL_AGNIX (a path, or "off"), else agnix on the PATH, else ~/.cargo/bin/agnix.
export function agnixPath(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.KEEL_AGNIX;
  if (set === "off") return null;
  if (set) return existsSync(set) ? set : null;
  const onPath = Bun.which("agnix", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const cargo = join(homeDir(), ".cargo", "bin", "agnix");
  return existsSync(cargo) ? cargo : null;
}

// The folder's agent configs, by name from the folder (those that exist).
export function configsOf(folder: string, fallback: readonly string[] = []): string[] {
  return [...new Set([...instructionNames(fallback), ...CONFIG_PATHS])].filter((n) => existsSync(join(folder, n)));
}

// The key of a run: the program's mark and every file's path and bytes under the configs (a file past
// KEY_FILE_BYTES by its size and change time; past KEY_FILES files and folders, the rest by their
// count). A folder is walked once, by its device and inode, so a link to a folder above it ends.
export async function keyOf(folder: string, names: readonly string[], bin: string): Promise<string> {
  const h = createHash("sha256");
  try { const s = statSync(bin); h.update(`bin:${bin}:${s.size}:${s.mtimeMs}\n`); } catch { h.update(`bin:${bin}\n`); }
  let seen = 0, bytes = 0;
  const dirs = new Set<string>();
  const visit = async (rel: string): Promise<void> => {
    const p = join(folder, rel);
    let st;
    try { st = await lstat(p); } catch { return; }
    if (st.isSymbolicLink()) { try { st = statSync(p); } catch { h.update(`dangling:${rel}\n`); return; } }
    if (st.isDirectory()) {
      const id = `${st.dev}:${st.ino}`;
      if (dirs.has(id)) { h.update(`again:${rel}\n`); return; }
      dirs.add(id);
      if (++seen > KEY_FILES) { h.update(`more:${rel}\n`); return; }
      let kids: string[] = [];
      try { kids = (await readdir(p)).sort(); } catch { return; }
      for (const k of kids) if (!SKIP_DIRS.has(k)) await visit(join(rel, k));
      return;
    }
    if (!st.isFile()) return;
    if (++seen > KEY_FILES) { h.update(`more:${rel}\n`); return; }
    if (st.size > KEY_FILE_BYTES || bytes + st.size > KEY_BYTES) { h.update(`big:${rel}:${st.size}:${st.mtimeMs}\n`); return; }
    bytes += st.size;
    try { h.update(`file:${rel}:`); h.update(await readFile(p)); h.update("\n"); } catch { h.update(`unread:${rel}\n`); }
  };
  for (const n of names) await visit(n);
  return h.digest("hex");
}

// agnix's JSON, read into a Lint (pure).
export function parseLint(text: string): Pick<Lint, "version" | "files" | "errors" | "warnings" | "info" | "findings"> | null {
  let d: any;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== "object" || !Array.isArray(d.diagnostics)) return null;
  const all: Finding[] = d.diagnostics
    .filter((x: any) => x && (x.level === "error" || x.level === "warning" || x.level === "info"))
    .map((x: any) => ({ level: x.level, rule: String(x.rule ?? ""), file: String(x.file ?? ""), line: Number(x.line) || 0, message: String(x.message ?? "") }));
  const SUM: Record<Level, string> = { error: "errors", warning: "warnings", info: "info" };
  const count = (l: Level): number => { const n = d.summary?.[SUM[l]]; return typeof n === "number" ? n : all.filter((f) => f.level === l).length; };
  const kept = [...all.filter((f) => f.level === "error"), ...all.filter((f) => f.level === "warning")].slice(0, KEEP_FINDINGS);
  return { version: String(d.version ?? ""), files: Number(d.files_checked) || 0, errors: count("error"), warnings: count("warning"), info: count("info"), findings: kept };
}

// What a session is told once: its errors by rule, file and message (a line that moved is the same error).
export function errorsKey(l: Pick<Lint, "findings">): string {
  const errs = l.findings.filter((f) => f.level === "error").map((f) => `${f.rule}\0${f.file}\0${f.message}`).sort();
  return createHash("sha256").update(errs.join("\n")).digest("hex").slice(0, 32);
}

// A finding as one line: file:line rule message.
export const findingLine = (f: Finding) => `${f.file || "(project)"}${f.line ? `:${f.line}` : ""} ${f.rule}: ${f.message}`;

type Persisted = { folders: Record<string, Lint> };

// The runner: one per daemon (`agnix()`), a state file for its last result per folder.
export class Agnix {
  private folders = new Map<string, Lint>();
  private running = new Map<string, Promise<Lint | null>>();
  private line: Promise<unknown> = Promise.resolve();
  private loaded = false;
  // Runs started (for the tests: a cached key runs nothing).
  runs = 0;
  // `failed`: a run of the program that failed, once a run (a failure kept for the same files is not told again).
  constructor(private o: { file?: string; bin?: () => string | null; fallback?: () => readonly string[]; nice?: boolean; ms?: number; changed?: (l: Lint) => void; failed?: (l: Lint) => void } = {}) {}

  private bin(): string | null { return (this.o.bin ?? agnixPath)(); }
  // Whether the program is there (Health's one line when it is not).
  installed(): boolean { return this.bin() !== null; }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.o.file) return;
    try {
      const d = JSON.parse(readFileSync(this.o.file, "utf8")) as Persisted;
      for (const [k, v] of Object.entries(d.folders ?? {})) if (v && typeof v.key === "string") this.folders.set(k, v);
    } catch {}
  }
  private save() {
    if (!this.o.file) return;
    const out: Persisted = { folders: Object.fromEntries(this.folders) };
    void Bun.write(this.o.file, JSON.stringify(out)).catch(() => {});
  }

  // The last result of a folder, and of every folder (newest first).
  of(folder: string): Lint | undefined { this.load(); return this.folders.get(folder); }
  all(): Lint[] { this.load(); return [...this.folders.values()].sort((a, b) => b.at - a.at); }

  // Lints the folder when its configs changed since its last run (or it has none). Never throws;
  // null when there is nothing to run (no program, no configs).
  check(folder: string): Promise<Lint | null> {
    this.load();
    const on = this.running.get(folder);
    if (on) return on;
    const p = this.checkNow(folder).catch(() => null).finally(() => this.running.delete(folder));
    this.running.set(folder, p);
    return p;
  }

  private async checkNow(folder: string): Promise<Lint | null> {
    const bin = this.bin();
    if (!bin) return null;
    const names = configsOf(folder, this.o.fallback?.() ?? []);
    if (!names.length) return null;
    const key = await keyOf(folder, names, bin);
    const was = this.folders.get(folder);
    if (was && was.key === key) return was;
    // The same files in another folder (a worktree of the same repository): its run stands for this one.
    const twin = [...this.folders.values()].find((l) => l.key === key && !l.failed);
    if (twin) return this.keep({ ...twin, folder });
    // One run at a time across the daemon.
    const run = this.line.then(() => this.spawn(folder, names, bin, key));
    this.line = run.catch(() => {});
    const lint = await run;
    if (lint.failed) try { this.o.failed?.(lint); } catch {}
    return this.keep(lint);
  }

  private keep(lint: Lint): Lint {
    this.folders.delete(lint.folder);
    this.folders.set(lint.folder, lint);
    while (this.folders.size > KEEP_FOLDERS) this.folders.delete(this.folders.keys().next().value!);
    this.save();
    this.o.changed?.(lint);
    return lint;
  }

  private async spawn(folder: string, names: string[], bin: string, key: string): Promise<Lint> {
    this.runs++;
    const t0 = Date.now();
    const argv = [...(this.o.nice === false ? [] : ["nice", "-n", "10"]), bin, "--format", "json", ...names];
    const base = { folder, key, at: t0, version: "", files: 0, errors: 0, warnings: 0, info: 0, findings: [] as Finding[] };
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { cwd: folder, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", AGNIX_TELEMETRY: "0" } });
    } catch (e) {
      return { ...base, ms: Date.now() - t0, failed: `could not start: ${(e as Error).message}` };
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, this.o.ms ?? RUN_MS);
    try {
      const [out, err] = await Promise.all([readText(proc.stdout as any, "agnix"), readText(proc.stderr as any, "agnix"), proc.exited]);
      const ms = Date.now() - t0;
      if (timedOut) return { ...base, ms, failed: `took longer than ${Math.round((this.o.ms ?? RUN_MS) / 1000)} s` };
      const r = parseLint(out);
      if (!r) return { ...base, ms, failed: (err.trim().split("\n").at(-1) || `exit ${proc.exitCode}, no JSON`).slice(0, 300) };
      return { ...base, ...r, ms };
    } finally {
      clearTimeout(timer);
    }
  }
}

// The daemon's runner (set by its route module).
let current: Agnix | null = null;
export const agnix = () => current;
export const setAgnix = (a: Agnix | null) => void (current = a);
