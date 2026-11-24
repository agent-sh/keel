import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimState } from "../core/claim.ts";
import { stateIdFrom } from "../tools/jobs.ts";
import { commandOf, list, liveStates, look, stop, summarize } from "./foreign-scopes.ts";

const cg = "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/keel-job-b12k1z677-v9729n.scope";

test("what a scope holds is said from its processes: commands once, marks and sessions, the folder and when it began", () => {
  const procs = [
    { pid: 10, argv: ["bash", "-c", "while [ ! -e /x/s ];\ndo sleep 0.2; done"], mark: "b4alu2.100", session: "s1", cwd: "/work/told-1-ws (deleted)", started: 5_000 },
    { pid: 11, argv: ["bash", "-c", "while [ ! -e /x/s ];\ndo sleep 0.2; done"], mark: "b4alu2.100", session: "s1", cwd: "/work/told-1-ws (deleted)", started: 4_000 },
    { pid: 12, argv: ["sleep", "0.2"], mark: "b4alu3.200", session: "s2", started: 9_000 },
    { pid: 13, argv: ["a"] }, { pid: 14, argv: ["b"] },
  ];
  const s = summarize(cg, procs, { why: "no process in its scope carries the job's mark", cpu_ms: 1234, memory_bytes: 99 });
  expect(s).toMatchObject({
    unit: "keel-job-b12k1z677-v9729n.scope", tasks: 5, cpu_ms: 1234, memory_bytes: 99, since: 4_000, why: "no process in its scope carries the job's mark",
    marks: ["b4alu2.100", "b4alu3.200"], sessions: ["s1", "s2"], cwd: "/work/told-1-ws", gone: true,
  });
  expect(s.commands).toEqual(["bash -c while [ ! -e /x/s ]; do sleep 0.2; done", "sleep 0.2", "a"]);
});

test("a stop is refused for a scope this daemon did not list, a name that is no job scope, and marks that changed", async () => {
  // Folders of a scratch tree stand for scopes: nothing real is looked at or signalled.
  const dir = mkdtempSync(join(tmpdir(), "keel-foreign-"));
  const scope = join(dir, "keel-job-b1-abcdef.scope");
  mkdirSync(scope);
  writeFileSync(join(scope, "cgroup.procs"), "");
  await expect(stop(scope, { marks: [] }, new Set())).rejects.toThrow("not a job scope of another daemon");
  const odd = join(dir, "other.service");
  mkdirSync(odd);
  await expect(stop(odd, { marks: [] }, new Set([odd]))).rejects.toThrow("not a job scope of another daemon");
  await expect(stop(scope, { marks: ["b4alu2.100"] }, new Set([scope]))).rejects.toThrow("other commands than the ones that were shown");
  // What was shown (nothing is in it) is stopped: no process to signal.
  expect(await stop(scope, { marks: [] }, new Set([scope]))).toEqual({ stopped: true, left: [] });
  // A scope that is gone is stopped.
  expect(await stop(join(dir, "keel-job-b2-abcdef.scope"), { marks: ["x"] }, new Set([join(dir, "keel-job-b2-abcdef.scope")]))).toEqual({ stopped: true, left: [] });
});

test("a job's wrapper and its trace lines are not the command: what the owner wrote is", () => {
  const trace = "set -T\ntrap '{ __keel_ps=1; } 2>/dev/null' DEBUG\ntrap 'pwd -P >| /x/cwd' EXIT\nexec 2>&1\ncd /work && sleep 600";
  expect(commandOf(["bash", "-c", '"$@"; c=$?; echo $c > "$0"; exit $c', "/s/jobs/b1.log.exit", "bash", "-c", trace])).toBe("bash -c cd /work && sleep 600");
  expect(commandOf(["/usr/bin/bash", "-c", 'p=$KEEL_CONCEAL; "$@" 2>&1 | x; echo $c > "$0"', "/s/jobs/b2.log.exit", "bash", "-c", "exec 2>&1\nwhile true; do sleep 0.2; done"])).toBe("bash -c while true; do sleep 0.2; done");
  // Anything else is as it was started.
  expect(commandOf(["sleep", "700"])).toBe("sleep 700");
  expect(commandOf(["bash", "-c", "echo hi"])).toBe("bash -c echo hi");
});

// A folder stands for a scope: its cgroup.procs names the processes.
const fakeScope = (dir: string, name: string, pids: number[]) => {
  const scope = join(dir, name);
  mkdirSync(scope, { recursive: true });
  writeFileSync(join(scope, "cgroup.procs"), pids.map((p) => `${p}\n`).join(""));
  return scope;
};
const spawnWith = (env: Record<string, string>) => Bun.spawn(["sleep", "30"], { env: { PATH: process.env.PATH ?? "/usr/bin", ...env }, stdout: "ignore", stderr: "ignore" });

/** Until a spawned child has exec'd, /proc shows the test process's own environment: wait for its own command line. */
const execd = async (pids: number[]) => {
  for (const pid of pids) {
    for (let i = 0; i < 400; i++) {
      let cmd = "";
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch {}
      if (cmd.startsWith("sleep\0")) break;
      await Bun.sleep(5);
    }
  }
};

test("a scope that holds this daemon or a process above it is marked, and never stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-foreign-"));
  const mine = fakeScope(dir, "keel-job-b1-abcdef.scope", [process.pid]);
  const above = fakeScope(dir, "keel-job-b2-abcdef.scope", [process.ppid]);
  const other = spawnWith({});
  try {
    const apart = fakeScope(dir, "keel-job-b3-abcdef.scope", [other.pid]);
    expect((await look(mine))?.holds_self).toBe(true);
    expect((await look(above))?.holds_self).toBe(true);
    expect((await look(apart))?.holds_self).toBeUndefined();
    await expect(stop(mine, { marks: [] }, new Set([mine]))).rejects.toThrow("this daemon runs in that scope");
    await expect(stop(above, { marks: [] }, new Set([above]))).rejects.toThrow("this daemon runs in that scope");
  } finally { other.kill(); }
});

test("a scope whose state folder has a running daemon says so, and is listed after those a dead daemon left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-foreign-"));
  const live = join(dir, "live-state"), dead = join(dir, "dead-state");
  for (const d of [live, dead]) mkdirSync(join(d, "spill"), { recursive: true });
  const idOf = (d: string) => stateIdFrom(statSync(join(d, "spill"), { bigint: true }));
  // A daemon holds its folder's claim; the other folder's daemon is gone.
  const claim = claimState(live);
  const a = spawnWith({ KEEL_JOB: "b1.100", KEEL_JOB_STATE: idOf(live) });
  const b = spawnWith({ KEEL_JOB: "b2.100", KEEL_JOB_STATE: idOf(dead) });
  try {
    const first = fakeScope(dir, "keel-job-b1-abcdef.scope", [a.pid]), second = fakeScope(dir, "keel-job-b2-abcdef.scope", [b.pid]);
    expect((await liveStates()).has(idOf(live))).toBe(true);
    expect((await liveStates()).has(idOf(dead))).toBe(false);
    const rows = await list([first, second], new Map());
    expect(rows.map((r) => [r.unit, r.daemon_live ?? false])).toEqual([["keel-job-b2-abcdef.scope", false], ["keel-job-b1-abcdef.scope", true]]);
    claim?.release();
    expect((await list([first], new Map()))[0]!.daemon_live).toBeUndefined();
  } finally { claim?.release(); a.kill(); b.kill(); }
});

test("the marks a stop is checked against are read from every process of the scope the listing read, not the first dozen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-foreign-"));
  const procs = Array.from({ length: 20 }, (_, i) => spawnWith({ KEEL_JOB: i === 19 ? "b9.900" : "b1.100" }));
  try {
    await execd(procs.map((p) => p.pid));
    const scope = fakeScope(dir, "keel-job-b1-abcdef.scope", procs.map((p) => p.pid));
    const seen = await look(scope);
    expect(seen?.marks).toEqual(["b1.100", "b9.900"]);
    // The listing showed only the first mark: the scope holds another one, so the stop is refused.
    await expect(stop(scope, { marks: ["b1.100"] }, new Set([scope]))).rejects.toThrow("other commands than the ones that were shown");
  } finally { for (const p of procs) p.kill(); }
});
