import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { importGraph, pageDigest, sourceApi } from "./api-stamp.ts";

// A tree of its own: the stamp hashes what the entry imports, and nothing a test, a doc or a page-only module holds.
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "api-stamp-"));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

test("the import graph is what the entry reaches: no test, doc, type-only or page-only file", () => {
  const root = tree({
    "src/main.ts": `#!/usr/bin/env bun\nimport { a } from "./a.ts";\nimport type { T } from "./types.ts";\nimport tools from "./tools.json";\nimport index from "../ui/index.html";\nconst x: T = a + tools.n;\nawait import("./late.ts");\n`,
    "src/a.ts": `export const a = 1;\nimport "../test/fixtures/data.json";\n`,
    "src/types.ts": "export type T = number;\n",
    "src/tools.json": `{"n":1}`,
    "src/late.ts": "export {};\n",
    "src/a.test.ts": `import { a } from "./a.ts";\n`,
    "src/page-only.ts": "export const p = 1;\n",
    "test/fixtures/data.json": "{}",
    "ui/index.html": "<html></html>",
    "README.md": "docs",
  });
  expect(importGraph(root, ["src/main.ts"])).toEqual(["src/a.ts", "src/late.ts", "src/main.ts", "src/tools.json", "test/fixtures/data.json"]);
});

test("the stamp moves with the graph's files and not with a test or a doc", () => {
  const root = tree({ "src/main.ts": `import "./a.ts";\n`, "src/a.ts": "export {};\n", "src/a.test.ts": "1", "src/orphan.ts": "1", "docs/x.md": "1" });
  const api = () => sourceApi(root, importGraph(root, ["src/main.ts"]));
  const before = api();
  writeFileSync(join(root, "src/a.test.ts"), "2");
  writeFileSync(join(root, "src/orphan.ts"), "2");
  writeFileSync(join(root, "docs/x.md"), "2");
  expect(api()).toBe(before);
  writeFileSync(join(root, "src/a.ts"), "export const b = 2;\n");
  expect(api()).not.toBe(before);
});

test("a page's digest is its files' names and bytes, in any order", () => {
  const b = (s: string) => new TextEncoder().encode(s);
  expect(pageDigest({ "a.js": b("1"), "index.html": b("2") })).toBe(pageDigest({ "index.html": b("2"), "a.js": b("1") }));
  expect(pageDigest({ "a.js": b("1"), "index.html": b("2") })).not.toBe(pageDigest({ "a.js": b("1"), "index.html": b("3") }));
  // The same page built in another folder: other chunk names, the same contents.
  const page = (x: string, y: string, body = "f()") => ({ [`chunk-${x}.js`]: b(`import "./chunk-${y}.js";${body}`), [`chunk-${y}.js`]: b("g()"), "index.html": b(`<script src="/_ui/chunk-${x}.js"></script>`) });
  expect(pageDigest(page("aaaa1111", "bbbb2222"))).toBe(pageDigest(page("dddd4444", "cccc3333")));
  expect(pageDigest(page("aaaa1111", "bbbb2222"))).not.toBe(pageDigest(page("dddd4444", "cccc3333", "h()")));
});
