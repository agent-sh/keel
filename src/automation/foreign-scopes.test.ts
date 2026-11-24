import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandOf, stop, summarize } from "./foreign-scopes.ts";

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
