import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesWithAll } from "./inside.ts";

// A transcript removed between the index's listing and the search's read is a file that holds no word, not a
// failure of the search: ripgrep and grep say exit 2 for it, with nothing printed when no other file matched.
test("a file that is gone by the time it is read holds no match, and the files left are still read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-inside-"));
  try {
    const held = join(dir, "held.jsonl"), other = join(dir, "other.jsonl"), gone = join(dir, "gone.jsonl");
    writeFileSync(held, '{"text":"a needle here"}\n');
    writeFileSync(other, '{"text":"nothing"}\n');
    // Gone alone in its batch, and gone beside a file that matches and one that does not.
    expect(await filesWithAll(["needle"], [gone])).toEqual(new Set());
    expect(await filesWithAll(["needle"], [gone, other])).toEqual(new Set());
    expect(await filesWithAll(["needle"], [other, gone, held])).toEqual(new Set([held]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
