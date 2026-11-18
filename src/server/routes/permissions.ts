// Permission gate routes and its beforeTool hook. app.ts wraps every handler
// so a throw is captured as an error.
import { registerHooks } from "../../engine/hooks.ts";
import { Gate, type SandboxProfile } from "../../safety/gate.ts";
import { isMode, MODES } from "../../safety/policy.ts";
import { confine, sandboxStatus } from "../../safety/sandbox.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const PROFILES = ["off", "workspace-write", "read-only"];

export let gate: Gate | undefined;

export const permissionRoutes: RouteModule = (deps: Deps) => {
  const { store } = deps;
  const g = (gate = new Gate(store, deps.bus, (_s, p) => p.sandbox !== "off" && sandboxStatus().available));
  const sb = sandboxStatus();
  if (!sb.available && g.defaultSandbox() !== "off") deps.errors.capture("server", new Error(`sandbox unavailable: ${sb.reason}`), { at: "startup" });
  registerHooks({
    // The gate first; a call it lets through runs confined when the session's sandbox is on.
    async beforeTool(s, call) {
      const refused = await g.check(s, call);
      if (refused) return refused;
      const p = g.perm(s.id);
      if (p.sandbox !== "off" && sb.available) return { ctx: { wrapSpawn: (argv) => confine(argv, p, s.workspace) } };
    },
  });

  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  const settings = () => ({ default_mode: g.defaultMode(), default_sandbox: g.defaultSandbox(), modes: MODES, sandbox: sandboxStatus() });

  return {
    "/api/permissions/settings": {
      GET: () => json(settings()),
      PUT: async (req: any) => {
        const b = await body(req);
        if (b.default_mode !== undefined) {
          if (!isMode(b.default_mode)) return bad(`unknown mode: ${b.default_mode}`);
          g.setDefaultMode(b.default_mode);
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
        return s ? json({ perm: g.perm(s.id), scope: g.scopeOf(s.workspace) }) : bad("no such session", 404);
      },
      PUT: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.mode !== undefined && !isMode(b.mode)) return bad(`unknown mode: ${b.mode}`);
        if (b.sandbox !== undefined && !PROFILES.includes(b.sandbox)) return bad(`unknown sandbox profile: ${b.sandbox}`);
        if (b.sandbox && b.sandbox !== "off" && !sandboxStatus().available) return bad(`the sandbox is unavailable: ${sandboxStatus().reason}`, 409);
        const patch: any = {};
        if (b.mode !== undefined) patch.mode = b.mode;
        if (b.sandbox !== undefined) patch.sandbox = b.sandbox;
        if (b.network !== undefined) patch.network = !!b.network;
        return json({ perm: g.setPerm(s.id, patch) });
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
        const rules = Array.isArray(b.rules) ? b.rules.filter((r: any) => ["shell", "edit", "tool"].includes(r?.kind) && typeof r.pattern === "string") : undefined;
        const r = g.resolve(req.params.aid, req.params.id, { choice: b.choice, reason: typeof b.reason === "string" ? b.reason : undefined, rules });
        return "error" in r ? bad(r.error, r.status) : json(r);
      },
    },
    "/api/permissions/grants": {
      GET: () => json({ grants: g.rules() }),
      POST: async (req: any) => {
        const b = await body(req);
        const s = store.session(b.session_id);
        if (!s) return bad("a grant names a session (its workspace is the scope)", 404);
        if (!["shell", "edit", "tool"].includes(b.kind) || typeof b.pattern !== "string" || !b.pattern.trim()) return bad("kind is shell, edit or tool, with a pattern");
        return json({ grant: g.addRule(s, b.kind, b.pattern, b.lifetime === "session" ? "session" : "always") }, 201);
      },
    },
    "/api/permissions/grants/:gid": {
      DELETE: (req: any) => (g.revoke(req.params.gid) ? json({ ok: true }) : bad("no such grant", 404)),
    },
  };
};
