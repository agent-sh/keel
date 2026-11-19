import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import { jobsOf, running, stopJob } from "../tools/jobs.ts";
import { admit, initAccess } from "./admission.ts";
import { Live } from "./live.ts";
import index from "../../ui/index.html";
import { speedOffer } from "../providers/registry.ts";
import { carrySettings, commitSwitch } from "./switch.ts";
import { bundleRoutes, compressJson } from "./compress.ts";

// A feature module adds its routes here instead of editing this file.
export type RouteModule = (deps: Deps) => Record<string, any>;

// A module that upgrades a request to its own WebSocket (the portal's dev
// server sockets) passes `data: { kind }` to `srv.upgrade` and registers the
// kind here; every other socket is a page's frame stream.
export type SocketHandler = { open?(ws: Bun.ServerWebSocket<any>): void; message?(ws: Bun.ServerWebSocket<any>, m: string | Buffer): void; close?(ws: Bun.ServerWebSocket<any>, code: number, reason: string): void };
const socketKinds = new Map<string, SocketHandler>();
export const registerSocket = (kind: string, h: SocketHandler) => void socketKinds.set(kind, h);
const socketKind = (ws: Bun.ServerWebSocket<any>) => (ws.data && typeof ws.data === "object" ? socketKinds.get((ws.data as any).kind) : undefined);

export type Deps = { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker; workspace: string };

// Fields of `PATCH /api/sessions/:id` a feature module owns (marks, memory
// switches, a step budget). Every `check` runs before anything changes and
// refuses by throwing an Error with a `status`; `apply` runs after the core
// fields are written. `id` keeps one entry per module across hot reloads.
export type SessionPatch = { id: string; fields: string[]; check?(s: Session, body: any): void | Promise<void>; apply(s: Session, body: any): void | Promise<void> };
const patchers = new Map<string, SessionPatch>();
export const registerSessionPatch = (p: SessionPatch) => void patchers.set(p.id, p);
// Filters of `GET /api/sessions` a module owns (`?tag=`, `?pinned=1`).
const listFilters = new Map<string, (s: Session, q: URLSearchParams) => boolean>();
export const registerListFilter = (id: string, f: (s: Session, q: URLSearchParams) => boolean) => void listFilters.set(id, f);

// The core routes plus every module's. Two modules may share a path with
// different methods; a core path, or the same path and method twice, is a
// startup error, never a silent overwrite of one lane's handler by another's.
// A dev daemon stops at a clash so the lane that made it sees it at once; a
// built one records it in the errors table and keeps the first handler.
function withModules(core: Record<string, any>, modules: RouteModule[], deps: Deps, wrap: (h: any) => any, strict: boolean) {
  const clash = (msg: string) => {
    if (strict) throw new Error(msg);
    deps.errors.capture("server", new Error(msg), { at: "routes" });
  };
  const out: Record<string, any> = {};
  const owner: Record<string, string> = {};
  modules.forEach((m, i) => {
    const name = m.name || `module ${i}`;
    for (const [path, methods] of Object.entries(m(deps))) {
      if (path in core) { clash(`route clash: ${name} redefines core path ${path}`); continue; }
      const table = typeof methods === "function" ? { ALL: methods } : (methods as Record<string, any>);
      const slot = (out[path] ??= {});
      for (const [verb, h] of Object.entries(table)) {
        const taken = slot[verb] ? verb : slot.ALL ? "ALL" : verb === "ALL" ? Object.keys(slot)[0] : undefined;
        if (taken) { clash(`route clash: ${verb} ${path} in ${name}, already defined by ${owner[`${taken} ${path}`]}`); continue; }
        slot[verb] = wrap(h);
        owner[`${verb} ${path}`] = name;
      }
    }
  });
  // A bare handler stays a bare handler (Bun serves it for every method).
  return { ...core, ...Object.fromEntries(Object.entries(out).map(([p, t]) => [p, t.ALL ?? t])) };
}

// The UI's pages; the client routes the rest.
const PAGES = ["/", "/s/:id", "/settings", "/settings/:section"];

const json = (data: unknown, status = 200) => Response.json(data, { status });
// Bun's default idle timeout, and the point where a handler counts as slow.
const IDLE_S = 10;
const SLOW_MS = 8_000;
const bad = (message: string, status = 400) => json({ error: message }, status);

export function serve(deps: Deps, opts: { hostname: string; port: number; development?: boolean }, modules: RouteModule[] = []) {
  const { store, bus, engine, providers, errors } = deps;
  initAccess(store.stateDir);
  // Bun's publish writes a frame to every subscribed tab natively, serialized once.
  const live = new Live(store, bus, (topic, data) => server.publish(topic, data));
  live.state = (id) => ({ queue: store.queue(id), held: engine.isHeld(id), status: engine.statusOf(id) });

  const session = (id: string) => store.session(id);

  const wrap = (h: (req: Request & { params: any }, srv: Bun.Server<unknown>) => Promise<Response> | Response) =>
    async (req: any, srv: any) => {
      // Bun closes a connection whose request has had no bytes for its idle
      // timeout (10 s), even while the handler still works: a DELETE waiting
      // for a turn to wind down, a compaction, a drain ended as a connection
      // reset. A handler still running at 8 s turns that off for its request;
      // the idle timeout comes back for the keep-alive wait after it answers.
      let slow = false;
      const timer = setTimeout(() => { slow = true; srv.timeout(req, 0); }, SLOW_MS);
      try {
        const refused = admit(req, srv);
        if (refused) return refused;
        return await compressJson(req, await h(req, srv));
      } catch (e) {
        const st = (e as any)?.status;
        // `code`: a machine-readable reason, when the refusal has one (off_branch).
        if (typeof st === "number" && st >= 400 && st < 500) return json({ error: (e as Error).message, ...((e as any).code ? { code: (e as any).code } : {}) }, st);
        const rec = errors.capture("server", e, { url: new URL(req.url).pathname, method: req.method });
        return json({ error: rec.message, error_id: rec.id }, 500);
      } finally {
        clearTimeout(timer);
        if (slow) srv.timeout(req, IDLE_S);
      }
    };

  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: IDLE_S,
    reusePort: false, // one daemon per port (Bun 1.4 binds a taken port anyway: start.ts checks first)
    development: opts.development ? { hmr: true, console: true } : false,
    routes: withModules({
      // A built binary serves its bundle compressed (compress.ts); the dev
      // server bundles on request with HMR and serves the files itself.
      ...(bundleRoutes(index, PAGES, (e) => errors.capture("server", e, { at: "bundle compression" })) ?? Object.fromEntries(PAGES.map((p) => [p, index]))),

      "/api/models": {
        GET: wrap(async (req) => {
          const force = new URL(req.url).searchParams.has("refresh");
          const models = providers.marked(await providers.models(force));
          const c = providers.choices();
          const groups = providers.statuses().filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }));
          return json({ models, default: await providers.defaultModel(), pinned: (c.pinned ?? []).filter((id) => models.some((m) => m.id === id)), providers: groups });
        }),
      },

      "/api/sessions": {
        GET: wrap((req) => {
          const q = new URL(req.url).searchParams;
          const fs = [...listFilters.values()];
          return json({ sessions: store.sessions({ archived: q.has("archived") }).filter((s) => fs.every((f) => f(s, q))) });
        }),
        POST: wrap(async (req) => {
          const body = (await req.json().catch(() => ({}))) as any;
          const workspace = resolve(body.workspace || deps.workspace);
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return bad(`not a directory: ${workspace}`);
          const model = body.model || (await providers.defaultModel());
          if (!model) return bad("no model is available: no provider has credentials", 409);
          await providers.resolve(model);
          let s = store.createSession({ model, workspace, title: body.title });
          // Module fields given at creation (tags, max_steps, the memory switches) hold or refuse it.
          const mine = [...patchers.values()].filter((p) => p.fields.some((f) => body[f] !== undefined));
          try {
            for (const p of mine) await p.check?.(s, body);
            for (const p of mine) await p.apply(s, body);
          } catch (e) {
            store.deleteSession(s.id);
            throw e;
          }
          s = store.session(s.id)!;
          bus.emit({ t: "session", session: s });
          if (body.text || body.images?.length) engine.send(s.id, String(body.text ?? "").trim(), { images: body.images ?? [] });
          return json({ session: store.session(s.id) }, 201);
        }),
      },

      "/api/sessions/:id": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          return s
            ? json({ session: s, events: store.events(s.id), running: engine.isRunning(s.id), queue: store.queue(s.id), held: engine.isHeld(s.id), status: engine.statusOf(s.id), draft: live.draft(s.id), rev: bus.rev() })
            : bad("no such session", 404);
        }),
        PATCH: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const body = (await req.json()) as any;
          if (body.title !== undefined && !String(body.title).trim()) return bad("the title cannot be empty");
          // The whole change is checked before anything is written: a refused
          // request leaves the model, the settings and the history as they were.
          const moving = body.model && body.model !== s.model ? (await providers.resolve(body.model)).info : undefined;
          // A model switch keeps only what the new model takes (an effort or a
          // speed it does not list is dropped, as the profile POST does).
          let settings = moving ? carrySettings(s.settings, moving) : s.settings;
          if (body.settings) {
            settings = { ...settings };
            for (const [k, v] of Object.entries(body.settings)) {
              if (v === null || v === "") delete (settings as any)[k];
              else (settings as any)[k] = v;
            }
            const info = moving ?? (await providers.models()).find((m) => m.id === s.model);
            if (body.settings.effort && settings.effort && info && !info.efforts.includes(settings.effort)) return bad(`${info.name} does not take effort ${settings.effort}`);
            if (settings.fallback) await providers.resolve(settings.fallback);
            if (body.settings.speed && info && !speedOffer(info, settings.speed)) return bad(`${info.name} has no ${settings.speed} speed on ${info.provider}`);
            if (settings.compact_at !== undefined && !(Number(settings.compact_at) > 0)) return bad("compact_at must be a number of tokens above 0");
          }
          const mine = [...patchers.values()].filter((p) => p.fields.some((f) => body[f] !== undefined));
          for (const p of mine) await p.check?.(s, body);
          // Archiving stops the session: the turn is cut and its queue held. Its
          // background commands stop only when the request says so.
          if (body.archived === true && !s.archived) {
            const jobs = jobsOf(s.id).filter(running);
            if (jobs.length && body.stop_shells !== true) return json({ error: `the session still runs ${jobs.length} background command${jobs.length > 1 ? "s" : ""}: ${jobs.map((j) => j.command.slice(0, 80)).join("; ")}. Archive with stop_shells to stop them.`, jobs: jobs.map((j) => ({ id: j.id, command: j.command })) }, 409);
            await engine.interrupt(s.id);
            await Promise.all(jobs.map((j) => stopJob(j, "was stopped: its session was archived")));
          }
          const core = body.title !== undefined || body.model !== undefined || body.archived !== undefined || body.settings !== undefined;
          const patch = { title: body.title?.trim(), archived: body.archived, settings };
          let next = moving ? await commitSwitch(store, bus, providers, s, moving, patch) : core ? store.updateSession(s.id, { ...patch, model: body.model }) : s;
          for (const p of mine) await p.apply(next, body);
          next = store.session(s.id)!;
          bus.emit({ t: "session", session: next });
          return json({ session: next });
        }),
        DELETE: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          // Its subagent sessions go with it (the rows cascade): each is
          // stopped first, deepest first, so no turn writes to a session
          // already gone. Their commands and spilled files go too.
          for (const id of [...store.descendants(s.id).reverse(), s.id]) {
            const x = store.session(id);
            if (!x) continue;
            await engine.interrupt(id);
            await Promise.all(jobsOf(id).filter(running).map((j) => stopJob(j, "was stopped: its session was deleted")));
            rmSync(join(store.stateDir, "spill", id), { recursive: true, force: true });
            store.deleteSession(id);
            bus.emit({ t: "session", session: { ...x, archived: true, phase: "idle" }, deleted: true });
          }
          return json({ ok: true });
        }),
      },

      "/api/sessions/:id/events": {
        GET: wrap((req) => {
          const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
          return json({ events: store.events(req.params.id, after) });
        }),
      },

      "/api/sessions/:id/messages": {
        POST: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          if (s.archived) return bad("the session is archived", 409);
          const body = (await req.json()) as any;
          const text = String(body.text ?? "").trim();
          // An image or a file may go without a caption; an edit needs words.
          if (!text && !(body.edit_of ? store.event(String(body.edit_of))?.data.images?.length : body.images?.length)) return bad("text cannot be empty");
          if (body.mode && !["send", "steer", "queue"].includes(body.mode)) return bad(`unknown mode ${body.mode}`);
          if (body.edit_of) return json(await engine.edit(s.id, String(body.edit_of), text), 201);
          return json(engine.send(s.id, text, { mode: body.mode, images: body.images ?? [] }), 201);
        }),
      },

      "/api/sessions/:id/interrupt": {
        POST: wrap(async (req) => {
          // `by`: who asked (the workbench sends "owner"), kept on the turn's end.
          const body = (await req.json().catch(() => ({}))) as { by?: unknown };
          await engine.interrupt(req.params.id, typeof body.by === "string" && /^[a-z-]{1,24}$/.test(body.by) ? body.by : undefined);
          return json({ ok: true });
        }),
      },

      "/api/health": { GET: () => json({ ok: true, pid: process.pid }) },
    }, modules, deps, wrap, !!opts.development),

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const refused = admit(req, srv);
        if (refused) return refused;
        if (srv.upgrade(req)) return;
        return bad("websocket upgrade failed");
      }
      return bad("not found", 404);
    },

    websocket: {
      open(ws) { const h = socketKind(ws); if (h) h.open?.(ws); else live.open(ws); },
      message(ws, m) { const h = socketKind(ws); if (h) h.message?.(ws, m); else live.message(ws, m); },
      close(ws, code, reason) { socketKind(ws)?.close?.(ws, code, reason); },
      // Pings while quiet; a client silent for 40 s is gone. One that stops
      // reading is closed instead of buffered without end: a page resumes on reconnect.
      idleTimeout: 40,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
    },
  });
  return server;
}
