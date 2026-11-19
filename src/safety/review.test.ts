import { expect, test } from "bun:test";
import { fixPrompt, parseAnswer, reviewKey, type Review } from "./review.ts";

const answer = (findings: unknown[], extra: object = { verdict: "incorrect" }) => "```json\n" + JSON.stringify({ findings, ...extra }) + "\n```";
const f = (o: object) => ({ file: "a.ts", line: 1, title: "t", ...o });

test("a priority the reviewer did not give is unrated, never P0", () => {
  const r = parseAnswer(answer([f({ title: "omitted" }), f({ title: "null", priority: null }), f({ title: "zero", priority: 0 }), f({ title: "one", priority: 1 })]));
  expect(r.findings.map((x) => [x.title, x.priority])).toEqual([["zero", 0], ["one", 1], ["omitted", null], ["null", null]]);
  expect(fixPrompt({ kind: "code", scope: "uncommitted", target: "HEAD" } as Review, r.findings)).toMatch(/\[P0\] a\.ts:1: zero[\s\S]*\[unrated\] a\.ts:1: null/);
});

test("findings are sorted before the cap: a P0 in position 101 is kept", () => {
  const many = [...Array.from({ length: 100 }, () => f({ priority: 3 })), f({ title: "blocker", priority: 0 })];
  const r = parseAnswer(answer(many));
  expect(r.findings[0]!.title).toBe("blocker");
  expect(r.omitted).toBe(1);
});

test("an unreadable finding is counted, and an answer of only those is not 'no findings'", () => {
  expect(() => parseAnswer(answer([{ title: "no file" }]))).toThrow(/could not be read \(no file\)/);
  const mixed = parseAnswer(answer([{ title: "no file" }, f({ title: "ok" })]));
  expect(mixed.findings.map((x) => x.title)).toEqual(["ok"]);
  expect(mixed.rejected).toBe(1);
  const empty = parseAnswer(answer([], {}));
  expect(empty).toMatchObject({ findings: [], verdict: undefined });
  expect(empty.rejected).toBeUndefined();
});

test("a review is the same review only on the same trees and reviewer", () => {
  const k = { from: "t1", to: "t2", kind: "code" as const, model: "A" };
  expect(reviewKey(k)).toBe(reviewKey({ ...k }));
  expect(reviewKey(k)).not.toBe(reviewKey({ ...k, to: "t3" }));
  expect(reviewKey(k)).not.toBe(reviewKey({ ...k, model: "B" }));
});
