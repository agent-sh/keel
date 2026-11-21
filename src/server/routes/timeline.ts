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
import { hasPending } from "../../automation/core.ts";
import { allPendingQuestions } from "../../tools/interact.ts";
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
