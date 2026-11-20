// Permission gate routes and its beforeTool hook. app.ts wraps every handler
// so a throw is captured as an error.
import { deliver } from "../../automation/core.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { Gate, type SandboxProfile } from "../../safety/gate.ts";
import { asksLess, isMode, MODES } from "../../safety/policy.ts";
import { makeJudge } from "../../safety/judge.ts";
import { isLocal, Presence } from "../../safety/presence.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const PROFILES = ["off", "workspace-write", "read-only"];

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
  registerHooks({
    beforeTool: (s, call) => g.beforeTool(s, call),
    callOutcome: (sid, callId) => g.callOutcome(sid, callId),
    turnParking: (sid) => g.park(sid),
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
  const settings = () => ({ default_mode: g.defaultMode(), default_sandbox: g.defaultSandbox(), reviewer_model: g.setting("reviewer_model") ?? null, reviewer_policy: g.setting("reviewer_policy") ?? "", modes: MODES, sandbox: sandboxStatus() });

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
