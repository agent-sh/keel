import { expect, test } from "bun:test";
import { filterSaid } from "./seccomp.ts";

test("the filter's state is said only when the sandbox runs and the daemon reports it", () => {
  expect(filterSaid(undefined)).toBeUndefined();
  expect(filterSaid({ available: true })).toBeUndefined();
  expect(filterSaid({ available: false, seccomp: true })).toBeUndefined();
  expect(filterSaid({ available: true, seccomp: true })?.on).toBe(true);
  const off = filterSaid({ available: true, seccomp: false, seccompReason: "bwrap refused --seccomp" })!;
  expect(off.on).toBe(false);
  expect(off.words).toContain("bwrap refused --seccomp");
});
