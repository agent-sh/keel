// Every session at once (src/admin/overview.ts).
//
// GET /api/overview?since=&until=&format=&ids=&of=&max=
//   -> { as_of, since, until, sessions, agents?, hidden, totals }
//   since: a span back from now (90s, 30m, 1h, 2d), epoch milliseconds or an
//   ISO time; a day by default, at most seven days back. of: a session whose own agents are listed
//   first (and which is left out of the sessions). max: sessions listed (20 by
//   default, at most 200), the ones that need the owner first. format=text: the same as
//   plain text for a model or a terminal (ids=0 leaves the ids off the lines).
// Content-free: titles, states, classes, counts, durations and ids.
import { bindOverview, DEFAULT_SINCE, overview, overviewText, tooFarBack, type From } from "../../admin/overview.ts";
import { parseSince, Timeline } from "../../admin/timeline.ts";
import { hasPending } from "../../automation/core.ts";
import { agentCounts, sessionState } from "../../automation/state.ts";
import { allPendingQuestions } from "../../tools/interact.ts";
import type { RouteModule } from "../app.ts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const overviewRoutes: RouteModule = ({ store, engine }) => {
  const timeline = new Timeline(store, {
    isRunning: (id) => engine.isRunning(id),
    turnOf: (id) => engine.turnOf(id),
    statusOf: (id) => engine.statusOf(id),
    isHeld: (id) => engine.isHeld(id),
    owed: hasPending,
    questions: allPendingQuestions,
  });
  const from: From = {
    store,
    counts: () => agentCounts({ store }),
    state: (s, counts) => sessionState(s, { counts, from: { store, engine } }),
    now: (id) => timeline.now(id),
  };
  bindOverview(from);

  return {
    "/api/overview": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const of = q.get("of");
        if (of && !store.session(of)) return bad("no such session", 404);
        const max = q.get("max");
        if (max !== null && !/^[1-9]\d*$/.test(max)) return bad("max is a whole number of sessions from 1 up");
        const now = Date.now();
        const since = q.get("since") ? parseSince(q.get("since")!, now) : now - DEFAULT_SINCE;
        const far = tooFarBack(since, now);
        if (far) return bad(far);
        const until = q.get("until") ? parseSince(q.get("until")!, now) : undefined;
        const o = overview(from, { since, until, of: of ?? undefined, max: max === null ? undefined : Number(max) });
        const headers = { "cache-control": "no-store" };
        if (q.get("format") === "text") return new Response(overviewText(o, { ids: q.get("ids") !== "0" }) + "\n", { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
        return Response.json(o, { headers });
      },
    },
  };
};
