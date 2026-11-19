// Conventions that kept breaking across lanes, checked over the source tree.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : files(p, ext)) : ext.test(n) ? [p] : [];
  });
}
const offenders = (list: string[], bad: RegExp) => list.filter((f) => bad.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));

test("specs take test from isolate.ts, which restores daemon-wide settings", () => {
  expect(offenders(files(join(ROOT, "test/e2e"), /\.spec\.ts$/), /from "@playwright\/test"/)).toEqual([]);
});

test("child process pipes are read through src/core/proc.ts", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(".test.ts") && !f.endsWith("core/proc.ts"));
  expect(offenders(src, /new Response\([\w.!]*\.std(out|err)\b|for await \([^)]*\.std(out|err)\b/)).toEqual([]);
});

test("path containment is contains(root, p) from src/core/paths.ts", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith("core/paths.ts"));
  expect(offenders(src, /(const|function) inside\b/)).toEqual([]);
});
