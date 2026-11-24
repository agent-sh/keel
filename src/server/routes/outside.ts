// Sessions another harness runs on this machine, in Keel's record while they
// run (src/integrations/outside/service.ts).
//
// GET  /api/outside                          -> what is watched and what that cost so far
// GET  /api/sessions/:id/outside             -> its files, its usage by model with cost, its source;
//                                               the transcript is brought up to date first
// POST /api/sessions/:id/outside/copy        -> a Keel session that goes on with it (the import path:
//                                               its copy brought up to date, else a new copy)
import { statSync } from "node:fs";
import { Outside } from "../../integrations/outside/service.ts";
import { modelFor, sharedImports } from "../../integrations/import/service.ts";
import { record } from "../../automation/failures.ts";
import { classOf } from "../../automation/failure-groups.ts";
import type { RouteModule } from "../app.ts";
import { seesOutside } from "../admission.ts";
import "../../integrations/outside/settings.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

export let outside: Outside | undefined;

export const outsideRoutes: RouteModule = (deps) => {
  const { store, bus, engine, providers, errors } = deps;
  const g = globalThis as any;
  // A hot reload makes the module again: the watches of the one before go first.
  g.__keelOutside?.stop();
  outside = g.__keelOutside = new Outside({
    store, bus, workspace: deps.workspace,
    price: (model, h) => providers.catalog.lookup(model, h === "claude" ? "anthropic" : "openai")?.price,
    viewed: (id) => !!engine.viewed?.(id),
    // The session's failures, grouped by cause as its own would be; nothing is owed to a model (none runs here).
    failed: (id, f) => { record(id, { kind: f.kind, cls: f.kind === "tool" ? f.tool : classOf(f.text), message: f.text }); },
    trouble: (e, at) => errors.capture("server", e, { at }),
  });
  outside.start();
  const o = outside;
  return {
    // (The owner's alone, as the sessions are: peer-scope.ts blindTo.)
    "/api/outside": { GET: (req: Request) => (seesOutside(req) ? json(o.status()) : bad("not found", 404)) },
    "/api/sessions/:id/outside": {
      GET: async (req: Request & { params: { id: string } }) => {
        const d = await o.details(req.params.id);
        return d ? json(d) : bad("not a session of another harness", 404);
      },
    },
    "/api/sessions/:id/outside/copy": {
      POST: async (req: Request & { params: { id: string } }) => {
        const f = o.source(req.params.id);
        if (!f) return bad("its transcript is no longer where it was, or holds another session", 409);
        const imports = sharedImports(store);
        const model = await modelFor(providers, f);
        if (!model) return bad("no model is available: no provider has credentials", 409);
        const workspace = isDir(f.cwd) ? f.cwd! : deps.workspace;
        const prior = imports.links(f.harness, f.id, f.path)[0];
        const seq = prior ? store.lastSeq(prior.session_id) : 0;
        // The copy made before, brought up to date; a new one where it went on here or its source rewound.
        let r;
        if (prior && !imports.wentOn(prior.session_id)) {
          r = await imports.import(f, { mode: "update", model, workspace, session_id: prior.session_id }).catch((e) => ((e as any)?.status === 409 ? undefined : Promise.reject(e)));
        }
        r ??= await imports.import(f, { mode: "new", model, workspace });
        if (r.action === "updated") for (const e of store.events(r.session.id, seq)) bus.emit({ t: "event", event: e });
        bus.emit({ t: "session", session: r.session });
        return json({ action: r.action, session: r.session, imported_events: r.imported_events }, r.action === "created" ? 201 : 200);
      },
    },
  };
};
