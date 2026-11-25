// The title request as the engine sends it (src/engine/title.ts): after the
// turn, never part of the session's status, never on the session's own model,
// and made again when the first prompt changed while one was out.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { TurnStatus } from "../core/types.ts";
import { ProviderError } from "../providers/http.ts";
import { Telemetry } from "../admin/telemetry.ts";
import { allHooks } from "./hooks.ts";
import { PromptStore } from "./prompt-store.ts";
import { Engine } from "./turn.ts";

const dirs: string[] = [];
afterAll(async () => {
  // (A test loaded a folder's settings: the file's place goes back to the process's own before it is removed.)
  (await import("../admin/settings.ts")).loadSettings(process.env.KEEL_STATE_DIR!, () => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const model = (name: string, input: number) => ({ id: `p:${name}`, provider: "p", model: name, name, family: "other", context: 100_000, output: 4_000, efforts: [], billing: "per_token", price: { input, output: input * 5 } });
const BIG = model("big", 10), SMALL = model("small", 1);
const said = (text: string) => ({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" });

// `title(req, n)`: the answer to the n-th title request (it may throw or wait).
function rig(listed: any[], title: (req: any, n: number) => Promise<any>, turn: (req: any) => Promise<any> = async () => said("Done.")) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "title-run-"));
  dirs.push(dir);
  const store = new Store(dir);
  const bus = new Bus();
  const asked: any[] = [];
  let n = 0;
  const provider = {
    id: "p", wire: "anthropic_messages", available: () => true, list: async () => [],
    stream: async (req: any) => { asked.push(req); return req.purpose === "title" ? title(req, n++) : turn(req); },
  };
  const providers = { resolve: async (id: string) => ({ provider, info: listed.find((m) => m.id === id) ?? BIG }), models: async () => listed, current: () => listed };
  const engine = new Engine(store, bus, providers as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }), recovered: () => {} } as any, join(dir, "spill"));
  (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
  const s = store.createSession({ model: BIG.id, workspace: dir });
  const statuses: TurnStatus[] = [];
  bus.on((f: any) => { if (f.t === "status" && f.session_id === s.id) statuses.push(f.status); });
  return { store, engine, s, asked, statuses, titled: (t: string) => waitFor(() => store.session(s.id)!.title === t) };
}

async function waitFor(ok: () => boolean, ms = 3_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(5)) if (ok()) return;
  throw new Error("timed out");
}

test("a title request that is retried says nothing in the session's status", async () => {
  const busy = new ProviderError("overloaded", "overloaded", 529, 1);
  const { engine, s, statuses, titled, asked } = rig([BIG, SMALL], async (_req, n) => { if (n === 0) throw busy; return said("Cart discounts"); });
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  const after = statuses.length;
  await titled("Cart discounts");
  // Asked twice of the small model: the retry was the request's own.
  expect(asked.filter((r) => r.purpose === "title").map((r) => r.model)).toEqual(["small", "small"]);
  expect(statuses.slice(after)).toEqual([]);
});

test("with no model cheaper than the session's own, no title is asked for", async () => {
  const { engine, s, asked, store } = rig([BIG], async () => said("Should not be asked"));
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  await Bun.sleep(50);
  expect(asked.filter((r) => r.purpose === "title")).toEqual([]);
  expect(store.session(s.id)!.title).toBe("Fix the cart discount rounding");
});

test("a session with no title choice is not looked at again at the next turn's end", async () => {
  const { engine, s, asked } = rig([BIG], async () => said("Should not be asked"));
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  await waitFor(() => !(engine as any).titling.has(s.id));
  expect((engine as any).untitled.has(s.id)).toBe(true);
  expect(asked.filter((r) => r.purpose === "title")).toEqual([]);
});

// The spend limit holds for every request: a title's skips the hooks that add to a conversation, not the limit.
test("over the spend limit no title is asked for", async () => {
  const { loadSettings, patchSettings } = await import("../admin/settings.ts");
  const costly = { ...said("Done."), usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, cost: 1 } };
  const { engine, s, asked, store } = rig([BIG, SMALL], async () => said("Should not be asked"), async () => costly);
  loadSettings(store.stateDir, () => {});
  new PromptStore(store);
  const before = allHooks().length;
  new Telemetry(store, new Bus());
  const mine = allHooks().slice(before);
  try {
    expect(patchSettings({ budget: { daily_usd: 0.5, monthly_usd: null } }).ok).toBe(true);
    // The turn's one request is under the limit when it is sent; its cost takes the day over it.
    engine.send(s.id, "Fix the cart discount rounding");
    await engine.idle(s.id);
    await waitFor(() => ((engine as any).titleFails.get(s.id) ?? 0) > 0);
    expect(asked.map((r) => r.purpose ?? "turn")).toEqual(["turn"]);
    expect(store.session(s.id)!.title).toBe("Fix the cart discount rounding");
  } finally {
    for (const h of mine) allHooks().splice(allHooks().indexOf(h), 1);
    patchSettings({ budget: { daily_usd: null, monthly_usd: null } });
  }
});

test("a first prompt edited while its title is out is titled from the new prompt", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { engine, s, store, titled } = rig([BIG, SMALL], async (req, n) => {
    if (n === 0) { await held; return said("Old task"); }
    return said(JSON.stringify(req.messages).includes("Count the items") ? "Count cart items" : "Wrong one");
  });
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  await waitFor(() => (engine as any).titling.has(s.id));
  const first = store.events(s.id).find((e) => e.kind === "user")!;
  await engine.edit(s.id, first.id, "Count the items in the cart");
  await engine.idle(s.id);
  release();
  await titled("Count cart items");
  expect(store.session(s.id)!.title_by).toBe("model");
});

// A model-made title costs a request a session: with the setting off none is made, and the title stays
// the first line of the first prompt, cut.
test("with model titles off no title request is made", async () => {
  const { loadSettings, patchSettings } = await import("../admin/settings.ts");
  const { engine, s, asked, store } = rig([BIG, SMALL], async () => said("Should not be asked"));
  loadSettings(store.stateDir, () => {});
  try {
    expect(patchSettings({ titles: { by_model: false } }).ok).toBe(true);
    engine.send(s.id, `Fix the cart discount rounding in the checkout flow\nsecond line ${"x".repeat(200)}`);
    await engine.idle(s.id);
    await Bun.sleep(100);
    expect(asked.map((r) => r.purpose ?? "turn")).toEqual(["turn"]);
    expect(store.session(s.id)!.title).toBe("Fix the cart discount rounding in the checkout flow");
    expect(store.session(s.id)!.title_by).toBe("prompt");
  } finally {
    patchSettings({ titles: { by_model: true } });
  }
});

// A prompt that reached the history by another way than `send` (a queued one delivered when its turn
// came) gave the session no title: the session read "New session" for ever.
test("a session whose first prompt came by the queue is titled at its first reply's end", async () => {
  const { engine, s, store, titled } = rig([BIG, SMALL], async () => said("Cart discount rounding"));
  const q = store.enqueue(s.id, "Fix the cart discount rounding", false, undefined, undefined);
  (engine as any).deliver(q.id, "queued", { turn: true });
  expect(store.session(s.id)!.title).toBe("");
  (engine as any).start(s.id);
  await engine.idle(s.id);
  await titled("Cart discount rounding");
  expect(store.session(s.id)!.title_by).toBe("model");
});

test("with model titles off a session that never had a title gets its first prompt's line", async () => {
  const { loadSettings, patchSettings } = await import("../admin/settings.ts");
  const { engine, s, store } = rig([BIG, SMALL], async () => said("Should not be asked"));
  loadSettings(store.stateDir, () => {});
  try {
    expect(patchSettings({ titles: { by_model: false } }).ok).toBe(true);
    const q = store.enqueue(s.id, "Fix the cart discount rounding", false, undefined, undefined);
    (engine as any).deliver(q.id, "queued", { turn: true });
    (engine as any).start(s.id);
    await engine.idle(s.id);
    await waitFor(() => store.session(s.id)!.title === "Fix the cart discount rounding");
    expect(store.session(s.id)!.title_by).toBe("prompt");
  } finally {
    patchSettings({ titles: { by_model: true } });
  }
});

// One failed request (a provider that was down for a minute) is not the end of the session's title:
// the next turn's end asks again. A failure that repeats is given up after a few turn ends.
test("a failed title request is asked again at a later turn's end, a few times at most", async () => {
  let fail = true;
  const { engine, s, store, titled, asked } = rig([BIG, SMALL], async () => { if (fail) throw new Error("provider down"); return said("Cart discounts"); });
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  await waitFor(() => ((engine as any).titleFails.get(s.id) ?? 0) === 1);
  expect(store.session(s.id)!.title).toBe("Fix the cart discount rounding");
  expect((engine as any).untitled.has(s.id)).toBe(false);
  fail = false;
  engine.send(s.id, "And the tax too");
  await engine.idle(s.id);
  await titled("Cart discounts");
  // A request that fails every time stops after three turn ends.
  const other = rig([BIG, SMALL], async () => { throw new Error("always down"); });
  for (let i = 1; i <= 5; i++) {
    other.engine.send(other.s.id, `Prompt ${i}`);
    await other.engine.idle(other.s.id);
    await waitFor(() => !(other.engine as any).titling.has(other.s.id));
  }
  expect(other.asked.filter((r) => r.purpose === "title").length).toBeGreaterThanOrEqual(3);
  expect((other.engine as any).titleFails.get(other.s.id)).toBe(3);
  expect(asked.filter((r) => r.purpose === "title").length).toBeGreaterThan(0);
});

// A title the owner gave (title_by empty, not the first prompt's words) is never asked for.
test("a title the owner set is not replaced by a model's", async () => {
  const { engine, s, store, asked } = rig([BIG, SMALL], async () => said("Not mine"));
  store.updateSession(s.id, { title: "Mine", title_by: "" });
  engine.send(s.id, "Fix the cart discount rounding");
  await engine.idle(s.id);
  await Bun.sleep(100);
  expect(asked.filter((r) => r.purpose === "title")).toEqual([]);
  expect(store.session(s.id)!.title).toBe("Mine");
  expect(store.session(s.id)!.title_by).toBe("");
});

// An import: its exchange exists already. A title that is only the source's first prompt is made again by
// a model right away; a title the source gave (its own name or AI title) stays.
test("an imported session with a derived title is titled by a model, one with its own title is left", async () => {
  const { engine, s, store, titled } = rig([BIG, SMALL], async () => said("Cart discount rounding"));
  const user = store.append(s.id, "user", { text: "Fix the cart discount rounding in the checkout flow, it is off by a cent" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Done." }] }, user.id);
  store.updateSession(s.id, { title: "Fix the cart discount rounding in the checkout flow, it is off by a cent" });
  engine.adoptImport(s.id);
  await titled("Cart discount rounding");
  expect(store.session(s.id)!.title_by).toBe("model");

  const own = rig([BIG, SMALL], async () => said("Should not be asked"));
  const u = own.store.append(own.s.id, "user", { text: "Fix the cart discount rounding" });
  own.store.append(own.s.id, "assistant", { blocks: [{ type: "text", text: "Done." }] }, u.id);
  own.store.updateSession(own.s.id, { title: "Checkout work (named in Claude Code)" });
  own.engine.adoptImport(own.s.id);
  await Bun.sleep(100);
  expect(own.asked.filter((r) => r.purpose === "title")).toEqual([]);
  expect(own.store.session(own.s.id)!.title).toBe("Checkout work (named in Claude Code)");
});

// Titles are three words now. A model's title from before (longer) is made again once, at the session's next
// turn end, and the new one is cut to three words if the answer is longer; a title the owner gave is never made again.
test("a model's title longer than three words is made again once at the next turn end", async () => {
  const { engine, s, store, asked, titled } = rig([BIG, SMALL], async () => said("Cart discount rounding in checkout"));
  const user = store.append(s.id, "user", { text: "Fix the cart discount rounding in the checkout flow" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "Done." }] }, user.id);
  store.updateSession(s.id, { title: "Fix the cart discount rounding", title_by: "model" });
  engine.send(s.id, "And the tax too");
  await engine.idle(s.id);
  await titled("Cart discount rounding");
  expect(store.session(s.id)!.title_by).toBe("model");
  engine.send(s.id, "And the shipping");
  await engine.idle(s.id);
  await Bun.sleep(100);
  expect(asked.filter((r) => r.purpose === "title").length).toBe(1);

  const mine = rig([BIG, SMALL], async () => said("Not mine"));
  const u = mine.store.append(mine.s.id, "user", { text: "Fix the cart discount rounding" });
  mine.store.append(mine.s.id, "assistant", { blocks: [{ type: "text", text: "Done." }] }, u.id);
  mine.store.updateSession(mine.s.id, { title: "My own long name for this work", title_by: "" });
  mine.engine.send(mine.s.id, "And the tax too");
  await mine.engine.idle(mine.s.id);
  await Bun.sleep(100);
  expect(mine.asked.filter((r) => r.purpose === "title")).toEqual([]);
  expect(mine.store.session(mine.s.id)!.title).toBe("My own long name for this work");
});
