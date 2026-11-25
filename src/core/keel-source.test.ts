import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKeelCheckout, keelRepo } from "./keel-source.ts";

const root = mkdtempSync(join(tmpdir(), "keel-source-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const checkout = (name: string) => {
  const d = join(root, name);
  mkdirSync(join(d, "src", "engine"), { recursive: true });
  mkdirSync(join(d, ".git"));
  writeFileSync(join(d, "package.json"), "{}");
  writeFileSync(join(d, "src", "engine", "turn.ts"), "");
  return d;
};
const dir = (r: ReturnType<typeof keelRepo>) => ("repo" in r ? [r.repo.from, r.repo.dir] : r.problem);

test("a checkout is the folder with its package, its engine and its own .git", () => {
  const d = checkout("a");
  expect(isKeelCheckout(d)).toBe(true);
  rmSync(join(d, ".git"), { recursive: true });
  expect(isKeelCheckout(d)).toBe(false);
  expect(isKeelCheckout(join(root, "none"))).toBe(false);
});

test("the daemon's own checkout comes first, then the owner's folder, then the one the build was made from", () => {
  const stamp = checkout("stamp");
  const set = checkout("set");
  expect(dir(keelRepo({ running: "/src", stamp, setting: set }))).toEqual(["running", "/src"]);
  expect(dir(keelRepo({ stamp, setting: set }))).toEqual(["setting", set]);
  expect(dir(keelRepo({ stamp, setting: null }))).toEqual(["build", stamp]);
  expect(dir(keelRepo({ stamp, setting: join(root, "gone") }))).toEqual(["build", stamp]);
});

test("a binary whose build folder is gone says which folder is missing and where to set it", () => {
  const gone = join(root, "gone");
  const r = dir(keelRepo({ stamp: gone, setting: null })) as string;
  expect(r).toContain(`the folder this build was made from (${gone}) is gone`);
  expect(r).not.toContain("helper.keel_repo (");
  expect(r).toContain("Settings > Helper");
  const both = dir(keelRepo({ stamp: gone, setting: join(root, "also") })) as string;
  expect(both).toContain(`helper.keel_repo (${join(root, "also")}) is not a Keel source checkout`);
  expect(both).toContain(`(${gone}) is gone`);
  expect(dir(keelRepo({ setting: null }))).toContain("does not say which folder it was made from");
});
