import { expect, test } from "bun:test";
import { ASK_MS, Batcher, BATCH_MAX, FLUSH_MS, isDrawn, nameOf, QUEUE_MAX, SEEN_AGAIN_MS, type Body } from "./press-batch.ts";

// A clock and a beat the test drives; the sender records what it was given.
function rig(answer: () => Promise<{ record: boolean } | void> = async () => ({ record: true })) {
  let now = 1_000_000;
  const beats = new Set<() => void>();
  const asks = new Set<() => void>();
  let timers = 0;
  const sent: Body[] = [];
  const b = new Batcher(
    async (body) => { sent.push(body); return answer(); },
    (ms, f) => {
      const set = ms === ASK_MS ? asks : beats;
      if (set === beats) { expect(ms).toBe(FLUSH_MS); timers++; }
      set.add(f);
      return () => void set.delete(f);
    },
    () => "page",
    () => now,
  );
  return { b, sent, beats, asks, ask: async () => { for (const f of [...asks]) f(); for (let i = 0; i < 4; i++) await Promise.resolve(); }, tick: async () => { for (const f of [...beats]) f(); await Promise.resolve(); await Promise.resolve(); }, at: (t: number) => void (now = t), timers: () => timers };
}

test("a control's name keeps what names it and drops the digits that name a thing", () => {
  expect(nameOf("show-sidebar")).toBe("show-sidebar");
  expect(nameOf("header-action-fork")).toBe("header-action-fork");
  expect(nameOf("session-row-01a1fb6f-d40c-71f2-8ef4-d02c9006567a")).toBe("session-row-*");
  expect(nameOf("tab-12")).toBe("tab-*");
  expect(nameOf("")).toBeNull();
  expect(nameOf(undefined)).toBeNull();
  // Something that is not a name (words, a quote) is never kept.
  expect(nameOf("Rename my project")).toBeNull();
  expect(nameOf('a"b')).toBeNull();
  expect(nameOf("9lives")).toBeNull();
});

test("a page at rest has no timer; presses go together on the beat, then the timer goes again", async () => {
  const r = rig();
  expect(r.timers()).toBe(0);
  r.b.press("a", "session", "s1");
  r.b.press("b", "session");
  r.b.press("a", "session", "s1");
  expect(r.timers()).toBe(1); // one beat for all of them
  expect(r.sent).toHaveLength(0); // nothing is sent per press
  await r.tick();
  expect(r.sent).toHaveLength(1);
  expect(r.sent[0]!.presses.map((p) => p.c)).toEqual(["a", "b", "a"]);
  expect(r.sent[0]!.presses[0]).toEqual({ c: "a", v: "session", s: "s1", t: 1_000_000 });
  expect("s" in r.sent[0]!.presses[1]!).toBe(false);
  await r.tick();
  expect(r.beats.size).toBe(0); // nothing left: the beat is given back
  expect(r.sent).toHaveLength(1);
});

test("a batch holds at most BATCH_MAX, the rest follows on the next beat", async () => {
  const r = rig();
  for (let i = 0; i < BATCH_MAX + 20; i++) r.b.press("a", "new");
  await r.tick();
  expect(r.sent[0]!.presses).toHaveLength(BATCH_MAX);
  await r.tick();
  expect(r.sent[1]!.presses).toHaveLength(20);
});

test("what waits is bounded: past QUEUE_MAX the oldest go, also when the daemon cannot be reached", async () => {
  let up = false;
  const r = rig(async () => { if (!up) throw new Error("down"); return { record: true }; });
  for (let i = 0; i < QUEUE_MAX + 50; i++) { r.at(1_000_000 + i); r.b.press("a", "new"); }
  expect(r.b.waiting).toBe(QUEUE_MAX);
  await r.tick(); // fails: put back in front, still within the bound
  expect(r.b.waiting).toBe(QUEUE_MAX);
  up = true;
  await r.tick();
  await r.tick();
  // The batch that failed was sent again whole, from the oldest that was kept.
  expect(r.sent[1]!.presses).toEqual(r.sent[0]!.presses);
  expect(r.sent[0]!.presses[0]!.t).toBe(1_000_000 + 50);
  expect(r.b.waiting).toBe(QUEUE_MAX - 2 * BATCH_MAX);
});

test("a control drawn is told once, and again after SEEN_AGAIN_MS", async () => {
  const r = rig();
  r.b.see("x", "new"); r.b.see("x", "new"); r.b.see("y", "new");
  await r.tick();
  expect(r.sent[0]!.seen).toEqual([{ c: "x", v: "new" }, { c: "y", v: "new" }]);
  r.b.see("x", "new");
  expect(r.b.waiting).toBe(0);
  r.at(1_000_000 + SEEN_AGAIN_MS);
  r.b.see("x", "new");
  r.b.see("x", "session"); // another view is another fact
  expect(r.b.waiting).toBe(2);
});

test("when the daemon says it does not record, the page drops what waits and sends nothing more", async () => {
  const r = rig(async () => ({ record: false }));
  r.b.press("a", "new");
  await r.tick();
  expect(r.b.recording).toBe(false);
  r.b.press("a", "new");
  r.b.see("a", "new");
  expect(r.b.waiting).toBe(0);
  expect(r.sent).toHaveLength(1);
});

test("the page going away sends what is left at once", async () => {
  const r = rig();
  r.b.press("a", "new");
  await r.b.flush(true);
  expect(r.sent).toHaveLength(1);
  expect(r.beats.size).toBe(0);
});

test("a tab that was told recording is off asks on a slow beat and resumes when it is on again", async () => {
  let on = false;
  const r = rig(async () => ({ record: on }));
  r.b.press("a", "new");
  await r.tick();
  expect(r.b.recording).toBe(false);
  expect(r.asks.size).toBe(1);
  // Still off: the ask is an empty batch and the tab stays quiet.
  await r.ask();
  expect(r.sent.at(-1)).toEqual({ surface: "page", presses: [], seen: [] });
  expect(r.b.recording).toBe(false);
  r.b.press("a", "new");
  expect(r.b.waiting).toBe(0);
  // Turned on elsewhere: the next ask brings it back, and the beat is given up.
  on = true;
  await r.ask();
  expect(r.b.recording).toBe(true);
  expect(r.asks.size).toBe(0);
  r.b.press("a", "new");
  expect(r.b.waiting).toBe(1);
});

test("turning it on by hand gives the ask up, and a failed ask is tried again", async () => {
  let up = false;
  const r = rig(async () => { if (!up) throw new Error("down"); return { record: true }; });
  r.b.recording = false;
  expect(r.asks.size).toBe(1);
  await r.ask();
  expect(r.b.recording).toBe(false);
  expect(r.asks.size).toBe(1);
  r.b.recording = true;
  expect(r.asks.size).toBe(0);
});

test("a control is drawn when it is shown and not disabled", () => {
  const el = (o: { disabled?: boolean; aria?: string; rects?: number }) => ({ disabled: o.disabled, getAttribute: (n: string) => (n === "aria-disabled" ? o.aria ?? null : null), getClientRects: () => ({ length: o.rects ?? 1 }) });
  expect(isDrawn(el({}))).toBe(true);
  expect(isDrawn(el({ disabled: true }))).toBe(false);
  expect(isDrawn(el({ aria: "true" }))).toBe(false);
  expect(isDrawn(el({ rects: 0 }))).toBe(false);
});
