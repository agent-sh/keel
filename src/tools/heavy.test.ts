import { afterEach, expect, setSystemTime, test } from "bun:test";
import { heavyChanged, machine, pool, type HeavyChange, type Slot } from "./heavy.ts";
import type { Job } from "./jobs.ts";

const read = machine.read;
const cpu = machine.cpu;
afterEach(() => { pool.reset(); machine.read = read; machine.cpu = cpu; heavyChanged.tell = undefined; heavyChanged.title = undefined; setSystemTime(); });

// A small machine, idle: 4 cores, room for one browser or two suites.
const small = () => { machine.read = () => ({ cores: 4, load1: 0.1, runnable: 0.1, sched_ns: undefined, mem_available_mb: 40_000 }); };
const job = () => ({ ended: undefined } as unknown as Job);

test("a watcher takes no slot, so the same session's next suite and another session's run on a small machine", async () => {
  small();
  expect(await pool.take({ session: "s1", who: "session", command: "bunx tsc --watch -p .", call: "w" })).toBeUndefined();
  const own = await pool.take({ session: "s1", who: "session", command: "bun test ./src", call: "a" });
  const other = await pool.take({ session: "s2", who: "session", command: "bun test ./src", call: "b" });
  expect(own && own !== "aborted").toBe(true);
  expect(other && other !== "aborted").toBe(true);
});

test("a quiet holder gives its slot back to the line, and the line names who holds the slots", async () => {
  small();
  const told: HeavyChange[] = [];
  heavyChanged.tell = (c) => told.push(c);
  heavyChanged.title = (id) => (id === "b" ? "Browser left open" : undefined);
  setSystemTime(new Date(1_000_000));
  // A browser holds the 4-core machine's room (3 cores of 3.3).
  const browser = (await pool.take({ session: "b", who: "agent", command: "chromium --headless about:blank", call: "c" })) as Slot;
  browser.bind(job());
  let used = 0;
  machine.cpu = async () => used;
  let got: Slot | "aborted" | undefined;
  void pool.take({ session: "s", who: "session", command: "bunx playwright test", call: "d" }).then((s) => { got = s; });
  await Bun.sleep(0);
  expect(got).toBeUndefined();
  expect(pool.lineOf("s")).toBe('Waiting for a heavy-command slot: next in line, held by chromium (agent "Browser left open"); every slot is taken');
  // After its ramp it works for a while (2 cores), then sits.
  for (let t = 4_000; t <= 34_000; t += 3_000) {
    setSystemTime(new Date(1_000_000 + t));
    used += t <= 13_000 ? 6_000 : 30;
    await pool.sampleQuiet();
    if (t <= 25_000) expect(got).toBeUndefined();
  }
  expect(got && got !== "aborted").toBe(true);
  expect(pool.view().quiet_freed).toBeGreaterThan(0);
  // Its end later gives nothing back twice.
  browser.release();
  expect([...pool.held.values()].map((h) => h.session)).toEqual(["s"]);
  expect(told.some((c) => c.state === "started" && c.session_id === "s")).toBe(true);
});
