import { expect, test } from "bun:test";
import { findSettings } from "./settings-match.ts";

const sections = [
  { id: "general", label: "General", words: "theme dark light mode font zoom" },
  { id: "safety", label: "Permissions", words: "approvals allow auto" },
  { id: "usage", label: "Usage", words: "cost budget limit" },
];
const rows: Record<string, string[]> = { safety: ["New sessions start in", "Judge model", "Code review model"], usage: ["Spend over time", "Spend limits", "Per model"] };
const find = (q: string) => findSettings(sections, (id) => rows[id] ?? [], q).map((r) => `${r.section.id}${r.rows.length ? `: ${r.rows.join(", ")}` : ""}`);

test("every word is matched on its own, in any order", () => {
  expect(find("dark mode")).toEqual(["general"]);
  expect(find("mode dark")).toEqual(["general"]);
  expect(find("model judge")).toEqual(["safety: Judge model"]);
  expect(find("dark judge")).toEqual([]);
});

test("a row is named when it holds a word and its section holds the rest", () => {
  expect(find("usage spend")).toEqual(["usage: Spend over time, Spend limits"]);
  expect(find("spend limits")).toEqual(["usage: Spend limits"]);
  expect(find("spend limit")).toEqual(["usage: Spend limits, Spend over time"]);
  expect(find("limit")).toEqual(["usage: Spend limits"]);
  expect(find("model")).toEqual(["safety: Judge model, Code review model", "usage: Per model"]);
  expect(find("")).toEqual(["general", "safety", "usage"]);
});
