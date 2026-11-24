import { expect, test } from "bun:test";
import { dismiss, freshModels, noteListing, NEWS_DAYS, type Seen } from "./first-seen.ts";

const DAY = 86_400_000;
// Listings read one after the other; the models of each are the argument, the time its place.
const read = (lists: string[][], identity?: string): Seen => lists.reduce<Seen | undefined>((seen, l, i) => noteListing(seen, l, 1000 * (i + 1), identity).seen, undefined)!;
const news = (s: Seen) => freshModels(s, 10_000).map((m) => m.model);

test("the first listing is the baseline: nothing in it is new", () => {
  const r = noteListing(undefined, ["a", "b"], 1000);
  expect(r.added).toEqual([]);
  expect(r.seen.models).toEqual({ a: 1000, b: 1000 });
  expect(freshModels(r.seen, 2000)).toEqual([]);
});

test("a model a later listing adds is new with the time it first listed", () => {
  const base = read([["a"], ["a"]]);
  const r = noteListing(base, ["a", "b"], 5000);
  expect(r.added).toEqual(["b"]);
  expect(freshModels(r.seen, 6000)).toEqual([{ model: "b", first_seen: 5000 }]);
  // The same listing again changes nothing, and keeps the first date.
  const again = noteListing(r.seen, ["a", "b"], 9000);
  expect(again.added).toEqual([]);
  expect(again.seen).toBe(r.seen);
});

test("a model that leaves and returns keeps its first date and is not new twice", () => {
  const base = read([["a", "b"], ["a", "b"]]);
  const gone = noteListing(base, ["a"], 2000);
  expect(gone.added).toEqual([]);
  const back = noteListing(gone.seen, ["a", "b"], 3000);
  expect(back.added).toEqual([]);
  expect(back.seen.models.b).toBe(1000);
  expect(freshModels(back.seen, 4000)).toEqual([]);
});

test("another account's listing is a new baseline, not news", () => {
  const base = read([["a"], ["a"]], "one");
  const r = noteListing(base, ["a", "x", "y"], 5000, "two");
  expect(r.added).toEqual([]);
  expect(freshModels(r.seen, 6000)).toEqual([]);
  // The new account's baseline reads two listings; what lists after them is new.
  const second = noteListing(r.seen, ["a", "x", "y", "w"], 6000, "two");
  expect(second.added).toEqual([]);
  const next = noteListing(second.seen, ["a", "x", "y", "w", "z"], 7000, "two");
  expect(next.added).toEqual(["z"]);
});

test("a model stops being news after its days, or when the owner puts it away", () => {
  const base = noteListing(noteListing(undefined, ["a"], 0).seen, ["a"], 500).seen;
  const r = noteListing(noteListing(base, ["a", "b", "c"], 1000).seen, ["a", "b", "c", "d"], 2000);
  expect(freshModels(r.seen, 3000).map((m) => m.model)).toEqual(["d", "b", "c"]);
  expect(freshModels(dismiss(r.seen, "d"), 3000).map((m) => m.model)).toEqual(["b", "c"]);
  expect(freshModels(r.seen, 1000 + NEWS_DAYS * DAY + 1).map((m) => m.model)).toEqual(["d"]);
  expect(freshModels(r.seen, 2000 + NEWS_DAYS * DAY + 1)).toEqual([]);
});

test("a first listing that was partial does not make the rest of the catalog new", () => {
  // The first answer held one model, the next the whole catalog: both are the baseline.
  expect(news(read([["a"], ["a", "b", "c", "d"]]))).toEqual([]);
  // A model that lists after them is new.
  expect(news(read([["a"], ["a", "b", "c", "d"], ["a", "b", "c", "d", "e"]]))).toEqual(["e"]);
  // Full, partial, full: nothing came back that was not there.
  expect(news(read([["a", "b", "c"], ["a"], ["a", "b", "c"]]))).toEqual([]);
});

test("a listing for another identity, one that appears or one that goes, starts a baseline again", () => {
  // No identity first, then an account (a sign-in): its catalog is not news.
  const signed = noteListing(read([["a", "b"], ["a", "b"]]), ["a", "b", "x", "y"], 5000, "acct").seen;
  expect(news(signed)).toEqual([]);
  // The same, the other way (a sign-out).
  const out = noteListing(read([["a", "b"], ["a", "b"]], "acct"), ["a", "b", "x", "y"], 5000).seen;
  expect(news(out)).toEqual([]);
  // The identity the listings keep is not a change.
  expect(news(read([["a"], ["a"], ["a", "b"]], "acct"))).toEqual(["b"]);
});

test("the first models of a part the provider learns late are its baseline, not news", () => {
  // An agent's models are `agent/choice`; the agent itself is listed from the start.
  const batchOf = (m: string) => (m.includes("/") ? m.slice(0, m.indexOf("/")) : undefined);
  const note = (prev: Seen | undefined, models: string[], at: number) => noteListing(prev, models, at, undefined, batchOf);
  // Two baseline listings with the agents only, then one agent's choices arrive, then the other's.
  let seen = note(note(undefined, ["a", "b"], 1000).seen, ["a", "b"], 2000).seen;
  const first = note(seen, ["a", "b", "a/x", "a/y"], 3000);
  expect(first.added).toEqual([]);
  expect(freshModels(first.seen, 4000)).toEqual([]);
  const second = note(first.seen, ["a", "b", "a/x", "a/y", "b/z"], 5000);
  expect(second.added).toEqual([]);
  expect(freshModels(second.seen, 6000)).toEqual([]);
  // A choice an agent that was read before adds later is new, and so is an agent the listing never had.
  const later = note(second.seen, ["a", "b", "a/x", "a/y", "a/w", "b/z", "c"], 7000);
  expect(later.added).toEqual(["a/w", "c"]);
  expect(freshModels(later.seen, 8000).map((m) => m.model).sort()).toEqual(["a/w", "c"]);
  // Without the part's name, the same listings make every late model news.
  expect(news(noteListing(noteListing(noteListing(undefined, ["a"], 1000).seen, ["a"], 2000).seen, ["a", "a/x"], 3000).seen)).toEqual(["a/x"]);
});
