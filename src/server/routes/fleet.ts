// The fleet's routes: identity and pairing, machines and their checks, one
// view of every session across linked daemons, the forwarder to another
// daemon's API, sessions placed on a machine, and the paired-only endpoints
// another daemon calls (facts, live stream, hands).
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { registerHooks } from "../../engine/hooks.ts";
import { instructionFiles } from "../../engine/turn.ts";
import { localFacts } from "../../fleet/facts.ts";
import { Fleet } from "../../fleet/fleet.ts";
import { runHands, WORKSPACE_TOOLS } from "../../fleet/hands.ts";
import { callerOf, LinkError, linkFetch, loopbackUrl, proven } from "../../fleet/link.ts";
import { remoteRun } from "../../fleet/remote.ts";
import { plainAlias, sshHosts } from "../../fleet/sshconfig.ts";
import { bindFleetTools } from "../../fleet/tools.ts";
import { inside } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";
import { gate } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const COLOUR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl|oklch)a?\([^)]*\))$/i;
const KEEPALIVE_MS = 5_000; // under Bun's 10 s idle timeout: a long call keeps its connection

export let fleet: Fleet | undefined;

export const fleetRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, engine, errors } = deps;
  const f = (fleet = new Fleet(store, bus, errors));
  bindFleetTools(f);
  f.start();
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
        const p = await f.peer(m.id);
        const r = await linkFetch(p, "/api/fleet/hands/instructions", { method: "POST", body: JSON.stringify({ cwd: s.workspace, root: m.workspace_root }) });
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
      if (!s.machine || !WORKSPACE_TOOLS.has(call.tool.name)) return;
      const m = f.row(s.machine);
      if (!m) return { deny: "This session's machine was removed from the fleet: its tools have nowhere to run." };
      if (!m.workspace_root) return { deny: `${m.name} has no granted directory: nothing runs there.` };
      const sandbox = gate?.perm(s.id).sandbox ?? "off";
      if (sandbox === "read-only" && !call.tool.readOnly) return { deny: "A read-only sandbox reaches no other machine." };
      return { ctx: { dispatch: (tool, input, ctx) => remoteRun(f, m, ctx, { tool: tool.name, input, cwd: ctx.cwd, sandbox: sandbox !== "off" }) } };
    },
  });

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
    const enabled = new Set(f.rows().map((m) => m.ssh_host).filter(Boolean));
    const offered = sshHosts().filter((h) => !enabled.has(h)).map((h) => ({ id: `ssh:${h}`, name: h, source: "ssh", enabled: false, state: "unknown", ssh_host: h }));
    return [await f.localView(), ...f.rows().map((m) => f.view(m)), ...offered];
  };

  // Every session across machines, from the relays: never waits on a link.
  const fleetView = () => {
    const local = store.sessions();
    const machines: any[] = [{ id: "local", name: f.name, state: "ready", sessions: local }];
    const recents: any[] = local.map((s) => ({ machine_id: "local", machine: f.name, session_id: s.id, title: s.title, phase: s.phase, updated_ms: s.updated, failed: s.phase === "error" }));
    for (const m of f.rows()) {
      if (!m.link_key && m.state === "unknown") continue;
      const r = f.remoteSessions(m.id);
      const v = f.view(m);
      machines.push({ id: m.id, name: m.name, state: v.daemon.state === "linked" ? m.state : "offline", sessions: r.sessions, reason: v.daemon.reason ?? m.reason ?? undefined, colour: m.colour ?? undefined, stale: r.stale || undefined, retry_at_ms: r.retry_at_ms });
      if (!r.stale) for (const s of r.sessions) recents.push({ machine_id: m.id, machine: m.name, session_id: s.id, title: s.title, phase: s.phase, updated_ms: s.updated, failed: s.phase === "error" });
    }
    recents.sort((a, b) => b.updated_ms - a.updated_ms);
    return { daemon_id: f.id, machines, recents };
  };

  return {
    "/api/fleet": { GET: () => json(fleetView()) },

    "/api/fleet/identity": {
      GET: (req: Request) => proven(json(f.identity()), paired(req), f.id),
    },

    // Another daemon links to this one: a secret made for it, kept here.
    "/api/fleet/pair": {
      POST: async (req: Request) => {
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
          if (!plainAlias(host) || !sshHosts().includes(host)) return bad(`${host} is not a concrete host of the ssh configuration`);
          if (f.rows().some((r) => r.ssh_host === host)) return bad(`${host} is already enabled`);
          const port = Number(b.daemon_port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) return bad("daemon_port must be the port its daemon listens on there");
          m = f.add({ name: String(b.name || host), source: "ssh", ssh_host: host, daemon_port: port, workspace_root: root });
        } else {
          const url = loopbackUrl(String(b.daemon_url ?? ""));
          if (!url) return bad("daemon_url must be http on a loopback address (reach another machine through its ssh host)");
          const name = String(b.name ?? "").trim();
          if (!name) return bad("a machine needs a name");
          if (f.rows().some((r) => r.name.toLowerCase() === name.toLowerCase())) return bad(`a machine is already named ${name}`);
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
        f.remove(id);
        return json({ machines: await machinesList() });
      },
    },

    "/api/fleet/machines/:id/check": {
      POST: async (req: any) => {
        const id: string = req.params.id;
        if (id === "local") return json(await f.localView());
        if (id.startsWith("ssh:")) {
          const alias = id.slice(4);
          if (!sshHosts().includes(alias)) return bad("no such machine", 404);
          return json(await f.checkSsh(alias));
        }
        if (!f.row(id)) return bad("no such machine", 404);
        await f.check(id);
        return json(machineView(id));
      },
    },

    // /api/fleet/machines/:id/api/<rest> is /api/<rest> on that machine's daemon.
    "/api/fleet/machines/:id/api/*": async (req: any) => {
      const url = new URL(req.url);
      const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
      if (!f.row(id)) return bad("no such machine", 404);
      const rest = url.pathname.slice(`/api/fleet/machines/${url.pathname.split("/")[4]}/api/`.length);
      let decoded: string;
      try { decoded = decodeURIComponent(rest); } catch { return bad("a path that cannot be read"); }
      if (decoded.split(/[\\/]/).some((p) => p === ".." || p === ".") || /^fleet\/(machines|linked)\b/.test(decoded)) {
        return bad("the path leaves the other daemon's /api or goes through it to a third daemon");
      }
      try {
        const p = await f.peer(id);
        const r = await linkFetch(p, `/api/fleet/linked/${rest}${url.search}`, {
          method: req.method,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
          headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
          timeout: 60_000,
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
        const m = f.row(String(b.machine ?? ""));
        if (!m) return bad("no such machine", 400);
        if (!m.workspace_root) return bad(`${m.name} has no granted directory: set one before starting sessions there`);
        const ws = b.workspace ? (isAbsolute(b.workspace) ? b.workspace : resolve(m.workspace_root, b.workspace)) : m.workspace_root;
        if (!inside(ws, m.workspace_root)) return bad(`${ws} is outside the directory granted on ${m.name}`);
        let st: any;
        try {
          const p = await f.peer(m.id);
          const r = await linkFetch(p, "/api/fleet/hands/stat", { method: "POST", body: JSON.stringify({ path: ws, root: m.workspace_root }) });
          st = await r.json();
        } catch (e) {
          if (!(e instanceof LinkError)) throw e;
          return bad(`${m.name} does not answer: ${(e as Error).message}`, 409);
        }
        if (!st.dir) return bad(`not a directory on ${m.name}: ${ws}`);
        const model = b.model || (await deps.providers.defaultModel());
        if (!model) return bad("no model is available: no provider has credentials", 409);
        await deps.providers.resolve(model);
        const s = store.createSession({ model, workspace: ws, title: b.title });
        store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(m.id, s.id);
        const next = store.session(s.id)!;
        bus.emit({ t: "session", session: next });
        if (b.text) engine.send(s.id, String(b.text), b.images ?? []);
        return json({ session: store.session(s.id) }, 201);
      },
    },

    "/api/sessions/:id/fleet": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const m = s.machine ? f.row(s.machine) : undefined;
        return json({ machine: m ? { id: m.id, name: m.name, colour: m.colour ?? undefined } : null, steps: f.steps(s.id) });
      },
    },

    // ---- what a paired daemon calls

    "/api/fleet/facts": {
      GET: linked(async (req) => json(await localFacts(new URL(req.url).searchParams.get("root") ?? undefined))),
    },

    // This daemon's live frames, for the other daemon's relay. Opens with the
    // sessions it shows; a comment line every 5 s keeps the stream and proves it alive.
    "/api/fleet/stream": {
      GET: linked((req) => {
        let off = () => {};
        let ping: Timer | undefined;
        const enc = new TextEncoder();
        const stop = () => { off(); clearInterval(ping); };
        const stream = new ReadableStream({
          start(c) {
            const send = (x: unknown) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); } catch { stop(); } };
            send({ t: "snapshot", sessions: store.sessions() });
            off = bus.on((fr) => {
              if (fr.t === "error" || (fr.t === "feature" && fr.name.startsWith("fleet_"))) return; // never relay a relay
              send(fr);
            });
            ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch { stop(); } }, KEEPALIVE_MS);
            req.signal?.addEventListener("abort", stop, { once: true });
          },
          cancel: stop,
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
      }),
    },

    // One workspace tool call for a paired daemon's session. The answer is JSON
    // preceded by spaces sent while the call runs, so the connection stays open.
    "/api/fleet/hands": {
      POST: linked(async (req) => {
        const q = await body(req);
        const enc = new TextEncoder();
        const ctl = new AbortController();
        req.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
        const stream = new ReadableStream({
          async start(c) {
            const tick = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch {} }, KEEPALIVE_MS);
            let out;
            try {
              out = await runHands(q, spillRoot, ctl.signal);
            } catch (e) {
              const rec = errors.capture("tool", e, { at: "fleet hands", tool: q.tool });
              out = { content: `Tool failed on this machine: ${rec.message}`, is_error: true };
            }
            clearInterval(tick);
            try { c.enqueue(enc.encode(JSON.stringify(out))); c.close(); } catch {}
          },
          cancel: () => ctl.abort(),
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }),
    },

    "/api/fleet/hands/instructions": {
      POST: linked(async (req) => {
        const b = await body(req);
        if (!b.cwd || !b.root || !inside(resolve(b.cwd), resolve(b.root))) return json({ text: "" });
        return json({ text: existsSync(b.cwd) ? instructionFiles(resolve(b.cwd)) : "" });
      }),
    },

    "/api/fleet/hands/stat": {
      POST: linked(async (req) => {
        const b = await body(req);
        const p = resolve(String(b.path ?? ""));
        if (!b.root || !inside(p, resolve(b.root))) return json({ exists: false, dir: false, error: "outside the granted directory" });
        try {
          const st = statSync(p);
          return json({ exists: true, dir: st.isDirectory() });
        } catch {
          return json({ exists: false, dir: false });
        }
      }),
    },

    // Any /api route of this daemon, for a paired daemon's forwarder.
    "/api/fleet/linked/*": linked(async (req) => {
      const url = new URL(req.url);
      const rest = url.pathname.slice("/api/fleet/linked/".length);
      if (/^fleet\/(machines|linked)\b/.test(decodeURIComponent(rest))) return bad("not through to a third daemon");
      const r = await fetch(`${url.origin}/api/${rest}${url.search}`, {
        method: req.method,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
        headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
        redirect: "manual",
      });
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/octet-stream" } });
    }),

    // The Rust Keel's peer records: in keel-bun every machine with a granted directory.
    "/api/peers": {
      GET: () => json({ peers: f.rows().filter((m) => m.workspace_root).map((m) => ({ ...f.view(m), healthy: m.state === "ready" || m.state === "busy", detail: m.reason ?? undefined })) }),
    },
  } satisfies Record<string, any>;
};

