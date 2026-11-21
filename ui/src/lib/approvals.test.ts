import { expect, test } from "bun:test";
import type { Approval } from "../../../src/safety/gate.ts";
import { batches, batchName, coverName, hold, nextAction, pressable, settled, spentAction, stand, SETTLE_MS, type Action, type Hold } from "./approvals.ts";

const card = (id: string, over: Partial<Approval> = {}): Approval => ({
  id, session_id: "s", call_id: `c-${id}`, tool: "Bash", kind: "shell", summary: `echo ${id}`, input: {}, risk: "low", suggest: [], state: "pending", created: 1, ...over,
});
const set = (...ids: string[]) => new Set(ids);

test("a thing counts once it has stood whole and unmoved for the settle time", () => {
  const a = stand(undefined, { x: 10, y: 100, whole: true }, 0);
  expect(settled(a, SETTLE_MS - 1)).toBe(false);
  expect(settled(a, SETTLE_MS)).toBe(true);
  // The same place keeps its time, a part of a pixel off included.
  expect(stand(a, { x: 10.4, y: 100.4, whole: true }, 500)).toBe(a);
  // It moved: the time starts again, and a slow drift is measured from where it stood.
  const moved = stand(a, { x: 10, y: 140, whole: true }, 2000);
  expect([moved.since, settled(moved, 2500), settled(moved, 3000)]).toEqual([2000, false, true]);
  expect(stand(stand(a, { x: 10, y: 100.6, whole: true }, 10), { x: 10, y: 101.2, whole: true }, 20).since).toBe(20);
  // Cut by an edge or covered: it does not count however long, and starts again when it is whole.
  const cut = stand(a, { x: 10, y: 100, whole: false }, 3000);
  expect(settled(cut, 99_999)).toBe(false);
  expect(stand(cut, { x: 10, y: 100, whole: true }, 4000).since).toBe(4000);
  expect(settled(undefined, 99_999)).toBe(false);
});

test("one batch per tool, of the requests that were read and are not cut", () => {
  const cards = [card("a"), card("e", { tool: "Edit", kind: "edit" }), card("b"), card("c"), card("d")];
  // d is out of view (not read), c is longer than its box.
  expect(batches(cards, set("a", "b", "c", "e"), set("c"))).toEqual([{ tool: "Bash", kind: "shell", waiting: 4, ids: ["a", "b"] }]);
  // Nothing read yet: the action is there with nothing to cover.
  expect(batches(cards, set(), set())).toEqual([{ tool: "Bash", kind: "shell", waiting: 4, ids: [] }]);
  // One request left that could ever be answered with others: no batch.
  expect(batches(cards, set("a", "b", "c", "d"), set("b", "c", "d"))).toEqual([]);
});

test("requests answered alone are never in a batch, and are counted as waiting", () => {
  const cards = [card("a"), card("b"), card("risky", { risk: "high" }), card("no", { kind: "refused" }), card("hook", { once: true }), card("long", { cut: true }), card("done", { state: "allowed" })];
  const all = set("a", "b", "risky", "no", "hook", "long", "done");
  expect(batches(cards, all, set())).toEqual([{ tool: "Bash", kind: "shell", waiting: 6, ids: ["a", "b"] }]);
  expect(batches(cards.filter((c) => c.id !== "b"), all, set())).toEqual([]);
});

test("the action covers what was ready when the hand came to it, and grows only behind a hold", () => {
  let t = 5000;
  let open = set("a", "b", "c", "d", "late");
  const step = (prev: Action | undefined, ready: string[], hot = false) => nextAction(prev, ready, hot, t, open);
  // From nothing to pressable at once, with what is ready.
  let a = step(undefined, ["a", "b"]);
  expect(a).toMatchObject({ covered: ["a", "b"], live: true, frozen: null });
  // It grows while it could be pressed: the new count shows, and it does not act for the settle time.
  a = step(a, ["a", "b", "c"]);
  expect(a).toMatchObject({ covered: ["a", "b", "c"], live: false, hold: t + SETTLE_MS });
  // Another one during that hold starts it again.
  t += 900;
  a = step(a, ["a", "b", "c", "d"]);
  expect(a).toMatchObject({ live: false, hold: t + SETTLE_MS });
  t += SETTLE_MS;
  a = step(a, ["a", "b", "c", "d"]);
  expect(a.live).toBe(true);
  // Shrinking needs no hold.
  a = step(a, ["a", "b"]);
  expect(a).toMatchObject({ covered: ["a", "b"], live: true });

  // The keyboard comes to it: from now it only shrinks.
  a = step(a, ["a", "b"], true);
  expect(a.frozen).toEqual(["a", "b"]);
  a = step(a, ["a", "b", "late"], true);
  expect(a).toMatchObject({ covered: ["a", "b"], live: true });
  // The list moved under it (nothing is ready for a moment), then stood again: back to what it covered, no more.
  a = step(a, [], true);
  expect(a).toMatchObject({ covered: [], live: false, frozen: ["a", "b"] });
  a = step(a, ["a", "b", "late"], true);
  expect(a).toMatchObject({ covered: ["a", "b"], live: true });
  a = step(a, ["b", "late"], true);
  expect(a).toMatchObject({ covered: ["b"], live: false });
  // The keyboard left: the late one joins, as any that is ready does.
  a = step(a, ["b", "late"]);
  expect(a).toMatchObject({ covered: ["b", "late"], live: true, frozen: null });

  // A hand that rests on it before it can be pressed: it becomes pressable with what is ready then, and is frozen from there.
  let b = step(undefined, ["a"], true);
  expect(b).toMatchObject({ live: false, frozen: null });
  b = step(b, ["a", "b", "c"], true);
  expect(b).toMatchObject({ covered: ["a", "b", "c"], live: true, frozen: ["a", "b", "c"] });
  b = step(b, ["a", "b", "c", "d"], true);
  expect(b.covered).toEqual(["a", "b", "c"]);
  // All it held is answered while the hand is still on it: it lets go, and covers what is ready after the settle time.
  open = set("d", "late");
  b = step(b, ["d", "late"], true);
  expect(b).toMatchObject({ covered: ["d", "late"], live: false, frozen: null, hold: t + SETTLE_MS });
  t += SETTLE_MS;
  b = step(b, ["d", "late"], true);
  expect(b).toMatchObject({ live: true, frozen: ["d", "late"] });

  // After it answered it does not act for the settle time, even if rows are ready at once.
  let c = step(spentAction(t), ["d", "late"]);
  expect(c).toMatchObject({ covered: ["d", "late"], live: false });
  t += SETTLE_MS;
  c = step(c, ["d", "late"]);
  expect(c.live).toBe(true);

  // After it answered, the next rows come to stand just before that hold ends: it is the one wait, not a second one.
  const spent = spentAction(t);
  t += SETTLE_MS - 20;
  let d = step(step(spent, []), ["d", "late"]);
  expect(d).toMatchObject({ covered: ["d", "late"], live: false, hold: spent.hold });
  t += 20;
  d = step(d, ["d", "late"]);
  expect(d.live).toBe(true);
});

test("an Allow acts when it has stood, or as the owner's own scroll ends", () => {
  let t = 10_000;
  const at = (y: number, whole = true) => ({ x: 400, y, whole });
  const read = (prev: Hold | undefined, y: number, placeY: number, o: { gesture?: boolean; listChanged?: boolean; whole?: boolean } = {}) =>
    hold(prev, at(y, o.whole ?? true), { x: 400, y: placeY }, !!o.gesture, !!o.listChanged, t);
  // A new card: its Allow waits the settle time whole on screen, ripe or not.
  let h = read(undefined, 300, 300);
  expect(pressable(h, false, false, t + SETTLE_MS - 1)).toBe(false);
  expect(pressable(h, true, false, t + SETTLE_MS)).toBe(true);
  t += 5000;

  // The owner scrolls: the row moves on screen, not in the list. While the scroll goes on it waits; as it ends it acts.
  h = read(h, 220, 300, { gesture: true });
  expect(h.own).toBe(true);
  expect(pressable(h, true, true, t)).toBe(false);
  t += 80;
  h = read(h, 140, 300, { gesture: true });
  expect(pressable(h, true, true, t)).toBe(false);
  expect(pressable(h, true, false, t)).toBe(true);
  // A card that is still new does not act that way, and one cut by the edge of the list never does.
  expect(pressable(h, false, false, t)).toBe(false);
  expect(pressable(read(h, -20, 300, { gesture: true, whole: false }), true, false, t)).toBe(false);

  // The same move with no hand behind it (the page scrolled, the frame moved): the whole settle time.
  t += 5000;
  let p = read(h, 60, 300);
  expect(p.own).toBe(false);
  expect(pressable(p, true, false, t + SETTLE_MS - 1)).toBe(false);
  expect(pressable(p, true, false, t + SETTLE_MS)).toBe(true);

  // The list changed while the owner scrolled (a row arrived, one left, one grew): the row's place
  // in the list moved, or the list's frame did. It is not the owner's move: the whole settle time.
  t += 5000;
  let c = read(h, 200, 356, { gesture: true });
  expect(c.own).toBe(false);
  expect(pressable(c, true, false, t + SETTLE_MS - 1)).toBe(false);
  c = read(h, 200, 300, { gesture: true, listChanged: true });
  expect(c.own).toBe(false);
  expect(pressable(c, true, false, t + SETTLE_MS - 1)).toBe(false);
  // And a list that changed a moment before the owner's scroll: the scroll does not shorten that wait.
  const changed = read(h, 140, 300, { listChanged: true }); // the frame changed, the row did not move on screen
  t += 300;
  const scrolled = read(changed, 100, 300, { gesture: true });
  expect(scrolled.own).toBe(true);
  expect(pressable(scrolled, true, false, t)).toBe(false);
  expect(pressable(scrolled, true, false, t + SETTLE_MS - 300)).toBe(true);
});

test("the action says what it covers", () => {
  expect(batchName({ tool: "Bash", kind: "shell" }, 3)).toBe("3 Bash commands");
  expect(batchName({ tool: "Edit", kind: "edit" }, 2)).toBe("2 Edit changes");
  expect(batchName({ tool: "fetch", kind: "other" }, 1)).toBe("1 fetch call");
  expect(coverName({ tool: "Bash", kind: "shell", waiting: 8 }, 8)).toBe("all 8 Bash commands");
  expect(coverName({ tool: "Bash", kind: "shell", waiting: 8 }, 3)).toBe("3 of 8 Bash commands");
  expect(coverName({ tool: "Bash", kind: "shell", waiting: 4 }, 0)).toBe("0 of 4 Bash commands");
});
