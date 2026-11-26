// A top session's last result, from facts alone: the newest of a branch that landed or left the
// landing queue (src/landing/queue.ts) and a named check that passed or failed (src/checks/ledger.ts),
// of the session itself and the agents it started. Never a model's words: what a row and the head say
// of where a session stands after its turn ended (src/core/stand.ts). A state is read at every change,
// so the answer is kept by session and read again only when either table gained a row.
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

// What either table holds now: a new check run or a landing entry that changed moves it. Both are
// one seek on an index (the rowid, landing_queue_updated).
function stamp(store: Store): string {
  const runs = table(store, "check_runs") ? store.db.query<{ n: number | null }, []>("SELECT max(id) AS n FROM check_runs").get()?.n ?? 0 : 0;
  const lands = table(store, "landing_queue") ? store.db.query<{ n: number | null }, []>("SELECT max(updated) AS n FROM landing_queue").get()?.n ?? 0 : 0;
  return `${runs}:${lands}`;
}

const kept = new WeakMap<Store, { stamp: string; by: Map<string, StandResult | null> }>();

export function resultOf(store: Store, s: Session): StandResult | undefined {
  if (s.parent_id || s.outside) return undefined;
  // (Asked at every read, never kept for a while: a session at rest is read once after its last change,
  // and an answer kept from before the check's row would stay on its row.)
  const st = stamp(store);
  let k = kept.get(store);
  if (!k || k.stamp !== st) kept.set(store, (k = { stamp: st, by: new Map() }));
  if (k.by.has(s.id)) return k.by.get(s.id) ?? undefined;
  const r = read(store, s.id);
  k.by.set(s.id, r ?? null);
  if (k.by.size > 2000) k.by.delete(k.by.keys().next().value!);
  return r;
}

function read(store: Store, id: string): StandResult | undefined {
  const agents = table(store, "agents");
  const mine = agents ? "(session_id = ?1 OR session_id IN (SELECT session_id FROM agents WHERE parent_id = ?1))" : "session_id = ?1";
  const check = table(store, "check_runs")
    ? store.db.query<{ name: string; result: string; ended: number }, [string]>(
      `SELECT name, result, ended FROM check_runs WHERE ${mine} AND by IN ('agent', 'owner') AND result IN ('pass', 'fail', 'answered') ORDER BY ended DESC LIMIT 1`).get(id)
    : null;
  const who = agents ? "(queued_by = ?1 OR queued_by IN (SELECT session_id FROM agents WHERE parent_id = ?1))" : "queued_by = ?1";
  const land = table(store, "landing_queue")
    ? store.db.query<{ branch: string; state: string; landed: string | null; updated: number }, [string]>(
      `SELECT branch, state, landed, updated FROM landing_queue WHERE ${who} AND state IN ('landed', 'left') ORDER BY updated DESC LIMIT 1`).get(id)
    : null;
  if (land && (!check || land.updated >= check.ended)) {
    return { kind: land.state === "landed" ? "landed" : "left", what: land.branch, ok: land.state === "landed", at: land.updated, ...(land.landed ? { head: land.landed.slice(0, 9) } : {}) };
  }
  if (check) return { kind: "check", what: check.name, ok: check.result !== "fail", at: check.ended };
  return undefined;
}
