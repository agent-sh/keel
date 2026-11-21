// Which model reads for a session: the owner's choice, else the cheapest of the
// session's provider and family that holds the text, never a dearer one.
import { expect, test } from "bun:test";
import type { ModelInfo } from "../providers/types.ts";
import { checkAnswer, checkedNote, chunkChars, chunkMaterial, NOTHING, partRef, pickReader, READ_CHUNK_CHARS, READER_OUTPUT, readerChoices, READERS_AT_ONCE } from "./reader.ts";
import { coverageNote, readMaterial, type ReaderHost } from "./readers.ts";

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

const host = (fail: Set<string>, seen: string[], refuse = new Set<string>()): ReaderHost => ({
  models: async () => all, current: async () => big, capture: (_e, c) => void seen.push(`captured ${c.model} ${c.part}`), env: { KEEL_READERS_AT_ONCE: "2" },
  ask: async (model, prompt) => {
    seen.push(`${model.id} ${prompt.startsWith("Readers each") ? "compile" : (/part (\d+) of/.exec(prompt)?.[1] ?? "1")}`);
    if (fail.has(model.id)) throw new Error("throttled");
    // A refusal is an answer the provider bills.
    if (refuse.has(model.id)) return { text: "", stop: "refusal", usage: { input: prompt.startsWith("Readers each") ? 10 : 1000, output: 0, cache_read: 0, cache_write: 0, cost: 0.002 } };
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

  // A reader that refuses is billed, and the job's usage says so; what the
  // working model would take in to read the same material once is the same.
  const files = [{ source: "a.log", text: text(true) }, { source: "b.log", text: text(true) }];
  const plain = await readMaterial(host(new Set(), []), files, "where is the marker?", new AbortController().signal);
  const refused = await readMaterial(host(new Set(), [], new Set(["p:small"])), files, "where is the marker?", new AbortController().signal);
  expect(plain.models).toEqual(["small"]);
  expect(refused.models).toEqual(["older"]);
  expect(plain.working!.tokens).toBe(plain.parts.length * 1000);
  expect(refused.working!.tokens).toBe(plain.working!.tokens);
  expect(refused.working!.cost).toBe(plain.working!.cost);
  expect(refused.usage.input).toBe(plain.usage.input + plain.parts.length * 1000 + 10);

  const none: string[] = [];
  const all3 = await readMaterial(host(new Set(["p:tiny", "p:small", "p:older", "p:big"]), none), [{ source: "a.log", text: text(false) }], "q", new AbortController().signal);
  expect(all3.text).toBe("");
  expect(all3.unread.length).toBe(all3.parts.length);
  expect(all3.unread[0]).toContain("every reader failed");
});

// A job with many long findings: twelve parts, each reader reporting about a
// fifth of what one request to the reader holds. `compile`: what the fake
// reader does with a compile request.
const wide = m("wide", 0.1, { context: 60_000, output: 8_000 });
const listed = (model: ModelInfo, prompt: string) => Math.ceil(prompt.length / 2.5) + Math.min(model.output, READER_OUTPUT) <= model.context;
function fanIn(compile: "merge" | "fail") {
  const asked: { model: ModelInfo; prompt: string; compile: boolean }[] = [];
  const h: ReaderHost = {
    models: async () => [big, wide], current: async () => big, capture: () => {}, env: { KEEL_READER_MODEL: "p:wide", KEEL_READERS_AT_ONCE: "4" },
    ask: async (model, prompt) => {
      const isCompile = prompt.startsWith("Readers each");
      asked.push({ model, prompt, compile: isCompile });
      const usage = { input: 1000, output: 20, cache_read: 0, cache_write: 0, cost: 0.001 };
      if (!isCompile) return { text: `"EVIDENCE-${/part (\d+) of/.exec(prompt)![1]} is here" (f${/part (\d+) of/.exec(prompt)![1]}.log:7)\n${"More of the same finding. ".repeat(800)}`, usage };
      if (compile === "fail") throw new Error("throttled");
      // A merge that keeps the evidence and drops the repetition.
      return { text: [...new Set([...prompt.matchAll(/"EVIDENCE-\d+ is here" \(f\d+\.log:7\)/g)].map((x) => x[0]))].join("\n"), usage };
    },
  };
  const items = Array.from({ length: 12 }, (_, i) => ({ source: `f${i + 1}.log`, text: lines(3_500) }));
  return { h, asked, items };
}

test("many long findings are compiled in stages: no request is over the reader's listed window, and early and late evidence reach the answer", async () => {
  const { h, asked, items } = fanIn("merge");
  const o = await readMaterial(h, items, "where is the evidence?", new AbortController().signal);
  expect(o.parts.length).toBe(12);
  expect(asked.filter((a) => !listed(a.model, a.prompt)).map((a) => `${a.model.id} ${a.prompt.length}`)).toEqual([]);
  expect(asked.filter((a) => a.compile).length).toBeGreaterThan(1);
  expect(o.compiled).toBe(true);
  for (let k = 1; k <= 12; k++) expect(o.text).toContain(`"EVIDENCE-${k} is here" (f${k}.log:7)`);
  expect(o.uncompiled).toBeUndefined();
});

test("findings no reader could compile come back as a bounded preview, every part's start in it, with the whole kept for a file", async () => {
  const { h, asked, items } = fanIn("fail");
  const o = await readMaterial(h, items, "where is the evidence?", new AbortController().signal);
  expect(asked.filter((a) => !listed(a.model, a.prompt)).map((a) => `${a.model.id} ${a.prompt.length}`)).toEqual([]);
  expect(o.compiled).toBe(false);
  const all = 12 * (`"EVIDENCE-1 is here" (f1.log:7)\n`.length + 25 * 800);
  expect(o.text.length).toBeLessThan(all / 4);
  expect(o.text.length).toBeLessThanOrEqual(34_000);
  for (let k = 1; k <= 12; k++) expect(o.text).toContain(`"EVIDENCE-${k} is here" (f${k}.log:7)`);
  expect(o.uncompiled).toMatchObject({ whole: 0, cut: 12, left: 0 });
  expect(o.uncompiled!.findings.length).toBeGreaterThan(all);
  const note = coverageNote(o, 12, undefined, "/state/spill/readers/findings.md");
  expect(note).toContain("could not be compiled");
  expect(note).toContain("the start of 12");
  expect(note).toContain("/state/spill/readers/findings.md");
});

test("the owner's small models read first, in their order, from any provider, skipping one not listed or too small", () => {
  const plan = m("luna", undefined, { provider: "plan", id: "plan:luna", family: "gpt", billing: "subscription" });
  const fall = m("haiku", 0.8, { provider: "q", id: "q:haiku" });
  const models = [...all, plan, fall];
  const ids = (need: number, own: string[]) => readerChoices(models, big, need, {}, undefined, own).map((x) => x.id);
  expect(ids(1000, ["gone:model", "plan:luna", "q:haiku"]).slice(0, 2)).toEqual(["plan:luna", "q:haiku"]);
  expect(ids(1000, ["q:haiku", "plan:luna"]).slice(0, 2)).toEqual(["q:haiku", "plan:luna"]);
  expect(ids(40_000, ["p:tiny", "q:haiku"])[0]).toBe("q:haiku");
});

test("an answer is checked against the material: quotes word for word at the lines cited, references that exist, quotes not found named", () => {
  const items = [
    { source: "notes/a.md", text: "# A\nThe crews go days without any link to shore, so the app must hold entries.\nOther text." },
    { source: "notes/b.md", text: "one\ntwo\nWe are moving another vendor's system out and into yours." },
  ];
  const answer = [
    "- **A** (notes/a.md:2): \u201cThe crews go days without any link to shore, so the app must hold entries.\u201d",
    "- **B** (`b.md:3`, `:9`)",
    '  "We are moving another vendor\'s system out ... and into yours."',
    '- C (notes/c.md:4): "a sentence nobody wrote down anywhere."',
  ].join("\n");
  const c = checkAnswer(answer, items);
  expect(c).toEqual({ quotes: 3, verbatim: 2, atLine: 2, loose: 0, refs: 4, valid: 2, ambiguous: 0, missing: ["a sentence nobody wrote down anywhere."] });
  expect(checkedNote(c)).toContain("2 of 3 quotes are word for word at the lines they cite; 2 of 4 path:line references");
  expect(checkedNote(c)).toContain('- "a sentence nobody wrote down anywhere."');
  expect(checkedNote(checkAnswer("no quotes and no references here", items))).toBe("");
});

test("a quote counts as at the line cited only word for word, case included, on the lines cited, in a file the path names alone, in a part a reader read", () => {
  const items = [
    { source: "x/a.md", text: "# X\nThe retry budget is seven attempts per job.\nOther text." },
    { source: "y/a.md", text: "# Y\nThe retry budget is nine attempts per job.\nOther text." },
    { source: "notes/b.md", text: "one\nThe Gateway refused the charge at noon.\nthree\nA line only the failed reader had in front of it.\n" },
  ];
  const one = (answer: string, read?: { source: string; from: number; to: number }[]) => checkAnswer(answer, items, read);
  // Exact, from a path that names one file: at the line cited.
  expect(one('- (x/a.md:2) "The retry budget is seven attempts per job."')).toMatchObject({ quotes: 1, verbatim: 1, atLine: 1, loose: 0, refs: 1, valid: 1, ambiguous: 0, missing: [] });
  // Two files end with a.md: the quote is in the material, but no line is confirmed.
  expect(one('- (a.md:2) "The retry budget is seven attempts per job."')).toMatchObject({ quotes: 1, verbatim: 1, atLine: 0, refs: 1, valid: 0, ambiguous: 1 });
  // Another case than the file has: not word for word, counted apart.
  const cased = one('- (notes/b.md:2) "the gateway refused the charge at noon."');
  expect(cased).toMatchObject({ quotes: 1, verbatim: 0, atLine: 0, loose: 1, missing: [] });
  expect(checkedNote(cased)).toContain("0 of 1 quotes are word for word at the lines they cite; 1 more matches the material only when case is ignored");
  // One line off: in the material, not at the line cited.
  const off = one('- (notes/b.md:3) "The Gateway refused the charge at noon."');
  expect(off).toMatchObject({ quotes: 1, verbatim: 1, atLine: 0, loose: 0, valid: 1 });
  expect(checkedNote(off)).toContain("0 of 1 quotes are word for word at the lines they cite; 1 more is word for word in the material but not on a line cited for it");
  // A part no reader read is not material the answer can be confirmed against.
  const read = [{ source: "x/a.md", from: 1, to: 3 }, { source: "y/a.md", from: 1, to: 3 }, { source: "notes/b.md", from: 1, to: 3 }];
  const failed = one('- (notes/b.md:4) "A line only the failed reader had in front of it."', read);
  expect(failed).toMatchObject({ quotes: 1, verbatim: 0, atLine: 0, loose: 0, refs: 1, valid: 0, missing: ["A line only the failed reader had in front of it."] });
  expect(one('- (notes/b.md:4) "A line only the failed reader had in front of it."')).toMatchObject({ verbatim: 1, atLine: 1, valid: 1 });
  // The line after the last one does not exist, with or without a newline at the end.
  expect(one("see notes/b.md:5 and x/a.md:4")).toMatchObject({ refs: 2, valid: 0 });
  expect(checkedNote(one('- (a.md:2) "The retry budget is seven attempts per job."'))).toContain("1 names a path that more than one file ends with");
});

test("a job holds its answer against the parts its readers read: a quote from a part every reader failed on is not confirmed", async () => {
  const h: ReaderHost = {
    models: async () => [big], current: async () => big, capture: () => {},
    ask: async (_m, prompt) => {
      if (/part 2 of/.test(prompt)) throw new Error("throttled");
      return { text: '- (a.log:3) "line 3 xxxxxxxxxxxxx"\n- (b.log:3) "bbbb 3 xxxxxxxxxxxxx"', usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
    },
  };
  const o = await readMaterial(h, [{ source: "a.log", text: lines(3_500) }, { source: "b.log", text: lines(3_500).replace("line 3 ", "bbbb 3 ") }], "q", new AbortController().signal);
  expect(o.parts.map((p) => p.state)).toEqual(["read", "unread"]);
  expect(o.checked).toMatchObject({ quotes: 2, verbatim: 1, atLine: 1, refs: 2, valid: 1, missing: ["bbbb 3 xxxxxxxxxxxxx"] });
});

test("parts no reader read are listed in part order, whichever failed first", async () => {
  const h: ReaderHost = {
    models: async () => [big], current: async () => big, capture: () => {}, env: { KEEL_READERS_AT_ONCE: "3" },
    ask: async (_m, prompt) => {
      const k = /part (\d+) of/.exec(prompt)![1];
      // Part 1 fails last, part 3 first.
      if (k === "1") { await Bun.sleep(30); throw new Error("throttled"); }
      if (k === "3") throw new Error("throttled");
      return { text: "found it at b.log:3", usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
    },
  };
  const o = await readMaterial(h, ["a.log", "b.log", "c.log"].map((source) => ({ source, text: lines(3_500) })), "q", new AbortController().signal);
  expect(o.unread.map((u) => u.split(" ")[0])).toEqual(["a.log", "c.log"]);
  const note = coverageNote(o, 3);
  expect(note.indexOf("- a.log (every reader failed")).toBeGreaterThan(0);
  expect(note.indexOf("- a.log (every reader failed")).toBeLessThan(note.indexOf("- c.log (every reader failed"));
});

test("the characters a job reports are the ones a reader read: a part that held nothing counts, a part every reader failed on does not", async () => {
  const files = [{ source: "a.log", text: lines(3_500) }, { source: "b.log", text: lines(3_400) + "\n" }, { source: "c.log", text: lines(3_300) }];
  const job = (fail: (k: string) => boolean) => readMaterial({
    models: async () => [big], current: async () => big, capture: () => {},
    ask: async (_m, prompt) => {
      const k = /part (\d+) of/.exec(prompt)![1]!;
      if (fail(k)) throw new Error("throttled");
      return { text: k === "3" ? NOTHING : "found it at a.log:3", usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
    },
  }, files, "q", new AbortController().signal);
  const [a, b, c] = files.map((f) => f.text.length) as [number, number, number];
  const mixed = await job((k) => k === "2");
  expect(mixed.parts.map((p) => p.state)).toEqual(["read", "unread", "nothing"]);
  expect(mixed.chars).toBe(a + c);
  expect(coverageNote(mixed, 3)).toContain(`(${a + c} chars)`);
  expect((await job(() => false)).chars).toBe(a + b + c);
  expect((await job(() => true)).chars).toBe(0);
});

test("readers at once: the default unless the override is a positive whole number, then exactly that", async () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ source: `f${i}.log`, text: lines(2_300) }));
  const most = async (override: string | undefined) => {
    let now = 0, top = 0;
    const o = await readMaterial({
      models: async () => [big], current: async () => big, capture: () => {}, env: { KEEL_READERS_AT_ONCE: override },
      ask: async () => {
        top = Math.max(top, ++now);
        await Bun.sleep(5);
        now--;
        return { text: NOTHING, usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
      },
    }, files, "q", new AbortController().signal);
    expect(o.parts.length).toBe(10);
    return top;
  };
  for (const bad of [undefined, "Infinity", "2.5", "0", "-3", "many", "1e400"]) expect(`${bad}: ${await most(bad)}`).toBe(`${bad}: ${READERS_AT_ONCE}`);
  expect(await most("3")).toBe(3);
  expect(await most("1")).toBe(1);
});
