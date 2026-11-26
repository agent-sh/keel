// A reading job a restart cut reads, when the turn sends it again, only the parts no reader answered yet; and the
// drain does not wait for a reading job.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { ModelInfo } from "../providers/types.ts";
import { drainWaitsFor, type DrainTurn } from "./drain-wait.ts";
import { NOTHING } from "./reader.ts";
import { FLUSH_MS, KEEP_MS, ReaderKept } from "./reader-kept.ts";
import { readMaterial, type ReaderHost } from "./readers.ts";

const m = (id: string, input: number): ModelInfo => ({ id: `p:${id}`, provider: "p", model: id, name: id, family: "claude", context: 200_000, output: 8_000, efforts: [], billing: "per_token", price: { input, output: input * 5 } as any });
const big = m("big", 5), small = m("small", 0.1);
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} `.padEnd(40, "x")).join("\n");

const host = (kept: ReaderKept, asked: string[], stopAfter?: { n: number; abort: AbortController }): ReaderHost => ({
  models: async () => [big, small], current: async () => big, capture: () => {}, env: { KEEL_READERS_AT_ONCE: "1" },
  kept: { get: (p) => kept.get("s", p), put: (p, a) => kept.put("s", p, a) },
  ask: async (_model, prompt) => {
    asked.push(prompt.startsWith("Readers each") ? "compile" : (/part (\d+) of/.exec(prompt)?.[1] ?? "1"));
    if (stopAfter && asked.length > stopAfter.n) { stopAfter.abort.abort(); throw Object.assign(new Error("stopped"), { name: "AbortError" }); }
    if (prompt.startsWith("Readers each")) return { text: "compiled", usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 } };
    return { text: prompt.includes("MARKER") ? "found it" : NOTHING, usage: { input: 1000, output: 20, cache_read: 0, cache_write: 0 } };
  },
});

test("a job cut after three parts, sent again on the next daemon, asks a reader only for the parts left", async () => {
  const db = new Database(":memory:");
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
  const db = new Database(":memory:");
  const k = new ReaderKept(db);
  k.put("s", "prompt", { text: "a", model: "small", input: 5 });
  db.close();
  const thrown: unknown[] = [];
  const on = (e: unknown) => void thrown.push(e);
  process.on("uncaughtException", on);
  await Bun.sleep(FLUSH_MS + 100);
  process.off("uncaughtException", on);
  expect(thrown).toEqual([]);
});

test("a kept answer is a restart's, not a day's: past KEEP_MS it is asked again", () => {
  const db = new Database(":memory:");
  let now = 1_000_000;
  const k = new ReaderKept(db, () => now);
  k.put("s", "prompt", { text: "a", model: "small", input: 5 });
  k.flush();
  expect(new ReaderKept(db, () => now).get("s", "prompt")?.text).toBe("a");
  expect(new ReaderKept(db, () => now).get("other", "prompt")).toBeUndefined();
  now += KEEP_MS;
  expect(new ReaderKept(db, () => now).get("s", "prompt")).toBeUndefined();
});

test("the drain does not wait for a reading job, nor for one beside a command in front of its turn", () => {
  const t: DrainTurn = { atBoundary: false, waitsOnOwner: false, providerWaiting: false, status: { kind: "tool" } as any, requestOut: false, betweenParts: false, callsOut: 1, inFront: false };
  expect(drainWaitsFor(t)).toBe(true);
  expect(drainWaitsFor({ ...t, kept: true })).toBe(false);
  expect(drainWaitsFor({ ...t, callsOut: 2, kept: true })).toBe(false);
});
