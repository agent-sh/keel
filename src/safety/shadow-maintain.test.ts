// A maintenance pass of a checkpoint store does only what the store needs: nothing for one that did not
// change, an incremental pack for new objects (the old pack stays as it is), a full rewrite only when a
// tree was let go and its space is wanted.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `shadow-maint-${process.pid}`);
ownEnv({ KEEL_CHECKPOINT_FILE_MB: undefined, KEEL_CHECKPOINT_SNAPSHOT_MB: undefined });
const { Shadow } = await import("./shadow.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function setup() {
  const ws = join(root, `ws-${++n}`);
  mkdirSync(ws, { recursive: true });
  const sh = new Shadow(join(root, `state-${n}`, "checkpoints"), ws);
  const calls: string[] = [];
  const git = sh.git.bind(sh);
  sh.git = (args, o) => { calls.push(args[0] === "-c" ? args[2]! : args[0]!); return git(args, o); };
  const snap = async (name: string, text: string) => { writeFileSync(join(ws, name), text); return sh.snapshot(); };
  const packs = () => readdirSync(join(sh.dir, "objects", "pack")).filter((f) => f.endsWith(".pack")).sort();
  return { sh, ws, calls, snap, packs };
}
const upkeep = (calls: string[]) => calls.filter((c) => c === "gc" || c === "repack");

test("a store that did not change since its last pass runs no gc and no repack", async () => {
  const t = setup();
  const a = await t.snap("a.txt", "one\n");
  expect(await t.sh.maintain(new Map([["a", a]]))).toBe("packed");
  const before = t.packs();
  t.calls.length = 0;
  expect(await t.sh.maintain(new Map([["a", a]]))).toBe("skipped");
  expect(await t.sh.maintain(new Map([["a", a]]))).toBe("skipped");
  expect(upkeep(t.calls)).toEqual([]);
  expect(t.calls).not.toContain("update-ref");
  expect(t.packs()).toEqual(before);
});

test("new objects are packed beside the old pack, which is not rewritten", async () => {
  const t = setup();
  const a = await t.snap("a.txt", "one\n".repeat(2000));
  await t.sh.maintain(new Map([["a", a]]));
  const [old] = t.packs();
  const ino = statSync(join(t.sh.dir, "objects", "pack", old!)).ino;
  const b = await t.snap("b.txt", "two\n".repeat(2000));
  t.calls.length = 0;
  expect(await t.sh.maintain(new Map([["a", a], ["b", b]]))).toBe("packed");
  expect(upkeep(t.calls)).toEqual(["repack"]);
  expect(t.packs()).toContain(old!);
  expect(statSync(join(t.sh.dir, "objects", "pack", old!)).ino).toBe(ino);
  const refs = (await t.sh.git(["for-each-ref", "--format=%(refname)", "refs/keel/cp/"])).trim().split("\n");
  expect(refs).toEqual(["refs/keel/cp/a", "refs/keel/cp/b"]);
  expect(await t.sh.maintain(new Map([["a", a], ["b", b]]))).toBe("skipped");
});

test("a tree let go waits for a full pass until the root asks for space or the last full pass is old", async () => {
  const t = setup();
  const a = await t.snap("a.txt", "one\n");
  const b = await t.snap("b.txt", "two\n");
  await t.sh.maintain(new Map([["a", a], ["b", b]]));
  // Let b go: the refs change, and the full pass is held back (the store was packed moments ago).
  t.calls.length = 0;
  expect(await t.sh.maintain(new Map([["a", a]]))).toBe("skipped");
  expect(upkeep(t.calls)).toEqual([]);
  expect((await t.sh.git(["for-each-ref", "--format=%(refname)", "refs/keel/cp/"])).trim()).toBe("refs/keel/cp/a");
  // Still owed: asking for space runs it, once.
  expect(await t.sh.maintain(new Map([["a", a]]), true)).toBe("full");
  expect(upkeep(t.calls)).toEqual(["gc"]);
  t.calls.length = 0;
  expect(await t.sh.maintain(new Map([["a", a]]), true)).toBe("skipped");
  expect(upkeep(t.calls)).toEqual([]);
});
