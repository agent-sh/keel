import { expect, test } from "bun:test";
import { bounded } from "./health.ts";

test("a check that runs long or fails is a row of its own, and the others still answer", async () => {
  const slow = await bounded("providers", "providers", 30, () => new Promise<never>(() => {}));
  expect(slow).toMatchObject([{ group: "providers", level: "warning", title: "the providers check did not finish in 0 s" }]);
  const failed = await bounded("hooks", "hooks", 1000, () => { throw new Error("EACCES: no"); });
  expect(failed).toMatchObject([{ group: "hooks", level: "warning", title: "the hooks check failed", detail: "EACCES: no" }]);
  const fine = await bounded("disk", "disk", 1000, () => [{ id: "d", group: "disk", level: "ok", title: "ok" }]);
  expect(fine.map((r) => r.id)).toEqual(["d"]);
});
