// A reading job a restart cut reads, when the turn sends it again, only the parts no reader answered yet; and the
// drain does not wait for a reading job.
import { Database } from "bun:sqlite";
import { READ_CUT, stopKind } from "../core/stops.ts";
import { expect, test } from "bun:test";
import { tempTree } from "../../test/env.ts";
import type { ModelInfo } from "../providers/types.ts";
import { drainWaitsFor, type DrainTurn } from "./drain-wait.ts";
import { NOTHING } from "./reader.ts";
import { FLUSH_MS, KEEP_MS, PRUNE_MS, ReaderKept } from "./reader-kept.ts";

// A database with the sessions the rows belong to (a row of a session that is gone is not written).
const dbOf = (...ids: string[]) => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
  for (const id of ids.length ? ids : ["s"]) db.query("INSERT INTO sessions (id) VALUES (?)").run(id);
  return db;
};
import { readMaterial, type ReaderHost } from "./readers.ts";

const m = (id: string, input: number): ModelInfo => ({ id: `p:${id}`, provider: "p", model: id, name: id, family: "claude", context: 200_000, output: 8_000, efforts: [], billing: "per_token", price: { input, output: input * 5 } as any });
const big = m("big", 5), small = m("small", 0.1);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} `.padEnd(40, "x")).join("\n");
const scratch = { dir: tempTree("reader-kept-") };

const host = (kept: ReaderKept, asked: string[], stopAfter?: { n: number; abort: AbortController }): ReaderHost => ({
  scratch,
  models: async () => [big, small], current: async () => big, capture: () => {}, env: { KEEL_READERS_AT_ONCE: "1" },
  kept: { get: (p, model) => kept.get("s", model, p), put: (p, model, a) => kept.put("s", model, p, a) },
  ask: async (_model, prompt) => {
    asked.push(prompt.startsWith("Readers each") ? "compile" : (/part (\d+) of/.exec(prompt)?.[1] ?? "1"));
    if (stopAfter && asked.length > stopAfter.n) { stopAfter.abort.abort(); throw Object.assign(new Error("stopped"), { name: "AbortError" }); }
    if (prompt.startsWith("Readers each")) return { text: "compiled", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 } };
    return { text: prompt.includes("MARKER") ? "found it" : NOTHING, usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
  },
});

test("a job cut after three parts, sent again on the next daemon, asks a reader only for the parts left", async () => {
  const db = dbOf();
  const text = lines(20_000).replace("line 3 ", "MARKER ");
  const first: string[] = [];
  const abort = new AbortController();
  const cutDaemon = new ReaderKept(db);
  await expect(readMaterial(host(cutDaemon, first, { n: 3, abort }), [{ source: "a.log", text }], "where is the marker?", abort.signal)).rejects.toThrow();
  expect(first).toEqual(["1", "2", "3", "4"]);
  // The stop flushes what was read (Engine.park); the next daemon has a store of its own on the same file.
  cutDaemon.flush();
  const next = new ReaderKept(db);
  const again: string[] = [];
  const o = await readMaterial(host(next, again), [{ source: "a.log", text }], "where is the marker?", new AbortController().signal);
  expect(o.text).toBe("found it");
  expect(o.parts.every((p) => p.state === "read" || p.state === "nothing")).toBe(true);
  const parts = o.parts.length;
  expect(parts).toBeGreaterThan(4);
  // Parts 1 to 3 were answered before the cut: not asked again.
  expect(again).not.toContain("1");
  expect(again).not.toContain("3");
  expect(again).toHaveLength(parts - 3);
});

test("rows that wait when their store closes are dropped, not thrown", async () => {
  const db = dbOf();
  const k = new ReaderKept(db);
  k.put("s", "p:small", "prompt", { text: "a", model: "small", input: 5 });
  db.close();
  const thrown: unknown[] = [];
  const on = (e: unknown) => void thrown.push(e);
  process.on("uncaughtException", on);
  await Bun.sleep(FLUSH_MS + 100);
  process.off("uncaughtException", on);
  expect(thrown).toEqual([]);
});

test("a kept answer is a restart's, not a day's: past KEEP_MS it is asked again", () => {
  const db = dbOf();
  let now = 1_000_000;
  const k = new ReaderKept(db, { now: () => now });
  k.put("s", "p:small", "prompt", { text: "a", model: "small", input: 5 });
  k.flush();
  expect(new ReaderKept(db, { now: () => now }).get("s", "p:small", "prompt")?.text).toBe("a");
  expect(new ReaderKept(db, { now: () => now }).get("other", "p:small", "prompt")).toBeUndefined();
  now += KEEP_MS;
  expect(new ReaderKept(db, { now: () => now }).get("s", "p:small", "prompt")).toBeUndefined();
});

test("the drain does not wait for a reading job, nor for one beside a command in front of its turn", () => {
  const t: DrainTurn = { atBoundary: false, waitsOnOwner: false, providerWaiting: false, status: { kind: "tool" } as any, requestOut: false, betweenParts: false, callsOut: 1, inFront: false };
  expect(drainWaitsFor(t)).toBe(true);
  expect(drainWaitsFor({ ...t, kept: true })).toBe(false);
  expect(drainWaitsFor({ ...t, callsOut: 2, kept: true })).toBe(false);
});

test("an answer is kept as stored text is (sealed), only by the reader that wrote it, and goes with its session", () => {
  const db = dbOf("s", "gone");
  const k = new ReaderKept(db, { seal: (_s, t) => t.replaceAll("hunter2", "[secret:x]") });
  k.put("s", "p:small", "prompt", { text: "the key is hunter2", model: "small", input: 5 });
  k.put("gone", "p:small", "prompt", { text: "b", model: "small", input: 5 });
  db.query("DELETE FROM sessions WHERE id = 'gone'").run();
  k.flush();
  const next = new ReaderKept(db);
  expect(next.get("s", "p:small", "prompt")?.text).toBe("the key is [secret:x]");
  expect(db.query("SELECT text FROM reader_kept").all()).toEqual([{ text: "the key is [secret:x]" }]);
  // Another reader's answer is not this one's.
  expect(next.get("s", "p:big", "prompt")).toBeUndefined();
  expect(next.get("gone", "p:small", "prompt")).toBeUndefined();
});

test("old rows go at the start and on the timer, not only when a job writes", () => {
  const db = dbOf();
  let now = 1_000_000;
  const k = new ReaderKept(db, { now: () => now });
  k.put("s", "p:small", "prompt", { text: "a", model: "small", input: 5 });
  k.job("s", "call", 3, 10);
  k.flush();
  k.close();
  now += KEEP_MS + 1;
  new ReaderKept(db, { now: () => now }).start();
  expect(db.query("SELECT COUNT(*) AS n FROM reader_kept").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM reader_jobs").get()).toEqual({ n: 0 });
  expect(PRUNE_MS).toBeLessThan(KEEP_MS);
});

test("a reading call a restart cut says how many of its parts are kept and to send the same call again", async () => {
  const db = dbOf();
  const text = lines(20_000);
  const abort = new AbortController();
  const cut = new ReaderKept(db);
  const asked: string[] = [];
  const h = host(cut, asked, { n: 3, abort });
  h.progress = (p) => cut.job("s", "call-1", p.parts.filter((x) => x.state === "read" || x.state === "nothing").length, p.parts.length);
  await expect(readMaterial(h, [{ source: "a.log", text }], "where?", abort.signal)).rejects.toThrow();
  cut.flush();
  const words = new ReaderKept(db).cutWords("s", "call-1");
  const total = Number(/of (\d+) parts/.exec(words)?.[1]);
  expect(total).toBeGreaterThan(4);
  expect(words).toContain(`3 of ${total} parts were read`);
  expect(words).toContain(`${total - 3} parts left`);
  expect(words).toContain("same call again unchanged");
  expect(stopKind(words)).toBe("cut");
  // A job that told nothing yet still says the call can be sent again.
  const none = new ReaderKept(db).cutWords("s", "other");
  expect(none.startsWith(READ_CUT)).toBe(true);
  expect(stopKind(none)).toBe("cut");
});
