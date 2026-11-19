import { expect, test } from "bun:test";
import { parseAnsi, stripAnsiText } from "./ansi.ts";

test("colors, weight and reset become runs", () => {
  expect(parseAnsi("a\x1b[1;31mred\x1b[0m b")).toEqual([
    { text: "a" },
    { text: "red", bold: true, fg: "var(--danger)" },
    { text: " b" },
  ]);
  expect(parseAnsi("\x1b[38;5;196mx\x1b[39m\x1b[48;2;1;2;3my")).toEqual([
    { text: "x", fg: "rgb(255, 0, 0)" },
    { text: "y", bg: "rgb(1, 2, 3)" },
  ]);
});

test("other escapes go, progress redraws keep their last frame", () => {
  expect(stripAnsiText("\x1b]0;title\x07\x1b[2K 10%\r 50%\r100%\ndone\x1b[?25h")).toBe("100%\ndone");
  expect(stripAnsiText("line\r\nnext")).toBe("line\nnext");
});
