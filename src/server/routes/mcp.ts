import { mcpLine, say } from "../../admin/daemon-log.ts";
import { registerSocket, type RouteModule } from "../app.ts";
import { McpManager } from "../../mcp/manager.ts";
import { changeDigest } from "../../mcp/pins.ts";
import { installMcpTools } from "../../mcp/tools.ts";
import { bindMcpCalls } from "../../automation/mcp-calls.ts";
import { installMcpSkills } from "../../mcp/skill-tools.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { installChromeBridge } from "../../integrations/chrome.ts";
import { installPhone } from "../../integrations/phone.ts";
import { installTacitServer } from "../../integrations/tacit-mcp.ts";
import { memoryOn } from "../../integrations/tacit.ts";
import { isAgentKey, ProjectServers } from "../../mcp/project.ts";
import { agentServers, defOfSession } from "../../automation/agents.ts";
import { readsOf } from "../reads.ts";
import { configPath, readConfig, serverFromJson, type McpServerConfig } from "../../mcp/config.ts";
import { endpoint, importHome } from "../../mcp/sources.ts";
import { access, connectorConfig, ghSignedIn, keelName, REGISTRY, searchRegistry, SUGGESTED } from "../../mcp/connectors.ts";
import { catalogSources, catalogTools, sessionOff } from "../../tools/catalog.ts";
import { score } from "../../mcp/tools.ts";
import { gate, presence } from "./permissions.ts";
import { hookMcp } from "../../integrations/hooks.ts";
import * as activity from "../../automation/activity.ts";
import * as channels from "../../automation/channels.ts";
import { confine, sandboxStatus } from "../../safety/sandbox.ts";
import { readOptsFor } from "../../safety/sandbox-config.ts";
import { sandboxScope } from "../../safety/sandbox-view.ts";
import { alertHook } from "../../automation/core.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

const page = (title: string, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
      `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="opacity:.7">${text}</p></div>` +
      `<script>setTimeout(() => window.close(), 1500)</script>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

// The server no longer knew Keel's client: one line, then the browser goes on to the sign-in of the new one.
const retryPage = (line: string, url: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Signing in again</title><meta http-equiv="refresh" content="3;url=${escape(url)}"><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
      `<div style="text-align:center"><h2 style="font-weight:600">Signing in again</h2><p style="opacity:.7">${escape(line)}</p><p><a href="${escape(url)}">Continue</a></p></div>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const mcpRoutes: RouteModule = (deps) => {
  // Under `bun --hot` this module runs again: close the old servers first.
  const g = globalThis as { __keelMcp?: McpManager; __keelMcpSaid?: boolean };
  g.__keelMcp?.dispose();
  // The daemon's manager is the one that reads and writes the owner's server list.
  const m = new McpManager(deps.errors, deps.store.stateDir, deps.workspace, configPath());
  m.elsewhere = (id) => { const at = deps.store.session(id)?.machine; return !!at && at !== "local"; };
  // A server's sampling request is answered by the session's own model, once the owner allowed it on the card.
  m.sampler = {
    size: (id, req) => deps.engine.sampleSize(id, req),
    run: (id, req, signal) => deps.engine.sample(id, req, signal),
  };
  g.__keelMcp = m;
  // A server that changed its tools is told to the owner once a change (src/mcp/pins.ts); the model is offered what the owner accepted.
  const list = (n: string[]) => (n.length > 4 ? `${n.slice(0, 4).join(", ")} and ${n.length - 4} more` : n.join(", "));
  m.onToolsHeld = (name, changes, instructions, skills) => {
    const added = changes.filter((c) => c.kind === "added").map((c) => c.name), changed = changes.filter((c) => c.kind === "changed").map((c) => c.name);
    const what = [changed.length ? `changed ${list(changed)}` : "", added.length ? `added ${list(added)}` : "", instructions ? "rewrote its instructions" : "", skills?.length ? `serves skills you have not allowed (${list(skills.map((k) => k.name))})` : ""].filter(Boolean);
    const said = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : what[0];
    // Entries that are one server (the same command, or the same tools) each report the change: one notice names them all.
    const names = [name, ...m.twinsOf(name)].sort();
    const who = names.length > 1 ? `${list(names.slice(0, -1))} and ${names.at(-1)}` : name;
    const accept = `Sessions keep the definitions and instructions you accepted, and a new tool${skills?.length ? " or skill" : ""} is not offered, until you accept the change in Customize > MCP servers.`;
    const only = !changes.length && !instructions && !!skills?.length;
    alertHook.raise?.("mcp", null, only ? `${name} serves skills` : names.length > 1 ? `${who} changed their tools` : `${name} changed its tools`,
      names.length > 1 ? `The MCP servers ${who} are one server configured twice. It ${said}. ${accept}` : `The MCP server ${name} ${said}. ${accept}`,
      { mcp_server: name, ...(names.length > 1 ? { mcp_servers: names } : {}), mcp_change: changeDigest(changes, instructions, skills) });
  };
  // Servers set up before pins were kept are pinned as they list now: the owner is told once, to look them over.
  m.onUpgradePinned = (names) => {
    const n = names.length;
    alertHook.raise?.("mcp", null, `${n} server${n === 1 ? " was" : "s were"} pinned as ${n === 1 ? "it is" : "they are"} now: review in Customize > MCP servers`, `Keel now pins each MCP server's tools and instructions, and holds a later change until you accept it. ${list(names)} ${n === 1 ? "was" : "were"} set up before, so what ${n === 1 ? "it lists" : "they list"} now was taken as accepted. Look ${n === 1 ? "it" : "them"} over in Customize > MCP servers.`, n === 1 ? { mcp_server: names[0] } : {});
  };
  installMcpTools(m);
  bindMcpCalls(m);
  installMcpSkills(m);
  // A call whose server asked the owner a question waits on the owner: a
  // drain does not wait for it, and a restart asks again on the same card.
  registerHooks({
    awaitsOwner: (sessionId, callId) => m.awaitsOwner(sessionId, callId),
    callOutcome: (sessionId, callId) => (m.askedBefore(sessionId, callId) ? "waiting" : undefined),
    turnParking: (sessionId) => m.park(sessionId),
  });
  installChromeBridge(m);
  installPhone(m);
  installTacitServer(m, (id) => memoryOn(deps.store, id));
  m.start();
  // A project's .mcp.json: its servers the owner approved go to the sessions working in it, from each turn's start.
  const projects = new ProjectServers(deps.store, m);
  // The owner's approvals in Claude Code are read off the loop (its ~/.claude.json is large).
  const reads = readsOf(deps.store);
  projects.read = (files, roots) => reads.run("claude.mcpChoices", { files, roots });
  projects.onPending = (sid, root, names) => {
    const one = names.length === 1;
    if (isAgentKey(root)) {
      // An agent file's: said in the agent's session and in its parent's, where the owner follows it.
      const text = `The agent file ${root} defines ${one ? "a server" : "servers"} of its own waiting for your approval: ${names.join(", ")}. The agent works without ${one ? "it" : "them"} until you approve ${one ? "it" : "them"} in Customize > MCP servers.`;
      // (Its session names its parent from its start, before its agent's record is written.)
      const parent = deps.store.db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?").get(sid)?.parent_id;
      for (const id of parent ? [sid, parent] : [sid]) deps.bus.emit({ t: "event", event: deps.store.append(id, "note", { kind: "mcp-project", text, servers: names, root }) });
      return;
    }
    const ev = deps.store.append(sid, "note", { kind: "mcp-project", text: `This project's .mcp.json (${root}) names ${one ? "a server" : "servers"} waiting for your approval: ${names.join(", ")}. ${one ? "It is" : "They are"} not started until you approve ${one ? "it" : "them"} in Customize > MCP servers.`, servers: names, root });
    deps.bus.emit({ t: "event", event: ev });
  };
  // An agent file's own servers: given to its agent at its start and at each of its turns, ended when it finishes.
  agentServers.give = (child, file) => projects.refreshAgent(child, file);
  agentServers.release = (id) => projects.releaseAgent(id);
  registerHooks({ turnStart: (s) => {
    try { projects.refresh(s); } catch (e) { deps.errors.capture("server", e, { at: "mcp project servers", session: s.id }); }
    try { const def = defOfSession(s.id); if (def?.file && def.ownServers?.length) projects.refreshAgent(s, def.file); } catch (e) { deps.errors.capture("server", e, { at: "mcp agent file servers", session: s.id }); }
  } });
  // Once a process, when the servers had a moment to connect: one line of what was found (daemon-log.ts).
  if (!g.__keelMcpSaid) {
    g.__keelMcpSaid = true;
    setTimeout(() => { try { say(mcpLine((g.__keelMcp ?? m).list().map((x: { name: string; state: string }) => ({ name: x.name, state: x.state })))); } catch {} }, Number(process.env.KEEL_MCP_SAID_MS) || 8000).unref?.();
  }
  // An mcp_tool hook: a tool of a server that is connected or connects in time, called as the hook file's owner asked.
  hookMcp.call = async (server, tool, input, ms) => {
    // A plugin's hook names its own server as plugin:<id>:<server>, whatever name that server has now.
    const client = await m.ensure(m.pluginServer(server) ?? server, Math.min(ms, 30_000));
    const r = await client.callTool(tool, input, AbortSignal.timeout(ms), ms);
    return { text: (r.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n").trim(), error: r.isError || undefined };
  };
  // A deleted or archived session lets go of what a bundled server held for it (tabs).
  (g as any).__keelMcpOff?.();
  // (And of the servers an editor passed with it.)
  (g as any).__keelMcpOff = deps.bus.on((f) => {
    if (f.t === "session" && (f.session.archived || f.deleted)) { m.releaseSession(f.session.id); projects.forgetSession(f.session.id); }
    // The session's sandbox changed: a command an editor passed is started again inside the new one.
    else if (f.t === "feature" && f.name === "perm" && f.session_id) m.sessionPermChanged(f.session_id);
  });
  // A command an editor passed runs where the session's own commands run:
  // inside its sandbox when that is on. A sandbox this machine cannot give is
  // not a reason to run the command outside one.
  m.sessionSandbox = (sessionId, argv) => {
    const s = deps.store.session(sessionId);
    const p = gate?.perm(sessionId);
    if (!s || !p || p.sandbox === "off") return { argv, as: "off" };
    const st = sandboxStatus();
    if (!st.available) return { refuse: `the session's commands run in a sandbox (${p.sandbox}) and this machine cannot give one (${st.reason}), so the editor's command is not started outside it` };
    return { argv: confine(argv, p, s.workspace, undefined, readOptsFor(sandboxScope(s.workspace))), as: `${p.sandbox}${p.network ? "" : ", no network"}` };
  };
  // What a session's own server did is in the session's activity and on the
  // bus: it is a program the session runs, and the owner sees that it does.
  m.onSessionServer = (e) => {
    const from = e.project ? (isAgentKey(e.project) ? `of the agent file ${e.project}` : "of this project's .mcp.json") : "passed by the editor";
    const text = e.what === "started" ? `MCP server ${e.name}, ${from}, started: ${e.target}`
      : e.what === "failed" ? `MCP server ${e.name}, ${from}, did not connect: ${e.error ?? "it failed"}`
      : `MCP server ${e.name}, ${from}, ended`;
    activity.record("turn", e.what === "failed" ? "mcp-failed" : "mcp", e.session, text, { server: e.name, target: e.target });
    deps.bus.emit({ t: "feature", name: "mcp-session", session_id: e.session, data: { name: e.name, what: e.what, target: e.target, ...(e.error ? { error: e.error } : {}) } });
  };
  // An editor's own socket to the daemon (keel acp opens one): the servers it
  // passed are held by it, and end when it closes, however the editor went.
  // (Kept across a dev hot reload: the sockets stay open through it.)
  const holders: Map<string, number> = ((globalThis as { __keelMcpHolders?: Map<string, number> }).__keelMcpHolders ??= new Map());
  registerSocket("mcp-hold", {
    open(ws) { const h = (ws.data as { holder: string }).holder; holders.set(h, (holders.get(h) ?? 0) + 1); ws.send(JSON.stringify({ t: "held", holder: h })); },
    close(ws) {
      const h = (ws.data as { holder: string }).holder;
      const left = (holders.get(h) ?? 1) - 1;
      if (left > 0) return void holders.set(h, left);
      holders.delete(h);
      (globalThis as { __keelMcp?: McpManager }).__keelMcp?.releaseHolder(h);
    },
  });

  // A server's pushed events go into the sessions that take them: the one an
  // editor's own server is for, or those the owner named for one of theirs.
  // The server is told what became of each, when it asked to be (STATUS_CAP).
  m.onChannel = (from, params) => {
    const targets = !from.on ? null : from.session ? [from.session] : channels.sessionsOf(from.server, from.ident).map((x) => x.id);
    void channels.push({ key: `mcp:${from.entry}`, name: from.server, via: "mcp" }, targets, params)
      .then((p) => m.tellChannel(from.entry, { ...(p.event_id ? { event_id: p.event_id } : {}), outcomes: p.outcomes }))
      .catch((e) => deps.errors.capture("server", e, { at: "mcp channel", mcp: from.entry }));
  };
  // Each server with where its events go and what became of the latest ones.
  m.onServerGone = (name) => channels.forget(name);
  // A browser closed for idleness is one line in the activity feed.
  m.onIdleClose = (name, idleMs) => {
    const min = Math.max(1, Math.round(idleMs / 60_000));
    activity.record("daemon", "mcp_browser", null, `Closed the browser of the MCP server ${name}: no call for ${min} minute${min === 1 ? "" : "s"}`, { mcp: name, idle_ms: idleMs });
  };
  const withChannels = (list: ReturnType<typeof m.list>) => list.map((x) => x.bundled ? x : ({
    ...x,
    channel: { ...x.channel, sessions: x.session ? [] : channels.sessionsOf(x.name, m.channelOf(x.name)?.ident ?? ""), recent: channels.recentOf(`mcp:${x.session ? `${x.name}@${x.session}` : x.name}`) },
  }));
  const servers = () => json({ servers: withChannels(m.list()) });
  // The servers the owner turned off for one session: its tools are not offered there (src/tools/catalog.ts).
  sessionOff.of = (id) => deps.store.session(id)?.settings.mcp_off;
  const offOf = (id: string) => deps.store.session(id)?.settings.mcp_off ?? [];
  const known = (name: string) => (m.has(name) ? null : bad(`no MCP server named ${name}`, 404));
  // A plugin's server goes and stops with its plugin (Customize > Plugins).
  const plugins = (name: string) => { const p = m.pluginOf(name); return p ? bad(`${name} comes with the plugin ${p}: turn the plugin off or remove it in Customize > Plugins`, 409) : null; };
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  // A server that is a command runs a program as the owner: from a remote device that takes the passkey.
  const needs = (req: Request) => (!presence || presence.allows(req, "mcp-command") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "mcp-command" } }, 428));

  return {
    // GET /api/mcp/hold?holder=ID upgrades to a socket that holds the servers
    // set with that `holder`: they end when it closes.
    "/api/mcp/hold": {
      GET: (req: Request, srv: Bun.Server<unknown>) => {
        const holder = new URL(req.url).searchParams.get("holder") ?? "";
        if (!/^[\w-]{8,80}$/.test(holder)) return bad("holder is 8 to 80 letters, digits, dashes or underscores");
        return srv.upgrade(req, { data: { kind: "mcp-hold", holder } }) ? undefined : bad("websocket upgrade failed");
      },
    },
    // A session's MCP list: the owner's servers and the ones an editor passed
    // with this session (`session` on each). PUT sets the session's own, the
    // whole list each time, as ACP's session/new, load and resume give it:
    // `servers` holds `{ name, command, args?, env? }` or `{ name, url, headers? }`,
    // and `holder` names the caller's hold socket (the servers end with it).
    // They run with the session's permissions and nothing more (see
    // McpManager.setSessionServers), and are never written to the owner's file.
    "/api/sessions/:id/mcp": {
      GET: (req: any) => (deps.store.session(req.params.id) ? json({ servers: withChannels(m.list(req.params.id)).map((x) => (x.session ? x : { ...x, off: offOf(req.params.id).includes(x.name) })) }) : bad("no such session", 404)),
      PUT: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        const b = await body(req);
        if (!Array.isArray(b.servers)) return bad("servers is a list");
        const record = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : undefined);
        const list = b.servers.map((x: any) => ({
          name: String(x?.name ?? ""),
          config: {
            ...(x?.command
              ? { command: String(x.command), args: Array.isArray(x.args) ? x.args.map(String) : undefined, env: record(x.env) }
              : { url: typeof x?.url === "string" ? x.url : undefined, headers: record(x?.headers), ...(x?.transport === "sse" ? { transport: "sse" as const } : {}) }),
            // How its server lives: kept running, or not shared with another session (the owner's own settings of the same names).
            ...(x?.keep_running === true ? { keep_running: true } : {}),
            ...(x?.share === false ? { share: false } : {}),
          } as McpServerConfig,
        }));
        // A command runs a program as the owner: from a remote device that takes the passkey.
        if (list.some((x: { config: McpServerConfig }) => x.config.command)) { const guard = needs(req); if (guard) return guard; }
        const holder = typeof b.holder === "string" && b.holder ? b.holder : undefined;
        if (holder && list.length && !holders.has(holder)) return bad("no open hold socket has this holder (GET /api/mcp/hold?holder=ID first)", 409);
        const remote = s.machine && s.machine !== "local" ? s.machine : undefined;
        return json({ set: m.setSessionServers(s.id, list, { cwd: s.workspace, remote, holder }), servers: m.list(s.id).filter((x) => x.session) });
      },
    },
    // POST { off: boolean }: turn one of the owner's servers off for this session alone, or on again. Its tools leave the
    // session's search and its requests (a tool its conversation loaded stays declared, as it was, until the cache is
    // cold: src/engine/build-pin.ts), and a call of them is told why. Every other session is as it was.
    "/api/sessions/:id/mcp/:name/off": {
      POST: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (!m.has(req.params.name) || m.list().every((x) => x.name !== req.params.name)) return bad(`no MCP server named ${req.params.name}`, 404);
        const b = await body(req);
        if (typeof b.off !== "boolean") return bad("off is true or false");
        const now = new Set(s.settings.mcp_off ?? []);
        if (b.off) now.add(req.params.name); else now.delete(req.params.name);
        const next = deps.store.mergeSettings(s.id, { mcp_off: now.size ? [...now].sort() : null });
        if (next) deps.bus.emit({ t: "session", session: next });
        return json({ off: offOf(s.id) });
      },
    },
    // A project's .mcp.json servers and what the owner decided of each; a decision is the owner's alone.
    "/api/mcp/projects": {
      GET: () => json({ projects: projects.projects() }),
    },
    "/api/mcp/projects/decide": {
      POST: async (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (!["approved", "rejected", "forget"].includes(b.decision)) return bad("decision is approved, rejected or forget");
        if (typeof b.root !== "string" || !b.root.startsWith("/") || typeof b.name !== "string" || typeof b.digest !== "string") return bad("give root, name and digest as shown");
        const err = projects.decide(b.root, b.name, b.digest, b.decision);
        return err ? bad(err, 409) : json({ projects: projects.projects() });
      },
    },
    "/api/mcp/servers": {
      GET: servers,
      POST: async (req: Request) => {
        const b = await body(req);
        // The whole server as one JSON (`keel mcp add NAME --json -`), checked as the owner's file is read.
        if (b.config !== undefined) {
          const got = serverFromJson(b.config);
          if ("error" in got) return bad(got.error);
          if (got.config.command || got.config.headers_helper) { const guard = needs(req); if (guard) return guard; }
          const err = m.add(String(b.name ?? ""), got.config);
          return err ? bad(err) : servers();
        }
        if (b.command) { const guard = needs(req); if (guard) return guard; }
        const cfg: McpServerConfig = b.command
          ? { command: b.command, args: b.args, env: b.env, cwd: b.cwd }
          : { url: b.url, headers: b.headers, bearer_env: b.bearer_env, oauth: b.oauth, transport: b.transport === "sse" ? "sse" : undefined, headers_helper: typeof b.headers_helper === "string" && b.headers_helper.trim() ? b.headers_helper : undefined };
        // A headers helper is a command too: from a remote device it takes the passkey.
        if (cfg.headers_helper) { const guard = needs(req); if (guard) return guard; }
        if (b.enabled === false) cfg.enabled = false;
        if (b.timeout_secs) cfg.timeout_secs = Number(b.timeout_secs);
        if (b.tool_timeout_secs ?? b.max_timeout_secs) cfg.tool_timeout_secs = Number(b.tool_timeout_secs ?? b.max_timeout_secs);
        for (const k of Object.keys(cfg) as (keyof McpServerConfig)[]) if (cfg[k] === undefined) delete cfg[k];
        if (b.command && b.url) return bad("give either command or url");
        const err = m.add(String(b.name ?? ""), cfg);
        return err ? bad(err) : servers();
      },
    },
    "/api/mcp/servers/:name": {
      DELETE: (req: any) =>
        known(req.params.name) ?? plugins(req.params.name) ?? (m.isBundled(req.params.name) ? bad(`${req.params.name} is built in: turn it off instead`, 409) : (m.remove(req.params.name), servers())),
    },
    // Whether a server's pushed events are taken (src/mcp/channel.ts), off by default.
    // { on } alone: the server's switch (off keeps the sessions named, so on again
    // takes up where it was). { on, session }: that session takes its events or
    // stops; a session named while the switch is off turns it on, which is what
    // naming one asks for. A session's own server has the one switch, for its session.
    "/api/mcp/servers/:name/channel": {
      POST: async (req: any) => {
        const b = await body(req);
        if (typeof b.on !== "boolean") return bad("on is true or false");
        const session = typeof b.session === "string" && b.session ? b.session : undefined;
        const from = m.channelOf(req.params.name, session);
        if (!from) return bad(`no MCP server named ${req.params.name}`, 404);
        const guard = b.on ? needs(req) : null;
        if (guard) return guard;
        try {
          if (from.session || !session) m.setChannel(req.params.name, b.on, from.session);
          else {
            channels.listen(req.params.name, from.ident, session, b.on);
            if (b.on && !from.on) m.setChannel(req.params.name, true);
          }
        } catch (e) {
          return bad((e as Error).message, (e as { status?: number }).status ?? 400);
        }
        return session ? json({ servers: withChannels(m.list(session)) }) : servers();
      },
    },
    // The owner's switch for closing a server's browser once it is idle (src/mcp/manager.ts closeIdle); off by
    // default, never for a remote server. A remote device needs the passkey.
    "/api/mcp/servers/:name/idle-browser": {
      PUT: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (typeof b.on !== "boolean") return bad("on is true or false");
        try { m.setCloseIdleBrowser(req.params.name, b.on); } catch (e) { return bad((e as Error).message, (e as { status?: number }).status ?? 400); }
        return servers();
      },
    },
    // The owner marks tools of a server as reads; a remote device needs the passkey.
    "/api/mcp/servers/:name/reads": {
      PUT: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (!Array.isArray(b.tools)) return bad("tools is a list of tool names");
        try { m.setReads(req.params.name, b.tools); } catch (e) { return bad((e as Error).message, 409); }
        return servers();
      },
      // One tool more (the press on a card that offers it).
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (typeof b.tool !== "string" || !b.tool) return bad("tool is a tool name");
        try { m.addRead(req.params.name, b.tool); } catch (e) { return bad((e as Error).message, 409); }
        return servers();
      },
    },
    // The owner accepts the tool definitions a server lists now (the change set the owner was shown: `digest`).
    "/api/mcp/servers/:name/accept": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (typeof b.digest !== "string" || !b.digest) return bad("digest is required: the change set you were shown (held.digest)");
        try { m.acceptTools(req.params.name, b.digest); } catch (e) { return bad((e as Error).message, (e as { status?: number }).status ?? 400); }
        return servers();
      },
    },
    // The owner looked at a server that was pinned as it was when this build first ran.
    "/api/mcp/servers/:name/pin-seen": {
      POST: (req: any) => known(req.params.name) ?? (m.pinSeen(req.params.name), servers()),
    },
    // The owner says what kind of server it is: each of outside, sends and account true, false, or null to forget the answer.
    "/api/mcp/servers/:name/class": {
      PUT: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const answers: Record<string, boolean | null> = {};
        for (const key of ["outside", "sends", "account"]) {
          if (!(key in b)) continue;
          if (b[key] !== null && typeof b[key] !== "boolean") return bad(`${key} is true, false or null`);
          answers[key] = b[key];
        }
        try { m.setClass(req.params.name, answers); } catch (e) { return bad((e as Error).message, 409); }
        return servers();
      },
    },
    "/api/mcp/servers/:name/toggle": {
      POST: async (req: any) => known(req.params.name) ?? plugins(req.params.name) ?? (m.toggle(req.params.name, (await body(req)).enabled !== false), servers()),
    },
    "/api/mcp/servers/:name/reconnect": {
      POST: async (req: any) => known(req.params.name) ?? (await m.reconnect(req.params.name), servers()),
    },
    "/api/mcp/servers/:name/sign-in": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const s = m.list().find((x) => x.name === req.params.name)!;
        if (!s.sign_in) return bad(`${s.name} has no sign-in`);
        const origin = new URL(req.url).origin;
        return json({ url: await m.signIn(s.name, `${origin}/api/mcp/oauth/callback`) });
      },
    },
    "/api/mcp/servers/:name/sign-out": {
      POST: (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        if (!m.list().find((x) => x.name === req.params.name)!.sign_in) return bad(`${req.params.name} has no sign-in`);
        m.signOut(req.params.name);
        return servers();
      },
    },
    "/api/mcp/oauth/callback": {
      GET: async (req: Request) => {
        try {
          const done = await m.finishSignIn(new URL(req.url).searchParams);
          if (done.retry) return retryPage(done.line ?? "", done.retry);
          return page("Signed in", `${escape(done.server)} is connected. You can close this tab.`);
        } catch (e) {
          deps.errors.capture("server", e, { at: "mcp oauth callback" });
          return page("Sign-in failed", escape((e as Error).message));
        }
      },
    },
    // The redirect pasted by hand (a browser on another device).
    "/api/mcp/sign-in/finish": {
      POST: async (req: Request) => {
        const r = String((await body(req)).redirect ?? "");
        const q = new URLSearchParams(r.includes("?") ? r.slice(r.indexOf("?") + 1) : r);
        if (!q.get("state")) return bad("the redirect carries no state");
        try {
          const done = await m.finishSignIn(q);
          return json({ server: done.server, ...(done.retry ? { retry: done.retry, line: done.line } : {}), servers: m.list() });
        } catch (e) {
          return bad((e as Error).message);
        }
      },
    },
    "/api/mcp/reload": {
      POST: async (req: Request) => {
        const b = await body(req);
        try {
          // a server only in the file may be reloaded into existence
          if (b.server && !m.has(b.server) && !(b.server in readConfig(configPath()).servers)) return bad(`no MCP server named ${b.server}`, 404);
          const reload = m.reload(b.server || undefined);
          // Phone control has no file entry: a reload asks the gateway again.
          reload.servers.push(...(await m.checkLive(b.server || undefined)));
          const changed = reload.servers.filter((s) => s.change !== "unchanged");
          const line = changed.length ? `MCP reloaded: ${changed.map((s) => `${s.name} ${s.change}`).join(", ")}.` : "MCP reloaded: nothing changed.";
          return json({ reload, line, servers: m.list() });
        } catch (e) {
          return bad(`mcp.json: ${(e as Error).message}`);
        }
      },
    },
    "/api/mcp/search": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const offset = Number(u.get("offset") ?? 0);
        const limit = Number(u.get("limit") ?? 20);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) return bad("offset and limit are numbers");
        const q = u.get("q") ?? "";
        const all = (await catalogTools()).filter((t) => !t.hidden);
        const hits = all.map((t) => ({ t, s: score(t, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t);
        const tools = hits.slice(offset, offset + limit).map((t) => ({ server: t.server, name: t.name, qualified_name: t.qualified, description: t.description, input_schema: t.input_schema }));
        const pending = catalogSources().flatMap((s) => s.pending?.() ?? []);
        return json({
          tools,
          total: hits.length,
          next_offset: hits.length > offset + limit ? offset + limit : undefined,
          pending_servers: pending.length ? pending : undefined,
          total_deferred: all.length,
        });
      },
    },
    // Env values can hold secrets: the listing names the keys, import copies the values server-side.
    "/api/mcp/importable": {
      // A listing also brings the copies in step (the watch can miss a folder made since).
      GET: () => { m.syncSources(); const failed: { file: string; error: string }[] = []; return json({
        failed,
        home: importHome(),
        servers: m.importable(failed).map((i) => ({
          ...i,
          config: { ...i.config, env: i.config.env ? Object.fromEntries(Object.keys(i.config.env).map((k) => [k, "***"])) : undefined, headers: i.config.headers ? Object.fromEntries(Object.keys(i.config.headers).map((k) => [k, "***"])) : undefined },
        })),
      }); },
    },
    "/api/mcp/import": {
      POST: async (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const err = m.importFrom(String(b.source ?? ""), String(b.name ?? ""), b.as ? String(b.as) : undefined);
        return err ? bad(err) : servers();
      },
    },
    // Every server the other agents hold that Keel does not, in one step.
    "/api/mcp/import-all": {
      POST: (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        return json({ ...m.importAll(), servers: m.list() });
      },
    },
    // Read the other agents' files now (the daemon also watches them).
    "/api/mcp/sync": {
      POST: () => {
        const changed = m.syncSources();
        return json({ changed, servers: m.list() });
      },
    },
    // Connectors: the vendors' own remote servers, with what each needs to sign in.
    "/api/mcp/connectors": {
      GET: async (req: Request) => {
        const have = new Map(m.list().filter((s) => s.endpoint).map((s) => [s.endpoint!, s.name]));
        const gh = await ghSignedIn();
        const connectors = await Promise.all(SUGGESTED.map(async (c) => ({
          ...c,
          access: await access(c.url).catch((e) => ({ kind: "unreachable" as const, error: (e as Error).message })),
          added: have.get(endpoint({ url: c.url })),
          gh: c.via === "gh" ? gh : undefined,
        })));
        return json({ connectors, redirect_uri: `${new URL(req.url).origin}/api/mcp/oauth/callback`, registry: REGISTRY });
      },
    },
    "/api/mcp/connectors/:id": {
      POST: async (req: any) => {
        const c = SUGGESTED.find((x) => x.id === req.params.id);
        if (!c) return bad(`no connector named ${req.params.id}`, 404);
        const b = await body(req);
        const gh = c.via === "gh" && b.client_id === undefined && (await ghSignedIn());
        // The GitHub CLI's sign-in runs gh at each connect: a command, so a remote device needs the passkey.
        if (gh) { const guard = needs(req); if (guard) return guard; }
        const cfg = connectorConfig(c, { gh, client_id: b.client_id ? String(b.client_id).trim() : undefined, client_secret_env: b.client_secret_env ? String(b.client_secret_env).trim() : undefined });
        const name = String(b.name ?? c.id);
        const err = m.add(name, cfg);
        return err ? bad(err) : json({ name, servers: m.list() });
      },
    },
    // The official MCP registry (or a file: mirror), searched by name.
    "/api/mcp/registry": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        try {
          const r = await searchRegistry(q.get("q") ?? "", q.get("cursor") ?? undefined);
          const have = new Set(m.list().map((s) => s.endpoint).filter(Boolean));
          return json({ ...r, servers: r.servers.map((x) => ({ ...x, suggested_name: keelName(x.name), added: (!!x.remote && have.has(endpoint({ url: x.remote.url }))) || (!!x.package && have.has(endpoint({ command: x.package.command, args: x.package.args }))) })) });
        } catch (e) {
          deps.errors.capture("server", e, { at: "mcp registry search" });
          return bad((e as Error).message, 502);
        }
      },
    },
    // Add a registry server: its remote URL with the headers it asks for, or its package run as a command with its env.
    "/api/mcp/registry/add": {
      POST: async (req: Request) => {
        const b = await body(req);
        const found = (await searchRegistry(String(b.server ?? ""))).servers.find((x) => x.name === b.server);
        if (!found) return bad(`the registry has no server named ${b.server}`, 404);
        const values = (b.values && typeof b.values === "object" ? b.values : {}) as Record<string, string>;
        const useRemote = b.kind !== "package" && !!found.remote;
        const spec = useRemote ? found.remote!.headers : found.package?.env ?? [];
        const missing = spec.filter((v) => v.required && !String(values[v.name] ?? "").trim()).map((v) => v.name);
        if (missing.length) return bad(`${found.name} needs ${missing.join(", ")}`);
        const given = Object.fromEntries(spec.filter((v) => String(values[v.name] ?? "").trim()).map((v) => [v.name, String(values[v.name]).trim()]));
        let cfg: McpServerConfig;
        if (useRemote) cfg = { url: found.remote!.url, ...(Object.keys(given).length ? { headers: given } : {}) };
        else if (found.package) {
          const guard = needs(req);
          if (guard) return guard;
          cfg = { command: found.package.command, args: found.package.args, ...(Object.keys(given).length ? { env: given } : {}) };
        } else return bad(`${found.name} has nothing Keel can run`);
        const name = String(b.name ?? keelName(found.name));
        const err = m.add(name, cfg);
        return err ? bad(err) : json({ name, servers: m.list() });
      },
    },
    "/api/mcp/servers/:name/resources": {
      GET: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const q = new URL(req.url).searchParams;
        const list = q.get("list"), cursor = q.get("cursor");
        const from = cursor !== null && (list === "resources" || list === "templates") ? { list, cursor } as const : undefined;
        try { return json(await m.resources(req.params.name, req.signal, from)); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/resource": {
      GET: async (req: any) => {
        const uri = new URL(req.url).searchParams.get("uri");
        if (!uri) return bad("uri is required");
        const k = known(req.params.name);
        if (k) return k;
        try { return json({ uri, items: await m.readResource(req.params.name, uri, req.signal) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/prompts": {
      GET: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        try { return json({ prompts: await m.prompts(req.params.name) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    // The latest lines of a server's own log (src/mcp/logs.ts).
    "/api/mcp/servers/:name/log": {
      GET: (req: any) => known(req.params.name) ?? json({ lines: m.log(req.params.name) }),
    },
    // What a server suggests for an argument: {ref: {type: "ref/prompt", name} or {type: "ref/resource", uri},
    // argument: {name, value}, context?: {name: value}} (completion/complete).
    "/api/mcp/servers/:name/complete": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const b = await body(req);
        const ref = b.ref?.type === "ref/prompt" && typeof b.ref.name === "string" ? { type: "ref/prompt" as const, name: b.ref.name }
          : b.ref?.type === "ref/resource" && typeof b.ref.uri === "string" ? { type: "ref/resource" as const, uri: b.ref.uri } : null;
        if (!ref) return bad("ref is a prompt ({type: \"ref/prompt\", name}) or a resource template ({type: \"ref/resource\", uri})");
        if (typeof b.argument?.name !== "string") return bad("argument.name is required");
        const context = b.context && typeof b.context === "object" && !Array.isArray(b.context)
          ? Object.fromEntries(Object.entries(b.context).filter(([, v]) => typeof v === "string") as [string, string][]) : undefined;
        try { return json(await m.complete(req.params.name, ref, { name: b.argument.name, value: String(b.argument.value ?? "") }, context, req.signal)); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    // Every connected server's prompts, for the slash menu (/server:prompt).
    "/api/mcp/prompts": {
      GET: async (req: Request) => json({ prompts: await m.allPrompts(req.signal) }),
    },
    // The owner runs a prompt as a command (/server:prompt args, Claude Code's
    // form; /mcp__server__prompt too). Words after it fill the prompt's
    // arguments in order, the last one taking the rest. What the server
    // returns reaches the model as a stored note just before the message; the
    // transcript shows the command.
    "/api/sessions/:id/mcp-prompt": {
      POST: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        const server = String(b.server ?? ""), name = String(b.prompt ?? "");
        const k = known(server);
        if (k) return k;
        try {
          const p = (await m.prompts(server)).find((x: any) => x.name === name);
          if (!p) return bad(`${server} has no prompt named ${name}`, 404);
          const params: { name: string; required?: boolean }[] = Array.isArray(p.arguments) ? p.arguments : [];
          const words = String(b.args ?? "").trim().split(/\s+/).filter(Boolean);
          const args: Record<string, string> = {};
          params.forEach((a, i) => {
            const v = i === params.length - 1 ? words.slice(i).join(" ") : words[i];
            if (v) args[a.name] = v;
          });
          const missing = params.filter((a) => a.required && !args[a.name]).map((a) => a.name);
          if (missing.length) return json({ error: `/${server}:${name} needs ${missing.map((x) => `<${x}>`).join(" ")}`, usage: true }, 400);
          const text = await m.getPrompt(server, name, args, req.signal);
          const note = deps.store.append(s.id, "note", { text: `<mcp-prompt server="${server}" name="${name}">\n${text}\n</mcp-prompt>`, model: true, mcp_prompt: `${server}:${name}` });
          deps.bus.emit({ t: "event", event: note });
          const ev = deps.engine.send(s.id, `/${server}:${name}${words.length ? ` ${words.join(" ")}` : ""}`);
          return json({ event: ev }, 201);
        } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/prompts/:prompt": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const args = (await body(req)).arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) return bad("arguments must be an object");
        try { return json({ name: req.params.prompt, messages: await m.promptMessages(req.params.name, req.params.prompt, args, req.signal) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
  };
};
