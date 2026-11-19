import { expect, test } from "bun:test";
import { prChecksVerdict } from "./waits.ts";

const run = (name: string, status: string, conclusion = "") => ({ __typename: "CheckRun", name, status, conclusion });
const ctx = (context: string, state: string) => ({ __typename: "StatusContext", context, state });

test("a pull request's checks decide the wait the way gh reports them", () => {
  // Any check still running, or a status still pending, keeps it waiting.
  expect(prChecksVerdict({ state: "OPEN", statusCheckRollup: [run("lint", "COMPLETED", "SUCCESS"), run("build", "IN_PROGRESS")] }, "o/r", 7, true)).toBeUndefined();
  expect(prChecksVerdict({ state: "OPEN", statusCheckRollup: [ctx("ci/legacy", "PENDING")] }, "o/r", 7, true)).toBeUndefined();
  // Done: passed, skipped and failed counted, the failed ones named.
  expect(prChecksVerdict({ state: "OPEN", statusCheckRollup: [run("lint", "COMPLETED", "SUCCESS"), run("docs", "COMPLETED", "SKIPPED"), run("build", "COMPLETED", "FAILURE"), ctx("ci/legacy", "ERROR")] }, "o/r", 7, false))
    .toBe("PR #7 in o/r checks completed: 1 passed, 2 failed, 1 skipped (failed: build, ci/legacy).");
  // Merged or closed fires at once; no checks fires only after the grace.
  expect(prChecksVerdict({ state: "MERGED", statusCheckRollup: [run("build", "QUEUED")] }, "o/r", 7, false)).toBe("PR #7 in o/r is MERGED.");
  expect(prChecksVerdict({ state: "OPEN", statusCheckRollup: [] }, "o/r", 7, false)).toBeUndefined();
  expect(prChecksVerdict({ state: "OPEN", statusCheckRollup: [] }, "o/r", 7, true)).toBe("PR #7 in o/r has no checks.");
});
