// The cost drivers' rollup (src/admin/cost-drivers.ts) at the daemon's start:
// held against the ledger on the read thread, and made again only when it is
// not there yet (the first start of a build with it) or differs. Making it
// reads the whole ledger (seconds on a large one), so it is made by the
// checkpoint thread under its write lock, as the index of the events' rows is
// (index-build.ts): the loop goes on, and turns wait off it for the lock.
// Where no thread takes it the statements run on the loop, timed, so the
// stall they make names them.
import type { Database } from "bun:sqlite";
import { timed } from "../admin/stall.ts";
import { driversReady, rebuildDriversSql, type DriversCheck } from "../admin/cost-drivers.ts";
import type { Checkpointer } from "../core/checkpoint.ts";

export const DRIVERS_WHAT = "making the cost drivers' rollup from the request ledger";
// How long a thread that is not ready yet (starting, or building something else) is waited for.
const THREAD_WAIT_MS = 120_000;
const THREAD_TRY_MS = 500;

export type DriversStart = { where: "none" | "thread" | "loop"; had: boolean; before: DriversCheck; after?: DriversCheck };

export async function driversAtStart(
  db: Database,
  check: () => Promise<DriversCheck>,
  thread: () => Pick<Checkpointer, "build"> | undefined,
  opts: { waitMs?: number; tryMs?: number } = {},
): Promise<DriversStart> {
  const had = driversReady(db);
  const before = await check();
  if (before.ok) return { where: "none", had, before };
  const sql = rebuildDriversSql(db);
  let where: DriversStart["where"] = "loop";
  for (const t0 = Date.now(); ;) {
    const c = thread();
    const asked = c?.build(sql, DRIVERS_WHAT);
    if (asked) { if (await asked) where = "thread"; break; }
    // (No thread at all, or one that did not take it within the bound: on the loop.)
    if (!c || Date.now() - t0 >= (opts.waitMs ?? THREAD_WAIT_MS)) break;
    await Bun.sleep(opts.tryMs ?? THREAD_TRY_MS);
  }
  if (where === "loop") timed(() => DRIVERS_WHAT, () => db.transaction(() => db.exec(sql))());
  return { where, had, before, after: await check() };
}
