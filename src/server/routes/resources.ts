// GET /api/resources?session_id=&history=&refresh=1
// What the daemon and the processes it started cost the machine: memory, CPU,
// threads and open files per process, by kind and by session, the disk of
// the state directory, and `history` minutes of samples (default 60, at most
// a day). `refresh` samples first. `daemon.given_back`: when memory was last given back to the system, why (the daemon
// came to rest, or its unit's bound was passed) and its resident memory before and after. `daemon.kept_events`: the sessions whose
// events the daemon holds in memory, what they are charged and the budget.
// `daemon.checkpoint`: the checkpoint thread's counts (passes, starts of the
// log, how long it held the write lock, the most frames the log held).
// `heavy`: the heavy-command pool (src/tools/heavy.ts): its settings, the
// machine as it reads it, the room, the commands that hold a slot and the line.
//
// Frame: { t: "feature", name: "heavy", session_id, data: HeavyChange }: a
// command of the session started waiting for a slot, moved in line, started or
// left the line (the session's state and its turn's trace read it).
import { restOf } from "../../core/rest.ts";
import { collected } from "../../core/collector.ts";
// `daemon.search_fill`: a search index made again, filled on its thread
// (search-fill.ts): running, events filled, how long it took.
import { fill } from "./search-fill.ts";
import { Resources } from "../../admin/resources.ts";
import { checkpointerOf } from "../../core/checkpoint.ts";
// `left`: what commands left running in their job scopes hold (src/automation/scopes.ts, its last pass), and
// the job scopes of other daemons that this one never touches.
import { heldNow } from "../../automation/scopes.ts";
import type { RouteModule } from "../app.ts";
import { heavyChanged, pool } from "../../tools/heavy.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

export let resources: Resources | undefined;

export const resourceRoutes: RouteModule = ({ store, bus }) => {
  resources?.stop(); // a hot reload makes a new sampler
  const r = (resources = new Resources(bus, store.stateDir));
  heavyChanged.tell = (c) => bus.emit({ t: "feature", name: "heavy", session_id: c.session_id, data: c });
  return {
    "/api/resources": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const history = q.get("history");
        if (history !== null && !Number.isFinite(Number(history))) return json({ error: "history is not a number" }, 400);
        const session = q.get("session_id") || undefined;
        if (session && !store.session(session)) return json({ error: "no such session" }, 404);
        const report = r.report({ session, historyMin: history === null ? undefined : Number(history), refresh: q.has("refresh") });
        // What the daemon holds of its sessions' events: how many sessions, the memory they are charged, and the budget.
        // And what its checkpoint thread did with the store's log (src/core/checkpoint.ts): absent when none works.
        const checkpoint = checkpointerOf(store)?.counts;
        return json({ ...report, left: heldNow(), daemon: { ...report.daemon, kept_events: store.keptEvents(), given_back: restOf()?.last ?? null, collector: collected, ...(checkpoint ? { checkpoint } : {}), ...(fill.running || fill.ms !== undefined ? { search_fill: fill } : {}) }, heavy: pool.view() });
      },
    },
  };
};
