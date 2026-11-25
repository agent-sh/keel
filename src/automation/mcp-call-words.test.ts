import { expect, test } from "bun:test";
import { ceilingWords } from "./mcp-call-words.ts";

test("a call's ceiling is said in the unit that fits", () => {
  expect(ceilingWords(1_000)).toBe("1 second");
  expect(ceilingWords(30_000)).toBe("30 seconds");
  expect(ceilingWords(600_000)).toBe("10 minutes");
  expect(ceilingWords(3_600_000)).toBe("60 minutes");
  expect(ceilingWords(100_000_000)).toBe("28 hours");
  expect(ceilingWords(3 * 86_400_000)).toBe("3 days");
});
