import { expect, test } from "bun:test";
import { wantsWorktree } from "./agents.ts";

test("an agent in a mode that writes nothing gets no worktree", () => {
  expect(wantsWorktree({}, {}, "ask")).toBe(true);
  expect(wantsWorktree({}, {}, "read-only")).toBe(false);
  expect(wantsWorktree({}, { isolation: "worktree" }, "plan")).toBe(false);
  expect(wantsWorktree({ readOnly: true }, {}, "full-auto")).toBe(false);
  expect(wantsWorktree({}, { isolation: "none" }, "full-auto")).toBe(false);
});
