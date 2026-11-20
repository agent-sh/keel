// Which model reads for a session: the owner's choice, else the cheapest of the
// session's provider and family that holds the text, never a dearer one.
import { expect, test } from "bun:test";
import type { ModelInfo } from "../providers/types.ts";
import { chunkChars, chunkMaterial, NOTHING, partRef, pickReader, READ_CHUNK_CHARS, readerChoices } from "./reader.ts";
import { readMaterial, type ReaderHost } from "./readers.ts";

const m = (id: string, input: number | undefined, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `p:${id}`, provider: "p", model: id, name: id, family: "claude", context: 200_000, output: 8_000, efforts: [],
  billing: input === undefined ? "subscription" : "per_token", ...(input === undefined ? {} : { price: { input, output: input * 5 } as any }), ...o,
});
const big = m("big", 5);
const small = m("small", 0.1, { release: "2026-10-01" });
const older = m("older", 0.1, { release: "2024-01-01" });
const tiny = m("tiny", 0.05, { context: 32_000 });
const other = m("other", 0.01, { family: "gpt" });
const all = [big, small, older, tiny, other, m("elsewhere", 0.01, { provider: "q", id: "q:x" })];

test("the cheapest of the same provider and family that fits, newest of equals", () => {
  expect(pickReader(all, big, 10_000, {}).id).toBe("p:tiny");
  expect(pickReader(all, big, 50_000, {}).id).toBe("p:small");
});

test("the owner's reader, then the configured small Claude model", () => {
  expect(pickReader(all, big, 10_000, { KEEL_READER_MODEL: "p:older" }).id).toBe("p:older");
  expect(pickReader(all, big, 10_000, { ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }).id).toBe("p:small");
});

test("never dearer than the session's model, and nothing by price without one", () => {
  expect(pickReader(all, tiny, 10_000, {}).id).toBe("p:tiny");
  const plan = m("plan", undefined);
  expect(pickReader([...all, plan], plan, 10_000, {}).id).toBe("p:plan");
});

test("on a plan the catalog's public rate ranks the plan's models; unknown rates keep the session's model", () => {
  const top = m("top", undefined), lite = m("lite", undefined), odd = m("odd", undefined);
  const list = (x: ModelInfo) => ({ top: { input: 5, output: 25 }, lite: { input: 0.5, output: 2 } } as Record<string, any>)[x.model];
  expect(readerChoices([top, lite, odd], top, 10_000, {}, list).map((x) => x.id)).toEqual(["p:lite", "p:top"]);
  expect(readerChoices([top, lite, odd], odd, 10_000, {}, list).map((x) => x.id)).toEqual(["p:odd"]);
});

test("the choices run best first and end on the session's own model, for a reader that fails", () => {
  expect(readerChoices(all, big, 50_000, { KEEL_READER_MODEL: "p:big" }).map((x) => x.id)).toEqual(["p:big", "p:small", "p:older"]);
  expect(readerChoices(all, big, 10_000, { ANTHROPIC_DEFAULT_HAIKU_MODEL: "older" }).map((x) => x.id)).toEqual(["p:older", "p:tiny", "p:small", "p:big"]);
});

test("a part stays under the reader's window and its first price tier", () => {
  expect(chunkChars(m("w", 1, { context: 1_000_000 }))).toBe(READ_CHUNK_CHARS);
  const tiered = chunkChars(m("t", 1, { context: 1_000_000, price: { input: 1, output: 5, tiers: [{ above: 20_000, input: 5, output: 25 }] } as any }));
  expect(tiered).toBeLessThan(20_000 * 2.5);
  expect(chunkChars(m("s", 1, { context: 16_000 }))).toBeLessThan(16_000 * 2.5);
});

const lines = (n: number, w = 20) => Array.from({ length: n }, (_, i) => `line ${i + 1} `.padEnd(w, "x")).join("\n");

test("material is split into balanced chunks; whole files stay whole; a long file splits at lines with its range", () => {
  const files = [{ source: "a.ts", text: lines(100) }, { source: "b.ts", text: lines(100) }, { source: "big.log", text: lines(2_000) }];
  const chunks = chunkMaterial(files, 12_000);
  expect(chunks.every((c) => c.chars <= 12_000)).toBe(true);
  const sizes = chunks.map((c) => c.chars);
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(3_000);
  const parts = chunks.flatMap((c) => c.parts);
  expect(parts.filter((p) => p.source === "a.ts")).toEqual([expect.objectContaining({ from: 1, to: 100, total: 100 })]);
  const big = parts.filter((p) => p.source === "big.log");
  expect(big[0]!.from).toBe(1);
  expect(big.at(-1)!.to).toBe(2_000);
  for (let i = 1; i < big.length; i++) expect(big[i]!.from).toBe(big[i - 1]!.to + 1);
  expect(big[1]!.body.split("\n")[0]).toStartWith(`${big[1]!.from}\t`);
  expect(partRef(big[1]!)).toBe(`big.log:${big[1]!.from}-${big[1]!.to}`);
  expect(partRef(parts[0]!)).toBe("a.ts");
});

test("a line longer than a part is cut into pieces under its own number", () => {
  const chunks = chunkMaterial([{ source: "min.js", text: "x".repeat(30_000) }], 10_000);
  const rows = chunks.flatMap((c) => c.parts.flatMap((p) => p.body.split("\n")));
  expect(rows.every((r) => r.startsWith("1\t"))).toBe(true);
  expect(rows.reduce((n, r) => n + r.length - 2, 0)).toBe(30_000);
});

const host = (fail: Set<string>, seen: string[]): ReaderHost => ({
  models: async () => all, current: async () => big, capture: (_e, c) => void seen.push(`captured ${c.model} ${c.part}`), env: { KEEL_READERS_AT_ONCE: "2" },
  ask: async (model, prompt) => {
    seen.push(`${model.id} ${prompt.startsWith("Readers each") ? "compile" : (/part (\d+) of/.exec(prompt)?.[1] ?? "1")}`);
    if (fail.has(model.id)) throw new Error("throttled");
    if (prompt.startsWith("Readers each")) return { text: "compiled answer", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0, cost: 0.001 } };
    return { text: prompt.includes("MARKER") ? "found it at a.log:3" : NOTHING, usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0, cost: 0.002 } };
  },
});

test("a failed reader hands its part to the next choice; the findings are compiled; a part every choice failed on is named", async () => {
  const text = (marked: boolean) => lines(5_000).replace("line 3 ", marked ? "MARKER " : "line 3 ");
  const seen: string[] = [];
  const o = await readMaterial(host(new Set(["p:small"]), seen), [{ source: "a.log", text: text(true) }, { source: "b.log", text: text(true) }], "where is the marker?", new AbortController().signal);
  const tried = seen.filter((s) => s.startsWith("p:small")).length;
  expect(tried).toBeGreaterThan(0);
  expect(seen.filter((s) => s.startsWith("captured p:small")).length).toBe(tried);
  expect(o.text).toBe("compiled answer");
  expect(o.compiled).toBe(true);
  expect(o.unread).toEqual([]);
  expect(o.models).toEqual(["older"]);
  expect(o.parts.filter((p) => p.state === "read").length).toBe(2);
  expect(o.cost).toBeGreaterThan(0);

  const none: string[] = [];
  const all3 = await readMaterial(host(new Set(["p:tiny", "p:small", "p:older", "p:big"]), none), [{ source: "a.log", text: text(false) }], "q", new AbortController().signal);
  expect(all3.text).toBe("");
  expect(all3.unread.length).toBe(all3.parts.length);
  expect(all3.unread[0]).toContain("every reader failed");
});
