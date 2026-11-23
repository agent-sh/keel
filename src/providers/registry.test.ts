// Listing state: which answer wins when refreshes overlap, whose saved list a
// provider may show, and when a read waits for a refresh.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndpointProvider } from "./endpoint.ts";
import { Providers, servedTier } from "./registry.ts";
import type { ListedModel, Provider } from "./types.ts";

type Step = { resolve: (m: ListedModel[]) => void; reject: (e: Error) => void };

function fake(id: string, who = { v: "a" }) {
  const calls: Step[] = [];
  const p: Provider = {
    id, family: "other", available: () => true, identity: () => who.v,
    list: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
    stream: async () => { throw new Error("no"); },
  };
  return { p, calls, who };
}

const dir = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-reg-"));
const make = (state: string, ps: Provider[]) => {
  const r = new Providers(state, { providers: ps });
  r.catalog.load = async () => {};
  return r;
};
const ids = (r: Providers, id: string) => r.listing(id).models.map((m) => m.model);

test("concurrent picks and outage probes share the target listing without waiting for other providers", async () => {
  const target = fake("target");
  const other = fake("other");
  const r = make(dir(), [target.p, other.p]);
  const picks = () => Array.from({ length: 4 }, () => r.resolve("target:next", { scoped: true }));
  const first = picks();
  await Bun.sleep(0);
  expect(target.calls).toHaveLength(1);
  expect(other.calls).toHaveLength(0);
  target.calls[0]!.resolve([{ model: "next" }]);
  for (const { info } of await Promise.all(first)) expect(info.id).toBe("target:next");

  const next = make(dir(), [target.p, other.p]);
  const full = next.models(true);
  await Bun.sleep(0);
  const during = next.resolve("target:next", { scoped: true });
  const probe: Promise<void> = (next as any).reach("target");
  await Bun.sleep(0);
  expect(target.calls).toHaveLength(2);
  expect(other.calls).toHaveLength(1);
  target.calls[1]!.resolve([{ model: "next" }]);
  expect((await during).info.id).toBe("target:next");
  await probe;
  other.calls[0]!.resolve([]);
  await full;
});

test("an older failed refresh does not undo a newer listing", async () => {
  const f = fake("p");
  const r = make(dir(), [f.p]);
  const first = r.refresh("p");
  await Bun.sleep(0);
  f.who.v = "b";
  const second = r.refresh("p");
  await Bun.sleep(0);
  f.calls[1]!.resolve([{ model: "new" }]);
  await second;
  f.calls[0]!.reject(new Error("timeout"));
  await first;
  expect(r.listing("p").state).toBe("ok");
  expect(ids(r, "p")).toEqual(["new"]);
  // A failure that really is later keeps the new list as last known.
  const third = r.refresh("p");
  await Bun.sleep(0);
  f.calls[2]!.reject(new Error("down"));
  await third;
  expect(r.listing("p").state).toBe("failed");
  expect(ids(r, "p")).toEqual(["new"]);
});

test("a saved listing is offered only to the account that made it", async () => {
  const state = dir();
  const f = fake("p");
  const r = make(state, [f.p]);
  const a = r.refresh("p");
  await Bun.sleep(0);
  f.calls[0]!.resolve([{ model: "a-only" }]);
  await a;
  f.who.v = "b";
  expect(ids(r, "p")).toEqual([]);
  // A fresh daemon on the same file: B sees nothing of A's, A sees its own offline.
  const g = fake("p", { v: "b" });
  expect(ids(make(state, [g.p]), "p")).toEqual([]);
  g.who.v = "a";
  expect(ids(make(state, [g.p]), "p")).toEqual(["a-only"]);
  expect(g.calls.length).toBe(0);
});

test("after a restart a read answers from the saved list while the refresh runs", async () => {
  const state = dir();
  const f = fake("p");
  const r = make(state, [f.p]);
  const a = r.refresh("p");
  await Bun.sleep(0);
  f.calls[0]!.resolve([{ model: "saved" }]);
  await a;
  const g = fake("p");
  const r2 = make(state, [g.p]);
  const read = await Promise.race([r2.models().then((m) => m.map((x) => x.model)), Bun.sleep(50).then(() => "blocked")]);
  expect(read).toEqual(["saved"]);
  expect(g.calls.length).toBe(1);
  // With no saved list the first read waits (loading, not "no models").
  const h = fake("q");
  const r3 = make(dir(), [h.p]);
  const empty = await Promise.race([r3.models().then(() => "answered"), Bun.sleep(50).then(() => "waiting")]);
  expect(empty).toBe("waiting");
  h.calls[0]!.resolve([]);
});

test("a call is priced at the tier the provider says served it, else marked as asked", () => {
  const price = (input: number) => ({ input, output: 0 });
  const priority = { id: "priority", label: "Priority", price: price(3), body: { service_tier: "priority" } };
  const flex = { id: "flex", label: "Flex", price: price(0.5), body: { service_tier: "flex" } };
  const info = { speeds: [priority, flex] } as any;
  expect(servedTier(info, priority, "default")).toEqual({ reported: "standard" });
  expect(servedTier(info, priority, "priority")).toEqual({ offer: priority, reported: "priority" });
  expect(servedTier(info, priority, "flex")).toEqual({ offer: flex, reported: "flex" });
  expect(servedTier(info, priority, undefined)).toEqual({ offer: priority });
  expect(servedTier(info, priority, "turbo")).toEqual({ offer: priority });
});

test("another provider's catalog entry cannot make an unknown route text-only", async () => {
  const f = fake("plug");
  const r = make(dir(), [f.p]);
  (r.catalog as any).byId.set("fiction", { id: "fiction", name: "Fiction", images: false, pdf: false });
  (r.catalog as any).byId.set("seer", { id: "seer", name: "Seer", images: true });
  const a = r.refresh("plug");
  await Bun.sleep(0);
  f.calls[0]!.resolve([{ model: "fiction" }, { model: "seer" }, { model: "said-no", images: false }]);
  await a;
  const by = new Map(r.current().map((m) => [m.model, m]));
  expect(by.get("fiction")!.images).toBeUndefined();
  expect(by.get("fiction")!.pdf).toBeUndefined();
  expect(by.get("seer")!.images).toBe(true);
  expect(by.get("said-no")!.images).toBe(false);
});

test("a read after a restart knows the window from the saved catalog while a newer one is fetched", async () => {
  const state = dir();
  await Bun.write(join(state, "models-dev.compact.json"), JSON.stringify({ shape: "old", sections: { other: { big: { name: "Big", context: 1_000_000, output: 64_000, efforts: ["high"] } } } }));
  const f = fake("p");
  const r = make(state, [f.p]);
  const a = r.refresh("p");
  await Bun.sleep(0);
  f.calls[0]!.resolve([{ model: "big" }]);
  await a;
  const r2 = make(state, [fake("p").p]);
  const big = (await r2.models()).find((m) => m.model === "big")!;
  expect(big.context).toBe(1_000_000);
  expect(big.context_assumed).toBeUndefined();
  expect(big.efforts).toEqual(["high"]);
});

// Whether a provider is set up is known before anything slow. A key that was
// never looked for counts as there (its first read decides), and that read
// came only after the catalog was fetched: for as long as the fetch took, a
// daemon with no key at all reported every keyed provider as available.
test("a key is looked for before the catalog is fetched, and a report waits for the look", async () => {
  const p = new EndpointProvider({ id: "nokey-early", base_url: "http://127.0.0.1:9/v1", key_env: `KEEL_TEST_NOKEY_EARLY_${process.pid}`, key_cred: `keel-test-absent-early-${process.pid}-${Date.now()}` });
  const r = new Providers(dir(), { providers: [p], capture: () => {} });
  const catalog = Promise.withResolvers<void>();
  r.catalog.load = () => catalog.promise; // a fetch that takes its time
  expect(p.available()).toBe(true); // not read yet
  const refreshing = r.refresh();
  await r.looked();
  expect(p.available()).toBe(false);
  expect(r.statuses().find((s) => s.id === "nokey-early")!.available).toBe(false);
  catalog.resolve();
  await refreshing;
  expect(r.listing("nokey-early").state).toBe("never");
});

// A report waits for the first looks, but not for ever: a keyring that waits
// on an unlock prompt or a helper that hangs holds no answer back.
test("the wait for the first looks is bounded and says when a look is still out", async () => {
  const slow = { id: "slow", family: "other", available: () => true, list: async () => [], look: () => new Promise<void>(() => {}) } as any;
  const r = new Providers(dir(), { providers: [slow], capture: () => {} });
  const t0 = performance.now();
  expect(await r.looked(30)).toBe(false);
  expect(performance.now() - t0).toBeLessThan(1000);
  const quick = { ...slow, id: "quick", look: async () => {} };
  expect(await new Providers(dir(), { providers: [quick], capture: () => {} }).looked(30)).toBe(true);
});

// The usage windows are asked of providers whose key has been read. One
// whose key is still being read would hold the answer for as long as the
// read takes (twenty seconds behind a helper that hangs): it is left for the
// next call, and asked once its key is there.
test("the usage windows do not wait on a key nobody has read yet", async () => {
  const look = Promise.withResolvers<void>();
  let read = false, asked = 0;
  const slow = {
    id: "slow-usage", family: "other", available: () => true, list: async () => [],
    look: () => look.promise.then(() => { read = true; }),
    unread: () => !read,
    usage: async () => { asked++; await look.promise; return [{ id: "day", label: "Day", used_percent: 40 }]; },
  } as any;
  const r = new Providers(dir(), { providers: [slow], capture: () => {} });
  const t0 = performance.now();
  expect(await r.windows()).toEqual([]);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(asked).toBe(0);
  look.resolve();
  await look.promise;
  await Bun.sleep(0);
  expect((await r.windows()).map((w) => [w.provider, w.id, w.used_percent])).toEqual([["slow-usage", "day", 40]]);
  expect(asked).toBe(1);
});

// A refresh looks for each key once: the key its first look found missing is
// not read again right after (each read is a keyring call and a helper run).
test("a key found missing is read once by the refresh that looked for it", async () => {
  const d = dir();
  const log = join(d, "reads.log"), helper = join(d, "helper.sh");
  writeFileSync(helper, `#!/bin/sh\necho "$1" >> ${log}\n`, { mode: 0o755 });
  const before = process.env.KEEL_CRED_GET;
  process.env.KEEL_CRED_GET = helper;
  try {
    const p = new EndpointProvider({ id: "once", base_url: "http://127.0.0.1:9/v1", key_cred: `keel-test-once-${process.pid}-${Date.now()}` });
    const r = new Providers(d, { providers: [p], capture: () => {} });
    r.catalog.load = async () => {};
    await r.refresh();
    expect(p.available()).toBe(false);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  } finally {
    if (before === undefined) delete process.env.KEEL_CRED_GET; else process.env.KEEL_CRED_GET = before;
  }
});

test("a provider with no key is not set up: nothing failed and no key was refused", async () => {
  const captured: unknown[] = [];
  const env = `KEEL_TEST_NOKEY_${process.pid}`;
  // A real endpoint whose key is named but held nowhere (the variable is unset, the keyring entry does not exist).
  const p = new EndpointProvider({ id: "nokey", base_url: "http://127.0.0.1:9/v1", key_env: env, key_cred: `keel-test-absent-${process.pid}-${Date.now()}` });
  const state = dir();
  const r = new Providers(state, { providers: [p], capture: (_s, e) => captured.push(e) });
  r.catalog.load = async () => {};
  expect(p.available()).toBe(true); // not read yet: the first read decides
  await r.refresh();
  expect(p.available()).toBe(false);
  expect(captured).toEqual([]);
  expect(r.listing("nokey").state).toBe("never");
  expect(r.problem("nokey")).toBeUndefined();
  // It stays not set up (no flapping back), and a later refresh looks again without recording anything.
  await r.refresh();
  expect(p.available()).toBe(false);
  expect(captured).toEqual([]);
  expect(new Providers(state, { providers: [p] }).listing("nokey").state).toBe("never");
  // With a key, a listing that fails is a failure and is recorded.
  process.env[env] = "k";
  try {
    expect(p.available()).toBe(true);
    await r.refresh();
    expect(r.listing("nokey").state).toBe("failed");
    expect(captured.length).toBe(1);
  } finally {
    delete process.env[env];
  }
});

// The catalog's interleaved field is a fact of the model: it reaches the
// request the driver gets, where the Chat Completions wire reads it.
test("the field a model reads its earlier reasoning from reaches the driver's request", async () => {
  const f = fake("plug");
  let seen: any;
  f.p.stream = async (req) => { seen = req; return { blocks: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: req.model } as any; };
  const r = make(dir(), [f.p]);
  (r.catalog as any).byId.set("thinker", { id: "thinker", name: "Thinker", interleaved: "reasoning_content" });
  const a = r.refresh("plug");
  await Bun.sleep(0);
  f.calls[0]!.resolve([{ model: "thinker" }, { model: "plain" }]);
  await a;
  for (const [model, want] of [["thinker", "reasoning_content"], ["plain", undefined]] as const) {
    const { provider, info } = await r.resolve(`plug:${model}`);
    expect(info.interleaved).toBe(want);
    await provider.stream({ model, system: "", messages: [], tools: [], signal: new AbortController().signal }, () => {});
    expect(seen.interleaved).toBe(want);
  }
});

// The field is the route's: a route whose catalog section has no entry of
// the model does not take another provider's entry of it.
test("a route with a catalog section takes the reasoning field from its own section only", async () => {
  for (const [ownEntry, want] of [[undefined, undefined], [{ id: "thinker", name: "Thinker" }, undefined], [{ id: "thinker", name: "Thinker", interleaved: "reasoning_details" }, "reasoning_details"]] as const) {
    const f = fake("openai");
    const r = make(dir(), [f.p]);
    (r.catalog as any).byId.set("thinker", { id: "thinker", name: "Thinker", interleaved: "reasoning_content" });
    if (ownEntry) (r.catalog as any).byProvider.set("openai", new Map([["thinker", ownEntry]]));
    const a = r.refresh("openai");
    await Bun.sleep(0);
    f.calls[0]!.resolve([{ model: "thinker" }]);
    await a;
    expect(r.current().find((m) => m.model === "thinker")!.interleaved).toBe(want);
  }
});

// A request that asks for less output than the model lists (a title, a reader's part) is sent with
// what it asked for; one that asks for nothing gets the model's own limit.
test("a request's own output limit is sent when it is under the model's", async () => {
  const sent: (number | undefined)[] = [];
  const p: Provider = {
    id: "out", family: "other", available: () => true, list: async () => [{ model: "m", context: 100_000, output: 64_000, tools: false }],
    stream: async (req) => { sent.push(req.maxTokens); return { blocks: [], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "m" }; },
  };
  const r = new Providers(dir(), { providers: [p], capture: () => {} });
  r.catalog.load = async () => {};
  try {
    const { provider } = await r.resolve("out:m");
    const req = { model: "m", system: "", messages: [], tools: [], signal: new AbortController().signal } as any;
    for (const maxTokens of [1024, undefined, 100_000]) await provider.stream({ ...req, maxTokens }, () => {});
    expect(sent).toEqual([1024, 64_000, 64_000]);
  } finally { r.shutdown(); }
});
