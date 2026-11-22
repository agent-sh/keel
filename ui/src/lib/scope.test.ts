// What the page asks its socket for, as views come and go: the bookkeeping
// alone, with the socket, the store and the clock stood in for.
import { expect, test } from "bun:test";
import { LINGER_MS, Scope, type ScopeMessage } from "./scope.ts";

function page(open = true) {
  const sent: ScopeMessage[] = [];
  const held = new Map<string, number>(); // the sessions the page holds, with their cursor
  const dropped: string[] = [];
  const timers: { f: () => void; ms: number; off?: boolean }[] = [];
  const socket = { open };
  const send = (m: ScopeMessage) => (socket.open ? (sent.push(m), true) : false);
  const scope = new Scope(
    { cursor: (id) => held.get(id), drop: (id) => { dropped.push(id); held.delete(id); }, far: (id) => id.includes("--") },
    { set: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clear: (t) => { if (t) (t as { off?: boolean }).off = true; } },
  );
  // The time after the last view is over, for every session that waits for it.
  const later = () => { for (const t of timers.splice(0)) if (!t.off) t.f(); };
  const pending = () => timers.filter((t) => !t.off).length;
  return { scope, sent, held, dropped, socket, send, later, pending, timers };
}

test("a session is asked for once its snapshot is in, from where the snapshot ended", () => {
  const p = page();
  p.scope.resume({}, p.send);
  const stop = p.scope.show("a");
  expect(p.sent).toEqual([]); // nothing before the snapshot: the cursor is not known yet
  p.held.set("a", 41);
  p.scope.loaded("a");
  expect(p.sent).toEqual([{ op: "sub", cursors: { a: 41 } }]);
  // A second view of it, and a second snapshot, ask for nothing more.
  const stop2 = p.scope.show("a");
  p.scope.loaded("a");
  expect(p.sent).toHaveLength(1);
  stop();
  expect(p.pending()).toBe(0); // one view still shows it
  stop2();
  expect(p.timers.at(-1)!.ms).toBe(LINGER_MS);
  expect(p.scope.hears()).toEqual(["a"]);
});

test("going back to a session within its time costs nothing; after it the daemon is told and the page lets go", () => {
  const p = page();
  p.scope.resume({}, p.send);
  const stop = p.scope.show("a");
  p.held.set("a", 7);
  p.scope.loaded("a");
  stop();
  const again = p.scope.show("a"); // back before the time is over
  p.later();
  expect(p.sent).toEqual([{ op: "sub", cursors: { a: 7 } }]);
  expect(p.dropped).toEqual([]);
  again();
  again(); // a view that stops twice counts once
  p.later();
  expect(p.sent.at(-1)).toEqual({ op: "unsub", watch: ["a"] });
  expect(p.dropped).toEqual(["a"]);
  expect(p.scope.hears()).toEqual([]);
  // Opened again: read anew and asked for again.
  p.scope.show("a");
  p.held.set("a", 90);
  p.scope.loaded("a");
  expect(p.sent.at(-1)).toEqual({ op: "sub", cursors: { a: 90 } });
});

test("a new socket is told what the page showed before, and a session whose snapshot is still on its way is asked for when it lands", () => {
  const p = page(false);
  p.scope.show("a");
  p.scope.show("b");
  p.scope.show("m1--far");
  p.held.set("a", 12);
  p.scope.loaded("a"); // no socket yet: nothing is sent, and nothing counts as asked for
  expect(p.sent).toEqual([]);
  p.socket.open = true;
  // The store names the sessions it holds; the far one this daemon cannot catch up is heard from now on.
  expect(p.scope.resume({ a: 12 }, p.send)).toEqual({ op: "resume", cursors: { a: 12 }, only: true, watch: ["m1--far"] });
  expect(p.scope.hears()).toEqual(["a", "m1--far"]);
  p.held.set("b", 3);
  p.scope.loaded("b");
  expect(p.sent).toEqual([{ op: "sub", cursors: { b: 3 } }]);
  // The socket drops and a new one opens: the same again, with the feeds.
  p.scope.feed("activity");
  p.sent.length = 0;
  expect(p.scope.resume({ a: 20, b: 9 }, p.send)).toEqual({ op: "resume", cursors: { a: 20, b: 9 }, only: true, watch: ["m1--far"], feeds: ["activity"] });
  p.scope.loaded("a");
  p.scope.loaded("b");
  expect(p.sent).toEqual([]);
});

test("another daemon's session is heard from the moment it is shown", () => {
  const p = page();
  p.scope.resume({}, p.send);
  const stop = p.scope.show("m1--s");
  expect(p.sent).toEqual([{ op: "sub", watch: ["m1--s"] }]);
  p.held.set("m1--s", 5);
  p.scope.loaded("m1--s"); // no cursor to catch up from here
  expect(p.sent).toHaveLength(1);
  stop();
  p.later();
  expect(p.sent.at(-1)).toEqual({ op: "unsub", watch: ["m1--s"] });
});

test("a snapshot that lands after its view left and its time is over is not kept", () => {
  const p = page();
  p.scope.resume({}, p.send);
  const stop = p.scope.show("late");
  stop();
  p.later();
  expect(p.dropped).toEqual(["late"]);
  p.held.set("late", 2);
  p.scope.loaded("late");
  expect(p.dropped).toEqual(["late", "late"]);
  expect(p.held.has("late")).toBe(false);
  expect(p.sent).toEqual([]); // it was never asked for, so there is nothing to take back
});

test("a feed is asked for while a view reads it", () => {
  const p = page();
  p.scope.resume({}, p.send);
  const a = p.scope.feed("activity");
  const b = p.scope.feed("activity");
  expect(p.sent).toEqual([{ op: "sub", feeds: ["activity"] }]);
  a();
  expect(p.sent).toHaveLength(1);
  b();
  expect(p.sent.at(-1)).toEqual({ op: "unsub", feeds: ["activity"] });
});
