// Listing state: which answer wins when refreshes overlap, whose saved list a
// provider may show, and when a read waits for a refresh.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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

test("an older failed refresh does not undo a newer listing", async () => {
  const f = fake("p");
  const r = make(dir(), [f.p]);
  const first = r.refresh("p");
  await Bun.sleep(0);
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
