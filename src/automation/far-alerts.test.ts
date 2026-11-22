import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import * as connection from "./connection.ts";
import { setDeps } from "./core.ts";
import * as snooze from "./snooze.ts";

// Alerts another daemon raised for its sessions, kept here as this daemon's
// own: once whatever is replayed, read on both sides, gone with the session.
// And the connection log's bounds. The orders an e2e cannot set up on demand
// (a frame told twice, a link down across an alert, a first link with history).
const scratch = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-far-alerts-")));
  const frames: any[] = [];
  const bus = new Bus();
  bus.on((f) => { if (f.t === "feature" && f.name === "automation") frames.push(f.data); });
  // What is captured is not thrown: the parts set here stay the process's own after this file, and a timer of another module may still report to them.
  setDeps({ store, bus, errors: { capture: () => {} } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  const told: [string, string[]][] = [];
  alerts.farHook.read = (machine, ids) => void told.push([machine, ids]);
  alerts.farHook.has = () => true;
  alerts.farHook.target = undefined;
  return { store, frames, told };
};
let n = 0;
const far = (kind: alerts.AlertKind, session: string, more: Partial<alerts.Alert> = {}): alerts.Alert =>
  ({ id: `far-${++n}`, ts: 1_000 + n, kind, session_id: session, title: `${kind} of ${session}`, body: "words", read: false, rev: n, kept: false, ...more });

test("another daemon's alert is kept once, under the id pages know its session by", () => {
  const { frames } = scratch();
  const a = far("finished", "s1", { data: { event_id: "e9", ran_ms: 12 } });
  const kept = alerts.mirror("m1", a)!;
  expect(kept.session_id).toBe("m1--s1");
  expect(kept.data).toMatchObject({ event_id: "e9", far: { machine: "m1", alert: a.id } });
  // Told again (a reconnect's catch-up, a channel's handoff frame, a restart of either daemon): still one.
  expect(alerts.mirror("m1", { ...a, delivery: { desktop: { state: "sent" } } })).toBeUndefined();
  expect(alerts.mirrorSince("m1", [a])).toBe(0);
  expect(alerts.list().map((x) => [x.kind, x.session_id, x.read])).toEqual([["finished", "m1--s1", false]]);
  expect(alerts.unreadCounts()).toMatchObject({ total: 1, sessions: { "m1--s1": 1 }, fresh: { "m1--s1": 1 } });
  expect(frames.filter((f) => f.kind === "alert")).toHaveLength(1);
  // The activity list has it under that session too.
  expect(activity.list({ kinds: ["alert"] }).items.map((x) => x.session_id)).toEqual(["m1--s1"]);
});

test("an agent's request there stands under its parent here, and its decision replaces its own row", () => {
  scratch();
  const ask = (id: string) => far("approval", "p", { data: { approval_id: id, child_session: "kid", child_title: "Docs", open_session: "p", snoozed: true } });
  const first = alerts.mirror("m1", ask("ap1"))!;
  expect(first.data).toMatchObject({ approval_id: "ap1", child_session: "m1--kid", child_title: "Docs", open_session: "m1--p" });
  expect(first.data.snoozed).toBeUndefined(); // what that daemon did with it is its own
  alerts.mirror("m1", ask("ap1")); // raised again there under a new id: the same decision
  alerts.mirror("m1", ask("ap2"));
  expect(alerts.list({ unread: true }).map((x) => x.data.approval_id).sort()).toEqual(["ap1", "ap2"]);
  expect(alerts.unreadCounts().children).toEqual({ "m1--kid": 2 });
  // Where it leads: the parent's page, the request still waiting as far as this daemon knows.
  expect(alerts.alertTarget(alerts.list()[0]!)).toMatchObject({ parent: "m1--p", child: "m1--kid", open: "m1--kid" });
});

test("this daemon's rules decide: nothing for a finish the owner watches here, read when it was read there", () => {
  scratch();
  alerts.setPresence("m1--s1", true, "page");
  expect(alerts.mirror("m1", far("finished", "s1"))).toBeUndefined();
  alerts.setPresence(null, true, "page");
  expect(alerts.mirror("m1", far("finished", "s2", { read: true }))!.read).toBe(true);
  // Never a relay of a relay, and nothing of that daemon's own business.
  expect(alerts.mirror("m1", far("finished", "m2--s3"))).toBeUndefined();
  expect(alerts.mirror("m1", far("snooze_over", "s4"))).toBeUndefined();
  expect(alerts.mirror("m1", { ...far("failed", "s5"), session_id: null })).toBeUndefined();
});

test("a machine's history stays its own at the first link; what came while the link was down is read after", () => {
  scratch();
  const old = [far("finished", "s1"), far("failed", "s2")];
  expect(alerts.mirrorSince("m1", old)).toBe(0);
  expect(alerts.list()).toHaveLength(0);
  // The link drops; two alerts are raised there; one more arrives live when it is back, before the list is read.
  const missed = [far("question", "s1", { data: { call_id: "c1", open_session: "s1" } }), far("finished", "s2")];
  const live = far("failed", "s3");
  alerts.mirror("m1", live, false);
  expect(alerts.mirrorSince("m1", [...old, ...missed, live])).toBe(2);
  expect(alerts.list().map((x) => [x.kind, x.session_id]).sort()).toEqual([["failed", "m1--s3"], ["finished", "m1--s2"], ["question", "m1--s1"]]);
  // Read again at the next open: nothing new, also of one this daemon chose not to keep (the owner watched it here).
  alerts.setPresence("m1--s4", true, "page");
  const watched = far("finished", "s4");
  expect(alerts.mirror("m1", watched)).toBeUndefined();
  alerts.setPresence(null, false, "page");
  expect(alerts.mirrorSince("m1", [...old, ...missed, live, watched])).toBe(0);
  expect(alerts.list()).toHaveLength(3);
});

test("read here is told there, read there is read here, and neither echoes", () => {
  const { told } = scratch();
  const a = far("finished", "s1"), b = far("failed", "s1"), c = far("finished", "s2");
  for (const x of [a, b, c]) alerts.mirror("m1", x);
  // The page reads the session it shows: what calls the owner (the failure) waits for them to act there.
  expect(alerts.markRead({ session_id: "m1--s1", auto: true })).toBe(1);
  expect(alerts.markRead({ session_id: "m1--s1", touch: true })).toBe(1);
  expect(told).toEqual([["m1", [a.id]], ["m1", [b.id]]]);
  // That daemon says the third was read on its own page.
  alerts.farWasRead("m1", { ids: [c.id] });
  expect(alerts.unreadCounts().total).toBe(0);
  expect(told).toHaveLength(2);
  // A session deleted there takes its alerts here; a machine taken out takes the rest and its cursor.
  alerts.farGone("m1", "s1");
  expect(alerts.list().map((x) => x.session_id)).toEqual(["m1--s2"]);
  alerts.farGone("m1");
  expect(alerts.list()).toHaveLength(0);
  expect(alerts.mirrorSince("m1", [far("finished", "s9")])).toBe(0); // a first link again
});

test("a machine out of reach is told once per absence", () => {
  scratch();
  expect(alerts.raisedOffline("m1", 5_000)).toBe(false);
  alerts.raise("failed", null, "devbox is offline", "Not heard from since 14:02.", { machine_offline: "m1", since_ms: 5_000 });
  expect(alerts.raisedOffline("m1", 5_000)).toBe(true);
  expect(alerts.raisedOffline("m1", 9_000)).toBe(false); // another absence
  alerts.readWhere("machine_offline", "m1");
  expect(alerts.list().map((x) => x.read)).toEqual([true]);
});

test("the connection log lists an absence once it ended, a dozen an hour per source, and says what it left out", () => {
  scratch();
  connection.reset();
  const now = Date.now();
  expect(connection.pageAbsence(now - 400, now, "silent")).toBe(false); // a blip
  expect(connection.pageAbsence(now - 25_000, now, "silent")).toBe(true);
  expect(connection.machineAbsence({ id: "m1", name: "devbox" }, now - 190_000, now, "the stream went silent")).toBe(true);
  const rows = () => activity.list({ kinds: ["daemon"] }).items;
  expect(rows().map((r) => [r.sub, r.text.replace(/\d\d:\d\d:\d\d/, "T")]).sort()).toEqual([
    ["connection", "A page did not hear Keel for 25 s, from T: its connection went silent"],
    ["machine", "devbox was out of reach for 3 min 10 s, from T: the stream went silent"],
  ]);
  for (let i = 0; i < 20; i++) connection.pageAbsence(now - 5_000, now, "closed");
  expect(rows().filter((r) => r.sub === "connection")).toHaveLength(12);
  // Nonsense is not listed: a time that is no number, an end before its start, an end in the future.
  expect([connection.pageAbsence(NaN, now, "x"), connection.pageAbsence(now, now - 5_000, "x"), connection.machineAbsence({ id: "m2", name: "x" }, now, now + 3_600_000)]).toEqual([false, false, false]);
  expect(connection.span(59_400)).toBe("59 s");
  expect(connection.span(3_725_000)).toBe("1 h 2 min");
});
