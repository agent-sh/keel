import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTools } from "./claude.ts";
import { applyEdit, editFile, globFiles, readFile } from "./files.ts";
import { geminiTools } from "./gemini.ts";
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

// Claude Code's allow_large: a read past one page and the whole-file limit,
// sized to the context the model has left.
test("a large read fills the room left in the context, not one page", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "large-"));
  const p = join(dir, "big.txt");
  writeFileSync(p, Array.from({ length: 20_000 }, (_, i) => `line ${i} ${"x".repeat(5)}`).join("\n"));
  const ctx: any = { cwd: dir, seen: new Map(), room: 200_000 };
  expect((await readFile(p, ctx)).error).toBe(true); // over 256 KB: refused whole
  const r = await readFile(p, ctx, { large: true });
  expect(r.partial).toBeFalsy();
  expect(String(r.content)).toContain("20000\tline 19999");
  expect((await readFile(p, { ...ctx, room: 20_000 }, { large: true })).error).toBe(true); // more than the room
});

test("a glob in a folder that is not there says where to look, and one stopped part-way says so", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "glob-"));
  mkdirSync(join(root, "crate/src"), { recursive: true });
  writeFileSync(join(root, "crate/src/lib.rs"), "");
  const ctx = { cwd: root } as any;
  for (const [tool, dir] of [[geminiTools.find((t) => t.name === "glob")!, "dir_path"], [claudeTools.find((t) => t.name === "Glob")!, "path"]] as const) {
    const gone = await tool.run({ pattern: "**/*.rs", [dir]: join(root, "crate/tests") }, ctx);
    expect(gone.is_error).toBe(true);
    expect(gone.content).toStartWith(`Directory does not exist: ${join(root, "crate/tests")}`);
    const file = await tool.run({ pattern: "**/*.rs", [dir]: join(root, "crate/src/lib.rs") }, ctx);
    expect(file.content).toBe(`${join(root, "crate/src/lib.rs")} is a file, not a directory. Search in ${join(root, "crate/src")}.`);
    const found = await tool.run({ pattern: "**/*.rs", [dir]: join(root, "crate") }, ctx);
    expect(found.is_error).toBeFalsy();
    expect(found.content).toContain(join(root, "crate/src/lib.rs"));
  }
  expect(notFound(join(root, "crate/srcs"), root, "Directory")).toContain(join(root, "crate/src"));
  mkdirSync(join(root, "crate/locked"));
  chmodSync(join(root, "crate/locked"), 0o000);
  const part = await globFiles("**/*.rs", join(root, "crate"), root);
  chmodSync(join(root, "crate/locked"), 0o755);
  if (process.getuid?.() !== 0) expect("stopped" in part && part.stopped).toContain("EACCES");
});
