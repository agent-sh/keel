import { afterEach, expect, setSystemTime, test } from "bun:test";
import { heavyChanged, machine, pool, program, type HeavyChange, type Slot } from "./heavy.ts";
import type { Job } from "./jobs.ts";

const read = machine.read;
const cpu = machine.cpu;
afterEach(() => { pool.reset(); machine.read = read; machine.cpu = cpu; heavyChanged.tell = undefined; setSystemTime(); });

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
  expect(pool.lineOf("s")).toBe('Waiting for a heavy-command slot: next in line, held by chromium (an agent); every slot is taken');
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

test("the line names another session's holder by its kind and a fixed command word, never its title or its target", async () => {
  small();
  const held = await pool.take({ session: "o", who: "session", command: "make deploy-prod", call: "m" });
  expect(held && held !== "aborted").toBe(true);
  void pool.take({ session: "w", who: "session", command: "bun test ./src", call: "t" });
  await Bun.sleep(0);
  expect(pool.lineOf("w")).toBe("Waiting for a heavy-command slot: next in line, held by make (another session); every slot is taken");
  expect(["cargo test --workspace", "bun run deploy-prod", "npm deploy", "go vet ./..."].map(program)).toEqual(["cargo test", "bun run", "npm", "go vet"]);
});

test("with nothing held, an agent's first heavy command waits while free memory is under the floor and starts when it comes back; the owner's does not wait", async () => {
  let mem = 4_000;
  machine.read = () => ({ cores: 8, load1: 0.1, runnable: 0.1, sched_ns: undefined, mem_available_mb: mem, mem_total_mb: 64_000 });
  let got: Slot | "aborted" | undefined;
  void pool.take({ session: "a", who: "agent", command: "bun test ./src", call: "t" }).then((s) => { got = s; });
  await Bun.sleep(0);
  expect(got).toBeUndefined();
  expect(pool.lineOf("a")).toBe("Waiting for a heavy-command slot: next in line, none held; free memory is under the 8192 MB kept free plus its 2048 MB estimate; with no slot held it runs alone after 30 s");
  const own = await pool.take({ session: "o", who: "owner", command: "bun test ./src", call: "o" });
  expect(own && own !== "aborted").toBe(true);
  (own as Slot).release();
  mem = 40_000;
  await Bun.sleep(1_100); // the line's next sample
  expect(got && got !== "aborted").toBe(true);
});

test("with nothing held and memory that does not come back, the head of the line runs alone after the bounded wait", async () => {
  // A 16 GB desktop at 8 GB free: under the floor plus the estimate, though both fit its memory.
  machine.read = () => ({ cores: 8, load1: 0.1, runnable: 0.1, sched_ns: undefined, mem_available_mb: 8_000, mem_total_mb: 15_800 });
  const told: HeavyChange[] = [];
  heavyChanged.tell = (c) => told.push(c);
  const start = Date.now();
  let got: Slot | "aborted" | undefined;
  void pool.take({ session: "a", who: "beside", command: "bun test ./src", call: "t" }).then((s) => { got = s; });
  let second: Slot | "aborted" | undefined;
  void pool.take({ session: "b", who: "beside", command: "bun test ./src", call: "u" }).then((s) => { second = s; });
  await Bun.sleep(0);
  expect(got).toBeUndefined();
  setSystemTime(new Date(start + 31_000));
  await Bun.sleep(1_100); // the line's next sample
  expect(got && got !== "aborted").toBe(true);
  // Alone: the next waits while it holds its slot.
  expect(second).toBeUndefined();
  expect(told.some((c) => c.state === "started" && c.key.startsWith("a:"))).toBe(true);
});
