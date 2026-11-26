import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { bindLedger, holdCheckCache, objectsOf, repoOf, treeOf, unbindLedger } from "./ledger.ts";
import { cacheId, pruneCheckFiles } from "./retention.ts";

const DAY = 86400_000;
const age = (file: string) => utimesSync(file, new Date(), new Date(Date.now() - 8 * DAY));

test("the check cache drops looks for gone git dirs, not live ones", async () => {
  const root = tempTree("check-retention-");
  const store = new Store(join(root, "state"));
  const capture = async (name: string) => {
    const top = join(root, name);
    mkdirSync(top);
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: top }).exitCode).toBe(0);
    const repo = repoOf(top)!;
    writeFileSync(join(top, "one"), name);
    const tree = (await treeOf(repo))?.tree;
    expect(tree).toMatch(/^[a-f0-9]{40,64}$/);
    const objects = objectsOf(repo)!;
    const index = objects.replace(/objects-([a-f0-9]+)$/, "index-$1");
    return { repo, tree, objects, index, files: [objects, `${objects}.bytes`, index] };
  };
  try {
    await bindLedger(store);
    const gone = await capture("gone");
    const live = await capture("live");
    const legacy = gone.objects.replace(/[a-f0-9]{20}$/, "a".repeat(20));
    mkdirSync(legacy);
    age(legacy);
    for (const file of live.files) age(file); // age by itself does not expire a live worktree
    rmSync(gone.repo.gitDir, { recursive: true });
    const release = holdCheckCache(gone.repo);
    try {
      await bindLedger(store);
      expect(gone.files.map(existsSync)).toEqual([true, true, true]);
    } finally { release(); }
    await bindLedger(store);
    expect(gone.files.map(existsSync)).toEqual([false, false, false]);
    expect(existsSync(legacy)).toBe(false);
    expect(live.files.map(existsSync)).toEqual([true, true, true]);
    expect((await treeOf(live.repo))?.tree).toBe(live.tree);
  } finally { unbindLedger(); store.db.close(); }
});

test("check-file retention keeps recent beside logs and ignores unrelated files", async () => {
  const root = tempTree("beside-log-retention-");
  const store = new Store(join(root, "state"));
  const logs = join(store.stateDir, "checks", "beside-logs");
  mkdirSync(logs, { recursive: true });
  const old = join(logs, "0123456789abcdef-unit-1.log");
  const recent = join(logs, "0123456789abcdef-unit-2.log");
  const other = join(logs, "note.txt");
  for (const file of [old, recent, other]) writeFileSync(file, "output");
  age(old);
  age(other);
  try {
    await bindLedger(store);
    expect([old, recent, other].map(existsSync)).toEqual([false, true, true]);
  } finally { unbindLedger(); store.db.close(); }
});

test("the sweep bounds each slice and resumes both directory cursors", async () => {
  const dir = tempTree("check-retention-slices-");
  const logs = join(dir, "beside-logs");
  mkdirSync(logs);
  const perSlice = 64;
  const each = 2 * perSlice + 5;
  for (let i = 0; i < each; i++) {
    const cache = join(dir, `objects-${i.toString(16).padStart(20, "0")}`);
    mkdirSync(cache);
    age(cache);
    const log = join(logs, `0123456789abcdef-unit-${i}.log`);
    writeFileSync(log, "output");
    age(log);
  }
  const remaining = () => [readdirSync(dir).length - 1, readdirSync(logs).length] as const;
  const slices: (readonly [number, number])[] = [];
  await pruneCheckFiles(dir, new AbortController().signal, (_, sweep) => sweep(), async (examined: number) => {
    expect(examined).toBe(perSlice);
    slices.push(remaining());
  });
  expect(slices.length).toBeGreaterThan(1);
  let previous: readonly number[] = [each, each];
  for (const slice of slices) {
    const removed = previous[0]! + previous[1]! - slice[0] - slice[1];
    expect(removed).toBeLessThanOrEqual(perSlice);
    previous = slice;
  }
  // Both cursors made progress before the first yield and had work left.
  expect(slices[0]!.every((n) => n > 0 && n < each)).toBe(true);
  expect(remaining()).toEqual([0, 0]);

  // A single cache can contain more files than one slice can remove.
  const gitDir = join(dir, "gone", ".git");
  const id = cacheId(gitDir);
  const blobs = join(dir, `objects-${id}`, "ab");
  const marker = join(dir, `index-${id}.gitdir`);
  symlinkSync(gitDir, marker);
  mkdirSync(blobs, { recursive: true });
  for (let i = 0; i < each; i++) writeFileSync(join(blobs, String(i)), "blob");
  const stop = new AbortController();
  let left = each;
  await pruneCheckFiles(dir, stop.signal, (_, sweep) => sweep(), async (examined) => {
    expect(examined).toBe(perSlice);
    left = readdirSync(blobs).length;
    stop.abort();
  });
  expect(each - left).toBeGreaterThan(0);
  expect(each - left).toBeLessThanOrEqual(perSlice);
  // After interruption the marker still identifies the partly removed cache.
  await pruneCheckFiles(dir, new AbortController().signal, (_, sweep) => sweep());
  expect(readdirSync(dir)).toEqual(["beside-logs"]);
});
