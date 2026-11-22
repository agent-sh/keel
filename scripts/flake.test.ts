import { expect, test } from "bun:test";
import { parseRun, report, shuffled, table } from "./flake.ts";

const line = (mark: string, n: number, file: string, at: number, title: string, project = "") => `  ${mark}  ${n} ${project}test/e2e/${file}.spec.ts:${at}:1 › ${title} (1.2s)`;

test("a list report is read with and without a project, with a skipped test and a repeated one", () => {
  const run = parseRun([
    "Running 4 tests using 1 worker",
    line("✓", 1, "copy", 12, "copy what a session shows", "[002 copy] › "),
    line("✘", 2, "alerts", 185, "alerts: a row is title, state and one line"),
    "  -  3 test/e2e/plan.spec.ts:9:1 › plan mode",
    line("✓", 4, "alerts", 185, "alerts: a row is title, state and one line"),
    "  1 failed",
  ].join("\n"));
  expect(run.order).toEqual(["test/e2e/copy.spec.ts", "test/e2e/alerts.spec.ts", "test/e2e/plan.spec.ts"]);
  expect(Object.fromEntries(run.results)).toEqual({
    "test/e2e/copy.spec.ts:12 › copy what a session shows": ["pass"],
    "test/e2e/alerts.spec.ts:185 › alerts: a row is title, state and one line": ["fail", "pass"],
    "test/e2e/plan.spec.ts:9 › plan mode": ["skip"],
  });
});

test("a seed gives the same order again, and another seed another", () => {
  const files = Array.from({ length: 40 }, (_, i) => `f${i}`);
  expect(shuffled(files, 7)).toEqual(shuffled(files, 7));
  expect(shuffled(files, 7)).not.toEqual(shuffled(files, 8));
  expect([...shuffled(files, 7)].sort()).toEqual([...files].sort());
});

test("a test that fails only after another spec is told with that spec", () => {
  const run = (order: string[], b: string) => parseRun(order.map((f, i) => line(f === "b" ? b : "✓", i + 1, f, 1, `${f} works`)).join("\n"));
  const rows = table([run(["a", "b", "c"], "✘"), run(["b", "a", "c"], "✓"), run(["c", "a", "b"], "✘"), run(["b", "c", "a"], "✓")]);
  const b = rows.find((r) => r.test.startsWith("test/e2e/b."))!;
  expect(b).toMatchObject({ kind: "flaky", failed: 2, ran: 4, after: ["test/e2e/a.spec.ts"] });
  expect(rows.filter((r) => r.kind === "passes")).toHaveLength(2);
  const text = report(rows, 4);
  expect(text).toContain("| test/e2e/b.spec.ts:1 › b works | FAIL | pass | FAIL | pass | flaky: failed 2 of 4; only after test/e2e/a.spec.ts |");
  expect(text.split("\n").at(-1)).toBe("3 tests in 4 runs: 2 passed every time, 0 failed every time, 1 flaky, 0 skipped every time.");
});
