import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A size written in KB by hand (`${n / 1024} KB`) said a 16-byte file was "0.0 KB" or "16 B" in one
// place and "16 bytes" in another: every file size in the page goes through fmtSize (utils.ts),
// which phone-attach.spec checks on the page.
test("no component writes a size in KB of its own", () => {
  const root = join(import.meta.dir, "..");
  const bad: string[] = [];
  for (const f of new Glob("**/*.{ts,tsx}").scanSync(root)) {
    if (f.endsWith(".test.ts") || f === join("lib", "utils.ts")) continue;
    readFileSync(join(root, f), "utf8").split("\n").forEach((l, i) => {
      if (/\}\s?KB\b/.test(l)) bad.push(`${f}:${i + 1}`);
    });
  }
  expect(bad).toEqual([]);
});
