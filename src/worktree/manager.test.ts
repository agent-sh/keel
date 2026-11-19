import { expect, test } from "bun:test";
import { summarizeChecks } from "./manager.ts";

test("pull request checks in a few words", () => {
  expect(summarizeChecks([]).summary).toBe("none");
  expect(summarizeChecks([{ name: "a", conclusion: "SUCCESS" }, { name: "b", conclusion: "CANCELLED" }]).summary).toBe("passing");
  expect(summarizeChecks([{ name: "a", conclusion: "SUCCESS" }, { name: "b", status: "IN_PROGRESS" }]).summary).toBe("pending");
  const r = summarizeChecks([{ name: "a", conclusion: "FAILURE" }, { context: "ci/x", state: "PENDING" }]);
  expect(r.summary).toBe("failing");
  expect(r.rows.map((x) => x.status)).toEqual(["failed", "pending"]);
});
