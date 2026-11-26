// The Conversation lens of a session (src/core/lens.ts): its owner's messages, the replies
// to them, and one folded run for each stretch between, told by what came of it.
//
// GET /api/sessions/:id/has-agents -> { agents }: it ever started one.
// GET /api/sessions/:id/lens?after=<seq>&at=<id>&turns=<n>
//   -> { items, events, stable, stable_id, last, earlier?, whole? }
//   items: the lens, oldest first (an item past the last turn's end is `open`); a folded
//   run's `words` are the first line of the reply it said last.
//   events: the bodies of the items shown, by id: nothing of a folded run.
//   stable, stable_id: the last turn's end read; a next read asks `after` its
//   seq (`at` its id) for what came since, and its first run goes on the run
//   before. An `at` that is not on the branch any more (a rewind, an edit) is
//   read from the start again: `whole`.
//   last: the branch's last event (where "read" moves to).
//   earlier: the part read starts after the branch's first event (the full
//   stream has the rest).
//   turns: a first read reaches back this many turns (at most LENS_TURNS, the
//   default): a page opening a session reads its newest screen with a few, then the rest.
// The branch is walked from the index of its events (no body); only the inputs
// and turn ends are asked for named fields, and the shown events for their
// bodies, on the read thread.
import { lensItems, type Mark } from "../../core/lens.ts";
import type { StoredEvent } from "../../core/types.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

// The turns one read reaches back over from the end of a branch: a few days of a busy coordinator.
export const LENS_TURNS = 3000;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

export const lensRoutes: RouteModule = ({ store }) => ({
  // Whether the session ever started an agent: a session that did opens on the lens (ui/src/lib/lens-view.ts).
  // One seek of the agents' index by parent; the page's own list of agents holds only the recent ones.
  "/api/sessions/:id/has-agents": {
    GET: (req: Request & { params: { id: string } }) => {
      if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
      let agents = false;
      try { agents = !!store.db.query("SELECT 1 FROM agents WHERE parent_id = ? LIMIT 1").get(req.params.id); } catch {} // a store with no agents table
      return json({ agents });
    },
  },
  "/api/sessions/:id/lens": {
    GET: async (req: Request & { params: { id: string } }) => {
      const s = store.session(req.params.id);
      if (!s) return json({ error: "no such session" }, 404);
      const q = new URL(req.url).searchParams;
      let after = Number(q.get("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) return json({ error: "after is a seq" }, 400);
      const reach = q.has("turns") ? Number(q.get("turns")) : LENS_TURNS;
      if (!Number.isInteger(reach) || reach < 1) return json({ error: "turns is a count" }, 400);
      // The rows alone: a session that is not in memory is read off the loop, without its bodies.
      await store.warm(s.id, false);
      const line = store.lineage(s.id);
      let a = 0, b = line.length;
      while (a < b) { const m = (a + b) >> 1; if (line[m]!.seq <= after) a = m + 1; else b = m; }
      const whole = after > 0 && line[a - 1]?.id !== q.get("at");
      if (whole) { after = 0; a = 0; }
      // A first read reaches back LENS_TURNS turns (or the fewer asked for), from a turn's end.
      let earlier = false;
      if (!after) {
        let turns = 0, i = line.length - 1;
        for (; i >= 0; i--) if (line[i]!.kind === "turn_start" && ++turns > Math.min(reach, LENS_TURNS)) break;
        if (i > 0) {
          while (i < line.length && line[i]!.kind !== "turn_end") i++;
          a = Math.min(line.length, i + 1);
          earlier = true;
        }
      }
      const marks: Mark[] = [];
      const users: string[] = [], ends: string[] = [];
      for (let i = a; i < line.length; i++) {
        const e = line[i]!;
        marks.push({ id: e.id, seq: e.seq, ts: e.ts, kind: e.kind });
        if (e.kind === "user") users.push(e.id);
        else if (e.kind === "turn_end") ends.push(e.id);
      }
      const last = line.at(-1);
      const tail = { last: last ? { id: last.id, seq: last.seq } : null, ...(earlier ? { earlier } : {}), ...(whole ? { whole } : {}) };
      if (!marks.length) return json({ items: [], events: {}, stable: after, stable_id: line[a - 1]?.id ?? null, ...tail });
      const reads = readsOf(store);
      const facts = await reads.run("lens.facts", { users, ends, sessions: [s.id, ...store.descendants(s.id)], from: marks[0]!.ts, to: Date.now() });
      const { items, stable } = lensItems(marks, (id) => facts.users[id], (id) => facts.ends[id], facts.asks);
      const shown = items.flatMap((it) => (it.t === "run" ? [] : [it.id]));
      const bodies = shown.length ? await reads.run("lens.bodies", { ids: shown }) : {};
      // Each folded run's last words: the first line of the reply it said last.
      const said = items.flatMap((it) => (it.t === "run" && it.said ? [it.said] : []));
      const words = said.length ? await reads.run("lens.words", { ids: said }) : {};
      for (const it of items) if (it.t === "run" && it.said && words[it.said]) it.words = words[it.said];
      const at = new Map(marks.map((m, i) => [m.id, line[a + i]!]));
      const events: Record<string, StoredEvent> = {};
      for (const id of shown) {
        const e = at.get(id), body = bodies[id];
        if (!e || body === undefined) continue;
        events[id] = { id, session_id: s.id, seq: e.seq, parent: e.parent, kind: e.kind, ts: e.ts, data: JSON.parse(body) };
      }
      const settled = stable ?? after;
      return json({ items, events, stable: settled, stable_id: stable !== undefined ? marks.find((m) => m.seq === stable)!.id : line[a - 1]?.id ?? null, ...tail });
    },
  },
});
