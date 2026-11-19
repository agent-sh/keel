// The permission gate: every tool call passes its session's mode and the
// standing answers; what they do not settle becomes an approval card the
// turn waits on. Cards, grants and modes are stored; a card left open by a
// restart is cancelled (nothing waits on it any more).
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall, ToolGate } from "../engine/hooks.ts";
import { confine } from "./sandbox.ts";
import { contains, realOf } from "../core/paths.ts";
import { classify, decide, isMode, type CallClass, type Decision, type Mode, type Rule, type RuleKind, type Suggest } from "./policy.ts";

// An edit is judged by where it sits (its folders' links resolved) and by
// where it lands (the file's own link followed too): a link inside the
// workspace that points out of it, or into .git, is judged as the place it
// names, and a link named like a file the repository runs (.envrc) stays that.
export const landing = (c: CallClass): CallClass =>
  c.kind === "edit" ? { kind: "edit", paths: [...new Set(c.paths.flatMap((p) => [join(realOf(dirname(p)), basename(p)), realOf(p)]))] } : c;

// What a call does, its relative paths resolved where the tool resolves them.
export const classifyCall = (call: ToolCall): CallClass => classify(call.tool, call.input, call.tool.cwdOf?.(call.ctx) ?? call.ctx.cwd);

export type SandboxProfile = "off" | "workspace-write" | "read-only";
export type SessionPerm = { session_id: string; mode: Mode; sandbox: SandboxProfile; network: boolean };

export type Approval = {
  id: string;
  session_id: string;
  call_id: string;
  tool: string;
  kind: Exclude<CallClass["kind"], "control">;
  summary: string;      // the command, or the paths, or the tool's input in short
  input: any;
  risk: "high" | "low";
  why?: string;         // why only "once" is offered
  notice?: string;      // why the owner is asked (the reviewer could not judge it)
  suggest: Suggest[];   // the grant "allow always" would store
  state: "pending" | "allowed" | "denied" | "cancelled";
  choice?: "once" | "session" | "always" | "deny";
  reason?: string;
  created: number;
  resolved?: number;
};

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

// What the reviewer of reviewer mode is asked, and what it answers.
export type ReviewAsk = { session: Session; tool: string; kind: string; summary: string; input: any };
export type Verdict = { allow: boolean; risk: string; reason: string; model: string } | { unavailable: string };
// A call the reviewer refused; the owner can let one retry of it through.
export type Blocked = { id: string; session_id: string; tool: string; summary: string; reason: string; risk: string; model: string; key: string; retry?: boolean; created: number };

type Waiter = { resolve: (d: { allow: true } | { deny: string }) => void; call: ToolCall; cls: CallClass; session: Session; name: string; once?: boolean };

export class Gate {
  private waiting = new Map<string, Waiter>();
  private roots = new Map<string, string>();
  private allowedCalls = new Set<string>();
  private retries = new Set<string>(); // session + call key: one retry the owner let through
  // Reviewer mode's judge (set by the permission routes, which hold the providers).
  judge: (a: ReviewAsk) => Promise<Verdict> = async () => ({ unavailable: "no reviewer is set up" });

  constructor(private store: Store, private bus: Bus, private sandboxed: (s: Session, p: SessionPerm) => boolean = () => false) {
    store.migrate(SCHEMA);
    const db = store.db;
    // Restart: no turn waits on an old card.
    for (const r of db.query<{ id: string; data: string }, []>("SELECT id, data FROM approvals WHERE state = 'pending'").all()) {
      const a = { ...(JSON.parse(r.data) as Approval), state: "cancelled" as const, reason: "the daemon restarted", resolved: Date.now() };
      db.query("UPDATE approvals SET state = 'cancelled', data = ? WHERE id = ?").run(JSON.stringify(a), r.id);
    }
  }

  setSandboxCheck(f: (s: Session, p: SessionPerm) => boolean) {
    this.sandboxed = f;
  }

  // Settings: the mode a new session starts in.
  defaultMode(): Mode {
    const v = this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get("default_mode")?.value;
    const env = process.env.KEEL_PERMISSION_MODE;
    return isMode(v) ? v : isMode(env) ? env : "ask";
  }
  setDefaultMode(m: Mode) {
    this.store.db.query("INSERT INTO perm_settings (key, value) VALUES ('default_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(m);
  }
  defaultSandbox(): SandboxProfile {
    const v = this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get("default_sandbox")?.value ?? process.env.KEEL_SANDBOX;
    return v === "workspace-write" || v === "read-only" ? v : "off";
  }
  setDefaultSandbox(p: SandboxProfile) {
    this.store.db.query("INSERT INTO perm_settings (key, value) VALUES ('default_sandbox', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(p);
  }

  setting(key: string): string | undefined {
    return this.store.db.query<{ value: string }, [string]>("SELECT value FROM perm_settings WHERE key = ?").get(key)?.value;
  }
  setSetting(key: string, value: string | null) {
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
    const next = { ...this.perm(sessionId), ...patch };
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

  addRule(session: Session, kind: RuleKind, pattern: string, lifetime: "always" | "session"): Rule {
    const rule: Rule = { id: crypto.randomUUID(), kind, pattern: pattern.trim(), scope: this.scopeOf(session.workspace), lifetime, session_id: lifetime === "session" ? session.id : null, created: Date.now() };
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(rule.id, rule.kind, rule.pattern, rule.scope, rule.lifetime, rule.session_id ?? null, rule.created);
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return rule;
  }

  // Revoked in this daemon: each can be put back once, exactly as it was (the Undo of a revoke).
  private revoked = new Map<string, Rule>();
  restore(id: string): Rule | null {
    const r = this.revoked.get(id);
    if (!r) return null;
    this.revoked.delete(id);
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.kind, r.pattern, r.scope, r.lifetime, r.session_id ?? null, r.created);
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return r;
  }

  revoke(id: string): boolean {
    const was = this.store.db.query<Rule, [string]>("SELECT * FROM perm_rules WHERE id = ?").get(id);
    if (was) this.revoked.set(id, was);
    const n = this.store.db.query("DELETE FROM perm_rules WHERE id = ?").run(id).changes;
    if (n) this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
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

  private evaluate(session: Session, name: string, cls: CallClass): Decision {
    const p = this.perm(session.id);
    // Edits are judged where they land (links resolved), so the workspace is too.
    return decide(cls, { mode: p.mode, workspace: cls.kind === "edit" ? realOf(session.workspace) : session.workspace, sandboxed: this.sandboxed(session, p), rules: this.rules(session), tool: name });
  }

  // The beforeTool hook: the gate first; a call it lets through runs confined
  // when the session's sandbox is on, unless the gate let it leave the sandbox
  // (an escalation the owner allowed). Confinement follows the class the gate
  // judged, never a field of the input.
  async beforeTool(session: Session, call: ToolCall): Promise<ToolGate> {
    const r = await this.check(session, call);
    if ("deny" in r) return r;
    const p = this.perm(session.id);
    if (r.cls.kind === "shell" && r.cls.escalate) return;
    if (this.sandboxed(session, p) && p.sandbox !== "off")
      return { ctx: { wrapSpawn: (argv) => confine(argv, p, session.workspace, call.ctx.spillDir), confined: { sandbox: p.sandbox, network: p.network } } };
  }

  // A dispatcher (mcp_call) is judged as the tool it runs: its own read flag,
  // and grants for that tool alone. Returns the class it judged.
  async check(session: Session, call: ToolCall): Promise<{ deny: string } | { cls: CallClass }> {
    const target = call.tool.target ? await call.tool.target(call.input) : null;
    const name = target?.name ?? call.tool.name;
    const cls: CallClass = landing(target ? (target.cls ?? (target.readOnly ? { kind: "read" } : { kind: "other" })) : classifyCall(call));
    const d = this.evaluate(session, name, cls);
    if ("allow" in d) return { cls };
    if ("deny" in d) return { deny: d.deny };
    if (cls.kind === "control") return { cls };
    const summary = cls.kind === "shell" ? cls.command : cls.kind === "edit" ? cls.paths.join("\n") : cls.kind === "drive" ? cls.shown : JSON.stringify(target ? target.input : call.input).slice(0, 400);
    let notice: string | undefined;
    // Reviewer mode: what would ask goes to the reviewer first; a high-risk
    // action, and anything it cannot judge, still goes to the owner.
    if (this.perm(session.id).mode === "reviewer" && d.ask.risk === "low") {
      const key = new Bun.CryptoHasher("sha256").update(`${name}\u0000${cls.kind === "other" ? JSON.stringify(call.input ?? {}) : summary}`).digest("hex").slice(0, 32);
      if (this.retries.delete(`${session.id}\u0000${key}`)) return { cls };
      const v = await this.judge({ session, tool: name, kind: cls.kind, summary, input: clip(call.input) });
      if ("unavailable" in v) notice = `Reviewer unavailable: ${v.unavailable}. The owner answers this one.`;
      else if (v.allow) return { cls };
      else {
        const b: Blocked = { id: crypto.randomUUID(), session_id: session.id, tool: name, summary: summary.slice(0, 2000), reason: v.reason, risk: v.risk, model: v.model, key, created: Date.now() };
        this.store.db.query("INSERT INTO perm_blocked (id, session_id, data, created) VALUES (?, ?, ?, ?)").run(b.id, b.session_id, JSON.stringify(this.redactAny(b)), b.created);
        this.bus.emit({ t: "feature", name: "blocked", session_id: session.id, data: b });
        return { deny: `The reviewer refused this call (risk ${v.risk}): ${v.reason.replace(/[.\s]+$/, "")}. Do not retry it as it is: take another way, or ask the owner, who can let one retry through.` };
      }
    }
    return (await this.card(session, call, name, cls, summary, { ...d.ask, notice })) ?? { cls };
  }

  // A card for this one call that only the owner answers (a hook asked): no
  // grant, mode change or reviewer settles it.
  async askOnce(session: Session, call: ToolCall, name: string, why: string): Promise<{ deny: string } | void> {
    const c = landing(classifyCall(call));
    const cls: CallClass = c.kind === "read" || c.kind === "control" ? { kind: "other" } : c;
    const summary = cls.kind === "shell" ? cls.command : cls.kind === "edit" ? cls.paths.join("\n") : cls.kind === "drive" ? cls.shown : JSON.stringify(call.input ?? {}).slice(0, 400);
    return this.card(session, call, name, cls, summary, { risk: "high", why, suggest: [] }, true);
  }

  // Calls the owner allowed on a card (the protected-path sweep leaves their work alone).
  ownerAllowed(callId: string | undefined): boolean {
    return !!callId && this.allowedCalls.has(callId);
  }

  private async card(session: Session, call: ToolCall, name: string, cls: CallClass, summary: string,
    ask: { risk: "high" | "low"; why?: string; suggest: Suggest[]; notice?: string }, once = false): Promise<{ deny: string } | void> {
    const a: Approval = {
      id: crypto.randomUUID(), session_id: session.id, call_id: call.id, tool: name, kind: cls.kind as Approval["kind"],
      summary, notice: ask.notice,
      input: clip(call.input), risk: ask.risk, why: ask.why, suggest: ask.suggest, state: "pending", created: Date.now(),
    };
    this.save(a);
    const signal = call.ctx.signal;
    const out = await new Promise<{ allow: true } | { deny: string }>((resolve) => {
      this.waiting.set(a.id, { resolve, call, cls, session, name, once });
      const onAbort = () => {
        if (!this.waiting.delete(a.id)) return;
        this.save({ ...a, state: "cancelled", reason: "the turn was stopped", resolved: Date.now() });
        resolve({ deny: "The turn was stopped before the owner answered." });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    if ("deny" in out) return out;
    this.allowedCalls.add(call.id);
    if (this.allowedCalls.size > 2000) this.allowedCalls.delete(this.allowedCalls.values().next().value!);
  }

  resolve(id: string, sessionId: string, c: Choice): { ok: true } | { error: string; status: number; approval?: Approval } {
    const a = this.approval(id);
    if (!a || a.session_id !== sessionId) return { error: "no such approval", status: 404 };
    const w = this.waiting.get(id);
    // A closed card says how it ended; an open one nothing waits on can no longer be answered.
    if (a.state !== "pending" || !w) return { error: closedWhy(a), status: 409, approval: a };
    if ((c.choice === "session" || c.choice === "always") && a.risk === "high")
      return { error: `this card covers its one call only (${a.why}): answer once or deny`, status: 400 };
    if (c.choice === "deny") {
      this.finish(a, { state: "denied", choice: "deny", reason: c.reason?.trim() || undefined });
      const why = c.reason?.trim();
      w.resolve({ deny: why ? `The owner denied this call: ${why}` : "The owner denied this call. Do not retry it; take another way or ask." });
      return { ok: true };
    }
    if (c.choice === "session" || c.choice === "always") {
      const rules = (c.rules?.length ? c.rules : a.suggest).filter((r) => r.pattern?.trim());
      if (!rules.length) return { error: "nothing to grant: give a rule", status: 400 };
      for (const r of rules) this.addRule(w.session, r.kind, r.pattern, c.choice);
    }
    this.finish(a, { state: "allowed", choice: c.choice });
    w.resolve({ allow: true });
    // A new grant may settle other open cards it covers.
    if (c.choice !== "once") this.recheck(() => true);
    return { ok: true };
  }

  private finish(a: Approval, patch: Partial<Approval>) {
    this.waiting.delete(a.id);
    this.save({ ...a, ...patch, resolved: Date.now() });
  }

  // After a mode or grant change: open cards that are now settled resolve.
  private recheck(which: (w: Waiter) => boolean) {
    for (const [id, w] of [...this.waiting]) {
      if (w.once || !which(w)) continue; // a one-call card only the owner answers
      const d = this.evaluate(w.session, w.name, w.cls);
      const a = this.approval(id);
      if (!a) continue;
      if ("allow" in d) {
        this.finish(a, { state: "allowed", choice: "once", reason: "settled by a grant or a mode change" });
        w.resolve({ allow: true });
      } else if ("deny" in d) {
        this.finish(a, { state: "denied", reason: d.deny });
        w.resolve({ deny: d.deny });
      }
    }
  }
}

export function closedWhy(a: Approval): string {
  const why = a.reason ? `: ${a.reason}` : "";
  if (a.state === "allowed") return `already allowed (${a.choice === "once" || !a.choice ? "once" : a.choice === "session" ? "for this session" : "always"})${why}`;
  if (a.state === "denied") return `already denied${why}`;
  if (a.state === "cancelled") return `cancelled${why}`;
  return "nothing waits on this card any more: it can no longer be answered";
}

function clip(v: any): any {
  const s = JSON.stringify(v ?? {});
  if (s.length <= 20_000) return v;
  return { _clipped: s.slice(0, 20_000) };
}
