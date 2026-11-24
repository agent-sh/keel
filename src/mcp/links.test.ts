// The pool's own rules, with a stand-in client: a connection is one per spec and per owner when it is not shared;
// sessions' calls take turns on a connection whose server has asked a question; a holder that closes ends its own
// calls; the kept lists past the cap are the ones used longest ago.
import { expect, test } from "bun:test";
import { Links, linkKey, placeKept, touchKept } from "./links.ts";

const stdio = (cwd = "/") => ({ kind: "stdio", command: "x", args: [], env: {}, cwd }) as any;
function fake(asked = false) {
  const c: any = { isClosed: false, expired: false, hasAsked: asked, closed: 0, retired: 0, close() { c.closed++; c.isClosed = true; }, retire() { c.retired++; }, call(signal: AbortSignal) { return new Promise<string>((res, rej) => { signal.addEventListener("abort", () => rej(signal.reason)); c.finish = () => res("done"); }); } };
  return c;
}

test("a server marked not shared is a connection of its session alone", async () => {
  expect(linkKey(stdio(), "s1")).not.toBe(linkKey(stdio()));
  expect(linkKey(stdio(), "s1")).not.toBe(linkKey(stdio(), "s2"));
  const links = new Links();
  let made = 0;
  const make = async () => { made++; return fake(); };
  await links.open(stdio(), make, undefined, "s1");
  await links.open(stdio(), make, undefined, "s2");
  await links.open(stdio(), make, undefined, "s1");
  await links.open(stdio(), make);
  await links.open(stdio(), make);
  expect([made, links.stats().holders.slice().sort()]).toEqual([3, [1, 2, 2]]);
});

test("calls of two sessions take turns once the server has asked, the calls of one session do not", async () => {
  const links = new Links();
  const c = fake();
  const a = await links.open(stdio(), async () => c) as any;
  const b = await links.open(stdio(), async () => c) as any;
  const sig = new AbortController().signal;
  // A server that never asked: no one waits.
  const r1 = await a.gate("s1", sig), r2 = await b.gate("s2", sig);
  r1(); r2();
  c.hasAsked = true;
  const order: string[] = [];
  const first = await a.gate("s1", sig);
  const same = await a.gate("s1", sig); // the same session's other call runs with it
  const other = b.gate("s2", sig).then((done: () => void) => { order.push("s2"); return done; });
  const later = a.gate("s1", sig).then((done: () => void) => { order.push("s1 later"); return done; }); // behind the one waiting
  await Bun.sleep(20);
  expect(order).toEqual([]);
  first();
  await Bun.sleep(20);
  expect(order).toEqual([]);
  same();
  (await other)();
  (await later)();
  expect(order).toEqual(["s2", "s1 later"]);
  // A call that gives up while it waits leaves the line, and the ones behind it go.
  const hold = await a.gate("s1", sig);
  const stop = new AbortController();
  const gone = b.gate("s2", stop.signal).catch((e: Error) => e.message);
  const behind = a.gate("s1", sig);
  stop.abort(new Error("stopped"));
  expect(await gone).toBe("stopped");
  (await behind)();
  hold();
});

test("a holder that closes ends the calls it made, and the others' go on", async () => {
  const links = new Links();
  const c = fake();
  const a = await links.open(stdio(), async () => c) as any;
  const b = await links.open(stdio(), async () => c) as any;
  const mine = a.call(new AbortController().signal), theirs = b.call(new AbortController().signal);
  const ended = mine.catch((e: Error) => e.message);
  a.close();
  expect(await ended).toBe("the server was dropped from this session");
  expect(c.closed).toBe(0);
  c.finish();
  expect(await theirs).toBe("done");
  b.close();
  expect(c.closed).toBe(1);
});

test("the kept lists past the cap are the ones used longest ago", () => {
  const kept: Record<string, number> = { owner: 0 };
  for (let i = 1; i <= 4; i++) placeKept(kept, `~${i}`, i, 4);
  expect(Object.keys(kept)).toEqual(["owner", "~1", "~2", "~3", "~4"]);
  // ~1 is used: it is the newest, and the next put drops ~2.
  expect(touchKept(kept, "~1")).toBe(true);
  expect(touchKept(kept, "~1")).toBe(false);
  placeKept(kept, "~5", 5, 4);
  expect(Object.keys(kept)).toEqual(["owner", "~3", "~4", "~1", "~5"]);
  // A list written again takes the newest place without making a place for itself twice.
  placeKept(kept, "~3", 33, 4);
  expect(Object.keys(kept)).toEqual(["owner", "~4", "~1", "~5", "~3"]);
});

test("a project's or an agent file's entry carries how its server lives", async () => {
  const { runnable } = await import("./project.ts");
  expect(runnable({ command: "x", share: false, keep_running: true })).toMatchObject({ share: false, keep_running: true });
  expect(runnable({ command: "x", share: true })).not.toHaveProperty("share");
});
