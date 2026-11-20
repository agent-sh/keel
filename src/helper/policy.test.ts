import { expect, test } from "bun:test";
import type { StoredEvent } from "../core/types.ts";
import { keptMessages, OWNER_WORDS_BYTES } from "../engine/compact.ts";
import { levelOfAlert, nextWakeAt, recall, spike, type MemoryItem } from "./policy.ts";

test("what wakes the helper, what waits for the next turn, what is noise", () => {
  const long = 5 * 60_000;
  expect(["failed", "limit", "loop_failed"].map((k) => levelOfAlert(k, undefined, long))).toEqual(["wake", "wake", "wake"]);
  expect(["approval", "question", "agent"].map((k) => levelOfAlert(k, undefined, long))).toEqual(["feed", "feed", "feed"]);
  expect(levelOfAlert("finished", { ran_ms: long }, long)).toBe("feed");
  expect(levelOfAlert("finished", { ran_ms: 1000 }, long)).toBeNull();
  expect(levelOfAlert("snooze_over", undefined, long)).toBeNull();
});

test("a burst is one wake, and wakes are kept apart", () => {
  expect(nextWakeAt(1000, 0, 60, 600)).toBe(1060);
  expect(nextWakeAt(1000, 900, 60, 600)).toBe(1500);
  let times: number[] = [];
  const spikes: number[] = [];
  for (let t = 0; t < 12; t++) {
    const r = spike(times, t * 1000, 10_000, 5);
    times = r.times;
    if (r.spiked) spikes.push(t);
  }
  expect(spikes).toEqual([4, 9]); // one spike per five failures, never one per failure
  expect(spike([0, 1000], 20_000, 10_000, 3).spiked).toBe(false); // old ones left the window
});

test("recall: related items first, standing ones next, nothing twice, within budget", () => {
  const m = (id: string, kind: MemoryItem["kind"], text: string, updated = 0): MemoryItem => ({ id, ts: 0, updated, kind, text, source: "helper" });
  const items = [
    m("a", "fact", "The dentist appointment is on Thursday at 10:00"),
    m("b", "preference", "Replies in short sentences, no hedging"),
    m("c", "person", "Dana is the accountant; invoices go to her"),
    m("d", "fact", "The office router is in the hallway closet"),
  ];
  expect(recall(items, "Send the invoices to the accountant", new Set(), 2000).map((x) => x.id)).toEqual(["c", "b"]);
  expect(recall(items, "Send the invoices to the accountant", new Set(["c", "b"]), 2000).map((x) => x.id)).toEqual([]);
  expect(recall(items, "When is the dentist", new Set(), 80).map((x) => x.id)).toEqual(["a"]);
});

// A conversation that never ends: forty compactions, each after an owner
// message of about 3 KB naming a decision, with digest wakes in between.
test("many compactions keep the owner's newest words whole, within the budget, ahead of other input", () => {
  let lineage: StoredEvent[] = [];
  let seq = 0;
  const ev = (kind: StoredEvent["kind"], data: any): StoredEvent => ({ id: `e${++seq}`, seq, session_id: "h", kind, data, ts: seq, parent: null } as StoredEvent);
  const said = (i: number) => `Decision ${i}: keep the release on Friday. ${"context ".repeat(370)}`;
  for (let i = 0; i < 40; i++) {
    lineage.push(ev("user", { text: said(i) }));
    lineage.push(ev("user", { text: `[helper digest] event ${i} ${"x".repeat(2000)}`, kind: "helper_digest" }));
    lineage.push(ev("assistant", { blocks: [{ type: "text", text: "Noted." }] }));
    const kept = keptMessages(lineage);
    lineage = [ev("compaction", { mode: "summary", summary: `summary ${i}`, ...kept })];
  }
  const last = lineage[0]!.data;
  const bytes = last.owner_messages.reduce((n: number, t: string) => n + Buffer.byteLength(t), 0);
  expect(bytes).toBeLessThanOrEqual(OWNER_WORDS_BYTES);
  // The newest decisions are there, whole and in order; the oldest went to the summaries.
  const whole = last.owner_messages.filter((t: string) => !t.includes("were left out"));
  expect(whole.at(-1)).toBe(said(39));
  expect(whole.length).toBeGreaterThanOrEqual(15);
  expect(whole.map((t: string) => Number(t.match(/^Decision (\d+)/)?.[1]))).toEqual(whole.map((_: string, k: number) => 40 - whole.length + k));
  // Digest wakes only fill what his words left.
  const other = (last.other_messages ?? []).reduce((n: number, t: string) => n + Buffer.byteLength(t), 0);
  expect(bytes + other).toBeLessThanOrEqual(OWNER_WORDS_BYTES);
});
