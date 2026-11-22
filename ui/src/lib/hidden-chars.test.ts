import { expect, test } from "bun:test";
import { hasHidden, hasRtl, plainAscii, rtlRuns, spellHidden } from "./hidden-chars.ts";

test("hidden characters are found and spelled out", () => {
  expect(hasHidden("git add -A && git commit -m 'x'")).toBe(false);
  expect(hasHidden("a\nb")).toBe(true);
  expect(hasHidden("a\n\tb", "\n\t")).toBe(false);
  expect(spellHidden("echo \u202Etxt.x > r.txt")).toEqual([
    { text: "echo " }, { text: "\u202E", hidden: { shown: "<U+202E>", name: "right-to-left override" } }, { text: "txt.x > r.txt" },
  ]);
  // In a text of many lines a newline and a tab are plain; a carriage return is not.
  expect(spellHidden("a\n\tb\r").map((p) => p.hidden?.shown ?? p.text)).toEqual(["a\n\tb", "<U+000D>"]);
  expect(spellHidden("plain")).toEqual([{ text: "plain" }]);
  // What draws nothing, and what draws as a plain space and is not one, is marked too.
  for (const [ch, shown] of [["\u3164", "<U+3164>"], ["\ufe0f", "<U+FE0F>"], ["\u034f", "<U+034F>"], ["\u2800", "<U+2800>"], ["\ufffc", "<U+FFFC>"], ["\u00a0", "<U+00A0>"], ["\u3000", "<U+3000>"]] as [string, string][]) {
    expect(hasHidden(`a${ch}b`)).toBe(true);
    expect(spellHidden(`a${ch}b`).map((p) => p.hidden?.shown ?? p.text)).toEqual(["a", shown, "b"]);
  }
  expect(hasHidden("a b")).toBe(false);
  expect(plainAscii("git add -A && git commit -m 'x'")).toBe(true);
  expect(plainAscii("caf\u00e9")).toBe(false);
  expect(hasRtl("cp \u05d0 1 2 \u05d1 > \u05d2")).toBe(true);
  expect(hasRtl("cp a b")).toBe(false);
});

test("letters written right to left are cut into their runs: each word by itself, the rest as written", () => {
  const cut = (t: string) => rtlRuns(t).map((p) => (p.rtl ? `[${p.text}]` : p.text)).join("");
  // Each letter by itself: digits and signs between them stay where they are written.
  expect(cut("cp \u05d0 1 2 \u05d1 > \u05d2")).toBe("cp [\u05d0] 1 2 [\u05d1] > [\u05d2]");
  // A word is one run, with its points; two words are two runs, in the order they are written.
  expect(cut("cat \u05d3\u05d5\u05d7.txt")).toBe("cat [\u05d3\u05d5\u05d7].txt");
  expect(cut("\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd \u05e2\u05d5\u05dc\u05dd")).toBe("[\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd] [\u05e2\u05d5\u05dc\u05dd]");
  expect(cut("notes/\u0645\u0644\u0641 2.md")).toBe("notes/[\u0645\u0644\u0641] 2.md");
  // Nothing written right to left: one piece, as it is.
  expect(rtlRuns("ls -la")).toEqual([{ text: "ls -la" }]);
  expect(rtlRuns("")).toEqual([]);
});
