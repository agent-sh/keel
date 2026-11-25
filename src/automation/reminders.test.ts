import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { ask } from "../tools/interact.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import { setDeps } from "./core.ts";
import * as reminders from "./reminders.ts";
import * as snooze from "./snooze.ts";

// What a card that waits while the owner is away is told, and that a restart keeps the schedule.
const MIN = 60_000;
const open = (dir: string) => {
  const store = new Store(dir);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  setDeps({ store, bus: new Bus(), errors: { capture: () => {} } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  reminders.migrate();
  return store;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

test("an unanswered question is told again while the owner is away, once a session, and a restart keeps the next time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-reminders-"));
  let store = open(dir);
  const sent: string[] = [];
  alerts.registerChannel({ id: "desktop", label: "Desktop", available: () => true, deliver: (a, o) => void sent.push(`${o?.reminder ? "again" : "first"}:${a.title}|${a.body.split("\n")[0]}`) });
  alerts.saveSettings({ routes: { ...Object.fromEntries(alerts.KINDS.map((k) => [k, []])), question: ["desktop"] } as any });
  const s = store.createSession({ title: "Build", model: "m", workspace: "/" }).id;
  const sig = new AbortController().signal;
  void ask({ sessionId: s, callId: "q1", signal: sig } as any);
  void ask({ sessionId: s, callId: "q2", signal: sig } as any);
  const a1 = alerts.raise("question", s, "Question: Build", "Keep the backup?", { call_id: "q1", open_session: s })!;
  alerts.raise("question", s, "Question: Build", "Retain logs?", { call_id: "q2", open_session: s });
  await settle();
  expect(sent).toHaveLength(2); // each card was told once when it came
  sent.length = 0;
  const t0 = a1.ts, input = t0 - 10 * MIN;

  // Away, but not for long: nothing yet. The owner back: nothing, whatever the time.
  expect(reminders.tick(t0 + 5 * MIN, input, true)).toEqual([]);
  expect(reminders.tick(t0 + 40 * MIN, null, true)).toEqual([]);
  // 15 minutes: one reminder for the session, with the count of the other card.
  expect(reminders.tick(t0 + 16 * MIN, input, true)).toEqual([s]);
  await settle();
  expect(sent).toEqual(["again:Still waiting: Question: Build|Waiting 16 min. 1 more card waits in this session."]);
  expect(reminders.tick(t0 + 17 * MIN, input, true)).toEqual([]);

  // The daemon restarts: the same store, nothing in memory. The next reminder is still the hour's, not a new 15 minutes.
  store.db.close();
  store = open(dir);
  expect(reminders.tick(t0 + 18 * MIN, input, true)).toEqual([]);
  expect(reminders.tick(t0 + 59 * MIN, input, true)).toEqual([]);
  expect(reminders.tick(t0 + 61 * MIN, input, true)).toEqual([s]);
  // An answered card leaves the schedule and the count; the other one still waits.
  alerts.readWhere("call_id", "q1", s);
  const { answer } = await import("../tools/interact.ts");
  answer(s, "q1", {});
  sent.length = 0;
  expect(reminders.tick(t0 + 4 * 60 * MIN + MIN, input, true)).toEqual([s]);
  await settle();
  expect(sent[0]).toBe("again:Still waiting: Question: Build|Waiting 4 h 1 min.");
  expect(store.db.query("SELECT COUNT(*) AS n FROM card_reminders").get()).toEqual({ n: 1 });
});

test("no reminder where the owner's routes name no interrupting channel", async () => {
  const store = open(mkdtempSync(join(tmpdir(), "keel-reminders-")));
  const sent: string[] = [];
  alerts.registerChannel({ id: "desktop", label: "Desktop", available: () => true, deliver: (a) => void sent.push(a.title) });
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  const s = store.createSession({ title: "T", model: "m", workspace: "/" }).id;
  void ask({ sessionId: s, callId: "q", signal: new AbortController().signal } as any);
  const a = alerts.raise("question", s, "Q", "Which?", { call_id: "q", open_session: s })!;
  expect(reminders.tick(a.ts + 20 * MIN, a.ts - MIN, true)).toEqual([]);
  alerts.saveSettings({ route: { kind: "question", channel: "desktop", on: true } });
  expect(reminders.tick(a.ts + 21 * MIN, a.ts - MIN, true)).toEqual([s]); // the first look after it was routed tells the gap it missed
  await settle();
  expect(sent).toHaveLength(1);
});
