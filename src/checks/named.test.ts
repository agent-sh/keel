import { expect, test } from "bun:test";
import { matchCommand, normDir, parseChecks } from "./named.ts";

const FILE = JSON.stringify({
  checks: {
    typecheck: "bunx tsc --noEmit -p .",
    unit: { run: "bun test", args: true },
    e2e: { run: "bunx playwright test", args: true, cache: false },
    web: { run: "npm test", dir: "./web/" },
  },
});
const { checks, problems } = parseChecks(FILE);

test("a checks file: a string or an object a check, with its defaults", () => {
  expect(problems).toEqual([]);
  expect(checks).toEqual([
    { name: "typecheck", run: "bunx tsc --noEmit -p .", args: false, dir: ".", cache: true },
    { name: "unit", run: "bun test", args: true, dir: ".", cache: true },
    { name: "e2e", run: "bunx playwright test", args: true, dir: ".", cache: false },
    { name: "web", run: "npm test", args: false, dir: "web", cache: true },
  ]);
});

test("what is wrong in a file is said, and the rest is kept", () => {
  const got = parseChecks(JSON.stringify({ checks: { ok: "make", "bad name": "x", empty: "", out: { run: "x", dir: "../up" }, flag: { run: "x", args: "yes" } } }));
  expect(got.checks.map((c) => c.name)).toEqual(["ok"]);
  expect(got.problems).toHaveLength(4);
  expect(parseChecks("{").problems[0]).toStartWith("it is not JSON");
  expect(parseChecks("[]").problems).toEqual(['it has no "checks" object']);
});

test("a command is a check as written, with its output filters taken off", () => {
  expect(matchCommand("bunx tsc --noEmit -p .", checks, ".")?.check.name).toBe("typecheck");
  expect(matchCommand("  bunx   tsc --noEmit -p . 2>&1 | tail -20", checks, ".")).toMatchObject({ command: "bunx tsc --noEmit -p .", piped: true });
  expect(matchCommand("bunx tsc --noEmit -p . 2>&1 | head -n 5 | tail -3", checks, ".")?.piped).toBe(true);
  expect(matchCommand("bunx tsc --noEmit -p .", checks, ".")?.piped).toBe(false);
  // More words only where the check allows them; each set of words is a check run of its own.
  expect(matchCommand("bunx tsc --noEmit -p . --watch", checks, ".")).toBeUndefined();
  expect(matchCommand("bun test ./src/checks", checks, ".")).toMatchObject({ command: "bun test ./src/checks", check: { name: "unit" } });
  expect(matchCommand("bun testing", checks, ".")).toBeUndefined();
});

test("a command that runs anything else is not the check", () => {
  for (const c of ["bun test; rm -rf x", "bun test && echo ok", "bun test || true", "bun test > out.log", "bun test $(cat list)", "bun test `x`", "bun test | grep fail", "bun test\necho"]) {
    expect(matchCommand(c, checks, ".")).toBeUndefined();
  }
});

test("a check runs in its own folder; a leading cd moves there", () => {
  expect(matchCommand("npm test", checks, ".")).toBeUndefined();
  expect(matchCommand("npm test", checks, "web")?.check.name).toBe("web");
  expect(matchCommand("cd web && npm test", checks, ".")).toMatchObject({ dir: "web", check: { name: "web" } });
  expect(matchCommand("cd 'web' && npm test 2>&1 | tail -5", checks, ".")).toMatchObject({ dir: "web", piped: true });
  expect(matchCommand("cd .. && bun test", checks, "web")?.dir).toBe(".");
  expect(matchCommand("cd /elsewhere && bun test", checks, ".", () => undefined)).toBeUndefined();
  expect(normDir("a/./b/../c/")).toBe("a/c");
  expect(normDir("../x")).toBe("..");
});
