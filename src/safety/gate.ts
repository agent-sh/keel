// The permission gate: every tool call passes its session's mode and the
// standing answers; what they do not settle becomes an approval card the
// turn waits on. Cards, grants and modes are stored. A card a restart left
// open (a crash, a kill, a stop) stays open: the continued turn runs its call
// again and waits on the same card, and an answer given before that is kept.
import { heldFile } from "../core/store-files.ts";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { lstat, readdir } from "node:fs/promises";
import type { Bus } from "../core/bus.ts";
import { locate } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolAuthorization, ToolCall, ToolGate } from "../engine/hooks.ts";
import { preAllow } from "./autonomy.ts";
import { fitsAsPlace, namedPlaces, ownFacts, placeOf as ownPlaceOf, settleOwn, shapeOf, type OwnPlace } from "./own-places.ts";
import { lookRepo, readRepo, repoContext } from "./repofacts.ts";
import { looking, type Looked } from "./looked.ts";
import { confine } from "./sandbox.ts";
import { detect, placeholdersIn, vault } from "./secrets.ts";
import { realPrograms } from "./shims.ts";
import { readOnlyCommand, shimmedPrograms, splitCommand } from "./shell.ts";
import { checkoutsOf, report, watch, type Watch } from "./refwatch.ts";
import { guardEnv } from "./ref-guard.ts";
import { setCallEnv } from "../tools/jobs.ts";
import type { Shared } from "./shared-branches.ts";
import { configDir } from "../providers/config.ts";
import { artifactsDir, atCwd, contains, realOf } from "../core/paths.ts";
import { applyEdit, fileId, noteJudged, noteLook } from "../tools/files.ts";
import { SUMMARY_LIMIT, shownInPart } from "./summary.ts";
import { agoSaid, cardForm, refusal, whereSaid, type AnsweredBy, type CardForm, type Hold } from "./card.ts";
import { AddressBook, addressOf, dataIn, groupOf, sendShown, wholeOf, type WebUse } from "./addresses.ts";
import { ownerPrompt, PEER_PREFIX } from "../core/owner.ts";
import { classify, decide, isMode, ownPath, pathsNamed, readPaths, programEntries, programRules, shellText, wordsNaming, type Ask, type CallClass, type Decision, type Mode, type Rule, type RuleKind, type Suggest } from "./policy.ts";
import { timed } from "../admin/stall.ts";
import { ownerDenial } from "../core/stops.ts";
// What a card a hook asked for says before the hook's reason.
export const HOOK_ASKS = "A hook of yours asks";
import { landing, type MarkArgs } from "./marks.ts";
import { readOptsFor } from "./sandbox-config.ts";
import { bindable, globBase, judgeWrite, ownerOpens, refusedWrites, scopes, shellWrites, type Base } from "./write-scope.ts";
import { overlays, ownFolders, sandboxScope, shownTo, storeOf, type ReadOpts } from "./sandbox-view.ts";

// Whether a file is, by its inode, one of the files Keel keeps at the top of its state or config folders (and one
// level into the config): asked only of a file that has more than one name.
function keelInode(path: string): "state" | "config" | null {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.nlink < 2) return null;
  if (heldFile(path)) return "state";
  const same = (f: string) => { try { const o = statSync(f); return o.isFile() && o.ino === st.ino && o.dev === st.dev; } catch { return false; } };
  const [state, config] = ownFolders() as [string, string];
  for (const [dir, deep] of [[state, false], [config, true]] as const) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names.slice(0, 500)) {
      const f = join(dir, n);
      if (same(f)) return dir === state ? "state" : "config";
      if (!deep) continue;
      let inner: string[] = [];
      try { inner = statSync(f).isDirectory() ? readdirSync(f) : []; } catch {} // not a folder
      if (inner.slice(0, 200).some((m) => same(join(f, m)))) return "config";
    }
  }
  return null;
}

// Whether a file has another name somewhere: a write to it lands there too. (The store's own files, by inode, are such.)
const hardLink = (path: string): boolean => {
  try { const st = lstatSync(path); return (st.isFile() && st.nlink > 1) || !!heldFile(path); } catch { return false; }
};
import { attachmentsGiven } from "../engine/attachments.ts";

// (Where an edit lands is read in marks.ts, which the read thread loads too.)
export { landing };
export type { CallMark } from "./marks.ts";

// The folders of a PATH that commands are found in by name and that lie
// inside a session's folder: a whole path there, or a relative entry (bash
// reads it from the folder a command runs in, so any folder of the workspace
// that ends with it). An entry that is the running folder itself ("." or an
// empty one) names every folder and is not a folder to guard: left out.
export function workspaceBins(path: string, workspace: string): string[] {
  const out = new Set<string>();
  for (const e of path.split(":")) {
    if (isAbsolute(e)) { const r = realOf(e); if (contains(workspace, r)) out.add(r); continue; }
    const rel = normalize(e).replace(/\/+$/, "");
    if (rel && rel !== "." && !rel.startsWith("..")) out.add(rel);
  }
  return [...out];
}

// What a call does, its relative paths resolved where the tool resolves them.
const cwdOf = (call: ToolCall) => call.tool.cwdOf?.(call.ctx, call.input);

// The tools that reach the web by themselves, outside any sandbox: a web
// fetch takes a method and a body, so it can send as well as read. A session
// whose network is off gets none of them (the readers only for local files).
// `name` is the tool's own; mcp_call is judged by the tool it calls.
const WEB_TOOLS = new Set(["webfetch", "websearch", "web_fetch", "web_search", "google_web_search"]);
export function webRefusal(name: string, input: any): string | null {
  const inner = name === "mcp_call" ? String(input?.tool ?? "") : name;
  const bare = inner.replace(/^mcp__/, "").split("__").pop()!.toLowerCase();
  if (WEB_TOOLS.has(bare)) return `Refused: this session has no network, and ${inner} reaches the web. Work from the files you have.`;
  if (inner === "AskReaders" && Array.isArray(input?.urls) && input.urls.length) return "Refused: this session has no network, and AskReaders fetches the urls it is given. Ask about local files (paths) only.";
  return null;
}
export const classifyCall = (call: ToolCall): CallClass => classify(call.tool, call.input, cwdOf(call) ?? call.ctx.cwd);

export type SandboxProfile = "off" | "workspace-write" | "read-only";
export type SessionPerm = { session_id: string; mode: Mode; sandbox: SandboxProfile; network: boolean };

export type Approval = {
  id: string;
  session_id: string;
  call_id: string;
  tool: string;
  kind: Exclude<CallClass["kind"], "control">;
  summary: string;      // the command, or the paths, or the tool's input in short
  cut?: true;           // the summary is only the start of the input: the card says so, and it is answered alone
  input: any;
  input_sha?: string;   // sha256 of the whole input the card was opened for, as stored (secrets out): `input` is only its start when it is long
  input_len?: number;   // how long that whole input was, when `input` holds only its start
  // Where a command starts and what reads it, as the gate judged it: the folder
  // when it is not the session's own (a workdir, or where the session's shell
  // has moved to), `away` when it is not under the session's folder either,
  // and the shell when it is not the default one.
  // `sub`: the folder as a path under the session's own, when it is one.
  at?: { cwd?: string; sub?: string; shell?: string; away?: true };
  rule?: string;        // the class of the rule that asked, in the policy's few words (its `Ask.rule`)
  risk: "high" | "low";
  why?: string;         // why only "once" is offered
  notice?: string;      // why the owner is asked (the reviewer could not judge it)
  suggest: Suggest[];   // the grant "allow always" would store
  once?: boolean;       // only the owner answers it (a hook asked)
  autoOwner?: true;     // Auto only: no judge, rule change or recovery grants this card
  bind?: string;        // the source a tool grant is for
  state: "pending" | "allowed" | "denied" | "cancelled";
  choice?: "once" | "session" | "always" | "deny";
  reason?: string;
  by?: AnsweredBy;      // who answered it: the kind of client, its name, whether it said it showed the whole text
  created: number;
  resolved?: number;
};

export type BatchResult = { id: string; ok: true } | { id: string; error: string; status: number; state?: Approval["state"] };
// `seen`: the client's word that it showed the whole text before the answer (card.ts: refusal). `by`: who answers.
export type Choice = { choice: "once" | "session" | "always" | "deny"; reason?: string; rules?: Suggest[]; seen?: "whole"; by?: Omit<AnsweredBy, "seen"> };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perm_sessions (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, sandbox TEXT NOT NULL DEFAULT 'off', network INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS perm_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL, scope TEXT NOT NULL, lifetime TEXT NOT NULL, session_id TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS approvals_session ON approvals(session_id, created);
CREATE TABLE IF NOT EXISTS perm_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perm_blocked (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS perm_blocked_session ON perm_blocked(session_id, created);
CREATE TABLE IF NOT EXISTS judge_verdicts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, created INTEGER NOT NULL, by TEXT NOT NULL, decision TEXT NOT NULL, class TEXT NOT NULL, place TEXT NOT NULL, risk TEXT, model TEXT, tool TEXT NOT NULL, shape TEXT NOT NULL, blocked_id TEXT, overridden INTEGER, override TEXT);
CREATE INDEX IF NOT EXISTS judge_verdicts_created ON judge_verdicts(created);
CREATE INDEX IF NOT EXISTS judge_verdicts_shape ON judge_verdicts(session_id, shape);
CREATE INDEX IF NOT EXISTS judge_verdicts_blocked ON judge_verdicts(blocked_id) WHERE blocked_id IS NOT NULL;
`;

// What the judge is asked (reviewer mode's calls, and full auto's high-risk
// ones with `high`: why the rules flagged it and the facts of where it lands),
// and what it answers.
export const REVIEW_SUMMARY_LIMIT = 4000;
export const REVIEW_INPUT_LIMIT = 2000;
// `own`: the session's own folders as the judge reads them (own-places.ts); `settled`: what Keel's facts settled of
// why the rules flagged the call, when it is judged as an ordinary call after that.
export type ReviewAsk = { session: Session; tool: string; kind: string; summary: string; input: any; mode?: "auto"; cwd?: string; interpreter?: string; high?: { why: string; facts?: string }; own?: string; settled?: string };
export type Verdict = { allow: boolean; risk: string; reason: string; model: string; ms?: number } | { unavailable: string };
// A call refused without the owner (the judge's refusal, a judge that could
// not answer, a repeat); the owner can let one retry of it through.
// `by`: who refused it; `count`: how often this exact call was refused.
export type Blocked = {
  id: string; session_id: string; calls?: string[]; tool: string; summary: string; reason: string; risk: string; model: string; key: string;
  by?: "reviewer" | "judge" | "unavailable" | "streak" | "rule"; count?: number; retry?: boolean; created: number; last?: number;
};
// One verdict on a call without the owner: the judge's (Auto, Reviewer) or Keel's rules' (a discard settled by its
// facts). `class`: what the rules flagged it for (a RiskRule), or "ordinary"; `place`: whether what it changes is
// in the session's own folders; `shape`: the call with what changes between runs folded (own-places.ts shapeOf).
export type VerdictRow = { session_id: string; by: "judge" | "reviewer" | "rule"; decision: "allow" | "deny"; class: string; place: "own" | "outside" | "unknown"; risk?: string; model?: string; tool: string; shape: string; blocked_id?: string };
// How long after a refusal an owner's allow of the same call counts as taking it back.
export const OVERRIDE_DAYS = 7;
// How long a verdict is kept.
export const VERDICT_DAYS = 90;
// How a full-auto high-risk call was settled, for the activity list and alerts.
export type Judged = { session_id: string; call_id: string; tool: string; summary: string; outcome: "rule" | "judge" | "retry" | "refused" | "repeat" | "unavailable" | "streak" | "unreviewed"; reason: string; model?: string; ms?: number; blocked_id?: string };

// Refusals in a row in one turn after which the rest of its high-risk calls
// are refused without review (Claude Code falls back after 3 in a row, Codex
// stops the turn after 3): the work goes on, the loop of retries does not.
export const STREAK = 3;

type Waiter = { resolve: (d: { allow: true } | { deny: string }) => void; call: ToolCall; cls: CallClass; session: Session; name: string; once?: boolean; bind?: string; facts?: CallFacts };
// What the gate looked up for one call before it decided (the policy itself reads no disk): whether a program's
// name is the program itself, and what this machine's disk says of the paths a command names (looked.ts). A card
// that waits is judged again with the same answers. `settles`: every reason the call is high risk is one of git's
// own forms, which the full-auto rules can settle.
// `own`: in Auto, the session's own folders (own-places.ts): the ones its parent's task or the owner named are read as
// its scratch, and the judge is told all of them.
type CallFacts = { real?: (program: string) => boolean; looked?: Looked; settles?: boolean; own?: OwnPlace[] };
const FROM_PARENT = "Message from the session that started you:\n";
type Target = Awaited<ReturnType<NonNullable<ToolCall["tool"]["target"]>>>;
type AutoReview = { ask: Ask; cwd?: string; input: unknown; interpreter?: string; valid: () => Promise<boolean> };
type AutoShell = { path: string; identity: string; interpreter: string };
type CheckResult = { deny: string } | { cls: CallClass; authorization?: ToolAuthorization };
const interruptedApproval = "The earlier approval cannot be used under Auto. Check the prior outcome before proposing the action again.";
const changedReview = { deny: "Refused: authorization or the action changed while permission was pending. Check the current permissions before proposing it again." };
const secretReview = { deny: "Refused: Auto cannot review an action that contains a secret or requires secret substitution. Use Ask to approve the action yourself." };

// Whether a folder is part of a git checkout or holds one: a `.git` in it or above it, or one in the folders below it
// (three levels, at most 2,000 entries looked at; more than that counts as holding one). Off the loop.
// `top`: where the look upward stops (a test's own folder); by default the root.
export async function checkoutAt(dir: string, top = "/"): Promise<boolean> {
  const there = (p: string) => lstat(p).then(() => true, () => false);
  for (let d = dir; ; d = dirname(d)) {
    if (await there(join(d, ".git"))) return true;
    if (d === top || dirname(d) === d) break;
  }
  let seen = 0;
  const walk = async (d: string, depth: number): Promise<boolean> => {
    let entries: import("node:fs").Dirent[];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (++seen > 2_000) return true;
      if (e.name === ".git") return true;
      if (depth < 3 && e.isDirectory() && !e.isSymbolicLink() && e.name !== "node_modules" && await walk(join(d, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 1);
}

function hasSecret(input: unknown, values: string[]): boolean {
  if (typeof input === "string") return !!(placeholdersIn(input).length || values.some((v) => input.includes(v)) || detect(input).length);
  if (!input || typeof input !== "object") return false;
  return Object.entries(input).some(([k, v]) => hasSecret(k, values) || hasSecret(v, values));
}

// Keel's own config: the folder, and a hooks or MCP file the daemon was pointed at elsewhere.
const ownConfig = () => [configDir(), process.env.KEEL_HOOKS, process.env.KEEL_MCP_CONFIG, process.env.KEEL_ACP_AGENTS, process.env.KEEL_ACP_FOLDERS].filter((x): x is string => !!x).map((x) => realOf(x));
// The hash a card keeps of the whole input it was opened for (the card itself holds a clipped copy).
const inputSha = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input ?? {}) ?? "").digest("hex");

function callClass(call: ToolCall, target: Target): CallClass {
  // (A reading tool known only by its flag, an MCP server's among them, is a read of the files its input names.)
  // Its path keys, and every string anywhere in the input that is a path or a file: URL by itself.
  const reads = (input: unknown): CallClass => { const paths = [...new Set([...readPaths(input, cwdOf(call) ?? call.ctx.cwd), ...pathsNamed(input).map((p) => atCwd(call.ctx.cwd, p.replace(/^~(?=\/|$)/, homedir())))])]; return paths.length ? { kind: "read", paths } : { kind: "read", unnamed: true }; };
  const cls = target ? target.cls ?? (target.readOnly ? reads(target.input) : { kind: "other" }) : classifyCall(call);
  // A tool the gate knows only by name is given the paths its input names (an MCP file server's write).
  if (cls.kind === "other" && !cls.paths) {
    const paths = pathsNamed(target ? target.input : call.input);
    if (paths.length) return { ...cls, paths };
  }
  const landed = entriesChanged(landing(cls.kind === "shell" && !cls.cwd ? { ...cls, cwd: cwdOf(call) } : cls), target ? undefined : call.input);
  // The file each named path is at this look (what the tool's open is later compared with: src/tools/files.ts hold).
  // One look for everything the call is judged by: the file itself, and whether it has another name (hardLink).
  if ((landed.kind === "edit" || landed.kind === "read" || landed.kind === "other") && landed.paths?.length) lookedAt.set(landed, landed.paths.map(look));
  return landed;
}
const lookedAt = new WeakMap<object, { path: string; id: string | null; linked: boolean }[]>();
// (One stat for both answers: two would be two moments.)
function look(path: string): { path: string; id: string | null; linked: boolean } {
  let seen: { path: string; id: string | null; linked: boolean };
  try {
    const st = lstatSync(path);
    seen = { path, id: `${st.dev}:${st.ino}`, linked: (st.isFile() && st.nlink > 1) || !!heldFile(path) };
  } catch {
    seen = { path, id: null, linked: !!heldFile(path) };
  }
  // (Kept a moment by path: a caller that holds the file without this look beside it is held to it all the same.)
  noteLook(path, seen.id);
  return seen;
}

// An edit of a file that can name a program (policy.ts NAMES_PROGRAM), read
// against the file as it is: the entry it changes may be one the file already
// holds, with none of the entry's own words in the edit (the name inside a
// plugins entry, the path after pythonPath). The edit is marked when the
// entries after it are not the entries before it. Where what the file will
// hold cannot be worked out here (a patch, another server's tool), it is
// marked when any file it names holds such an entry now.
const ENTRY_FILE_MAX = 1024 * 1024;
function entriesChanged(c: CallClass, input: any): CallClass {
  if (c.kind !== "edit") return c;
  const rules = new Set(c.paths.flatMap(programRules));
  if (!rules.size) return c;
  const read = (p: string): string | null => {
    try { const st = statSync(p); return st.isFile() && st.size <= ENTRY_FILE_MAX && !heldFile(p) ? readFileSync(p, "utf8") : null; } catch (e: any) { return e?.code === "ENOENT" ? "" : null; }
  };
  const texts = new Map(c.paths.map((p) => [p, read(p)]));
  const names = new Set(c.names ?? []);
  const whole = typeof input?.content === "string", swap = typeof input?.old_string === "string" && typeof input?.new_string === "string";
  for (const id of rules) {
    if (!whole && !swap) {
      // Unreadable or too large to read here counts as holding one.
      if ([...texts.values()].some((t) => t === null || wordsNaming(t).includes(id))) names.add(id);
      continue;
    }
    for (const p of c.paths) {
      if (!programRules(p).includes(id)) continue;
      const before = texts.get(p);
      if (before == null) { names.add(id); continue; }
      let after: string;
      if (whole) after = input.content;
      else if (before === "" || input.old_string === "") after = input.new_string;
      else { const r = applyEdit(before, input.old_string, input.new_string, !!(input.replace_all ?? input.allow_multiple)); if ("error" in r) continue; after = r.text; }
      if (programEntries(id, before).join("\n") !== programEntries(id, after).join("\n")) names.add(id);
    }
  }
  return names.size === (c.names?.length ?? 0) ? c : { ...c, names: [...names] };
}

// Auto reviews shell calls only when the actual starting directory is known.
// A retry is not transferable to a different directory or replacement inode.
function localShellDir(session: Session, call: ToolCall, target: Target, cls: CallClass) {
  if (cls.kind !== "shell" || session.machine || (!target?.cls && !call.tool.cwdOf) || !cls.cwd) return;
  try {
    const path = realpathSync(cls.cwd);
    const st = statSync(path, { bigint: true });
    if (st.isDirectory()) return { path, identity: `${st.dev}:${st.ino}` };
  } catch {}
}

export class Gate {
  private lastCard = 0; // when the newest card was made
  private waiting = new Map<string, Waiter>();
  private asking = new Map<string, Promise<void>>(); // per session: the last call still at its decision (see `checked`)
  private checking = new Map<string, CallFacts>(); // the facts of the calls being checked now, by session and call
  private roots = new Map<string, string>();
  private allowedCalls = new Set<string>();
  private retries = new Set<string>(); // session + call key: one retry the owner let through
  private streak = new Map<string, number>(); // refusals in a row in the session's turn
  private reviewVersion = 0;

  private invalidateReview() {
    this.reviewVersion++;
  }
  // Cards a restart left open, by session and call: nothing waits on them
  // until the continued turn runs the call again (park, reattach).
  private parked = new Map<string, string>();
  // Sessions whose turn the daemon is parking for a stop: their cards stay open.
  private parking = new Set<string>();
  // Reviewer mode's judge (set by the permission routes, which hold the providers).
  judge: (a: ReviewAsk) => Promise<Verdict> = async () => ({ unavailable: "no reviewer is set up" });
  // What a tool of any family does on the web, by its name (set by the permission routes, which see the tools):
  // how a stored call is read for the addresses a session has seen (src/safety/addresses.ts).
  webUse: (name: string, dispatched?: boolean) => WebUse | undefined = () => undefined;
  // The addresses each session has seen, read from its events as they come (one book a session, kept while the daemon runs).
  private books = new Map<string, AddressBook>();

  // What a session has seen of the web: whether it has seen an address (in its own events or a parent session's: the
  // owner's words reach an agent through its parent) and what an unseen one carries. Each book reads only the
  // events after the last it read.
  private async seen(session: Session): Promise<{ has(address: string): boolean; carries(address: string, earlier?: number): string | null }> {
    const chain: string[] = [session.id];
    for (let up = session, n = 0; up.parent_id && n < 32; n++) { chain.push(up.parent_id); up = this.store.session(up.parent_id) ?? up; }
    const books: AddressBook[] = [];
    // The root first: a book asks the books above it whether the owner wrote an address (src/safety/addresses.ts, `above`).
    for (const id of [...chain].reverse()) {
      let b = this.books.get(id);
      if (!b) {
        if (this.books.size >= 1024) this.books.delete(this.books.keys().next().value!);
        this.books.set(id, (b = new AddressBook((name, input) => this.webCall(name, input), ownerPrompt, (a) => this.ownerWrote(id, a))));
      }
      // A session not in memory is brought in, and the bodies of the events this book has not read are read, off the
      // loop (a long session's first read would otherwise read them a run at a time on it).
      if (this.store.session(id)) await this.store.warmBodies(id, b.seq + 1);
      const book = b;
      timed(() => `reading the web addresses session ${id} has seen`, () => book.take(this.store.events(id, book.seq)));
      books.push(b);
    }
    // A secret in a path: a known value or one shaped like a key (nothing is added to the vault), or a placeholder.
    const secret = (text: string) => placeholdersIn(text).length > 0 || detect(text).length > 0 || vault.pairs().some(([v]) => v.length >= 8 && text.includes(v));
    return {
      has: (address) => books.some((b) => b.has(address)),
      // `earlier`: the unseen addresses on its registered domain that the call being judged fetches before it.
      carries: (address, earlier = 0) => timed(() => "reading an unseen address for the data it carries", () =>
        dataIn(address, (f) => books.some((b) => b.inResults(f)), secret, earlier + books.reduce((n, b) => n + b.unseenOn(address), 0), (host, path) => { const owner = books.some((b) => b.ownsHost(host)); return books.reduce((n, b) => Math.max(n, b.listed(host, path, owner)), 0); })),
    };
  }
  // Whether the owner wrote an address in a prompt of a session above this one.
  private ownerWrote(id: string, address: string): boolean {
    for (let up = this.store.session(id)?.parent_id, n = 0; up && n < 32; n++) {
      if (this.books.get(up)?.ownedHas(address)) return true;
      up = this.store.session(up)?.parent_id;
    }
    return false;
  }
  // A stored call as the web tool it is: a dispatcher's call (mcp_call) is its tool's.
  private webCall(name: string, input: any): { use: WebUse; input: any } | undefined {
    if (name === "mcp_call") {
      const use = this.webUse(String(input?.tool ?? ""), true);
      return use ? { use, input: input?.arguments ?? {} } : undefined;
    }
    const use = this.webUse(name);
    return use ? { use, input: input ?? {} } : undefined;
  }

  constructor(private store: Store, private bus: Bus, private sandboxed: (s: Session, p: SessionPerm) => boolean = () => false) {
    store.migrate(SCHEMA);
    store.migrate("CREATE TABLE IF NOT EXISTS session_roots (session_id TEXT NOT NULL, workspace TEXT NOT NULL, real TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (session_id, workspace))");
    // (Pinned when the session is made; one made before this was here, at its first sight.)
    store.onCreated((s) => void this.rootMoved(s));
    if (!store.columnExists("perm_rules", "bind")) store.migrate("ALTER TABLE perm_rules ADD COLUMN bind TEXT");
    const db = store.db;
    // Restart: an open card waits for its call to come back (callOutcome "waiting").
    for (const r of db.query<{ data: string }, []>("SELECT data FROM approvals WHERE state = 'pending'").all()) {
      const a = JSON.parse(r.data) as Approval;
      this.parked.set(callKey(a.session_id, a.call_id), a.id);
    }
  }

  // The daemon stops: this session's turn is parked, and the card it waits on stays open.
  park(sessionId: string) {
    this.parking.add(sessionId);
  }

  // What a call's card recorded, for a call a restart cut before its result
  // was stored: a card that is still open (or answered since) waits for the
  // call to run again; a denial as the model got it; a card that was closed
  // unanswered (it never ran). An allowed call, or one without a card, may have run.
  callOutcome(sessionId: string, callId: string): { denied: string } | "not_run" | "waiting" | undefined {
    if (this.parked.has(callKey(sessionId, callId))) return "waiting";
    const r = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM approvals WHERE session_id = ? AND json_extract(data, '$.call_id') = ? ORDER BY created DESC LIMIT 1").get(sessionId, callId);
    const a = r ? (JSON.parse(r.data) as Approval) : undefined;
    if (a?.state === "cancelled") return "not_run";
    if (a?.state === "denied") return { denied: a.choice === "deny" ? ownerDenial(a.reason) : a.reason ?? ownerDenial() };
    return undefined;
  }

  // Whether this call waits on an open card right now.
  awaitsOwner(sessionId: string, callId: string): boolean {
    for (const w of this.waiting.values()) if (w.session.id === sessionId && w.call.id === callId) return true;
    return false;
  }

  setSandboxCheck(f: (s: Session, p: SessionPerm) => boolean) {
    this.invalidateReview();
    this.sandboxed = f;
  }

  // Settings: the mode a new session starts in.
  defaultMode(): Mode {
    const v = this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get("default_mode")?.value;
    const env = process.env.KEEL_PERMISSION_MODE;
    return isMode(v) ? v : isMode(env) ? env : "ask";
  }
  setDefaultMode(m: Mode) {
    if (m !== this.defaultMode()) {
      this.invalidateReview();
      this.streak.clear();
    }
    this.store.db.query("INSERT INTO perm_settings (key, value) VALUES ('default_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(m);
  }
  defaultSandbox(): SandboxProfile {
    const v = this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get("default_sandbox")?.value ?? process.env.KEEL_SANDBOX;
    return v === "workspace-write" || v === "read-only" ? v : "off";
  }
  setDefaultSandbox(p: SandboxProfile) {
    if (p !== this.defaultSandbox()) this.invalidateReview();
    this.store.db.query("INSERT INTO perm_settings (key, value) VALUES ('default_sandbox', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(p);
  }

  setting(key: string): string | undefined {
    return this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get(key)?.value;
  }
  setSetting(key: string, value: string | null) {
    if ((key === "reviewer_model" || key === "reviewer_policy") && (value || undefined) !== this.setting(key)) this.invalidateReview();
    if (value) this.store.db.query("INSERT INTO perm_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    else this.store.db.query("DELETE FROM perm_settings WHERE key = ?").run(key);
  }

  blocked(sessionId: string): Blocked[] {
    return this.store.db.query<{ data: string }, [string]>("SELECT data FROM perm_blocked WHERE session_id = ? ORDER BY created DESC LIMIT 50").all(sessionId).map((r) => JSON.parse(r.data));
  }
  // The owner lets one retry of exactly that refused call through.
  allowRetry(sessionId: string, id: string): Blocked | null {
    const r = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM perm_blocked WHERE id = ? AND session_id = ?").get(id, sessionId);
    if (!r) return null;
    const prev = JSON.parse(r.data) as Blocked;
    // Spent once: an id that already let its retry through (used or not)
    // never grants another, so replaying an old one cannot rearm it.
    if (prev.retry) return prev;
    const b: Blocked = { ...prev, retry: true };
    this.retries.add(`${sessionId}\u0000${b.key}`);
    this.streak.delete(sessionId);
    this.store.db.query("UPDATE perm_blocked SET data = ? WHERE id = ?").run(JSON.stringify(b), id);
    this.overridden("retry", { blocked_id: id });
    this.bus.emit({ t: "feature", name: "blocked", session_id: sessionId, data: b });
    return b;
  }

  perm(sessionId: string): SessionPerm {
    const r = this.store.db.query<{ mode: string; sandbox: string; network: number }, [string]>("SELECT mode, sandbox, network FROM perm_sessions WHERE session_id = ?").get(sessionId);
    if (r) return { session_id: sessionId, mode: isMode(r.mode) ? r.mode : "ask", sandbox: r.sandbox as SandboxProfile, network: !!r.network };
    return { session_id: sessionId, mode: this.defaultMode(), sandbox: this.defaultSandbox(), network: true };
  }

  // Whether the session's Read of a file on this machine would run without asking anyone: what a part
  // of Keel that reads a file for the session later, as the daemon (a wait's wake), may read of it. A
  // session whose tools run on another machine reads none of this one's files.
  readable(session: Session, path: string): boolean {
    if (session.machine) return false;
    return "allow" in this.evaluate(session, "Read", { kind: "read", paths: [path] });
  }

  // What a session's sandbox shows beyond the toolchains: the owner's list
  // for its repository, and of Keel's own state the session's own files:
  // what it was given by path, and its artifacts (written in the
  // workspace-write profile, see `writable`).
  readOpts(session: Session, profile?: SessionPerm["sandbox"]): ReadOpts {
    if (session.machine) return readOptsFor(sandboxScope(session.workspace));
    const artifacts = this.scope(session).scratch;
    // (The worktrees Keel made for the session's own agents: theirs to work in, the session's to read and merge.)
    const worktrees = this.agentTrees(session.id);
    const root = (this.rootOf(session), this.pins.get(`${session.id}\0${session.workspace}`)?.id);
    const more = [...this.readMore.values()].flatMap((f) => f(session));
    return { ...readOptsFor(sandboxScope(session.workspace)), own: [...attachmentsGiven(session.id), ...(profile === "workspace-write" ? [] : artifacts), ...more], ...(worktrees.length ? { worktrees } : {}), ...(root ? { root } : {}), ...(profile === "workspace-write" ? this.held(session) : {}) };
  }
  // What an agent's write scope keeps read-only in its sandbox: its folder when no place of the scope holds it, and
  // the branches another checkout has out (sandbox.ts compose).
  private held(session: Session): Pick<ReadOpts, "held"> {
    if (!scopes.of?.(session.id)) return {};
    const ws = realOf(session.workspace);
    const base = this.baseOf(session);
    // (Its folder is its own place unless it is the owner's checkout itself: an agent that shares that checkout writes
    // in it only where its writes name a folder, bound after it.)
    const shut = !!base && (ws === base.root || contains(base.git, ws));
    const refs = base ? base.branches.map((b) => join(base.git, "refs", "heads", b)) : [];
    return shut || refs.length ? { held: { ...(shut ? { workspace: true as const } : {}), ...(refs.length ? { refs } : {}) } } : {};
  }
  // How a command Keel runs as the session's own is confined (its tests on the base without its change,
  // src/checks/before-run.ts): the profile its own commands get, with `workspace` in the place of its folder
  // and `tool` as its tool folder (writable in every profile, as a call's spill folder is). Undefined when the
  // session's commands run unconfined. (No pin of the session's folder: `workspace` is not that folder.) `shown`:
  // folders out of `workspace` the command reads (the base's packages a run links): where overlays mount, each
  // with a layer of its own in `tool`, so the command writes into them as into its own and nothing it writes
  // reaches them (`layered`); else read-only.
  confineFor(sessionId: string, workspace: string, tool: string, shown: string[] = []): { wrap: (argv: string[]) => string[]; sandbox: SessionPerm["sandbox"]; network: boolean; layered: boolean } | undefined {
    const session = this.store.session(sessionId);
    if (!session || session.machine) return undefined;
    const p = this.perm(session.id);
    if (p.sandbox === "off" || !this.sandboxed(session, p)) return undefined;
    const { root: _pin, ...read } = this.readOpts(session, p.sandbox);
    const writable = this.writable(session, tool, p.sandbox);
    const layers = shown.length && overlays() ? shown.map((at, i) => ({ at, up: join(tool, "layers", `${i}`, "up"), work: join(tool, "layers", `${i}`, "work") })) : [];
    try { for (const l of layers) { mkdirSync(l.up, { recursive: true }); mkdirSync(l.work, { recursive: true }); } }
    catch { layers.length = 0; } // the tool folder takes none: read-only, then
    const given = shown.length ? { ...read, own: [...(read.own ?? []), ...shown], ...(layers.length ? { layers } : {}) } : read;
    return { wrap: (argv) => confine(argv, p, workspace, writable, given), sandbox: p.sandbox, network: p.network, layered: layers.length > 0 };
  }
  // (Read from the store at most every two seconds per session: a turn asks for it at every call.)
  private trees = new Map<string, { at: number; list: string[] }>();
  private agentTrees(sessionId: string): string[] {
    const have = this.trees.get(sessionId);
    if (have && Date.now() - have.at < 2_000) return have.list;
    const made = realOf(join(this.store.stateDir, "worktrees"));
    let list: string[] = [];
    // (No agents are known where nothing that starts them has made its table.)
    try { list = this.store.descendants(sessionId).map((id) => this.store.session(id)?.workspace).filter((w): w is string => !!w && contains(made, realOf(w))); } catch {}
    if (this.trees.size > 512) this.trees.clear();
    this.trees.set(sessionId, { at: Date.now(), list });
    return list;
  }
  // A read of the store off the loop (the permission routes give the read thread; a test reads on the loop).
  readSql: (sql: string, params: (string | number | null)[]) => Promise<unknown[]> = async (sql, params) => this.store.db.query(sql).all(...params);
  // The folders that are a session's own (own-places.ts), read at most every 30 seconds per session: its folder,
  // the worktree Keel made for it, its scratch, and the folders named as its own scratch in words Keel stored: the
  // owner's own prompts, and for an agent the task and the messages its parent gave it. Text the agent wrote, read
  // or fetched never adds one. A named folder counts only by its real path, reached through no link, that is no
  // part of a git checkout and holds none, and is none of Keel's own folders; one an agent's parent named counts
  // only inside the parent's own folders (a parent gives no more than it has).
  private placesKept = new Map<string, { at: number; list: OwnPlace[] }>();
  // Whether a folder is part of a git checkout or holds one (a test looks no higher than its own folder).
  checkout: (dir: string) => Promise<boolean> = (dir) => checkoutAt(dir);
  async places(session: Session, depth = 0): Promise<OwnPlace[]> {
    const have = this.placesKept.get(session.id);
    if (have && Date.now() - have.at < 30_000) return have.list;
    const list: OwnPlace[] = [{ path: realOf(session.workspace), from: "folder" }];
    try {
      const wt = this.store.db.query<{ path: string }, [string]>("SELECT path FROM worktrees WHERE session_id = ? AND state = 'active'").get(session.id)?.path;
      if (wt && realOf(wt) !== list[0]!.path) list.push({ path: realOf(wt), from: "worktree" });
    } catch {} // no worktree was ever made here
    for (const d of this.scope(session).scratch) list.push({ path: d, from: "scratch" });
    // What its parent gave it to write (its spawn's writes, the parent's yes to a question since): src/automation/write-asks.ts.
    for (const g of scopes.of?.(session.id)?.places ?? []) {
      const path = g.glob ? g.path : realOf(g.path);
      if (!list.some((x) => x.path === path)) list.push({ path, from: "writes", ...(g.glob ? { glob: true as const } : {}) });
    }
    const home = realOf(homedir());
    const keel = ownFolders();
    const words = await this.placeWords(session);
    const parent = session.parent_id && words.some((w) => w.from === "parent") ? this.store.session(session.parent_id) : undefined;
    const given = parent && depth < 8 ? await this.places(parent, depth + 1) : [];
    for (const w of words) for (const p of namedPlaces(w.text, home)) {
      const real = realOf(p);
      // (Through a link, or out of the folders a scratch folder can be once resolved: not a place.)
      if (real !== resolve(p) || !fitsAsPlace(real, home)) continue;
      if (keel.some((k) => contains(k, real) || contains(real, k)) || list.some((x) => x.path === real)) continue;
      if (w.from === "parent" && !given.some((x) => contains(x.path, real))) continue;
      if (await this.checkout(real)) continue;
      list.push({ path: real, from: w.from });
    }
    if (this.placesKept.size > 512) this.placesKept.clear();
    this.placesKept.set(session.id, { at: Date.now(), list });
    return list;
  }
  // The places are read again at the next call (the parent widened the agent's scope).
  forgetPlaces(sessionId: string) { this.placesKept.delete(sessionId); }
  placesFor(session: Session): OwnPlace[] { return this.placesNow(session); }
  // Why a parent cannot give an agent whose folder is `agentFolder` a path to write: it is in the owner's checkout or
  // its git directory (and not in the agent's own folder, made inside it), or the parent has a scope of its own that
  // does not hold it (a parent gives no more than it may write itself).
  async giftRefused(parent: Session, agentFolder: string, path: string): Promise<string | undefined> {
    const glob = /[*?[{]/.test(path);
    const p = realOf(glob ? globBase(path) : path);
    const folder = realOf(agentFolder);
    const base = this.baseAt(folder);
    if (base && (contains(base.root, p) || contains(base.git, p) || contains(p, base.root))) {
      const inOwn = folder !== base.root && !contains(base.git, folder) && contains(folder, p);
      if (!inOwn) return `it is in the owner's checkout (${base.root}) or its git directory, or holds them, and no agent writes there unless the owner's own words name it`;
    }
    if (scopes.of?.(parent.id) && !parent.machine) {
      const v = judgeWrite(p, { places: await this.places(parent), base: this.baseOf(parent) });
      if (!("ok" in v) && !("free" in v)) return "it is outside the paths you may write yourself, and a session gives an agent no more than it may write";
    }
    return undefined;
  }
  // The places as last read, for what cannot wait for a read (the sandbox's binds): before the first read, the ones
  // Keel's own records give.
  private placesNow(session: Session): OwnPlace[] {
    const have = this.placesKept.get(session.id)?.list;
    if (have) return have;
    const list: OwnPlace[] = [{ path: realOf(session.workspace), from: "folder" }, ...this.scope(session).scratch.map((path) => ({ path, from: "scratch" as const }))];
    for (const g of scopes.of?.(session.id)?.places ?? []) list.push({ path: g.glob ? g.path : realOf(g.path), from: "writes", ...(g.glob ? { glob: true as const } : {}) });
    return list;
  }

  // The owner's base checkout of the repository a session works in, its git directory, and the branches checked
  // out in a checkout that is not the session's own (src/safety/write-scope.ts). None outside a repository.
  baseOf(session: Session): Base | undefined {
    return session.machine ? undefined : this.baseAt(session.workspace);
  }
  baseAt(folder: string): Base | undefined {
    let w: ReturnType<typeof locate> = null;
    try { w = locate(folder); } catch {} // a folder git cannot read: no base
    if (!w) return undefined;
    const git = realOf(w.common);
    const root = basename(git) === ".git" ? dirname(git) : git;
    const branches = new Set<string>();
    const own = realOf(w.gitDir);
    const headOf = (dir: string) => { try { return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(dir, "HEAD"), "utf8"))?.[1]?.trim(); } catch { return undefined; } };
    if (own !== git) { const b = headOf(git); if (b) branches.add(b); }
    try {
      for (const name of readdirSync(join(git, "worktrees")).slice(0, 500)) {
        const dir = join(git, "worktrees", name);
        if (realOf(dir) === own) continue;
        const b = headOf(dir);
        if (b) branches.add(b);
      }
    } catch {} // no linked worktrees
    return { root, git, branches: [...branches] };
  }

  // An agent with a write scope writes only where it may: a call whose writes (a file tool's paths, a command's
  // writes that its words show) fall outside is refused before it runs, in every mode, Full auto included. A write
  // into the owner's checkout or its git directory is refused as it is; any other is one question to the parent
  // (scopes.ask), whose yes widens the scope. Undefined: the call goes on to the rest of the gate.
  // (Answered in the same tick when the places were read lately and the owner's words need no read: the calls of
  // one reply keep their order to the gate.)
  private scopeRefusal(session: Session, call: ToolCall, cls: CallClass): string | undefined | Promise<string | undefined> {
    if (session.machine || !scopes.of?.(session.id)) return undefined;
    let paths: string[] = [], refs: string[] = [];
    if (cls.kind === "edit") paths = cls.paths;
    else if (cls.kind === "shell") ({ paths, refs } = shellWrites(cls.command, cls.cwd ?? session.workspace, realOf(homedir())));
    else if (cls.kind === "other" && cls.paths?.length && !call.tool.readOnly) paths = cls.paths;
    if (!paths.length && !refs.length) return undefined;
    const kept = this.placesKept.get(session.id);
    const fresh = kept && Date.now() - kept.at < 30_000 ? kept.list : undefined;
    const go = (places: OwnPlace[], opened: Set<string>): string | undefined | { owner: string } => {
      const base = this.baseOf(session);
      const outside: string[] = [];
      for (const raw of paths) {
        const p = realOf(raw);
        const v = judgeWrite(p, { places, base });
        if ("never" in v) {
          if (opened.has(p)) continue;
          if (!opened.has(`asked\0${p}`)) return { owner: p };
          return `Refused: ${v.never}. No agent writes there unless the owner's own words name it, and your parent cannot give it: this is not a question for anyone. Work in your own folders (${places.filter((x) => x.from !== "folder" || x.path !== base?.root).map((x) => x.path).join(", ")}).`;
        }
        if ("out" in v && !outside.includes(p)) outside.push(p);
      }
      const theirs = refs.filter((r) => base?.branches.includes(r));
      if (theirs.length) return `Refused: the command moves ${theirs.map((r) => `the branch ${r}`).join(" and ")}, which another checkout of the repository has out (the owner's, or another session's). No agent moves it: commit on your own branch, and your parent merges it.`;
      if (!outside.length) return undefined;
      return scopes.ask?.(session.id, outside, call.tool.name) ?? `Refused: ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the paths this agent may write.`;
    };
    const opened = new Set<string>();
    const first = fresh ? go(fresh, opened) : { owner: "" };
    if (typeof first !== "object") return first;
    return (async () => {
      const places = fresh ?? await this.places(session);
      const base = this.baseOf(session);
      for (let n = 0; n < 64; n++) {
        const r = go(places, opened);
        if (typeof r !== "object") return r;
        // A path of the base: the owner's words are read once for it.
        if (!r.owner) continue;
        opened.add(base && (await this.ownerOpens(session, r.owner, base)) ? r.owner : `asked\0${r.owner}`);
      }
      return undefined;
    })();
  }
  // What a confined command of an agent with a scope was refused by its sandbox (a write it made that the gate could
  // not read from its words): a path outside the scope is the same one question to the parent; one in the owner's
  // checkout is said as it is. Lines for the command's result.
  async sandboxRefused(session: Session, output: string): Promise<string[]> {
    if (session.machine || !scopes.of?.(session.id)) return [];
    const refused = refusedWrites(output);
    if (!refused.length) return [];
    const facts = { places: await this.places(session), base: this.baseOf(session) };
    const outside: string[] = [], lines: string[] = [];
    const opts = this.readOpts(session, "workspace-write");
    for (const { path: p, how } of refused) {
      // (A folder that is not there to the command only because its sandbox hides it: a path it shows is really missing.)
      if (how === "missing" && shownTo(p, session.workspace, opts).shown) continue;
      const v = judgeWrite(realOf(p), facts);
      if ("never" in v) lines.push(`The sandbox refused a write: ${v.never}. No agent writes there unless the owner's own words name it.`);
      else if ("out" in v) outside.push(realOf(p));
    }
    if (outside.length) lines.push(`The sandbox refused a write outside the paths this agent may write. ${(scopes.ask?.(session.id, outside, "a command") ?? "").replace(/^Refused: /, "")}`);
    return lines;
  }
  // Whether the owner's own words open a path of the base to this agent: a prompt the owner typed in the agent's own
  // session, or in a session above it after it started, that names the path or a folder holding it, in a sentence
  // that does not say no. The git directory opens only by a name inside it: naming the checkout opens its files.
  private async ownerOpens(session: Session, path: string, base: Base): Promise<boolean> {
    const ids: { id: string; since: number }[] = [{ id: session.id, since: 0 }];
    for (let up = session, n = 0; up.parent_id && n < 32; n++) { ids.push({ id: up.parent_id, since: session.created }); up = this.store.session(up.parent_id) ?? up; }
    const home = realOf(homedir());
    for (const { id, since } of ids) {
      type Row = { kind: string | null; origin: string | null; text: string | null; ts: number };
      let rows: Row[] = [];
      try { rows = await this.readSql("SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.origin') AS origin, substr(json_extract(data, '$.text'), 1, 20000) AS text, ts FROM events WHERE session_id = ? AND kind = 'user' AND ts >= ? ORDER BY seq DESC LIMIT 200", [id, since]) as Row[]; } catch { continue; }
      for (const r of rows) {
        const text = typeof r.text === "string" ? r.text : "";
        if (!text || !ownerPrompt({ kind: r.kind ?? undefined, origin: r.origin ?? undefined }) || text.startsWith("[harness]") || text.startsWith(PEER_PREFIX)) continue;
        if (ownerOpens(text, path, base, home)) return true;
      }
    }
    return false;
  }

  // The stored words that may name a session's own folders, newest first: for an agent its tasks and its parent's
  // messages, and the owner's own prompts (ownerPrompt), but none a session imported from another harness holds
  // (they are that harness's transcript). Read on the read thread, only the fields read.
  private async placeWords(session: Session): Promise<{ text: string; from: "parent" | "owner" }[]> {
    type Row = { kind: string | null; origin: string | null; from_agent: string | null; text: string | null; ts: number };
    let rows: Row[] = [];
    let since = 0;
    try { since = this.store.db.query<{ synced_ms: number }, [string]>("SELECT synced_ms FROM import_links WHERE session_id = ?").get(session.id)?.synced_ms ?? 0; } catch {} // nothing was imported here
    try {
      rows = await this.readSql("SELECT json_extract(data, '$.kind') AS kind, json_extract(data, '$.origin') AS origin, json_extract(data, '$.from_agent') AS from_agent, substr(json_extract(data, '$.text'), 1, 20000) AS text, ts FROM events WHERE session_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT 200", [session.id]) as Row[];
    } catch { return []; }
    const out: { text: string; from: "parent" | "owner" }[] = [];
    for (const r of rows) {
      const text = typeof r.text === "string" ? r.text : "";
      if (!text) continue;
      const kind = r.kind ?? undefined, origin = r.origin ?? undefined;
      if (session.parent_id && kind === "task") out.push({ text: text.replace(/^[\s\S]*?\nTask:\n/, ""), from: "parent" });
      else if (session.parent_id && kind === "steer" && !r.from_agent && text.startsWith(FROM_PARENT)) out.push({ text, from: "parent" });
      else if (ownerPrompt({ kind, origin }) && r.ts > since && !text.startsWith("[harness]") && !text.startsWith(PEER_PREFIX)) out.push({ text, from: "owner" });
    }
    return out;
  }

  // The outputs kept for a session and for the sessions it started or was started by (an agent's report names its files).
  private spills(session: Session): string[] {
    const ids = new Set([session.id]);
    let up = session;
    for (let n = 0; up.parent_id && n < 32; n++) { ids.add(up.parent_id); up = this.store.session(up.parent_id) ?? up; }
    try { for (const id of this.store.descendants(session.id)) ids.add(id); } catch {} // none
    return [...ids].map((id) => join(this.store.stateDir, "spill", id));
  }
  // Why a file is one of Keel's own, which no session's tool writes: its state and its config, but for the session's
  // artifacts folder and a worktree Keel made for it (its workspace, inside the state's worktrees folder).
  // `where`: Keel's state (the store, its token, its keys, other sessions' files: no session's tool writes it, in any
  // mode, Full auto too: it keeps a session from corrupting the daemon's store) or Keel's config (skills, hooks, MCP
  // servers, settings: the owner's own card in the asking modes; in Full auto, which checks nothing, it runs, and
  // a sandbox there keeps the session's file tools out of it as it keeps its commands out).
  private keelOwn(path: string, workspace: string, scratch: string[]): { where: "state" | "config"; why: string } | null {
    const s = storeOf(path);
    const config = `it changes ${path}, which Keel runs or reads its configuration from (its hooks and their scripts, MCP servers, skills and agents), outside any sandbox`;
    if (!s) {
      // (A config file the owner keeps elsewhere: KEEL_HOOKS, KEEL_MCP_CONFIG and their kin.)
      if (ownConfig().some((c) => contains(c, path))) return { where: "config", why: config };
      // (A file with another name: one of the files at the top of Keel's state or config under a name in the workspace.)
      const linked = keelInode(path);
      return linked ? { where: linked, why: `it changes ${path}, another name (a hard link) of one of Keel's own files (its ${linked === "state" ? "state" : "settings"})` } : null;
    }
    if (!s.own) return null;
    if (s.path !== (ownFolders()[0] as string)) return { where: "config", why: config };
    if (scratch.some((d) => contains(d, path))) return null;
    if (contains(workspace, path) && contains(realOf(join(this.store.stateDir, "worktrees")), workspace) && workspace !== realOf(join(this.store.stateDir, "worktrees"))) return null;
    // A session whose own folder is Keel's state folder, or inside it, hears why nothing it writes there lands: the
    // folder it was pointed at is the daemon's, and a session that changes files needs one of its own outside it.
    const ownFolder = contains(s.path, workspace) ? ` (this session's own folder, ${workspace}, is ${workspace === s.path ? "Keel's state folder" : "inside Keel's state folder"}: nothing there is a session's to write, and a session that changes files needs a folder of its own outside it)` : "";
    return { where: "state", why: `it changes ${path}, one of Keel's own files (its store, its token and keys, other sessions' files)${ownFolder}` };
  }

  // What a session's commands write beside its folder: its outputs, and its artifacts folder (made when missing).
  private writable(session: Session, spillDir: string | undefined, profile: SessionPerm["sandbox"]): string[] {
    const out = spillDir ? [spillDir] : [];
    if (profile !== "workspace-write" || session.machine) return out;
    for (const dir of this.scope(session).scratch) {
      try { mkdirSync(dir, { recursive: true }); out.push(dir); } catch {} // not writable here: the command is told when it tries
    }
    // An agent's write scope: the places its parent gave it, and the ones named as its own, writable too.
    // A folder or a file that is there is bound as it is. One that is not there yet: a file in a folder that is
    // there is reached through that folder (a bind needs something to bind, and a file made empty here would be
    // a file nobody asked for), and anything else is made as the folder it names.
    if (scopes.of?.(session.id)) for (const p of bindable(this.placesNow(session), this.baseOf(session))) {
      let at = p;
      if (!existsSync(p)) {
        const up = dirname(p);
        if (existsSync(up) && statSync(up).isDirectory() && up !== realOf(homedir()) && !contains(up, realOf(homedir()))) at = up;
        else try { mkdirSync(p, { recursive: true }); } catch { continue; } // not there and not made: the command is told when it tries
      }
      if (!out.some((x) => contains(x, at))) out.push(at);
    }
    return out;
  }

  // How far the daemon's own git may fetch for a session's worktree
  // (GitOpts.fetch in src/core/git.ts): as far as the session's own commands
  // reach. Any address when they are not confined; the ones the web tools
  // reach when its sandbox leaves the network on; nothing when it is off.
  // No session (the owner's own act): what the web tools reach.
  gitReach(sessionId?: string): "any" | "public" | undefined {
    const s = sessionId ? this.store.session(sessionId) : undefined;
    if (!s) return "public";
    const p = this.perm(s.id);
    if (p.sandbox === "off" || !this.sandboxed(s, p)) return "any";
    return p.network ? "public" : undefined;
  }

  setPerm(sessionId: string, patch: Partial<Omit<SessionPerm, "session_id">>): SessionPerm {
    const prev = this.perm(sessionId);
    const next = { ...prev, ...patch };
    if (prev.mode !== next.mode) this.streak.delete(sessionId);
    if (prev.mode !== next.mode || prev.sandbox !== next.sandbox || prev.network !== next.network) this.invalidateReview();
    this.store.db
      .query("INSERT INTO perm_sessions (session_id, mode, sandbox, network) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET mode = excluded.mode, sandbox = excluded.sandbox, network = excluded.network")
      .run(sessionId, next.mode, next.sandbox, next.network ? 1 : 0);
    this.bus.emit({ t: "feature", name: "perm", session_id: sessionId, data: next });
    this.recheck((w) => w.session.id === sessionId);
    return next;
  }

  // Standing answers are kept for the repository (a worktree's answers are
  // its main checkout's), else for the folder.
  scopeOf(workspace: string): string {
    const hit = this.roots.get(workspace);
    if (hit) return hit;
    // A folder that is gone has no repository to ask (and may come back).
    if (!existsSync(workspace)) return workspace;
    // (Read from the files: git is not run for it, see src/core/git.ts.)
    const out = timed(() => "finding a workspace's repository", () => locate(workspace)?.common ?? "");
    const root = out ? (out.endsWith("/.git") ? dirname(out) : out) : workspace;
    this.roots.set(workspace, root);
    return root;
  }

  rules(session?: Session): Rule[] {
    const all = this.store.db.query<Rule, []>("SELECT * FROM perm_rules ORDER BY created").all();
    if (!session) return all;
    const turn = this.turnGrants.get(session.id);
    return [...all.filter((r) => (r.lifetime === "session" ? r.session_id === session.id : contains(r.scope, session.workspace) || contains(r.scope, this.scopeOf(session.workspace)))), ...(turn && !turn.next ? turn.rules : [])];
  }

  // A skill's allowed-tools (Claude Code's skills frontmatter): rules that
  // hold for the one turn that invoked the skill, and only until the owner's
  // next message. Kept in memory only (a restart ends them with the turn).
  // `next`: the owner's /command that starts a turn now: it holds from that
  // turn's start, which follows at once (Engine.send starts it before it
  // returns); one the turn never took is dropped (dropTurnGrant). `cmd`: the
  // command's own text, the message that is not the owner's next one. Every
  // rule still goes through the gate as a rule does: the mode, the sandbox
  // and the high-risk checks ask whatever a rule says.
  private turnGrants = new Map<string, { rules: Rule[]; next: boolean; from: string; cmd?: string }>();
  grantTurn(session: Session, rules: { kind: RuleKind; pattern: string }[], from: string, next: boolean, cmd?: string) {
    const had = this.turnGrants.get(session.id);
    const made: Rule[] = rules.map((r) => ({ id: `turn:${crypto.randomUUID()}`, kind: r.kind, pattern: r.pattern.trim(), scope: this.scopeOf(session.workspace), lifetime: "session", session_id: session.id, created: Date.now(), bind: null }));
    // Two skills in one turn: both grants hold.
    this.turnGrants.set(session.id, { rules: [...(had && had.next === next ? had.rules : []), ...made], next, from, ...(cmd ? { cmd } : {}) });
  }
  turnGrant(sessionId: string) { return this.turnGrants.get(sessionId); }
  dropTurnGrant(sessionId: string) { this.turnGrants.delete(sessionId); }
  // The owner's message reached the session: a grant ends with it, unless it is the command that made the grant.
  ownerSaid(sessionId: string, text: string) {
    const g = this.turnGrants.get(sessionId);
    if (!g) return;
    if (g.cmd !== undefined && g.cmd === text.trim()) { g.cmd = undefined; return; }
    this.turnGrants.delete(sessionId);
  }
  private turnBegan(sessionId: string) {
    const g = this.turnGrants.get(sessionId);
    if (g?.next) g.next = false;
  }
  // The turn is over: its grant ends, and so does one no turn took.
  turnEnded(sessionId: string) {
    this.turnGrants.delete(sessionId);
    this.answeredShell.delete(sessionId);
  }

  // A command an external agent asked about and the gate allowed (src/acp/external.ts), which the agent then
  // runs in a terminal of Keel's: the same text is let through once in this turn, without a second card. It
  // still goes through every check that refuses (the mode, the rules, the never-allowed commands) and runs
  // confined. Not in Auto, whose answer is bound to the call it judged.
  private answeredShell = new Map<string, string[]>();
  answeredOnce(sessionId: string, command: string) {
    const list = this.answeredShell.get(sessionId) ?? [];
    if (list.length >= 64) list.shift();
    this.answeredShell.set(sessionId, [...list, command]);
  }
  private takeAnswered(sessionId: string, command: string): boolean {
    const list = this.answeredShell.get(sessionId);
    const i = list?.indexOf(command) ?? -1;
    if (i < 0) return false;
    list!.splice(i, 1);
    return true;
  }

  addRule(session: Session, kind: RuleKind, pattern: string, lifetime: "always" | "session", bind?: string): Rule {
    // (Younger than every card there is: a card that is read first is never settled by a rule made after it, see `recheck`.)
    const rule: Rule = { id: crypto.randomUUID(), kind, pattern: pattern.trim(), scope: this.scopeOf(session.workspace), lifetime, session_id: lifetime === "session" ? session.id : null, created: Math.max(Date.now(), this.lastCard + 1), bind: bind ?? null };
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created, bind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(rule.id, rule.kind, rule.pattern, rule.scope, rule.lifetime, rule.session_id ?? null, rule.created, rule.bind ?? null);
    this.invalidateReview();
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return rule;
  }

  // A standing rule for a folder and all below it, not tied to a session (keel port brings these).
  hasStanding(kind: RuleKind, pattern: string, scope: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM perm_rules WHERE kind = ? AND pattern = ? AND scope = ? AND lifetime = 'always'").get(kind, pattern.trim(), scope);
  }
  addStanding(kind: RuleKind, pattern: string, scope: string): void {
    if (this.hasStanding(kind, pattern, scope)) return;
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created) VALUES (?, ?, ?, ?, 'always', NULL, ?)").run(crypto.randomUUID(), kind, pattern.trim(), scope, Date.now());
    this.invalidateReview();
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
  }

  // Revoked in this daemon: each can be put back once, exactly as it was (the Undo of a revoke).
  private revoked = new Map<string, Rule>();
  restore(id: string): Rule | null {
    const r = this.revoked.get(id);
    if (!r) return null;
    this.revoked.delete(id);
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created, bind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.kind, r.pattern, r.scope, r.lifetime, r.session_id ?? null, r.created, r.bind ?? null);
    this.invalidateReview();
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return r;
  }

  revoke(id: string): boolean {
    const was = this.store.db.query<Rule, [string]>("SELECT * FROM perm_rules WHERE id = ?").get(id);
    if (was) this.revoked.set(id, was);
    const n = this.store.db.query("DELETE FROM perm_rules WHERE id = ?").run(id).changes;
    if (n) {
      this.invalidateReview();
      this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    }
    return n > 0;
  }

  // Oldest first, ties broken by id, so every read (and the client, which
  // sorts alike) puts the same card first. Open cards are read on their own:
  // the bounded history never hides one.
  approvals(opts: { session?: string; pending?: boolean } = {}): Approval[] {
    const db = this.store.db;
    const open = opts.pending ? " AND state = 'pending'" : "";
    const rows = opts.session
      ? db.query<{ data: string }, [string]>(`SELECT data FROM approvals WHERE session_id = ?${open} ORDER BY created, id`).all(opts.session)
      : opts.pending
        ? db.query<{ data: string }, []>("SELECT data FROM approvals WHERE state = 'pending' ORDER BY created, id").all()
        : db.query<{ data: string }, []>("SELECT data FROM approvals ORDER BY created DESC, id DESC LIMIT 500").all().reverse();
    return rows.map((r) => JSON.parse(r.data) as Approval);
  }

  approval(id: string): Approval | undefined {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM approvals WHERE id = ?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  }

  // What is stored and shown of a card (secrets are kept out of it).
  redact: (a: Approval) => Approval = (a) => a;
  private redactAny = <T,>(v: T): T => this.redact(v as any) as T;

  // `owed`: an answer. It acts in memory whatever the store says: when the
  // store takes no writes its record is written later (Store.orLater), and
  // the page is told now.
  private save(a: Approval, owed = false) {
    a = this.redact(a);
    // (An answer changes a card that is in the store: its id, its session, the state and the record it has from here.)
    if (owed) this.store.sqlOrLater("approval", [a.id, a.session_id, a.state, JSON.stringify(a)], "a card's answer");
    else this.store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data").run(a.id, a.session_id, a.state, JSON.stringify(a), a.created);
    this.bus.emit({ t: "feature", name: "approval", session_id: a.session_id, data: a });
  }

  // Where a session's edits are its own: its workspace and its scratch folder, links resolved (edits are judged where they land).
  private scope(session: Session) {
    let root = session;
    for (let n = 0; root.parent_id && !root.machine && n < 32; n++) root = this.store.session(root.parent_id) ?? root;
    return { workspace: this.rootOf(session), scratch: session.machine ? [] : [realOf(artifactsDir(this.store.stateDir, root.id))] };
  }

  // What the read thread judges this session's stored calls on (marks.ts):
  // the facts `evaluate` gives the policy, as plain data. A session on another
  // machine has none of this machine's files.
  markFacts(session: Session): Pick<MarkArgs, "workspace" | "scope" | "machine" | "home" | "config" | "bins" | "rules" | "shell"> {
    const local = !session.machine;
    return {
      workspace: session.workspace, scope: this.scope(session), machine: !local, home: realOf(homedir()),
      config: local ? [...ownConfig(), ...(this.hookFiles?.(session) ?? [])] : [],
      bins: local ? workspaceBins(process.env.PATH ?? "", this.rootOf(session)) : [],
      rules: this.rules(session), shell: process.env.SHELL,
    };
  }

  // `real`: for a command that names a program a version manager may stand in for, whether each such name is
  // the program itself here (see `shimmed`). Without it those forms ask.
  // `before`: only the standing rules that are not younger than this time (a held card's own).
  // `mode`: decided as in that mode, not the session's (what Ask would make of the call: its own risk).
  private evaluate(session: Session, name: string, cls: CallClass, bind?: string, facts?: CallFacts, before?: number, mode?: Mode): Decision {
    const p = mode ? { ...this.perm(session.id), mode } : this.perm(session.id);
    const { workspace, scratch } = this.scope(session);
    // (Folders named as the session's own are its scratch to the rules; Keel's own files are judged by its own scratch alone.)
    const named = facts?.own?.filter((x) => x.from === "parent" || x.from === "owner").map((x) => x.path) ?? [];
    const edit = cls.kind === "edit";
    let own: { home: string; config: string[]; bins: string[]; land: (p: string) => string[] } | undefined;
    return decide(cls, {
      mode: p.mode, workspace: edit || !session.machine ? workspace : session.workspace, sandboxed: this.sandboxed(session, p), rules: before === undefined ? this.rules(session) : this.rules(session).filter((r) => r.created <= before), tool: name, bind, scratch: named.length ? [...scratch, ...named] : scratch, real: facts?.real, looked: facts?.looked,
      // An agent in a worktree Keel made: what it shares with the other checkouts (shared-branches.ts).
      ...((cls.kind === "shell" || cls.kind === "edit") && session.parent_id && !session.machine ? { shared: this.sharedOf(session) } : {}),
      // (On this machine's disk: a session whose tools run elsewhere reads and writes that machine's files.)
      ...(session.machine || cls.kind !== "read" ? {} : { shown: (path: string) => shownTo(path, workspace, this.readOpts(session, "read-only"), this.spills(session), true) }),
      ...(session.machine || cls.kind === "read" ? {} : {
        keel: (path: string) => { const k = this.keelOwn(path, workspace, scratch); return k?.where === "state" ? k.why : null; },
        keelConfig: (path: string) => { const k = this.keelOwn(path, workspace, scratch); return k?.where === "config" ? k.why : null; },
        // (As it was at the gate's one look at the call's files: the file the tool then opens is compared with that look.)
        linked: (path: string) => lookedAt.get(cls)?.find((l) => l.path === path)?.linked ?? hardLink(path),
      }),
      // What Keel itself runs things from: a change there is the owner's alone
      // (on this machine's disk). With it, the scripts the owner's hooks and a
      // pinned repository's hooks run: no pin holds one outside .keel/. Read
      // once, and only for a call that names a file to change.
      ...(session.machine ? {} : { own: () => (own ??= {
        home: realOf(homedir()), config: [...ownConfig(), ...(this.hookFiles?.(session) ?? [])],
        // The PATH the session's commands get is the daemon's own (toolEnv).
        bins: workspaceBins(process.env.PATH ?? "", this.rootOf(session)),
        land: (x: string) => [...new Set([x, join(realOf(dirname(x)), basename(x)), realOf(x)])],
      }) }),
    });
  }

  // The checkouts an agent's worktree shares its branches with, when the agent
  // works in a worktree Keel made: its own, or the one of the agent it runs
  // under (the nearest that holds its folder). Read at each command: a checkout
  // made or gone, or a branch taken out, since the last one counts.
  private sharedOf(session: Session): Shared | undefined {
    let row: { path: string; branch: string; base: string } | null;
    try {
      row = this.store.db.query<{ path: string; branch: string; base: string }, [string, string]>(
        "SELECT path, branch, base FROM worktrees WHERE state = 'active' AND (session_id = ?1 OR ?2 = path OR substr(?2, 1, length(path) + 1) = path || '/') ORDER BY session_id = ?1 DESC, length(path) DESC LIMIT 1",
      ).get(session.id, session.workspace);
    } catch {
      return undefined; // (no worktree was ever made: the table is not there)
    }
    if (!row) return undefined;
    // (A worktree made from a commit has no base branch.)
    const base = /^[0-9a-f]{7,64}$/.test(row.base) || row.base === "HEAD" ? null : row.base.replace(/^refs\/heads\//, "");
    return timed(() => "reading the checkouts an agent's worktree shares its branches with", () => checkoutsOf(row.path, row.branch, base));
  }

  // What stands on this machine under the names of the programs a command's reading forms depend on (node
  // --version reads where node is the program, and installs where it is a version manager's shim). Looked up
  // once for the call, off the loop and within a deadline, and only for a line that names one. A session on
  // another machine runs its commands there: what this machine holds says nothing.
  private shimmed(session: Session, cls: CallClass): string[] {
    return cls.kind === "shell" && !session.machine && cls.interpreter === undefined ? shimmedPrograms(cls.command) : [];
  }
  private async real(names: string[]): Promise<(program: string) => boolean> {
    const found = await realPrograms(names);
    return (program) => found.get(program) === true;
  }

  // Set by the hooks module: the files and folders the session's hooks run things from.
  hookFiles?: (session: Session) => string[];

  // Features that hold some sessions to a few tools (a review of another
  // person's pull request: its model's own reading tools, nothing that reaches
  // an MCP server, another session, a machine or a device). An answer is the
  // tools the session may call; nothing: no limit. Keyed by the feature.
  readonly toolLimits = new Map<string, (session: Session) => ((tool: string) => boolean) | undefined>();
  // Features that show a session more of Keel's own state, read-only, in its
  // sandbox (a review's checkout reads its git folder there).
  readonly readMore = new Map<string, (session: Session) => string[]>();

  // Whether a hook's allow may answer this ask. It answers only a question the
  // owner would have been asked (a mode that opens an owner card, for an
  // ordinary action: not high risk, not the owner's alone), for a call that
  // stays inside what the session may already touch: an edit whose every path
  // is in its workspace or its scratch folder, on this machine's disk; a
  // command the session's sandbox confines.
  // A tool, or a message into another session, runs unasked only by the
  // owner's own rule, and with one there is no ask to answer.
  private hookMayAnswer(session: Session, cls: CallClass, ask: { risk: "high" | "low"; ownerOnly?: true }): boolean {
    const p = this.perm(session.id);
    if ((p.mode !== "ask" && p.mode !== "auto-edits") || ask.risk !== "low" || ask.ownerOnly) return false;
    if (cls.kind === "edit") {
      const f = this.scope(session);
      return !session.machine && cls.paths.every((x) => ownPath(x, f));
    }
    // (A command the rules read as a read never asks, so there is nothing of it to answer.)
    if (cls.kind === "shell") return !cls.escalate && p.sandbox !== "off" && this.sandboxed(session, p);
    return false;
  }

  // The beforeTool hook: the gate first; a call it lets through runs confined
  // when the session's sandbox is on, unless the gate let it leave the sandbox
  // (an escalation the owner allowed). Confinement follows the class the gate
  // judged, never a field of the input.
  async beforeTool(session: Session, call: ToolCall): Promise<ToolGate> {
    for (const [, limit] of this.toolLimits) {
      const only = limit(session);
      if (only && !only(call.tool.name)) return { deny: `Refused: this session reviews another person's code and uses only its model's own reading tools (files, search, its sandboxed shell); ${call.tool.name} is not one of them.` };
    }
    if (!this.perm(session.id).network) {
      const web = webRefusal(call.tool.name, call.input);
      if (web) return { deny: web };
    }
    const r = await this.check(session, call);
    if ("deny" in r) return r;
    // An agent in a worktree Keel made: every git its command starts carries the hook that keeps the branches the
    // worktree shares where they are (ref-guard.ts).
    if (r.cls.kind === "shell" && session.parent_id && !session.machine) {
      const shared = this.sharedOf(session);
      const env = shared ? timed(() => "making the hook that keeps an agent off the shared branches", () => guardEnv(shared)) : {};
      if (Object.keys(env).length) setCallEnv(session.id, call.id, env);
    }
    const p = this.perm(session.id);
    let ctx: Partial<ToolCall["ctx"]> | undefined =
      !(r.cls.kind === "shell" && r.cls.escalate) && this.sandboxed(session, p) && p.sandbox !== "off"
        ? { wrapSpawn: (argv) => confine(argv, p, session.workspace, this.writable(session, call.ctx.spillDir, p.sandbox), this.readOpts(session, p.sandbox)), confined: { sandbox: p.sandbox, network: p.network, since: Date.now() } }
        : undefined;
    // A confined command in a linked worktree can write the refs it shares
    // with the other checkouts: they are read now and compared after it
    // (refsChanged). Not for a command proved to only read, nor for one that
    // runs on another machine.
    if (ctx && p.sandbox === "workspace-write" && !session.machine && r.cls.kind === "shell" && !(r.cls.interpreter === undefined && readOnlyCommand(r.cls.command))) {
      const w = await watch(session.workspace);
      if (w) {
        if (this.watches.size >= 256) this.watches.delete(this.watches.keys().next().value!); // calls that never came back
        this.watches.set(callKey(session.id, call.id), w);
      }
    }
    // The files the call was judged for, where they are: a file tool opens nothing else (src/tools/files.ts hold).
    // A name can change between this look and the tool's open; what is opened is compared with this.
    // (Each with the file it is now: a name that is another file by the time of the open is not what was judged.)
    const looks = !session.machine && (r.cls.kind === "edit" || r.cls.kind === "read" || r.cls.kind === "other") && r.cls.paths?.length ? lookedAt.get(r.cls) ?? r.cls.paths.map((path) => ({ path, id: fileId(path) })) : undefined;
    // (Also kept for a moment by session and by what the call does: a caller that runs the tool without this context is held to it too.)
    if (looks) {
      ctx = { ...ctx, judged: looks.map((l) => l.path), looked: Object.fromEntries(looks.map((l) => [l.path, l.id])) };
      noteJudged(session.id, r.cls.kind === "read" ? "read" : "write", looks);
    }
    if (!r.authorization) return ctx ? { ctx } : undefined;
    const auth = r.authorization;
    const wrap = ctx?.wrapSpawn ?? call.ctx.wrapSpawn;
    const confined = JSON.stringify(ctx?.confined ?? call.ctx.confined);
    return { ctx, authorization: {
      ...auth,
      valid: (now, input) => now.ctx.wrapSpawn === wrap && JSON.stringify(now.ctx.confined) === confined && auth.valid(now, input),
    } };
  }

  // After a call that was watched (a confined command in a linked worktree):
  // what it changed in the repository outside its own branch, in one
  // sentence, or no note.
  private watches = new Map<string, Watch>();
  // The refs a session's own commands made in its running turn: deleting or
  // moving one of them again is its own work, and is not reported.
  private ownRefs = new Map<string, Set<string>>();
  async refsChanged(sessionId: string, callId: string): Promise<{ note?: string } | undefined> {
    const key = callKey(sessionId, callId);
    const w = this.watches.get(key);
    this.watches.delete(key);
    if (!w) return undefined;
    let own = this.ownRefs.get(sessionId);
    if (!own) this.ownRefs.set(sessionId, (own = new Set()));
    return { note: await report(w, own) };
  }

  // A dispatcher (mcp_call) is judged as the tool it runs: its own read flag,
  // and grants for that tool alone. Returns the class it judged.
  // The folder a session was made in is pinned: where it is, and the folder it is (device and inode). A session
  // whose folder's name leads somewhere else now (a link took its place), or is another folder under the same
  // name, runs nothing: every rule here is about "the session's folder", and that would be a folder nobody chose.
  // A sandboxed command cannot make this change (its own folder is a mount point there); a command outside one can.
  // Keel's own worktrees are made again under their name by Keel: those are pinned anew.
  private pins = new Map<string, { real: string; id: string }>();
  // Where the session's folder is: where it was when the session was made (the pin), not where its name leads at
  // this moment.
  private rootOf(session: Session): string {
    if (session.machine) return realOf(session.workspace);
    return this.pins.get(`${session.id}\0${session.workspace}`)?.real ?? (this.rootMoved(session), this.pins.get(`${session.id}\0${session.workspace}`)?.real) ?? realOf(session.workspace);
  }
  private rootMoved(session: Session): string | undefined {
    if (session.machine) return undefined;
    const key = `${session.id}\0${session.workspace}`;
    const real = realOf(session.workspace), id = fileId(real);
    if (id === null) return undefined; // gone: the tools say so
    let pin = this.pins.get(key);
    if (!pin) {
      const row = this.store.db.query<{ real: string; id: string }, [string, string]>("SELECT real, id FROM session_roots WHERE session_id = ? AND workspace = ?").get(session.id, session.workspace);
      pin = row ?? undefined;
    }
    const mine = contains(realOf(join(this.store.stateDir, "worktrees")), real);
    if (!pin || (pin.real === real && pin.id !== id && mine)) {
      pin = { real, id };
      this.store.db.query("INSERT INTO session_roots (session_id, workspace, real, id) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, workspace) DO UPDATE SET real = excluded.real, id = excluded.id").run(session.id, session.workspace, real, id);
    }
    if (this.pins.size > 2048) this.pins.clear();
    this.pins.set(key, pin);
    if (pin.real === real && pin.id === id) return undefined;
    return `Refused: this session's folder is not the folder the session was made in. ${session.workspace} ${pin.real !== real ? `leads to ${real} now (it was ${pin.real})` : "is another folder under the same name now"}. Nothing runs in it. If the owner replaced the folder, a new session there works.`;
  }

  async check(session: Session, call: ToolCall): Promise<CheckResult> {
    try { return await this.checked(session, call); } finally { this.checking.delete(callKey(session.id, call.id)); }
  }
  private async checked(session: Session, call: ToolCall): Promise<CheckResult> {
    { const moved = this.rootMoved(session); if (moved) return { deny: moved }; }
    if (call.tool.confirm) return (await this.askOnce(session, call, call.tool.name, call.tool.confirm.why, call.tool.confirm.shown(call.input))) ?? { cls: { kind: "other" } };
    const target = call.tool.target ? await call.tool.target(call.input, session.id) : null;
    const name = target?.name ?? call.tool.name;
    // A page fetch to an address the session has not seen is judged as the send it is (src/safety/addresses.ts).
    const raw = callClass(call, target);
    const fresh = raw.kind === "read" && raw.fetches?.length ? await this.seen(session).then((web) => {
      const tally = new Map<string, number>();
      const held = new Map<string, string>();
      for (const a of raw.fetches!) {
        if (web.has(a)) continue;
        const host = groupOf(addressOf(a) ?? a) ?? "";
        const earlier = tally.get(host) ?? 0;
        tally.set(host, earlier + 1);
        const why = web.carries(a, earlier);
        if (why) held.set(a, why);
      }
      return held;
    }) : undefined;
    const asJudged = (c: CallClass) => sentAs(c, fresh);
    const cls = asJudged(raw);
    // (Only an agent with a scope waits for it: every other call goes on in the same tick, as before.)
    if (!session.machine && scopes.of?.(session.id)) {
      const r = this.scopeRefusal(session, call, cls);
      const out = typeof r === "object" ? await r : r;
      if (out) return { deny: out };
    }
    const mode = this.perm(session.id).mode;
    const dir = mode === "auto" ? localShellDir(session, call, target, cls) : undefined;
    // Nothing is waited for unless the line names such a program.
    const names = this.shimmed(session, cls);
    const judged = cls.kind === "shell" && dir ? { ...cls, cwd: dir.path } : cls;
    // What the disk says of the paths a command names is asked off the loop, and only when the decision asked
    // for it: the first reading of a line decides most of them. Nothing is asked for a session on another machine.
    const facts: CallFacts = { real: names.length ? await this.real(names) : undefined };
    // The calls of one reply are checked side by side, and their cards list in call order: a call goes on from
    // here only after the calls before it have, however long the disk took over any of them.
    const prior = this.asking.get(session.id);
    const local = !session.machine && judged.kind === "shell";
    const l = local ? looking(session.workspace) : null;
    let asked = new Map<string, () => Promise<unknown>>();
    let dNow = this.evaluate(session, name, judged, target?.source, l ? { ...facts, looked: l.view(asked) } : facts);
    if (asked.size || prior) {
      let done!: () => void;
      const mine = new Promise<void>((r) => { done = r; });
      this.asking.set(session.id, mine);
      try {
        for (let pass = 0; l && asked.size && !l.over() && pass < 3; pass++) {
          await l.answer(asked);
          asked = new Map();
          dNow = this.evaluate(session, name, judged, target?.source, { ...facts, looked: l.view(asked) });
        }
      } finally {
        await prior;
        done();
        if (this.asking.get(session.id) === mine) this.asking.delete(session.id);
      }
    }
    // A call Auto sends to the judge: the session's own folders, for the judge and for the rules. A folder its
    // parent's task or the owner named as its own is its scratch to the rules, so the call is decided again with it.
    if (mode === "auto" && !session.machine && "ask" in dNow && !dNow.ask.ownerOnly) {
      facts.own = await this.places(session);
      if (facts.own.some((x) => x.from === "parent" || x.from === "owner")) {
        asked = new Map();
        dNow = this.evaluate(session, name, judged, target?.source, l ? { ...facts, looked: l.view(asked) } : facts);
        for (let pass = 0; l && asked.size && !l.over() && pass < 3; pass++) {
          await l.answer(asked);
          asked = new Map();
          dNow = this.evaluate(session, name, judged, target?.source, { ...facts, looked: l.view(asked) });
        }
      }
    }
    if (l) facts.looked = l.view();
    facts.settles = "ask" in dNow && !!dNow.ask.settles;
    this.checking.set(callKey(session.id, call.id), facts);
    // The call a restart cut while its card was open: that card again, settled
    // the way an open card is (the owner's answer, a grant or mode since, or waiting).
    const back = this.recovered(session.id, call, false) ?? (mode === "auto" ? this.recovered(session.id, call, true) : undefined);
    if (back) {
      // A card that is read first waits for its own answer: a rule made after it opened does not settle it (see `recheck`).
      const d = back.state === "pending" && this.form(back).hold.length
        ? this.evaluate(session, name, judged, target?.source, facts, back.created) : dNow;
      // Do not authorize a recovered non-hook card under the new mode. A
      // saved answer is not evidence about the current binding or landing.
      if (mode === "auto" || back.autoOwner) {
        const deny = "deny" in d ? d.deny : interruptedApproval;
        if (back.state === "pending") this.finish(back, { state: "denied", reason: deny });
        return { deny };
      }
      const settled: Partial<Approval> | undefined = back.state !== "pending" ? undefined
        : "allow" in d ? { state: "allowed", choice: "once", reason: "settled by a grant or a mode change" } : "deny" in d ? { state: "denied", reason: d.deny } : undefined;
      if (settled) this.finish(back, settled);
      // Now in full auto: the card closes and the call is settled without the owner.
      if (!settled && back.state === "pending" && "ask" in d && !back.once && this.perm(session.id).mode === "full-auto") {
        this.finish(back, { state: "cancelled", reason: "settled without the owner in full auto" });
        return this.alone(session, call, name, cls, back.summary, keyOf(name, target, cls, call, back.summary), d.ask.why);
      }
      return (await this.wait({ ...back, ...settled }, session, call, name, cls)) ?? { cls };
    }
    const d = dNow;
    if ("deny" in d) return { deny: d.deny };
    if (mode === "auto" && cls.kind !== "read" && hasSecret([call.input, target?.input, cls, dir?.path], vault.pairs().map(([value]) => value))) return secretReview;
    const checkShell = mode === "auto" && (cls.kind === "shell" || !!call.tool.autoShell);
    const shell = checkShell ? call.tool.autoShell?.(call.input ?? {}) : undefined;
    if (checkShell && (cls.kind !== "shell" || !shell || shell.command !== cls.command || !dir))
      return { deny: 'Refused: Auto cannot verify this shell invocation. Use a supported local non-login Bash command (for exec_command, shell: "bash" and login: false), or use Ask.' };
    const invocation = dir && shell ? { ...dir, interpreter: shell.interpreter } : undefined;
    if ("allow" in d) return { cls, ...(mode === "auto" ? { authorization: this.autoAuthorization(session, call, target, cls, false, invocation, asJudged).authorization } : {}) };
    if (cls.kind === "control") return { cls };
    if (mode !== "auto" && cls.kind === "shell" && call.tool.answeredBefore && this.takeAnswered(session.id, cls.command)) return { cls };
    // A hook's allow (the owner's own hooks file, or a repository's they read
    // and pinned) answers the card this call would open, and nothing more
    // (hookMayAnswer): what is refused above stays refused (Read only, Plan,
    // the never-allowed commands), the judge and the reviewer still review
    // what is theirs, a high-risk or owner-only action and a tool that
    // confirms every call still ask, and the sandbox still confines what runs.
    if (call.hook?.allowed !== undefined && this.hookMayAnswer(session, cls, d.ask)) {
      call.hook.skipped = true;
      return { cls };
    }
    const { summary, cut } = inShort(cls, target ? target.input : call.input);
    const key = keyOf(name, target, cls, call, summary);
    if (mode === "auto") {
      const input = shell ? shell.options : target ? target.input : call.input;
      if ((!d.ask.ownerOnly || checkShell) && (summary.length > REVIEW_SUMMARY_LIMIT || JSON.stringify(input ?? {}).length > REVIEW_INPUT_LIMIT))
        return { deny: "Refused: the complete action does not fit in Auto review. Break it into smaller actions or use Ask for owner approval." };
      return this.checkAuto(session, call, target, cls, name, summary, d.ask, input, invocation, cut, asJudged);
    }
    // Full auto: nothing waits on the owner. What would ask is high risk; it
    // goes to the rules, then the judge, and is run or refused at once.
    if (mode === "full-auto") return this.alone(session, call, name, cls, summary, key, d.ask.why);
    let notice: string | undefined;
    // Reviewer mode: what would ask goes to the reviewer first; a high-risk
    // action, and anything it cannot judge, still goes to the owner.
    if (mode === "reviewer" && d.ask.risk === "low" && !readWhole(cls, target ? target.input : call.input)) notice = "Too long for the reviewer to read whole. The owner answers this one.";
    else if (mode === "reviewer" && d.ask.risk === "low") {
      if (this.retries.delete(`${session.id}\u0000${key}`)) return { cls };
      const v = await this.judge({ session, tool: name, kind: cls.kind, summary, input: clip(call.input) });
      const record = (decision: "allow" | "deny", blocked_id?: string) => "unavailable" in v ? undefined
        : this.verdict({ session_id: session.id, tool: name, by: "reviewer", decision, class: "ordinary", place: "unknown", risk: v.risk, model: v.model, shape: shapeOf(name, summary), blocked_id });
      if ("unavailable" in v) notice = `Reviewer unavailable: ${v.unavailable}. The owner answers this one.`;
      else if (v.allow) return record("allow"), { cls };
      else {
        const b = this.block({ session_id: session.id, calls: [call.id], tool: name, summary, reason: v.reason, risk: v.risk, model: v.model, key, by: "reviewer" });
        record("deny", b.id);
        return { deny: `The reviewer refused this call (risk ${v.risk}): ${v.reason.replace(/[.\s]+$/, "")}. Do not retry it as it is: take another way, or ask the owner, who can let one retry through.` };
      }
    }
    return (await this.card(session, call, name, cls, summary, { ...d.ask, notice: notice ?? d.ask.notice, bind: target?.source, cut })) ?? { cls };
  }

  // `asJudged`: what the gate made of the call's class when it judged it (a fetch judged as a send), made again of the class now.
  private autoAuthorization(session: Session, call: ToolCall, target: Target, cls: CallClass, exactDispatch: boolean, invocation?: AutoShell, asJudged: (c: CallClass) => CallClass = (c) => c) {
    const revision = this.reviewVersion;
    const originalInput = JSON.stringify(call.input);
    const { tool, ctx: { dispatch, signal, cwd, sessionId, spillDir } } = call;
    const signature = (current: ToolCall, t: Target, c: CallClass, shell?: AutoShell) => {
      const p = this.perm(session.id);
      const stored = this.store.session(session.id);
      return JSON.stringify([p, this.sandboxed(session, p), stored?.archived, stored?.machine, stored?.workspace, realOf(session.workspace),
        c, shell, t?.name, t?.source, t?.shape, t?.input, current.input]);
    };
    const before = signature(call, target, cls, invocation);
    let currentTarget = target;
    const active = () => revision === this.reviewVersion && !signal.aborted;
    const authorization: ToolAuthorization = {
      deny: changedReview.deny,
      refresh: tool.target ? async (now) => {
        if (active() && now.tool === tool && JSON.stringify(now.input) === originalInput) currentTarget = await tool.target!(now.input, session.id);
      } : undefined,
      valid: (now, input) => {
        if (!active() || now.tool !== tool || now.ctx.signal !== signal || now.ctx.cwd !== cwd ||
            now.ctx.sessionId !== sessionId || now.ctx.spillDir !== spillDir ||
            ((exactDispatch || invocation) && now.ctx.dispatch !== dispatch) || JSON.stringify(input) !== originalInput) return false;
        const c = asJudged(callClass(now, currentTarget));
        const dir = invocation ? localShellDir(session, now, currentTarget, c) : undefined;
        const shell = invocation ? tool.autoShell?.(now.input ?? {}) : undefined;
        return before === signature(now, currentTarget, c,
          dir && shell && c.kind === "shell" && shell.command === c.command ? { ...dir, interpreter: shell.interpreter } : undefined);
      },
    };
    return { authorization, before };
  }

  private async checkAuto(session: Session, call: ToolCall, target: Target, cls: CallClass, name: string, summary: string, ask: Ask, input: unknown, invocation?: AutoShell, cut?: true, asJudged?: (c: CallClass) => CallClass): Promise<CheckResult> {
    const { authorization, before } = this.autoAuthorization(session, call, target, cls, !ask.ownerOnly, invocation, asJudged);
    const valid = async () => {
      await authorization.refresh?.(call);
      return authorization.valid(call, call.input);
    };
    if (ask.ownerOnly) {
      const shown = invocation ? `${summary}\n\nStarting directory: ${invocation.path}\nInterpreter: ${invocation.interpreter}` : summary;
      const deny = await this.card(session, call, name, cls, shown, { ...ask, bind: target?.source, autoOwner: true, cut });
      return deny ?? (await valid() ? { cls, authorization } : changedReview);
    }
    // Auto refusals and one-off retries are separate from Full auto's
    // existing decisions, and tied to the input, binding and resolved cwd.
    const key = new Bun.CryptoHasher("sha256").update(`auto\0${before}`).digest("hex").slice(0, 32);
    const r = await this.alone(session, call, name, cls, summary, key, ask.why ?? "no safe default or standing grant covers it",
      { ask, cwd: invocation?.path, interpreter: invocation?.interpreter, input, valid });
    return "deny" in r ? r : { cls, authorization };
  }

  // A new turn: the run of refusals starts over.
  turnStarted(sessionId: string) {
    this.streak.delete(sessionId);
    this.ownRefs.delete(sessionId);
    this.turnBegan(sessionId);
  }

  // Full auto's high-risk call, settled without the owner: a retry the owner
  // let through runs; the rules allow what stays on the session's own,
  // recoverable work; a call refused before is refused again with its reason;
  // after STREAK refusals in a row the turn's other high-risk calls are refused
  // unreviewed; else the judge decides, and a judge that cannot answer refuses.
  private async alone(session: Session, call: ToolCall, name: string, cls: CallClass, summary: string, key: string, why = "it is high risk", auto?: AutoReview): Promise<{ deny: string } | { cls: CallClass }> {
    const base = { session_id: session.id, tool: name, summary: summary.slice(0, 2000) };
    const ran = (outcome: Judged["outcome"], reason: string, more: Partial<Judged> = {}) => {
      if (outcome === "rule" || outcome === "judge" || outcome === "retry") this.streak.delete(session.id);
      this.bus.emit({ t: "feature", name: "judged", session_id: session.id, data: this.redactAny({ ...base, call_id: call.id, outcome, reason, ...more }) });
    };
    // Full auto checks nothing: a call the rules flag runs as it is, and the
    // activity list says it ran unreviewed and why it was flagged. (Auto, which
    // passes `auto`, keeps its judge.)
    if (!auto) return ran("unreviewed", why), { cls };
    const retry = `${session.id}\u0000${key}`;
    if (this.retries.has(retry)) {
      if (auto && !await auto.valid()) return changedReview;
      if (this.retries.delete(retry)) return ran("retry", "the owner let one retry through"), { cls };
    }
    if (!auto && cls.kind === "shell" && !cls.escalate) {
      // The rules settle git's own forms from the repository's state. A line that is high risk for anything else goes
      // to the judge, and is not read again here.
      const parts = this.checking.get(callKey(session.id, call.id))?.settles ? splitCommand(cls.command) : null;
      const rule = parts ? preAllow(parts, cls.cwd ?? session.workspace, homedir(), lookRepo) : null;
      if (rule) return ran("rule", rule), { cls };
    }
    // What is judged is what runs, whole: the judge is sent the start of a
    // long action only, so one that does not fit is not sent at all. (Auto
    // refuses the same before it gets here. A command that asks to leave the
    // sandbox with its write past the part that is read ran unread.)
    if (!auto && !readWhole(cls, call.input, summary)) {
      return { deny: `Refused: the complete action does not fit in the judge's review (${REVIEW_SUMMARY_LIMIT} characters), and no part of it runs unread. Break it into smaller actions, or put a long script in a file and run that; the owner can also run it.` };
    }
    const refuse = (b: Blocked, outcome: Judged["outcome"], text: string) => {
      this.streak.set(session.id, (this.streak.get(session.id) ?? 0) + (outcome === "unavailable" ? 0 : 1));
      ran(outcome, b.reason, { model: b.model, blocked_id: b.id });
      return { deny: text };
    };
    const again = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM perm_blocked WHERE session_id = ? AND json_extract(data, '$.key') = ? ORDER BY created DESC LIMIT 1").get(session.id, key);
    const prev = again ? (JSON.parse(again.data) as Blocked) : undefined;
    // (Not a refusal of Keel's rules: what they read of the disk can change, a commit made since among it.)
    if (prev && !prev.retry && prev.by !== "unavailable" && prev.by !== "streak" && prev.by !== "rule") {
      const b: Blocked = { ...prev, calls: [...(prev.calls ?? []), call.id].slice(-20), count: (prev.count ?? 1) + 1, last: Date.now() };
      this.store.db.query("UPDATE perm_blocked SET data = ? WHERE id = ?").run(JSON.stringify(this.redactAny(b)), b.id);
      this.bus.emit({ t: "feature", name: "blocked", session_id: session.id, data: this.redactAny(b) });
      return refuse(b, "repeat", `Refused again: this exact call was already refused in this session (${reasonOf(prev.reason)}). Do not retry it or work around it. Take a safer way, or finish the rest and tell the owner what you could not do; the owner can let one retry through.`);
    }
    if ((this.streak.get(session.id) ?? 0) >= STREAK) {
      const calls = auto ? "calls needing review" : "high-risk calls";
      const b = this.block({ ...base, calls: [call.id], reason: `${STREAK} ${calls} in a row were refused in this turn, so this one was refused without review`, risk: "unknown", model: "", key, by: "streak" });
      return refuse(b, "streak", `Refused without review: ${STREAK} ${calls} in a row were refused in this turn. Stop trying these actions now: finish what you can without them, then report to the owner what was refused and why you needed it.`);
    }
    let high = !auto || auto.ask.risk === "high";
    const cwd = auto?.cwd ?? (cls.kind === "shell" ? cls.cwd : undefined) ?? session.workspace;
    const places = this.checking.get(callKey(session.id, call.id))?.own ?? [];
    const sort = this.sortOf(cls, auto?.ask, places, cwd);
    const record = (v: Omit<VerdictRow, "session_id" | "tool" | "class" | "place" | "shape">) => this.verdict({ session_id: session.id, tool: name, class: sort.class, place: sort.place, shape: shapeOf(name, summary), ...v });
    // What Keel's facts settle of a high-risk command inside the session's own folders: a discard of git work with
    // nothing there to lose is judged as the ordinary call it then is; one that would lose uncommitted work is refused
    // here, with the way to do it safely (own-places.ts).
    let settled: string | undefined;
    if (auto && high && cls.kind === "shell" && auto.ask.risks?.length && places.length) {
      const parts = splitCommand(cls.command);
      const s = parts ? settleOwn({ parts, risks: auto.ask.risks, cwd, home: homedir(), places, look: readRepo }) : null;
      if (s && "deny" in s) {
        const b = this.block({ ...base, calls: [call.id], reason: s.deny, risk: "high", model: "", key, by: "rule" });
        record({ by: "rule", decision: "deny", blocked_id: b.id });
        return refuse(b, "refused", s.deny);
      }
      if (s) { high = false; settled = `${s.allow} The rules flagged it because the command ${why.replace(/^the command /, "")}.`; }
    }
    const facts = high && cls.kind === "shell" ? repoContext(cls.command, cwd, homedir(), session, places) : undefined;
    const own = places.length ? ownFacts(places) : undefined;
    const v = await this.judge({ session, tool: name, kind: cls.kind, summary, input: auto ? auto.input : clip(call.input), mode: auto && "auto", cwd: auto?.cwd, interpreter: auto?.interpreter, high: high ? { why, facts } : undefined, own, settled });
    if (auto && !await auto.valid()) return changedReview;
    if ("unavailable" in v) {
      const b = this.block({ ...base, calls: [call.id], reason: `The judge could not review it: ${v.unavailable}`, risk: "unknown", model: "", key, by: "unavailable" });
      return refuse(b, "unavailable", `Refused: this ${high ? "high-risk " : ""}call (${why}) needs the judge's review, and the judge could not give one (${reasonOf(v.unavailable)}). That is not proof it is unsafe. Take another way if there is one, or go on with the rest and report it; the owner can let one retry through.`);
    }
    if (v.allow) return record({ by: "judge", decision: "allow", risk: v.risk, model: v.model }), ran("judge", v.reason, { model: v.model, ms: v.ms }), { cls };
    const b = this.block({ ...base, calls: [call.id], reason: v.reason, risk: v.risk, model: v.model, key, by: "judge" });
    record({ by: "judge", decision: "deny", risk: v.risk, model: v.model, blocked_id: b.id });
    return refuse(b, "refused", `Refused by the judge (risk ${v.risk}): ${reasonOf(v.reason)}. Do not retry it as it is or work around it: take a safer way, or finish the rest and tell the owner what you could not do. The owner can let one retry through.`);
  }

  // The class a verdict is counted under: what the rules flagged (the first reason's class), or an ordinary call;
  // and whether every path the call names to change is in the session's own folders.
  private sortOf(cls: CallClass, ask: Ask | undefined, places: OwnPlace[], cwd: string): { class: string; place: "own" | "outside" } {
    const rule = ask?.risk === "high" ? ask.risks?.[0]?.rule ?? (ask.ownerOnly ? "owner" : "flagged") : "ordinary";
    const paths = cls.kind === "edit" ? cls.paths : cls.kind === "shell" ? [cwd] : [];
    const allOwn = places.length > 0 && paths.length > 0 && paths.every((p) => !!ownPlaceOf(realOf(p), places));
    return { class: rule, place: allOwn ? "own" : "outside" };
  }

  // One verdict on a call, kept to count how often the owner later takes it back (judgeStats).
  private pruned = 0;
  private verdict(v: VerdictRow) {
    try {
      // (Kept 90 days, pruned at most once a day: the counts read a week, and nothing reads past that.)
      if (Date.now() - this.pruned > 86_400_000) { this.pruned = Date.now(); this.store.db.query("DELETE FROM judge_verdicts WHERE created < ?").run(Date.now() - VERDICT_DAYS * 86_400_000); }
      this.store.db.query("INSERT INTO judge_verdicts (id, session_id, created, by, decision, class, place, risk, model, tool, shape, blocked_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), v.session_id, Date.now(), v.by, v.decision, v.class, v.place, v.risk ?? null, v.model ?? null, v.tool, v.shape, v.blocked_id ?? null);
    } catch {} // a store that takes no writes now: the verdict stands, uncounted (the store says why it takes none)
  }
  // The owner took a refusal back: one retry of it, or an allow of the same call on a card later.
  private overridden(how: "retry" | "card", where: { blocked_id: string } | { session_id: string; shape: string }) {
    const now = Date.now();
    // (Counting never stands in the way of the owner's answer: a store that takes no writes now counts nothing.)
    try {
      if ("blocked_id" in where) this.store.db.query("UPDATE judge_verdicts SET overridden = ?, override = ? WHERE blocked_id = ? AND overridden IS NULL").run(now, how, where.blocked_id);
      else this.store.db.query("UPDATE judge_verdicts SET overridden = ?, override = ? WHERE session_id = ? AND shape = ? AND decision = 'deny' AND overridden IS NULL AND created > ?").run(now, how, where.session_id, where.shape, now - OVERRIDE_DAYS * 86_400_000);
    } catch {} // counted by none
  }

  // A refusal stored for the owner's list (secrets kept out of it).
  private block(b: Omit<Blocked, "id" | "created">): Blocked {
    const full: Blocked = { ...b, summary: b.summary.slice(0, 2000), id: crypto.randomUUID(), created: Date.now() };
    const shown = this.redactAny(full);
    this.store.db.query("INSERT INTO perm_blocked (id, session_id, data, created) VALUES (?, ?, ?, ?)").run(full.id, full.session_id, JSON.stringify(shown), full.created);
    this.bus.emit({ t: "feature", name: "blocked", session_id: full.session_id, data: shown });
    return full;
  }

  // A card for this one call that only the owner answers (a hook asked): no
  // grant, mode change or reviewer settles it.
  // `shown`: what the card shows of the call (a mail as its recipients, subject and text).
  async askOnce(session: Session, call: ToolCall, name: string, why: string, shown?: string): Promise<{ deny: string } | void> {
    const c = landing(classifyCall(call));
    const cls: CallClass = c.kind === "read" || c.kind === "control" ? { kind: "other" } : c;
    const short = inShort(cls, call.input);
    return this.card(session, call, name, cls, shown ?? short.summary, { risk: "high", why, suggest: [], cut: shown === undefined ? short.cut : undefined }, true);
  }

  // A hook of the owner's asks about a call the gate let through. The card is answered once, as askOnce's,
  // and says two things apart: the call's own risk and reason, what Ask would make of it whatever the
  // session's mode, and the hook's reason, in the hook's words.
  async askForHook(session: Session, call: ToolCall, name: string, reason: string): Promise<{ deny: string } | void> {
    const c = landing(classifyCall(call));
    const cls: CallClass = c.kind === "read" || c.kind === "control" ? { kind: "other" } : c;
    const short = inShort(cls, call.input);
    const target = call.tool.target ? await call.tool.target(call.input, session.id) : null;
    const d = this.evaluate(session, target?.name ?? call.tool.name, callClass(call, target), target?.source, undefined, undefined, "ask");
    const own = "ask" in d ? { risk: d.ask.risk, why: d.ask.why } : "deny" in d ? { risk: "high" as const, why: d.deny } : { risk: "low" as const };
    return this.card(session, call, name, cls, short.summary, { ...own, notice: `${HOOK_ASKS}: ${reason.replace(/\s+$/, "")}`, suggest: [], cut: short.cut }, true);
  }

  // Set by the hooks module: what the owner's PermissionRequest hooks answer for a card about to open.
  requestHook?: (session: Session, call: ToolCall, name: string, ask: { risk: "high" | "low"; why?: string; rule?: string }) => Promise<{ allow: true } | { deny: string } | void>;

  // Calls the owner allowed on a card (the protected-path sweep leaves their work alone).
  ownerAllowed(callId: string | undefined): boolean {
    return !!callId && this.allowedCalls.has(callId);
  }

  private async card(session: Session, call: ToolCall, name: string, cls: CallClass, summary: string,
    ask: { risk: "high" | "low"; why?: string; rule?: string; suggest: Suggest[]; notice?: string; bind?: string; autoOwner?: true; cut?: true }, once = false): Promise<{ deny: string } | void> {
    // A call a hook changed is asked about as changed: the card says what the model wrote.
    const from = call.hook?.from;
    const changed = from === undefined ? undefined : `A hook of yours changed this call. The model asked for: ${(shellText(from) ?? JSON.stringify(from) ?? "").slice(0, 300)}`;
    const parked = this.recovered(session.id, call, once);
    // A new card is about to open: the owner's PermissionRequest hooks first.
    // A deny refuses the call. An allow answers the card where a PreToolUse
    // hook's allow would have (hookMayAnswer), and no other card.
    if (!parked && this.requestHook) {
      const r = await this.requestHook(session, call, name, { risk: ask.risk, why: ask.why, rule: ask.rule });
      if (r && "deny" in r) return r;
      if (r && "allow" in r && !once && !ask.autoOwner && this.hookMayAnswer(session, cls, ask)) {
        call.hook = { ...call.hook, allowed: call.hook?.allowed ?? "", skipped: true };
        return;
      }
    }
    const a: Approval = parked ?? {
      id: crypto.randomUUID(), session_id: session.id, call_id: call.id, tool: name, kind: cls.kind as Approval["kind"],
      summary, cut: ask.cut, notice: [ask.notice, changed].filter(Boolean).join(" ") || undefined,
      // Cards of one reply are made in the same millisecond: each gets a later time than the one before, so they list in call order.
      input: clip(call.input), input_sha: this.shaOf(session.id, call.input), ...inputLen(call.input), risk: ask.risk, why: ask.why, suggest: ask.suggest, state: "pending", created: (this.lastCard = Math.max(Date.now(), this.lastCard + 1)),
      once: once || undefined, bind: ask.bind, autoOwner: ask.autoOwner, ...placeOf(session, cls), ...(ask.rule ? { rule: ask.rule } : {}),
    };
    return this.wait(a, session, call, name, cls);
  }

  // The parked card of this call, when it is still for this call. An approval
  // is for exactly the input its card shows. The continued turn runs the call
  // again, and what a hook makes of it the second time may differ (another
  // input, or none when the hook fails): a card whose stored input is not the
  // input now judged is closed, answered or not, and the call is judged as new.
  private recovered(sessionId: string, call: ToolCall, once: boolean): Approval | undefined {
    const a = this.unpark(sessionId, call.id, once);
    if (!a) return undefined;
    // The whole input is compared, by its hash: the card's own copy is cut at
    // 20,000 characters, and an input can differ after that. A card an older
    // build wrote has no hash and is compared by that copy.
    const same = a.input_sha !== undefined ? a.input_sha === this.shaOf(sessionId, call.input)
      : JSON.stringify(a.input) === JSON.stringify(this.redact({ ...a, input: clip(call.input) }).input);
    if (same) return a;
    this.finish(a, { state: "cancelled", choice: undefined, reason: "the call changed since this card opened" });
    return undefined;
  }

  // The hash of a call's whole input as a card stores inputs: with secrets out.
  private shaOf(sessionId: string, input: unknown): string {
    return inputSha(this.redact({ session_id: sessionId, input } as Approval).input);
  }

  // A call was dispatched, or its result is stored: a card of it that a
  // restart left parked and nothing took back (a hook that asked before the
  // restart and not after it) would stay open and answer nothing. It closes.
  settled(sessionId: string, callId: string) {
    const key = callKey(sessionId, callId);
    const id = this.parked.get(key);
    if (id === undefined) return;
    this.parked.delete(key);
    const a = this.approval(id);
    if (a?.state === "pending") this.finish(a, { state: "cancelled", reason: "the call went on without this question" });
  }

  // A parked card of this call (a one-call card only for askOnce), taken back.
  private unpark(sessionId: string, callId: string, once: boolean): Approval | undefined {
    const key = callKey(sessionId, callId);
    const a = this.parked.has(key) ? this.approval(this.parked.get(key)!) : undefined;
    if (!a || !!a.once !== once) return undefined;
    this.parked.delete(key);
    return a;
  }

  // The turn waits on the card: shown (again, after a restart) until it is
  // answered; a card answered while nothing waited on it settles at once.
  private async wait(a: Approval, session: Session, call: ToolCall, name: string, cls: CallClass): Promise<{ deny: string } | void> {
    if (a.state === "denied") return { deny: a.choice === "deny" ? ownerDenial(a.reason) : a.reason ?? ownerDenial() };
    if (a.state === "cancelled") return { deny: "The turn was stopped before the owner answered." };
    if (a.state === "allowed") return void this.allowedCalls.add(call.id);
    this.save(a);
    const signal = call.ctx.signal;
    // The turn's signal is shared by all its calls: the listener goes when
    // the card is answered, so answered cards do not pile up on it.
    let onAbort = () => {};
    const out = await new Promise<{ allow: true } | { deny: string }>((resolve) => {
      this.waiting.set(a.id, { resolve, call, cls, session, name, once: a.once, bind: a.bind, facts: this.checking.get(callKey(session.id, call.id)) });
      onAbort = () => {
        if (!this.waiting.delete(a.id)) return;
        // Parked for a stop: the card stays open for the next daemon, which
        // runs the call again. A call a program made is not run again (the
        // program is gone with the daemon), so its card closes: left open, it
        // would take an answer and run nothing.
        if (this.parking.has(session.id) && !call.ctx.nestedIn) this.parked.set(callKey(session.id, call.id), a.id);
        else this.save({ ...a, state: "cancelled", reason: this.parking.has(session.id) ? "the daemon restarted before it was answered, and the program that asked no longer runs" : "the turn was stopped", resolved: Date.now() });
        resolve({ deny: "The turn was stopped before the owner answered." });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }).finally(() => signal.removeEventListener("abort", onAbort));
    if ("deny" in out) return out;
    this.allowedCalls.add(call.id);
    if (this.allowedCalls.size > 2000) this.allowedCalls.delete(this.allowedCalls.values().next().value!);
  }

  // Where a session's calls run, for the form of its cards (set by the fleet's routes).
  machineOf?: (sessionId: string) => { name: string; far?: boolean } | undefined;

  // A card as every client is given it (card.ts). Read once for a card: its
  // text, marks and hold do not change while it waits (the phone's lists, the
  // stream, a push and an answer all ask for it).
  private forms = new Map<string, { key: string; form: CardForm }>();
  form(a: Approval): CardForm {
    const here = this.machineOf?.(a.session_id);
    const key = `${here?.name ?? ""}\u0000${here?.far ? 1 : 0}`;
    const hit = this.forms.get(a.id);
    if (hit?.key === key) return hit.form.state === a.state ? hit.form : { ...hit.form, state: a.state };
    const form = cardForm(a, here);
    if (a.state === "pending") {
      this.forms.set(a.id, { key, form });
      if (this.forms.size > 500) this.forms.delete(this.forms.keys().next().value!);
    }
    return form;
  }

  // `hold`: the answer was an allow of a card its client did not show whole. The card stays open.
  resolve(id: string, sessionId: string, c: Choice): { ok: true } | { error: string; status: number; approval?: Approval; hold?: Hold[] } {
    const a = this.approval(id);
    if (!a || a.session_id !== sessionId) return { error: "no such approval", status: 404 };
    const w = this.waiting.get(id);
    // A card a restart left open is answered all the same: its call runs (or
    // not) when the continued turn reaches it again.
    const parked = !w && a.state === "pending" && this.parked.get(callKey(a.session_id, a.call_id)) === id;
    const session = w?.session ?? (parked ? this.store.session(sessionId) : undefined);
    // A closed card says how it ended; an open one nothing waits on can no longer be answered.
    if (a.state !== "pending" || !session) return { error: closedWhy(a), status: 409, approval: a };
    // Do not turn a parked or pre-Auto card into a standing grant under Auto.
    const auto = this.perm(sessionId).mode === "auto";
    if (c.choice !== "deny" && !a.once && (auto || a.autoOwner) && (parked || !auto || !a.autoOwner))
      return { error: interruptedApproval, status: 409, approval: a };
    // What widens what a session may do from here on (a standing answer) is never owed to a store
    // that takes no writes: it is said, and the card takes a one-time answer or a denial meanwhile.
    if ((c.choice === "session" || c.choice === "always") && this.store.refusing)
      return { error: "the daemon's store takes no writes right now, and a standing answer cannot be kept: allow this once, or deny it", status: 503 };
    if ((c.choice === "session" || c.choice === "always") && a.risk === "high")
      return { error: `this card covers its one call only (${a.why ?? a.notice ?? "it is asked about once"}): answer once or deny`, status: 400 };
    // Its turn was just parked and this daemon is on its way out: an answer
    // taken now would be lost with it (the card would read answered, the call
    // would never run, a denial would lose its reason). The card stays open
    // for the next daemon.
    if (parked && this.parking.has(a.session_id)) return { error: "Keel is restarting: answer again in a moment, when it is back", status: 503 };
    // (A notification shows one line: an answer from one never counts as having shown the text.)
    const seen = c.seen === "whole" && c.by?.client !== "notification" ? ("whole" as const) : undefined;
    const by: AnsweredBy = { client: "api", ...c.by, ...(seen ? { seen } : {}) };
    if (c.choice === "deny") {
      this.finish(a, { state: "denied", choice: "deny", reason: c.reason?.trim() || undefined, by });
      w?.resolve({ deny: ownerDenial(c.reason?.trim()) });
      return { ok: true };
    }
    // The read-first rule, for every client: an allow of a text one line does
    // not show whole comes with the client's word that it showed all of it.
    const form = this.form(a);
    const unread = refusal(form, c.choice, seen, by.client);
    if (unread) return { error: unread, status: 409, approval: a, hold: form.hold };
    if (c.choice === "session" || c.choice === "always") {
      const rules = (c.rules?.length ? c.rules : a.suggest).filter((r) => r.pattern?.trim());
      if (!rules.length) return { error: "nothing to grant: give a rule", status: 400 };
      // A tool grant is for the source the card judged (taken from the card, never the client).
      for (const r of rules) this.addRule(session, r.kind, r.pattern, c.choice, a.suggest.find((x) => x.kind === r.kind && x.pattern === r.pattern?.trim())?.bind ?? (r.kind === "tool" ? w?.bind ?? a.bind : undefined));
    }
    this.finish(a, { state: "allowed", choice: c.choice, by });
    // (An allow of a call the judge or the rules refused in this session before: the owner took that refusal back.)
    this.overridden("card", { session_id: a.session_id, shape: shapeOf(a.tool, a.summary) });
    w?.resolve({ allow: true });
    // A new grant may settle other open cards it covers: the ones a line shows
    // whole. A card that is read first stays open for its own answer.
    if (c.choice !== "once") this.recheck(() => true, { client: by.client, ...(by.device ? { device: by.device } : {}), ...(by.peer ? { peer: by.peer } : {}) });
    return { ok: true };
  }

  // One answer for several cards: each is allowed once, in the order given.
  // The owner answers these together only after reading each, so a card that
  // must be read on its own is never among them: one that is high risk, one
  // whose summary is only the start of its input, a refused call. A list that
  // names such a card is refused whole and nothing is allowed (the page left
  // it in by mistake). A card that is no longer open is passed over and the
  // rest are answered; the reply says how each one went, also when answering
  // one of them threw (`caught` records it): the ones before it stay allowed
  // and the page is told which.
  resolveMany(sessionId: string, ids: string[], caught?: (e: unknown, id: string) => void, from: Pick<Choice, "seen" | "by"> = {}): { results: BatchResult[] } | { error: string; status: number; alone: string[] } {
    const list = [...new Set(ids)];
    const alone = list.filter((id) => {
      const a = this.approval(id);
      return !!a && a.session_id === sessionId && a.state === "pending" && (a.risk === "high" || shownInPart(a) || !!a.once || a.kind === "refused");
    });
    if (alone.length) return { error: "these are answered one at a time: a high-risk request, or one shown only in part", status: 400, alone };
    return {
      results: list.map((id) => {
        try {
          const r = this.resolve(id, sessionId, { choice: "once", ...from });
          return "error" in r ? { id, error: r.error, status: r.status, state: r.approval?.state } : { id, ok: true as const };
        } catch (e) {
          caught?.(e, id);
          return { id, error: e instanceof Error ? e.message : String(e), status: 500, state: this.approval(id)?.state };
        }
      }),
    };
  }

  private finish(a: Approval, patch: Partial<Approval>) {
    this.waiting.delete(a.id);
    this.forms.delete(a.id);
    this.save({ ...a, ...patch, resolved: Date.now() }, true);
  }

  // After a mode or grant change: open cards that are now settled resolve.
  // A card that is read first (card.ts: its form has a hold) is never settled
  // by a rule made after it opened: a standing answer on the short card beside
  // it would otherwise allow text nobody was shown. It waits for its own
  // answer; the rule covers later calls, as any rule does. A mode change still
  // settles it: that is the owner's word about every call.
  // `from`: the client whose standing answer made the rule. A card it settles keeps that.
  private recheck(which: (w: Waiter) => boolean, from?: Omit<AnsweredBy, "seen" | "grant">) {
    for (const [id, w] of [...this.waiting]) {
      if (w.once || !which(w)) continue; // a one-call card only the owner answers
      const a = this.approval(id);
      if (!a) continue;
      const d = this.evaluate(w.session, w.name, w.cls, w.bind, w.facts, this.form(a).hold.length ? a.created : undefined);
      const mode = this.perm(w.session.id).mode;
      if (mode === "auto" || a.autoOwner) {
        if (mode === "auto" && a.autoOwner && !("deny" in d)) continue;
        const deny = "deny" in d ? d.deny : interruptedApproval;
        this.finish(a, { state: "denied", reason: deny });
        w.resolve({ deny });
        continue;
      }
      if ("allow" in d) {
        this.finish(a, { state: "allowed", choice: "once", reason: "settled by a grant or a mode change", ...(from ? { by: { ...from, grant: true as const } } : {}) });
        w.resolve({ allow: true });
      } else if ("deny" in d) {
        this.finish(a, { state: "denied", reason: d.deny });
        w.resolve({ deny: d.deny });
      } else if (mode === "full-auto") {
        // The session went to full auto with a card open: the card closes, and
        // the call is settled the way full auto settles it.
        this.finish(a, { state: "cancelled", reason: "settled without the owner in full auto" });
        const key = keyOf(w.name, w.bind ? { source: w.bind } : null, w.cls, w.call, a.summary);
        void this.alone(w.session, w.call, w.name, w.cls, a.summary, key, a.why).then((r) => w.resolve("deny" in r ? r : { allow: true }));
      }
    }
  }
}

const callKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;

// A page fetch with addresses the session has not seen that carry data (`fresh`: each with what it carries, as the
// gate found them) as the send it is: those addresses, each whole with its query. Any other class as it is.
function sentAs(c: CallClass, fresh: Map<string, string> | undefined): CallClass {
  if (c.kind !== "read" || !c.fetches?.length || !fresh?.size) return c;
  const held = c.fetches.filter((a) => fresh.has(a));
  const to = [...new Set(held.map(wholeOf))];
  const because = [...new Set(held.map((a) => fresh.get(a)!))].join(" and ");
  return to.length ? { kind: "send", to, shown: sendShown(to), because } : c;
}

// A refused call as judged: its tool on that source in that shape, and its input.
const keyOf = (name: string, target: { source?: string; shape?: string } | null, cls: CallClass, call: ToolCall, summary: string) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify([name, target?.source ?? null, target?.shape ?? null, cls.kind === "other" ? JSON.stringify(call.input ?? {}) : summary])).digest("hex").slice(0, 32);

const reasonOf = (r: string) => r.replace(/[.\s]+$/, "");


// How a card ended, for the client whose answer came second: what was
// answered, where from and how long ago ("already allowed (once) from the
// page, 3 s ago"), then the reason when one was given.
export function closedWhy(a: Approval, now = Date.now()): string {
  const why = a.reason ? `: ${a.reason}` : "";
  const by = a.by && (a.state === "allowed" || a.state === "denied") ? ` from ${whereSaid(a.by)}${a.resolved ? `, ${agoSaid(now - a.resolved)}` : ""}` : "";
  if (a.state === "allowed") return `already allowed (${a.choice === "once" || !a.choice ? "once" : a.choice === "session" ? "for this session" : "always"})${by}${why}`;
  if (a.state === "denied") return `already denied${by}${why}`;
  if (a.state === "cancelled") return `cancelled${why}`;
  return "nothing waits on this card any more: it can no longer be answered";
}

// What a card shows of a call: the command, the paths, or the start of the
// input. `cut` says the input goes on past what is shown.
function inShort(cls: CallClass, input: unknown): { summary: string; cut?: true } {
  if (cls.kind === "shell") return { summary: cls.command };
  if (cls.kind === "edit") return { summary: cls.paths.join("\n") };
  if (cls.kind === "drive" || cls.kind === "send") return { summary: cls.shown };
  const whole = JSON.stringify(input ?? {});
  return whole.length > SUMMARY_LIMIT ? { summary: whole.slice(0, SUMMARY_LIMIT), cut: true } : { summary: whole };
}

// Whether the reviewer model is sent the whole of an action: the judge's
// prompt holds the start of it (REVIEW_SUMMARY_LIMIT), and for a tool that
// is neither a command nor an edit its input in the same bound.
function readWhole(cls: CallClass, input: unknown, summary = ""): boolean {
  const judged = cls.kind === "shell" ? cls.command : cls.kind === "edit" ? cls.paths.join("\n") : cls.kind === "drive" || cls.kind === "send" ? cls.shown : JSON.stringify(input ?? {});
  return Math.max(judged.length, summary.length) <= REVIEW_SUMMARY_LIMIT;
}

// Where a command starts and what reads it, for its card. The folder is kept
// when it is not the session's own (a workdir, a session shell that moved);
// `away` when it is not under the session's folder either (on this machine by
// where the paths lead; on another machine by the paths as written).
function placeOf(session: Session, cls: CallClass): { at?: Approval["at"] } {
  if (cls.kind !== "shell") return {};
  const [root, cwd] = !cls.cwd ? ["", ""] : session.machine ? [session.workspace, cls.cwd] : [realOf(session.workspace), realOf(cls.cwd)];
  const moved = cwd !== root, own = contains(root, cwd);
  if (!moved && !cls.interpreter) return {};
  return { at: { ...(moved ? { cwd: cls.cwd } : {}), ...(moved && own ? { sub: relative(root, cwd) } : {}), ...(cls.interpreter ? { shell: cls.interpreter } : {}), ...(own ? {} : { away: true as const }) } };
}

// How long an input was, kept only when the card holds its start alone.
const inputLen = (v: any): { input_len?: number } => { const n = JSON.stringify(v ?? {}).length; return n > 20_000 ? { input_len: n } : {}; };

function clip(v: any): any {
  const s = JSON.stringify(v ?? {});
  if (s.length <= 20_000) return v;
  return { _clipped: s.slice(0, 20_000) };
}
