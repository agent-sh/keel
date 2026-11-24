import { expect, test } from "bun:test";
import { callTopics } from "./memory-yield.ts";
import { denyPrefixes, stoppable } from "./deny-keys.ts";

test("a call waits for the store only when its command starts with the words of a key the store can stop", () => {
  const file = { facts: [{ key: ["gh", "pr", "merge"] }, { key: ["git", "fetch", "--all"] }, { key: ["rm", "-rf"] }, { key: ["git", "stash"] }, { key: [] }, { nokey: 1 }] };
  const keys = denyPrefixes(file);
  expect(keys.sort()).toEqual(["gh pr merge", "git fetch", "git stash", "rm"]);
  const waits = (command: string) => stoppable(callTopics({ tool_name: "Bash", tool_input: { command } }), keys);
  expect(waits("gh pr merge 12 --squash")).toBe(true);
  expect(waits("cd x && sudo git stash pop")).toBe(true);
  expect(waits("rm -rf build")).toBe(true);
  expect(waits("gh pr view 12")).toBe(false);
  expect(waits("git status")).toBe(false);
  expect(waits("ls git-stash")).toBe(false);
  expect(denyPrefixes("not a table")).toEqual([]);
});
