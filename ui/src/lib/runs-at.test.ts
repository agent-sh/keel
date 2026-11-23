import { expect, test } from "bun:test";
import { runsAt } from "./runs-at.ts";

// The card's "in <folder>, branch <b>" names the agent's branch only where its command really runs in
// its worktree: a link inside it that leads out is away, and a card that is no command names no folder.
test("an approval names the asker's branch only for a command inside its worktree", () => {
  const where = { folder: "/w/agent", branch: "keel/x" };
  expect(runsAt({ cwd: "/w/agent/sub" }, where)).toEqual({ folder: "/w/agent/sub", branch: "keel/x" });
  expect(runsAt({ cwd: "/w/agent/link", away: true }, where)).toEqual({ folder: "/w/agent/link" });
  expect(runsAt({ cwd: "/w/parent", away: true }, where)).toEqual({ folder: "/w/parent" });
  expect(runsAt(undefined, where)).toEqual(where);
  expect(runsAt(undefined, where, false)).toBeNull();
});
