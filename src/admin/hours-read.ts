// The records a tree's hours are read from (src/admin/hours-rows.ts), read
// on the read thread (src/server/read-tasks.ts): its agents, each session's
// turns and what started each, the spans of their turns, the waits they set,
// their slot holds and the daemon's starts. Each statement seeks by session
// on an index of its own; nothing walks a whole table but the daemon's
// starts (a few rows) and the waits of the tree's sessions.
import type { Database } from "bun:sqlite";
import { TURN } from "./marks.ts";
import { treeHours, type HourInput, type HourMember, type HourSpan, type HourTurn, type TreeHours } from "./hours-rows.ts";

export type HoursAsk = { session: string; now: number; since?: number; until?: number };
// A tree this large is read whole all the same; the bound is on the ids a statement names.
const CHUNK = 400;

type AgentRow = { id: string; parent_id: string; session_id: string; title: string; status: string; created: number; ended: number | null };

export function hoursInput(db: Database, a: HoursAsk): HourInput | null {
  const s = db.query<{ id: string; title: string; created: number }, [string]>("SELECT id, title, created FROM sessions WHERE id = ?").get(a.session);
  if (!s) return null;
  // The tree: the session, and every agent below it.
  const agents = db.query<AgentRow, [string]>(`WITH RECURSIVE t(sid, d) AS (SELECT ?1, 0 UNION SELECT a.session_id, t.d + 1 FROM agents a JOIN t ON a.parent_id = t.sid WHERE t.d < 32)
    SELECT a.id, a.parent_id, a.session_id, a.title, a.status, a.created, a.ended FROM agents a JOIN t ON a.session_id = t.sid`).all(a.session);
  const own = agents.find((r) => r.session_id === a.session);
  const ids = [a.session, ...agents.filter((r) => r.session_id !== a.session).map((r) => r.session_id)];
  const chunks = <T>(f: (part: string[]) => T[]) => { const out: T[] = []; for (let i = 0; i < ids.length; i += CHUNK) out.push(...f(ids.slice(i, i + CHUNK))); return out; };

  // Turns, paired start to end, with what started each (the prompt before it, past a note).
  const turns: HourTurn[] = [];
  const marks = db.query<{ kind: string; ts: number; pk: string | null; o: string | null; reason: string | null }, [string]>(
    `SELECT e.kind, e.ts, COALESCE(CASE WHEN u.kind IN ('note', 'compaction') THEN u2.kind END, u.kind) AS pk,
       CASE WHEN COALESCE(CASE WHEN u.kind IN ('note', 'compaction') THEN u2.kind END, u.kind) = 'user' THEN (SELECT json_object('origin', x.data ->> '$.origin', 'kind', x.data ->> '$.kind', 'job', x.data ->> '$.job', 'continued', x.data ->> '$.continued')
         FROM events x WHERE x.id = CASE WHEN u.kind = 'user' THEN u.id ELSE u2.id END) END AS o,
       CASE WHEN COALESCE(CASE WHEN u.kind IN ('note', 'compaction') THEN u2.kind END, u.kind) = 'turn_end' THEN (SELECT x.data ->> '$.reason' FROM events x WHERE x.id = CASE WHEN u.kind = 'turn_end' THEN u.id ELSE u2.id END) END AS reason
     FROM events e LEFT JOIN events u ON e.kind = 'turn_start' AND u.id = e.parent LEFT JOIN events u2 ON u.kind IN ('note', 'compaction') AND u2.id = u.parent
     WHERE e.session_id = ? AND ${TURN.replace("kind", "e.kind")} AND e.kind IN ('turn_start', 'turn_end') ORDER BY e.ts, e.seq`);
  const lastEnd = new Map<string, number>();
  for (const id of ids) {
    let open: HourTurn | null = null;
    for (const r of marks.all(id)) {
      if (r.kind === "turn_start") {
        if (open) open.end = r.ts; // a start with no end of its own ended where the next began
        const opener = r.pk === "user" && r.o ? JSON.parse(r.o) : r.pk === "turn_end" && r.reason === "restart" ? { origin: "restart" } : undefined;
        open = { session_id: id, start: r.ts, end: null, ...(opener ? { opener } : {}) };
        turns.push(open);
      } else if (open) {
        open.end = r.ts;
        lastEnd.set(id, r.ts);
        open = null;
      }
    }
  }

  const members: HourMember[] = [];
  const firstTurn = (id: string) => turns.find((t) => t.session_id === id)?.start;
  for (const id of ids) {
    const r = agents.find((x) => x.session_id === id);
    const liveAgent = r && (r.status === "running" || r.status === "waiting");
    if (r) members.push({ session_id: id, parent_session: id === a.session ? null : r.parent_id, agent_id: r.id, title: r.title, start: r.created, end: liveAgent ? null : r.ended ?? lastEnd.get(id) ?? r.created });
    else {
      const running = turns.some((t) => t.session_id === id && t.end === null);
      const start = firstTurn(id) ?? s.created;
      members.push({ session_id: id, parent_session: null, title: s.title, start, end: running ? null : lastEnd.get(id) ?? start });
    }
  }
  if (own) members[0]!.parent_session = null;

  const spans = chunks((part) => db.query<HourSpan, string[]>(
    `SELECT span_id, parent_id, session_id, kind, name, start_ms, end_ms, attrs ->> '$.tool' AS tool, attrs ->> '$.shape.purpose' AS purpose
     FROM spans WHERE session_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(part)));
  const waits = chunks((part) => db.query<{ session_id: string; from: number; to: number | null }, string[]>(
    `SELECT session_id, created AS "from", ended AS "to" FROM waits WHERE session_id IN (SELECT value FROM json_each(?)) AND kind NOT IN ('monitor', 'websocket')`).all(JSON.stringify(part)));
  // A slot hold is said in the parent's activity, by the agent it holds.
  const byAgent = new Map(agents.map((r) => [r.id, r.session_id]));
  const holds = db.query<{ ts: number; agent: string | null }, [string]>("SELECT ts, data ->> '$.agent_id' AS agent FROM activity WHERE session_id = ? AND kind = 'agent' AND sub IN ('queued', 'slot_wait')");
  const parents = new Set(agents.map((r) => r.parent_id));
  for (const p of parents) {
    if (!ids.includes(p) && p !== own?.parent_id) continue;
    for (const h of holds.all(p)) {
      const m = h.agent ? members.find((x) => x.session_id === byAgent.get(h.agent!)) : undefined;
      if (m) (m.held ??= []).push(h.ts);
    }
  }
  const restarts: HourInput["restarts"] = [];
  const hasStarts = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daemon_starts'").get();
  if (hasStarts) for (const r of db.query<{ data: string }, []>("SELECT data FROM daemon_starts").all()) {
    try {
      const d = JSON.parse(r.data);
      const back = d.listening_ms ?? d.up_ms;
      if (d.before?.down_ms && back > d.before.down_ms) restarts.push({ from: d.before.down_ms, to: back });
    } catch {}
  }
  return { now: a.now, root: a.session, members, turns, spans, waits, restarts, ...(a.since !== undefined ? { since: a.since } : {}), ...(a.until !== undefined ? { until: a.until } : {}) };
}

export function readHours(db: Database, a: HoursAsk): TreeHours | null {
  const input = hoursInput(db, a);
  return input ? treeHours(input) : null;
}
