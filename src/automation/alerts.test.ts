import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { ask, answer } from "../tools/interact.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import { clip, setDeps } from "./core.ts";
import * as snooze from "./snooze.ts";

// The alert service over a scratch store: what the inbox keeps, reads and
// sends. Paths an e2e cannot set up on demand (two agents asking at once, a
// channel that throws, a 30-day-old open question, a midnight snooze).
const scratch = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-alerts-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const errors: unknown[] = [];
  setDeps({ store, bus: new Bus(), errors: { capture: (_s: string, e: unknown) => void errors.push(e) } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  const session = (title: string, parent?: string) => {
    const s = store.createSession({ title, model: "m", workspace: "/" });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
    return s.id;
  };
  return { store, errors, session };
};
const settle = () => new Promise((r) => setTimeout(r, 20));

test("two agents' questions are two decisions; a redelivery replaces its own row", async () => {
  const { session } = scratch();
  const p = session("Build"), a = session("Docs", p), b = session("Tests", p);
  const sig = new AbortController().signal;
  void ask({ sessionId: a, callId: "qa", signal: sig } as any);
  void ask({ sessionId: b, callId: "qb", signal: sig } as any);
  alerts.raise("question", a, "Question: Docs", "Keep backup?", { call_id: "qa", open_session: a });
  alerts.raise("question", b, "Question: Tests", "Retain logs?", { call_id: "qb", open_session: b });
  alerts.raise("question", a, "Question: Docs", "Keep backup?", { call_id: "qa", open_session: a });
  expect(alerts.unreadCounts().sessions[p]).toBe(2);
  expect(alerts.unreadCounts().children).toEqual({ [a]: 1, [b]: 1 });
  answer(b, "qb", {});
  alerts.readWhere("call_id", "qb");
  expect(alerts.unreadCounts().sessions[p]).toBe(1);
  const left = alerts.list({ unread: true });
  expect(left.map((x) => x.data.child_title)).toEqual(["Docs"]);
});

test("a read names what it saw: a replay never reads a newer or re-marked alert", () => {
  const { session } = scratch();
  const s = session("S");
  const a = alerts.raise("agent", s, "S", "first")!;
  const seen = alerts.currentRev();
  expect(alerts.markRead({ all: true, seen })).toBe(1);
  const b = alerts.raise("finished", s, "S", "second")!;
  expect(alerts.markRead({ all: true, seen })).toBe(0); // the same click, replayed
  expect(alerts.list({ unread: true }).map((x) => x.id)).toEqual([b.id]);
  // Marked unread to come back to: an old read of it, and the page reading the
  // session on screen, both leave it; reading it on purpose clears it.
  alerts.markUnread(a.id);
  expect(alerts.markRead({ ids: [a.id], seen })).toBe(0);
  expect(alerts.markRead({ session_id: s, auto: true, seen: alerts.currentRev() })).toBe(1); // b only
  expect(alerts.list({ unread: true }).map((x) => x.id)).toEqual([a.id]);
  expect(alerts.markRead({ ids: [a.id], seen: alerts.currentRev() })).toBe(1);
});

test("each channel gets its own attempt and its own outcome; retry resends only the failed one", async () => {
  const { session } = scratch();
  const s = session("S");
  const got: Record<string, number> = { ok: 0, bad: 0 };
  let fail = true;
  const withdrawn: string[] = [];
  alerts.registerChannel({ id: "bad", label: "bad", available: () => true, deliver: () => { got.bad!++; if (fail) throw new Error("refused"); }, withdraw: (id) => void withdrawn.push(`bad:${id}`) });
  alerts.registerChannel({ id: "ok", label: "ok", available: () => true, deliver: async () => void got.ok!++, withdraw: (id) => void withdrawn.push(`ok:${id}`) });
  alerts.saveSettings({ route: { kind: "agent", channel: "bad", on: true } });
  alerts.saveSettings({ route: { kind: "agent", channel: "ok", on: true } });
  const a = alerts.raise("agent", s, "S", "hello");
  expect(a?.id).toBeTruthy();
  await settle();
  expect(got).toEqual({ ok: 1, bad: 1 });
  expect(alerts.get(a!.id)!.delivery).toMatchObject({ ok: { state: "sent" }, bad: { state: "failed" } });
  fail = false;
  alerts.retry(a!.id);
  await settle();
  expect(got).toEqual({ ok: 1, bad: 2 });
  expect(alerts.get(a!.id)!.delivery).toMatchObject({ ok: { state: "sent" }, bad: { state: "sent" } });
  // Mark all read takes back what every channel shows for the session.
  alerts.markRead({ all: true });
  await settle();
  expect(withdrawn.sort()).toEqual([`bad:${s}`, `ok:${s}`]);
  // Nothing routed: the alert says why it stayed in the inbox.
  const t = alerts.raise("finished", s, "S", "done");
  expect(t?.data?.inbox_only).toEqual({ no_route: true });
  alerts.registerChannel({ id: "off", label: "off", available: () => false, deliver: () => {} });
  alerts.saveSettings({ route: { kind: "failed", channel: "off", on: true } });
  expect(alerts.raise("failed", s, "S", "x")?.data?.inbox_only).toEqual({ not_set_up: ["off"] });
});

test("the sweep keeps an old reminder whose question is still open", () => {
  const { store, session } = scratch();
  const p = session("Build"), c = session("Docs", p);
  const sig = new AbortController().signal;
  void ask({ sessionId: c, callId: "q1", signal: sig } as any);
  const q = alerts.raise("question", c, "Question: Docs", "Which?", { call_id: "q1", open_session: c })!;
  const n = alerts.raise("agent", p, "Build", "note")!;
  alerts.markRead({ ids: [n.id] });
  store.db.query("UPDATE alerts SET ts = ?").run(Date.now() - 31 * 86400_000);
  alerts.sweep();
  expect(alerts.list({ limit: 10 }).map((x) => x.id)).toEqual([q.id]);
  answer(c, "q1", {});
  alerts.sweep();
  expect(alerts.list({ limit: 10 })).toEqual([]);
});

test("a session's snooze ending stays off the channels while alerts are snoozed", () => {
  const { session } = scratch();
  const s = session("S");
  let sent = 0;
  alerts.registerChannel({ id: "rec", label: "rec", available: () => true, deliver: () => void sent++ });
  alerts.saveSettings({ route: { kind: "snooze_over", channel: "rec", on: true } });
  snooze.setGlobal(Date.now() + 30 * 60_000);
  snooze.set(s, { until_ms: Date.now() + 1000 }, false);
  alerts.raise("snooze_over", s, "Snooze over: S", "Back from snooze.");
  expect(sent).toBe(0);
  expect(alerts.list({ unread: true })[0]?.data?.held).toBe(true);
});

test("a background page does not stop the owner watching a session in another", () => {
  const { session } = scratch();
  const a = session("A");
  alerts.setPresence(a, true, "p1");
  alerts.setPresence(null, false, "p2");
  expect(alerts.raise("finished", a, "A", "done")).toBeUndefined(); // watched: stays in that page
});

test("cut text keeps whole characters; activity pages never skip a shared millisecond", () => {
  expect(clip("a".repeat(499) + "😀", 500)).toBe("a".repeat(499) + "…");
  expect(clip("a".repeat(498) + "😀", 500)).toBe("a".repeat(498) + "😀");
  expect(clip("ab👍🏽", 4)).toBe("ab…");
  const { store, session } = scratch();
  const s = session("S");
  for (const t of ["older", "A", "B", "C"]) activity.record("turn", "end", s, t);
  const ts = Date.now();
  store.db.query("UPDATE activity SET ts = ? WHERE text != 'older'").run(ts);
  store.db.query("UPDATE activity SET ts = ? WHERE text = 'older'").run(ts - 5);
  const seen: string[] = [];
  let before: string | undefined;
  for (;;) {
    const r = activity.list({ limit: 2, session_id: s, before });
    seen.push(...r.items.map((x) => x.text));
    if (!r.has_more) break;
    before = `${r.items.at(-1)!.ts}:${r.items.at(-1)!.id}`;
  }
  expect(seen.sort()).toEqual(["A", "B", "C", "older"]);
  // Rows past the 30 days are not listed even before the sweep runs.
  store.db.query("UPDATE activity SET ts = ? WHERE text = 'older'").run(Date.now() - 31 * 86400_000);
  expect(activity.list({ session_id: s }).items.map((x) => x.text)).not.toContain("older");
});

test("a finished notice quotes this turn's reply and names it, or none", () => {
  const { store, session } = scratch();
  const s = session("Demo");
  const turn = (reply?: string) => {
    store.append(s, "turn_start", { model: "m" });
    store.append(s, "user", { text: "go" });
    const e = reply ? store.append(s, "assistant", { blocks: [{ type: "text", text: reply }] }) : undefined;
    alerts.onTurnEnd(s, "end_turn", { subagent: false, loopRun: false, more: false });
    return { e, a: alerts.list({ limit: 1 })[0]! };
  };
  const one = turn("Checks passed\nfirst");
  const two = turn("Checks passed\nsecond");
  const three = turn();
  expect(one.a.data.event_id).toBe(one.e!.id);
  expect(two.a.data.event_id).toBe(two.e!.id);
  expect(three.a.body).toBe("The turn finished.");
  expect(three.a.data?.event_id).toBeUndefined();
});
