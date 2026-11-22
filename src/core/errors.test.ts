// Failures the store cannot take (a full disk, a store that takes no writes): kept in memory, in the
// list the Errors panel reads, and written with their counts once the store takes rows again.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "./bus.ts";
import { ErrorTracker } from "./errors.ts";
import { Store } from "./store.ts";
import type { ErrorRecord } from "./types.ts";

test("a failure the store cannot take is kept, shown, counted, and written when the store takes rows again", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-errors-"));
  const store = new Store(dir);
  const bus = new Bus();
  const frames: ErrorRecord[] = [];
  bus.on((f: any) => { if (f.t === "error") frames.push(f.error); });
  const errors = new ErrorTracker(store, bus);
  const quiet = console.error;
  console.error = () => {};
  try {
    errors.capture("server", new Error("recorded before"));
    expect(errors.unwritten()).toEqual([]);
    // The store takes no writes (as on a full disk: SQLite refuses the statement).
    store.db.exec("PRAGMA query_only = ON");
    const a = errors.capture("server", new Error("the disk is full: ENOSPC"), { at: "append" });
    expect(a.id).toBe("unwritten-1");
    expect(a.unwritten).toContain("readonly");
    errors.capture("server", new Error("the disk is full: ENOSPC"), { at: "append" });
    const b = errors.capture("tool", new Error("a tool failed meanwhile"));
    // In the list, the newest first, a repeat counted on its row; the page was told of each.
    expect(errors.unwritten().map((e) => [e.id, e.message, e.count])).toEqual([[b.id, "a tool failed meanwhile", 1], ["unwritten-1", "the disk is full: ENOSPC", 2]]);
    expect(frames.filter((f) => f.id.startsWith("unwritten-")).map((f) => [f.id, f.count])).toEqual([["unwritten-1", 1], ["unwritten-1", 2], [b.id, 1]]);
    expect(store.errors().map((e) => e.message)).toEqual(["recorded before"]);
    // Still refused: a flush writes nothing and loses nothing.
    errors.flush();
    expect(errors.unwritten()).toHaveLength(2);
    // One the owner lets go is gone, and the page is told.
    expect(errors.dismiss(b.id)?.resolved_ts).toBeGreaterThan(0);
    expect(errors.dismiss(b.id)).toBeUndefined();
    expect(errors.unwritten().map((e) => e.id)).toEqual(["unwritten-1"]);

    // The store takes rows again: the next capture that is recorded writes what waited, with its count and its first time.
    store.db.exec("PRAGMA query_only = OFF");
    errors.capture("server", new Error("recorded after"));
    expect(errors.unwritten()).toEqual([]);
    const rows = store.errors();
    expect(rows.map((e) => e.message).sort()).toEqual(["recorded after", "recorded before", "the disk is full: ENOSPC"]);
    const kept = rows.find((e) => e.message.startsWith("the disk is full"))!;
    expect([kept.count, kept.first_ts, kept.context]).toEqual([2, a.first_ts, { at: "append" }]);
    // The page drops the row it showed from memory and takes the stored one.
    expect(frames.some((f) => f.id === "unwritten-1" && !!f.resolved_ts)).toBe(true);
    expect(frames.some((f) => f.id === kept.id)).toBe(true);
  } finally {
    console.error = quiet;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// What is kept is what the store would have kept: redacted first, one record a kind by the store's own
// fingerprint, and all of them held to a few megabytes, with what was dropped said.
test("a kept failure is redacted like a stored one, folded by kind, and bounded in bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-errors-"));
  const store = new Store(dir);
  // The store's concealment, as the daemon installs it: a secret's value is its placeholder.
  store.redact = (_s, _k, v) => JSON.parse(JSON.stringify(v).replaceAll("sk-live-hunter2", "[secret:1a2b]"));
  const bus = new Bus();
  const frames: ErrorRecord[] = [];
  bus.on((f: any) => { if (f.t === "error") frames.push(structuredClone(f.error)); });
  const errors = new ErrorTracker(store, bus);
  const quiet = console.error;
  console.error = () => {};
  try {
    store.db.exec("PRAGMA query_only = ON");
    const boom = Object.assign(new Error("the provider refused the key sk-live-hunter2"), { stack: "Error: sk-live-hunter2\n    at call" });
    const kept = errors.capture("provider", boom, { header: "Bearer sk-live-hunter2" });
    // In memory, on the bus and in the list: the placeholder, never the value.
    for (const seen of [kept, errors.unwritten()[0]!, ...frames]) expect(JSON.stringify(seen)).not.toContain("sk-live-hunter2");
    expect(kept.message).toBe("the provider refused the key [secret:1a2b]");
    expect(kept.context).toEqual({ header: "Bearer [secret:1a2b]" });

    // A hundred messages that differ by a number are one kind, as in the table: they push nothing else out.
    for (let n = 0; n < 100; n++) errors.capture("server", new Error(`request ${n} timed out after ${n * 10} ms`));
    expect(errors.unwritten().map((e) => [e.message.replace(/\b\d+\b/g, "N"), e.count])).toEqual([["request N timed out after N ms", 100], ["the provider refused the key [secret:1a2b]", 1]]);

    // A megabyte of context is not kept: the record says so. A long stack is cut.
    const big = errors.capture("tool", Object.assign(new Error("a tool failed with a large context"), { stack: "x".repeat(50_000) }), { blob: "y".repeat(1_000_000) });
    expect(JSON.stringify(big.context)).toContain("too large to keep in memory");
    expect(big.stack!.length).toBeLessThan(9_000);
    // Many kinds with all they may hold: the whole stays within a few megabytes, the oldest go, and that is said.
    for (let n = 0; n < 150; n++) errors.capture("tool", new Error(`kind ${"abcdefghijklmnopqrstuvwxyz"[n % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(n / 26)]} failed`), { blob: "z".repeat(18_000) });
    const list = errors.unwritten();
    expect(list.length).toBeLessThanOrEqual(101);
    expect(list.reduce((n, e) => n + JSON.stringify(e).length, 0)).toBeLessThan(2.5 * 1024 * 1024);
    const said = list.find((e) => /dropped from memory/.test(e.message))!;
    expect(said.count).toBeGreaterThan(50);
    expect(said.message).toContain(`${said.count} earlier failures were dropped from memory`);
    // The newest is there; the first kinds are the ones that went.
    expect(list.some((e) => e.message === "kind tf failed")).toBe(true);
    expect(list.some((e) => e.message.startsWith("the provider refused"))).toBe(false);
  } finally {
    console.error = quiet;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
