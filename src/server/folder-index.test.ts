import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { folderIndex } from "./folder-index.ts";

// A session working in another folder changes which used folder is newest, not
// what the index walks: the walk is not made again for it.
test("the index is reused when only the order of the used folders or roots changed", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "folder-index-"));
  for (const d of ["a/one", "b/two"]) mkdirSync(join(dir, d), { recursive: true });
  const a = join(dir, "a"), b = join(dir, "b");
  const first = folderIndex([{ path: a, depth: 2 }, { path: b, depth: 2 }], [join(a, "one"), join(b, "two")]);
  const again = folderIndex([{ path: b, depth: 2 }, { path: a, depth: 2 }], [join(b, "two"), join(a, "one")]);
  expect(again).toBe(first);
  expect((await first).folders.map((f) => f.name).sort()).toEqual(["one", "two"]);
  // Another folder used is another index.
  const more = folderIndex([{ path: a, depth: 2 }, { path: b, depth: 2 }], [join(a, "one")]);
  expect(more).not.toBe(first);
  await more;
});
