// The readers tool around a job: what it gathers before any reader runs.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gather } from "./readers.ts";
import type { ToolContext } from "./types.ts";
import { plainFetch } from "./web.ts";

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
