// Your asks, read on the read thread (src/server/read-tasks.ts): the owner's own inputs of a session's line
// (the branch its head is on), its turn ends, the words he typed on its question cards, and the agents of its
// tree with the words of their tasks (the parent's own words only, from `task_at`: the harness's preamble is not the task); tied together by src/board/asks.ts. Imports nothing of the daemon.
import type { Database } from "bun:sqlite";
import { ownerPrompt, PEER_PREFIX } from "../core/owner.ts";
import { linkAsks, type Ask, type AskAgent, type AskHow, type AskInput } from "./asks.ts";

const TEXT_MAX = 6_000;   // characters of an input or a task read
const TREE = "WITH RECURSIVE t(s, d) AS (SELECT ?1, 0 UNION SELECT a.session_id, t.d + 1 FROM agents a JOIN t ON a.parent_id = t.s WHERE t.d < 12)";
const AGENTS_MAX = 400;

type Row = { id: string; seq: number; kind: string; ts: number; parent: string | null; origin: string | null; ukind: string | null; text: string | null; shown: string | null };

const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const howOf = (origin: string | null): AskHow => (origin === "steer" || origin === "queued" || origin === "voice" || origin === "cli" ? origin : "prompt");

// The words the owner typed on the cards a result answers ("other"); the labels he picked are the model's words.
function typedOn(shown: string | null): string {
  if (!shown) return "";
  try {
    const out: string[] = [];
    for (const v of Object.values(JSON.parse(shown) as Record<string, { answers?: Record<string, { other?: unknown }>; relayed?: unknown }>)) {
      if (!v?.answers || typeof v.answers !== "object") continue;
      for (const a of Object.values(v.answers)) if (typeof a?.other === "string" && a.other.trim()) out.push(a.other.trim());
    }
    return out.join("\n");
  } catch { return ""; }
}

// As the gate reads his words: true for a text that is not his (src/safety/gate.ts): the harness's own notes and a peer session's message are not his.
export const notHis = (t: string) => t.startsWith("[harness]") || t.startsWith(PEER_PREFIX);

export function asksFacts(db: Database, a: { root: string; head: string | null }): Ask[] {
  const parentCol = db.query<{ name: string }, []>("PRAGMA table_info(events)").all().some((c) => c.name === "parent");
  const rows = db.query<Row, [string]>(
    `SELECT id, seq, kind, ts, ${parentCol ? "parent" : "NULL AS parent"},
       CASE WHEN kind = 'user' THEN data ->> '$.origin' END AS origin,
       CASE WHEN kind = 'user' THEN data ->> '$.kind' END AS ukind,
       CASE WHEN kind = 'user' AND (data ->> '$.kind') IS NULL THEN substr(data ->> '$.text', 1, ${TEXT_MAX}) END AS text,
       CASE WHEN kind = 'tool_result' AND instr(data, '"other"') > 0 THEN data -> '$.shown' END AS shown
     FROM events WHERE session_id = ?1 AND kind IN ('user', 'turn_end', 'tool_result') ORDER BY seq`).all(a.root);
  // The line the head is on: its parents up to the first event that names none, and the events before that one
  // that name none either (a session from before events named their parent). No head: every event.
  let on: (r: Row) => boolean = () => true;
  if (a.head && parentCol) {
    const parents = new Map(db.query<{ id: string; parent: string | null; seq: number }, [string]>("SELECT id, parent, seq FROM events WHERE session_id = ?").all(a.root).map((r) => [r.id, r]));
    const line = new Set<string>();
    let at = parents.get(a.head), floor = -1;
    for (let n = 0; at && n < 1_000_000; n++) {
      line.add(at.id);
      if (!at.parent) { floor = at.seq; break; }
      at = parents.get(at.parent);
    }
    if (line.size) on = (r) => line.has(r.id) || (r.parent === null && r.seq < floor);
  }
  const inputs: AskInput[] = [], ends: number[] = [];
  for (const r of rows) {
    if (!on(r)) continue;
    if (r.kind === "turn_end") ends.push(r.ts);
    else if (r.kind === "user" && ownerPrompt({ kind: r.ukind ?? undefined, origin: r.origin ?? undefined }) && r.text?.trim() && !notHis(r.text.trimStart())) inputs.push({ id: r.id, seq: r.seq, ts: r.ts, how: howOf(r.origin), text: r.text.trim() });
    else if (r.kind === "tool_result") { const t = typedOn(r.shown); if (t) inputs.push({ id: r.id, seq: r.seq, ts: r.ts, how: "answer", text: t }); }
  }
  const kept = has(db, "agents") && db.query<{ name: string }, []>("PRAGMA table_info(agents)").all().some((c) => c.name === "task");
  const agents: AskAgent[] = has(db, "agents") ? db.query<Omit<AskAgent, "task"> & { first: string | null; kept: string | null }, [string, number]>(
    `${TREE} SELECT a.id, a.parent_id, a.session_id, a.created,
       (SELECT substr(e.data ->> '$.text', 1 + COALESCE(e.data ->> '$.task_at', 0), ${TEXT_MAX}) FROM events e WHERE e.session_id = a.session_id AND e.kind = 'user' AND (e.data ->> '$.kind') = 'task' ORDER BY e.seq LIMIT 1)${kept ? ` AS first, substr(a.task ->> '$.text', 1 + COALESCE(a.task ->> '$.task_at', 0), ${TEXT_MAX}) AS kept` : " AS first, NULL AS kept"}
     FROM agents a JOIN t ON a.parent_id = t.s ORDER BY a.created DESC LIMIT ?2`).all(a.root, AGENTS_MAX).map(({ first, kept: k, ...x }) => ({ ...x, task: first ?? k ?? "" })) : [];
  return linkAsks({ root: a.root, inputs, ends, agents });
}
