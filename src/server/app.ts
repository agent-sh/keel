import type { ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import index from "../../ui/index.html";

// A feature module adds its routes here instead of editing this file.
export type RouteModule = (deps: Deps) => Record<string, any>;

export type Deps = { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker; workspace: string };

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (message: string, status = 400) => json({ error: message }, status);

export function serve(deps: Deps, opts: { hostname: string; port: number; development?: boolean }, modules: RouteModule[] = []) {
  const { store, bus, engine, providers, errors } = deps;
  const sockets = new Set<ServerWebSocket<unknown>>();
  bus.on((f) => {
    const msg = JSON.stringify(f);
    for (const ws of sockets) ws.send(msg);
  });

  const session = (id: string) => store.session(id);

  const wrap = (h: (req: Request & { params: any }, srv: Bun.Server<unknown>) => Promise<Response> | Response) =>
    async (req: any, srv: any) => {
      try {
        return await h(req, srv);
      } catch (e) {
        const st = (e as any)?.status;
        if (typeof st === "number" && st >= 400 && st < 500) return json({ error: (e as Error).message }, st);
        const rec = errors.capture("server", e, { url: new URL(req.url).pathname, method: req.method });
        return json({ error: rec.message, error_id: rec.id }, 500);
      }
    };

  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    development: opts.development ? { hmr: true, console: true } : false,
    routes: {
      "/": index,
      "/s/:id": index,
      "/settings": index,
      "/settings/:section": index,

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
        GET: wrap((req) => json({ sessions: store.sessions({ archived: new URL(req.url).searchParams.has("archived") }) })),
        POST: wrap(async (req) => {
          const body = (await req.json().catch(() => ({}))) as any;
          const workspace = resolve(body.workspace || deps.workspace);
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return bad(`not a directory: ${workspace}`);
          const model = body.model || (await providers.defaultModel());
          if (!model) return bad("no model is available: no provider has credentials", 409);
          await providers.resolve(model);
          const s = store.createSession({ model, workspace, title: body.title });
          bus.emit({ t: "session", session: s });
          if (body.text) engine.send(s.id, body.text, { images: body.images ?? [] });
          return json({ session: store.session(s.id) }, 201);
        }),
      },

      "/api/sessions/:id": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          return s
            ? json({ session: s, events: store.events(s.id), running: engine.isRunning(s.id), queue: store.queue(s.id), held: engine.isHeld(s.id) })
            : bad("no such session", 404);
        }),
        PATCH: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const body = (await req.json()) as any;
          if (body.title !== undefined && !String(body.title).trim()) return bad("the title cannot be empty");
          if (body.model && body.model !== s.model) {
            const { info } = await providers.resolve(body.model);
            const from = (await providers.models()).find((m) => m.id === s.model)?.name ?? s.model;
            bus.emit({ t: "event", event: store.append(s.id, "note", { kind: "model", text: `Model changed from ${from} to ${info.name}.` }) });
          }
          let settings = s.settings;
          if (body.settings) {
            settings = { ...s.settings };
            for (const [k, v] of Object.entries(body.settings)) {
              if (v === null || v === "") delete (settings as any)[k];
              else (settings as any)[k] = v;
            }
            const info = (await providers.models()).find((m) => m.id === (body.model ?? s.model));
            if (settings.effort && info && !info.efforts.includes(settings.effort)) return bad(`${info.name} does not take effort ${settings.effort}`);
            if (settings.fallback) await providers.resolve(settings.fallback);
            if (settings.compact_at !== undefined && !(Number(settings.compact_at) > 0)) return bad("compact_at must be a number of tokens above 0");
          }
          // Archiving stops the session: the turn is cut and its queue held.
          if (body.archived === true) await engine.interrupt(s.id);
          const next = store.updateSession(s.id, { title: body.title?.trim(), model: body.model, archived: body.archived, settings });
          bus.emit({ t: "session", session: next });
          return json({ session: next });
        }),
        DELETE: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          await engine.interrupt(s.id);
          store.deleteSession(s.id);
          bus.emit({ t: "session", session: { ...s, archived: true, phase: "idle", title: s.title } });
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
          if (!text) return bad("text cannot be empty");
          if (body.mode && !["send", "steer", "queue"].includes(body.mode)) return bad(`unknown mode ${body.mode}`);
          if (body.edit_of) return json(await engine.edit(s.id, String(body.edit_of), text), 201);
          return json(engine.send(s.id, text, { mode: body.mode, images: body.images ?? [] }), 201);
        }),
      },

      "/api/sessions/:id/interrupt": {
        POST: wrap(async (req) => {
          await engine.interrupt(req.params.id);
          return json({ ok: true });
        }),
      },

      "/api/health": { GET: () => json({ ok: true, pid: process.pid }) },
      ...Object.fromEntries(
        modules.flatMap((m) => Object.entries(m(deps))).map(([path, methods]) => [
          path,
          typeof methods === "function"
            ? wrap(methods)
            : Object.fromEntries(Object.entries(methods as Record<string, any>).map(([k, h]) => [k, wrap(h)])),
        ]),
      ),
    },

    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req)) return;
        return bad("websocket upgrade failed");
      }
      return bad("not found", 404);
    },

    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message() {},
    },
  });
  return server;
}
