// A session's state as the daemon tells it (the session tools, the helper,
// the phone, the alerts): the shared word of src/core/watch.ts, read from what
// the daemon knows now. A parent whose own turn ended reads as working while
// an agent it started still runs or waits.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { watchLabel, watchOf, watchWord, type Watch } from "../core/watch.ts";
import * as perm from "../server/routes/permissions.ts";
import { pendingQuestions } from "../tools/interact.ts";
import { D } from "./core.ts";

export type SessionState = { watch: Watch; agents: number; label: string; word: string };
// What the state is read from: the daemon's store and engine (the automation's by default).
type From = { store: Store; engine: { isRunning(id: string): boolean } };
const from = (): From => D();

// Live agents per parent session, in one read.
export function agentCounts(d: Pick<From, "store"> = from()): Map<string, number> {
  const rows = d.store.db.query<{ parent_id: string; n: number }, []>("SELECT parent_id, COUNT(*) AS n FROM agents WHERE status IN ('running', 'waiting') GROUP BY parent_id").all();
  return new Map(rows.map((r) => [r.parent_id, r.n]));
}

export const liveAgents = (sessionId: string, d: Pick<From, "store"> = from()) =>
  d.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM agents WHERE parent_id = ? AND status IN ('running', 'waiting')").get(sessionId)!.n;

// `counts`: agentCounts() when many sessions are told at once.
export function sessionState(s: Session, o: { counts?: Map<string, number>; from?: From } = {}): SessionState {
  const d = o.from ?? from();
  const running = d.engine.isRunning(s.id);
  const row = running && s.phase !== "working" ? { ...s, phase: "working" as const } : s;
  const agents = o.counts ? o.counts.get(s.id) ?? 0 : liveAgents(s.id, d);
  const approvals = perm.gate?.approvals({ session: s.id, pending: true }).length ?? 0;
  const watch = watchOf(row, undefined, { approvals, asking: pendingQuestions(s.id).length > 0, agents });
  return { watch, agents, label: watchLabel(watch, agents), word: watchWord(watch, agents) };
}
