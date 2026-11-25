import { expect, test } from "bun:test";
import { digestOf, freeSlots, nextFree, needsOf, NEED_MS, plan, PushBudget, rank, SETTLE_MS, tierOf, WINDOW_MS, type Held } from "./budget.ts";

const row = (id: string, kind: string, ts: number, key?: number): Held => ({ id, ts, kind, ...(key === undefined ? {} : { wait: { key } }) });

test("the order of attention: needs you, failures, reports, done; the costliest wait first inside a class", () => {
  const rows = [
    row("done-1", "finished", 1), row("report-1", "agent", 2), row("fail-1", "failed", 3),
    row("need-cheap", "question", 4, 0.01), row("need-dear", "approval", 5, 0.4), row("need-old", "approval", 0, 0.01),
  ];
  expect(rank(rows).map((r) => r.id)).toEqual(["need-dear", "need-old", "need-cheap", "fail-1", "report-1", "done-1"]);
  expect(["approval", "mcp", "limit", "regression", "review", "snooze_over"].map(tierOf)).toEqual(["need", "need", "failed", "failed", "done", "report"]);
});

test("a plan tells what fits alone, folds the rest in one digest that has the last slot, holds all when no slot is free", () => {
  const needs = Array.from({ length: 8 }, (_, i) => row(`n${i}`, "approval", i, i === 5 ? 0.5 : 0));
  const p = plan(needs, 6);
  expect(p.alone.map((r) => r.id)).toEqual(["n5", "n0", "n1", "n2", "n3"]);
  expect(p.digest.map((r) => r.id)).toEqual(["n4", "n6", "n7"]);
  expect(p.held).toEqual([]);
  // Nothing is lost: every row is in exactly one list.
  for (const free of [0, 1, 2, 7, 8, 9, Infinity]) {
    const q = plan(needs, free);
    expect([...q.alone, ...q.digest, ...q.held].map((r) => r.id).sort()).toEqual(needs.map((r) => r.id).sort());
    expect(q.alone.length + (q.digest.length ? 1 : 0)).toBeLessThanOrEqual(Math.max(free === 0 ? 0 : free, 0));
  }
  expect(plan(needs, 0)).toMatchObject({ alone: [], digest: [], held: expect.any(Array) });
  expect(plan(needs.slice(0, 3), 3).alone).toHaveLength(3);
  // A done notice goes last: it is what the digest takes first.
  const mixed = [row("d", "finished", 0), ...needs.slice(0, 2)];
  expect(plan(mixed, 2)).toMatchObject({ alone: [{ id: "n0" }], digest: [{ id: "n1" }, { id: "d" }] });
});

test("the push for what needs you when no slot is free says how many and which", () => {
  expect(needsOf([{ ...row("a", "question", 1), label: "Which color?" }, { ...row("b", "approval", 2), label: "Run rm?" }]).body).toBe("2 need you: Which color?; Run rm?");
  const five = Array.from({ length: 5 }, (_, i) => ({ ...row(`q${i}`, "question", i), label: `Q${i}` }));
  expect(needsOf(five)).toEqual({ title: "5 need you", body: "5 need you: Q0; Q1; Q2; and 2 more" });
  expect(needsOf([row("x", "approval", 1)]).body).toBe("1 needs you");
});

test("slots of the hour: a push leaves it an hour later", () => {
  const t0 = 1_000_000;
  const sent = [t0, t0 + 10, t0 + 20];
  expect(freeSlots(sent, t0 + 30, 3)).toBe(0);
  expect(freeSlots(sent, t0 + 30, 5)).toBe(2);
  expect(freeSlots(sent, t0 + 30, 0)).toBe(Infinity);
  expect(nextFree(sent, t0 + 30, 3)).toBe(t0 + WINDOW_MS);
  expect(nextFree(sent, t0 + 30, 2)).toBe(t0 + 10 + WINDOW_MS);
  expect(nextFree(sent, t0 + 30, 4)).toBe(t0 + 30);
  expect(freeSlots(sent, t0 + WINDOW_MS + 15, 3)).toBe(2);
});

test("the digest says how many, what needs you first", () => {
  const d = digestOf([row("a", "finished", 1), row("b", "finished", 2), row("c", "failed", 3), row("d", "agent", 4)]);
  expect(d.body).toBe("4 more: 1 failed, 1 report, 2 done");
  expect(digestOf([row("a", "approval", 1), row("b", "question", 2), row("c", "finished", 3)]).body).toBe("3 more: 2 need you, 1 done");
  expect(digestOf([row("a", "approval", 1), row("b", "finished", 2)]).body).toBe("2 more: 1 needs you, 1 done");
});

// The runner on a clock and a timer list the test holds.
function rig(limit: number, seed: number[] = []) {
  let now = 10_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  const told: string[] = [];
  const open = new Set<string>();
  const b = new PushBudget<Held>({
    limit: () => limit,
    now: () => now,
    timer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clear: (t) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); },
    seed: () => seed,
    alone: async (i) => void told.push(i.id),
    digest: async (items) => void told.push(`digest:${items.map((i) => i.id).join("+")}`),
    over: async (items) => void told.push(`over:${items.map((i) => i.id).join("+")}`),
    moot: (i) => !open.has(i.id),
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((x, y) => x.at - y.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
      await Promise.resolve();
    }
    now = end;
  };
  return { b, told, open, advance, now: () => now, set: (n: number) => (limit = n) };
}

test("eight needs trickling in over a minute: six pushes, the seventh past the budget at once, the eighth ten minutes after it and not an hour", async () => {
  const r = rig(6);
  const done: Promise<void>[] = [];
  for (let i = 0; i < 8; i++) { r.open.add(`n${i}`); done.push(r.b.offer(row(`n${i}`, "approval", i))); await r.advance(5000); }
  await r.advance(SETTLE_MS);
  expect(r.told).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "over:n6"]);
  const at = r.now();
  expect(r.b.status()).toMatchObject({ limit: 6, sent: 6, over: 1, held: 1, held_need: 1 });
  // The eighth is held until ten minutes after the last push past the budget.
  const next = r.b.status().next_slot!;
  expect(next - at).toBeLessThan(NEED_MS);
  expect(next - at).toBeGreaterThan(NEED_MS - 60_000);
  await r.advance(next - at + 1);
  await Promise.all(done);
  expect(r.told).toEqual(["n0", "n1", "n2", "n3", "n4", "n5", "over:n6", "over:n7"]);
  expect(r.b.status()).toMatchObject({ held: 0, over: 2 });
});

test("a burst that comes at once is ranked together: five alone, one digest of the rest", async () => {
  const r = rig(6);
  const rows = [row("done", "finished", 0), ...Array.from({ length: 7 }, (_, i) => row(`n${i}`, "question", i + 1, i === 6 ? 0.3 : 0))];
  for (const x of rows) r.open.add(x.id);
  const all = rows.map((x) => r.b.offer(x));
  await r.advance(SETTLE_MS);
  await Promise.all(all);
  expect(r.told).toEqual(["n6", "n0", "n1", "n2", "n3", "digest:n4+n5+done"]);
});

test("with the hour full, needs go out at once in one push past the budget, then at most every ten minutes; the rest is held for a slot", async () => {
  const start = 10_000_000;
  const r = rig(3, [start - 30 * 60_000, start - 20 * 60_000, start - 10 * 60_000]);
  const all: Promise<void>[] = [];
  const offer = (id: string, kind: string) => { r.open.add(id); all.push(r.b.offer(row(id, kind, 1))); };
  for (const [id, kind] of [["a", "approval"], ["b", "question"], ["c", "approval"], ["done", "finished"]] as const) offer(id, kind);
  await r.advance(SETTLE_MS);
  expect(r.told).toEqual(["over:a+b+c"]);
  expect(r.b.status()).toMatchObject({ sent: 3, over: 1, held: 1, held_need: 0, next_slot: start - 30 * 60_000 + WINDOW_MS });
  // A second need two minutes later waits for the ten minutes; one answered while held is not told.
  await r.advance(2 * 60_000);
  offer("d", "approval"); offer("e", "approval");
  await r.advance(SETTLE_MS);
  expect(r.told).toEqual(["over:a+b+c"]);
  expect(r.b.status()).toMatchObject({ held: 3, held_need: 2 });
  r.open.delete("e");
  await r.advance(NEED_MS - 2 * 60_000 - SETTLE_MS);
  expect(r.told).toEqual(["over:a+b+c", "over:d"]);
  // The finished one waits for the slot: the oldest push of the hour is an hour old 30 minutes from the start.
  await r.advance(WINDOW_MS);
  await Promise.all(all);
  expect(r.told).toEqual(["over:a+b+c", "over:d", "done"]);
  expect(r.b.status()).toMatchObject({ held: 0 });
});

test("a limit of 0 is no limit", async () => {
  const r = rig(0);
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => { r.open.add(id); return r.b.offer(row(id, "finished", 1)); });
  await r.advance(SETTLE_MS);
  await Promise.all(all);
  expect(r.told).toHaveLength(8);
});
