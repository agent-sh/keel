import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTopics } from "./memory-yield.ts";
import { DenyKeys, denyPrefixes, stoppable } from "./deny-keys.ts";

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

test("a scratch daemon on the owner's home reads none of his deny keys; a state folder given by the variable is read", () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? ".", "deny-home-"));
  const dir = join(home, ".local", "state", "tacit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "deny-keys.json"), JSON.stringify({ facts: [{ key: ["rm", "-rf"] }] }));
  const own = mkdtempSync(join(process.env.TMPDIR ?? ".", "deny-own-"));
  writeFileSync(join(own, "deny-keys.json"), JSON.stringify({ facts: [{ key: ["git", "stash"] }] }));
  const keysOf = () => new DenyKeys(0).get();
  const put = (to: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(to)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const names = ["HOME", "KEEL_ACCOUNT_HOME", "TACIT_STATE_DIR"];
  const before = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  try {
    put({ HOME: home, TACIT_STATE_DIR: undefined, KEEL_ACCOUNT_HOME: join(home, "elsewhere") });
    expect(keysOf()).toEqual(["rm"]); // the home is not the account's: a daemon that may read it
    put({ KEEL_ACCOUNT_HOME: home });
    expect(keysOf()).toEqual([]); // the account's own home under a scratch config folder: withheld
    put({ TACIT_STATE_DIR: own });
    expect(keysOf()).toEqual(["git stash"]); // its own state folder is always read
  } finally { put(before); }
});
