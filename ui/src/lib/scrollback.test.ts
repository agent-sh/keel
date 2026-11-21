// The terminal pane's bound on a followed command's output: where it cuts.
import { expect, test } from "bun:test";
import { parseAnsi } from "../../../src/core/ansi.ts";
import { bounded, SHOWN } from "./scrollback.ts";

test("output under the budget is kept whole", () => {
  const t = "ERROR-AT-START\n" + "x".repeat(70_000) + "\nburst-end\n";
  expect(bounded(t)).toEqual({ text: t, cut: 0 });
  expect(SHOWN).toBeGreaterThan(70_000);
});

test("steady output plateaus, cut at a line's start", () => {
  let own = "";
  let dropped = 0, most = 0;
  for (let i = 0; i < 5000; i++) {
    const r = bounded(own + `line ${i} ${"y".repeat(40)}\n`, 10_000);
    own = r.text;
    dropped += r.cut;
    most = Math.max(most, own.length);
  }
  expect(most).toBeLessThanOrEqual(12_600);
  expect(own.length).toBeGreaterThanOrEqual(10_000 - 60);
  expect(dropped).toBeGreaterThan(200_000);
  expect(own.startsWith("line ")).toBe(true);
  expect(own.endsWith(`line 4999 ${"y".repeat(40)}\n`)).toBe(true);
});

test("the colors in force at the cut lead what is kept", () => {
  // Red is set once, far above; the lines kept are still red.
  const t = "\x1b[1m\x1b[0m\x1b[31mred from here\n" + "still red\n".repeat(2000) + "\x1b[0mplain\n";
  const r = bounded(t, 5000);
  expect(r.cut).toBeGreaterThan(0);
  const segs = parseAnsi(r.text);
  expect(segs[0]!.fg).toBe("var(--danger)");
  expect(segs[0]!.bold).toBeUndefined(); // the reset before the red still holds
  expect(segs[0]!.text.startsWith("still red\n")).toBe(true);
  expect(segs.at(-1)).toEqual({ text: "plain\n" });
  // Nothing set at the cut: nothing is added.
  expect(bounded("\x1b[32mok\x1b[0m\n" + "plain\n".repeat(3000), 5000).text.startsWith("plain\n")).toBe(true);
});

test("one long line is cut between characters and outside escape sequences", () => {
  const smile = "\u{1F600}"; // two code units
  const long = smile.repeat(4000);
  const r = bounded(long, 4001);
  expect(r.cut).toBeGreaterThan(0);
  expect(r.text.codePointAt(0)).toBe(0x1f600);
  expect([...r.text].every((c) => c === smile)).toBe(true);
  // The cut would fall inside a true-color sequence: it moves past it.
  const seq = "\x1b[38;2;10;20;30m";
  const body = "a".repeat(6000);
  const line = body.slice(0, 2994) + seq + body.slice(2994); // the sequence spans index 3000
  const cut = bounded(line + "b".repeat(4000), 7000 + seq.length - 6); // at = 3000
  expect(cut.cut).toBe(2994 + seq.length);
  expect(cut.text.startsWith(seq + "a")).toBe(true); // carried as the color in force
  expect(parseAnsi(cut.text)[0]!.fg).toBe("rgb(10, 20, 30)");
});

test("a long title or link sequence is never cut in two", () => {
  // An OSC sequence of 3,000 characters across the cut: it goes whole.
  const osc = "\x1b]8;;https://example.com/" + "p".repeat(3000) + "\x07";
  const t = "a".repeat(5000) + osc + "b".repeat(4000);
  const r = bounded(t, 5500); // the cut falls inside the sequence
  expect(r.text.startsWith("b")).toBe(true);
  expect(r.text.includes("\x1b]")).toBe(false);
  // One that never closes stays whole in what is kept, from its start.
  const open = "a".repeat(5000) + "\x1b]0;" + "t".repeat(6000);
  const k = bounded(open, 5500);
  expect(k.text.startsWith("\x1b]0;")).toBe(true);
});
