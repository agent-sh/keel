// The processor time of the runs Keel makes beside agents and in the landing queue is kept with each run
// and summed over the last hour in the checks report; a run of an agent or the owner has none.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cpuMsOf } from "../core/proc.ts";
import { Store } from "../core/store.ts";
import { bindLedger, list, record, unbindLedger } from "./ledger.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `check-cpu-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => { unbindLedger(); rmSync(root, { recursive: true, force: true }); });

test("the report sums the hour's processor time by who made the run", async () => {
  const store = new Store(join(root, "state"));
  bindLedger(store);
  const now = 10 * 3_600_000;
  const run = (by: "agent" | "beside" | "queue", ended: number, cpu_ms?: number | null) =>
    record({ name: "unit", command: "bun test", dir: ".", repo: "/r", tree: `t${ended}${by}`, head: null, session_id: "s", call_id: null, by, result: "pass", exit: 0, pass: null, fail: null, started: ended - 10, ended, log: null, from_run: null, ...(cpu_ms === undefined ? {} : { cpu_ms }) });
  run("beside", now - 1000, 30_000);
  run("beside", now - 2000, 12_000);
  run("queue", now - 3000, 8_000);
  run("beside", now - 2 * 3_600_000, 99_000); // over an hour ago
  run("agent", now - 1000); // not measured
  const read = async <T>(sql: string, params: (string | number | null)[]) => store.db.query(sql).all(...params) as T[];
  const r = await list({ now }, read);
  expect(r.cpu_hour).toEqual({ cpu_ms: 50_000, beside_ms: 42_000, queue_ms: 8_000, runs: 3 });
  expect(r.runs.find((x) => x.by === "queue")?.cpu_ms).toBe(8_000);
});

test("a child's processor time is read from its own usage", async () => {
  const p = Bun.spawn(["sh", "-c", "i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done"], { stdout: "ignore" });
  await p.exited;
  const ms = cpuMsOf(p);
  expect(ms).not.toBeNull();
  expect(ms!).toBeGreaterThan(0);
  expect(cpuMsOf({})).toBeNull();
});
