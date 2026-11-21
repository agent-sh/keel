// Which build a session's tools and system prompt are from, what of the
// running build waits for its cache to be cold, and the owner's way to take
// the running build's now (src/engine/build-pin.ts).
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export const buildPinRoutes: RouteModule = ({ store, engine }) => ({
  "/api/sessions/:id/build": {
    GET: (req: any) => (store.session(req.params.id) ? json(engine.buildState(req.params.id)) : json({ error: "no such session" }, 404)),
  },
  // The session's next request carries this build's tools and prompt, and
  // writes its context to the cache again. An idle session takes them at once.
  "/api/sessions/:id/build/adopt": {
    POST: async (req: any) => (store.session(req.params.id) ? json(await engine.adoptBuild(req.params.id)) : json({ error: "no such session" }, 404)),
  },
});
