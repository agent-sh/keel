// Permission gate routes and its beforeTool hook. app.ts wraps every handler
// so a throw is captured as an error.
import { deliver } from "../../automation/core.ts";
import { sandboxSaid } from "../../safety/refwatch.ts";
import { gitShut, linkedWorktree } from "../../safety/sandbox.ts";
import { escapeOf } from "../../safety/policy.ts";
import * as activity from "../../automation/activity.ts";
import { stopKind } from "../../core/stops.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { Gate, type SandboxProfile } from "../../safety/gate.ts";
import { asksLess, isMode, MODE_GROUPS, MODES } from "../../safety/policy.ts";
import { makeJudge } from "../../safety/judge.ts";
import { isLocal, Presence } from "../../safety/presence.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import type { Deps, RouteModule } from "../app.ts";
import { setGitReach } from "../../core/git.ts";
import { refusedSince } from "../../safety/net-proxy.ts";
import { sandboxScope, scopeDir } from "../../safety/sandbox-scope.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const PROFILES = ["off", "workspace-write", "read-only"];
// The longest list of cards one answer may name.
const MANY = 100;

export let gate: Gate | undefined;
export let presence: Presence | undefined;

// A mode that asks less than another (a remote device needs the owner's passkey to loosen one).
export { asksLess };

export const permissionRoutes: RouteModule = (deps: Deps) => {
  const { store } = deps;
  const g = (gate = new Gate(store, deps.bus, (_s, p) => p.sandbox !== "off" && sandboxStatus().available));
  const pk = (presence = new Presence(store));
  // 428 tells the page which action to get a passkey assertion for, then retry once.
  const needs = (req: Request, action: string) => (pk.allows(req, action) ? null : json({ error: "this needs your passkey from a remote device", presence: { action } }, 428));
  g.judge = makeJudge(store, deps.providers, () => g.setting("reviewer_model"), () => g.setting("reviewer_policy"));
  const sb = sandboxStatus();
  if (!sb.available && g.defaultSandbox() !== "off") deps.errors.capture("server", new Error(`sandbox unavailable: ${sb.reason}`), { at: "startup" });
  // What the daemon's own git may fetch for a session's worktree: as far as that session reaches.
  setGitReach((id) => g.gitReach(id));
  registerHooks({
    beforeTool: (s, call) => g.beforeTool(s, call),
    // What a confined command in a linked worktree changed outside its own
    // branch is said in its result and in the session's activity. What a
    // confined command ran into (the read-only top, the read-only config,
    // the network that is off) is said in its result, with the way this
    // tool asks to leave the sandbox.
    afterTool: async (s, call, result) => {
      const watched = await g.refsChanged(s.id, call.id);
      const confined = call.tool.kind === "shell" ? call.ctx.confined : undefined;
      if (!watched && !confined) return;
      const said = typeof result.content === "string" ? result.content : result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      const shut = confined ? sandboxSaid(said, { linked: !s.machine && !!linkedWorktree(s.workspace), network: !!confined.network, escape: escapeOf(call.tool), ...(s.machine ? {} : { shut: () => gitShut(s.workspace), refused: () => refusedSince(scopeDir(sandboxScope(s.workspace)), confined.since ?? Date.now()) }) }) : [];
      if (watched?.note) activity.record("approval", "sandbox", s.id, watched.note, { call_id: call.id });
      const text = [watched?.note && `[sandbox] ${watched.note} If this command did that and it was not asked for, put it back and say so.`, ...shut.map((line) => `[sandbox] ${line}`)].filter(Boolean).join("\n\n");
      if (!text) return;
      // (A result that says the turn was stopped under the call is read by its exact words.)
      if (typeof result.content !== "string") result.content = [...result.content, { type: "text", text }];
      else if (!stopKind(result.content)) result.content = result.content ? `${result.content}\n\n${text}` : text;
    },
    callOutcome: (sid, callId) => g.callOutcome(sid, callId),
    awaitsOwner: (sid, callId) => g.awaitsOwner(sid, callId),
    turnParking: (sid) => g.park(sid),
    // A call that was dispatched, or whose result is stored, has no use for a card a restart left parked for it.
    toolRan: (s, call) => g.settled(s.id, call.id),
    resultStored: (s, results) => { for (const r of results) g.settled(s.id, r.tool_use_id); },
    turnStart: (s) => g.turnStarted(s.id),
  });

  const presenceCall = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e) {
      const st = (e as any).status;
      if (st) return bad((e as Error).message, st);
      return bad(`the passkey could not be verified: ${(e as Error).message}`, 400);
    }
  };
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const settings = () => ({ default_mode: g.defaultMode(), default_sandbox: g.defaultSandbox(), reviewer_model: g.setting("reviewer_model") ?? null, reviewer_policy: g.setting("reviewer_policy") ?? "", modes: MODES, mode_groups: MODE_GROUPS, sandbox: sandboxStatus() });

  return {
    "/api/permissions/settings": {
      GET: () => json(settings()),
      PUT: async (req: any) => {
        const guard = needs(req, "settings");
        if (guard) return guard;
        const b = await body(req);
        if (b.default_mode !== undefined) {
          if (!isMode(b.default_mode)) return bad(`unknown mode: ${b.default_mode}`);
          g.setDefaultMode(b.default_mode);
        }
        if (typeof b.reviewer_policy === "string") g.setSetting("reviewer_policy", b.reviewer_policy.trim().slice(0, 8000) || null);
        if (b.reviewer_model !== undefined) {
          if (b.reviewer_model) await deps.providers.resolve(String(b.reviewer_model));
          g.setSetting("reviewer_model", b.reviewer_model ? String(b.reviewer_model) : null);
        }
        if (b.default_sandbox !== undefined) {
          if (!PROFILES.includes(b.default_sandbox)) return bad(`unknown sandbox profile: ${b.default_sandbox}`);
          g.setDefaultSandbox(b.default_sandbox as SandboxProfile);
        }
        return json(settings());
      },
    },
    "/api/sessions/:id/permissions": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        // `rev`: the bus frame this read reflects, so a page orders it against perm frames.
        return s ? json({ perm: g.perm(s.id), scope: g.scopeOf(s.workspace), rev: deps.bus.rev() }) : bad("no such session", 404);
      },
      PUT: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.mode !== undefined && !isMode(b.mode)) return bad(`unknown mode: ${b.mode}`);
        if (b.sandbox !== undefined && !PROFILES.includes(b.sandbox)) return bad(`unknown sandbox profile: ${b.sandbox}`);
        if (b.sandbox && b.sandbox !== "off" && !sandboxStatus().available) return bad(`the sandbox is unavailable: ${sandboxStatus().reason}`, 409);
        const cur = g.perm(s.id);
        const looser = (b.mode !== undefined && asksLess(b.mode, cur.mode)) || (b.sandbox === "off" && cur.sandbox !== "off") || (b.network === true && !cur.network);
        const guard = looser ? needs(req, `perm:${s.id}`) : null;
        if (guard) return guard;
        const patch: any = {};
        if (b.mode !== undefined) patch.mode = b.mode;
        if (b.sandbox !== undefined) patch.sandbox = b.sandbox;
        if (b.network !== undefined) patch.network = !!b.network;
        const perm = g.setPerm(s.id, patch);
        return json({ perm, rev: deps.bus.rev() });
      },
    },
    // What the judge refused without the owner (reviewer mode, full auto), newest first; the owner can let one retry through.
    "/api/sessions/:id/blocked": {
      GET: (req: any) => (store.session(req.params.id) ? json({ blocked: g.blocked(req.params.id), reviewer_model: g.setting("reviewer_model") ?? null }) : bad("no such session", 404)),
    },
    "/api/sessions/:id/blocked/:bid": {
      POST: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const guard = needs(req, `retry:${req.params.bid}`);
        if (guard) return guard;
        const b = g.allowRetry(s.id, req.params.bid);
        if (!b) return bad("no such refused call", 404);
        const text = `[harness] The owner let one retry of a refused call go through: ${b.tool} ${b.summary.slice(0, 300)}. The owner wants it run: run it again now, exactly as before; this one time it is not refused.`;
        deliver(s.id, text, { kind: "harness", origin: "harness" });
        return json({ ok: true, blocked: b });
      },
    },
    "/api/approvals": {
      GET: () => json({ approvals: g.approvals({ pending: true }) }),
    },
    "/api/sessions/:id/approvals": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const all = new URL(req.url).searchParams.has("all");
        return json({ approvals: g.approvals({ session: s.id, pending: !all }) });
      },
      // Several cards allowed once with one answer. The gate refuses the whole
      // list when it names a card that is answered alone (high risk, or shown
      // only in part): all of these are low risk and allowed once, which needs
      // no passkey from a remote device, as one such card does not.
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.choice !== "once") return bad("several requests are answered together only with choice once");
        if (!Array.isArray(b.ids) || !b.ids.length || !b.ids.every((x: unknown) => typeof x === "string")) return bad("ids is a list of approval ids");
        // More than a page can show to be read at once is not a list the owner answered.
        if (b.ids.length > MANY) return bad(`at most ${MANY} requests are answered together`);
        const r = g.resolveMany(s.id, b.ids, (e, id) => deps.errors.capture("server", e, { at: "approvals answered together", approval: id }));
        return "error" in r ? json({ error: r.error, alone: r.alone }, r.status) : json(r);
      },
    },
    "/api/sessions/:id/approvals/:aid": {
      POST: async (req: any) => {
        const b = await body(req);
        if (!["once", "session", "always", "deny"].includes(b.choice)) return bad("choice is once, session, always or deny");
        // A high-risk card, or a standing answer, from a remote device: the owner's passkey.
        const card = g.approval(req.params.aid);
        if (card && b.choice !== "deny" && (card.risk === "high" || b.choice !== "once")) {
          const guard = needs(req, `approval:${card.id}`);
          if (guard) return guard;
        }
        const rules = Array.isArray(b.rules) ? b.rules.filter((r: any) => ["shell", "edit", "tool"].includes(r?.kind) && typeof r.pattern === "string") : undefined;
        const r = g.resolve(req.params.aid, req.params.id, { choice: b.choice, reason: typeof b.reason === "string" ? b.reason : undefined, rules });
        return "error" in r ? json({ error: r.error, approval: r.approval }, r.status) : json(r);
      },
    },
    "/api/permissions/grants": {
      GET: () => json({ grants: g.rules() }),
      POST: async (req: any) => {
        const guard = needs(req, "grant");
        if (guard) return guard;
        const b = await body(req);
        const s = store.session(b.session_id);
        if (!s) return bad("a grant names a session (its workspace is the scope)", 404);
        if (!["shell", "edit", "tool"].includes(b.kind) || typeof b.pattern !== "string" || !b.pattern.trim()) return bad("kind is shell, edit or tool, with a pattern");
        return json({ grant: g.addRule(s, b.kind, b.pattern, b.lifetime === "session" ? "session" : "always") }, 201);
      },
    },
    // Passkeys: enrolled at the desk, or on a device with a code shown at the desk.
    "/api/owner-presence": {
      GET: (req: any) => {
        const o = req.headers.get("origin");
        let rp: string | null = null;
        try { rp = o ? new URL(o).hostname : null; } catch {}
        return json({ local: isLocal(req), enrolled: pk.enrolled(), rp_id: rp, passkeys: pk.list() });
      },
    },
    "/api/owner-presence/code": {
      POST: (req: any) => (isLocal(req) ? json(pk.code()) : bad("the enrollment code is shown at the desk only", 403)),
    },
    "/api/owner-presence/register/start": {
      POST: async (req: any) => presenceCall(async () => json(await pk.registerStart(req, (await body(req)).code))),
    },
    "/api/owner-presence/register/finish": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        return json({ ok: true, ...(await pk.registerFinish(req, String(b.ceremony ?? ""), b.credential, b.label)) });
      }),
    },
    "/api/owner-presence/authenticate/start": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        if (typeof b.action !== "string" || !b.action) return bad("name the action to sign");
        return json(await pk.authStart(req, b.action));
      }),
    },
    "/api/owner-presence/authenticate/finish": {
      POST: async (req: any) => presenceCall(async () => {
        const b = await body(req);
        return json(await pk.authFinish(req, String(b.ceremony ?? ""), b.credential));
      }),
    },
    "/api/owner-presence/:pid": {
      DELETE: (req: any) => {
        const guard = needs(req, `passkey-remove:${req.params.pid}`);
        if (guard) return guard;
        return pk.remove(req.params.pid) ? json({ ok: true }) : bad("no such passkey", 404);
      },
    },
    "/api/permissions/grants/:gid/restore": {
      POST: (req: any) => {
        const guard = needs(req, "grant");
        if (guard) return guard;
        const r = g.restore(req.params.gid);
        return r ? json({ grant: r }) : bad("no revoke of that grant to undo in this daemon", 400);
      },
    },
    "/api/permissions/grants/:gid": {
      DELETE: (req: any) => (g.revoke(req.params.gid) ? json({ ok: true }) : bad("no such grant", 404)),
    },
  };
};
