// The index of the events' rows (src/core/bare-index.ts), built for a store
// from before it once the daemon listens. The build reads every event's
// body, so on a large store with a cold cache it is as long as the disk
// takes to read the whole table. Here the daemon answers meanwhile:
// - the events are read first on the read thread, a part at a time (no long
//   read holds the log), so their pages are in the system's memory;
// - then the index is made by the checkpoint thread under its write lock
//   (seconds, from memory): turns wait off the loop for it, and a write that
//   waits past the bound is refused and owed, said as this build.
// Where no thread works the statement is made on the loop, timed, so the
// stall it makes names it.
import { timed } from "../admin/stall.ts";
import { BARE_INDEX_SQL, hasBareIndex } from "../core/bare-index.ts";
import type { Checkpointer } from "../core/checkpoint.ts";
import type { Store } from "../core/store.ts";
import type { Reads } from "./reads.ts";

// Events read ahead in one statement of the read thread.
const PART = 20_000;
const WHAT = "building the index of its events' rows";

export async function buildBareIndex(store: Store, reads: Pick<Reads, "sql">, checkpointer: Pick<Checkpointer, "build"> | undefined, say: (line: string) => void = console.log): Promise<{ where: "thread" | "loop"; read_ms: number; build_ms: number } | undefined> {
  const n = store.indexOwed;
  if (!n) return undefined;
  if (hasBareIndex(store.db)) { store.indexOwed = 0; return undefined; }
  say(`[store] building the index of the events' rows, once (about ${n} events): the daemon answers meanwhile`);
  const t0 = performance.now();
  for (let at = 0; at < n; at += PART) {
    // (A part that fails to be read ahead is read by the build itself.)
    await reads.sql("SELECT COUNT(*) AS n, MAX(ts) AS ts FROM events WHERE rowid > ? AND rowid <= ?", [at, at + PART]).catch(() => {});
    await new Promise((r) => setImmediate(r));
  }
  const t1 = performance.now();
  let where: "thread" | "loop" = "thread";
  if (!(await checkpointer?.build(BARE_INDEX_SQL, WHAT))) {
    where = "loop";
    timed(() => WHAT, () => store.db.exec(BARE_INDEX_SQL));
  }
  const t2 = performance.now();
  store.indexOwed = 0;
  say(`[store] the index is built (${((t1 - t0) / 1000).toFixed(1)} s reading the events, ${((t2 - t1) / 1000).toFixed(1)} s building${where === "loop" ? ", on the loop: no checkpoint thread works" : ""})`);
  return { where, read_ms: Math.round(t1 - t0), build_ms: Math.round(t2 - t1) };
}
