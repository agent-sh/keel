// The run's last lines: how many tests passed, failed and were skipped, and why
// the skipped ones were, counted by reason. A skipped test is not a passed one:
// a run that says "passed" alone hides the tests that did not run. The list
// reporter above it names each test; this names what the run as a whole
// covered. A reason reads "what is needed: the detail" (shots.ts, the specs'
// own probes); the count is by what is needed, and the tests are named under it.
import type { FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";

const where = (t: TestCase) => `${t.location.file.replace(/^.*\/test\/e2e\//, "test/e2e/")}:${t.location.line}`;
// Why a test was skipped: the reason its probe gave, else that it gave none.
export function reasonOf(t: Pick<TestCase, "annotations" | "results">): string {
  const notes = [...t.annotations, ...t.results.flatMap((r) => (r as { annotations?: TestCase["annotations"] }).annotations ?? [])];
  return notes.find((a) => (a.type === "skip" || a.type === "fixme") && a.description)?.description ?? "no reason given";
}
// "needs a real model: it has to write a plan" is counted under "needs a real model".
export const needOf = (reason: string) => reason.split(": ")[0]!;

export default class Summary implements Reporter {
  private root?: Suite;
  onBegin(_config: unknown, suite: Suite) { this.root = suite; }
  printsToStdio() { return false; }
  onEnd(result: FullResult) {
    const tests = this.root?.allTests() ?? [];
    const count = { passed: 0, failed: 0, flaky: 0, skipped: 0, "not run": 0 };
    const skipped = new Map<string, TestCase[]>();
    for (const t of tests) {
      const o = t.outcome();
      if (!t.results.length) count["not run"]++;
      else if (o === "skipped") { count.skipped++; const need = needOf(reasonOf(t)); skipped.set(need, [...(skipped.get(need) ?? []), t]); }
      else count[o === "expected" ? "passed" : o === "flaky" ? "flaky" : "failed"]++;
    }
    const parts = [`${count.passed} passed`, `${count.failed} failed`, ...(count.flaky ? [`${count.flaky} passed on a retry`] : []), ...(count["not run"] ? [`${count["not run"]} not run`] : [])];
    const reasons = [...skipped].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    // The tests first, the one line last: it is what the end of a log shows.
    console.log("");
    for (const [need, ts] of reasons) {
      console.log(`  skipped, ${need} (${ts.length}):`);
      for (const t of ts) { const r = reasonOf(t); console.log(`    ${where(t)} ${t.title}${r === need ? "" : ` [${r.slice(need.length + 2)}]`}`); }
    }
    console.log(`Summary: ${parts.join(", ")}, ${count.skipped} skipped${reasons.length ? ` (${reasons.map(([need, ts]) => `${ts.length} ${need}`).join("; ")})` : ""}${result.status === "interrupted" ? "; the run was interrupted" : ""}.`);
  }
}
