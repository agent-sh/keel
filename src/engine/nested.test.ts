// The prompt's chain a call's nested files are told against is kept while its files are unchanged.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { chainOf } from "./nested.ts";

test("the chain is read again only when one of its files changed", () => {
  const dir = tempTree("nested-chain-");
  const cwd = join(dir, "repo");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "AGENTS.md"), "rules\n");
  const a = chainOf(cwd);
  expect(a.paths).toContain(join(cwd, "AGENTS.md"));
  expect(chainOf(cwd)).toBe(a);
  // A new file of the chain is a change: the chain is read again and holds it.
  writeFileSync(join(cwd, "CLAUDE.md"), "more rules\n");
  const b = chainOf(cwd);
  expect(b).not.toBe(a);
  expect(b.paths).toContain(join(cwd, "CLAUDE.md"));
});
