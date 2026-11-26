import { describe, expect, test } from "bun:test";
import { splitCommand } from "../safety/shell.ts";
import { before, checkConfig, compile, MEM_WAIT_MS, cpuList, heavyPattern, light, loadBetween, nextQuiet, order, placeLine, quiet, room, schedTime, type PoolConfig } from "./heavy-pool.ts";
import { DEFAULTS } from "./heavy.ts";

const pats = compile(DEFAULTS.patterns, DEFAULTS.cost);
const heavy = (c: string) => heavyPattern(splitCommand(c), pats, splitCommand);

describe("which commands are heavy", () => {
  test("a suite, a build or a browser, under wrappers and after other commands", () => {
    expect(heavy("cd x && FOO=1 bun test ./src")?.pattern).toBe("(bun|deno) test");
    expect(heavy("timeout 600 nice -n 10 cargo build --release 2>&1 | tail -5")?.pattern).toContain("cargo");
    expect(heavy("waitfor --capacity 20,8 --timeout 10m && bunx playwright test a.spec.ts")?.pattern).toContain("playwright");
    expect(heavy("bash -c 'go test ./...'")?.pattern).toContain("go");
    expect(heavy("systemd-run --user --scope -p CPUWeight=20 -- npm run build")?.pattern).toContain("npm");
    expect(heavy("echo $(bun test)")).toBeDefined();
    expect(heavy("scripts/smoke.sh test/e2e/chat.spec.ts")?.pattern).toContain("smoke");
    expect(heavy("bash -x scripts/smoke.sh a.spec.ts")?.line).toBe("smoke.sh a.spec.ts");
    expect(heavy("bash scripts/lint.sh")).toBeUndefined();
    expect(heavy("make -j8 all")).toBeDefined();
  });
  test("not what runs elsewhere, mentions a suite, or only looks like one", () => {
    expect(heavy("ssh devbox 'cd y && bun test'")).toBeUndefined();
    expect(heavy("echo bun test")).toBeUndefined();
    expect(heavy("git status && rg -n 'bun test' docs")).toBeUndefined();
    expect(heavy("bun tests.ts")).toBeUndefined();
    expect(heavy("maker --help")).toBeUndefined();
    expect(heavyPattern(splitCommand("bun test"), [], splitCommand)).toBeUndefined();
  });
  test("not a watcher or a server left up for later: it would hold its slot for as long as it lives", () => {
    for (const c of ["tsc --watch", "bunx tsc -w -p .", "bun run build --watch", "bun test --watch", "vitest --watch=true", "jest --watchAll", "playwright test --ui", "npm run dev", "bun run serve", "make serve", "make dev"]) expect([c, heavy(c)]).toEqual([c, undefined]);
    // A watcher beside a real suite: the suite still is.
    expect(heavy("tsc --watch & bun test")?.pattern).toBe("(bun|deno) test");
    // The words of a server only for script runners, makes and servers, and never as an argument of a suite or a build.
    for (const c of ["npm start", "pnpm dev", "yarn run preview", "deno task dev", "vite serve", "next dev", "make watch"]) expect(light(c.split(" "))).toBe(true);
    for (const c of ["bun test dev", "cargo test start", "pytest start", "playwright test dev", "bunx playwright test dev", "docker build --target dev .", "go test ./start", "npm test dev", "bun run build dev", "make build serve"]) expect([c, light(c.split(" ").filter((w) => w !== "bunx"))]).toEqual([c, false]);
    expect(heavy("bun test dev")?.pattern).toBe("(bun|deno) test");
    expect(heavy("docker build --target dev .")).toBeDefined();
  });
  test("not one that says something and ends", () => {
    for (const c of ["tsc --version", "bun test --help", "cargo build -h", "go help test", "make -n", "make -j4 --dry-run all", "make clean", "make distclean", "ninja -t clean", "make -q all"]) expect([c, heavy(c)]).toEqual([c, undefined]);
    expect(heavy("make clean all")).toBeDefined();
  });
  test("each kind is counted at its own measured cost", () => {
    expect(heavy("bun test ./src/tools")?.cost).toEqual({ cores: 1.5, memory_mb: 2048 });
    expect(heavy("bunx playwright test")?.cost).toEqual({ cores: 3, memory_mb: 1024 });
    expect(heavy("go test ./...")?.cost).toEqual({ cores: 3, memory_mb: 1536 });
    // A pattern given as text costs the default.
    const own = compile(["my-suite"], { cores: 2, memory_mb: 512 });
    expect(heavyPattern(splitCommand("my-suite --all"), own, splitCommand)?.cost).toEqual({ cores: 2, memory_mb: 512 });
  });
});

const cfg: PoolConfig = { ...DEFAULTS, load_share: 0.8, free_mb: 8192, cost: { cores: 4, memory_mb: 1536, ramp_s: 10 }, slots: null };
const at = 1_000_000;
const r = (runnable: number, mem = 40_000, cores = 24) => ({ cores, load1: runnable, runnable, mem_available_mb: mem, at });
const C4 = { cores: 4, memory_mb: 1536 };
const held = (n: number, ago = 60_000, cost = C4) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, who: "agent" as const, since: at - ago, cost }));
const gone = (ago: number, cost = C4) => ({ at: at - ago, cost });

describe("the room the machine has", () => {
  test("starts as many as the busy cores leave room for, up to the cap", () => {
    // 24 cores at 0.8: a limit of 19.2; 4 cores a command; at most 4 at once.
    expect(room(r(2), [], cfg)).toMatchObject({ slots: 4, free: 4, cause: "room" });
    expect(room(r(12), held(2), cfg)).toMatchObject({ slots: 3, free: 1 });
    expect(room(r(18), held(4), cfg)).toMatchObject({ slots: 4, free: 0, cause: "slots" });
  });
  test("each command counts at its own cost: suites fit twice as many as browsers", () => {
    const suite = { cores: 1.5, memory_mb: 2048 };
    // 8 cores at 0.83: a limit of 6.6. Browsers at 3 cores: two; suites at 1.5: four.
    const c = { ...cfg, load_share: 0.83 };
    expect(room(r(0.5, 40_000, 8), [], c, [], 0, { cores: 3, memory_mb: 1024 }).slots).toBe(2);
    expect(room(r(0.5, 40_000, 8), [], c, [], 0, suite).slots).toBe(4);
    // Two browsers that just started hold 6 cores: no suite fits beside them; two suites leave room for two more.
    expect(room(r(0.5, 40_000, 8), held(2, 1000, { cores: 3, memory_mb: 1024 }), c, [], 0, suite).free).toBe(0);
    expect(room(r(0.5, 40_000, 8), held(2, 1000, suite), c, [], 0, suite).free).toBe(2);
  });
  test("a command that just started counts before its load shows", () => {
    // Two given a second ago: the machine still reads idle, and they count as 8 cores.
    expect(room(r(2), held(2, 1000), cfg)).toMatchObject({ slots: 4, free: 2 });
    expect(room(r(10), held(2, 1000), cfg).free).toBe(0);
  });
  test("a command that just ended is taken off a busy count that still shows it", () => {
    expect(room(r(16), held(3), cfg).free).toBe(0);
    expect(room(r(16), held(2), cfg, [gone(1000)], 5000).free).toBe(1);
    expect(room(r(16), held(2), cfg, [gone(9000)], 5000).free).toBe(0);
  });
  test("other work on the machine holds the line; one may start when none runs", () => {
    expect(room(r(30), held(1), cfg)).toMatchObject({ free: 0, cause: "load" });
    expect(room(r(30), [], cfg)).toMatchObject({ slots: 1, free: 1 });
  });
  test("free memory under the floor and a command's memory holds the next", () => {
    expect(room(r(2, 9000), held(1), cfg)).toMatchObject({ free: 0, cause: "memory" });
    expect(room(r(2, 8192 + 1536 + 100), held(1), cfg).free).toBe(1);
  });
  test("with no slot held, free memory under the floor holds the first command too, and its coming back lets it go", () => {
    // Nothing runs, the processors are idle, but 9 GB free under an 8 GB floor leaves no room for 1.5 GB more.
    expect(room(r(2, 9000), [], cfg)).toMatchObject({ slots: 0, free: 0, cause: "memory" });
    expect(room(r(2, 0), [], cfg)).toMatchObject({ free: 0, cause: "memory" });
    expect(room(r(2, 8192 + 1536 + 100), [], cfg)).toMatchObject({ free: 1, cause: "room" });
    // The processors alone still never hold the first one.
    expect(room(r(30, 40_000), [], cfg)).toMatchObject({ slots: 1, free: 1 });
  });
  test("a command whose estimate and the floor are more than the machine has runs alone at once, and says why it waits behind others", () => {
    const big = { cores: 2, memory_mb: 30_000 };
    const total = (mem: number) => ({ ...r(2, mem), mem_total_mb: 32_000 });
    expect(room(total(20_000), [], cfg, [], 0, big)).toMatchObject({ free: 1 });
    expect(room(total(1000), [], cfg, [], 0, big)).toMatchObject({ free: 1 });
    const behind = room(total(20_000), held(1), cfg, [], 0, big);
    expect(behind).toMatchObject({ free: 0, cause: "memory" });
    expect(behind.why).toBe("its 30000 MB estimate and the 8192 MB kept free are more than this machine's 32000 MB: it runs alone when no slot is held");
    // One that fits a machine with that much memory waits for it as any other.
    expect(room({ ...r(2, 20_000), mem_total_mb: 64_000 }, [], cfg, [], 0, big)).toMatchObject({ free: 0, cause: "memory" });
  });
  test("an 8 GB machine under the default floor runs its heavy commands one at a time", () => {
    const small = (mem: number) => ({ ...r(1, mem), mem_total_mb: 7_800 });
    expect(room(small(3_000), [], cfg)).toMatchObject({ slots: 1, free: 1 });
    expect(room(small(3_000), held(1), cfg)).toMatchObject({ free: 0, cause: "memory" });
  });
  test("with no slot held, the head waits for memory at most MEM_WAIT_MS, then runs alone; its reason says so", () => {
    // A 16 GB desktop with 8 GB free: under the 8 GB floor plus 1.5 GB, but the floor plus the estimate fits 16 GB.
    const desk = { ...r(1, 8_000), mem_total_mb: 15_800 };
    const waiting = room(desk, [], cfg, [], 0, cfg.cost, MEM_WAIT_MS - 1);
    expect(waiting).toMatchObject({ free: 0, cause: "memory" });
    expect(waiting.why).toBe(`free memory is under the 8192 MB kept free plus its 1536 MB estimate; with no slot held it runs alone after ${MEM_WAIT_MS / 1000} s`);
    expect(room(desk, [], cfg, [], 0, cfg.cost, MEM_WAIT_MS)).toMatchObject({ slots: 1, free: 1 });
    // Alone: a second waits while the first holds its slot, whatever the first one waited.
    expect(room(desk, held(1), cfg, [], 0, cfg.cost, MEM_WAIT_MS)).toMatchObject({ free: 0, cause: "memory" });
    expect(room(desk, held(1), cfg).why).toBe("free memory is under the 8192 MB kept free plus its 1536 MB estimate");
  });
  test("the owner's fixed number of slots", () => {
    expect(room(r(2), [], { ...cfg, slots: 2 })).toMatchObject({ slots: 2, free: 2 });
    expect(room(r(2), held(2), { ...cfg, slots: 2 })).toMatchObject({ free: 0, cause: "slots" });
  });
});

describe("the line", () => {
  const line = [
    { key: "a1", who: "agent" as const, at: 1 },
    { key: "a2", who: "agent" as const, at: 2 },
    { key: "s1", who: "session" as const, at: 3 },
    { key: "a3", who: "agent" as const, at: 4 },
  ];
  test("a session's own command goes before the agents', each kind in its order", () => {
    expect(order(line).map((x) => x.key)).toEqual(["s1", "a1", "a2", "a3"]);
    expect(before(line, "session")).toBe(1);
    expect(before(line, "agent")).toBe(4);
    expect(before(line, "owner")).toBe(0);
  });
  test("the place says who holds the slots, with no live number, so it changes only with the place or the holders", () => {
    expect(placeLine(0, ["tsc (this session)"], "slots")).toBe("Waiting for a heavy-command slot: next in line, held by tsc (this session); every slot is taken");
    expect(placeLine(2, ["bun test (agent \"a\")", "go test (session)", "make (agent)", "cargo build (agent)", "tsc (agent)"], "load"))
      .toBe("Waiting for a heavy-command slot: 2 ahead, held by bun test (agent \"a\"), go test (session), make (agent) and 2 more; the machine is busy");
    expect(placeLine(0, [], "load")).toContain("none held");
  });
});

test("a holder gives its slot back when it has gone quiet: under a tenth of its cores for 15 s straight", () => {
  // 3 cores: quiet is under 0.3 of a core, 300 ms of processor time a second.
  let q = nextQuiet(undefined, { at: 0, cpu: 0 }, 3);
  q = nextQuiet(q, { at: 10_000, cpu: 2_000 }, 3);
  expect(quiet(q)).toBe(false);
  q = nextQuiet(q, { at: 15_000, cpu: 3_000 }, 3);
  expect(quiet(q)).toBe(true);
  // A burst starts the count again.
  const busy = nextQuiet(nextQuiet(undefined, { at: 0, cpu: 0 }, 3), { at: 15_000, cpu: 30_000 }, 3);
  expect(quiet(busy)).toBe(false);
  expect(busy.from).toBe(15_000);
  // A long gap between samples (no one waited) starts it again too.
  const gap = nextQuiet(nextQuiet(undefined, { at: 0, cpu: 0 }, 3), { at: 60_000, cpu: 0 }, 3);
  expect(quiet(gap)).toBe(false);
});

test("the load on the processors it may use, from the scheduler's times", () => {
  expect([...cpuList("0-2,8,10-11\n")]).toEqual([0, 1, 2, 8, 10, 11]);
  const text = "version 17\ntimestamp 1\ncpu0 0 0 0 0 0 0 1000 500 7\ndomain0 MC ff 0 0 0\ncpu1 0 0 0 0 0 0 2000 250 9\ncpu2 0 0 0 0 0 0 4000 4000 1\n";
  expect(schedTime(text)).toBe(11_750);
  expect(schedTime(text, new Set([0, 1]))).toBe(3_750);
  expect(schedTime(text, new Set([5]))).toBeUndefined();
  expect(schedTime("version 17\n")).toBeUndefined();
  // Six seconds of task time in two seconds: a load of 3.
  expect(loadBetween({ at: 0, ns: 0 }, { at: 2000, ns: 6e9 })).toBe(3);
  expect(loadBetween({ at: 0, ns: 0 }, { at: 0, ns: 6e9 })).toBeUndefined();
});

test("the settings check", () => {
  expect(checkConfig(DEFAULTS)).toBeUndefined();
  expect(checkConfig({ ...DEFAULTS, patterns: ["bun (test"] })).toContain("not a regular expression");
  expect(checkConfig({ ...DEFAULTS, slots: 0 })).toContain("slots");
  expect(checkConfig({ ...DEFAULTS, load_share: 0 })).toContain("load_share");
  expect(checkConfig({ ...DEFAULTS, patterns: ["x", { pattern: "y", cores: 1, memory_mb: 0 }] })).toBeUndefined();
  expect(checkConfig({ ...DEFAULTS, patterns: [{ pattern: "y", cores: 0, memory_mb: 0 }] })).toContain("cores");
});
