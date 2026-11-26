// The cache plan's stops across a daemon restart, with a stand-in provider
// whose cache keeps a prefix 2 s and refreshes it on a read: no warm read after
// the session's waits are gone or the session is held, none once the cache has
// lapsed (a daemon that was down), and the warm reads of one wait never cost
// more in all than one rewrite, however often the daemon starts again. A
// "restart" is a new CachePlans on the same store, as a new daemon makes.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import type { StoredEvent } from "../core/types.ts";
import type { WaitShape } from "./cache-plan.ts";
import { CachePlans, type PlanStep } from "./cache-plans.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-cache-plans-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(join(dir, "state"));
setDefaultTimeout(20_000);
const MODEL = "standin:m";
const LIFE = 2_000; // margin 500 ms: a warm read 1.25 s after the last, while the cache holds
const TOKENS = 100_000;
// A read of the context costs $0.05, a rewrite $0.125: at most two warm reads a wait.
const price = { input: 1, output: 0, cache_read: 0.5, cache_write: 1.25 };
const st: PlanStep = { provider: { id: "standin", family: "other", caching: { life: LIFE, refresh: "read" }, available: () => true, list: async () => [], stream: async () => { throw new Error("not here"); } }, info: { id: MODEL, provider: "standin", model: "m", name: "m", family: "other", context: 200_000, output: 1000, efforts: [], billing: "per_token", price } };

type World = { shape?: WaitShape; held: boolean; calls: number[] };
function daemon(w: World) {
  return new CachePlans({
    store, errors: { capture: () => ({}) } as any,
    append: (id, kind, data) => store.append(id, kind, data as any),
    isRunning: () => false, isHeld: () => w.held, draining: () => false,
    waitShape: () => w.shape, replan: () => {},
    call: async () => {
      w.calls.push(Date.now());
      return { blocks: [], usage: { input: 0, cache_read: TOKENS, cache_write: 0, output: 0, cost: 0.05 }, stop: "max_tokens", model: "m" };
    },
    prepare: () => {},
  });
}
const replied = (ts: number): StoredEvent[] => [{ id: "a", session_id: "s", seq: 1, ts, kind: "assistant", data: { model: MODEL, blocks: [], usage: { input: 0, cache_read: TOKENS, cache_write: 0, output: 1 } } } as any];
const park = (plans: CachePlans, id: string, shape: WaitShape, touched: number) =>
  plans.park(store.session(id)!, st, replied(touched), shape, { tokens: TOKENS, step: async () => st, messages: () => [] });
const notes = (id: string) => store.events(id).filter((e) => e.kind === "note" && e.data.kind === "cache_plan").map((e) => e.data);

test("no warm read after the session's waits are gone or it is held", async () => {
  for (const stop of ["cancelled", "held"] as const) {
    const id = store.createSession({ model: MODEL, workspace: dir, title: stop }).id;
    const w: World = { shape: { kind: "file", since: Date.now() }, held: false, calls: [] };
    const plans = daemon(w);
    expect(park(plans, id, w.shape!, Date.now())?.choice).toBe("warm");
    await Bun.sleep(1_400);
    expect(w.calls).toHaveLength(1);
    if (stop === "cancelled") w.shape = undefined; else w.held = true;
    await Bun.sleep(1_500);
    expect(w.calls).toHaveLength(1);
    expect(plans.of(id)).toBeUndefined();
    // A held session after a restart gets no plan from its start either (the engine skips it: Engine.planPark).
    plans.stopAll();
  }
});

test("a daemon that starts after the cache lapsed sends nothing for it", async () => {
  const id = store.createSession({ model: MODEL, workspace: dir, title: "lapsed" }).id;
  const w: World = { shape: { kind: "file", since: Date.now() - 10_000 }, held: false, calls: [] };
  const plans = daemon(w);
  expect(park(plans, id, w.shape!, Date.now() - 1_600)).toMatchObject({ choice: "lapse", why: expect.stringContaining("lapsed") });
  await Bun.sleep(600);
  expect(w.calls).toHaveLength(0);
  plans.stopAll();
});

test("the warm reads of one wait stay under one rewrite across restarts", async () => {
  const id = store.createSession({ model: MODEL, workspace: dir, title: "cap" }).id;
  const since = Date.now();
  const w: World = { shape: { kind: "file", since }, held: false, calls: [] };
  let plans = daemon(w);
  park(plans, id, w.shape!, Date.now());
  await Bun.sleep(1_400);
  expect(w.calls).toHaveLength(1);
  // A restart: the same wait goes on from what its warm reads cost, read from the store.
  plans.stopAll();
  plans = daemon(w);
  expect(park(plans, id, w.shape!, w.calls.at(-1)!)?.choice).toBe("warm");
  await Bun.sleep(1_400);
  expect(w.calls).toHaveLength(2);
  plans.stopAll();
  plans = daemon(w);
  // Two reads for $0.10: a third would pass the $0.125 of a rewrite.
  expect(park(plans, id, w.shape!, w.calls.at(-1)!)?.choice).toBe("lapse");
  await Bun.sleep(1_400);
  expect(w.calls).toHaveLength(2);
  plans.end(id, "woke");
  expect(notes(id).at(-1)).toMatchObject({ pings: 2, spent_usd: 0.1 });
  // A new wait starts its own count.
  plans = daemon(w);
  w.shape = { kind: "file", since: Date.now() };
  expect(park(plans, id, w.shape, Date.now())?.choice).toBe("warm");
  plans.stopAll();
});

// A tool step whose last request read the cache longer ago than its lifetime: the cache was gone
// before the step began, and the note says so, not that the wait lost it.
test("a cache gone before its wait began is told as gone before it", () => {
  const id = store.createSession({ model: MODEL, workspace: dir, title: "gone before" }).id;
  const plans = daemon({ held: false, calls: [] });
  const usage = { input: 0, cache_read: TOKENS, cache_write: 0, output: 1 };
  const done = plans.tool(id, st, replied(Date.now() - 3_000), () => [], { kind: "tool:Bash" }, Date.now() - 3_000, usage);
  done();
  expect(notes(id).at(-1)).toMatchObject({ outcome: "lapsed", before_wait: true, text: expect.stringMatching(/^The prompt cache had lapsed before this wait began, 3 s after the request that last read it: nothing could keep it/) });
  expect(notes(id).at(-1)!.idle_ms).toBeGreaterThanOrEqual(3_000);
  plans.stopAll();
});

// A tool step kept warm is told once the next request says whether it read the cache: read, a failed warm
// named so when it wrote the context again, or not known when no request came while the cache lived.
test("a wait kept warm is told by what the next request read", async () => {
  const usage = { input: 0, cache_read: TOKENS, cache_write: 0, output: 1 };
  const kept = async (title: string) => {
    const id = store.createSession({ model: MODEL, workspace: dir, title }).id;
    const w: World = { held: false, calls: [] };
    const plans = daemon(w);
    const done = plans.tool(id, st, replied(Date.now()), () => [], { kind: "tool:Bash" }, Date.now(), usage);
    await Bun.sleep(1_400);
    expect(w.calls).toHaveLength(1);
    done();
    // Nothing is told before the next request answers.
    expect(notes(id)).toHaveLength(0);
    expect(plans.owes(id)).toBe(true);
    return { id, plans };
  };
  const a = await kept("read");
  a.plans.answered(a.id, { route: MODEL, usage: { input: 10, cache_read: TOKENS, cache_write: 200, output: 5 }, sentAt: Date.now() });
  expect(notes(a.id)).toEqual([expect.objectContaining({ outcome: "warm", pings: 1, next_read_tokens: TOKENS, text: expect.stringMatching(/^Kept the prompt cache warm through a wait of 1 s: 1 warm request for \$0\.050, and the next request read it/) })]);
  const b = await kept("missed");
  b.plans.answered(b.id, { route: MODEL, usage: { input: 10, cache_read: 3_000, cache_write: 97_000, output: 5 }, sentAt: Date.now() });
  expect(notes(b.id)).toEqual([expect.objectContaining({ outcome: "warm_missed", next_read_tokens: 3_000, next_written_tokens: 97_010, text: expect.stringMatching(/^The warm requests did not keep the prompt cache through a wait of 1 s: 1 warm request for \$0\.050, and the next request read 3,000 of 100,000 tokens and wrote the rest again/) })]);
  // A miss the ledger names by another cause (an urgent build, an edited instruction file, an
  // effort change) is not the warm requests'; one it names theirs is.
  const f = await kept("prefix changed");
  f.plans.answered(f.id, { route: MODEL, usage: { input: 10, cache_read: 3_000, cache_write: 97_000, output: 5 }, sentAt: Date.now(), cause: "prefix_changed" });
  expect(notes(f.id)).toEqual([expect.objectContaining({ outcome: "warm_unchecked" })]);
  const g = await kept("warm missed");
  g.plans.answered(g.id, { route: MODEL, usage: { input: 10, cache_read: 3_000, cache_write: 97_000, output: 5 }, sentAt: Date.now(), cause: "warm_missed" });
  expect(notes(g.id)).toEqual([expect.objectContaining({ outcome: "warm_missed" })]);
  // Another route's request says nothing of this cache; nor does none at all, once the cache's lifetime passed.
  const c = await kept("other route");
  c.plans.answered(c.id, { route: "standin:other", usage: { input: 10, cache_read: 0, cache_write: 97_000, output: 5 }, sentAt: Date.now() });
  expect(notes(c.id)).toEqual([expect.objectContaining({ outcome: "warm_unchecked" })]);
  const d = await kept("none");
  await Bun.sleep(LIFE); // (the last read was 1.25 s into the step: its cache lived 2 s from there)
  expect(notes(d.id)).toEqual([expect.objectContaining({ outcome: "warm_unchecked", text: expect.stringMatching(/so whether they kept it is not known$/) })]);
  // A session deleted while its note is owed is told nothing, and nothing fails.
  const e = await kept("deleted");
  store.deleteSession(e.id);
  const failed: unknown[] = [];
  (e.plans as any).d.errors = { capture: (...x: unknown[]) => { failed.push(x); return {}; } };
  e.plans.answered(e.id, { route: MODEL, usage: { input: 10, cache_read: TOKENS, cache_write: 200, output: 5 }, sentAt: Date.now() });
  expect([e.plans.owes(e.id), failed]).toEqual([false, []]);
  for (const p of [a, b, c, d, e, f, g]) p.plans.stopAll();
});

// A step the load hold keeps waiting: its turn runs, but the wait is a long one the session set, so its cache is
// kept by its plan, the warm read sent with the history before the last reply (where that request's cache is).
test("a step held for the machine keeps its cache warm while its turn waits", async () => {
  const id = store.createSession({ model: MODEL, workspace: dir, title: "held" }).id;
  const w: World = { held: false, calls: [] };
  const sent: unknown[][] = [];
  const plans = new CachePlans({
    store, errors: { capture: () => ({}) } as any,
    append: (sid, kind, data) => store.append(sid, kind, data as any),
    isRunning: () => true, isHeld: () => false, draining: () => false,
    waitShape: () => undefined, replan: () => {},
    call: async (_sid, _st, messages) => {
      w.calls.push(Date.now());
      sent.push(messages);
      return { blocks: [], usage: { input: 0, cache_read: TOKENS, cache_write: 0, output: 0, cost: 0.05 }, stop: "max_tokens", model: "m" };
    },
    prepare: () => {},
  });
  const asked: number[] = [];
  const before = (seq: number) => { asked.push(seq); return [{ role: "user", content: [{ type: "text", text: "the task" }] }] as any; };
  const done = plans.held(id, st, replied(Date.now()), { kind: "load", since: Date.now(), deadline: Date.now() + 600_000 }, TOKENS, before);
  await Bun.sleep(1_400);
  expect(w.calls).toHaveLength(1);
  expect(asked).toEqual([1]);
  expect(JSON.stringify(sent[0])).toContain("the task");
  done();
  expect(plans.owes(id)).toBe(true);
  // A session with no reply yet (a new agent held before its first step) has no cache to keep.
  const none = plans.held(store.createSession({ model: MODEL, workspace: dir, title: "new" }).id, st, [], { kind: "load" }, TOKENS, before);
  none();
  plans.stopAll();
});
