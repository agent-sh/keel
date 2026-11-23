// Where a session's or an agent tree's hours went (src/admin/hours-rows.ts).
//
// GET /api/sessions/:id/hours?since=&until=&format=text
//   -> { root, title, from, to, wall_ms, live, agents, classes, accounted, recorded, inferred, inferred_ms, top, top_in, line, members }
//   classes: milliseconds by class along the tree's critical path (they add
//   up to wall_ms); members: each session's own time by class. since/until:
//   a span back from now (2h, 1d), epoch milliseconds or an ISO time.
//   format=text: the same in a few lines, for a model.
//   :id is a session's id or an agent's (src/admin/session-ref.ts).
// Read on the read thread: a tree's spans, turns and waits are many rows.
// Content-free: ids, titles, classes and durations.
import { sessionRef, sessionRefs } from "../../admin/session-ref.ts";
import { parseSince } from "../../admin/timeline.ts";
import { hoursText, type TreeHours } from "../../admin/hours-rows.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const hoursRoutes: RouteModule = ({ store }) => {
  const read = (session: string, since?: number | null, until?: number | null): Promise<TreeHours | null> =>
    readsOf(store).run("hours.tree", { session, now: Date.now(), ...(since != null ? { since } : {}), ...(until != null ? { until } : {}) });

  // The text form as a tool: a coordinator reads its tree's hours without its transcripts.
  const TreeTime: Tool = {
    name: "keel__tree_time",
    readOnly: true,
    description:
      "Where the time of this session's agent tree went, or of one agent you started and the agents under it: wall time by class (model requests, commands, waiting for agents, for the parent, on waits, for the owner, slots, the provider, compaction, restarts) along the tree's critical path (while a session waits for its agents, the time counts as the agent that ends last, and so on down, so the classes add up to the wall time), its bottleneck in one line, the shares from records and those inferred from what started a next turn, and each agent's own split. A few hundred tokens; no model request.",
    input_schema: {
      type: "object",
      properties: {
        session: { type: "string", description: "An agent you started (its id or session id). Omit for this session's whole tree." },
        since: { type: "string", description: "Only time after this: a span back from now (90m, 1d) or an ISO time." },
      },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const want = String(input?.session ?? "").trim();
      let id = ctx.sessionId;
      if (want && want !== ctx.sessionId) {
        const found = sessionRefs(store, want, ctx.sessionId);
        if (found.length > 1) return fail(`${want} names ${found.length} of your agents; give more of the id.`);
        if (!found[0]) return fail("NOT_YOURS: this tool reads this session and the agents it started. Name one of your agents, or leave session out.");
        id = found[0];
      }
      try {
        const t = await read(id, input?.since ? parseSince(String(input.since)) : null);
        return t ? ok(hoursText(t)) : fail("NOT_AVAILABLE: that session was deleted.");
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  };
  registerShared(TreeTime);

  return {
    "/api/sessions/:id/hours": {
      GET: async (req: Request & { params: { id: string } }) => {
        const s = sessionRef(store, req.params.id);
        const q = new URL(req.url).searchParams;
        let since: number | null = null, until: number | null = null;
        try {
          since = q.get("since") ? parseSince(q.get("since")!) : null;
          until = q.get("until") ? parseSince(q.get("until")!) : null;
        } catch (e) {
          return bad((e as Error).message);
        }
        const t = await read(s.id, since, until);
        if (!t) return bad(`no session ${req.params.id}`, 404);
        const headers = { "cache-control": "no-store" };
        if (q.get("format") === "text") return new Response(hoursText(t) + "\n", { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
        return Response.json(t, { headers });
      },
    },
  };
};
