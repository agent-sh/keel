// Two outputs spilled in the same millisecond under the same label each keep
// their own file (pure logic no e2e can time).
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { capResult, OUTPUT_CAP, spill } from "./spill.ts";

afterEach(() => setSystemTime());

test("two long outputs of one millisecond and label are saved to two files, each whole", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "spill-"));
  try {
    setSystemTime(new Date(Date.UTC(2026, 0, 1)));
    const a = "first output line\n".repeat(OUTPUT_CAP / 10), b = "second output line\n".repeat(OUTPUT_CAP / 10);
    const [ra, rb] = await Promise.all([spill(a, dir, "Bash"), spill(b, dir, "Bash")]);
    const path = (r: string) => /saved to (\S+) \.\.\.\]/.exec(r)![1]!;
    expect(path(ra)).not.toBe(path(rb));
    expect(readFileSync(path(ra), "utf8")).toBe(a);
    expect(readFileSync(path(rb), "utf8")).toBe(b);
    expect(readdirSync(dir)).toHaveLength(2);
    // The name still starts with the time and the label, as before.
    expect(path(ra)).toMatch(/\/\d+-Bash-[0-9a-f]{8}\.txt$/);
    // A short output is returned as it is and saves nothing.
    expect(await spill("short", dir, "Bash")).toBe("short");
    expect(readdirSync(dir)).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The engine holds what any tool returned to the one cap: a long text goes
// to a file and comes back as its head, its tail and the path; a result
// within the cap, a tool's own larger cap, and what is not text pass as
// they are. A call that ran on another machine saves nothing here.
test("a result past the cap is cut through the spill, whatever its shape", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "cap-"));
  try {
    const long = Array.from({ length: 5000 }, (_, i) => `src/file.ts:${i}:export function parse(input: string): string[] { return []; }`).join("\n");
    const cut = (await capResult(long, OUTPUT_CAP, dir, "Grep")) as string;
    expect(cut.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(cut.startsWith(long.slice(0, 1000))).toBe(true);
    expect(cut.endsWith(long.slice(-1000))).toBe(true);
    const path = /saved to (\S+) \.\.\.\]/.exec(cut)![1]!;
    expect(path).toMatch(/\/\d+-Grep-[0-9a-f]{8}\.txt$/);
    expect(readFileSync(path, "utf8")).toBe(long);

    // Within the cap, with the line or two a tool adds around output it cut itself: as it is.
    const fits = "x".repeat(OUTPUT_CAP) + "\n[exit code 0; cwd is now /work]";
    expect(await capResult(fits, OUTPUT_CAP, dir, "Bash")).toBe(fits);
    // A tool that bounds its own result (a read page, a skill's instructions): as it is.
    expect(await capResult(long, Infinity, dir, "Read")).toBe(long);
    expect(readdirSync(dir)).toHaveLength(1);

    // Blocks: the texts are cut as one, where the first stood; the image is the same object.
    const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }, short = { type: "text", text: "captured" };
    const blocks = (await capResult([short, { type: "text", text: long }, image], OUTPUT_CAP, dir, "mcp")) as any[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"]);
    expect(blocks[1]).toBe(image);
    expect(blocks[0].text.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(blocks[0].text.startsWith("captured\nsrc/file.ts:0:")).toBe(true);
    expect(blocks[0].text).toContain("saved to ");
    const same = [short, image];
    expect(await capResult(same, OUTPUT_CAP, dir, "mcp")).toBe(same);
    // The cap is for the whole result: three texts each under it are one text within it, the image kept.
    const three = (await capResult([{ type: "text", text: "a".repeat(31_000) }, image, { type: "text", text: "b".repeat(31_000) }, { type: "text", text: "c".repeat(31_000) }], OUTPUT_CAP, dir, "mcp")) as any[];
    expect(three.map((b) => b.type)).toEqual(["text", "image"]);
    expect(three[0].text.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect([three[0].text.startsWith("aaaa"), three[0].text.endsWith("cccc"), three[0].text.includes("saved to ")]).toEqual([true, true, true]);

    // Run on another machine: nothing is saved here, and the result says the middle is gone.
    const far = (await capResult(long, OUTPUT_CAP, undefined, "Grep")) as string;
    expect(far.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(far).toContain("chars cut and not kept");
    expect(readdirSync(dir)).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A result sized by what carrying it costs (src/tools/carry.ts) keeps that
// many characters, most of them from its end; one a tool already cut and saved
// keeps the line that names its file.
test("a result sized for its session is cut to that size, its end kept longer than its start", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "sized-"));
  try {
    const long = Array.from({ length: 3000 }, (_, i) => `test ${i} ok`).join("\n") + "\nFAILED: 1 of 3000 tests";
    const cut = (await capResult(long, OUTPUT_CAP, dir, "Bash", { cap: 10_000, head: 0.25 })) as string;
    const [start, end] = cut.split(/\n\n\[\.\.\. \d+ chars cut; full output \(\d+ lines\) saved to \S+ \.\.\.\]\n\n/);
    expect([start!.length, end!.length]).toEqual([2_500, 7_500]);
    expect(end).toEndWith("FAILED: 1 of 3000 tests");
    expect(readFileSync(/saved to (\S+) \.\.\.\]/.exec(cut)![1]!, "utf8")).toBe(long);
    // Within the size: as it is. A tool's own cap below the size still holds.
    expect(await capResult(long.slice(0, 9_000), OUTPUT_CAP, dir, "Bash", { cap: 10_000, head: 0.25 })).toBe(long.slice(0, 9_000));
    // Run on another machine (no folder here to keep the rest): the size every result had.
    const far = (await capResult(long + "\n" + "z".repeat(40_000), OUTPUT_CAP, undefined, "Bash", { cap: 10_000, head: 0.25 })) as string;
    expect(far.length).toBeGreaterThan(27_000);
    expect(far).toContain("chars cut and not kept");
    // Cut and saved by the tool already: not cut again.
    const saved = await spill("y".repeat(OUTPUT_CAP * 2), dir, "mcp");
    expect(await capResult(saved, OUTPUT_CAP, dir, "mcp", { cap: 10_000, head: 0.25 })).toBe(saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
