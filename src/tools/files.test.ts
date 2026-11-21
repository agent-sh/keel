import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTools } from "./claude.ts";
import { applyEdit, editFile, globFiles, lineRange, readFile } from "./files.ts";
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

// A range of a file too large to read whole: the rows asked for, by the same
// 1-based offsets and in the file's encoding, without reading what lies after
// them (the bytes this process read say so) and with a scan that can be stopped.
test("a ranged read of a large file reads up to its page and no further, and can be stopped", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "range-"));
  const p = join(dir, "big.txt");
  const N = 400_000;
  writeFileSync(p, Array.from({ length: N }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n") + "\n");
  const size = statSync(p).size;
  const ctx: any = { cwd: dir, seen: new Map(), signal: new AbortController().signal };
  // Bytes read by this process (Linux): what a read took from the disk.
  const rchar = () => (existsSync("/proc/self/io") ? Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))![1]) : 0);
  const reading = async <T>(f: () => Promise<T>) => { const before = rchar(); const r = await f(); return { r, read: rchar() - before }; };

  const head = await reading(() => readFile(p, ctx, { offset: 3, limit: 2 }));
  expect(head.r.content).toBe(`3\tline 2 ${"x".repeat(60)}\n4\tline 3 ${"x".repeat(60)}`);
  expect(head.read).toBeLessThan(1024 * 1024);
  expect((await lineRange(p, { offset: 3, limit: 2 })).bytes).toBeLessThanOrEqual(64 * 1024);
  // The default first page: cut by its size, it says where to go on without counting the file's lines.
  const page = await reading(() => readFile(p, ctx, { limit: 2000 }));
  expect(page.r.partial).toBe(true);
  expect(String(page.r.content)).toMatch(/\n\nPARTIAL view: lines 1-(\d+)\. Continue with offset \d+\.$/);
  expect(page.read).toBeLessThan(1024 * 1024);
  // A range in the middle reads up to it, not the half after it.
  const mid = await reading(() => readFile(p, ctx, { offset: N / 2 + 1, limit: 1 }));
  expect(mid.r.content).toBe(`${N / 2 + 1}\tline ${N / 2} ${"x".repeat(60)}`);
  if (mid.read) expect(mid.read).toBeLessThan(size * 0.6);
  // The file's end: its last lines whole, and an offset past it named with the line count.
  expect((await readFile(p, ctx, { offset: N - 1 })).content).toBe(`${N - 1}\tline ${N - 2} ${"x".repeat(60)}\n${N}\tline ${N - 1} ${"x".repeat(60)}`);
  expect((await readFile(p, ctx, { offset: N + 5, limit: 1 })).content).toBe(`${p} has ${N} lines; offset ${N + 5} is past the end.`);
  // Stopped on its way to a far offset: the scan ends there.
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 0);
  const cut = await reading(() => readFile(p, { ...ctx, signal: stop.signal }, { offset: N, limit: 1 }));
  expect(cut.r).toEqual({ content: `The read of ${p} was stopped before it reached line ${N}.`, error: true });
  if (cut.read) expect(cut.read).toBeLessThan(size / 2);

  // UTF-16 by its mark, one very long line cut to what is shown, a last line with no line end.
  const wide = join(dir, "wide.txt");
  const rows = ["Status: מוכן 🌍", "y".repeat(300_000), "last"];
  writeFileSync(wide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows.join("\n"), "utf16le")]));
  expect((await readFile(wide, ctx, { limit: 1 })).content).toBe(`1\t${rows[0]}`);
  expect((await readFile(wide, ctx, { offset: 2 })).content).toBe(`2\t${"y".repeat(2000)} [line cut at 2000 of 300000 chars]\n3\tlast`);
  const g = geminiTools.find((t) => t.name === "read_file")!;
  expect((await g.run({ file_path: p, start_line: 3, end_line: 4 }, ctx)).content).toBe(`line 2 ${"x".repeat(60)}\nline 3 ${"x".repeat(60)}`);
  rmSync(dir, { recursive: true, force: true });
}, 60_000);
