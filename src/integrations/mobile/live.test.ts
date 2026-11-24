import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { liveData, liveStatus, LiveTicker, readLive, type LiveStatus } from "./live.ts";

test("the status counts what runs and what waits, the longest-running first", () => {
  const s = liveStatus([
    { title: "Docs", running: true, since: 2000, needs: 0 },
    { title: "Fix the build", running: true, since: 1000, needs: 1 },
    { title: "Idle", running: false, needs: 1 },
  ]);
  // Fix the build waits on the owner: it needs them, it does not work.
  expect(s).toEqual({ working: 1, needs: 2, failed: 0, titles: ["Docs"], since: 2000 });
  expect(liveData(s)).toEqual({ w: "1", q: "2", f: "0", to: "needs", title: "1 session working · 2 need you", body: "Docs", since: "2000" });
  expect(liveData(liveStatus([]))).toEqual({ w: "0", q: "0", f: "0", to: "sessions", title: "", body: "" });
});

test("the open errors ride with work or a wait, and a tap goes to what asks first", () => {
  const runs = [{ title: "Docs", running: true, since: 2000, needs: 0 }];
  // Beside work: counted and named, and the tap goes to the errors.
  const s = liveStatus(runs, 3);
  expect(liveData(s)).toEqual({ w: "1", q: "0", f: "3", to: "errors", title: "1 session working · 3 errors", body: "Docs", since: "2000" });
  // A wait on the owner comes first.
  expect(liveData(liveStatus([...runs, { title: "Fix", running: false, needs: 1 }], 1))).toMatchObject({ f: "1", to: "needs", title: "1 session working · 1 needs you · 1 error" });
  // Alone, errors put nothing up: each failure has a notification of its own.
  expect(liveStatus([], 4)).toEqual({ working: 0, needs: 0, failed: 0, titles: [], since: null });
  expect(liveData(liveStatus(runs, 0)).to).toBe("sessions");
});

test("a change of the open errors is sent while something runs, and a status told before them reads as none", async () => {
  let now: LiveStatus = { working: 1, needs: 0, failed: 0, titles: ["A"], since: 1 };
  // What a daemon from before told: no count of errors.
  let kept: any = { working: 1, needs: 0, titles: ["A"], since: 1 };
  const sent: LiveStatus[] = [];
  const t = new LiveTicker(() => now, (x) => { sent.push(x); return true; }, 10, () => true, { get: () => kept, set: (x) => void (kept = x) });
  t.poke(); await Bun.sleep(30);
  expect(sent).toEqual([]);
  now = { ...now, failed: 2 }; t.poke(); await Bun.sleep(30);
  expect(sent.map((x) => x.failed)).toEqual([2]);
  t.stop();
});

test("a change is held and sent once; one that comes and goes inside the hold sends nothing; the end is sent", async () => {
  let now: LiveStatus = { working: 0, needs: 0, failed: 0, titles: [], since: null };
  const sent: LiveStatus[] = [];
  const t = new LiveTicker(() => now, (s) => { sent.push(s); return true; }, 30);
  // Nothing runs and nothing was told: nothing to say.
  t.poke(); await Bun.sleep(60);
  expect(sent).toEqual([]);
  // A turn starts and ends inside one hold: nothing.
  now = { working: 1, needs: 0, failed: 0, titles: ["A"], since: 1 }; t.poke();
  now = { working: 0, needs: 0, failed: 0, titles: [], since: null }; t.poke();
  await Bun.sleep(60);
  expect(sent).toEqual([]);
  // A turn that runs: one push, however often it is poked.
  now = { working: 1, needs: 0, failed: 0, titles: ["A"], since: 1 };
  for (let i = 0; i < 5; i++) t.poke();
  await Bun.sleep(60);
  t.poke(); await Bun.sleep(60);
  expect(sent.map((s) => s.working)).toEqual([1]);
  // It ends: the push that takes the notification down.
  now = { working: 0, needs: 0, failed: 0, titles: [], since: null }; t.poke(); await Bun.sleep(60);
  expect(sent.map((s) => s.working)).toEqual([1, 0]);
  t.stop();
});

test("what was last told outlives the daemon: the next one takes the notification down when nothing runs", async () => {
  const working: LiveStatus = { working: 2, needs: 1, failed: 0, titles: ["A", "B"], since: 1 };
  const idle: LiveStatus = { working: 0, needs: 0, failed: 0, titles: [], since: null };
  let kept: LiveStatus | null = null;
  const keep = { get: () => kept, set: (s: LiveStatus) => void (kept = s) };
  const sent: LiveStatus[] = [];
  let now = working;
  const before = new LiveTicker(() => now, (s) => { sent.push(s); return true; }, 10, () => true, keep);
  before.poke(); await Bun.sleep(40);
  // The turns end inside the hold, and the daemon stops before it is over.
  now = idle; before.poke(); before.stop();
  const after = new LiveTicker(() => now, (s) => { sent.push(s); return true; }, 10, () => true, keep);
  after.poke(); await Bun.sleep(40);
  expect(sent.map((s) => s.working)).toEqual([2, 0]);
  after.stop();
});

test("a push that did not go is sent again, and a send that throws is no unhandled failure", async () => {
  const now: LiveStatus = { working: 1, needs: 0, failed: 0, titles: ["A"], since: 1 };
  let tries = 0;
  const fails: unknown[] = [];
  const t = new LiveTicker(() => now, () => { tries++; if (tries === 1) throw new Error("no network"); return tries > 2; }, 5, () => true, undefined, (e) => fails.push(e));
  t.poke();
  // A throw, then a refusal, then it goes; after that the same status is not sent again.
  for (let i = 0; i < 100 && tries < 3; i++) await Bun.sleep(10);
  t.poke(); await Bun.sleep(30);
  expect([tries, fails.length]).toEqual([3, 1]);
  t.stop();
});

test("the status is read from what runs and waits, never a whole table, and each turn's start is one seek", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-live-")));
  const make = (title: string) => store.createSession({ title, model: "fx:m", workspace: "/w" });
  const runs = make("Runs"), leads = make("Leads agents"), asks = make("Asks"), shelved = make("Shelved");
  for (let i = 0; i < 40; i++) make(`Idle ${i}`);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const agent = make("An agent");
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(leads.id, agent.id);
  store.updateSession(shelved.id, { archived: true });
  store.append(runs.id, "turn_start", {}, null, 5000);
  for (let i = 0; i < 30; i++) store.append(runs.id, "assistant", { text: String(i) });
  store.append(leads.id, "turn_start", {}, null, 4000);
  const running = new Set([runs.id, agent.id, shelved.id]);
  // What reads it: no list of every session, and each statement over events seeks an index made for it.
  const all = store.sessions.bind(store);
  let lists = 0;
  store.sessions = ((o?: any) => { lists++; return all(o); }) as any;
  const asked: string[] = [];
  const query = store.db.query.bind(store.db);
  store.db.query = ((sql: string) => { if (/\bFROM events\b/.test(sql)) asked.push(sql); return query(sql); }) as any;
  const s = readLive({ store, running: () => running, waiting: () => [agent.id, asks.id], below: () => new Map([[leads.id, 1]]), failed: () => 2 });
  store.db.query = query as any;
  // The agent's card is its root's: the root waits on the owner, and the archived session is not counted.
  expect(s).toEqual({ working: 1, needs: 2, failed: 2, titles: ["Runs"], since: 5000 });
  const plan = (sql: string) => JSON.stringify(query("EXPLAIN QUERY PLAN " + sql).all(...Array(sql.split("?").length - 1).fill(runs.id)));
  expect(asked.length).toBeGreaterThan(0);
  expect({ lists, unindexed: asked.filter((sql) => !plan(sql).includes("events_turn_marks")) }).toEqual({ lists: 0, unindexed: [] });
});

test("a change during a send that then fails waits the longer hold, not its own", async () => {
  const now: LiveStatus = { working: 1, needs: 0, failed: 0, titles: ["A"], since: 1 };
  let tries = 0;
  let release: (ok: boolean) => void = () => {};
  const t = new LiveTicker(() => now, () => { tries++; return tries === 1 ? new Promise<boolean>((r) => (release = r)) : true; }, 50, () => true);
  const out = t.flush();
  await Bun.sleep(5);
  t.poke(); // a change while the first send is out: a plain hold of 50 ms
  await Bun.sleep(5);
  release(false);
  await out;
  // The plain hold would try again at about 50 ms; the failure's hold is 100 ms from the failure.
  await Bun.sleep(75);
  expect(tries).toBe(1);
  await Bun.sleep(60);
  expect(tries).toBe(2);
  t.stop();
});
