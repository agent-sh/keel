import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTools } from "./claude.ts";
import { applyEdit, editFile, GLOB_SCAN_MAX, globFiles, lineRange, readFile } from "./files.ts";
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
  expect(String(page.r.content)).toMatch(/\n\nPARTIAL view: lines 1-(\d+), ending \d+% into the file's [\d.]+ (KB|MB)\. Continue with offset \d+\.$/);
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

// More matches than a result shows is ordinary truncation. A scan that stopped
// at its ceiling is something else: it never examined every match, so the
// result says files may be missing and that newest first holds only among
// the ones examined. The two are told apart.
test("a glob that reaches the scan ceiling says the scan was cut, unlike one that only shows fewer", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "ceil-"));
  const ctx = { cwd: root } as any;
  const claude = claudeTools.find((t) => t.name === "Glob")!, gemini = geminiTools.find((t) => t.name === "glob")!;
  const cut = `The scan stopped after ${GLOB_SCAN_MAX} matches, before it had examined them all`;
  try {
    mkdirSync(join(root, "few"));
    for (let i = 0; i < 250; i++) writeFileSync(join(root, "few", `f${i}.log`), "");
    // Shown fewer than found, every match examined: the ordinary note, no warning.
    const few = await globFiles("**/*.log", join(root, "few"), root) as any;
    expect([few.files.length, few.truncated, few.ceiling]).toEqual([100, true, undefined]);
    const c = String((await claude.run({ pattern: "**/*.log", path: join(root, "few") }, ctx)).content);
    expect(c).toEndWith("(Results are truncated. Consider using a more specific path or pattern.)");
    const g = String((await gemini.run({ pattern: "**/*.log", dir_path: join(root, "few") }, ctx)).content);
    expect(g).toStartWith(`Found 200+ file(s) matching "**/*.log" within ${join(root, "few")}, sorted by modification time (newest first):`);
    for (const text of [c, g]) expect(text).not.toContain("The scan stopped");

    // One match more than the ceiling: the scan was cut.
    mkdirSync(join(root, "many"));
    for (let i = 0; i <= GLOB_SCAN_MAX; i++) writeFileSync(join(root, "many", `m${i}.log`), "");
    const many = await globFiles("**/*.log", join(root, "many"), root) as any;
    expect([many.files.length, many.truncated]).toEqual([100, true]);
    expect(many.ceiling).toStartWith(cut);
    const cm = String((await claude.run({ pattern: "**/*.log", path: join(root, "many") }, ctx)).content);
    expect(cm).toContain(`${cut}: files that match may be missing here, and newest first holds only among the ${GLOB_SCAN_MAX} examined.`);
    expect(cm).not.toContain("Results are truncated");
    const gm = String((await gemini.run({ pattern: "**/*.log", dir_path: join(root, "many") }, ctx)).content);
    expect(gm).toStartWith(`Found 200+ file(s) matching "**/*.log" within ${join(root, "many")}, newest first among the matches examined:`);
    expect(gm).toContain(cut);
    // Exactly the ceiling: every match was examined, nothing was cut.
    rmSync(join(root, "many", "m0.log"));
    expect((await globFiles("**/*.log", join(root, "many"), root) as any).ceiling).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("a notebook cell with two images gives no empty text block between them", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "nb-"));
  try {
    const p = join(root, "plots.ipynb");
    writeFileSync(p, JSON.stringify({ cells: [{ cell_type: "code", source: "plot()", outputs: [{ data: { "image/png": "iVBORw0KGgo=" } }, { data: { "image/png": "iVBORw0KGgo=" } }] }] }));
    const blocks = (await readFile(p, { seen: new Map(), cwd: root } as any, {})).content as any[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image", "image"]);
    expect(blocks.every((b) => b.type !== "text" || b.text)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A read is the same read whichever path takes it: a file under the
// whole-file limit is read whole and cut, one over it is read in chunks. A
// limit below zero and a start past the end are the cases the two answered
// differently.
test("a negative limit and a start past the end read the same for a small file and a large one", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "parity-"));
  const row = (i: number) => `line ${i} ${"x".repeat(60)}`;
  const make = (name: string, n: number) => { const p = join(dir, name); writeFileSync(p, Array.from({ length: n }, (_, i) => row(i + 1)).join("\n") + "\n"); return { p, n }; };
  const small = make("small.txt", 200), large = make("large.txt", 6_000);
  expect(statSync(small.p).size).toBeLessThan(256 * 1024);
  expect(statSync(large.p).size).toBeGreaterThan(256 * 1024);
  const ctx: any = { cwd: dir, seen: new Map(), signal: new AbortController().signal };
  const g = geminiTools.find((t) => t.name === "read_file")!;
  for (const { p, n } of [small, large]) {
    const read = async (o: { offset?: number; limit?: number }) => { const r = await readFile(p, ctx, o); return [r.content, r.error ?? false]; };
    // A limit below zero asks for no lines: none come back, from any offset in the file.
    expect([p, await read({ offset: 5, limit: -1 })]).toEqual([p, ["", false]]);
    expect([p, await read({ offset: n, limit: -3 })]).toEqual([p, ["", false]]);
    // A start past the end is named with the line count, whatever the limit.
    for (const limit of [undefined, 1, -1]) expect([p, limit, await read({ offset: n + 1, limit })]).toEqual([p, limit, [`${p} has ${n} lines; offset ${n + 1} is past the end.`, true]]);
    // The last line is not past the end.
    expect([p, await read({ offset: n, limit: 1 })]).toEqual([p, [`${n}\t${row(n)}`, false]]);
    // The Gemini profile's read_file, by start and end line.
    const lines = async (input: Record<string, number>) => { const r = await g.run({ file_path: p, ...input }, ctx); return [r.content, r.is_error ?? false]; };
    expect([p, await lines({ start_line: n + 1 })]).toEqual([p, [`${p} has ${n} lines; line ${n + 1} is past the end.`, true]]);
    expect([p, await lines({ start_line: n + 4, end_line: n + 9 })]).toEqual([p, [`${p} has ${n} lines; line ${n + 4} is past the end.`, true]]);
    expect([p, await lines({ start_line: n, end_line: n + 9 })]).toEqual([p, [row(n), false]]);
    expect([p, await lines({ start_line: 9, end_line: 5 })]).toEqual([p, ["", false]]);
  }
  rmSync(dir, { recursive: true, force: true });
});
