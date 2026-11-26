// A top session's last result, from facts alone: the newest of a branch that landed or left the
// landing queue (src/landing/queue.ts) and a named check that passed or failed (src/checks/ledger.ts),
// of the session itself and the agents it started. Never a model's words: what a row and the head say
// of where a session stands after its turn ended (src/core/stand.ts). A state is read at every change,
// so the answer is kept by session: a new check run is read by itself, a landing that changed asks again.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { StandResult } from "../core/watch.ts";

const has = new WeakMap<Store, Map<string, boolean>>();
function table(store: Store, name: string): boolean {
  const m = has.get(store) ?? has.set(store, new Map()).get(store)!;
  let v = m.get(name);
  if (v === undefined) m.set(name, (v = !!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)));
  return v;
}

// What either table holds now: the newest check run (runs are written once, at their end, so a new
// one is a higher id) and the newest landing entry that changed. Both are one seek on an index (the
// rowid, landing_queue_by).
function stamp(store: Store): { runs: number; lands: number } {
  const runs = table(store, "check_runs") ? store.db.query<{ n: number | null }, []>("SELECT max(id) AS n FROM check_runs").get()?.n ?? 0 : 0;
  const lands = table(store, "landing_queue") ? store.db.query<{ n: number | null }, []>("SELECT max(updated) AS n FROM landing_queue").get()?.n ?? 0 : 0;
  return { runs, lands };
}

type Check = { name: string; result: string; ended: number };
type Land = { branch: string; state: string; landed: string | null; updated: number };
// A session's answer, with the stamp it was read at: a new check run is read on its own (the runs after
// `runs`), never the session's whole tree of runs again.
type Kept = { runs: number; lands: number; check: Check | null; land: Land | null };
const kept = new WeakMap<Store, Map<string, Kept>>();

export function resultOf(store: Store, s: Session): StandResult | undefined {
  if (s.parent_id || s.outside) return undefined;
  // (Asked at every read, never kept for a while: a session at rest is read once after its last change,
  // and an answer kept from before the check's row would stay on its row.)
  const st = stamp(store);
  const m = kept.get(store) ?? kept.set(store, new Map()).get(store)!;
  let k = m.get(s.id);
  if (!k) {
    k = { runs: st.runs, lands: st.lands, check: lastCheck(store, s.id), land: lastLand(store, s.id) };
    m.set(s.id, k);
    if (m.size > 2000) m.delete(m.keys().next().value!);
  } else {
    if (k.runs !== st.runs) {
      // Fewer runs than before: the ledger was pruned or replaced, and the session is read whole again.
      const late = st.runs > k.runs ? newerCheck(store, s.id, k.runs) : lastCheck(store, s.id);
      if (st.runs < k.runs) k.check = late;
      else if (late && (!k.check || late.ended >= k.check.ended)) k.check = late;
      k.runs = st.runs;
    }
    if (k.lands !== st.lands) { k.land = lastLand(store, s.id); k.lands = st.lands; }
  }
  return answer(k.check, k.land);
}

const PASSED = "by IN ('agent', 'owner') AND result IN ('pass', 'fail', 'answered')";

// The newest run of the session and of each agent it started, one seek each on the session index from its
// newest run back: a tree of a thousand agents and twenty thousand runs is read in a few milliseconds, where
// sorting every run of the tree took tens, and longer still from a cold disk.
function lastCheck(store: Store, id: string): Check | null {
  if (!table(store, "check_runs")) return null;
  const sids = table(store, "agents") ? "SELECT ?1 AS sid UNION ALL SELECT session_id FROM agents WHERE parent_id = ?1" : "SELECT ?1 AS sid";
  return store.db.query<Check, [string]>(
    `SELECT c.name, c.result, c.ended FROM (${sids}) s JOIN check_runs c ON c.id = (SELECT id FROM check_runs WHERE session_id = s.sid AND ${PASSED} ORDER BY ended DESC LIMIT 1) ORDER BY c.ended DESC LIMIT 1`).get(id) ?? null;
}

// The newest of the runs after `since` that are the session's or one of its agents': the runs since are read
// by their ids (the rowid), and each is asked whether its session is the tree's.
function newerCheck(store: Store, id: string, since: number): Check | null {
  const mine = table(store, "agents") ? "(+c.session_id = ?1 OR EXISTS (SELECT 1 FROM agents a WHERE a.session_id = c.session_id AND a.parent_id = ?1))" : "+c.session_id = ?1";
  return store.db.query<Check, [string, number]>(
    `SELECT c.name, c.result, c.ended FROM check_runs c WHERE c.id > ?2 AND ${mine} AND c.by IN ('agent', 'owner') AND c.result IN ('pass', 'fail', 'answered') ORDER BY c.ended DESC LIMIT 1`).get(id, since) ?? null;
}

function lastLand(store: Store, id: string): Land | null {
  if (!table(store, "landing_queue")) return null;
  const who = table(store, "agents") ? "(queued_by = ?1 OR queued_by IN (SELECT session_id FROM agents WHERE parent_id = ?1))" : "queued_by = ?1";
  return store.db.query<Land, [string]>(
    `SELECT branch, state, landed, updated FROM landing_queue WHERE ${who} AND state IN ('landed', 'left') ORDER BY updated DESC LIMIT 1`).get(id) ?? null;
}

function answer(check: Check | null, land: Land | null): StandResult | undefined {
  if (land && (!check || land.updated >= check.ended)) {
    return { kind: land.state === "landed" ? "landed" : "left", what: land.branch, ok: land.state === "landed", at: land.updated, ...(land.landed ? { head: land.landed.slice(0, 9) } : {}) };
  }
  if (check) return { kind: "check", what: check.name, ok: check.result !== "fail", at: check.ended };
  return undefined;
}
