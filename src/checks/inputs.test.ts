import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputsOf } from "./ledger.ts";

// A check's inputs: what it reads beside the tree. A worktree's node_modules is often a link to
// another checkout's; `node_modules/../bun.lock` is then that checkout's lock file, as the kernel reads it.
test("an input is read through its links, and changes with a file in a folder it names", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-inputs-"));
  const shared = join(root, "shared"), wt = join(root, "wt");
  mkdirSync(join(shared, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(shared, "bun.lock"), "one\n");
  mkdirSync(wt);
  writeFileSync(join(wt, "bun.lock"), "the worktree's own\n");
  symlinkSync(join(shared, "node_modules"), join(wt, "node_modules"));
  const ins = ["node_modules", "node_modules/../bun.lock"];
  // The worktree and the checkout its link points into read the same inputs.
  expect(inputsOf(wt, ins)).toBe(inputsOf(shared, ins)!);
  const before = inputsOf(wt, ins);
  writeFileSync(join(shared, "bun.lock"), "two, longer\n");
  expect(inputsOf(wt, ins)).not.toBe(before!);
  // A file in a named folder (one level).
  const mid = inputsOf(wt, ["node_modules"]);
  writeFileSync(join(shared, "node_modules", "new.txt"), "x");
  expect(inputsOf(wt, ["node_modules"])).not.toBe(mid!);
  expect(inputsOf(wt, [])).toBeUndefined();
  expect(inputsOf(wt, ["gone"])).toBe(inputsOf(wt, ["gone"])!);
});
