// The session timeline: what happened in a session, what it is doing now, what
// it waits on and what went wrong, from one place.
//
// GET /api/sessions/:id/timeline?before=&limit=&only=&since=&now=&format=
//   -> { session_id, as_of, now: { state, lines }, rows, next, scanned?, partial? }
//   partial: a turn of the page is not placed on a branch yet (its row says
//   so, `turn.branch` "unknown"): a long session is walked a bounded piece a
//   read, and the same read again goes on. format=text reads on by itself for
//   up to two seconds and then says which turns are not placed.
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
//   :id is a session's id, a prefix of it that names one session, or an agent's
//   id or a prefix of that (src/admin/session-ref.ts).
// Content-free like the turn receipt: ids, kinds, counts, classes, durations
// and titles, never a prompt, a tool's input or output or an error's message.
import { buildBundle } from "../../admin/bundle.ts";
import { sessionRef, sessionRefs } from "../../admin/session-ref.ts";
import { ONLY, PAGE, PAGE_MAX, parseSince, Timeline, type Only } from "../../admin/timeline.ts";
import { timelineText } from "../../admin/timeline-rows.ts";
import { hasPending } from "../../automation/core.ts";
import { sessionState } from "../../automation/state.ts";
import { jobsOf, running } from "../../tools/jobs.ts";
import { plansWaiting } from "./plan.ts";
import { secretsWaiting } from "./secrets.ts";
import { allPendingQuestions } from "../../tools/interact.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { RouteModule } from "../app.ts";
import { tracer } from "./observe.ts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const timelineRoutes: RouteModule = ({ store, engine }) => {
  const timeline = new Timeline(store, {
    isRunning: (id) => engine.isRunning(id),
    turnOf: (id) => engine.turnOf(id),
    statusOf: (id) => engine.statusOf(id),
    outputOf: (id) => engine.outputOf(id),
    plans: plansWaiting,
    secrets: secretsWaiting,
    jobs: (id) => jobsOf(id).filter((j) => j.background && running(j)).map((j) => ({ id: j.id, started: j.started })),
    watchOf: (id) => { const s = store.session(id); return s ? sessionState(s, { from: { store, engine } }).watch : undefined; },
    // What a waiting agent waits on: the wait due first (a timer at its wake time), else its oldest.
    parkedOn: (id) => {
      const rows = store.db.query<{ kind: string; spec: string }, [string]>("SELECT kind, spec FROM waits WHERE status = 'active' AND session_id = ? ORDER BY created").all(id);
      const timers = rows.filter((w) => w.kind === "timer").map((w) => { try { return Number(JSON.parse(w.spec).at_ms) || 0; } catch { return 0; } }).filter(Boolean).sort((a, b) => a - b);
      return timers.length ? { kind: "timer", until: timers[0] } : rows[0] ? { kind: rows[0].kind } : undefined;
    },
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
      "The timeline of this session or of an agent you started, a line a row, newest first: what it does now, its turns, agents, waits, approvals and failures. Ids, counts and durations only, no prompt or tool output: where an agent stands or what failed, without its transcript. open gives one failure in full instead.",
    input_schema: {
      type: "object",
      properties: {
        session: { type: "string", description: "An agent you started (its id or session id). Omit for this session." },
        open: { type: "string", description: "An id a row ends with (error=ID or turn=ID): that failure, its trace and the events before it, instead of the rows." },
        since: { type: "string", description: "Nothing older: a span back from now (90s, 30m, 1h, 2d) or an ISO time." },
        only: { type: "string", enum: ONLY },
        limit: { type: "integer", description: `Rows, 1 to ${PAGE_MAX} (default ${PAGE}).` },
        before: { type: "string", description: "The cursor an answer ended with, for older rows." },
      },
      additionalProperties: false,
    },
    async run(input, ctx) {
      const NOT_YOURS = "NOT_YOURS: this tool reads this session and the agents it started. Name one of your agents (its id, a prefix of it or its session id), or leave session out.";
      const want = String(input?.session ?? "").trim();
      let id = ctx.sessionId;
      if (want && want !== ctx.sessionId) {
        const found = sessionRefs(store, want, ctx.sessionId);
        if (found.length > 1) return fail(`${want} names ${found.length} of your agents; give more of the id.`);
        if (!found[0]) return fail(NOT_YOURS);
        id = found[0];
      }
      const s = store.session(id);
      if (!s) return fail(want ? "NOT_AVAILABLE: that agent's session was deleted, so it has no timeline to read." : "NOT_AVAILABLE: this session was deleted.");
      if (input?.open !== undefined) {
        // One failure in full: the bundle keel debug prints, for a failure of this session or of an agent it started.
        const ref = String(input.open).trim().replace(/^\[|\]$/g, "");
        const [kind, value] = ref.includes("=") ? [ref.slice(0, ref.indexOf("=")), ref.slice(ref.indexOf("=") + 1)] : ["", ref];
        const error = kind === "turn" ? undefined : store.error(value);
        const turn = error || kind === "error" ? undefined : store.event(value);
        const owner = error?.session_id ?? (turn?.kind === "turn_start" ? turn.session_id : undefined);
        if (!owner) return fail("open takes an id a timeline row ends with: error=ID or turn=ID.");
        const mine = owner === ctx.sessionId || sessionRefs(store, owner, ctx.sessionId)[0] === owner;
        // An Errors row keeps one session a kind of failure, the last it happened in: an id a row of
        // this timeline gave may point elsewhere by now (and an id that never was this session's reads
        // the same: nothing says which). The turn's id does not move.
        if (!mine && error) return fail("NOT_YOURS: this error id is not this session's, or no longer (a kind of failure keeps the last session it happened in). Open the turn instead (turn=ID, on the failed turn's row).");
        if (!mine || (want && owner !== id)) return fail(want && mine ? "That id is not in the session you named." : NOT_YOURS);
        if (!tracer) return fail("NOT_AVAILABLE: traces are not kept on this daemon.");
        // Only what is the caller's: its own session and agents, none of the daemon's other errors, log lines or paths.
        return ok(buildBundle(store, tracer, { error, ...(turn ? { session_id: owner, turn_event: turn.id } : {}), daemon: { state_dir: store.stateDir }, own: true, live: (sid) => ({ running: engine.isRunning(sid), status: engine.statusOf(sid) }) }).markdown);
      }
      const { limit, only } = input ?? {};
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1)) return fail(`limit is a whole number of rows from 1 up (${PAGE} by default, at most ${PAGE_MAX})`);
      if (only !== undefined && !ONLY.includes(only)) return fail(`only is one of ${ONLY.join(", ")}`);
      try {
        // Read until its turns are placed on a branch (a long session's first read is not): a model reads this once.
        const page = await timeline.settled(id, { before: input?.before ? String(input.before) : null, limit, only: only ?? null, since: input?.since ? parseSince(String(input.since)) : null });
        return ok(timelineText(page, { title: s.title }));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  };
  registerShared(SessionTimeline);

  return {
    "/api/sessions/:id/timeline": {
      GET: async (req: Request & { params: { id: string } }) => {
        const s = sessionRef(store, req.params.id);
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit");
        if (limit !== null && !/^[1-9]\d*$/.test(limit)) return bad(`limit is a whole number of rows from 1 up (${PAGE} by default, at most ${PAGE_MAX})`);
        const only = q.get("only");
        if (only && !ONLY.includes(only as Only)) return bad(`only is one of ${ONLY.join(", ")}`);
        const since = q.get("since");
        const opts = {
          before: q.get("before"), limit: limit === null ? undefined : Number(limit), only: (only as Only) || null,
          since: since ? parseSince(since) : null, now: q.get("now") !== "0",
        };
        // The text form is read once and whole, so it is read until its turns
        // are placed on a branch; the page's form says `partial` and the page asks again.
        const page = q.get("format") === "text" ? await timeline.settled(s.id, opts) : timeline.page(s.id, opts);
        const headers = { "cache-control": "no-store" };
        if (q.get("format") === "text") return new Response(timelineText(page, { title: s.title, ids: q.get("ids") !== "0" }) + "\n", { headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
        return Response.json(page, { headers });
      },
    },
  };
};
