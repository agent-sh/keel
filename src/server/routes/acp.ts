// ACP agents keel-bun drives (src/acp/external.ts): the list (the ACP registry
// joined with what is installed, and the owner's own entries), adding and
// removing an entry, and the turn hook that hands an `acp:` session's turns to
// its agent. Permission requests and file access of the agent go through the gate.
import { agentFolders, checkFolder, confineAgent, readFolders, writeFolders } from "../../acp/confine.ts";
import { allHooks, registerHooks, type TurnHooks } from "../../engine/hooks.ts";
import { registerSessionPatch, type RouteModule } from "../app.ts";
import { AcpProvider, readCustom, writeCustom } from "../../acp/agents.ts";
import { AcpRunner, agentOf, isAcpModel, type ChildHost, type Judge } from "../../acp/external.ts";
import * as agents from "../../automation/agents.ts";
import type { Terminals } from "../../acp/external.ts";
import type { Tool } from "../../tools/types.ts";
import { gate, presence } from "./permissions.ts";
import { homeDir } from "../../core/paths";

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
  // A terminal's command runs through the engine's chain (the owner's hooks, then the gate); a command the agent
  // asked about and the gate allowed is answered there once more without a card.
  const terminals: Terminals | undefined = gate ? { answered: (sid, command) => gate!.answeredOnce(sid, command) } : undefined;
  g.__keelAcp?.dispose();
  // The agent's process follows the session's sandbox and network, as its commands would.
  const permOf = (sessionId?: string) => gate ? (sessionId ? gate.perm(sessionId) : { sandbox: gate.defaultSandbox(), network: true }) : { sandbox: "off" as const, network: true };
  // What an agent offers (its models, else its modes) is asked of it once per program, as a new session's agent would run.
  provider.agents.argvOf = (a, cwd) => confineAgent(a, permOf(), cwd, false).argv;
  provider.agents.onLearned = () => void deps.providers.refresh("acp").catch((e) => deps.errors.capture("provider", e, { at: "acp listing" }));
  // The children an agent announces are agent rows under the session (src/automation/agents.ts, agents another program runs).
  const kids: ChildHost = {
    io: (sid) => deps.engine.passive(sid),
    find: (parent, child, conv) => {
      const a = agents.externalOf(parent, child, conv);
      const s = a && deps.store.session(a.session_id);
      return a && s && a.call_id ? { id: a.id, session: s, callId: a.call_id } : undefined;
    },
    create: (parent, o) => {
      const r = agents.createExternal(parent, { title: o.title, model: parent.model, agent: o.agent, child: o.child, conv: o.conv, callId: o.callId, status: o.reading.status, cancel: o.cancel, state: o.reading.state });
      return { id: r.agent.id, session: r.session, callId: o.callId };
    },
    patch: (id, p) => void agents.patchExternal(id, p),
    disconnect: (id) => agents.disconnectExternal(id),
    isChild: (sid) => !!agents.externalAgentOf(sid),
    limit: (parent) => agents.limitOf(parent),
  };
  const runner = (g.__keelAcp = new AcpRunner(deps.store, provider.agents, judge, (e, ctx) => deps.errors.capture("provider", e, ctx), (s, a, give) => confineAgent(a, permOf(s.id), s.workspace, true, give), terminals, kids));
  deps.engine.inputRefusals.set("acp-child", (id) => { const by = agents.externalAgentOf(id); return by ? `${by} runs this agent: it reads no message from here` : undefined; });
  // The owner's Stop on a child's row is the agent's cancel of that child.
  agents.outside.stop = (a, by) => (a.external ? g.__keelAcp?.cancelChild(a.id, by) : undefined);
  // Registered once per hook list (a hot reload may make a new one); it calls the runner of now.
  g.__keelAcpHook ??= { external: (s) => (g.__keelAcp?.claims(s) ? (io) => g.__keelAcp!.turn(s, io) : undefined) };
  if (!allHooks().includes(g.__keelAcpHook)) registerHooks(g.__keelAcpHook);
  g.__keelAcpOff?.();
  g.__keelAcpOff = deps.bus.on((f) => { if (f.t === "session" && (f.deleted || f.session.archived)) g.__keelAcp?.release(f.session.id); });

  // An agent keeps its own history: a session that has talked moves neither to
  // nor from an agent, nor between two (the other side would not know what was said).
  // Between the models (or modes) of its own agent it moves freely: the agent switches in place.
  registerSessionPatch({
    id: "acp-model",
    fields: ["model"],
    check(s, body) {
      if (!body.model || body.model === s.model || (!isAcpModel(body.model) && !isAcpModel(s.model))) return;
      if (isAcpModel(body.model) && isAcpModel(s.model) && agentOf(body.model) === agentOf(s.model)) return;
      if (deps.store.hasKind(s.id, "turn_start"))
        throw Object.assign(new Error("this session has a conversation: an ACP agent keeps its own history, so start a new session to talk to another agent or model"), { status: 409 });
    },
    apply() {},
  });

  const needs = (req: Request) => (!presence || presence.allows(req, "mcp-command") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "mcp-command" } }, 428));
  const listing = () => json({
    // How a new session's agent would run (the default sandbox): the card says it plainly.
    agents: provider.agents.list().map((a) => ({ ...a, installed: !!a.run, model: `acp:${a.id}`, run: a.run ? { command: a.run.command, args: a.run.args } : undefined,
      ...(a.run ? { sandbox: (({ confined, note }) => ({ confined, note }))(confineAgent(a, permOf(), deps.workspace, false)),
        // The folders it may write: the owner's list, else the guess by its name.
        folders: { list: a.folders ?? agentFolders(a, false).map((f) => (f.startsWith(homeDir() + "/") ? `~${f.slice(homeDir().length)}` : f)), own: !!a.folders } } : {}) })),
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
    // The slash commands a session's agent advertised (sent as typed: the agent reads them).
    "/api/acp/sessions/:id/commands": {
      GET: (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (!isAcpModel(s.model)) return json({ commands: [] });
        const r = runner.commands(s);
        // An agent not asked yet what it offers (its probe makes a session and keeps what it advertised) is asked now.
        const a = provider.agents.get(r.agent);
        if (!r.started && a) provider.agents.ask([a]);
        return json(r);
      },
    },
    // The agent's switches (its boolean options): what each is, and the owner's setting, sent before its next prompt.
    "/api/acp/sessions/:id/switches": {
      GET: (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (!isAcpModel(s.model)) return json({ switches: [] });
        return json(runner.switches(s));
      },
      PUT: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (!isAcpModel(s.model)) return bad("this session is not answered by an ACP agent");
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        const sw = runner.switches(s).switches.find((x) => x.id === b.id);
        if (!sw) return bad(`the agent offers no option ${b.id}`, 404);
        if (sw.held) return bad(`${sw.name} is about what the agent may do without asking: Keel's permission mode and sandbox decide that for this session`, 409);
        if (b.value !== null && typeof b.value !== "boolean") return bad("value is true, false, or null for the agent's own");
        const set = { ...(s.settings.acp_switches ?? {}) };
        if (b.value === null) delete set[sw.id];
        else set[sw.id] = b.value;
        const next = deps.store.mergeSettings(s.id, { acp_switches: Object.keys(set).length ? set : null });
        if (next) deps.bus.emit({ t: "session", session: next });
        return json(runner.switches(next ?? s));
      },
    },
    // The owner's writable folders for one agent; null goes back to the guess. Used from its next start.
    "/api/acp/agents/:id/folders": {
      PUT: async (req: any) => {
        const guard = needs(req);
        if (guard) return guard;
        const id = req.params.id;
        if (!provider.agents.list().some((a) => a.id === id)) return bad(`no agent named ${id}`, 404);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        const all = readFolders();
        if (b.folders === null) delete all[id];
        else {
          if (!Array.isArray(b.folders) || b.folders.length > 64) return bad("folders is a list of up to 64 paths, or null for the guess");
          const out: string[] = [];
          for (const f of b.folders) {
            const c = checkFolder(String(f));
            if (c.error !== undefined) return bad(c.error);
            if (!out.includes(c.path)) out.push(c.path);
          }
          all[id] = out;
        }
        writeFolders(all);
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
