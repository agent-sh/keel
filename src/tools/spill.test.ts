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

    // Blocks: the long text is cut, the image and the short text are the same objects.
    const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" }, short = { type: "text", text: "captured" };
    const blocks = (await capResult([short, { type: "text", text: long }, image], OUTPUT_CAP, dir, "mcp")) as any[];
    expect([blocks[0], blocks[2]]).toEqual([short, image]);
    expect(blocks[1].text.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(blocks[1].text).toContain("saved to ");
    const same = [short, image];
    expect(await capResult(same, OUTPUT_CAP, dir, "mcp")).toBe(same);

    // Run on another machine: nothing is saved here, and the result says the middle is gone.
    const far = (await capResult(long, OUTPUT_CAP, undefined, "Grep")) as string;
    expect(far.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(far).toContain("chars cut and not kept");
    expect(readdirSync(dir)).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
