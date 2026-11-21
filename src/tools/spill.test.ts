// Two outputs spilled in the same millisecond under the same label each keep
// their own file (pure logic no e2e can time).
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_CAP, spill } from "./spill.ts";

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
