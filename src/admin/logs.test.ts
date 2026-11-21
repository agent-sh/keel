// The log's files, read back: a line with its session and turn, a stack under
// its line, the newest end across two days, and a window found in a large
// day's file without reading the file.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatLine, fromFiles, type LogLine, parseLines, tail } from "./logs.ts";

const S = "01a1fd57-0861-7438-b6d5-030fa4213433", T = "01a1fd57-095a-7557-af0f-38a84abd7dd6";
const day = (d: string, h: number, m: number, s: number, ms = 0) => Date.parse(`${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}Z`);

test("a line keeps its session and turn, a stack stays under its line, and an older file's lines still read", () => {
  const lines: LogLine[] = [
    { ts: day("2026-11-21", 9, 0, 0), level: "info", text: "keel listening on http://127.0.0.1:1 (state /x)" },
    { ts: day("2026-11-21", 9, 0, 1, 5), level: "error", text: "[provider] 529 overloaded\n    at send (http.ts:1:1)\n    at step (turn.ts:2:2)", session: S, turn: T },
    { ts: day("2026-11-21", 9, 0, 2), level: "warn", text: "[turn] cut at step 3, during Bash, after 42 s: the daemon went down", session: S },
  ];
  const text = lines.map(formatLine).join("\n") + "\n";
  expect(text.split("\n")[1]).toBe(`2026-11-21T09:00:01.005Z ERROR {${S} ${T}} [provider] 529 overloaded`);
  expect(parseLines(text)).toEqual(lines);
  // A line from before the session and turn were written, and a piece that starts mid-entry.
  expect(parseLines("    at tail (x.ts:1:1)\n2026-11-20T08:00:00.000Z INFO  an old line\n")).toEqual([{ ts: day("2026-11-20", 8, 0, 0), level: "info", text: "an old line" }]);
});

test("the newest end is read across days, and a window is found inside a large file", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "logs-"));
  try {
    // Two days: a line every 5 s, about 3 MB a day (more than one read holds), some with a stack.
    const mk = (d: string) => Array.from({ length: 17_280 }, (_, i): LogLine => ({ ts: day(d, 0, 0, 0) + i * 5000, level: i % 500 === 0 ? "error" : "info", text: `line ${d} ${i} ${"x".repeat(120)}${i % 500 === 0 ? "\n    at somewhere (file.ts:1:1)" : ""}`, ...(i % 3 === 0 ? { session: S, turn: T } : {}) }));
    const [one, two] = [mk("2026-11-20"), mk("2026-11-21")];
    writeFileSync(join(dir, "keel-2026-11-20.log"), one.map(formatLine).join("\n") + "\n");
    writeFileSync(join(dir, "keel-2026-11-21.log"), two.slice(0, 300).map(formatLine).join("\n") + "\n");
    writeFileSync(join(dir, "notes.txt"), "not a log\n");

    // The last 2000 lines: all 300 of the newer day, then the end of the older one.
    const end = tail(dir, 2000);
    expect(end.length).toBe(2000);
    expect(end.slice(-300)).toEqual(two.slice(0, 300));
    expect(end.slice(0, 1700)).toEqual(one.slice(-1700));

    // Ten minutes in the middle of the first day, to the millisecond.
    const since = day("2026-11-20", 12, 0, 0), until = day("2026-11-20", 12, 10, 0);
    expect(fromFiles(dir, since, until)).toEqual(one.filter((l) => l.ts >= since && l.ts <= until));
    expect(fromFiles(dir, since, until).length).toBe(121);
    // A window over midnight reads both files; one before any line reads none.
    const over = fromFiles(dir, day("2026-11-20", 23, 59, 0), day("2026-11-21", 0, 1, 0));
    expect(over.map((l) => l.text.slice(0, 22))).toEqual([...one.slice(-12), ...two.slice(0, 13)].map((l) => l.text.slice(0, 22)));
    expect(fromFiles(dir, day("2026-11-19", 1, 0, 0), day("2026-11-19", 2, 0, 0))).toEqual([]);
    // A window larger than one read holds: its newest lines are the ones returned, to its very end.
    const wide = fromFiles(dir, day("2026-11-20", 0, 0, 0), day("2026-11-21", 0, 20, 0));
    expect(wide.at(-1)).toEqual(two[240]!);
    expect(wide.length).toBeGreaterThan(5_000);
    expect(wide.length).toBeLessThan(one.length);
    expect(wide).toEqual([...one, ...two.slice(0, 241)].slice(-wide.length));
    expect(fromFiles(join(dir, "missing"), since, until)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
