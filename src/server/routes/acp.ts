// ACP agents keel-bun drives (src/acp/external.ts): the list (the ACP registry
// joined with what is installed, and the owner's own entries), adding and
// removing an entry, and the turn hook that hands an `acp:` session's turns to
// its agent. Permission requests and file access of the agent go through the gate.
import { confineAgent } from "../../acp/confine.ts";
import { allHooks, registerHooks, type TurnHooks } from "../../engine/hooks.ts";
import { registerSessionPatch, type RouteModule } from "../app.ts";
import { AcpProvider, readCustom, writeCustom } from "../../acp/agents.ts";
import { AcpRunner, isAcpModel, type Judge } from "../../acp/external.ts";
import type { Tool } from "../../tools/types.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

type G = { __keelAcp?: AcpRunner; __keelAcpHook?: TurnHooks; __keelAcpOff?: () => void };

export const acpRoutes: RouteModule = (deps) => {
  const g = globalThis as G;
  const provider = deps.providers.get("acp") as AcpProvider | undefined;
  if (!provider) return {};
  // The gate judges what the agent asks for as a call of that class: the
  // session's mode and grants first, else a card only the owner answers.
  const judge: Judge = async (s, c) => {
    if (!gate) return { deny: "the permission gate is not running" };
    const tool: Tool = {
      name: c.name, description: "", input_schema: {}, readOnly: c.cls.kind === "read",
      target: async () => ({ name: c.name, readOnly: c.cls.kind === "read", input: c.input, cls: c.cls }),
      run: async () => ({ content: "" }),
    } as Tool;
    const r = await gate.check(s, { id: c.id, tool, input: c.input, ctx: { sessionId: s.id, cwd: s.workspace, signal: c.signal, seen: new Map(), spillDir: "" } });
    return "deny" in r ? r : undefined;
  };
  g.__keelAcp?.dispose();
  // The agent's process follows the session's sandbox and network, as its commands would.
  const permOf = (sessionId?: string) => gate ? (sessionId ? gate.perm(sessionId) : { sandbox: gate.defaultSandbox(), network: true }) : { sandbox: "off" as const, network: true };
  const runner = (g.__keelAcp = new AcpRunner(deps.store, provider.agents, judge, (e, ctx) => deps.errors.capture("provider", e, ctx), (s, a) => confineAgent(a, permOf(s.id), s.workspace)));
  // Registered once per hook list (a hot reload may make a new one); it calls the runner of now.
  g.__keelAcpHook ??= { external: (s) => (g.__keelAcp?.claims(s) ? (io) => g.__keelAcp!.turn(s, io) : undefined) };
  if (!allHooks().includes(g.__keelAcpHook)) registerHooks(g.__keelAcpHook);
  g.__keelAcpOff?.();
  g.__keelAcpOff = deps.bus.on((f) => { if (f.t === "session" && (f.deleted || f.session.archived)) g.__keelAcp?.release(f.session.id); });

  // An agent keeps its own history: a session that has talked moves neither to
  // nor from an agent, nor between two (the other side would not know what was said).
  registerSessionPatch({
    id: "acp-model",
    fields: ["model"],
    check(s, body) {
      if (!body.model || body.model === s.model || (!isAcpModel(body.model) && !isAcpModel(s.model))) return;
      if (deps.store.events(s.id).some((e) => e.kind === "turn_start"))
        throw Object.assign(new Error("this session has a conversation: an ACP agent keeps its own history, so start a new session to talk to another agent or model"), { status: 409 });
    },
    apply() {},
  });

  const needs = (req: Request) => (!presence || presence.allows(req, "mcp-command") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "mcp-command" } }, 428));
  const listing = () => json({
    // How a new session's agent would run (the default sandbox): the card says it plainly.
    agents: provider.agents.list().map((a) => ({ ...a, installed: !!a.run, model: `acp:${a.id}`, run: a.run ? { command: a.run.command, args: a.run.args } : undefined,
      ...(a.run ? { sandbox: (({ confined, note }) => ({ confined, note }))(confineAgent(a, permOf(), deps.workspace, false)) } : {}) })),
    error: provider.agents.error,
    running: runner.running(),
  });

  return {
    "/api/acp/agents": {
      GET: async (req: Request) => {
        if (new URL(req.url).searchParams.get("refresh")) await deps.providers.refresh("acp");
        return listing();
      },
      // Add an agent: a command of the owner's, or a registry agent through its npx/uvx command.
      POST: async (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        const id = String(b.id ?? "").trim();
        if (!/^[\w.-]{1,64}$/.test(id)) return bad("an agent id is letters, digits, dot, dash or underscore");
        const custom = readCustom();
        if (b.command) custom[id] = { command: String(b.command), args: Array.isArray(b.args) ? b.args.map(String) : [], name: b.name ? String(b.name) : undefined };
        else {
          const a = provider.agents.list().find((x) => x.id === id);
          if (!a?.add) return bad(`${id} is not a registry agent that installs through npx or uvx here`, 404);
          custom[id] = { ...a.add, name: a.name };
        }
        writeCustom(custom);
        await deps.providers.refresh("acp");
        return listing();
      },
    },
    "/api/acp/agents/:id": {
      DELETE: async (req: any) => {
        const guard = needs(req);
        if (guard) return guard;
        const custom = readCustom();
        if (!custom[req.params.id]) return bad(`no agent of yours named ${req.params.id}`, 404);
        delete custom[req.params.id];
        writeCustom(custom);
        await deps.providers.refresh("acp");
        return listing();
      },
    },
  };
};
