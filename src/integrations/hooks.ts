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
// going (Stop), answer a permission request, change a call's input before it
// is judged, and allow a call:
// that answers the call's low-risk ask in the owner's place and nothing more
// (src/safety/gate.ts: no high-risk card, no never-allowed command, nothing in
// Read only or Plan).
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { contains, realOf } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { tacitToolCall } from "./tacit.ts";
import { configDir } from "../providers/config.ts";
import { readText } from "../core/proc.ts";
import { shellText } from "../safety/policy.ts";
import { splitCommand } from "../safety/shell.ts";

// The events Keel fires, the ones existing hook files use most first. What
// each carries and what its hooks can answer: README, Hooks.
export const EVENTS = [
  "SessionStart", "Stop", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "UserPromptExpansion", "PreToolUse", "StopFailure",
  "SubagentStop", "SessionEnd", "PermissionRequest", "PreCompact", "SubagentStart", "PostCompact", "Notification", "PermissionDenied",
  "PostToolBatch", "Interrupt", "PreModelRequest", "PostModelRequest",
] as const;
export type HookEvent = (typeof EVENTS)[number];

// Events Claude Code documents that Keel has no moment for. A file that names
// one loads; its hooks never run, and the file's list says why.
export const NOT_FIRED: Record<string, string> = {
  Setup: "Keel has no init or maintenance run",
  InstructionsLoaded: "instruction files are part of the system prompt Keel keeps with the session, and no hook point reads them yet",
  MessageDisplay: "the page renders the reply as it streams, with no step a hook could take part in",
  TaskCreated: "the task list is written whole by one tool: a PreToolUse hook on that tool sees it",
  TaskCompleted: "the task list is written whole by one tool: a PostToolUse hook on that tool sees it",
  TeammateIdle: "Keel has no agent teams",
  ConfigChange: "Keel reads its config files when it uses them and watches none for a session",
  CwdChanged: "a session's folder does not change while it runs: every command starts in it",
  DirectoryAdded: "no hook point where a folder is added to a session yet",
  FileChanged: "Keel watches no files for a session",
  WorktreeCreate: "Keel makes its agents' worktrees itself, and a hook does not replace that",
  WorktreeRemove: "Keel removes the worktrees it made itself",
  PreModelSwitch: "no hook point on a model switch yet",
  PostModelSwitch: "no hook point on a model switch yet",
  Elicitation: "Keel's MCP client answers no elicitation request",
  ElicitationResult: "Keel's MCP client answers no elicitation request",
};

// What an event's hooks can answer. `context`: text for the model; `text`: plain
// stdout is such text; `block`: exit code 2, decision "block" or continue false
// refuses the thing; `goOn`: they send the session back to work instead.
type Can = { context?: true; text?: true; block?: true; goOn?: true };
const CAN: Record<HookEvent, Can> = {
  SessionStart: { context: true, text: true },
  SubagentStart: { context: true, text: true },
  UserPromptSubmit: { context: true, text: true, block: true },
  UserPromptExpansion: { context: true, text: true, block: true },
  PreToolUse: { context: true, text: true, block: true },
  PostToolUse: { context: true, text: true, block: true },
  PostToolUseFailure: { context: true, text: true, block: true },
  PostToolBatch: { context: true, text: true, block: true },
  PermissionRequest: { block: true },
  Stop: { goOn: true },
  // Told only: nothing they answer changes what Keel does.
  SubagentStop: {}, StopFailure: {}, SessionEnd: {}, PermissionDenied: {}, PreCompact: {}, PostCompact: {}, Notification: {}, Interrupt: {}, PreModelRequest: {}, PostModelRequest: {},
};
// Events whose hooks get `if` (a tool and a pattern); on the others a hook with `if` never runs.
const TOOL_EVENTS = new Set<string>(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"]);
// Seconds a hook gets when it names none: [default, most it may ask for].
const TIMEOUTS: Partial<Record<HookEvent, [number, number]>> = { UserPromptSubmit: [30, 600], UserPromptExpansion: [30, 600], SessionEnd: [1.5, 60], Interrupt: [1, 3] };
type Handler = { type: "command"; command: string; timeout?: number; onFailure?: "block" | "continue"; if?: string };
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
    if (NOT_FIRED[event]) { problems.push(`${event}: never runs here (${NOT_FIRED[event]})`); continue; }
    if (!(EVENTS as readonly string[]).includes(event)) { problems.push(`${event}: not an event of Claude Code, Codex or Keel`); continue; }
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

// `allow`: a PreToolUse hook allowed the call, with its reason (a block or an
// ask from another hook wins). `input`: the input a PreToolUse hook gave the
// call in place of the model's (the first hook's, in file order).
// `allow`: a PreToolUse hook allowed the call, with its reason (a block or an
// ask from another hook wins); on PermissionRequest, a hook allowed the request.
// `input`: the input a PreToolUse hook gave the call in place of the model's
// (the first hook's, in file order). `continueWith`: a Stop hook sends the
// session back to work with these words. `ran`: how many hooks ran.
export type HookResult = { block?: string; ask?: string; allow?: string; input?: Record<string, unknown>; context: string[]; continueWith?: string; ran: number };

// A matcher against the values an event is matched on (a tool's names, a
// start's source, a compaction's trigger). As Claude Code reads it: nothing,
// "" and "*" match all; letters, digits, _ - space , | are exact alternatives;
// anything else is a regular expression, tested unanchored.
export function matches(matcher: string | undefined, values: string[] | undefined): boolean {
  if (!matcher || matcher === "*" || !values) return true;
  if (/^[\w\- ,|]*$/.test(matcher)) {
    const alts = matcher.split(/[|,]/).map((x) => x.trim());
    return values.some((v) => alts.includes(v));
  }
  let re: RegExp;
  try { re = new RegExp(matcher); } catch { return false; }
  return values.some((v) => re.test(v));
}

// A hook's `if`: one permission rule, `Tool` or `Tool(pattern)`, where * in the
// pattern stands for any text. A shell tool's pattern is tried on each command
// of the line (leading VAR=value words aside), another tool's on the file it
// names. What cannot be read runs the hook: the hook decides.
export function ifHolds(rule: string, names: string[] | undefined, input: any, cwd: string): boolean {
  const m = /^([\w.-]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m || !names) return true;
  if (!names.includes(m[1]!)) return false;
  if (m[2] === undefined || m[2] === "*" || m[2] === "") return true;
  // (`npm run:*`, the older way to write a prefix, is `npm run *`.)
  const glob = new RegExp(`^${m[2].replace(/:\*$/, " *").split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
  const command = shellText(input);
  if (command !== null) {
    const parts = splitCommand(command);
    if (!parts) return true;
    return parts.some((p) => glob.test(p.text.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, "")) || glob.test(p.words.join(" ")));
  }
  const path = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (typeof path !== "string") return true;
  const full = resolve(cwd, path);
  return [path, full, relative(cwd, full), basename(full)].some((x) => glob.test(x));
}

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

  // The events a folder's active hook files have hooks for.
  events(cwd: string, srcs = this.sources(cwd, true)): Set<HookEvent> {
    const out = new Set<HookEvent>();
    for (const src of srcs) if (src.active) for (const e of Object.keys(src.groups) as HookEvent[]) out.add(e);
    return out;
  }

  // Every active handler of an event that matches, run at the same time.
  // `payload` is made only when a handler runs. `match`: the values the
  // event's matcher is tested on (none: the event takes no matcher).
  async run(event: HookEvent, s: Session, payload: Record<string, unknown> | (() => Record<string, unknown>), match?: string[], srcs = this.sources(s.workspace, true)): Promise<HookResult> {
    const res: HookResult = { context: [], ran: 0 };
    const groups: Group[] = [];
    for (const src of srcs) if (src.active) for (const g of src.groups[event] ?? []) if (matches(g.matcher, match)) groups.push(g);
    if (!groups.length) return res;
    const data = { session_id: s.id, transcript_path: null, cwd: s.workspace, hook_event_name: event, model: s.model, ...(typeof payload === "function" ? payload() : payload) } as Record<string, any>;
    const handlers = groups.flatMap((g) => g.hooks).filter((h) => h.if === undefined || (TOOL_EVENTS.has(event) && ifHolds(h.if, match, data.tool_input, s.workspace)));
    if (!handlers.length) return res;
    res.ran = handlers.length;
    const can = CAN[event];
    const input = JSON.stringify(data);
    const [normal, most] = TIMEOUTS[event] ?? [600, 3600];
    const outs = await Promise.all(handlers.map((h) => runHook(h, input, s.workspace, Math.min(h.timeout ?? normal, most) * 1000)));
    let stop: string | undefined;
    for (const [i, o] of outs.entries()) {
      const h = handlers[i]!;
      const refuse = (why: string) => { if (can.block) res.block ??= why; };
      const fails = (why: string) => { if (h.onFailure === "block") refuse(`a hook failed (${why})`); };
      if (o.code === null) { fails("it did not finish in time"); continue; }
      if (o.code === 2) {
        if (can.goOn) res.continueWith ??= o.stderr.trim() || "a hook asked to go on";
        else refuse(o.stderr.trim() || "a hook blocked this");
        continue;
      }
      if (o.code !== 0) { fails(`exit ${o.code}`); continue; }
      const text = o.stdout.trim();
      if (!text) continue;
      let j: any;
      try { j = JSON.parse(text); } catch {
        if (!text.startsWith("{")) { if (can.text) res.context.push(text.slice(0, 10_000)); }
        else if (event === "PreToolUse" || event === "UserPromptSubmit") refuse("a hook answered JSON that cannot be read");
        continue;
      }
      if (!j || typeof j !== "object") continue;
      const hso = j.hookSpecificOutput ?? {};
      if (j.decision === "block") {
        if (can.goOn) res.continueWith ??= String(j.reason ?? "a hook asked to go on");
        else refuse(String(j.reason ?? "a hook blocked this"));
      }
      if (j.continue === false) {
        if (can.goOn) stop ??= String(j.stopReason ?? "");
        else refuse(String(j.stopReason ?? "a hook stopped this"));
      }
      if (event === "PreToolUse") {
        // The older top-level form: "approve" is "allow" ("block" is read above).
        const decision = hso.permissionDecision ?? (j.decision === "approve" ? "allow" : undefined);
        if (decision === "deny") res.block ??= String(hso.permissionDecisionReason ?? "a hook denied this call");
        else if (decision === "ask") res.ask ??= String(hso.permissionDecisionReason ?? "a hook asks the owner about this call");
        else if (decision === "allow") res.allow ??= String(hso.permissionDecisionReason ?? j.reason ?? "");
        // A changed input replaces the whole input. One that is not an object cannot be judged: the call does not run.
        if (hso.updatedInput !== undefined && decision !== "deny") {
          if (hso.updatedInput && typeof hso.updatedInput === "object" && !Array.isArray(hso.updatedInput)) res.input ??= hso.updatedInput;
          else res.block ??= "a hook answered an input for this call that is not an object";
        }
      }
      if (event === "PermissionRequest") {
        const d = hso.decision ?? {};
        if (d.behavior === "deny") res.block ??= String(d.message ?? "a hook denied this request");
        // An allow that also changes the input or the standing rules is not taken: the owner gets the card.
        else if (d.behavior === "allow" && d.updatedInput === undefined && d.updatedPermissions === undefined) res.allow ??= "";
      }
      if (can.context) {
        if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) res.context.push(hso.additionalContext.trim().slice(0, 10_000));
        if (typeof j.systemMessage === "string" && j.systemMessage.trim()) res.context.push(j.systemMessage.trim().slice(0, 10_000));
      }
    }
    // Between hooks: a block beats an ask, and an ask beats an allow; a hook that ends the session's work beats one that sends it back.
    if (res.block || res.ask) delete res.allow;
    if (stop !== undefined) delete res.continueWith;
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
