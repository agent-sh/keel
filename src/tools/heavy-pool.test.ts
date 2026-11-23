import { describe, expect, test } from "bun:test";
import { splitCommand } from "../safety/shell.ts";
import { admit, before, checkConfig, compile, cpuList, heavyPattern, loadBetween, placeLine, room, schedTime, type PoolConfig } from "./heavy-pool.ts";
import { DEFAULTS } from "./heavy.ts";

const pats = compile(DEFAULTS.patterns);
const heavy = (c: string) => heavyPattern(splitCommand(c), pats, splitCommand);

describe("which commands are heavy", () => {
  test("a suite, a build or a browser, under wrappers and after other commands", () => {
    expect(heavy("cd x && FOO=1 bun test ./src")).toBe("^(?:(bun|deno) test)(?![\\w.-])");
    expect(heavy("timeout 600 nice -n 10 cargo build --release 2>&1 | tail -5")).toContain("cargo");
    expect(heavy("waitfor --capacity 20,8 --timeout 10m && bunx playwright test a.spec.ts")).toContain("playwright");
    expect(heavy("bash -c 'go test ./...'")).toContain("go");
    expect(heavy("systemd-run --user --scope -p CPUWeight=20 -- npm run build")).toContain("npm");
    expect(heavy("echo $(bun test)")).toBeDefined();
    expect(heavy("scripts/smoke.sh test/e2e/chat.spec.ts")).toContain("smoke");
    expect(heavy("bash -x scripts/smoke.sh a.spec.ts")).toContain("smoke");
    expect(heavy("bash scripts/lint.sh")).toBeUndefined();
  });
  test("not what runs elsewhere, mentions a suite, or only looks like one", () => {
    expect(heavy("ssh devbox 'cd y && bun test'")).toBeUndefined();
    expect(heavy("echo bun test")).toBeUndefined();
    expect(heavy("git status && rg -n 'bun test' docs")).toBeUndefined();
    expect(heavy("bun tests.ts")).toBeUndefined();
    expect(heavy("maker --help")).toBeUndefined();
    expect(heavyPattern(splitCommand("bun test"), [], splitCommand)).toBeUndefined();
  });
});

const cfg: PoolConfig = { ...DEFAULTS, load_share: 0.8, free_mb: 8192, cost: { cores: 4, memory_mb: 1536, ramp_s: 10 }, slots: null };
const at = 1_000_000;
const r = (runnable: number, mem = 40_000) => ({ cores: 24, load1: runnable, runnable, mem_available_mb: mem, at });
const held = (n: number, ago = 60_000) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, who: "agent" as const, since: at - ago }));

describe("the room the machine has", () => {
  test("starts as many as the busy cores leave room for, up to the cap", () => {
    // 24 cores at 0.8: a limit of 19.2; 4 cores a command; at most 4 at once.
    expect(room(r(2), [], cfg)).toMatchObject({ slots: 4, free: 4, cause: "room" });
    expect(room(r(12), held(2), cfg)).toMatchObject({ slots: 3, free: 1 });
    expect(room(r(18), held(4), cfg)).toMatchObject({ slots: 4, free: 0, cause: "slots" });
  });
  test("a command that just started counts before its load shows", () => {
    // Two given a second ago: the machine still reads idle, and they count as 8 cores.
    expect(room(r(2), held(2, 1000), cfg)).toMatchObject({ slots: 4, free: 2 });
    expect(room(r(10), held(2, 1000), cfg).free).toBe(0);
  });
  test("a command that just ended is taken off a busy count that still shows it", () => {
    expect(room(r(16), held(3), cfg).free).toBe(0);
    expect(room(r(16), held(2), cfg, [at - 1000], 5000).free).toBe(1);
    expect(room(r(16), held(2), cfg, [at - 9000], 5000).free).toBe(0);
  });
  test("other work on the machine holds the line; one may start when none runs", () => {
    expect(room(r(30), held(1), cfg)).toMatchObject({ free: 0, cause: "load" });
    expect(room(r(30), [], cfg)).toMatchObject({ slots: 1, free: 1 });
  });
  test("free memory under the floor and a command's memory holds the next", () => {
    expect(room(r(2, 9000), held(1), cfg)).toMatchObject({ free: 0, cause: "memory" });
    expect(room(r(2, 8192 + 1536 + 100), held(1), cfg).free).toBe(1);
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
    expect(admit(line, 2).map((x) => x.key)).toEqual(["s1", "a1"]);
    expect(admit(line, 0)).toEqual([]);
    expect(before(line, "session")).toBe(1);
    expect(before(line, "agent")).toBe(4);
    expect(before(line, "owner")).toBe(0);
  });
  test("the place is said with no live number, so it changes only with the place", () => {
    expect(placeLine(0, 4, "slots")).toBe("Waiting for a heavy-command slot: next in line, 4 running, every slot is taken");
    expect(placeLine(2, 3, "load")).toBe("Waiting for a heavy-command slot: 2 ahead, 3 running, the machine is busy");
  });
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
});
