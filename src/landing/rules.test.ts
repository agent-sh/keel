import { expect, test } from "bun:test";
import { parseChecks } from "../checks/named.ts";
import { buildOrder, checksToRun, outcomeText, queueWarning, readLand, tailOf, TIMEOUT_MINUTES } from "./rules.ts";

const named = parseChecks(JSON.stringify({ checks: { typecheck: "bunx tsc --noEmit -p .", unit: { run: "bun test", args: true }, any: { run: "x", dir: "*" }, remote: { run: "~/bin/rv", args: true, tree: { commit: "last" } } } })).checks;

test("the land rules: defaults, each field, and what is wrong", () => {
  expect(readLand(undefined)).toEqual({ method: "rebase", timeoutMs: TIMEOUT_MINUTES * 60_000, problems: [] });
  const r = readLand({ checks: ["typecheck", "unit test/x"], setup: "ln -s a b", after: "deploy", push: "origin", method: "merge", timeout_minutes: 5 });
  expect(r).toEqual({ checks: [{ name: "typecheck", args: [] }, { name: "unit", args: ["test/x"] }], setup: "ln -s a b", after: "deploy", push: "origin", method: "merge", timeoutMs: 300_000, problems: [] });
  expect(readLand({ push: false }).push).toBeUndefined();
  expect(readLand({ push: "a b", method: "squash", timeout_minutes: 0, checks: "unit" }).problems).toHaveLength(4);
});

test("which checks an entry must pass", () => {
  // Every check of the work tree in one folder, with no words added.
  expect(checksToRun(readLand(undefined), named, "/h")).toEqual({ run: [{ check: named[0]!, command: "bunx tsc --noEmit -p .", dir: "." }, { check: named[1]!, command: "bun test", dir: "." }] });
  expect(checksToRun(readLand({ checks: ["unit test/x"] }), named, "/h")).toMatchObject({ run: [{ command: "bun test test/x" }] });
  expect(checksToRun(readLand({ checks: ["lint"] }), named, "/h")).toEqual({ problem: "land.checks names lint, which .keel/checks.json does not name" });
  expect(checksToRun(readLand({ checks: ["typecheck src"] }), named, "/h")).toEqual({ problem: "land.checks gives typecheck words of its own, and typecheck takes none" });
  expect("problem" in checksToRun(readLand({ checks: ["remote"] }), named, "/h")).toBe(true);
  expect("problem" in checksToRun(readLand({ checks: [] }), named, "/h")).toBe(true);
  expect("problem" in checksToRun(readLand(undefined), [], "/h")).toBe(true);
});

test("build order: as queued, a branch the forecast finds conflicting with the base last", () => {
  const e = (branch: string, pos: number) => ({ branch, pos });
  expect(buildOrder([e("c", 3), e("a", 1), e("b", 2)], new Set(["a"])).map((x) => x.branch)).toEqual(["b", "c", "a"]);
});

test("the warning a queued branch gets from the forecast", () => {
  expect(queueWarning("x", "main", { base: undefined, ahead: [] })).toBeUndefined();
  const w = queueWarning("x", "main", { base: ["a.ts"], ahead: [{ branch: "y", files: ["b.ts"] }] })!;
  expect(w).toContain("x would conflict with main in a.ts: it leaves the queue at its rebase unless it is rebased onto main first");
  expect(w).toContain("x would conflict with y, queued ahead of it, in b.ts: if y lands, x leaves and is rebased onto it");
});

test("the outcome: what landed on which tree, what left and why", () => {
  const t = outcomeText({ repo: "/r", base: "main", from: "a".repeat(40), to: "c".repeat(40), checks: ["test"], push: { remote: "origin", ok: true }, landed: [{ branch: "k/a", tip: "1".repeat(40), at: "b".repeat(40) }, { branch: "k/c", tip: "2".repeat(40), at: "c".repeat(40), moved: true }], left: [{ branch: "k/b", why: "test failed on it" }], after: { exit: 0, log: "/l" } });
  expect(t).toBe([
    "[harness] Landing queue:",
    "- Landed on main: k/a (as bbbbbbbbb), k/c (as ccccccccc). main moved aaaaaaaaa to ccccccccc, a fast-forward to the commit test passed on, and was pushed to origin.",
    "- k/c moved while it was checked: what came after the checked tip is not landed; queue it again.",
    "- The after-land step ran once (exit 0). Its output: /l",
    "- k/b left the queue: test failed on it.",
  ].join("\n"));
  expect(tailOf("a\n\nb\x1b[31m\nc\n", 2)).toBe("b | c");
});

// The after step's pin holds the landing it comes after whole: a check's inputs, folder or cache moved is another landing.
test("the land text holds each check whole", async () => {
  const { landText } = await import("./land-pin.ts");
  const rules = readLand({ checks: ["unit"], after: "true" });
  const text = (c: object) => landText(rules, parseChecks(JSON.stringify({ checks: { unit: { run: "bun test", ...c } } })).checks);
  const one = text({});
  expect(text({ inputs: ["node_modules"] })).not.toBe(one);
  expect(text({ dir: "ui" })).not.toBe(one);
  expect(text({ cache: false })).not.toBe(one);
  expect(text({})).toBe(one);
});
