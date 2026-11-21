import { expect, test } from "bun:test";
import { plainLine } from "./plain.ts";

test("a model's markdown reads as one plain line", () => {
  expect(plainLine("## The parser, moved\n\nThe change is in `notes/plan.md:2`.")).toBe("The parser, moved: The change is in notes/plan.md:2.");
  // A heading alone is still a line; a heading names the line after it, once.
  expect(plainLine("## Result")).toBe("Result");
  expect(plainLine("## Result\n\n```\ncode\n```\nThe tests pass.\n\n## Next")).toBe("Result: The tests pass.");
  // A span written with a fence's mark on one line is a span.
  expect(plainLine("```npm test``` passes now")).toBe("npm test passes now");
  expect(plainLine("```npm test```")).toBe("npm test");
  expect(plainLine("\n\n```ts\nconst x = 1;\n```\n- [x] **Done**: see [the plan](notes/plan.md) and `src/a_b_c.ts`")).toBe("Done: see the plan and src/a_b_c.ts");
  expect(plainLine("> *Note* the snake_case_name stays, 2 * 3 * 4 too")).toBe("Note the snake_case_name stays, 2 * 3 * 4 too");
  expect(plainLine("| File | Change |\n| --- | ---: |\n| a | b |")).toBe("File, Change");
  expect(plainLine("---\n\n1. First step")).toBe("First step");
  expect(plainLine("word ".repeat(100), 20)).toBe("word word word word…");
  expect(plainLine("```\nonly code\n```")).toBe("");
});

test("code spans keep their marks, a longer fence holds a shorter one, and a cut never splits a character", () => {
  expect(plainLine("Rename `__init__.py` and **keep** `src/**/x` with `lib/**/y`")).toBe("Rename __init__.py and keep src/**/x with lib/**/y");
  expect(plainLine("````md\n```ts\nconst inner = 1;\n```\n````\nAfter the fence")).toBe("After the fence");
  expect(plainLine("~~~\n```\n~~~\nTilde fence closed")).toBe("Tilde fence closed");
  const cut = plainLine("a".repeat(8) + "😀😀😀", 10);
  expect(cut).toBe("a".repeat(8) + "😀…");
  expect(cut.isWellFormed()).toBe(true);
});

test("a very long line of unclosed marks is read in no time", () => {
  for (const mark of ["**", "__", "~~", "![", "`"]) {
    const t = performance.now();
    expect(plainLine(`${mark}x `.repeat(60_000)).length).toBeLessThanOrEqual(300);
    expect(performance.now() - t).toBeLessThan(200);
  }
});
