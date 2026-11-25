// A file read through a reader (src/tools/reading.ts): which reads go to the
// reader for each family and which stay the file itself, what a reading lets an
// edit change, the fallback when no reading comes back, and the urgent marks.
// A stand-in takes the reader's place.
import { afterAll, afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolMarks } from "../core/build.ts";
import { emptyUsage } from "../core/types.ts";
import { chunkMaterial } from "../engine/reader.ts";
import { claudeTools } from "./claude.ts";
import { FLOOR } from "./carry.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { stopJob, jobsOf } from "./jobs.ts";
import { expandReading, knownOf, merge, missing, pageOf, READER_REST_MS, rebase, touched } from "./reading.ts";
import type { Tool, ToolContext } from "./types.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "reading-"));
afterAll(async () => { for (const j of jobsOf("reading-test")) await stopJob(j); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { setSystemTime(); delete process.env.KEEL_READ_WAIT_MS; });

const tool = (list: Tool[], name: string) => list.find((t) => t.name === name)!;
const Read = tool(claudeTools, "Read"), Edit = tool(claudeTools, "Edit"), Write = tool(claudeTools, "Write"), Bash = tool(claudeTools, "Bash");
const read_file = tool(geminiTools, "read_file"), replace = tool(geminiTools, "replace");
const exec_command = tool(gptTools, "exec_command"), apply_patch = tool(gptTools, "apply_patch");
const text = (o: { content: unknown }) => (typeof o.content === "string" ? o.content : JSON.stringify(o.content));

// A text file over the carry floor: 600 lines, each its own.
const line = (n: number) => `const v${n} = ${n}; // the value of line ${n}`;
const LONG = Array.from({ length: 600 }, (_, i) => line(i + 1)).join("\n") + "\n";
let files = 0;
const file = (content = LONG, name = `long-${++files}.ts`) => { const p = join(dir, name); writeFileSync(p, content); return p; };

// A session's context with a stand-in reader: it marks `marks` and says what it was asked.
type Asked = { prompt: string; source: string; first: number; lines: number; own: boolean | undefined };
function rig(o: { marks?: string; answer?: (asked: Asked) => any; more?: Partial<ToolContext> } = {}) {
  const asked: Asked[] = [];
  const ctx: ToolContext = {
    sessionId: "reading-test", cwd: dir, signal: new AbortController().signal, spillDir: join(dir, "spill"), seen: new Map(),
    readMaterial: async (items, _question, _call, opts) => {
      const chunk = chunkMaterial(items, 1e9)[0]!;
      const a: Asked = { prompt: opts!.prompt!(chunk, 1, 1), source: items[0]!.source, first: items[0]!.first ?? 1, lines: items[0]!.text.split("\n").length, own: opts!.others };
      asked.push(a);
      const part = { k: 1, covers: a.source, chars: items[0]!.text.length, state: "read" as const, model: "Small" };
      if (o.answer) return o.answer(a);
      return { text: `A file of constants.\n- lines ${a.first}-${a.first + a.lines - 1}: one constant a line\n${o.marks ?? "@@ 120-122"}`, models: ["Small"], parts: [part], unread: [], chars: part.chars,
        usage: { ...emptyUsage(), input: 5_000, output: 60, cost: 0.002 }, cost: 0.002, compiled: false, working: { model: "Big", tokens: 5_000, cost: 0.03 } };
    },
    ...o.more,
  };
  return { ctx, asked };
}
const unread = (error: string) => () => ({ text: "", models: [], parts: [{ k: 1, covers: "x", chars: 1, state: "unread", error }], unread: ["x"], chars: 0, usage: emptyUsage(), compiled: false });

describe("which reads go to the reader", () => {
  test("Claude's Read: a long text file comes back as a reading with the file's own lines at the marks", async () => {
    const { ctx, asked } = rig();
    const p = file();
    const out = await Read.run({ file_path: p, for: "find where v120 is set" }, ctx);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ first: 1, lines: 600, own: true });
    expect(asked[0]!.prompt).toContain("Its aim for this read, in its own words: find where v120 is set");
    expect(asked[0]!.prompt).toContain(`600\t${line(600)}`);
    const said = text(out);
    expect(said).toStartWith(`[Compiled reading of ${p.slice(dir.length + 1)}, lines 1-600 of 600, by Small: not the file's text.`);
    expect(said).toContain("Read it with raw: true");
    expect(said).toContain(`120\t${line(120)}\n121\t${line(121)}\n122\t${line(122)}`);
    expect(said).not.toContain(line(300));
    expect(said.length).toBeLessThan(LONG.length / 10);
    expect(out.is_error).toBeFalsy();
    // What the savings ledger reads of it (src/admin/outcomes.ts).
    expect((out.shown as any).readers).toMatchObject({ read: true, models: ["Small"], cost: 0.002, working: { model: "Big" }, quoted: [{ from: 120, to: 122 }] });
  });

  test("with no aim stated the reader gets what the engine knows of the session's work", async () => {
    const { ctx, asked } = rig({ more: { aim: () => "Its task (shortened): fix the retry" } });
    await Read.run({ file_path: file() }, ctx);
    expect(asked[0]!.prompt).toContain("Its task (shortened): fix the retry");
    const bare = rig();
    await Read.run({ file_path: file() }, bare.ctx);
    expect(bare.asked[0]!.prompt).toContain("It stated no aim for this read");
  });

  test("the file itself: raw, allow_large, a short file, a short range, a program's read, a session set to read itself", async () => {
    const { ctx, asked } = rig();
    const p = file();
    expect(text(await Read.run({ file_path: p, raw: true }, ctx))).toContain(`300\t${line(300)}`);
    expect(text(await Read.run({ file_path: p, allow_large: true }, { ...ctx, room: 200_000 }))).toContain(`300\t${line(300)}`);
    const short = Array.from({ length: 100 }, (_, i) => line(i + 1)).join("\n");
    expect(short.length).toBeLessThan(FLOOR);
    expect(text(await Read.run({ file_path: file(short) }, ctx))).toBe(short.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n"));
    expect(text(await Read.run({ file_path: p, offset: 300, limit: 5 }, ctx))).toBe([300, 301, 302, 303, 304].map((n) => `${n}\t${line(n)}`).join("\n"));
    expect(text(await Read.run({ file_path: p }, { ...ctx, nestedIn: "program-1" }))).toContain(`300\t${line(300)}`);
    expect(text(await Read.run({ file_path: p }, { ...ctx, readThrough: false }))).toContain(`300\t${line(300)}`);
    expect(text(await Read.run({ file_path: p }, { ...ctx, readMaterial: undefined }))).toContain(`300\t${line(300)}`);
    expect(asked).toHaveLength(0);
    // A long range is a page like any other.
    expect(text(await Read.run({ file_path: p, offset: 100, limit: 400 }, ctx))).toStartWith("[Compiled reading of");
    expect(asked[0]).toMatchObject({ first: 100, lines: 400 });
  });

  test("the carry size decides what is short", async () => {
    const { ctx, asked } = rig({ more: { inline: { cap: 30_000, head: 0.25 } } });
    const p = file();
    expect(LONG.length).toBeLessThan(30_000);
    expect(text(await Read.run({ file_path: p }, ctx))).toContain(`300\t${line(300)}`);
    expect(asked).toHaveLength(0);
  });

  test("images, notebooks and binary files keep their path", async () => {
    const { ctx, asked } = rig();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
    const pic = join(dir, "dot.png");
    writeFileSync(pic, png);
    expect((await Read.run({ file_path: pic }, ctx)).content).toMatchObject([{ type: "image", media_type: "image/png" }]);
    const nb = file(JSON.stringify({ cells: Array.from({ length: 400 }, (_, i) => ({ cell_type: "code", id: `c${i}`, source: [line(i)], outputs: [] })) }), "book.ipynb");
    expect(text(await Read.run({ file_path: nb }, ctx))).toContain('<cell id="c399">');
    const zip = file("PK\u0003\u0004".repeat(5_000), "pack.zip");
    const refused = await Read.run({ file_path: zip }, ctx);
    expect(refused.is_error).toBe(true);
    expect(text(refused)).toContain("is a binary file (.zip)");
    expect(asked).toHaveLength(0);
  });

  test("no other model than the session's own to read with: the file, with nothing said", async () => {
    const { ctx, asked } = rig({ answer: () => ({ text: "", models: [], parts: [], unread: [], chars: 0, usage: emptyUsage(), compiled: false, none: true }) });
    const p = file();
    const out = text(await Read.run({ file_path: p }, ctx));
    expect(out).toStartWith(`1\t${line(1)}`);
    // (Asked each time: a listing can gain a reader.)
    await Read.run({ file_path: p }, ctx);
    expect(asked).toHaveLength(2);
  });

  test("a reading as long as the page is not worth it: the page", async () => {
    const { ctx } = rig({ marks: "@@ 1-600" });
    const short = Array.from({ length: 260 }, (_, i) => line(i + 1)).join("\n");
    const out = text(await Read.run({ file_path: file(`${short}\n`) }, rig({ answer: (a) => ({ text: `${"word ".repeat(1_800)}`, models: ["Small"], parts: [{ k: 1, covers: a.source, chars: 1, state: "read" }], unread: [], chars: 1, usage: emptyUsage(), compiled: false }) }).ctx));
    expect(out).toStartWith(`1\t${line(1)}`);
    // The marked lines are held to a quarter of the page.
    const held = text(await Read.run({ file_path: file() }, ctx));
    expect(held).toStartWith("[Compiled reading of");
    expect(held).toContain("are not shown here]");
    expect(held.length).toBeLessThan(LONG.length * 0.4);
  });

  test("Gemini's read_file: a reading by default with the numbers of the lines it shows, the content itself with raw", async () => {
    const { ctx, asked } = rig();
    const p = file();
    const out = text(await read_file.run({ file_path: p, for: "v120" }, ctx));
    expect(out).toStartWith("[Compiled reading of");
    expect(out).toContain("use read_file with raw: true");
    expect(out).toContain(`121\t${line(121)}`);
    expect(text(await read_file.run({ file_path: p, raw: true }, ctx))).toStartWith(`${line(1)}\n${line(2)}`);
    expect(text(await read_file.run({ file_path: p, start_line: 300, end_line: 302 }, ctx))).toBe([300, 301, 302].map(line).join("\n"));
    expect(asked).toHaveLength(1);
    // A long range, and the same with raw.
    const range = text(await read_file.run({ file_path: p, start_line: 100, end_line: 500 }, rig({ marks: "@@ 200-201" }).ctx));
    expect(range).toStartWith(`[Compiled reading of ${p.slice(dir.length + 1)}, lines 100-500 of 600`);
    expect(range).toContain(`200\t${line(200)}\n201\t${line(201)}`);
    expect(text(await read_file.run({ file_path: p, start_line: 100, end_line: 500, raw: true }, ctx))).toStartWith(`${line(100)}\n`);
  });

  test("the GPT family's shell returns the command's output: a cat of a long file is the file, and no reader is asked", async () => {
    const { ctx, asked } = rig();
    const p = file();
    const out = text(await exec_command.run({ cmd: `cat ${p}`, login: false, shell: "bash" }, ctx));
    expect(out).toContain("Process exited with code 0");
    expect(out).not.toContain("Compiled reading");
    expect(out).toContain(`${line(300)}\n${line(301)}`);
    expect(asked).toHaveLength(0);
    expect(knownOf(ctx, p)).toBeUndefined();
  }, 30_000);
});

describe("an edit after a reading", () => {
  test("the lines a reading showed are edited; other lines are refused once, with the read to make", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    expect(knownOf(ctx, p)).toMatchObject({ lines: [{ from: 120, to: 122 }], told: false });
    const ok = await Edit.run({ file_path: p, old_string: line(121), new_string: "const v121 = 0;" }, ctx);
    expect(ok.is_error).toBeFalsy();
    const edit = { file_path: p, old_string: line(300), new_string: "const v300 = 0;" };
    const no = await Edit.run(edit, ctx);
    expect(no.is_error).toBe(true);
    expect(text(no)).toBe(`Not applied: you have ${p} as a compiled reading, and line 300 that this edit changes is not among the lines it showed. ` +
      "Read them first (Read with raw: true, offset 300, limit 1), then send the edit again. If you have these lines exactly from another result, send the same edit again as it is: it is applied.");
    expect(readFileSync(p, "utf8")).toContain(line(300));
    // Sent again: applied. And nothing else of the file is refused after that.
    expect((await Edit.run(edit, ctx)).is_error).toBeFalsy();
    expect((await Edit.run({ file_path: p, old_string: line(400), new_string: "const v400 = 0;" }, ctx)).is_error).toBeFalsy();
    expect(readFileSync(p, "utf8")).toContain("const v121 = 0;\n");
    expect(readFileSync(p, "utf8")).toContain("const v300 = 0;\n");
  });

  test("a raw read of the range makes its lines the session's, and a raw read of the whole lifts the rule", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    await Read.run({ file_path: p, raw: true, offset: 300, limit: 5 }, ctx);
    expect(knownOf(ctx, p)!.lines).toEqual([{ from: 120, to: 122 }, { from: 300, to: 304 }]);
    expect((await Edit.run({ file_path: p, old_string: `${line(301)}\n${line(302)}`, new_string: "const merged = 0;" }, ctx)).is_error).toBeFalsy();
    expect(knownOf(ctx, p)!.told).toBe(false);
    const whole = file();
    await Read.run({ file_path: whole }, ctx);
    await Read.run({ file_path: whole, raw: true }, ctx);
    expect(knownOf(ctx, whole)).toBeUndefined();
    expect((await Edit.run({ file_path: whole, old_string: line(500), new_string: "x" }, ctx)).is_error).toBeFalsy();
    // A file seen whole before the reading is not taken back by it.
    await Read.run({ file_path: file(LONG, "seen.ts"), raw: true }, ctx);
    await Read.run({ file_path: join(dir, "seen.ts") }, ctx);
    expect(knownOf(ctx, join(dir, "seen.ts"))).toBeUndefined();
  });

  test("the known lines follow the session's own edits", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    await Edit.run({ file_path: p, old_string: line(120), new_string: `${line(120)}\nconst a = 1;\nconst b = 2;` }, ctx);
    expect(knownOf(ctx, p)!.lines).toEqual([{ from: 120, to: 124 }]);
    // What was line 122, and a line the edit wrote.
    expect((await Edit.run({ file_path: p, old_string: line(122), new_string: "const v122 = 0;" }, ctx)).is_error).toBeFalsy();
    expect((await Edit.run({ file_path: p, old_string: "const a = 1;", new_string: "const a = 2;" }, ctx)).is_error).toBeFalsy();
    expect(knownOf(ctx, p)!.told).toBe(false);
    // Lines added next to a line it has are placed, not refused.
    expect((await Edit.run({ file_path: p, old_string: "const v122 = 0;", new_string: "const v122 = 0;\nconst c = 3;" }, ctx)).is_error).toBeFalsy();
  });

  test("a file changed by something else since the reading has no line the session is known to have", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    writeFileSync(p, `// a new first line\n${LONG}`);
    const k = knownOf(ctx, p)!;
    k.mtime -= 1; // (a time the file no longer has, whatever the clock's grain)
    const no = await Edit.run({ file_path: p, old_string: line(121), new_string: "x" }, ctx);
    expect(text(no)).toContain("line 122 that this edit changes is not among the lines it showed");
  });

  test("a whole Write over a file the session has only a reading of is held once, as a file it never read", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    const no = await Write.run({ file_path: p, content: "gone\n" }, ctx);
    expect(text(no)).toContain("exists and you have only a compiled reading of it, not its text");
    expect((await Write.run({ file_path: p, content: "gone\n" }, ctx)).is_error).toBeFalsy();
    expect(knownOf(ctx, p)).toBeUndefined();
  });

  test("a command that names the file looked at it: nothing is held back after", async () => {
    const { ctx } = rig();
    const p = file();
    await Read.run({ file_path: p }, ctx);
    expect(knownOf(ctx, p)).toMatchObject({ lines: [{ from: 120, to: 122 }] });
    await Bash.run({ command: `sed -n '290,310p' ${p}` }, ctx);
    expect(knownOf(ctx, p)).toBeUndefined();
  }, 30_000);

  test("Gemini's replace names its own way to read the lines; the GPT family's apply_patch is not held", async () => {
    const g = rig();
    const p = file();
    await read_file.run({ file_path: p }, g.ctx);
    const no = await replace.run({ file_path: p, old_string: line(300), new_string: "x" }, g.ctx);
    expect(text(no)).toContain("Read them first (read_file with raw: true, start_line 300, end_line 300)");
    expect((await replace.run({ file_path: p, old_string: line(300), new_string: "x" }, g.ctx)).is_error).toBeFalsy();

    const c = rig();
    const q = file();
    const name = q.slice(dir.length + 1);
    const patch = (n: number) => `*** Begin Patch\n*** Update File: ${name}\n@@\n-${line(n)}\n+const v${n} = 0;\n*** End Patch`;
    expect((await apply_patch.run({ input: patch(300) }, c.ctx)).is_error).toBeFalsy();
    expect(readFileSync(q, "utf8")).toContain("const v300 = 0;");
  }, 30_000);

  test("the lines an edit touches, the ones not held, and the lines after it", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n") + "\n";
    expect(touched(before, "a\nB\nc\nd\ne\n")).toEqual([{ from: 2, to: 2 }]);
    expect(touched(before, "a\nb\nc\nd\n")).toEqual([{ from: 5, to: 5 }]);
    expect(touched(before, "a\nb\nx\ny\nc\nd\ne\n")).toEqual([{ from: 2, to: 3, insert: true }]);
    expect(touched(before, "x\na\nb\nc\nd\ne\n")).toEqual([{ from: 0, to: 1, insert: true }]);
    expect(touched(before, "a\nc\nd\nE\n")).toEqual([{ from: 2, to: 2 }, { from: 5, to: 5 }]);
    expect(missing([{ from: 2, to: 3 }], [{ from: 2, to: 4 }], 5)).toEqual([{ from: 4, to: 4 }]);
    // Added lines are placed by either line next to them.
    expect(missing([{ from: 3, to: 3 }], [{ from: 2, to: 3, insert: true }], 5)).toEqual([]);
    expect(missing([{ from: 5, to: 5 }], [{ from: 2, to: 3, insert: true }], 5)).toEqual([{ from: 2, to: 3 }]);
    expect(missing([], [{ from: 0, to: 1, insert: true }], 0)).toEqual([]);
    expect(rebase([{ from: 2, to: 3 }], before, "a\nb\nx\ny\nc\nd\ne\n")).toEqual([{ from: 2, to: 5 }]);
    expect(rebase([{ from: 4, to: 5 }], before, "b\nc\nd\ne\n")).toEqual([{ from: 3, to: 4 }]);
    expect(merge([{ from: 5, to: 6 }, { from: 1, to: 2 }, { from: 3, to: 3 }, { from: 9, to: 8 }])).toEqual([{ from: 1, to: 3 }, { from: 5, to: 6 }]);
  });
});

describe("the reading itself", () => {
  const page = pageOf(Array.from({ length: 50 }, (_, i) => `${i + 1}\tline ${i + 1}`).join("\n") + "\n\nPARTIAL view: lines 1-50 of 90. Continue with offset 51.", true, 1, 90);

  test("a page from a read's text, numbered or bare", () => {
    expect(page).toMatchObject({ first: 1, last: 50, total: 90, more: "PARTIAL view: lines 1-50 of 90. Continue with offset 51." });
    expect(page.rows.get(50)).toBe("line 50");
    const bare = pageOf("x\ny\nz", false, 10);
    expect([...bare.rows]).toEqual([[10, "x"], [11, "y"], [12, "z"]]);
    expect(bare).toMatchObject({ first: 10, last: 12, more: "" });
  });

  test("marks become the file's own lines; a row the reader typed is the file's row; a mark past the budget says so", () => {
    const r = expandReading("What it is.\n- `@@ 3-4`\n@@ 7: the seventh\n9\tnot what line nine says\n77\ta line the page lacks\n@@ 60-61", page, 10_000);
    expect(r.text).toBe("What it is.\n3\tline 3\n4\tline 4\nthe seventh\n7\tline 7\n9\tline 9\n77 a line the page lacks\n[lines 60-61 are not shown here]");
    expect(r.quoted).toEqual([{ from: 3, to: 4 }, { from: 7, to: 7 }, { from: 9, to: 9 }]);
    const held = expandReading("@@ 1-50", page, 40);
    expect(held.quoted).toEqual([{ from: 1, to: 4 }]);
    expect(held.text).toEndWith("[lines 5-50 are not shown here]");
    // A diff's hunk header is not a mark.
    expect(expandReading("@@ -3,4 +3,5 @@", page, 100).text).toBe("@@ -3,4 +3,5 @@");
  });
});

describe("no reading comes back", () => {
  test("a reader that fails: the file, said once; reads stay raw without asking until the rest is over", async () => {
    let fail = true;
    const { ctx, asked } = rig({ answer: (a) => { if (fail) throw new Error("the provider is unreachable"); return { text: "A file.\n@@ 1-2", models: ["Small"], parts: [{ k: 1, covers: a.source, chars: 1, state: "read" }], unread: [], chars: 1, usage: emptyUsage(), compiled: false }; } });
    const p = file();
    const first = text(await Read.run({ file_path: p }, ctx));
    expect(first).toStartWith("[The reader model did not give a reading of this file (the provider is unreachable): the file itself follows, and file reads come back as they are until a reader answers again.]\n1\t");
    expect(first).toContain(`600\t${line(600)}`);
    // The file itself is the session's: an edit of it is not held.
    expect((await Edit.run({ file_path: p, old_string: line(300), new_string: "x" }, ctx)).is_error).toBeFalsy();
    const second = text(await Read.run({ file_path: file() }, ctx));
    expect(second).toStartWith(`1\t${line(1)}`);
    expect(asked).toHaveLength(1);
    // After the rest one read asks again; a second failure is not said again.
    setSystemTime(new Date(Date.now() + READER_REST_MS + 1_000));
    expect(text(await Read.run({ file_path: file() }, ctx))).toStartWith(`1\t${line(1)}`);
    expect(asked).toHaveLength(2);
    // The reader answers again, and a later failure is said.
    fail = false;
    setSystemTime(new Date(Date.now() + READER_REST_MS + 1_000));
    expect(text(await Read.run({ file_path: file() }, ctx))).toStartWith("[Compiled reading of");
    fail = true;
    expect(text(await Read.run({ file_path: file() }, ctx))).toStartWith("[The reader model did not give a reading");
  });

  test("a reader that refuses or reads nothing: the file, with why", async () => {
    const { ctx } = rig({ answer: unread("Small: the reader (Small) refused") });
    expect(text(await Read.run({ file_path: file() }, ctx))).toStartWith("[The reader model did not give a reading of this file (Small: the reader (Small) refused)");
    const empty = rig({ answer: (a) => ({ text: " ", models: ["Small"], parts: [{ k: 1, covers: a.source, chars: 1, state: "read" }], unread: [], chars: 1, usage: emptyUsage(), compiled: false }) });
    expect(text(await read_file.run({ file_path: file() }, empty.ctx))).toStartWith("[The reader model did not give a reading of this file (it gave no answer)");
  });

  test("a reader slower than the bound: the file, and the job is ended", async () => {
    process.env.KEEL_READ_WAIT_MS = "60";
    let ended = false;
    const { ctx } = rig();
    ctx.readMaterial = (_items, _q, _c, opts) => new Promise((_, no) => opts!.signal!.addEventListener("abort", () => { ended = true; no(Object.assign(new Error("interrupted"), { name: "AbortError" })); }, { once: true }));
    const out = text(await Read.run({ file_path: file() }, ctx));
    expect(out).toStartWith("[The reader model did not give a reading of this file (no answer in 0 s)");
    expect(out).toContain(`600\t${line(600)}`);
    expect(ended).toBe(true);
  });

  test("a stopped turn ends the read as any stopped call, with no fallback", async () => {
    const stop = new AbortController();
    const { ctx } = rig({ more: { signal: stop.signal } });
    ctx.readMaterial = () => new Promise((_, no) => { stop.abort(); no(Object.assign(new Error("interrupted"), { name: "AbortError" })); });
    await expect(Read.run({ file_path: file() }, ctx)).rejects.toThrow("interrupted");
  });
});

test("the changed tools carry an urgent mark", () => {
  const marks = { ...toolMarks(claudeTools), ...toolMarks(geminiTools), ...toolMarks(gptTools) };
  expect(marks.Read).toBe("read-through-reader");
  expect(marks.read_file).toBe("read-through-reader");
  // A shell returns its command's output: the GPT family's tools changed nothing.
  expect(marks.exec_command).toBe("wait-poll");
  expect(marks.apply_patch).toBeUndefined();
  expect(marks.Edit).toBe("edit-after-reading");
  expect(marks.replace).toBe("edit-after-reading");
  // The explicit fields are optional: a call written for the definition before them still runs.
  for (const t of [Read, read_file]) {
    expect((t.input_schema as any).properties.raw).toMatchObject({ type: "boolean" });
    expect((t.input_schema as any).properties.for).toMatchObject({ type: "string" });
    expect((t.input_schema as any).required).toEqual(["file_path"]);
  }
});
