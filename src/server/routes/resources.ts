// GET /api/resources?session_id=&history=&refresh=1
// What the daemon and the processes it started cost the machine: memory, CPU,
// threads and open files per process, by kind and by session, the disk of
// the state directory, and `history` minutes of samples (default 60, at most
// a day). `refresh` samples first.
import { Resources } from "../../admin/resources.ts";
import type { RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export let resources: Resources | undefined;

export const resourceRoutes: RouteModule = ({ store, bus }) => {
  resources?.stop(); // a hot reload makes a new sampler
  const r = (resources = new Resources(bus, store.stateDir));
  return {
    "/api/resources": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const history = q.get("history");
        if (history !== null && !Number.isFinite(Number(history))) return json({ error: "history is not a number" }, 400);
        const session = q.get("session_id") || undefined;
        if (session && !store.session(session)) return json({ error: "no such session" }, 404);
        return json(r.report({ session, historyMin: history === null ? undefined : Number(history), refresh: q.has("refresh") }));
      },
    },
  };
};
