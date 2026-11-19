// Listing state: which answer wins when refreshes overlap, whose saved list a
// provider may show, and when a read waits for a refresh.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Providers } from "./registry.ts";
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
