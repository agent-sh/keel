import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdit, editFile, readFile } from "./files.ts";
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

test("an edit keeps the file's line ends and byte-order mark; a read decodes UTF-16 by its mark", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "enc-"));
  const ctx = { seen: new Map(), cwd: root } as any;
  const crlf = "one\r\nold\r\nthree\r\n";
  for (const repl of ["new\nextra", "new\r\nextra"]) {
    const p = join(root, "crlf.txt");
    writeFileSync(p, crlf);
    expect("ok" in (await editFile(p, "old", repl, false, ctx))).toBe(true);
    expect(readFileSync(p, "latin1")).toBe("one\r\nnew\r\nextra\r\nthree\r\n");
  }
  const bom = join(root, "bom.txt");
  writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("a\r\nold\r\n")]));
  await editFile(bom, "old", "new", false, ctx);
  expect([...readFileSync(bom)]).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from("a\r\nnew\r\n")]);
  const plain = join(root, "plain.txt");
  writeFileSync(plain, "old\n");
  await editFile(plain, "old", "new", false, ctx);
  expect(readFileSync(plain, "latin1")).toBe("new\n");
  const line = "Status: מוכן 🌍";
  const le = join(root, "le.txt"), be = join(root, "be.txt");
  writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")]));
  writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(line, "utf16le").swap16()]));
  for (const p of [le, be]) expect((await readFile(p, ctx, {})).content).toBe(`1\t${line}`);
  expect("error" in (await editFile(le, "Status", "State", false, ctx))).toBe(true); // not written as UTF-8
});

test("a straight-quote edit takes the exact match first and never guesses between curly ones", () => {
  expect(applyEdit('say "old"\nsay “old”\n', 'say "old"', 'say "new"')).toEqual({ text: 'say "new"\nsay “old”\n', count: 1 });
  expect((applyEdit("say “old”\nsay “old”\n", 'say "old"', 'say "new"') as { error: string }).error).toContain("matches 2 places (lines 1, 2)");
  expect((applyEdit("say “old”\nsay “old”\n", 'say "old"', 'say "new"', true) as { text: string }).text).toBe("say “new”\nsay “new”\n");
});
