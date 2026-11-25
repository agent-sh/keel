import { expect, test } from "bun:test";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { tempTree } from "../../test/env.ts";
import { LOOKS_PER_HOUR } from "./error-look.ts";
import { Looks } from "./looks.ts";

// The looks with a real store and error tracker, and a model that counts what it was asked.
function setup(answer: (n: number) => string | undefined = () => '{"what":"The key is missing.","blame":"setup","step":"Add it in Settings"}') {
  const store = new Store(tempTree("keel-looks-"));
  const bus = new Bus();
  const errors = new ErrorTracker(store, bus);
  const session = store.createSession({ title: "Helper", model: "scripted:stand-in", workspace: "/", settings: { helper: true } });
  const asked: string[] = [];
  const told: string[] = [];
  const deps: any = {
    store, bus, errors,
    engine: { small: async (_id: string, _m: string, o: { prompt: string }) => { asked.push(o.prompt); const t = answer(asked.length); return t === undefined ? undefined : { text: t, model: "scripted:stand-in", usage: { input: 100, output: 20, cache_read: 0, cache_write: 0 } }; } },
    providers: { cachedModel: () => ({ name: "Scripted", billing: "per_token", price: { input: 1, output: 5 } }), catalog: { lookup: () => undefined } },
  };
  const looks = new Looks(deps, { session: () => session, on: () => true, isHelper: (id) => id === session.id }, (l) => told.push(`${l.state}:${l.cause}`));
  const row = (message: string, over: any = {}) => errors.capture("server", Object.assign(new Error(message), over));
  return { looks, row, asked, told, errors, store, session };
}

test("rows of one cause get one look: the second row is added to it and nothing is asked", async () => {
  const t = setup();
  const a = t.row("ENOENT: no such file, open '/home/a/one/x.json'");
  const b = t.row("ENOENT: no such file, open '/home/b/two/x.json'");
  expect(a.id).not.toBe(b.id);
  const first = await t.looks.settle(a.id, false);
  const second = await t.looks.settle(b.id, false);
  expect(t.asked.length).toBe(1);
  expect(first).toMatchObject({ state: "done", blame: "setup", step: "Add it in Settings", model: "Scripted" });
  expect(first!.cost).toBeCloseTo((100 * 1 + 20 * 5) / 1e6, 9);
  expect(first!.tokens).toBe(120);
  expect(second!.cause).toBe(first!.cause);
  expect(t.looks.get(first!.cause)!.error_ids).toEqual([a.id, b.id]);
  // The same row again, as a capture of a row already looked at: still one look.
  await t.looks.settle(a.id, false);
  expect(t.asked.length).toBe(1);
});

test("different causes are looked at one after the other, up to the hour's count; the rest are held until the owner asks", async () => {
  const t = setup();
  const rows = Array.from({ length: LOOKS_PER_HOUR + 2 }, (_, i) => t.row(`Failure number${"x".repeat(i)} in a place`));
  const results = [];
  for (const r of rows) results.push(await t.looks.settle(r.id, false));
  expect(t.asked.length).toBe(LOOKS_PER_HOUR);
  expect(results.slice(0, LOOKS_PER_HOUR).every((l) => l!.state === "done")).toBe(true);
  expect(results.slice(LOOKS_PER_HOUR).map((l) => l!.state)).toEqual(["held", "held"]);
  // A held look is asked for on the owner's word, and that is one more request, once.
  const held = results[LOOKS_PER_HOUR]!;
  const done = await t.looks.ask(held.cause);
  expect(done!.state).toBe("done");
  expect(t.asked.length).toBe(LOOKS_PER_HOUR + 1);
});

test("a look that failed is not made again by itself; a row the owner resolved or the helper's own row is not looked at", async () => {
  const t = setup(() => undefined);
  const a = t.row("Odd failure alpha");
  const l = await t.looks.settle(a.id, false);
  expect(l).toMatchObject({ state: "failed" });
  await t.looks.settle(a.id, false);
  expect(t.asked.length).toBe(1);
  const b = t.row("Odd failure beta");
  t.errors.capture("server", new Error("x"));
  t.store.db.query("UPDATE errors SET resolved_ts = ? WHERE id = ?").run(Date.now(), b.id);
  expect(await t.looks.settle(b.id, false)).toBeUndefined();
  const own = t.errors.capture("server", new Error("The helper's own failure"), { session: t.session.id });
  expect(await t.looks.settle(own.id, false)).toBeUndefined();
  expect(t.asked.length).toBe(1);
});

test("a look that was under way when the daemon stopped is said to have failed", () => {
  const t = setup();
  t.store.db.query("INSERT INTO helper_looks (cause, ts, data) VALUES ('c1', 1, ?)").run(JSON.stringify({ cause: "c1", state: "looking", error_ids: [], ts: 1, title: "t" }));
  const again = new Looks({ ...t.looks["deps"] } as any, { session: () => t.session, on: () => true, isHelper: () => false }, () => {});
  expect(again.get("c1")).toMatchObject({ state: "failed" });
});

test("a row of the cause that comes while its look is under way stays on the finished look", async () => {
  const t = setup();
  const a = t.row("ENOENT: no such file, open '/home/a/one/y.json'");
  const b = t.row("ENOENT: no such file, open '/home/b/two/y.json'");
  const [first] = await Promise.all([t.looks.settle(a.id, false), t.looks.settle(b.id, false)]);
  expect(t.asked.length).toBe(1);
  expect(t.looks.get(first!.cause)!.error_ids).toEqual([a.id, b.id]);
});
