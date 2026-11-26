// A top session's last result, from facts alone: the newest of a branch that landed or left the
// landing queue (src/landing/queue.ts), an agent branch that reached the base in git, and the session's
// own named check that passed or failed (src/checks/ledger.ts). Never a model's words: what a row and
// the head say of where a session stands after its turn ended (src/core/stand.ts).
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

type Check = { name: string; result: string; ended: number };
type Land = { branch: string; state: string; landed: string | null; updated: number };
const kept = new WeakMap<Store, Map<string, { stamp: number; land: Land | null }>>();
const gitResults = new WeakMap<Store, Map<string, StandResult>>();

// A git read finishes off the loop, then the state's next telling (and every snapshot) sees its answer.
export function keepGitLanding(store: Store, id: string, result?: StandResult): boolean {
  const m = gitResults.get(store) ?? gitResults.set(store, new Map()).get(store)!;
  const was = m.get(id);
  if (result) m.set(id, result); else m.delete(id);
  return result?.at !== was?.at || result?.head !== was?.head || result?.what !== was?.what;
}

export function resultOf(store: Store, s: Session): StandResult | undefined {
  if (s.parent_id || s.outside) return undefined;
  const check = lastCheck(store, s.id);
  const stamp = table(store, "landing_queue") ? store.db.query<{ n: number | null }, []>("SELECT max(updated) AS n FROM landing_queue").get()?.n ?? 0 : 0;
  const m = kept.get(store) ?? kept.set(store, new Map()).get(store)!;
  let k = m.get(s.id);
  if (!k || k.stamp !== stamp) {
    k = { stamp, land: lastLand(store, s.id) };
    m.set(s.id, k);
    if (m.size > 2000) m.delete(m.keys().next().value!);
  }
  const gitLand = gitResults.get(store)?.get(s.id);
  const own = answer(check, k.land);
  return gitLand && (!own || gitLand.at > own.at) ? gitLand : own;
}

// One seek on the session index. The number of agents does not affect this read or its answer.
function lastCheck(store: Store, id: string): Check | null {
  if (!table(store, "check_runs")) return null;
  return store.db.query<Check, [string]>(
    `SELECT name, result, ended FROM check_runs WHERE session_id = ? AND by IN ('agent', 'owner')
     AND result IN ('pass', 'fail', 'answered') ORDER BY ended DESC, id DESC LIMIT 1`).get(id) ?? null;
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
