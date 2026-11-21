// The readers tool around a job: what it gathers before any reader runs.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaterial, type ReaderHost } from "../engine/readers.ts";
import type { ModelInfo } from "../providers/types.ts";
import { AskReaders, gather } from "./readers.ts";
import type { ToolContext } from "./types.ts";
import { htmlToText, plainFetch } from "./web.ts";

const DIR = mkdtempSync(join(tmpdir(), "keel-readers-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const ctxOf = (signal = new AbortController().signal): ToolContext =>
  ({ sessionId: "t", cwd: DIR, signal, spillDir: join(DIR, "spill"), seen: new Map() });
const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1} `.padEnd(99, "x")).join("\n") + "\n";
const size = (items: { text: string }[]) => items.reduce((n, m) => n + m.text.length, 0);

test("gathering stops at the job's budget before a file is read whole; the tail and every file after it are named", async () => {
  const dir = join(DIR, "files");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.txt"), rows(30, "a"));
  // 200 lines of text, then a megabyte no decoder takes: a whole read of this
  // file fails, a read that stops at the budget never reaches the tail.
  writeFileSync(join(dir, "big.txt"), Buffer.concat([Buffer.from(rows(200, "big")), Buffer.alloc(1_000_000, 0xff)]));
  writeFileSync(join(dir, "c.txt"), rows(30, "c"));
  writeFileSync(join(dir, "d.txt"), rows(30, "d"));
  const { items, skipped } = await gather({ paths: ["files/a.txt", "files/big.txt", "files/c.txt", "files/d.txt"] }, ctxOf(), { budget: 10_000 });
  expect(items.map((m) => m.source)).toEqual(["files/a.txt", "files/big.txt"]);
  expect(size(items)).toBeLessThanOrEqual(10_000);
  const big = items[1]!.text;
  expect(big.endsWith("x\n")).toBe(true);
  const kept = big.split("\n").length - 1;
  expect(kept).toBeGreaterThan(50);
  expect(skipped).toEqual([
    `files/big.txt after line ${kept} (past what one job reads, 10000 characters)`,
    "files/c.txt (past what one job reads, 10000 characters)",
    "files/d.txt (past what one job reads, 10000 characters)",
  ]);
});

// Local pages: each answer is held a moment, so fetches that run together overlap.
function pages() {
  const seen = { now: 0, most: 0, hits: [] as string[], sent: 0 };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.hits.push(path);
      seen.most = Math.max(seen.most, ++seen.now);
      await Bun.sleep(40);
      seen.now--;
      if (path !== "/huge") return new Response(rows(30, path), { headers: { "content-type": "text/plain" } });
      // 64 MB that exist only as far as the client reads them.
      let left = 1_000;
      const block = new TextEncoder().encode(rows(640, "huge"));
      return new Response(new ReadableStream({
        pull(c) { if (left-- <= 0) return c.close(); seen.sent += block.length; c.enqueue(block); },
      }), { headers: { "content-type": "text/plain" } });
    },
  });
  return { seen, server, url: (p: string) => `http://127.0.0.1:${server.port}${p}` };
}
// The tool's own fetch of a page, without the guard that keeps it off this machine.
const local = (url: string, o: any, signal?: AbortSignal) => plainFetch(new URL(url), o, signal);

test("pages share the job's budget and are fetched a few at a time; a page that is cut or never fetched is named", async () => {
  const { seen, server, url } = pages();
  try {
    const urls = [1, 2, 3, 4, 5, 6].map((i) => url(`/page-${i}`));
    const { items, skipped } = await gather({ urls }, ctxOf(), { budget: 8_000, atOnce: 2, fetch: local });
    expect(seen.most).toBe(2);
    expect(size(items)).toBeLessThanOrEqual(8_000);
    // In the order they were named, whichever came back first.
    expect(items.map((m) => m.label)).toEqual(urls.slice(0, items.length));
    expect(items.length).toBeGreaterThanOrEqual(2);
    // Every page is either read whole, or named: its tail, or the whole of it.
    expect(skipped.length).toBe(urls.length - 2);
    for (const u of urls.slice(2)) expect(skipped.filter((s) => s.startsWith(`${u} `) && s.includes("past what one job reads, 8000 characters")).length).toBe(1);
    expect(skipped.some((s) => /page-3 after line \d+ /.test(s))).toBe(true);
    // The pages past the budget were not fetched at all.
    expect(seen.hits).not.toContain("/page-5");
    expect(seen.hits).not.toContain("/page-6");

    // A file first: the pages get what it left.
    writeFileSync(join(DIR, "first.txt"), rows(50, "first"));
    const both = await gather({ paths: ["first.txt"], urls: [url("/page-1"), url("/page-2")] }, ctxOf(), { budget: 8_000, atOnce: 2, fetch: local });
    expect(size(both.items)).toBeLessThanOrEqual(8_000);
    expect(both.items[0]!.source).toBe("first.txt");
    expect(both.skipped.some((s) => s.includes("/page-2"))).toBe(true);

    // A body far past the budget is not downloaded whole.
    const huge = await gather({ urls: [url("/huge")] }, ctxOf(), { budget: 20_000, fetch: local });
    expect(size(huge.items)).toBeLessThanOrEqual(20_000);
    expect(huge.skipped).toEqual([expect.stringMatching(/\/huge after line \d+ \(past what one job reads, 20000 characters\)$/)]);
    expect(seen.sent).toBeLessThan(32_000_000);
  } finally {
    server.stop(true);
  }
});

test("a stop ends the gathering: nothing more is fetched", async () => {
  const ac = new AbortController();
  let calls = 0;
  const fetch = async () => { calls++; ac.abort(); return { text: rows(10, "p") }; };
  const urls = [1, 2, 3, 4].map((i) => `https://pages.example/${i}`);
  await expect(gather({ urls }, ctxOf(ac.signal), { budget: 50_000, atOnce: 1, fetch })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(1);

  let read = 0;
  const gone = new AbortController();
  gone.abort();
  writeFileSync(join(DIR, "late.txt"), rows(10, "late"));
  await expect(gather({ paths: ["late.txt"], urls }, ctxOf(gone.signal), { budget: 50_000, fetch: async () => { read++; return { text: "x" }; } })).rejects.toMatchObject({ name: "AbortError" });
  expect(read).toBe(0);
});

// A reader that reports long findings for every part and cannot compile them.
const model: ModelInfo = { id: "p:r", provider: "p", model: "r", name: "r", family: "claude", context: 400_000, output: 8_000, efforts: [], billing: "per_token", price: { input: 1, output: 5 } as any };
const noCompile: ReaderHost = {
  models: async () => [model], current: async () => model, capture: () => {},
  ask: async (_m, prompt) => {
    if (prompt.startsWith("Readers each")) throw new Error("throttled");
    const k = /part (\d+) of/.exec(prompt)![1];
    return { text: `"EVIDENCE-${k} is here" (logs/f${k}.log:7)\n${"More of the same finding. ".repeat(800)}`, usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
  },
};

test("when the findings cannot be compiled the working model gets a bounded preview, the path of the saved findings and what the preview covers", async () => {
  const dir = join(DIR, "logs");
  mkdirSync(dir);
  for (let i = 1; i <= 3; i++) writeFileSync(join(dir, `f${i}.log`), rows(1_400, `f${i}`));
  const ctx = ctxOf();
  ctx.readMaterial = (items, q) => readMaterial(noCompile, items, q, ctx.signal);
  const out = await AskReaders.run({ question: "where is the evidence?", paths: ["logs"] }, ctx);
  const text = out.content as string;
  const parts = (out.shown as any).readers.parts.length;
  expect(parts).toBeGreaterThan(3);
  // Far less than the findings (about 20,000 characters a part), all of which are in the file.
  expect(text.length).toBeLessThan(36_000);
  const path = /saved whole, in part order, to (\S+\.md)/.exec(text)?.[1];
  expect(path).toBeDefined();
  const saved = readFileSync(path!, "utf8");
  expect(saved.length).toBeGreaterThan(parts * 20_000);
  for (let k = 1; k <= parts; k++) {
    expect(text).toContain(`"EVIDENCE-${k} is here"`);
    expect(saved).toContain(`"EVIDENCE-${k} is here"`);
  }
  expect(text).toContain(`the start of the findings of ${parts} parts`);
  expect(text).toContain("could not be compiled");
  expect((out.shown as any).readers.compiled).toBe(false);
});

test("material is short when what would come back is: numbered lines and file headers count", async () => {
  // 1,900 one-character lines: 3,800 characters in the file, several times that once each line has its number.
  writeFileSync(join(DIR, "dots.txt"), "x\n".repeat(1_900));
  writeFileSync(join(DIR, "short.txt"), rows(20, "s"));
  let jobs = 0;
  const ctx = ctxOf();
  const reader: ReaderHost = { ...noCompile, ask: async () => ({ text: "Every line is an x (dots.txt:1).", usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } }) };
  ctx.readMaterial = (items, q) => { jobs++; return readMaterial(reader, items, q, ctx.signal); };
  const long = await AskReaders.run({ question: "what is in it?", paths: ["dots.txt"] }, ctx);
  expect(jobs).toBe(1);
  expect((long.content as string).length).toBeLessThan(8_000);
  expect(long.content).toContain("Every line is an x");
  const short = await AskReaders.run({ question: "what is in it?", paths: ["short.txt"] }, ctx);
  expect(jobs).toBe(1);
  expect(short.content).toContain("20\ts line 20");
  expect(short.content).toContain("no reader was used");
});

// A docs page: about 420,000 characters of markup and scripts around 22,000 of text.
const paragraphs = Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${i + 1} of the page says something useful here.</p>`).join("\n");
const docs = `<html><head><title>t</title><script>${"var a=1;".repeat(20_000)}</script></head><body>${paragraphs}<script>${"var b=2;".repeat(30_000)}</script></body></html>`;

test("a page of markup is charged for its text, not its markup: six fetched at once all come back whole", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(docs, { headers: { "content-type": "text/html" } }) });
  try {
    const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
    const one = await plainFetch(new URL(url("/one")), { spillDir: join(DIR, "spill"), whole: true });
    expect(one.text).toContain("Paragraph 400 of the page");
    expect(one.text.length).toBeLessThan(30_000);
    const six = await gather({ urls: [1, 2, 3, 4, 5, 6].map((i) => url(`/p${i}`)) }, ctxOf(), { budget: 700_000, atOnce: 6, fetch: local });
    expect(six.skipped).toEqual([]);
    expect(six.items.map((m) => m.text.length)).toEqual(Array(6).fill(one.text.length));
    expect(six.items.every((m) => m.text === one.text)).toBe(true);
    // One page whose markup alone is past the budget.
    const small = await gather({ urls: [url("/small")] }, ctxOf(), { budget: 100_000, fetch: local });
    expect(small.skipped).toEqual([]);
    expect(small.items[0]!.text).toBe(one.text);
  } finally {
    server.stop(true);
  }
});

test("pages are charged in the order named, whichever came back first, and a page that failed takes nothing", async () => {
  const page = (tag: string) => `<html><body>${Array.from({ length: 30 }, (_, i) => `<p>${`${tag} line ${i + 1} `.padEnd(92, "x")}</p>`).join("\n")}</body></html>`;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      await Bun.sleep(path === "/slow-1" ? 150 : 10);
      return new Response(page(path), { headers: { "content-type": "text/html" } });
    },
  });
  try {
    const urls = ["/slow-1", "/page-2", "/page-3"].map((p) => `http://127.0.0.1:${server.port}${p}`);
    const whole = (await plainFetch(new URL(urls[0]!), { spillDir: join(DIR, "spill"), whole: true })).text.length;
    const { items, skipped } = await gather({ urls }, ctxOf(), { budget: whole * 2 + 1_000, atOnce: 3, fetch: local });
    // The first two named are whole; the third, which came back before the first, is the one cut.
    expect(items.map((m) => [m.label, m.text.length >= whole - 1])).toEqual([[urls[0], true], [urls[1], true], [urls[2], false]]);
    expect(skipped).toEqual([expect.stringMatching(/\/page-3 after line \d+ \(past what one job reads/)]);

    // A fetch that fails gives back only what it took: nothing here, so the budget does not grow by its message.
    const bad = async (url: string, o: any, signal?: AbortSignal) => (url.endsWith("/bad") ? { text: "x".repeat(5_000), error: true } : local(url, o, signal));
    const after = await gather({ urls: [`http://127.0.0.1:${server.port}/bad`, urls[1]!, urls[2]!] }, ctxOf(), { budget: whole + 1_000, atOnce: 1, fetch: bad });
    expect(size(after.items)).toBeLessThanOrEqual(whole + 1_000);
    expect(after.skipped.length).toBe(2);
  } finally {
    server.stop(true);
  }
});

test("sources past the budget are counted by folder with the list in a file, so the result stays short", async () => {
  const root = join(DIR, "tree");
  for (let d = 1; d <= 12; d++) {
    mkdirSync(join(root, `pkg-${String(d).padStart(2, "0")}`), { recursive: true });
    for (let f = 1; f <= 25; f++) writeFileSync(join(root, `pkg-${String(d).padStart(2, "0")}`, `file-${String(f).padStart(2, "0")}.txt`), rows(4, `p${d}f${f}`));
  }
  const ctx = ctxOf();
  ctx.readBudget = async () => 12_100;
  const reader: ReaderHost = { ...noCompile, ask: async () => ({ text: "Nothing stands out (tree/pkg-01/file-01.txt:1).", usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } }) };
  ctx.readMaterial = (items, q) => readMaterial(reader, items, q, ctx.signal);
  const out = await AskReaders.run({ question: "what stands out?", paths: ["tree"] }, ctx);
  const text = out.content as string;
  const shown = (out.shown as any).readers;
  const left = 300 - shown.sources;
  expect(left).toBeGreaterThan(250);
  expect(text.split("\n").length).toBeLessThan(20);
  expect(text.length).toBeLessThan(3_000);
  expect(shown.unread.length).toBeLessThan(5);
  // The source the budget cut is named; the rest are counted, and all of them are in the file the note names.
  expect(text).toMatch(/tree\/pkg-\d+\/file-\d+\.txt after line \d+ \(past what one job reads, 12100 characters\)/);
  const m = /(\d+) sources \(past what one job reads, 12100 characters\): 25 in tree\/pkg-\d+\/.* All of them are listed in (\S+\.txt)/.exec(text);
  expect(Number(m?.[1])).toBe(left);
  const listed = readFileSync(m![2]!, "utf8").trim().split("\n");
  expect(listed.length).toBe(left);
  expect(listed.at(-1)).toBe("tree/pkg-12/file-25.txt");
});

test("a whole page keeps the text after a self-closed svg or script; only a cut page drops an open tail", () => {
  const page = '<p>before</p><svg width="1" height="1"/><p>after the mark</p><script src="/a.js"/><p>and the end</p>';
  expect(htmlToText(page)).toContain("after the mark");
  expect(htmlToText(page)).toContain("and the end");
  // Cut inside a script: the open tail is markup, not text.
  expect(htmlToText("<p>kept</p><script>var a = 1; var b =", true)).toBe("kept");
  expect(htmlToText('<p>kept</p><a href="/long', true)).toBe("kept");
});
