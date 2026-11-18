import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdit } from "./files.ts";
import { notFound, similar } from "./missing.ts";

test("an edit whose lines differ only in trailing whitespace applies once", () => {
  const file = "a\n  b  \nc\n";
  const r = applyEdit(file, "  b\nc\n", "  B\nC\n");
  expect(r).toEqual({ text: "a\n  B\nC\n", count: 1, note: "matched ignoring trailing whitespace" });
  expect("error" in applyEdit("x  \ny\nx \ny\n", "x\ny\n", "z\n")).toBe(true);   // two loose places: refused
});

test("a missed edit names the closest lines and the first difference", () => {
  const file = ["one", "function f() {", "  return 1;", "}", "two"].join("\n");
  const r = applyEdit(file, "function f() {\n  return 2;\n}", "x") as { error: string };
  expect(r.error).toContain("lines 2-4");
  expect(r.error).toContain("1 of 3 lines differ");
  expect(r.error).toContain('file:       "  return 1;"');
  expect((applyEdit(file, "nothing like it", "x") as { error: string }).error).toContain("No part of the file is close");
});

test("a missing file suggests near names, a moved root and the nearest folder", () => {
  expect(similar(["voice.svelte.ts", "voice.ts", "other.ts"], "voice.test.ts").sort()).toEqual(["voice.svelte.ts", "voice.ts"]);
  expect(similar(["config.toml"], "confg.toml")).toEqual(["config.toml"]);
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "miss-"));
  mkdirSync(join(root, "repo/src"), { recursive: true });
  writeFileSync(join(root, "repo/src/a.ts"), "");
  expect(notFound(join(root, "src/a.ts"), join(root, "repo"))).toContain(join(root, "repo/src/a.ts"));
  const gone = notFound(join(root, "repo/wt-1/src/a.ts"), root);
  expect(gone).toContain(`The folder ${join(root, "repo/wt-1")} does not exist. The nearest folder that does is ${join(root, "repo")}.`);
});
