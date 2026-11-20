// The fleet's routes: identity and pairing, machines and their checks, one
// view of every session across linked daemons, the forwarder to another
// daemon's API, sessions placed on a machine, and the paired-only endpoints
// another daemon calls (facts, live stream, hands).
import { holdStream } from "../streams.ts";
import { dirname, isAbsolute, resolve } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { instructionFiles } from "../../engine/turn.ts";
import { Fleet } from "../../fleet/fleet.ts";
import { WORKSPACE_TOOLS } from "../../fleet/hands.ts";
import { handsRoutes } from "../../fleet/hands-routes.ts";
import { callerOf, LinkError, linkFetch, linkJson, loopbackUrl, proof, proven, standingFrom } from "../../fleet/link.ts";
import { innerHeaders, isLocal, type Standing } from "../../safety/presence.ts";
import { remoteRun } from "../../fleet/remote.ts";
import { Handoffs, MoveError } from "../../fleet/handoff.ts";
import { forgetOwnership, portalOf, portalPath, sessionPorts, setOpen } from "../../fleet/portal.ts";
import { bridge, isUpgrade, present, sameText, upHeaders, upstream } from "../../fleet/portal-proxy.ts";
import { validate as validatePlacement } from "../../fleet/placement.ts";
import { groupOf, hostGroups, plainAlias } from "../../fleet/sshconfig.ts";
import { bindFleetTools } from "../../fleet/tools.ts";
import { bindNotices } from "../../fleet/notice.ts";
import { registerSendFiles, RemoteAgents } from "../../fleet/agents.ts";
import { setRemotePlacer } from "../../automation/agents.ts";
import { HttpError, type Message, Messages } from "../../fleet/messages.ts";
import * as alerts from "../../automation/alerts.ts";
import { contains } from "../../core/paths.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate, presence } from "./permissions.ts";
import { runMode } from "../../core/runmode.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl|oklch)a?\([^)]*\))$/i;
const KEEPALIVE_MS = 5_000; // under Bun's 10 s idle timeout: a long call keeps its connection

export let fleet: Fleet | undefined;

export const fleetRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, errors } = deps;
  // A hot reload builds a new fleet: the old one closes its relays and tunnels first.
  const g = globalThis as { __keelFleet?: Fleet };
  g.__keelFleet?.stop();
  const f = (fleet = g.__keelFleet = new Fleet(store, bus, errors));
  const msgs = new Messages(store, bus, engine, f, (id) => (gate ? gate.perm(id) : undefined), (m, s) => {
    alerts.raise("agent", s.id, `Message waiting: ${s.title || "a session"}`, `From ${m.from.title || m.from.session_id}${m.from.daemon_id !== f.id ? ` on ${m.from.machine ?? m.from.daemon_id}` : ""}: ${m.reason}. ${m.text.slice(0, 300)}`, { open_session: s.id, message_id: m.id });
  });
  bindFleetTools(f, msgs, (id) => store.session(id), bindNotices(f, msgs, store, engine));
  const moves = new Handoffs(store, bus, engine, f);
  const remoteAgents = new RemoteAgents(store, f, errors, (id) => gate?.perm(id).sandbox ?? "off");
  setRemotePlacer(remoteAgents);
  registerSendFiles(() => remoteAgents, (id) => store.session(id), (id) => gate?.perm(id).mode ?? "ask");
  // A deleted session takes what its moves and its agents there left with it.
  bus.on((fr) => {
    if (fr.t === "session" && fr.session.archived && !store.session(fr.session.id)) {
      moves.cleanup(fr.session.id).catch((e) => errors.capture("server", e, { at: "handoff cleanup" }));
      remoteAgents.sweep().catch((e) => errors.capture("server", e, { at: "remote agent sweep" }));
    }
  });
  // A linked daemon's outbox: messages its sessions wrote for this daemon's.
  f.onOutbox = (machineId) => {
    (async () => {
      const p = await f.peer(machineId);
      const r = await linkJson<{ messages: Message[] }>(p, "/api/fleet/outbox", { method: "POST", body: JSON.stringify({ daemon_id: f.id, name: f.name }) });
      const kept: string[] = [];
      for (const m of r.messages) {
        const to = store.session(m.to_session);
        // Proven by the link's answer; it counts as that daemon's when it says it was written there.
        // Refused (gone, archived, rate) is an answer too: it is not handed out again.
        if (to) try { msgs.receiveOutbound(to, m, m.from.daemon_id === p.daemonId); } catch (e) { if (!(e instanceof HttpError)) throw e; }
        kept.push(m.id);
      }
      if (kept.length) await linkJson(p, "/api/fleet/outbox/ack", { method: "POST", body: JSON.stringify({ daemon_id: f.id, ids: kept }) });
    })().catch((e) => { if (!(e instanceof LinkError)) errors.capture("server", e, { at: "fleet outbox", machine: machineId }); });
  };
  if (!runMode.client) f.start();
  const spillRoot = `${store.stateDir}/spill`;

  // A session placed on another machine: its workspace tools run there.
  registerHooks({
    async system(s) {
      if (!s.machine) return "";
      const m = f.row(s.machine);
      if (!m) return "";
      const facts = f.facts(m.id);
      let inst = "";
      try {
        const r = await f.hands(m.id, "/api/fleet/hands/instructions", { method: "POST", body: JSON.stringify({ cwd: s.workspace, root: m.workspace_root }), idempotent: true });
        inst = ((await r.json()) as any).text ?? "";
      } catch (e) {
        if (!(e instanceof LinkError)) errors.capture("server", e, { at: "fleet instructions", machine: m.id });
      }
      return [
        `Your workspace tools (shell, files, search) run on the machine "${m.name}"${facts ? ` (${facts.os} ${facts.arch}, ${facts.cpus} cores)` : ""}, not on this daemon's machine. Paths are paths there; the directory granted there is ${m.workspace_root}.`,
        inst ? `\nInstructions from the owner's files on ${m.name}:\n\n${inst}` : "",
      ].join("\n");
    },
    beforeTool(s, call) {
      if (WORKSPACE_TOOLS.has(call.tool.name) && moves.isMoving(s.id)) return { deny: "The session is moving to another place; its tools run again when the move ends." };
      if (!s.machine || !WORKSPACE_TOOLS.has(call.tool.name)) return;
      const m = f.row(s.machine);
      if (!m) return { deny: "This session's machine was removed from the fleet: its tools have nowhere to run." };
      if (!m.workspace_root) return { deny: `${m.name} has no granted directory: nothing runs there.` };
      const sandbox = gate?.perm(s.id).sandbox ?? "off";
      if (sandbox === "read-only" && !call.tool.readOnly) return { deny: "A read-only sandbox reaches no other machine." };
      return { ctx: { dispatch: (tool, input, ctx) => remoteRun(f, m, ctx, { tool: tool.name, input, cwd: ctx.cwd, sandbox: sandbox !== "off" }) } };
    },
  });

  const portsOf = (id: string) =>
    (sessionPorts().get(id) ?? []).sort((a, b) => a.port - b.port).map((p) => {
      const o = portalOf(id, p.port);
      return o ? { ...p, open: true, point: o.point || undefined, url: `${portalPath(id, p.port, o.key)}/` } : p;
    });

  // Not open, a wrong key and an unknown session are the same 404; a port whose
  // owner is gone is 502. Never follows a redirect; the page is sandboxed.
  const portalTarget = (path: string) => {
    const [sid = "", portS = "", key = "", ...rest] = path.split("/");
    const port = Number(portS);
    const o = portalOf(sid, port);
    if (!o || o.key !== key) return { error: bad("not found", 404) };
    if (!(sessionPorts().get(sid) ?? []).some((p) => p.port === port)) return { error: bad("no process of the session listens there any more", 502) };
    return { sid, port, key, point: o.point, rest: rest.join("/") };
  };
  const portal = async (req: Request, srv: Bun.Server<unknown>) => {
    const u = new URL(req.url);
    const t = portalTarget(u.pathname.slice("/portal/".length));
    if ("error" in t) return t.error;
    if (isUpgrade(req)) return bridge(req, srv, `ws://127.0.0.1:${t.port}/${t.rest}${u.search}`);
    let r: Response;
    try { r = await upstream(req, t.port, `${t.rest}${u.search}`); } catch (e) { return bad(`the dev server does not answer: ${(e as Error).message}`, 502); }
    return present(r, t.port, portalPath(t.sid, t.port, t.key), t.point);
  };

  // The portal of a session on another daemon: that daemon reaches its dev
  // server, this one rewrites for its own prefix and holds the page's socket.
  const remotePortal = async (req: Request, srv: Bun.Server<unknown>) => {
    const u = new URL(req.url);
    const [, , mid = "", sid = "", portS = "", key = "", ...rest] = u.pathname.split("/");
    const port = Number(portS);
    if (!f.row(mid) || !/^[\w-]+$/.test(sid) || !Number.isInteger(port) || !/^\w+$/.test(key)) return bad("not found", 404);
    const far = `/api/fleet/portal/${sid}/${port}/${key}/${rest.join("/")}${u.search}`;
    let p;
    try { p = await f.peer(mid); } catch (e) { if (!(e instanceof LinkError)) throw e; return bad((e as Error).message, 502); }
    if (isUpgrade(req)) {
      const nonce = Bun.randomUUIDv7();
      const want = proof(p.key, nonce, p.daemonId);
      return bridge(req, srv, p.url.replace(/^http/, "ws") + far, {
        headers: { "x-keel-link": `${p.myId} ${p.key}`, "x-keel-nonce": nonce },
        verify: (first) => { try { return sameText(String(JSON.parse(first).keel_proof ?? ""), want); } catch { return false; } },
      });
    }
    let r: Response;
    try {
      r = await linkFetch(p, far, { method: req.method, headers: upHeaders(req), body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(), timeout: 60_000 });
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      return bad((e as Error).message, 502);
    }
    if (r.headers.get("x-keel-portal") !== "1") return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
    return present(r, port, `/fleet-portal/${mid}/${sid}/${port}/${key}`, r.headers.get("x-keel-portal-point") === "1");
  };

  const paired = (req: Request) => callerOf(req, f.keyOf);
  // Paired-only endpoints: a request without this daemon's key for the caller
  // gets a plain 403, with no proof.
  const linked = (h: (req: any, c: NonNullable<ReturnType<typeof paired>>) => Promise<Response> | Response) => async (req: any) => {
    const c = paired(req);
    if (!c) return proven(bad("not a paired daemon", 403), null, f.id);
    return proven(await h(req, c), c, f.id);
  };

  const machineView = (id: string) => {
    const m = f.row(id);
    return m ? f.view(m) : undefined;
  };
  const machinesList = async () => {
    return [await f.localView(), ...f.rows().map((m) => f.view(m)), ...f.offeredView()];
  };

  // Every session across machines, from the relays: never waits on a link.
  const fleetView = () => {
    const local = store.sessions();
    const machines: any[] = [{ id: "local", name: f.name, state: "ready", sessions: local }];
    const recents: any[] = local.map((s) => ({ machine_id: "local", machine: f.name, session_id: s.id, title: s.title, phase: s.phase, updated_ms: s.updated, failed: s.phase === "error" }));
    for (const m of f.rows()) {
      if ((!m.link_key && m.state === "unknown") || f.isSsh(m)) continue; // an ssh machine has no sessions of its own
      const r = f.remoteSessions(m.id);
      const v = f.view(m);
      machines.push({ id: m.id, name: m.name, state: v.daemon.state === "linked" ? m.state : "offline", sessions: r.sessions, reason: v.daemon.reason ?? m.reason ?? undefined, colour: m.colour ?? undefined, stale: r.stale || undefined, retry_at_ms: r.retry_at_ms });
      if (!r.stale) for (const s of r.sessions) recents.push({ machine_id: m.id, machine: m.name, session_id: s.id, title: s.title, phase: s.phase, updated_ms: s.updated, failed: s.phase === "error" });
    }
    recents.sort((a, b) => b.updated_ms - a.updated_ms);
    return { daemon_id: f.id, machines, recents };
  };

  // The hands, for paired daemons only.
  const handsLinked = Object.fromEntries(Object.entries(handsRoutes({ spillRoot, capture: (e, c) => errors.capture("tool", e, c), instructions: instructionFiles })).map(([path, h]) => [path, Object.fromEntries(Object.entries(h).map(([m, fn]) => [m, linked(fn as any)]))]));

  return {
    "/api/fleet": { GET: () => json(fleetView()) },

    "/api/fleet/identity": {
      GET: (req: Request) => proven(json(f.identity()), paired(req), f.id),
    },

    // Another daemon links to this one: a secret made for it, kept here.
    "/api/fleet/pair": {
      POST: async (req: Request) => {
        // A pairing hands out a key that runs commands here (hands): from a
        // remote device it takes the passkey, like any authority change.
        if (presence && !presence.allows(req, "fleet-pair")) return json({ error: "this needs your passkey from a remote device", presence: { action: "fleet-pair" } }, 428);
        const b = await body(req);
        const id = String(b.daemon_id ?? "");
        if (!id || /\s/.test(id)) return bad("daemon_id must be a non-empty word");
        if (id === f.id) return bad("that is this daemon's own id: a daemon is never linked to itself");
        const key = f.pairWith(id, typeof b.name === "string" ? b.name.slice(0, 120) : undefined);
        f.emitMachines();
        return json({ ...f.identity(), key });
      },
    },

    "/api/fleet/pairs": { GET: () => json({ pairs: f.pairs() }) },
    "/api/fleet/pairs/:id": {
      DELETE: (req: any) => {
        if (!f.keyOf(req.params.id)) return bad("no such pairing", 404);
        f.unpair(req.params.id);
        f.emitMachines();
        return json({ pairs: f.pairs() });
      },
    },

    "/api/fleet/machines": {
      GET: async () => json({ machines: await machinesList() }),
      POST: async (req: Request) => {
        const b = await body(req);
        const root = typeof b.workspace_root === "string" && b.workspace_root.trim() ? b.workspace_root.trim() : undefined;
        if (root && !isAbsolute(root)) return bad("workspace_root must be an absolute path on that machine");
        let m;
        if (b.ssh_host !== undefined) {
          const host = String(b.ssh_host);
          const group = groupOf(host);
          if (!plainAlias(host) || !group) return bad(`${host} is not a concrete host of the ssh configuration`);
          const same = f.rows().find((r) => r.ssh_host && group.routes.includes(r.ssh_host));
          if (same) return bad(`${host} reaches ${same.name}, which is already enabled`);
          // With a daemon port: a Keel daemon runs there, reached through ssh -L.
          // Without: the machine itself, its tools through the helper Keel puts there.
          const port = b.daemon_port === undefined || b.daemon_port === null || b.daemon_port === "" ? null : Number(b.daemon_port);
          if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return bad("daemon_port must be the port its daemon listens on there");
          const name = String(b.name || group.alias);
          if (f.rows().some((r) => r.name.toLowerCase() === name.toLowerCase())) return bad(`a machine is already named ${name}`);
          m = f.add({ name, source: "ssh", ssh_host: group.alias, daemon_port: port ?? undefined, workspace_root: root });
          if (port === null) {
            // The account is the owner's own: its home is the directory granted unless they name one.
            const checked = await f.check(m.id);
            if (!root && checked.facts) {
              const home = (JSON.parse(checked.facts) as { home?: string }).home;
              if (home) f.update(m.id, { workspace_root: home });
            }
            return json({ id: m.id, machines: await machinesList() }, 201);
          }
        } else {
          const url = loopbackUrl(String(b.daemon_url ?? ""));
          if (!url) return bad("daemon_url must be http on a loopback address (reach another machine through its ssh host)");
          const name = String(b.name ?? "").trim();
          if (!name) return bad("a machine needs a name");
          if (f.rows().some((r) => r.name.toLowerCase() === name.toLowerCase())) return bad(`a machine is already named ${name}`);
          // One record per daemon: a second pairing would replace the first one's key there.
          const same = f.rows().find((r) => r.daemon_url === url.origin);
          if (same) return bad(`that daemon is already enabled as ${same.name}`);
          m = f.add({ name, source: "daemon", daemon_url: url.origin, workspace_root: root });
        }
        await f.check(m.id);
        return json({ id: m.id, machines: await machinesList() }, 201);
      },
    },

    "/api/fleet/machines/:id": {
      GET: (req: any) => (machineView(req.params.id) ? json(machineView(req.params.id)) : bad("no such machine", 404)),
      PATCH: async (req: any) => {
        const id = req.params.id;
        if (id.startsWith("ssh:")) return bad("enable the ssh host first");
        if (!f.row(id)) return bad("no such machine", 404);
        const b = await body(req);
        const patch: any = {};
        if (b.name !== undefined) { if (!String(b.name).trim()) return bad("a name cannot be empty"); patch.name = String(b.name).trim(); }
        if (b.auto_connect !== undefined) patch.auto_connect = b.auto_connect ? 1 : 0;
        if (b.colour !== undefined) { if (b.colour !== null && !COLOUR.test(String(b.colour))) return bad("colour must be a CSS colour"); patch.colour = b.colour; }
        if (b.daemon_url !== undefined) { if (b.daemon_url !== null && !loopbackUrl(b.daemon_url)) return bad("daemon_url must be http on a loopback address"); patch.daemon_url = b.daemon_url && loopbackUrl(b.daemon_url)!.origin; }
        if (b.daemon_port !== undefined) patch.daemon_port = b.daemon_port;
        if (b.messages !== undefined) { if (!["allow", "hold"].includes(b.messages)) return bad("messages is allow or hold"); patch.messages = b.messages; }
        if (b.max_jobs !== undefined) { if (b.max_jobs !== null && !(Number.isInteger(b.max_jobs) && b.max_jobs > 0)) return bad("max_jobs must be at least 1"); patch.max_jobs = b.max_jobs; }
        if (b.workspace_root !== undefined) { if (b.workspace_root !== null && !isAbsolute(String(b.workspace_root))) return bad("workspace_root must be absolute"); patch.workspace_root = b.workspace_root; }
        f.update(id, patch);
        f.emitMachines();
        return json(machineView(id));
      },
      DELETE: async (req: any) => {
        const id = req.params.id;
        if (id === "local") return bad("this machine cannot be removed");
        if (!f.row(id)) return bad("no such machine", 404);
        const users = store.sessions().filter((s) => s.machine === id);
        if (users.length) return bad(`sessions run their tools there: ${users.map((s) => s.title || s.id).join(", ")}`, 409);
        await f.remove(id);
        return json({ machines: await machinesList() });
      },
    },

    "/api/fleet/machines/:id/check": {
      POST: async (req: any) => {
        const id: string = req.params.id;
        if (id === "local") return json(await f.localView());
        if (id.startsWith("ssh:")) {
          const alias = id.slice(4);
          if (!hostGroups().some((g) => g.routes.includes(alias))) return bad("no such machine", 404);
          return json(await f.checkSsh(alias));
        }
        if (!f.row(id)) return bad("no such machine", 404);
        await f.check(id);
        return json(machineView(id));
      },
    },

    // The folders inside a folder of an ssh machine, for the folder picker:
    // inside its granted directory, over its master connection.
    "/api/fleet/machines/:id/dirs": {
      GET: async (req: any) => {
        const m = f.row(req.params.id);
        if (!m || !f.isSsh(m)) return bad("no such ssh machine", 404);
        if (!m.workspace_root) return bad(`${m.name} has no granted directory`);
        const want = new URL(req.url).searchParams.get("path") || m.workspace_root;
        const p = isAbsolute(want) ? resolve(want) : resolve(m.workspace_root, want);
        if (!contains(m.workspace_root, p)) return bad(`${p} is outside the directory granted on ${m.name}`, 403);
        try {
          const r = await f.sshLink(m).dirs(p);
          return json({ path: r.path, parent: r.path === m.workspace_root || !contains(m.workspace_root, dirname(r.path)) ? null : dirname(r.path), is_git: r.is_git, root: m.workspace_root, dirs: r.dirs.map((d) => ({ ...d, path: `${r.path.replace(/\/$/, "")}/${d.name}` })) });
        } catch (e) {
          if (!(e instanceof LinkError)) throw e;
          return bad((e as Error).message, 502);
        }
      },
    },

    // /api/fleet/machines/:id/api/<rest> is /api/<rest> on that machine's daemon.
    "/api/fleet/machines/:id/api/*": async (req: any) => {
      const url = new URL(req.url);
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      if (!f.row(id)) return bad("no such machine", 404);
      if (f.isSsh(f.row(id)!)) return bad("that machine has no daemon of its own", 404);
      const rest = url.pathname.slice(`/api/fleet/machines/${url.pathname.split("/")[4]}/api/`.length);
      let decoded: string;
      try { decoded = decodeURIComponent(rest); } catch { return bad("a path that cannot be read"); }
      if (decoded.split(/[\\/]/).some((p) => p === ".." || p === ".") || /^fleet\/(machines|linked)\b/.test(decoded)) {
        return bad("the path leaves the other daemon's /api or goes through it to a third daemon");
      }
      try {
        const p = await f.peer(id);
        // Who is asking travels with it: the far daemon applies its presence
        // rules to a remote device as remote, not as its own loopback caller.
        const standing: Standing = presence ? presence.standing(req) : { local: isLocal(req), enrolled: true, present: null };
        const r = await linkFetch(p, `/api/fleet/linked/${rest}${url.search}`, {
          method: req.method,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
          headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
          timeout: 60_000,
          standing,
        });
        const h = new Headers();
        const type = r.headers.get("content-type") ?? "";
        if (type) h.set("content-type", type);
        if (!type.includes("json")) {
          h.set("content-security-policy", "sandbox");
          h.set("x-content-type-options", "nosniff");
          if (!/^image\/(png|jpeg|gif|webp|avif)/.test(type)) h.set("content-disposition", "attachment");
        }
        return new Response(r.body, { status: r.status, headers: h });
      } catch (e) {
        if (!(e instanceof LinkError)) throw e;
        return bad((e as Error).message, 502);
      }
    },

    // A new session whose tools run on a machine of the fleet.
    "/api/fleet/sessions": {
      POST: async (req: Request) => {
        const b = await body(req);
        // The model runs here wherever the tools go: it is checked first, the
        // same way for every placement, before any session exists.
        const model = b.model || (await deps.providers.defaultModel());
        if (!model) return bad("no model is available: no provider has credentials", 409);
        try {
          await deps.providers.resolve(model);
        } catch (e) {
          return bad(`${(e as Error).message}: pick another model`, 409);
        }
        let placed: any;
        if (b.machine === "auto") {
          placed = await f.placeWork({ kind: "session", heavy: !!b.heavy, needs_gpu: !!b.needs_gpu });
          if (typeof placed === "string") return bad(placed);
          // The start box shows where Auto places the session before it is
          // sent (expect_machine); a different answer now is said, not taken.
          if (typeof b.expect_machine === "string" && b.expect_machine !== placed.machine_id)
            return json({ error: `Auto now places this on ${placed.machine} (${placed.reason}), not where the start box showed. Look at the new place and send again.`, placed }, 409);
          // A folder of this machine is not a folder there: Auto never trades
          // the project for another one in the other machine's directory.
          if (placed.machine_id !== "local" && b.local_workspace) {
            const there = f.row(placed.machine_id)?.workspace_root;
            return json({ error: `Auto places this on ${placed.machine}, where it would start in ${there ?? "its granted directory"}, not in ${b.local_workspace} on this machine. Pick this machine to work there, or ${placed.machine} to start in its directory.`, placed }, 409);
          }
          if (placed.machine_id === "local") {
            const ws = resolve(b.local_workspace || deps.workspace);
            const s = store.createSession({ model, workspace: ws, title: b.title });
            store.append(s.id, "note", { text: `Kept on ${f.name}: ${placed.reason}.` });
            bus.emit({ t: "session", session: store.session(s.id)! });
            if (b.text) engine.send(s.id, String(b.text), { images: b.images ?? [] });
            return json({ session: store.session(s.id), placed }, 201);
          }
          b.machine = placed.machine_id;
        }
        const m = f.row(String(b.machine ?? ""));
        if (!m) return bad("no such machine", 400);
        if (!m.workspace_root) return bad(`${m.name} has no granted directory: set one before starting sessions there`);
        const ws = b.workspace ? (isAbsolute(b.workspace) ? b.workspace : resolve(m.workspace_root, b.workspace)) : m.workspace_root;
        if (!contains(m.workspace_root, ws)) return bad(`${ws} is outside the directory granted on ${m.name}`);
        let st: any;
        try {
          // An ssh machine's first session puts its helper there: minutes at most (an upload).
          const r = await f.hands(m.id, "/api/fleet/hands/stat", { method: "POST", body: JSON.stringify({ path: ws, root: m.workspace_root }), idempotent: true });
          st = await r.json();
        } catch (e) {
          if (!(e instanceof LinkError)) throw e;
          return bad(`${m.name} does not answer: ${(e as Error).message}`, 409);
        }
        if (!st.dir) return bad(`not a directory on ${m.name}: ${ws}`);
        const s = store.createSession({ model, workspace: ws, title: b.title });
        store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(m.id, s.id);
        const next = store.session(s.id)!;
        bus.emit({ t: "session", session: next });
        if (placed) store.append(s.id, "note", { text: `Placed on ${m.name} by ${placed.reason}.` });
        if (b.text) engine.send(s.id, String(b.text), { images: b.images ?? [] });
        return json({ session: store.session(s.id), placed }, 201);
      },
    },

    "/api/fleet/messages": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        return json({ messages: msgs.list({ session_id: q.get("session_id") ?? undefined, state: q.get("state") ?? undefined }) });
      },
      // A message from a session of another daemon (or posted locally) to one of this daemon's.
      POST: async (req: Request) => {
        const c = paired(req);
        const b = await body(req);
        const from = b.from ?? {};
        if (!from.session_id || !from.daemon_id) return proven(bad("from must name a session and a daemon"), c, f.id);
        const to = store.session(String(b.to ?? ""));
        if (!to) return proven(bad("no such session", 404), c, f.id);
        const trusted = !!c && c.daemonId === from.daemon_id;
        try {
          const m = msgs.receive(to, String(b.text ?? ""), { ...from, limited: from.limited !== false }, b.wake !== false, trusted);
          return proven(json({ id: m.id, state: m.state, reason: m.reason ?? undefined }), c, f.id);
        } catch (e) {
          if (e instanceof HttpError) return proven(bad(e.message, e.status), c, f.id);
          throw e;
        }
      },
    },

    // Where one message stands (held, dropped, waiting, handled): for this
    // page, and for the paired daemon that sent it and waits for a notice.
    "/api/fleet/messages/:id/disposition": {
      GET: (req: any) => {
        const c = paired(req);
        const m = msgs.get(req.params.id);
        if (c && m && m.from.daemon_id !== c.daemonId) return proven(bad("no such message", 404), c, f.id);
        return proven(m ? json(msgs.disposition(m.id)) : bad("no such message", 404), c, f.id);
      },
    },

    "/api/fleet/messages/:id": {
      POST: async (req: any) => {
        const b = await body(req);
        if (!["deliver", "drop"].includes(b.decision)) return bad("decision is deliver or drop");
        try {
          const m = msgs.decide(req.params.id, b.decision);
          return json({ id: m.id, state: m.state });
        } catch (e) {
          if (e instanceof HttpError) return bad(e.message, e.status);
          throw e;
        }
      },
    },

    // A linked daemon's relay fetches what waits for it; a caller without its key gets nothing.
    "/api/fleet/outbox": {
      POST: async (req: Request) => {
        const c = paired(req);
        const b = await body(req);
        if (!String(b.daemon_id ?? "")) return proven(bad("daemon_id cannot be empty"), c, f.id);
        if (!c || c.daemonId !== b.daemon_id) return proven(json({ messages: [] }), c, f.id);
        return proven(json({ messages: msgs.pendingOutbound(c.daemonId) }), c, f.id);
      },
    },
    "/api/fleet/outbox/ack": {
      POST: async (req: Request) => {
        const c = paired(req);
        const b = await body(req);
        if (!c || c.daemonId !== b.daemon_id) return proven(bad("not a paired daemon", 403), c, f.id);
        msgs.ackOutbound(c.daemonId, Array.isArray(b.ids) ? b.ids.map(String).slice(0, 500) : []);
        return proven(json({ ok: true }), c, f.id);
      },
    },

    "/api/fleet/placement": {
      GET: () => json({ rules: f.rules() }),
      POST: async (req: Request) => {
        const b = await body(req);
        const known = (m: string) => {
          if (m === "local") return { id: "local", name: f.name, state: "ready" };
          const r = f.row(m) ?? f.byName(m);
          return r ? { id: r.id, name: r.name, state: r.state } : undefined;
        };
        const rules = validatePlacement(b.rules, known);
        if (typeof rules === "string") return bad(rules);
        f.setRules(rules);
        f.emitMachines();
        return json({ rules });
      },
    },

    "/api/fleet/place": {
      POST: async (req: Request) => {
        const r = await f.placeWork(await body(req));
        return typeof r === "string" ? bad(r) : json(r);
      },
    },

    "/api/sessions/:id/handoff": {
      GET: (req: any) => (store.session(req.params.id) ? json({ handoff: moves.latest(req.params.id) }) : bad("no such session", 404)),
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        try {
          return json({ handoff: moves.start(s, await body(req)) });
        } catch (e) {
          if (e instanceof MoveError) return bad(e.message, e.status);
          throw e;
        }
      },
    },

    // The portal: a session's dev server inside the workbench.
    "/api/sessions/:id/portal": {
      GET: (req: any) => (store.session(req.params.id) ? json({ ports: portsOf(req.params.id) }) : bad("no such session", 404)),
      POST: async (req: any) => {
        const id = req.params.id;
        if (!store.session(id)) return bad("no such session", 404);
        const b = await body(req);
        const port = Number(b.port);
        forgetOwnership();
        if (!portsOf(id).some((p) => p.port === port)) return bad(`no process of this session listens on port ${b.port}`);
        setOpen(id, port, !!b.open, !!b.point);
        return json({ ports: portsOf(id) });
      },
    },
    "/portal/:session/:port/:key": (req: any) => Response.redirect(`${new URL(req.url).pathname}/`, 308),
    "/portal/:session/:port/:key/*": (req: any, srv: any) => portal(req, srv),
    "/fleet-portal/:machine/:session/:port/:key": (req: any) => Response.redirect(`${new URL(req.url).pathname}/`, 308),
    "/fleet-portal/:machine/:session/:port/:key/*": (req: any, srv: any) => remotePortal(req, srv),

    "/api/sessions/:id/fleet": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const m = s.machine ? f.row(s.machine) : undefined;
        return json({ machine: m ? { id: m.id, name: m.name, colour: m.colour ?? undefined } : null, steps: f.steps(s.id) });
      },
    },

    // ---- what a paired daemon calls

    ...handsLinked,

    // This daemon's live frames, for the other daemon's relay. Opens with the
    // sessions it shows; a comment line every 5 s keeps the stream and proves it alive.
    "/api/fleet/stream": {
      GET: linked((req, c) => {
        let off = () => {};
        let ping: Timer | undefined;
        const enc = new TextEncoder();
        let forget = () => {};
        const stop = () => { off(); clearInterval(ping); forget(); };
        const stream = new ReadableStream({
          start(ctl) {
            forget = holdStream(ctl);
            const send = (x: unknown) => { try { ctl.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); } catch { stop(); } };
            send({ t: "snapshot", sessions: store.sessions() });
            off = bus.on((fr) => {
              if (fr.t === "feature" && fr.name === "fleet_outbox") { if (fr.data?.daemon_id === c.daemonId) send(fr); return; }
              if (fr.t === "error" || (fr.t === "feature" && fr.name.startsWith("fleet_"))) return; // never relay a relay
              send(fr);
            });
            ping = setInterval(() => { try { ctl.enqueue(enc.encode(": ping\n\n")); } catch { stop(); } }, KEEPALIVE_MS);
            req.signal?.addEventListener("abort", stop, { once: true });
          },
          cancel: stop,
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }),
    },

    // The portal of one of this daemon's sessions, for a paired daemon that
    // shows it: the dev server's answer as it is (the caller rewrites it), and
    // its socket, whose first frame proves the pairing.
    "/api/fleet/portal/*": async (req: any, srv: any) => {
      const c = paired(req);
      if (!c) return proven(bad("not a paired daemon", 403), null, f.id);
      const u = new URL(req.url);
      const t = portalTarget(u.pathname.slice("/api/fleet/portal/".length));
      if ("error" in t) return proven(t.error!, c, f.id);
      if (isUpgrade(req)) return bridge(req, srv, `ws://127.0.0.1:${t.port}/${t.rest}${u.search}`, { hello: JSON.stringify({ keel_proof: proof(c.key, c.nonce, f.id) }) });
      let r: Response;
      try { r = await upstream(req, t.port, `${t.rest}${u.search}`); } catch (e) { return proven(bad(`the dev server does not answer: ${(e as Error).message}`, 502), c, f.id); }
      const h = new Headers(r.headers);
      h.set("x-keel-portal", "1");
      h.set("x-keel-portal-point", t.point ? "1" : "0");
      h.delete("content-length"); h.delete("content-encoding"); h.delete("transfer-encoding");
      return proven(new Response(r.body, { status: r.status, headers: h }), c, f.id);
    },

    // Any /api route of this daemon, for a paired daemon's forwarder.
    // Its own port, not the request's host: through an ssh tunnel the host is
    // the far end's local port, which means nothing here.
    "/api/fleet/linked/*": async (req: any, srv: any) => linked(async (req, c) => {
      const url = new URL(req.url);
      const rest = url.pathname.slice("/api/fleet/linked/".length);
      if (/^fleet\/(machines|linked)\b/.test(decodeURIComponent(rest))) return bad("not through to a third daemon");
      // The caller's standing over there, as it signed it; none (an older
      // daemon) or a bad signature counts as a remote device with passkeys.
      const st = standingFrom(req, c);
      const standing: Standing = st ? { local: st.local === true, enrolled: st.enrolled !== false, present: typeof st.present === "string" ? st.present : null } : { local: false, enrolled: true, present: null };
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/${rest}${url.search}`, {
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
        headers: { "content-type": req.headers.get("content-type") ?? "application/json", ...innerHeaders(standing) },
        redirect: "manual",
      });
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/octet-stream" } });
    })(req),

    // The Rust Keel's peer records: in keel-bun every machine with a granted directory.
    "/api/peers": {
      GET: () => json({ peers: f.rows().filter((m) => m.workspace_root).map((m) => ({ ...f.view(m), healthy: m.state === "ready" || m.state === "busy", detail: m.reason ?? undefined })) }),
    },
  } satisfies Record<string, any>;
};

