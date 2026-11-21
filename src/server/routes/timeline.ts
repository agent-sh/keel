// The session timeline: what happened in a session, what it is doing now, what
// it waits on and what went wrong, from one place.
//
// GET /api/sessions/:id/timeline?before=&limit=&only=&since=&now=&format=
//   -> { session_id, as_of, now: { state, lines }, rows, next, scanned? }
//   rows are newest first; `next` is the cursor of the following page (`before`),
//   null at the end. limit: 1 to 200, 50 by default. only: failures | turns |
//   agents. since: a span back from now (90s, 30m, 1h, 2d), epoch milliseconds
//   or an ISO time: nothing older is read or returned (a page that refreshes
//   itself asks only for what is newer than what it holds). now=0 leaves "now"
//   out; with it, what "now" says (the running turn, an open card) is not a row
//   too. A filtered page reads a bounded number of rows (`scanned`) and gives
//   `next` when it stopped there, with however many rows it found.
//   format=text: the same story as plain text, a line a row, for a model
//   (ids=0 leaves the ids off the lines).
// Content-free like the turn receipt: ids, kinds, counts, classes, durations
// and titles, never a prompt, a tool's input or output or an error's message.
import { ONLY, PAGE, PAGE_MAX, parseSince, Timeline, type Only } from "../../admin/timeline.ts";
import { timelineText } from "../../admin/timeline-rows.ts";
import * as agents from "../../automation/agents.ts";
import { hasPending } from "../../automation/core.ts";
import { allPendingQuestions } from "../../tools/interact.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { RouteModule } from "../app.ts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const timelineRoutes: RouteModule = ({ store, engine }) => {
  const timeline = new Timeline(store, {
    isRunning: (id) => engine.isRunning(id),
    turnOf: (id) => engine.turnOf(id),
    statusOf: (id) => engine.statusOf(id),
    isHeld: (id) => engine.isHeld(id),
    owed: hasPending,
    questions: allPendingQuestions,
  });
  // The text form as a tool, for a session with no shell to ask the route:
  // its own timeline, or that of an agent it started, and no other session's.
  const SessionTimeline: Tool = {
    name: "keel__session_timeline",
    readOnly: true,
    description:
      "The timeline of this session or of an agent you started, a line a row, newest first: what it does now, its turns, agents, waits, approvals and failures. Ids, counts and durations only, no prompt or tool output: where an agent stands or what failed, without its transcript.",
    input_schema: {
      type: "object",
      properties: {
        session: { type: "string", description: "An agent you started (its id or session id). Omit for this session." },
        since: { type: "string", description: "Nothing older: a span back from now (90s, 30m, 1h, 2d) or an ISO time." },
        only: { type: "string", enum: ONLY },
        limit: { type: "integer", description: `Rows, 1 to ${PAGE_MAX} (default ${PAGE}).` },
        before: { type: "string", description: "The cursor an answer ended with, for older rows." },
      },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const want = String(input?.session ?? "").trim();
      let id = ctx.sessionId;
      if (want && want !== ctx.sessionId) {
        const a = agents.get(want) ?? agents.byChild(want);
        if (a?.parent_id !== ctx.sessionId) return fail("NOT_YOURS: this tool reads this session and the agents it started. Name one of your agents (its id or its session id), or leave session out.");
        id = a.session_id;
      }
      const s = store.session(id);
      if (!s) return fail("NOT_AVAILABLE: that session is not on this machine any more.");
      const { limit, only } = input ?? {};
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) return fail(`limit is a whole number of rows from 1 up (${PAGE} by default, at most ${PAGE_MAX})`);
      if (only !== undefined && !ONLY.includes(only)) return fail(`only is one of ${ONLY.join(", ")}`);
      try {
        const page = timeline.page(id, { before: input?.before ? String(input.before) : null, limit, only: only ?? null, since: input?.since ? parseSince(String(input.since)) : null });
        return ok(timelineText(page, { title: s.title }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  };
  registerShared(SessionTimeline);

  return {
    "/api/sessions/:id/timeline": {
      GET: (req: Request & { params: { id: string } }) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit");
        if (limit !== null && !/^[1-9]\d*$/.test(limit)) return bad(`limit is a whole number of rows from 1 up (${PAGE} by default, at most ${PAGE_MAX})`);
        const only = q.get("only");
        if (only && !ONLY.includes(only as Only)) return bad(`only is one of ${ONLY.join(", ")}`);
        const since = q.get("since");
        const page = timeline.page(s.id, {
          before: q.get("before"), limit: limit === null ? undefined : Number(limit), only: (only as Only) || null,
          since: since ? parseSince(since) : null, now: q.get("now") !== "0",
        });
        const headers = { "cache-control": "no-store" };
        if (q.get("format") === "text") return new Response(timelineText(page, { title: s.title, ids: q.get("ids") !== "0" }) + "\n", { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
        return Response.json(page, { headers });
      },
    },
  };
};
