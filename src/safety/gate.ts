// The permission gate: every tool call passes its session's mode and the
// standing answers; what they do not settle becomes an approval card the
// turn waits on. Cards, grants and modes are stored; a card left open by a
// restart is cancelled (nothing waits on it any more).
import { dirname } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { classify, decide, inside, isMode, type CallClass, type Decision, type Mode, type Rule, type RuleKind, type Suggest } from "./policy.ts";

export type SandboxProfile = "off" | "workspace-write" | "read-only";
export type SessionPerm = { session_id: string; mode: Mode; sandbox: SandboxProfile; network: boolean };

export type Approval = {
  id: string;
  session_id: string;
  call_id: string;
  tool: string;
  kind: CallClass["kind"];
  summary: string;      // the command, or the paths, or the tool's input in short
  input: any;
  risk: "high" | "low";
  why?: string;         // why only "once" is offered
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
`;

type Waiter = { resolve: (d: { allow: true } | { deny: string }) => void; call: ToolCall; cls: CallClass; session: Session };

export class Gate {
  private waiting = new Map<string, Waiter>();
  private roots = new Map<string, string>();

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
    const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspace, stdout: "pipe", stderr: "ignore" });
    const out = r.success ? r.stdout.toString().trim() : "";
    const root = out ? (out.endsWith("/.git") ? dirname(out) : out) : workspace;
    this.roots.set(workspace, root);
    return root;
  }

  rules(session?: Session): Rule[] {
    const all = this.store.db.query<Rule, []>("SELECT * FROM perm_rules ORDER BY created").all();
    if (!session) return all;
    return all.filter((r) => (r.lifetime === "session" ? r.session_id === session.id : inside(session.workspace, r.scope) || inside(this.scopeOf(session.workspace), r.scope)));
  }

  addRule(session: Session, kind: RuleKind, pattern: string, lifetime: "always" | "session"): Rule {
    const rule: Rule = { id: crypto.randomUUID(), kind, pattern: pattern.trim(), scope: this.scopeOf(session.workspace), lifetime, session_id: lifetime === "session" ? session.id : null, created: Date.now() };
    this.store.db.query("INSERT INTO perm_rules (id, kind, pattern, scope, lifetime, session_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(rule.id, rule.kind, rule.pattern, rule.scope, rule.lifetime, rule.session_id ?? null, rule.created);
    this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return rule;
  }

  revoke(id: string): boolean {
    const n = this.store.db.query("DELETE FROM perm_rules WHERE id = ?").run(id).changes;
    if (n) this.bus.emit({ t: "feature", name: "grants", data: { changed: true } });
    return n > 0;
  }

  approvals(opts: { session?: string; pending?: boolean } = {}): Approval[] {
    const rows = opts.session
      ? this.store.db.query<{ data: string }, [string]>("SELECT data FROM approvals WHERE session_id = ? ORDER BY created").all(opts.session)
      : this.store.db.query<{ data: string }, []>("SELECT data FROM approvals ORDER BY created DESC LIMIT 500").all().reverse();
    const all = rows.map((r) => JSON.parse(r.data) as Approval);
    return opts.pending ? all.filter((a) => a.state === "pending") : all;
  }

  approval(id: string): Approval | undefined {
    const r = this.store.db.query<{ data: string }, [string]>("SELECT data FROM approvals WHERE id = ?").get(id);
    return r ? JSON.parse(r.data) : undefined;
  }

  private save(a: Approval) {
    this.store.db.query("INSERT INTO approvals (id, session_id, state, data, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data")
      .run(a.id, a.session_id, a.state, JSON.stringify(a), a.created);
    this.bus.emit({ t: "feature", name: "approval", session_id: a.session_id, data: a });
  }

  private evaluate(session: Session, call: ToolCall, cls: CallClass): Decision {
    const p = this.perm(session.id);
    return decide(cls, { mode: p.mode, workspace: session.workspace, sandboxed: this.sandboxed(session, p), rules: this.rules(session), tool: call.tool.name });
  }

  // The beforeTool hook.
  async check(session: Session, call: ToolCall): Promise<{ deny: string } | void> {
    const cls = classify(call.tool, call.input, call.ctx.cwd);
    const d = this.evaluate(session, call, cls);
    if ("allow" in d) return;
    if ("deny" in d) return { deny: d.deny };
    const a: Approval = {
      id: crypto.randomUUID(), session_id: session.id, call_id: call.id, tool: call.tool.name, kind: cls.kind,
      summary: cls.kind === "shell" ? cls.command : cls.kind === "edit" ? cls.paths.join("\n") : JSON.stringify(call.input).slice(0, 400),
      input: clip(call.input), risk: d.ask.risk, why: d.ask.why, suggest: d.ask.suggest, state: "pending", created: Date.now(),
    };
    this.save(a);
    const signal = call.ctx.signal;
    const out = await new Promise<{ allow: true } | { deny: string }>((resolve) => {
      this.waiting.set(a.id, { resolve, call, cls, session });
      const onAbort = () => {
        if (!this.waiting.delete(a.id)) return;
        this.save({ ...a, state: "cancelled", reason: "the turn was stopped", resolved: Date.now() });
        resolve({ deny: "The turn was stopped before the owner answered." });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    if ("deny" in out) return out;
  }

  resolve(id: string, sessionId: string, c: Choice): { ok: true } | { error: string; status: number } {
    const a = this.approval(id);
    if (!a || a.session_id !== sessionId) return { error: "no such approval", status: 404 };
    const w = this.waiting.get(id);
    if (a.state !== "pending" || !w) return { error: "this approval is not open", status: 409 };
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
      if (!which(w)) continue;
      const d = this.evaluate(w.session, w.call, w.cls);
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

function clip(v: any): any {
  const s = JSON.stringify(v ?? {});
  if (s.length <= 20_000) return v;
  return { _clipped: s.slice(0, 20_000) };
}
