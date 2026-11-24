import { expect, test } from "bun:test";
import type { Message } from "../core/types.ts";
import { oldestResultsForSize, shortenResults } from "./size-fit.ts";

const result = (id: string, n: number): Message => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(n) }] });
const history: Message[] = [result("a", 20_000), result("b", 500), result("c", 20_000), result("d", 20_000), result("e", 20_000)];

test("the oldest long results go first, until half of what they could save", () => {
  expect(oldestResultsForSize(history, new Set())).toEqual(["a", "c"]);
  // Asked again after those: the rest.
  expect(oldestResultsForSize(history, new Set(["a", "c"]))).toEqual(["d"]);
  expect(oldestResultsForSize(history, new Set(["a", "c", "d", "e"]))).toEqual([]);
});

test("a shortened result keeps its start and end, and the history is not changed", () => {
  const out = shortenResults(history, new Set(["a"]));
  const text = (m: Message) => (m.role === "user" && m.content[0]!.type === "tool_result" ? String(m.content[0]!.content) : "");
  expect(text(out[0]!).length).toBeLessThan(2_500);
  expect(text(out[0]!)).toContain("[Output shortened:");
  expect(text(out[2]!).length).toBe(20_000);
  expect(text(history[0]!).length).toBe(20_000);
  // The same ids give the same bytes every time (the provider's cache prefix).
  expect(JSON.stringify(shortenResults(history, new Set(["a"])))).toBe(JSON.stringify(out));
});
