// Which build a session's tools and system prompt are from, what of the
// running build waits for its cache to be cold, and the owner's way to take
// the running build's now, in one session or in all (src/engine/build-pin.ts).
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
  // The open sessions on an earlier build's tools or prompt, with the tokens
  // their next requests would write again: what POST /api/build/adopt costs.
  "/api/build/pins": {
    GET: async () => json(await engine.buildPins()),
  },
  // Every open session takes this build's tools and prompt at its next request.
  "/api/build/adopt": {
    POST: () => json(engine.adoptAllBuilds()),
  },
});
