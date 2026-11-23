import { expect, test } from "bun:test";
import { beforeLine, commandFor, declaredOf, howToRun, keyOf, limitFor, LINE_MAX, lockDirOf, missingOnBase, missingPackage, needsOf, testsOf, timesCpu, verdictOf, withTimes, type FileResult } from "./before.ts";
import { parseChecks } from "./named.ts";

const named = parseChecks(JSON.stringify({
  checks: {
    typecheck: "bunx tsc --noEmit -p .",
    unit: { run: "bun test", args: true, tests: ["**/*.test.ts"] },
    web: { run: "npx vitest run", args: true, dir: "web", tests: ["web/**/*.spec.ts"] },
  },
}));

test("a check names its test files only with args and a folder of its own", () => {
  expect(named.problems).toEqual([]);
  expect(parseChecks(JSON.stringify({ checks: { u: { run: "bun test", tests: ["*.test.ts"] } } })).problems[0]).toContain('"tests" needs "args": true');
  expect(parseChecks(JSON.stringify({ checks: { u: { run: "bun test", args: true, dir: "*", tests: ["*.test.ts"] } } })).problems[0]).toContain("not \"*\"");
  expect(parseChecks(JSON.stringify({ checks: { u: { run: "bun test", args: true, tests: ["../x.test.ts"] } } })).problems[0]).toContain("globs from the repository's top");
  // A check without the field has none (and its shape is what it was).
  expect("tests" in named.checks[0]!).toBe(false);
});

test("changed files that are tests, each with the check that runs it, as one command for the file", () => {
  const got = testsOf(["README.md", "src/a.test.ts", "web/b.spec.ts", "a.test.ts", "web/c.ts", "src/a.test.ts"], named.checks);
  expect(got.map((t) => [t.path, t.check.name, commandFor(t)])).toEqual([
    ["a.test.ts", "unit", "bun test ./a.test.ts"],
    ["src/a.test.ts", "unit", "bun test ./src/a.test.ts"],
    ["web/b.spec.ts", "web", "npx vitest run ./b.spec.ts"],
  ]);
  expect(commandFor({ path: "it's here.test.ts", check: named.checks[1]! })).toBe("bun test './it'\\''s here.test.ts'");
});

test("what a run on the base says", () => {
  const v = (code: number | null, out: string, more: object = {}) => verdictOf({ code, out, limitMs: 120_000, ...more });
  expect(v(1, " 1 pass\n 2 fail\nRan 3 tests across 1 file.")).toEqual({ state: "fails", why: "2 of 3 failed" });
  expect(v(0, " 4 pass\n 0 fail\n")).toEqual({ state: "passes", why: "4 passed" });
  expect(v(0, "ok\n")).toEqual({ state: "passes", why: "" });
  // A module the change adds is missing on the base: the file fails, and says why.
  expect(v(1, "# Unhandled error between tests\nerror: Cannot find module './missing.ts' from 'a.test.ts'\n 0 pass\n 1 fail\n 1 error\n")).toEqual({ state: "fails", why: "it does not load without the change: Cannot find module './missing.ts' from 'a.test.ts'" });
  // An assertion's own words are not a load error.
  expect(v(1, "calc.test.ts:\n3 | test(\"x\", () => expect(div(1, 0)).toBe(0));\nerror: expect(received).toBe(expected)\n\nExpected: 0\nReceived: Infinity\n 0 pass\n 1 fail\n")).toEqual({ state: "fails", why: "1 of 1 failed" });
  expect(v(127, "bash: line 1: ./run.sh: No such file or directory\n")).toEqual({ state: "unrun", why: "the command could not start on the base: bash: line 1: ./run.sh: No such file or directory" });
  expect(v(null, "", { timedOut: true })).toEqual({ state: "unrun", why: "it ran past its 120 s limit and was stopped" });
  expect(v(null, "", { signal: "SIGKILL" })).toEqual({ state: "unrun", why: "it was ended by SIGKILL" });
  expect(v(0, " 0 pass\n 0 fail\n")).toEqual({ state: "unrun", why: "no test in it ran on the base" });
  expect(v(2, "boom\n")).toEqual({ state: "fails", why: "exit 2: boom" });
});

test("a package the base declares that does not load is the checkout's lack, not a failure before", () => {
  const out = "# Unhandled error between tests\nerror: Cannot find module '@simplewebauthn/server' from '/s/src/admin/x.ts'\n 0 pass\n 1 fail\n 1 error\n";
  const declared = declaredOf(['{"dependencies":{"@simplewebauthn/server":"^13"},"devDependencies":{"typescript":"^5"}}', "not json"]);
  expect([...declared].sort()).toEqual(["@simplewebauthn/server", "typescript"]);
  const v = (base?: Parameters<typeof verdictOf>[1]) => verdictOf({ code: 1, out, limitMs: 120_000 }, base);
  expect(v({ declared })).toEqual({ state: "unrun", why: "the base's packages are not there: Cannot find module '@simplewebauthn/server' from '/s/src/admin/x.ts'" });
  expect(v({ declared, why: "its install (bun install --frozen-lockfile) did not finish: exit 1" })).toEqual({ state: "unrun", why: "the base's packages are not there: its install (bun install --frozen-lockfile) did not finish: exit 1" });
  // A package only the change adds, or a module of the repository's own, is a real failure before.
  expect(v({ declared: new Set(["typescript"]) }).state).toBe("fails");
  expect(verdictOf({ code: 1, out: "error: Cannot find module './gone.ts' from 'a.test.ts'\n 0 pass\n 1 fail\n", limitMs: 1 }, { declared: new Set(["gone.ts"]) }).state).toBe("fails");
  expect([missingPackage("Cannot find package 'lodash/fp' imported from /x.js"), missingPackage("Cannot find module '@a/b/c'"), missingPackage("Cannot find module 'node:fs'"), missingPackage("Cannot find module '/abs/x'")]).toEqual(["lodash", "@a/b", undefined, undefined]);
});

test("a file that fails writing under packages read-only to it could not run, it does not fail before", () => {
  const out = "error: EROFS: read-only file system, open '/s/node_modules/.cache/x'\n 0 pass\n 1 fail\n";
  const v = (base?: Parameters<typeof verdictOf>[1], o = out) => verdictOf({ code: 1, out: o, limitMs: 120_000 }, base);
  expect(v({ declared: new Set(), readOnly: true })).toEqual({ state: "unrun", why: "the base's packages are read-only here: the test writes under node_modules" });
  expect(v({ declared: new Set(), readOnly: true }, "mkdir: cannot create directory 'node_modules/.vite': Read-only file system\n 0 pass\n 1 fail\n").state).toBe("unrun");
  // Packages it may write, or a read-only folder that is not theirs: what the run says.
  expect(v({ declared: new Set() })).toEqual({ state: "fails", why: "1 of 1 failed" });
  expect(v({ declared: new Set(), readOnly: true }, "error: EROFS: read-only file system, open '/s/out.txt'\n 0 pass\n 1 fail\n").state).toBe("fails");
});

test("the packages of a check's folder are the nearest lockfile's, up to the top", () => {
  const has = (files: string[]) => (p: string) => files.includes(p);
  expect(lockDirOf("web/app", has(["bun.lock", "web/package-lock.json"]))).toMatchObject({ dir: "web", lock: { install: "npm ci" } });
  expect(lockDirOf("web/app", has(["bun.lock"]))).toMatchObject({ dir: ".", lock: { install: "bun install --frozen-lockfile" } });
  expect(lockDirOf(".", has([]))).toBeUndefined();
});

test("a run is known by its base, its files' content and commands", () => {
  const f = (bytes: string) => [{ path: "a.test.ts", command: "bun test ./a.test.ts", bytes: new TextEncoder().encode(bytes) }];
  expect(keyOf("abc", f("x"))).toBe(keyOf("abc", f("x")));
  expect(keyOf("abc", f("x"))).not.toBe(keyOf("abc", f("y")));
  expect(keyOf("abc", f("x"))).not.toBe(keyOf("abd", f("x")));
});

test("a file's limit: the agent's own runs times three, never under the shell tool's default", () => {
  expect(limitFor([])).toBe(120_000);
  expect(limitFor([5_000, 60_000])).toBe(180_000);
});

test("the report line says each file, and what is still running", () => {
  const r = (path: string, state: FileResult["state"], why = ""): FileResult => ({ path, check: "unit", command: `bun test ./${path}`, state, why, exit: null, ms: 1, cpu_ms: 1 });
  const base = { mergeBase: "0123456789abcdef", base: "origin/main" };
  expect(beforeLine({ ...base, results: [] })).toBe("");
  expect(beforeLine({ ...base, results: [r("a.test.ts", "fails", "2 of 3 failed"), r("b.test.ts", "passes"), r("c.test.ts", "unrun", "the command could not start on the base: x")] })).toBe(
    "(Its new and changed tests on the base (origin/main at 012345678), without the change: a.test.ts fails before: yes (2 of 3 failed); b.test.ts passes without the change; c.test.ts could not run (the command could not start on the base: x).)",
  );
  expect(beforeLine({ ...base, results: [r("a.test.ts", "fails"), r("b.test.ts", "running"), r("c.test.ts", "waiting")] })).toBe(
    "(Its new and changed tests on the base (origin/main at 012345678), without the change: a.test.ts fails before: yes; 2 still running (their answers follow when done, and the Review view shows them).)",
  );
  expect(beforeLine({ ...base, why: "no base to compare with", results: [r("a.test.ts", "waiting")] })).toContain("a.test.ts could not run (no base to compare with)");
  const many = Array.from({ length: 30 }, (_, i) => r(`src/some/rather/long/folder/name/file-${i}.test.ts`, i % 2 ? "passes" : "fails", "1 of 1 failed"));
  const line = beforeLine({ ...base, results: many });
  expect(line.length).toBeLessThanOrEqual(LINE_MAX);
  expect(line).toContain("more");
});

test("the run is confined as the agent's own commands are, or not made, and an unconfined one says why", () => {
  expect(howToRun({ mode: "ask", sandbox: "read-only" }, { sandbox: "read-only" })).toEqual({ confined: true, sandbox: "read-only" });
  expect(howToRun({ mode: "full-auto", sandbox: "off" }, undefined)).toEqual({ confined: false, why: "the session runs in full auto with its sandbox off" });
  expect(howToRun({ mode: "full-auto", sandbox: "workspace-write" }, undefined)).toEqual({ confined: false, why: "the session runs in full auto and the sandbox is not available on this machine" });
  expect(howToRun({ mode: "auto", sandbox: "off" }, undefined)).toEqual({ refused: "the session's commands run outside the sandbox and its mode asks before a command runs" });
  expect(howToRun({ mode: "auto", sandbox: "workspace-write" }, undefined)).toMatchObject({ refused: expect.stringContaining("not available") });
  expect(howToRun(undefined, { sandbox: "workspace-write" })).toMatchObject({ refused: expect.stringContaining("could not be read") });
  const r: FileResult = { path: "a.test.ts", check: "unit", command: "bun test ./a.test.ts", state: "fails", why: "", exit: 1, ms: 1, cpu_ms: 1 };
  expect(beforeLine({ mergeBase: "0123456789", base: "main", unconfined: "the session runs in full auto with its sandbox off", results: [r] })).toBe(
    "(Its new and changed tests on the base (main at 012345678), without the change, run outside the sandbox (the session runs in full auto with its sandbox off): a.test.ts fails before: yes.)",
  );
});

test("a command whose own program or script is not on the base could not run", () => {
  const has = (files: string[]) => ({ file: (p: string) => files.includes(p), onPath: (n: string) => ["sh", "bun"].includes(n) });
  expect(needsOf("X=1 sh scripts/t.sh --quick")).toEqual({ program: "sh", script: "scripts/t.sh" });
  expect(needsOf("bun test")).toEqual({ program: "bun" });
  expect(missingOnBase("bun test", has([]))).toBeUndefined();
  expect(missingOnBase("sh tools/run.sh", has([]))).toBe("its command's script tools/run.sh is not on the base");
  expect(missingOnBase("sh tools/run.sh", has(["tools/run.sh"]))).toBeUndefined();
  expect(missingOnBase("./run-tests", has([]))).toBe("its command's program ./run-tests is not on the base");
  expect(missingOnBase("pytest", has([]))).toBe("its command's program pytest is not on the base");
});

test("the processor time of a run, from bash's times", () => {
  expect(timesCpu("0m0.002s 0m0.001s\n0m0.398s 0m0.020s\n")).toBe(421);
  expect(timesCpu("1m2.500s 0m0.000s\n0m0.000s 0m0.000s\n")).toBe(62_500);
  expect(timesCpu("")).toBeNull();
  expect(withTimes("bun test ./a.test.ts", "/s/7.tool/cpu-times")).toBe("bun test ./a.test.ts\ns=$?; times > /s/7.tool/cpu-times 2>/dev/null; exit $s");
});
