// The permission gate: every tool call passes its session's mode and the
// standing answers; what they do not settle becomes an approval card the
// turn waits on. Cards, grants and modes are stored. A card a restart left
// open (a crash, a kill, a stop) stays open: the continued turn runs its call
// again and waits on the same card, and an answer given before that is kept.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolAuthorization, ToolCall, ToolGate } from "../engine/hooks.ts";
import { preAllow } from "./autonomy.ts";
import { lookRepo, repoContext } from "./repofacts.ts";
import { confine } from "./sandbox.ts";
import { detect, placeholdersIn, vault } from "./secrets.ts";
import { splitCommand } from "./shell.ts";
import { artifactsDir, contains, realOf } from "../core/paths.ts";
import { SUMMARY_LIMIT, shownInPart } from "./summary.ts";
import { classify, decide, isMode, type Ask, type CallClass, type Decision, type Mode, type Rule, type RuleKind, type Suggest } from "./policy.ts";

// An edit is judged by where it sits (its folders' links resolved) and by
// where it lands (the file's own link followed too): a link inside the
// workspace that points out of it, or into .git, is judged as the place it
// names, and a link named like a file the repository runs (.envrc) stays that.
export const landing = (c: CallClass): CallClass =>
  c.kind === "edit" ? { kind: "edit", paths: [...new Set(c.paths.flatMap((p) => [join(realOf(dirname(p)), basename(p)), realOf(p)]))] } : c;

// What a call does, its relative paths resolved where the tool resolves them.
const cwdOf = (call: ToolCall) => call.tool.cwdOf?.(call.ctx, call.input);
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
  created: number;
  resolved?: number;
};

export type BatchResult = { id: string; ok: true } | { id: string; error: string; status: number; state?: Approval["state"] };
export type Choice = { choice: "once" | "session" | "always" | "deny"; reason?: string; rules?: Suggest[] };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perm_sessions (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, sandbox TEXT NOT NULL DEFAULT 'off', network INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS perm_rules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL, scope TEXT NOT NULL, lifetime TEXT NOT NULL, session_id TEXT, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS approvals_session ON approvals(session_id, created);
CREATE TABLE IF NOT EXISTS perm_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS perm_blocked (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS perm_blocked_session ON perm_blocked(session_id, created);
`;

// What the judge is asked (reviewer mode's calls, and full auto's high-risk
// ones with `high`: why the rules flagged it and the facts of where it lands),
// and what it answers.
export const REVIEW_SUMMARY_LIMIT = 4000;
export const REVIEW_INPUT_LIMIT = 2000;
export type ReviewAsk = { session: Session; tool: string; kind: string; summary: string; input: any; mode?: "auto"; cwd?: string; interpreter?: string; high?: { why: string; facts?: string } };
export type Verdict = { allow: boolean; risk: string; reason: string; model: string; ms?: number } | { unavailable: string };
// A call refused without the owner (the judge's refusal, a judge that could
// not answer, a repeat); the owner can let one retry of it through.
// `by`: who refused it; `count`: how often this exact call was refused.
export type Blocked = {
  id: string; session_id: string; calls?: string[]; tool: string; summary: string; reason: string; risk: string; model: string; key: string;
  by?: "reviewer" | "judge" | "unavailable" | "streak"; count?: number; retry?: boolean; created: number; last?: number;
};
// How a full-auto high-risk call was settled, for the activity list and alerts.
export type Judged = { session_id: string; call_id: string; tool: string; summary: string; outcome: "rule" | "judge" | "retry" | "refused" | "repeat" | "unavailable" | "streak"; reason: string; model?: string; ms?: number; blocked_id?: string };

// Refusals in a row in one turn after which the rest of its high-risk calls
// are refused without review (Claude Code falls back after 3 in a row, Codex
// stops the turn after 3): the work goes on, the loop of retries does not.
export const STREAK = 3;

type Waiter = { resolve: (d: { allow: true } | { deny: string }) => void; call: ToolCall; cls: CallClass; session: Session; name: string; once?: boolean; bind?: string };
type Target = Awaited<ReturnType<NonNullable<ToolCall["tool"]["target"]>>>;
type AutoReview = { ask: Ask; cwd?: string; input: unknown; interpreter?: string; valid: () => Promise<boolean> };
type AutoShell = { path: string; identity: string; interpreter: string };
type CheckResult = { deny: string } | { cls: CallClass; authorization?: ToolAuthorization };
const interruptedApproval = "The earlier approval cannot be used under Auto. Check the prior outcome before proposing the action again.";
const changedReview = { deny: "Refused: authorization or the action changed while permission was pending. Check the current permissions before proposing it again." };
const secretReview = { deny: "Refused: Auto cannot review an action that contains a secret or requires secret substitution. Use Ask to approve the action yourself." };

function hasSecret(input: unknown, values: string[]): boolean {
  if (typeof input === "string") return !!(placeholdersIn(input).length || values.some((v) => input.includes(v)) || detect(input).length);
  if (!input || typeof input !== "object") return false;
  return Object.entries(input).some(([k, v]) => hasSecret(k, values) || hasSecret(v, values));
}

function callClass(call: ToolCall, target: Target): CallClass {
  const cls = target ? target.cls ?? (target.readOnly ? { kind: "read" } : { kind: "other" }) : classifyCall(call);
  return landing(cls.kind === "shell" && !cls.cwd ? { ...cls, cwd: cwdOf(call) } : cls);
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

  constructor(private store: Store, private bus: Bus, private sandboxed: (s: Session, p: SessionPerm) => boolean = () => false) {
    store.migrate(SCHEMA);
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
    this.bus.emit({ t: "feature", name: "blocked", session_id: sessionId, data: b });
    return b;
  }

  perm(sessionId: string): SessionPerm {
    const r = this.store.db.query<{ mode: string; sandbox: string; network: number }, [string]>("SELECT mode, sandbox, network FROM perm_sessions WHERE session_id = ?").get(sessionId);
    if (r) return { session_id: sessionId, mode: isMode(r.mode) ? r.mode : "ask", sandbox: r.sandbox as SandboxProfile, network: !!r.network };
    return { session_id: sessionId, mode: this.defaultMode(), sandbox: this.defaultSandbox(), network: true };
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
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace, stdout: "pipe", stderr: "ignore" });
    const out = r.success ? r.stdout.toString().trim() : "";
    const root = out ? (out.endsWith("/.git") ? dirname(out) : out) : workspace;
    this.roots.set(workspace, root);
    return root;
  }

  rules(session?: Session): Rule[] {
    const all = this.store.db.query<Rule, []>("SELECT * FROM perm_rules ORDER BY created").all();
    if (!session) return all;
    return all.filter((r) => (r.lifetime === "session" ? r.session_id === session.id : contains(r.scope, session.workspace) || contains(r.scope, this.scopeOf(session.workspace))));
  }

  addRule(session: Session, kind: RuleKind, pattern: string, lifetime: "always" | "session", bind?: string): Rule {
    const rule: Rule = { id: crypto.randomUUID(), kind, pattern: pattern.trim(), scope: this.scopeOf(session.workspace), lifetime, session_id: lifetime === "session" ? session.id : null, created: Date.now(), bind: bind ?? null };
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

  private save(a: Approval) {
    a = this.redact(a);
    this.store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data")
      .run(a.id, a.session_id, a.state, JSON.stringify(a), a.created);
    this.bus.emit({ t: "feature", name: "approval", session_id: a.session_id, data: a });
  }

  private evaluate(session: Session, name: string, cls: CallClass, bind?: string): Decision {
    const p = this.perm(session.id);
    // Edits are judged where they land (links resolved), so the workspace is too.
    let root = session;
    for (let n = 0; root.parent_id && !root.machine && n < 32; n++) root = this.store.session(root.parent_id) ?? root;
    const scratch = session.machine ? [] : [realOf(artifactsDir(this.store.stateDir, root.id))];
    return decide(cls, { mode: p.mode, workspace: cls.kind === "edit" ? realOf(session.workspace) : session.workspace, sandboxed: this.sandboxed(session, p), rules: this.rules(session), tool: name, bind, scratch });
  }

  // The beforeTool hook: the gate first; a call it lets through runs confined
  // when the session's sandbox is on, unless the gate let it leave the sandbox
  // (an escalation the owner allowed). Confinement follows the class the gate
  // judged, never a field of the input.
  async beforeTool(session: Session, call: ToolCall): Promise<ToolGate> {
    const r = await this.check(session, call);
    if ("deny" in r) return r;
    const p = this.perm(session.id);
    const ctx: Partial<ToolCall["ctx"]> | undefined =
      !(r.cls.kind === "shell" && r.cls.escalate) && this.sandboxed(session, p) && p.sandbox !== "off"
        ? { wrapSpawn: (argv) => confine(argv, p, session.workspace, call.ctx.spillDir), confined: { sandbox: p.sandbox, network: p.network } }
        : undefined;
    if (!r.authorization) return ctx ? { ctx } : undefined;
    const auth = r.authorization;
    const wrap = ctx?.wrapSpawn ?? call.ctx.wrapSpawn;
    const confined = JSON.stringify(ctx?.confined ?? call.ctx.confined);
    return { ctx, authorization: {
      ...auth,
      valid: (now, input) => now.ctx.wrapSpawn === wrap && JSON.stringify(now.ctx.confined) === confined && auth.valid(now, input),
    } };
  }

  // A dispatcher (mcp_call) is judged as the tool it runs: its own read flag,
  // and grants for that tool alone. Returns the class it judged.
  async check(session: Session, call: ToolCall): Promise<CheckResult> {
    if (call.tool.confirm) return (await this.askOnce(session, call, call.tool.name, call.tool.confirm.why, call.tool.confirm.shown(call.input))) ?? { cls: { kind: "other" } };
    const target = call.tool.target ? await call.tool.target(call.input) : null;
    const name = target?.name ?? call.tool.name;
    const cls = callClass(call, target);
    const mode = this.perm(session.id).mode;
    const dir = mode === "auto" ? localShellDir(session, call, target, cls) : undefined;
    const d = this.evaluate(session, name, cls.kind === "shell" && dir ? { ...cls, cwd: dir.path } : cls, target?.source);
    // The call a restart cut while its card was open: that card again, settled
    // the way an open card is (the owner's answer, a grant or mode since, or waiting).
    const back = this.unpark(session.id, call.id, false) ?? (mode === "auto" ? this.unpark(session.id, call.id, true) : undefined);
    if (back) {
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
    if ("deny" in d) return { deny: d.deny };
    if (mode === "auto" && cls.kind !== "read" && hasSecret([call.input, target?.input, cls, dir?.path], vault.pairs().map(([value]) => value))) return secretReview;
    const checkShell = mode === "auto" && (cls.kind === "shell" || !!call.tool.autoShell);
    const shell = checkShell ? call.tool.autoShell?.(call.input ?? {}) : undefined;
    if (checkShell && (cls.kind !== "shell" || !shell || shell.command !== cls.command || !dir))
      return { deny: 'Refused: Auto cannot verify this shell invocation. Use a supported local non-login Bash command (for exec_command, shell: "bash" and login: false), or use Ask.' };
    const invocation = dir && shell ? { ...dir, interpreter: shell.interpreter } : undefined;
    if ("allow" in d) return { cls, ...(mode === "auto" ? { authorization: this.autoAuthorization(session, call, target, cls, false, invocation).authorization } : {}) };
    if (cls.kind === "control") return { cls };
    const { summary, cut } = inShort(cls, target ? target.input : call.input);
    const key = keyOf(name, target, cls, call, summary);
    if (mode === "auto") {
      const input = shell ? shell.options : target ? target.input : call.input;
      if ((!d.ask.ownerOnly || checkShell) && (summary.length > REVIEW_SUMMARY_LIMIT || JSON.stringify(input ?? {}).length > REVIEW_INPUT_LIMIT))
        return { deny: "Refused: the complete action does not fit in Auto review. Break it into smaller actions or use Ask for owner approval." };
      return this.checkAuto(session, call, target, cls, name, summary, d.ask, input, invocation, cut);
    }
    // Full auto: nothing waits on the owner. What would ask is high risk; it
    // goes to the rules, then the judge, and is run or refused at once.
    if (mode === "full-auto") return this.alone(session, call, name, cls, summary, key, d.ask.why);
    let notice: string | undefined;
    // Reviewer mode: what would ask goes to the reviewer first; a high-risk
    // action, and anything it cannot judge, still goes to the owner.
    if (mode === "reviewer" && d.ask.risk === "low") {
      if (this.retries.delete(`${session.id}\u0000${key}`)) return { cls };
      const v = await this.judge({ session, tool: name, kind: cls.kind, summary, input: clip(call.input) });
      if ("unavailable" in v) notice = `Reviewer unavailable: ${v.unavailable}. The owner answers this one.`;
      else if (v.allow) return { cls };
      else {
        this.block({ session_id: session.id, calls: [call.id], tool: name, summary, reason: v.reason, risk: v.risk, model: v.model, key, by: "reviewer" });
        return { deny: `The reviewer refused this call (risk ${v.risk}): ${v.reason.replace(/[.\s]+$/, "")}. Do not retry it as it is: take another way, or ask the owner, who can let one retry through.` };
      }
    }
    return (await this.card(session, call, name, cls, summary, { ...d.ask, notice, bind: target?.source, cut })) ?? { cls };
  }

  private autoAuthorization(session: Session, call: ToolCall, target: Target, cls: CallClass, exactDispatch: boolean, invocation?: AutoShell) {
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
        if (active() && now.tool === tool && JSON.stringify(now.input) === originalInput) currentTarget = await tool.target!(now.input);
      } : undefined,
      valid: (now, input) => {
        if (!active() || now.tool !== tool || now.ctx.signal !== signal || now.ctx.cwd !== cwd ||
            now.ctx.sessionId !== sessionId || now.ctx.spillDir !== spillDir ||
            ((exactDispatch || invocation) && now.ctx.dispatch !== dispatch) || JSON.stringify(input) !== originalInput) return false;
        const c = callClass(now, currentTarget);
        const dir = invocation ? localShellDir(session, now, currentTarget, c) : undefined;
        const shell = invocation ? tool.autoShell?.(now.input ?? {}) : undefined;
        return before === signature(now, currentTarget, c,
          dir && shell && c.kind === "shell" && shell.command === c.command ? { ...dir, interpreter: shell.interpreter } : undefined);
      },
    };
    return { authorization, before };
  }

  private async checkAuto(session: Session, call: ToolCall, target: Target, cls: CallClass, name: string, summary: string, ask: Ask, input: unknown, invocation?: AutoShell, cut?: true): Promise<CheckResult> {
    const { authorization, before } = this.autoAuthorization(session, call, target, cls, !ask.ownerOnly, invocation);
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
    const retry = `${session.id}\u0000${key}`;
    if (this.retries.has(retry)) {
      if (auto && !await auto.valid()) return changedReview;
      if (this.retries.delete(retry)) return ran("retry", "the owner let one retry through"), { cls };
    }
    if (!auto && cls.kind === "shell" && !cls.escalate) {
      const parts = splitCommand(cls.command);
      const rule = parts ? preAllow(parts, cls.cwd ?? session.workspace, homedir(), lookRepo) : null;
      if (rule) return ran("rule", rule), { cls };
    }
    const refuse = (b: Blocked, outcome: Judged["outcome"], text: string) => {
      this.streak.set(session.id, (this.streak.get(session.id) ?? 0) + (outcome === "unavailable" ? 0 : 1));
      ran(outcome, b.reason, { model: b.model, blocked_id: b.id });
      return { deny: text };
    };
    const again = this.store.db.query<{ data: string }, [string, string]>("SELECT data FROM perm_blocked WHERE session_id = ? AND json_extract(data, '$.key') = ? ORDER BY created DESC LIMIT 1").get(session.id, key);
    const prev = again ? (JSON.parse(again.data) as Blocked) : undefined;
    if (prev && !prev.retry && prev.by !== "unavailable" && prev.by !== "streak") {
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
    const high = !auto || auto.ask.risk === "high";
    const facts = high && cls.kind === "shell" ? repoContext(cls.command, auto?.cwd ?? cls.cwd ?? session.workspace, homedir(), session) : undefined;
    const v = await this.judge({ session, tool: name, kind: cls.kind, summary, input: auto ? auto.input : clip(call.input), mode: auto && "auto", cwd: auto?.cwd, interpreter: auto?.interpreter, high: high ? { why, facts } : undefined });
    if (auto && !await auto.valid()) return changedReview;
    if ("unavailable" in v) {
      const b = this.block({ ...base, calls: [call.id], reason: `The judge could not review it: ${v.unavailable}`, risk: "unknown", model: "", key, by: "unavailable" });
      return refuse(b, "unavailable", `Refused: this ${high ? "high-risk " : ""}call (${why}) needs the judge's review, and the judge could not give one (${reasonOf(v.unavailable)}). That is not proof it is unsafe. Take another way if there is one, or go on with the rest and report it; the owner can let one retry through.`);
    }
    if (v.allow) return ran("judge", v.reason, { model: v.model, ms: v.ms }), { cls };
    const b = this.block({ ...base, calls: [call.id], reason: v.reason, risk: v.risk, model: v.model, key, by: "judge" });
    return refuse(b, "refused", `Refused by the judge (risk ${v.risk}): ${reasonOf(v.reason)}. Do not retry it as it is or work around it: take a safer way, or finish the rest and tell the owner what you could not do. The owner can let one retry through.`);
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

  // Calls the owner allowed on a card (the protected-path sweep leaves their work alone).
  ownerAllowed(callId: string | undefined): boolean {
    return !!callId && this.allowedCalls.has(callId);
  }

  private async card(session: Session, call: ToolCall, name: string, cls: CallClass, summary: string,
    ask: { risk: "high" | "low"; why?: string; suggest: Suggest[]; notice?: string; bind?: string; autoOwner?: true; cut?: true }, once = false): Promise<{ deny: string } | void> {
    const a: Approval = this.unpark(session.id, call.id, once) ?? {
      id: crypto.randomUUID(), session_id: session.id, call_id: call.id, tool: name, kind: cls.kind as Approval["kind"],
      summary, cut: ask.cut, notice: ask.notice,
      // Cards of one reply are made in the same millisecond: each gets a later time than the one before, so they list in call order.
      input: clip(call.input), risk: ask.risk, why: ask.why, suggest: ask.suggest, state: "pending", created: (this.lastCard = Math.max(Date.now(), this.lastCard + 1)),
      once: once || undefined, bind: ask.bind, autoOwner: ask.autoOwner,
    };
    return this.wait(a, session, call, name, cls);
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
      this.waiting.set(a.id, { resolve, call, cls, session, name, once: a.once, bind: a.bind });
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

  resolve(id: string, sessionId: string, c: Choice): { ok: true } | { error: string; status: number; approval?: Approval } {
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
    if ((c.choice === "session" || c.choice === "always") && a.risk === "high")
      return { error: `this card covers its one call only (${a.why}): answer once or deny`, status: 400 };
    // Its turn was just parked and this daemon is on its way out: an answer
    // taken now would be lost with it (the card would read answered, the call
    // would never run, a denial would lose its reason). The card stays open
    // for the next daemon.
    if (parked && this.parking.has(a.session_id)) return { error: "Keel is restarting: answer again in a moment, when it is back", status: 503 };
    if (c.choice === "deny") {
      this.finish(a, { state: "denied", choice: "deny", reason: c.reason?.trim() || undefined });
      w?.resolve({ deny: ownerDenial(c.reason?.trim()) });
      return { ok: true };
    }
    if (c.choice === "session" || c.choice === "always") {
      const rules = (c.rules?.length ? c.rules : a.suggest).filter((r) => r.pattern?.trim());
      if (!rules.length) return { error: "nothing to grant: give a rule", status: 400 };
      // A tool grant is for the source the card judged (taken from the card, never the client).
      for (const r of rules) this.addRule(session, r.kind, r.pattern, c.choice, a.suggest.find((x) => x.kind === r.kind && x.pattern === r.pattern?.trim())?.bind ?? (r.kind === "tool" ? w?.bind ?? a.bind : undefined));
    }
    this.finish(a, { state: "allowed", choice: c.choice });
    w?.resolve({ allow: true });
    // A new grant may settle other open cards it covers.
    if (c.choice !== "once") this.recheck(() => true);
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
  resolveMany(sessionId: string, ids: string[], caught?: (e: unknown, id: string) => void): { results: BatchResult[] } | { error: string; status: number; alone: string[] } {
    const list = [...new Set(ids)];
    const alone = list.filter((id) => {
      const a = this.approval(id);
      return !!a && a.session_id === sessionId && a.state === "pending" && (a.risk === "high" || shownInPart(a) || !!a.once || a.kind === "refused");
    });
    if (alone.length) return { error: "these are answered one at a time: a high-risk request, or one shown only in part", status: 400, alone };
    return {
      results: list.map((id) => {
        try {
          const r = this.resolve(id, sessionId, { choice: "once" });
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
    this.save({ ...a, ...patch, resolved: Date.now() });
  }

  // After a mode or grant change: open cards that are now settled resolve.
  private recheck(which: (w: Waiter) => boolean) {
    for (const [id, w] of [...this.waiting]) {
      if (w.once || !which(w)) continue; // a one-call card only the owner answers
      const d = this.evaluate(w.session, w.name, w.cls, w.bind);
      const a = this.approval(id);
      if (!a) continue;
      const mode = this.perm(w.session.id).mode;
      if (mode === "auto" || a.autoOwner) {
        if (mode === "auto" && a.autoOwner && !("deny" in d)) continue;
        const deny = "deny" in d ? d.deny : interruptedApproval;
        this.finish(a, { state: "denied", reason: deny });
        w.resolve({ deny });
        continue;
      }
      if ("allow" in d) {
        this.finish(a, { state: "allowed", choice: "once", reason: "settled by a grant or a mode change" });
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

// A refused call as judged: its tool on that source in that shape, and its input.
const keyOf = (name: string, target: { source?: string; shape?: string } | null, cls: CallClass, call: ToolCall, summary: string) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify([name, target?.source ?? null, target?.shape ?? null, cls.kind === "other" ? JSON.stringify(call.input ?? {}) : summary])).digest("hex").slice(0, 32);

const reasonOf = (r: string) => r.replace(/[.\s]+$/, "");

// What the model gets for a call the owner denied.
const ownerDenial = (why?: string) => (why ? `The owner denied this call: ${why}` : "The owner denied this call. Do not retry it; take another way or ask.");

export function closedWhy(a: Approval): string {
  const why = a.reason ? `: ${a.reason}` : "";
  if (a.state === "allowed") return `already allowed (${a.choice === "once" || !a.choice ? "once" : a.choice === "session" ? "for this session" : "always"})${why}`;
  if (a.state === "denied") return `already denied${why}`;
  if (a.state === "cancelled") return `cancelled${why}`;
  return "nothing waits on this card any more: it can no longer be answered";
}

// What a card shows of a call: the command, the paths, or the start of the
// input. `cut` says the input goes on past what is shown.
function inShort(cls: CallClass, input: unknown): { summary: string; cut?: true } {
  if (cls.kind === "shell") return { summary: cls.command };
  if (cls.kind === "edit") return { summary: cls.paths.join("\n") };
  if (cls.kind === "drive") return { summary: cls.shown };
  const whole = JSON.stringify(input ?? {});
  return whole.length > SUMMARY_LIMIT ? { summary: whole.slice(0, SUMMARY_LIMIT), cut: true } : { summary: whole };
}

function clip(v: any): any {
  const s = JSON.stringify(v ?? {});
  if (s.length <= 20_000) return v;
  return { _clipped: s.slice(0, 20_000) };
}
