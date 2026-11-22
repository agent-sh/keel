// Every session at once (src/admin/overview.ts).
//
// GET /api/overview?since=&until=&format=&ids=&of=&max=
//   -> { as_of, since, until, sessions, agents?, hidden, totals }
//   since: a span back from now (90s, 30m, 1h, 2d), epoch milliseconds or an
//   ISO time; a day by default, at most seven days back. of: a session whose own agents are listed
//   first (and which is left out of the sessions). max: sessions listed (20 by
//   default, at most 200), the ones that need the owner first. format=text: the same as
//   plain text for a model or a terminal (ids=0 leaves the ids off the lines).
// GET /api/away?since=&format=&ids=
//   -> { away: Digest | null, last_seen, gap_ms }: what happened while the
//   owner was away (src/admin/away.ts), per session; null when the owner was
//   not away or nothing happened. With since (at most 7 days back), the same
//   for that window, whether or not the owner was away. format=text as above.
// DELETE /api/away   the owner has seen the digest: it is not shown again.
// Content-free: titles, states, classes, counts, durations and ids.
import { wentDownAt } from "../../admin/life.ts";
import { awayGap, bindPresence, digest, digestText, Presence, TICK_MS, type AwayWindow } from "../../admin/away.ts";
import { daemonFacts } from "../../admin/daemon-facts.ts";
import { zonedStamp } from "../../core/clock.ts";
import { bindOverview, DEFAULT_SINCE, overview, overviewText, tooFarBack, type From } from "../../admin/overview.ts";
import { dur } from "../../admin/timeline-rows.ts";
import { parseSince, Timeline } from "../../admin/timeline.ts";
import { agentCounts, sessionState } from "../../automation/state.ts";
import { liveOf } from "./timeline.ts";
import { allPendingQuestions } from "../../tools/interact.ts";
import type { RouteModule } from "../app.ts";

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export const overviewRoutes: RouteModule = ({ store, engine }) => {
  // The same "now" the timeline tells; the state word is this report's own read, so it is not read again a row.
  const timeline = new Timeline(store, { ...liveOf({ store, engine }), watchOf: undefined });
  const from: From = {
    store,
    counts: () => agentCounts({ store }),
    state: (s, counts) => sessionState(s, { counts, from: { store, engine } }),
    now: (id) => timeline.now(id),
  };
  bindOverview(from);
  store.migrate("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const presence = new Presence({
    load: () => store.db.query<{ value: string }, []>("SELECT value FROM admin_meta WHERE key = 'owner_presence'").get()?.value ?? null,
    save: (v) => void store.db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES ('owner_presence', ?)").run(v),
  }, undefined, undefined, wentDownAt());
  bindPresence(presence);
  // The daemon notes that it runs: a note that comes late is time it was down or asleep, which is no absence.
  const g = globalThis as { __keelPresenceTick?: ReturnType<typeof setInterval> };
  clearInterval(g.__keelPresenceTick);
  g.__keelPresenceTick = setInterval(() => presence.tick(), TICK_MS);
  g.__keelPresenceTick.unref?.();
  // The questions that wait for the owner, by the session that asked and by its parent (an agent's question is its parent's to see).
  const asked_of = () => {
    const n: Record<string, number> = {};
    for (const q of allPendingQuestions()) for (const id of new Set([q.session_id, q.parent_id])) if (id) n[id] = (n[id] ?? 0) + 1;
    return n;
  };
  const text = (body: string) => new Response(body + "\n", { headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

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
    "/api/away": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const now = Date.now();
        const asked = q.get("since");
        const from_ms = asked ? parseSince(asked, now) : 0;
        const far = asked ? tooFarBack(from_ms, now) : undefined;
        if (far) return bad(far);
        const w: AwayWindow | null = asked ? { spans: [{ from: from_ms, to: now }], present: false } : presence.window(now);
        const asText = q.get("format") === "text";
        const meta = { last_seen: presence.lastSeen, gap_ms: awayGap() };
        const d = w ? digest(overview(from, { since: w.spans[0]!.from, until: w.spans.at(-1)!.to + 1, spans: w.spans.map((s) => [s.from, s.to + 1] as [number, number]), max: 200 }), w, { daemon: daemonFacts(store.db, w.spans), questions: asked_of() }) : null;
        // Absences in which nothing happened leave nothing to tell: they go once the owner is back.
        if (w && !d && !asked && w.present) presence.dismiss();
        if (!d) {
          if (!asText) return Response.json({ away: null, ...meta }, { headers: { "cache-control": "no-store" } });
          const last = presence.lastSeen;
          if (asked) return text(`Nothing happened since ${zonedStamp(from_ms)}.`);
          return text(w ? "Nothing happened while you were away."
            : `No absence to tell of: ${last === null ? "nobody has been at a page of the daemon yet" : `the owner was at a page of the daemon ${dur(Math.max(now - last, 0))} ago`}. Name a time (since=1h; --since 1h on the command line) for what happened since then.`);
        }
        return asText ? text(digestText(d, { ids: q.get("ids") !== "0", since: !!asked })) : Response.json({ away: d, ...meta }, { headers: { "cache-control": "no-store" } });
      },
      DELETE: () => {
        presence.dismiss();
        return Response.json({ ok: true });
      },
    },
  };
};
