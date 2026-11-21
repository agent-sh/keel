// The owner's hook commands at fixed points of a session, in the shape Claude
// Code and Codex share: { "hooks": { "<Event>": [{ "matcher": "<regex>",
// "hooks": [{ "type": "command", "command", "timeout"?, "onFailure"? }] }] } }.
// The owner's file (~/.config/keel-bun/hooks.json) always runs; a
// repository's .keel/hooks.json runs only once the owner pinned exactly that
// content and the content of every file under .keel/ its commands run (a
// changed file or script runs nothing until pinned again). A pin belongs to
// the repository (its git common dir), so its worktrees keep it.
//
// What a hook can do: block a call or a prompt, send a call to the owner, add
// context for the model (with the call's result; after the prompt), keep a turn
// going (Stop). What it cannot: allow anything.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { contains, realOf } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { tacitToolCall } from "./tacit.ts";
import { configDir } from "../providers/config.ts";
import { readText } from "../core/proc.ts";

export const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact"] as const;
export type HookEvent = (typeof EVENTS)[number];
type Handler = { type: "command"; command: string; timeout?: number; onFailure?: "block" | "continue" };
type Group = { matcher?: string; hooks: Handler[] };

// `covers`: the files under .keel/ the pin covers besides hooks.json (what its commands run).
export type Source = { path: string; scope: "owner" | "project"; root: string; text: string; sha256: string; active: boolean; events: Record<string, number>; problems: string[]; covers: string[]; groups: Partial<Record<HookEvent, Group[]>> };

export const ownerHooksPath = () => process.env.KEEL_HOOKS ?? join(configDir(), "hooks.json");

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// The repository root of a folder (where .keel/ lives), else the folder.
export function projectRoot(cwd: string): string {
  for (let d = cwd; ; d = dirname(d)) {
    if (existsSync(join(d, ".git")) || existsSync(join(d, ".keel"))) return d;
    if (dirname(d) === d) return cwd;
  }
}

// The files under <root>/.keel/ that hook commands name (a script, or a folder
// of them): each named file, the rest of the folder it sits in when that is a
// folder of .keel/ (what it sources), and every file under a named folder.
const COVER_MAX = 500;
export function coveredFiles(root: string, groups: Partial<Record<HookEvent, Group[]>>): string[] {
  const keel = join(root, ".keel");
  const out = new Set<string>();
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (out.size >= COVER_MAX) return;
      const p = join(d, n);
      try { if (statSync(p).isDirectory()) walk(p); else out.add(p); } catch {}
    }
  };
  // Scripts a hook runs from .keel/ or, for hooks brought from Claude Code, from .claude/.
  for (const list of Object.values(groups)) for (const g of list ?? []) for (const h of g.hooks) {
    for (const m of h.command.matchAll(/(\.keel|\.claude)\/([\w./@+-]+)/g)) {
      const base = join(root, m[1]!);
      const p = resolve(base, m[2]!.replace(/\/+$/, ""));
      if (!contains(base, p) || p === base || p === join(keel, "hooks.json")) continue;
      let st;
      try { st = statSync(p); } catch { out.add(p); continue; } // a missing script is covered as missing
      if (st.isDirectory()) walk(p);
      else {
        out.add(p);
        if (dirname(p) !== base) walk(dirname(p));
      }
    }
  }
  out.delete(join(keel, "hooks.json"));
  return [...out].sort();
}

// The digest a pin holds: hooks.json alone when its commands run no file of
// .keel/, else with each covered file's path and content.
// `bodies`: each covered file's bytes as last read with their hash. Every
// file is read at every call; one whose bytes are the same is not decoded and
// hashed again. What is kept is replaced by what this call read.
type Bodies = Map<string, { bytes: Buffer; sha: string }>;
const BODY_MAX = 256 * 1024;
function pinDigest(text: string, root: string, files: string[], bodies?: Bodies): string {
  if (!files.length) { bodies?.clear(); return sha(text); }
  const h = new Bun.CryptoHasher("sha256").update(text);
  const read: Bodies = new Map();
  for (const f of files) {
    let body = "\u0000missing";
    try {
      const bytes = readFileSync(f);
      const was = bodies?.get(f);
      body = was && was.bytes.equals(bytes) ? was.sha : sha(bytes.toString("utf8"));
      if (bytes.length <= BODY_MAX) read.set(f, { bytes, sha: body });
    } catch {}
    // A link is pinned with where it points too, so retargeting it unpins.
    let link = "";
    try { if (lstatSync(f).isSymbolicLink()) link = `\u0000link\u0000${readlinkSync(f)}`; } catch {}
    h.update(`\u0000${relative(root, f)}${link}\u0000${body}`);
  }
  if (bodies) { bodies.clear(); for (const [f, v] of read) bodies.set(f, v); }
  return h.digest("hex");
}

// Covered files that are links landing outside .keel/ (or .claude/ for a file there): the pin does not hold
// what they run, so the file does not run.
export const linksOut = (root: string, files: string[]) => {
  const dirs = [".keel", ".claude"].map((d) => realOf(join(root, d)));
  return files.filter((f) => { try { return lstatSync(f).isSymbolicLink() && !dirs.some((d) => contains(d, realOf(f))); } catch { return false; } });
};

// What names a path's content on disk without reading it: its inode, kind,
// size and change times, and for a link also where it points and the same of
// what it lands on. A write, a replacement, a retargeted link or a file that
// came or went changes it; the change time cannot be set back. `newest`
// takes the latest of those times, in milliseconds. It does not see a change
// made through a shared memory mapping after the page was first written (the
// kernel stamps the file at the first write to a page, not at later ones), so
// nothing that guards what runs is decided by it: only the owner's own file
// is kept by its mark.
function diskMark(path: string, newest: { ms: number }): string {
  const of = (st: { ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) => {
    const ms = Number((st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs) / 1_000_000n);
    if (ms > newest.ms) newest.ms = ms;
    return `${st.ino}.${st.mode}.${st.size}.${st.mtimeNs}.${st.ctimeNs}`;
  };
  try {
    const l = lstatSync(path, { bigint: true });
    if (!l.isSymbolicLink()) return of(l);
    let to = "dangling";
    try { to = of(statSync(path, { bigint: true })); } catch {}
    return `${of(l)}>${readlinkSync(path)}>${to}`;
  } catch {
    return "missing";
  }
}

// A file changed this recently is read again at the next event whatever its
// mark says: a second write within the clock's step of the first would leave
// the same times.
const RACY_MS = 2_000;

// A repository's pins are kept for its git common dir (a worktree's are its
// main checkout's), else for the folder.
const pinKeys = new Map<string, string>();
export function pinKey(root: string): string {
  const hit = pinKeys.get(root);
  if (hit) return hit;
  // A folder that is not on this machine (a session whose folder is on another
  // one, or one removed since): the spawn itself throws there. It has no
  // repository here, so its key is the folder.
  let out = "";
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdout: "pipe", stderr: "ignore" });
    if (r.success) out = r.stdout.toString().trim();
  } catch {}
  const key = out ? (out.endsWith("/.git") ? dirname(out) : out) : root;
  pinKeys.set(root, key);
  return key;
}

export function parseHooks(text: string): { groups: Partial<Record<HookEvent, Group[]>>; problems: string[] } {
  const problems: string[] = [];
  const groups: Partial<Record<HookEvent, Group[]>> = {};
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { return { groups, problems: [`not JSON: ${(e as Error).message}`] }; }
  for (const [event, list] of Object.entries<any>(raw?.hooks ?? {})) {
    if (!(EVENTS as readonly string[]).includes(event)) { problems.push(`${event}: not an event Keel runs`); continue; }
    if (!Array.isArray(list)) { problems.push(`${event}: must be a list`); continue; }
    const out: Group[] = [];
    for (const g of list) {
      if (g?.matcher !== undefined) {
        try { new RegExp(g.matcher); } catch { problems.push(`${event}: matcher ${g.matcher} is not a regular expression`); continue; }
      }
      const hooks = (Array.isArray(g?.hooks) ? g.hooks : []).filter((h: any) => {
        if (h?.type === "command" && typeof h.command === "string" && h.command.trim()) return true;
        problems.push(`${event}: only command hooks run here (${h?.type ?? "no type"})`);
        return false;
      });
      if (hooks.length) out.push({ matcher: g.matcher, hooks });
    }
    if (out.length) groups[event as HookEvent] = out;
  }
  return { groups, problems };
}

// A tool's own name and the names other harnesses give it, for hook matchers
// and agents' disallowed tools. `via` is the tool that dispatched it (mcp_call
// runs a catalog tool by its full name; Claude Code calls that mcp__<name>).
// A tool that runs a command (a monitor of one, a program, a command on
// another machine) also answers to Bash.
export function namesOf(tool: string, input: any, via?: string): string[] {
  const out = [tool];
  const t = tacitToolCall(tool, input);
  if (t) out.push(t.tool_name);
  if (via && via !== tool) out.push(via);
  if (via === "mcp_call" && !tool.startsWith("mcp__")) out.push(`mcp__${tool}`);
  if (/^(run_code|keel__run_on)$/.test(tool) || (/^monitor$/i.test(tool) && input?.command)) out.push("Bash");
  if (/^(edit|replace|multi_edit|multiedit|apply_patch)$/i.test(tool)) out.push("Edit");
  if (/^(write|write_file)$/i.test(tool)) out.push("Write");
  return [...new Set(out)];
}

export type HookResult = { block?: string; ask?: string; context: string[]; continueWith?: string };

export class Hooks {
  constructor(private store: Store) {
    store.migrate("CREATE TABLE IF NOT EXISTS hook_pins (root TEXT NOT NULL, sha256 TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (root));");
  }

  private pinned(root: string) {
    return this.store.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM hook_pins WHERE root = ?").get(pinKey(root))?.sha256;
  }

  // The owner's file as last read, with the mark (diskMark) that named that
  // content on disk. Every hook event asks for the sources, and a file that
  // did not change is not read, parsed and hashed again: one stat says so.
  // The mark is taken before the read, so a write in between shows at the
  // next event. Only the owner's own file is kept this way: it always runs,
  // so no trust check rests on the read.
  private owner?: { path: string; mark: string; source: Omit<Source, "root"> };

  private ownerSource(root: string): Source | undefined {
    const path = ownerHooksPath();
    const newest = { ms: 0 };
    const t0 = Date.now();
    const mark = diskMark(path, newest);
    if (mark === "missing") {
      this.owner = undefined;
      if (!existsSync(path)) return undefined;
    } else if (this.owner?.path === path && this.owner.mark === mark) return { ...this.owner.source, root };
    this.owner = undefined;
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch (e) { return { path, scope: "owner", root, text: "", sha256: "", active: false, events: {}, problems: [(e as Error).message], covers: [], groups: {} }; }
    const { groups, problems } = parseHooks(text);
    const events = Object.fromEntries(Object.entries(groups).map(([e, g]) => [e, g!.reduce((n, x) => n + x.hooks.length, 0)]));
    const source = { path, scope: "owner" as const, text: text.slice(0, 20_000), sha256: sha(text), active: true, events, problems, covers: [], groups };
    // Kept only when its last change is old enough to tell from a later one (the time taken before the read).
    if (mark !== "missing" && t0 - newest.ms > this.racyMs) this.owner = { path, mark, source };
    return { ...source, root };
  }

  racyMs = RACY_MS;

  // A repository's file. Its pin is a trust check, so the decision is taken
  // from nothing an earlier event read: at every event the file, the list of
  // what it covers and every covered file are read, and the digest held
  // against the pin is of what is on disk then. Two things are spared, and
  // the decision rests on neither. A file with no pin runs nothing whatever
  // it holds, so an event (`run`) reads none of it; the listing and the pin
  // still read it all. And what was last read is kept to compare with: a
  // hooks.json with the same text is not parsed again, and a covered file
  // with the same bytes is not hashed again.
  private projects = new Map<string, { text: string; groups: Source["groups"]; problems: string[]; bodies: Bodies }>();

  private projectSource(root: string, run: boolean): Source | undefined {
    const pin = this.pinned(root);
    if (run && !pin) return undefined;
    const path = join(root, ".keel", "hooks.json");
    if (!existsSync(path)) { this.projects.delete(root); return undefined; }
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch (e) { return { path, scope: "project", root, text: "", sha256: "", active: false, events: {}, problems: [(e as Error).message], covers: [], groups: {} }; }
    let kept = this.projects.get(root);
    if (kept?.text !== text) this.projects.set(root, (kept = { text, ...parseHooks(text), bodies: new Map() }));
    const { groups } = kept;
    const problems = [...kept.problems];
    const files = coveredFiles(root, groups);
    const digest = pinDigest(text, root, files, kept.bodies);
    let active = true;
    if (!pin) { active = false; problems.unshift("not pinned: the owner reads the file and pins it before it runs"); }
    else if (pin !== digest) { active = false; problems.unshift(`changed since it was pinned${files.length ? " (the file or a script it runs)" : ""}: pin it again to run it`); }
    const links = linksOut(root, files);
    if (links.length) { active = false; problems.unshift(`${links.map((f) => relative(root, f)).join(", ")} ${links.length > 1 ? "are links" : "is a link"} out of .keel/: the pin cannot hold what ${links.length > 1 ? "they run" : "it runs"}`); }
    const events = Object.fromEntries(Object.entries(groups).map(([e, g]) => [e, g!.reduce((n, x) => n + x.hooks.length, 0)]));
    return { path, scope: "project", root, text: text.slice(0, 20_000), sha256: digest, active, events, problems, covers: files.map((f) => relative(root, f)), groups };
  }

  // `run`: for an event, which needs only what can run (a file with no pin is left out unread).
  sources(cwd: string, run = false): Source[] {
    const root = projectRoot(cwd);
    return [this.ownerSource(root), this.projectSource(root, run)].filter((s) => s !== undefined);
  }

  pin(cwd: string, digest: string): string | null {
    const project = this.sources(cwd).find((s) => s.scope === "project");
    if (!project) return "this folder has no .keel/hooks.json";
    if (project.sha256 !== digest) return "the file is no longer the one that was shown: read it again";
    this.store.db.query("INSERT INTO hook_pins (root, sha256, created) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET sha256 = excluded.sha256, created = excluded.created").run(pinKey(projectRoot(cwd)), digest, Date.now());
    return null;
  }

  // Every active handler of an event that matches, run at the same time.
  async run(event: HookEvent, s: Session, payload: Record<string, unknown>, match?: string[]): Promise<HookResult> {
    const handlers: Handler[] = [];
    for (const src of this.sources(s.workspace, true)) {
      if (!src.active) continue;
      for (const g of src.groups[event] ?? []) {
        if (match && g.matcher && g.matcher !== "*" && !match.some((n) => new RegExp(`^(?:${g.matcher})$`).test(n))) continue;
        handlers.push(...g.hooks);
      }
    }
    const res: HookResult = { context: [] };
    if (!handlers.length) return res;
    const input = JSON.stringify({ session_id: s.id, cwd: s.workspace, hook_event_name: event, model: s.model, ...payload });
    const outs = await Promise.all(handlers.map((h) => runHook(h, input, s.workspace, (h.timeout ?? (event === "UserPromptSubmit" ? 30 : 600)) * 1000)));
    for (const [i, o] of outs.entries()) {
      const h = handlers[i]!;
      const fails = (why: string) => { if (h.onFailure === "block") res.block ??= `a hook failed (${why})`; };
      if (o.code === null) { fails("it did not finish in time"); continue; }
      if (o.code === 2) { res.block ??= o.stderr.trim() || "a hook blocked this"; continue; }
      if (o.code !== 0) { fails(`exit ${o.code}`); continue; }
      const text = o.stdout.trim();
      if (!text) continue;
      let j: any;
      try { j = JSON.parse(text); } catch {
        if (event === "PreToolUse" || event === "UserPromptSubmit") { if (!text.startsWith("{")) { res.context.push(text); continue; } res.block ??= "a hook answered JSON that cannot be read"; }
        else res.context.push(text);
        continue;
      }
      const hso = j.hookSpecificOutput ?? {};
      if (j.decision === "block") {
        if (event === "Stop") res.continueWith ??= String(j.reason ?? "a hook asked to go on");
        else res.block ??= String(j.reason ?? "a hook blocked this");
      }
      if (j.continue === false && event !== "Stop") res.block ??= String(j.stopReason ?? "a hook stopped this");
      if (hso.permissionDecision === "deny") res.block ??= String(hso.permissionDecisionReason ?? "a hook denied this call");
      else if (hso.permissionDecision === "ask") res.ask ??= String(hso.permissionDecisionReason ?? "a hook asks the owner about this call");
      // "allow" is ignored: a hook cannot allow anything. A rewrite is not supported.
      if (hso.updatedInput !== undefined) res.block ??= "a hook tried to change the call's input, which Keel does not do";
      if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) res.context.push(hso.additionalContext.trim().slice(0, 10_000));
      if (typeof j.systemMessage === "string" && j.systemMessage.trim()) res.context.push(j.systemMessage.trim().slice(0, 10_000));
    }
    return res;
  }
}

async function runHook(h: Handler, input: string, cwd: string, ms: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["bash", "-c", h.command], { cwd, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", detached: true, env: { ...process.env, KEEL_PROJECT_DIR: projectRoot(cwd), CLAUDE_PROJECT_DIR: projectRoot(cwd) } });
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  }
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, ms);
  const read = (s: ReadableStream<Uint8Array> | number | undefined) => readText(s, "hook").catch(() => "");
  const [stdout, stderr, code] = await Promise.all([read(p.stdout), read(p.stderr), p.exited]);
  clearTimeout(t);
  return { code: timedOut ? null : code, stdout, stderr };
}

export const hookContext = (event: string, lines: string[]) => `<hook event="${event}">\n${lines.join("\n\n")}\n</hook>`;
