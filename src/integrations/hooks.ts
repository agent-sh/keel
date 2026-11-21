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
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { contains, realOf } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { tacitToolCall } from "./tacit.ts";
import { configDir } from "../providers/config.ts";
import { chunks, pumpText } from "../core/proc.ts";
import { hookSaid } from "../engine/hooks.ts";
import { shellText } from "../safety/policy.ts";
import { splitCommand } from "../safety/shell.ts";
import { timed } from "../admin/stall.ts";

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
// What runs for an event: a shell command (or, with `args`, a program run
// without a shell), a POST of the event to a URL, or a tool of a connected
// MCP server. A `prompt` or `agent` handler is read and not run: see parseHooks.
type Common = { timeout?: number; onFailure?: "block" | "continue"; if?: string };
type Handler =
  | (Common & { type: "command"; command: string; args?: string[] })
  | (Common & { type: "http"; url: string; headers?: Record<string, string>; allowedEnvVars?: string[] })
  | (Common & { type: "mcp_tool"; server: string; tool: string; input?: Record<string, unknown> });
// Why a handler cannot run, or nothing.
function handlerProblem(h: any): string | null {
  const text = (v: unknown) => typeof v === "string" && !!v.trim();
  switch (h?.type) {
    case "command":
      if (!text(h.command)) return "a command hook needs a command";
      return h.args === undefined || (Array.isArray(h.args) && h.args.every((a: unknown) => typeof a === "string")) ? null : "a command hook's args must be a list of strings";
    case "http":
      if (!text(h.url) || !/^https?:\/\//.test(h.url)) return "an http hook needs an http or https url";
      if (h.headers !== undefined && (!h.headers || typeof h.headers !== "object" || Object.values(h.headers).some((v) => typeof v !== "string"))) return "an http hook's headers must be strings";
      return h.allowedEnvVars === undefined || (Array.isArray(h.allowedEnvVars) && h.allowedEnvVars.every((a: unknown) => typeof a === "string")) ? null : "an http hook's allowedEnvVars must be a list of names";
    case "mcp_tool":
      if (!text(h.server) || !text(h.tool)) return "an mcp_tool hook needs a server and a tool";
      return h.input === undefined || (h.input && typeof h.input === "object" && !Array.isArray(h.input)) ? null : "an mcp_tool hook's input must be an object";
    case "prompt":
    case "agent":
      // A model asked on every event: Keel's own model checks are the judge and the reviewer, on the model the owner chose for them.
      return `${h.type} hooks are read and not run: they ask a model on every event`;
    default:
      return `no handler of type ${h?.type ?? "(none)"}`;
  }
}

// Set by the MCP module: calls a tool of a connected server for an mcp_tool
// hook. The hook file's owner chose the tool: no approval is asked and no
// other hook runs for the call.
export const hookMcp: { call?: (server: string, tool: string, input: unknown, ms: number) => Promise<{ text: string; error?: boolean }> } = {};
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
    // (A program run without a shell names its script in its arguments.)
    for (const m of (h.type === "command" ? [h.command, ...(h.args ?? [])].join(" ") : "").matchAll(/(\.keel|\.claude)\/([\w./@+-]+)/g)) {
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
    const r = timed(() => "running git rev-parse for a hooks file's repository", () => Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdout: "pipe", stderr: "ignore" }));
    if (r.success) out = r.stdout.toString().trim();
  } catch {}
  const key = out ? (out.endsWith("/.git") ? dirname(out) : out) : root;
  pinKeys.set(root, key);
  return key;
}

// `problems`: what is wrong with the file. `notes`: what loads and never runs
// here (an event Keel has no moment for, a prompt or agent handler): said in
// the file's list, and no fault of the file.
export function parseHooks(text: string): { groups: Partial<Record<HookEvent, Group[]>>; problems: string[]; notes: string[] } {
  const problems: string[] = [], notes: string[] = [];
  const groups: Partial<Record<HookEvent, Group[]>> = {};
  let raw: any;
  try { raw = JSON.parse(text); } catch (e) { return { groups, notes, problems: [`not JSON: ${(e as Error).message}`] }; }
  for (const [event, list] of Object.entries<any>(raw?.hooks ?? {})) {
    if (NOT_FIRED[event]) { notes.push(`${event}: never runs here (${NOT_FIRED[event]})`); continue; }
    if (!(EVENTS as readonly string[]).includes(event)) { problems.push(`${event}: not an event of Claude Code, Codex or Keel`); continue; }
    if (!Array.isArray(list)) { problems.push(`${event}: must be a list`); continue; }
    const out: Group[] = [];
    for (const g of list) {
      if (g?.matcher !== undefined) {
        try { new RegExp(g.matcher); } catch { problems.push(`${event}: matcher ${g.matcher} is not a regular expression`); continue; }
      }
      const hooks = (Array.isArray(g?.hooks) ? g.hooks : []).filter((h: any) => {
        const why = handlerProblem(h);
        if (why) (h?.type === "prompt" || h?.type === "agent" ? notes : problems).push(`${event}: ${why}`);
        return !why;
      });
      if (hooks.length) out.push({ matcher: g.matcher, hooks });
    }
    if (out.length) groups[event as HookEvent] = out;
  }
  return { groups, problems, notes };
}

// The files a hook file's commands name as what they run, as paths: a word of
// a command (or of its args) that is a path, with the project folder's
// placeholders, ~ and $HOME filled in, a relative one from the repository's
// root. A script in a folder of .keel/ or .claude/ stands for its whole folder
// (what it sources). Nothing is read: a script that is not there yet is named too.
export function scriptsOf(root: string, groups: Partial<Record<HookEvent, Group[]>>): string[] {
  const out = new Set<string>();
  const home = homedir();
  for (const list of Object.values(groups)) for (const g of list ?? []) for (const h of g.hooks) {
    if (h.type !== "command") continue;
    for (const raw of [h.command, ...(h.args ?? [])].join(" ").split(/[\s;|&<>()=]+/).slice(0, 200)) {
      let w = raw.replace(/["']/g, "").replace(/\$\{?(?:KEEL|CLAUDE)_PROJECT_DIR\}?/g, root).replace(/^(?:~|\$\{?HOME\}?)(?=\/|$)/, home);
      if (!w.includes("/") && !/\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/.test(w)) continue;
      if (/[$`*?]/.test(w) || w.startsWith("/dev/") || w.startsWith("-")) continue;
      w = resolve(root, w);
      // (Not a folder the repository or the home sits in: `//` in a jq filter is no script.)
      if (contains(w, root) || contains(w, home) || !/[A-Za-z0-9]/.test(basename(w))) continue;
      const held = [".keel", ".claude"].map((d) => join(root, d)).find((d) => contains(d, w) && dirname(w) !== d);
      out.add(held ? dirname(w) : w);
    }
  }
  return [...out];
}

// The most of a hooks file a Source carries. The page shows all of it, and a
// file longer than this is not pinned: the owner pins what they were shown.
export const SHOWN_MAX = 400_000;

// Where a file's hooks send what they are given, for the owner to read before
// a pin: each http hook's URL (it gets prompts, tool inputs and tool results),
// and each MCP tool a hook calls.
export function reaches(groups: Partial<Record<HookEvent, Group[]>>): { urls: string[]; tools: string[] } {
  const urls = new Set<string>(), tools = new Set<string>();
  for (const list of Object.values(groups)) for (const g of list ?? []) for (const h of g.hooks) {
    if (h.type === "http") urls.add(h.url);
    else if (h.type === "mcp_tool") tools.add(`${h.server}__${h.tool}`);
  }
  return { urls: [...urls], tools: [...tools] };
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

export type HookFailure = { hook: string; event: HookEvent; session: string; why: string };

export class Hooks {
  // `failed`: told of each hook that failed (exit 1, a command that is not there, a timeout, an http port nobody listens on).
  constructor(private store: Store, private failed?: (f: HookFailure) => void) {
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
    const source = { path, scope: "owner" as const, text: text.slice(0, SHOWN_MAX + 1), sha256: sha(text), active: true, events, problems, covers: [], groups };
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
    // Every covered file is listed, read and hashed here at each event, in
    // one piece: named, should it hold the loop (src/admin/stall.ts).
    const bodies = kept.bodies;
    const { files, digest, links } = timed(() => "reading a repository's hooks file and the files it covers", () => {
      const files = coveredFiles(root, groups);
      return { files, digest: pinDigest(text, root, files, bodies), links: linksOut(root, files) };
    });
    let active = true;
    if (!pin) { active = false; problems.unshift("not pinned: the owner reads the file and pins it before it runs"); }
    else if (pin !== digest) { active = false; problems.unshift(`changed since it was pinned${files.length ? " (the file or a script it runs)" : ""}: pin it again to run it`); }
    if (links.length) { active = false; problems.unshift(`${links.map((f) => relative(root, f)).join(", ")} ${links.length > 1 ? "are links" : "is a link"} out of .keel/: the pin cannot hold what ${links.length > 1 ? "they run" : "it runs"}`); }
    const events = Object.fromEntries(Object.entries(groups).map(([e, g]) => [e, g!.reduce((n, x) => n + x.hooks.length, 0)]));
    return { path, scope: "project", root, text: text.slice(0, SHOWN_MAX + 1), sha256: digest, active, events, problems, covers: files.map((f) => relative(root, f)), groups };
  }

  // What the folder's hook files name, from their text alone: the owner's file
  // (kept by its mark) and a repository's file that has a pin. No covered file
  // is read and no pin is checked, so nothing that runs is decided here: it
  // answers only "does any file name this event" and "which files do the hooks
  // run", both of which the full read (`sources`) then settles.
  private named = new Map<string, { text: string; files: string[] }>();
  private texts(cwd: string): { scope: "owner" | "project"; root: string; text: string; groups: Source["groups"] }[] {
    const root = projectRoot(cwd);
    const out: ReturnType<Hooks["texts"]> = [];
    const owner = this.ownerSource(root);
    if (owner) out.push({ scope: "owner", root, text: owner.sha256, groups: owner.groups });
    if (!this.pinned(root)) return out;
    let text: string;
    try { text = readFileSync(join(root, ".keel", "hooks.json"), "utf8"); } catch { return out; }
    const kept = this.projects.get(root);
    out.push({ scope: "project", root, text, groups: kept?.text === text ? kept.groups : parseHooks(text).groups });
    return out;
  }

  // Whether any hook file of the folder names one of these events (a file that names none costs no further read).
  names(cwd: string, ...events: HookEvent[]): boolean {
    return this.texts(cwd).some((t) => events.some((e) => t.groups[e]?.length));
  }

  // The files and folders the folder's hooks run things from: each script a
  // command names (scriptsOf). The pin holds those under .keel/ and .claude/;
  // one elsewhere runs as it is on disk when its hook fires, and the owner's
  // own hooks have no pin at all. The gate asks the owner before a session
  // changes any of them.
  runsFrom(cwd: string): string[] {
    const out: string[] = [];
    for (const t of this.texts(cwd)) {
      const key = `${t.scope}\u0000${t.root}`;
      let kept = this.named.get(key);
      if (kept?.text !== t.text) this.named.set(key, (kept = { text: t.text, files: scriptsOf(t.root, t.groups) }));
      out.push(...kept.files);
    }
    return out;
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
    if (project.text.length > SHOWN_MAX) return `the file is longer than Keel shows whole (${SHOWN_MAX} characters), so it cannot be pinned: you would pin hooks you were not shown`;
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
  async run(event: HookEvent, s: Session, payload: Record<string, unknown> | (() => Record<string, unknown>), match?: string[], srcs?: Source[]): Promise<HookResult> {
    const res: HookResult = { context: [], ran: 0 };
    // An event no file names reads no covered script: the events of every model request would otherwise read them all each time.
    if (!srcs && !this.names(s.workspace, event)) return res;
    srcs ??= this.sources(s.workspace, true);
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
    const outs = await Promise.all(handlers.map((h) => {
      const ms = Math.min(h.timeout ?? normal, most) * 1000;
      return h.type === "http" ? runHttp(h, input, ms) : h.type === "mcp_tool" ? runMcp(h, data, ms) : runHook(h, input, s.workspace, ms);
    }));
    let stop: string | undefined;
    // What each PreToolUse hook answered about the call's input and its allow, in file order.
    const said: { input?: Record<string, unknown>; allow?: string }[] = [];
    for (const [i, o] of outs.entries()) {
      const h = handlers[i]!;
      const refuse = (why: string) => { if (can.block) res.block ??= why; };
      // A hook that failed is said once in Errors, with what it is: a mistyped policy hook otherwise never runs and nobody is told.
      const fails = (why: string) => {
        const what = h.type === "http" ? h.url : h.type === "mcp_tool" ? `${h.server}__${h.tool}` : [h.command, ...(h.args ?? [])].join(" ");
        this.failed?.({ hook: what.slice(0, 500), event, session: s.id, why: `${why}${o.stderr.trim() ? `: ${o.stderr.trim().slice(0, 300)}` : ""}` });
        if (h.onFailure === "block") refuse(`a hook failed (${why})`);
      };
      if (o.code === null) { fails("it did not finish in time"); continue; }
      if (o.code === 2) {
        // (Not honoured on PermissionRequest, as documented: a hook denies there with its decision.)
        if (can.goOn) res.continueWith ??= hookSaid(o.stderr.trim() || "a hook asked to go on");
        else if (event !== "PermissionRequest") refuse(hookSaid(o.stderr.trim() || "a hook blocked this"));
        continue;
      }
      if (o.code !== 0) { fails(o.code === -1 ? "it could not be started" : `exit ${o.code}`); continue; }
      const text = o.stdout.trim();
      if (!text) continue;
      let j: any;
      try { j = JSON.parse(text); } catch {
        if (!text.startsWith("{")) { if (can.text) res.context.push(hookSaid(text)); }
        else if (event === "PreToolUse" || event === "UserPromptSubmit") refuse("a hook answered JSON that cannot be read");
        continue;
      }
      if (!j || typeof j !== "object") continue;
      const hso = j.hookSpecificOutput ?? {};
      if (j.decision === "block") {
        if (can.goOn) res.continueWith ??= hookSaid(j.reason ?? "a hook asked to go on");
        else refuse(hookSaid(j.reason ?? "a hook blocked this"));
      }
      if (j.continue === false) {
        if (can.goOn) stop ??= "";
        else refuse(hookSaid(j.stopReason ?? "a hook stopped this"));
      }
      if (event === "PreToolUse") {
        // The older top-level form: "approve" is "allow" ("block" is read above).
        const decision = hso.permissionDecision ?? (j.decision === "approve" ? "allow" : undefined);
        const mine: (typeof said)[number] = {};
        if (decision === "deny") res.block ??= hookSaid(hso.permissionDecisionReason ?? "a hook denied this call");
        else if (decision === "ask") res.ask ??= hookSaid(hso.permissionDecisionReason ?? "a hook asks the owner about this call");
        else if (decision === "allow") mine.allow = hookSaid(hso.permissionDecisionReason ?? j.reason ?? "");
        // A changed input replaces the whole input. One that is not an object cannot be judged: the call does not run.
        if (hso.updatedInput !== undefined && decision !== "deny") {
          if (hso.updatedInput && typeof hso.updatedInput === "object" && !Array.isArray(hso.updatedInput)) mine.input = hso.updatedInput;
          else res.block ??= "a hook answered an input for this call that is not an object";
        }
        said.push(mine);
      }
      if (event === "PermissionRequest") {
        const d = hso.decision ?? {};
        if (d.behavior === "deny") res.block ??= hookSaid(d.message ?? "a hook denied this request");
        // An allow that also changes the input or the standing rules is not taken: the owner gets the card.
        else if (d.behavior === "allow" && d.updatedInput === undefined && d.updatedPermissions === undefined) res.allow ??= "";
      }
      if (can.context) {
        if (typeof hso.additionalContext === "string" && hso.additionalContext.trim()) res.context.push(hookSaid(hso.additionalContext.trim()));
        if (typeof j.systemMessage === "string" && j.systemMessage.trim()) res.context.push(hookSaid(j.systemMessage.trim()));
      }
    }
    // The first hook in file order that changed the input wins. An allow is
    // for the input its hook saw or wrote: with a changed input, only the
    // allow of the hook whose input won counts; another hook's allow was for
    // the call as the model wrote it.
    const won = said.find((x) => x.input !== undefined);
    if (won) res.input = won.input;
    const allow = won ? won.allow : said.find((x) => x.allow !== undefined)?.allow;
    if (allow !== undefined) res.allow = allow;
    // Between hooks: a block beats an ask, and an ask beats an allow; a hook that ends the session's work beats one that sends it back.
    if (res.block || res.ask) delete res.allow;
    if (stop !== undefined) delete res.continueWith;
    return res;
  }
}

// What is kept of a hook's stdout, of its stderr and of an http hook's answer: a hook that says more has failed or is cut there.
const OUT_MAX = 1_000_000;

type Out = { code: number | null; stdout: string; stderr: string };

async function runHook(h: Extract<Handler, { type: "command" }>, input: string, folder: string, ms: number): Promise<Out> {
  const root = projectRoot(folder);
  // A session whose folder is gone, or is on another machine, still runs its hooks (one that denies must still deny): in the home folder.
  const cwd = existsSync(folder) ? folder : homedir();
  // With `args` the program runs as given, no shell: each argument is one word, and the project folder's placeholders are filled in.
  const place = (x: string) => x.replace(/\$\{(?:KEEL|CLAUDE)_PROJECT_DIR\}/g, root);
  const argv = h.args ? [place(h.command), ...h.args.map(place)] : ["bash", "-c", h.command];
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { cwd, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe", detached: true, env: { ...process.env, KEEL_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root } });
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  }
  let timedOut = false;
  const t = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, "SIGKILL"); } catch {} }, ms);
  // Read to the end, kept to a bound: a hook that prints without end fills no memory.
  const read = async (s: ReadableStream<Uint8Array> | number | undefined) => {
    let out = "";
    await pumpText(s, (t) => { if (out.length < OUT_MAX) out += t.slice(0, OUT_MAX - out.length); }, "hook").catch(() => {});
    return out;
  };
  const [stdout, stderr, code] = await Promise.all([read(p.stdout), read(p.stderr), p.exited]);
  clearTimeout(t);
  return { code: timedOut ? null : code, stdout, stderr };
}

// The event as the body of a POST. A 2xx answer with no body is a hook with
// nothing to say; with a JSON object it is the hook's answer, read like a
// command's stdout. Any other answer, status or failure is a failed hook
// (text that is not JSON never reaches the model). A header takes the value
// of an environment variable only when the hook lists it in allowedEnvVars.
async function runHttp(h: Extract<Handler, { type: "http" }>, input: string, ms: number): Promise<Out> {
  const allowed = new Set(h.allowedEnvVars ?? []);
  const fill = (v: string) => v.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => (allowed.has(a ?? b) ? process.env[a ?? b] ?? "" : ""));
  const headers: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = fill(v);
  try {
    const r = await fetch(h.url, { method: "POST", headers, body: input, signal: AbortSignal.timeout(ms), redirect: "error" });
    if (!r.ok) { await r.body?.cancel().catch(() => {}); return { code: 1, stdout: "", stderr: `the hook's server answered ${r.status}` }; }
    // The answer is read to a bound and no further (leaving the loop cancels the stream).
    let size = 0;
    const parts: Uint8Array[] = [];
    if (r.body) for await (const chunk of chunks(r.body)) {
      size += chunk.byteLength;
      if (size > OUT_MAX) return { code: 1, stdout: "", stderr: `the hook's server answered more than ${OUT_MAX} bytes` };
      parts.push(chunk);
    }
    const text = Buffer.concat(parts).toString("utf8").trim();
    if (!text) return { code: 0, stdout: "", stderr: "" };
    let j: unknown;
    try { j = JSON.parse(text); } catch {}
    return j && typeof j === "object" && !Array.isArray(j) ? { code: 0, stdout: text, stderr: "" } : { code: 1, stdout: "", stderr: "the hook's server answered something that is not a JSON object" };
  } catch (e) {
    return { code: (e as Error).name === "TimeoutError" ? null : 1, stdout: "", stderr: (e as Error).message };
  }
}

// A value of the hook's `input` with ${path} filled from the event: a
// placeholder that is the whole value keeps the type it names, one inside a
// longer text is written into it.
export function fillInput(v: unknown, data: Record<string, any>): unknown {
  const at = (path: string) => path.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), data);
  if (typeof v === "string") {
    const whole = /^\$\{([\w.]+)\}$/.exec(v);
    if (whole) return at(whole[1]!) ?? null;
    return v.replace(/\$\{([\w.]+)\}/g, (_m, p) => { const x = at(p); return x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x); });
  }
  if (Array.isArray(v)) return v.map((x) => fillInput(x, data));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillInput(x, data)]));
  return v;
}

// A tool of a connected MCP server: its text is read like a command's stdout,
// and an error answer, a missing server or a missing tool is a failed hook.
async function runMcp(h: Extract<Handler, { type: "mcp_tool" }>, data: Record<string, any>, ms: number): Promise<Out> {
  if (!hookMcp.call) return { code: 1, stdout: "", stderr: "no MCP servers here" };
  try {
    const r = await hookMcp.call(h.server, h.tool, fillInput(h.input ?? {}, data), ms);
    return r.error ? { code: 1, stdout: "", stderr: r.text.slice(0, OUT_MAX) } : { code: 0, stdout: r.text.slice(0, OUT_MAX), stderr: "" };
  } catch (e) {
    return { code: (e as Error).name === "TimeoutError" ? null : 1, stdout: "", stderr: (e as Error).message };
  }
}

// A hook's words for the model, in a frame they cannot close.
// (The joined block is filtered, not each line: two hooks' lines cannot make a tag between them.)
export const hookContext = (event: string, lines: string[]) => `<hook event="${event.replace(/[^\w, ]/g, "")}">\n${hookSaid(lines.join("\n\n"), Infinity)}\n</hook>`;
