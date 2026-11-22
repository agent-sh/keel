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
// own: once whatever is replayed, read on both sides, gone with the session,
// and never more of that daemon's word than an alert carries. And the
// connection log's bounds. The orders an e2e cannot set up on demand (a
// frame told twice, a link down across an alert or a read, a flood).
const scratch = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-far-alerts-")));
  const frames: any[] = [];
  const bus = new Bus();
  bus.on((f) => { if (f.t === "feature" && f.name === "automation") frames.push(f.data); });
  // What is captured is not thrown: the parts set here stay the process's own after this file, and a timer of another module may still report to them.
  const errors: unknown[] = [];
  setDeps({ store, bus, errors: { capture: (_s: string, e: unknown) => void errors.push(e) } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  // The link to the other daemon: down, or up and keeping what it is told.
  const link = { up: true, read: [] as [string, string[]][], unread: [] as [string, string][] };
  alerts.farHook.read = async (machine, ids) => { if (!link.up) throw new Error("down"); link.read.push([machine, ids]); };
  alerts.farHook.unread = async (machine, id) => { if (!link.up) throw new Error("down"); link.unread.push([machine, id]); };
  alerts.farHook.has = () => true;
  alerts.farHook.target = undefined;
  const names: Record<string, string> = { m1: "devbox" };
  alerts.farHook.name = (id) => names[id];
  alerts.resetMinutes();
  const session = (title: string) => store.createSession({ title, model: "m", workspace: "/" }).id;
  return { store, frames, link, names, errors, session };
};
const settle = () => new Promise((r) => setTimeout(r, 5));
let n = 0;
const far = (kind: alerts.AlertKind, session: string, more: Partial<alerts.Alert> = {}): alerts.Alert =>
  ({ id: `far-${++n}`, ts: 1_000 + n, kind, session_id: session, title: `${kind} of ${session}`, body: "words", read: false, rev: n, kept: false, ...more });

test("another daemon's alert is kept once, under the id pages know its session by, with its machine's name", () => {
  const { frames, names } = scratch();
  const a = far("finished", "s1", { data: { event_id: "e9", ran_ms: 12 } });
  const kept = alerts.mirror("m1", a)!;
  expect(kept.session_id).toBe("m1--s1");
  expect(kept.data).toMatchObject({ event_id: "e9", far: { machine: "m1", alert: a.id, ts: a.ts } });
  // The machine is served with the alert, by the name it has now.
  expect(kept.machine).toEqual({ id: "m1", name: "devbox" });
  names.m1 = "buildbox";
  expect(alerts.list()[0]!.machine).toEqual({ id: "m1", name: "buildbox" });
  // Told again (a reconnect's catch-up, a channel's handoff frame, a restart of either daemon): still one.
  expect(alerts.mirror("m1", { ...a, delivery: { desktop: { state: "sent" } } })).toBeUndefined();
  expect(alerts.mirrorSince("m1", [a])).toBe(0);
  expect(alerts.list().map((x) => [x.kind, x.session_id, x.read])).toEqual([["finished", "m1--s1", false]]);
  expect(alerts.unreadCounts()).toMatchObject({ total: 1, sessions: { "m1--s1": 1 }, fresh: { "m1--s1": 1 } });
  expect(frames.filter((f) => f.kind === "alert")).toHaveLength(1);
  // The activity list has it under that session too.
  expect(activity.list({ kinds: ["alert"] }).items.map((x) => x.session_id)).toEqual(["m1--s1"]);
  // Another machine may hold an alert of the same id: it is its own.
  expect(alerts.mirror("m2", a)!.session_id).toBe("m2--s1");
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

// The reviewer's schedules: a peer's approval alert that names a local approval's id, and a field of a megabyte.
test("another daemon's word never removes or reads an alert of this daemon's, and only an alert's own fields are kept", () => {
  const { session } = scratch();
  const mine = session("Mine");
  alerts.raise("approval", mine, "Approval: Mine", "Bash: ls", { approval_id: "ap-local", open_session: mine });
  alerts.mirror("m1", far("approval", "s1", { data: { approval_id: "ap-local", open_session: "s1" } }));
  expect(alerts.list({ unread: true }).map((a) => a.session_id).sort()).toEqual([mine, "m1--s1"].sort());
  // The local approval is answered: its alert is read, the other daemon's is not.
  alerts.readWhere("approval_id", "ap-local");
  expect(alerts.list({ unread: true }).map((a) => a.session_id)).toEqual(["m1--s1"]);
  // Two machines naming one approval id are two decisions.
  alerts.mirror("m2", far("approval", "s1", { data: { approval_id: "ap-local", open_session: "s1" } }));
  expect(alerts.list({ unread: true }).map((a) => a.session_id).sort()).toEqual(["m1--s1", "m2--s1"]);

  const big = alerts.mirror("m1", far("finished", "s2", { title: "t".repeat(5_000), body: "b".repeat(50_000), data: { event_id: "e1", blob: "x".repeat(1_000_000), child_title: "c".repeat(5_000), child_session: "kid", call_id: "y".repeat(1_000), ran_ms: "soon", nested: { deep: ["z".repeat(100_000)] } } as any }))!;
  // (`inbox_only` is this daemon's own note of why nothing left the inbox.)
  expect(Object.keys(big.data).filter((k) => k !== "inbox_only").sort()).toEqual(["child_session", "child_title", "event_id", "far"]);
  expect(big.data.child_title.length).toBeLessThanOrEqual(200);
  expect(JSON.stringify(alerts.list()).length).toBeLessThan(8_000);
  // An id that is no id, a session that is no session: not kept at all.
  expect(alerts.mirror("m1", far("finished", "s3", { id: "i".repeat(500) }))).toBeUndefined();
  expect(alerts.mirror("m1", far("finished", "../../etc"))).toBeUndefined();
  expect(alerts.mirror("m1", far("finished", "s".repeat(500)))).toBeUndefined();
});

test("this daemon's rules decide: nothing for a finish the owner watches here, read when it was read there", () => {
  scratch();
  alerts.setPresence("m1--s1", true, "page");
  expect(alerts.mirror("m1", far("finished", "s1"))).toBeUndefined();
  alerts.setPresence(null, true, "page");
  expect(alerts.mirror("m1", far("finished", "s2", { read: true }))!.read).toBe(true);
  // Never a relay of a relay, and nothing of that daemon's own business.
  expect(alerts.mirror("m1", far("finished", "s3", { data: { far: { machine: "m9", alert: "x" } } }))).toBeUndefined();
  expect(alerts.mirror("m1", far("snooze_over", "s4"))).toBeUndefined();
  expect(alerts.mirror("m1", far("machine" as alerts.AlertKind, "s4"))).toBeUndefined();
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

// The reviewer's schedule: 300 alerts raised during an outage, ten of them failures among the oldest.
test("of many raised while the link was down, what needs the owner and what failed are kept first, and one alert says how many were not", async () => {
  scratch();
  const told: string[] = [];
  alerts.registerChannel({ id: "command", label: "test", available: () => true, deliver: (a) => void told.push(a.kind) });
  alerts.saveSettings({ completion: "always", routes: Object.fromEntries(alerts.KINDS.map((k) => [k, ["command"]])) as any });
  try {
    expect(alerts.mirrorSince("m1", [far("finished", "s0")])).toBe(0);
    const raised = Array.from({ length: 300 }, (_, i) => (i < 10 ? far("failed", `f${i}`) : i < 14 ? far("question", `q${i}`, { data: { call_id: `c${i}`, open_session: `q${i}` } }) : far("finished", `s${i}`)));
    expect(alerts.mirrorSince("m1", raised)).toBe(alerts.FAR_KEPT_AT_ONCE);
    const kept = alerts.list({ limit: 200 });
    const of = (k: string) => kept.filter((a) => a.kind === k && a.data?.far).length;
    expect([of("failed"), of("question"), of("finished")]).toEqual([10, 4, 86]);
    // The finishes kept are the newest, and the inbox lists all of them in the order they were raised.
    const order = kept.filter((a) => a.data?.far).sort((x, y) => x.ts - y.ts).map((a) => a.data.far.ts);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(Math.min(...kept.filter((a) => a.kind === "finished" && a.data?.far).map((a) => a.data.far.ts))).toBe(raised[214]!.ts);
    const more = kept.filter((a) => a.kind === "machine");
    expect(more.map((a) => [a.title, a.body])).toEqual([["200 more from devbox", "200 more alerts from devbox raised while it was out of reach are not listed here. Its own inbox has them."]]);
    // A dozen are told on the channels, what needs the owner first; the rest stay in the inbox.
    await settle();
    expect(told.filter((k) => k !== "machine")).toHaveLength(alerts.FAR_TOLD_A_MINUTE);
    expect(told.filter((k) => k === "question").length).toBe(4);
    expect(told.filter((k) => k === "failed").length).toBe(8);
  } finally {
    alerts.registerChannel({ id: "command", label: "KEEL_NOTIFY_COMMAND", available: () => false, deliver: () => {} });
  }
});

// The reviewer's schedule: 600 forged questions in a few seconds.
test("a machine's alerts are listed and told within a bound a minute, and one alert says how many more came", async () => {
  scratch();
  const told: string[] = [];
  alerts.registerChannel({ id: "command", label: "test", available: () => true, deliver: (a) => void told.push(a.kind) });
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, ["command"]])) as any });
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    for (let i = 0; i < 600; i++) alerts.mirror("m1", far("question", `s${i}`, { data: { call_id: `c${i}`, open_session: `s${i}` } }));
    expect(alerts.list({ limit: 200 }).filter((a) => a.kind === "question")).toHaveLength(alerts.FAR_KEPT_A_MINUTE);
    await settle();
    expect(told).toHaveLength(alerts.FAR_TOLD_A_MINUTE);
    // The next minute: what was left out is said once, and that machine is listed again.
    t += 61_000;
    expect(alerts.mirror("m1", far("failed", "later"))).toBeDefined();
    expect(alerts.list({ limit: 200 }).filter((a) => a.kind === "machine").map((a) => a.title)).toEqual(["540 more from devbox"]);
    // Another machine has a minute of its own.
    expect(alerts.mirror("m2", far("failed", "s1"))).toBeDefined();
  } finally {
    Date.now = real;
    alerts.registerChannel({ id: "command", label: "KEEL_NOTIFY_COMMAND", available: () => false, deliver: () => {} });
  }
});

test("read here is told there, read there is read here, and neither echoes", async () => {
  const { link } = scratch();
  const a = far("finished", "s1"), b = far("failed", "s1"), c = far("finished", "s2");
  for (const x of [a, b, c]) alerts.mirror("m1", x);
  // The page reads the session it shows: what calls the owner (the failure) waits for them to act there.
  expect(alerts.markRead({ session_id: "m1--s1", auto: true })).toBe(1);
  expect(alerts.markRead({ session_id: "m1--s1", touch: true })).toBe(1);
  await settle();
  expect(link.read).toEqual([["m1", [a.id]], ["m1", [b.id]]]);
  expect(alerts.pendingReads("m1")).toEqual([]);
  // That daemon says the third was read on its own page.
  alerts.farWasRead("m1", { ids: [c.id] });
  await settle();
  expect(alerts.unreadCounts().total).toBe(0);
  expect(link.read).toHaveLength(2);
  // More ids than a statement takes are no error.
  alerts.farWasRead("m1", { ids: Array.from({ length: 2_000 }, (_, i) => `x${i}`) });
  // Marked unread there, to come back to: unread and kept here; marked unread here: told there.
  alerts.farWasUnread("m1", c.id);
  const mine = alerts.list().find((x) => x.data.far.alert === c.id)!;
  expect([mine.read, mine.kept]).toEqual([false, true]);
  expect(link.unread).toEqual([]);
  const other = alerts.list().find((x) => x.data.far.alert === a.id)!;
  alerts.markUnread(other.id);
  await settle();
  expect(link.unread).toEqual([["m1", a.id]]);
  // A session deleted there takes its alerts here; a machine taken out takes the rest and its cursor.
  alerts.farGone("m1", "s1");
  expect(alerts.list().map((x) => x.session_id)).toEqual(["m1--s2"]);
  alerts.farGone("m1");
  expect(alerts.list()).toHaveLength(0);
  expect(alerts.mirrorSince("m1", [far("finished", "s9")])).toBe(0); // a first link again
});

// The reviewer's schedule: an approval mirrored unread, the link silent, the approval answered
// on the peer, the link back. And the other way: read here while the link is down.
test("what was read on either side while the link was down is the same on both when it opens", async () => {
  const { link } = scratch();
  alerts.mirrorSince("m1", []);
  const ask = far("approval", "s1", { data: { approval_id: "ap1", open_session: "s1" } }), done = far("finished", "s2"), keep = far("failed", "s3");
  for (const x of [ask, done, keep]) alerts.mirror("m1", x);
  // The link goes down. The approval is answered there; the finish is read here; the failure is marked unread there.
  link.up = false;
  expect(alerts.markRead({ session_id: "m1--s2" })).toBe(1);
  expect(alerts.markRead({ session_id: "m1--s3" })).toBe(1);
  await settle();
  expect(link.read).toEqual([]);
  expect(alerts.pendingReads("m1").sort()).toEqual([done.id, keep.id].sort());
  // The link opens: its list says the approval is read and the failure kept unread; the finish is still unread there.
  link.up = true;
  alerts.mirrorSince("m1", [{ ...ask, read: true }, done, { ...keep, read: false, kept: true }]);
  alerts.tellPendingReads("m1");
  await settle();
  const by = (id: string) => alerts.list().find((x) => x.data.far.alert === id)!;
  expect(by(ask.id).read).toBe(true); // no "Approval ... Review" left for a request that was answered
  expect(by(done.id).read).toBe(true);
  // A read made here that was still to be told stands over that daemon's older word, and is told now.
  expect(by(keep.id).read).toBe(true);
  expect(link.read.flatMap(([, ids]) => ids).sort()).toEqual([done.id, keep.id].sort());
  expect(alerts.pendingReads("m1")).toEqual([]);
  // With nothing waiting to be told, its "kept unread" is followed.
  alerts.mirrorSince("m1", [{ ...ask, read: true }, { ...done, read: true }, { ...keep, read: false, kept: true }]);
  expect([by(keep.id).read, by(keep.id).kept]).toEqual([false, true]);
});

test("the inbox is in the order things reached this daemon, whatever the other daemon's clock says", () => {
  scratch();
  const real = Date.now;
  const now = real();
  Date.now = () => now;
  try {
    const mine = alerts.raise("agent", null, "Here first", "words")!;
    // Its clock is ten minutes behind.
    const theirs = alerts.mirror("m1", far("failed", "s1", { ts: now - 600_000 }))!;
    const ahead = alerts.mirror("m1", far("failed", "s2", { ts: now + 600_000 }))!;
    expect(alerts.list().map((a) => a.id)).toEqual([ahead.id, theirs.id, mine.id]);
    expect(theirs.ts).toBeGreaterThan(mine.ts);
    expect(theirs.data.far.ts).toBe(now - 600_000);
  } finally {
    Date.now = real;
  }
});

test("a machine out of reach is told once per absence, in its own kind and by its name now", () => {
  const { names } = scratch();
  expect(alerts.raisedOffline("m1", 5_000)).toBe(false);
  const a = alerts.raise("machine", null, "devbox is offline", "devbox does not answer since 14:02.", { machine_offline: "m1", since_ms: 5_000 })!;
  expect(a.machine).toEqual({ id: "m1", name: "devbox" });
  expect(alerts.raisedOffline("m1", 5_000)).toBe(true);
  expect(alerts.raisedOffline("m1", 9_000)).toBe(false); // another absence
  // A notice, not a failure of work: it stays in the inbox whatever the routes say.
  expect(a.channels).toEqual([]);
  names.m1 = "buildbox";
  expect(alerts.list()[0]!.title).toBe("buildbox is offline");
  alerts.readWhere("machine_offline", "m1");
  expect(alerts.list().map((x) => x.read)).toEqual([true]);
});

test("the connection log lists an absence once it ended, once however many pages lived it, a dozen an hour per source", () => {
  scratch();
  connection.reset();
  const now = Date.now();
  expect(connection.pageAbsence(now - 400, now, "silent")).toBe(false); // a blip
  expect(connection.pageAbsence(now - 25_000, now, "silent")).toBe(true);
  // A second tab behind the same link says the same absence a moment later: one row.
  expect(connection.pageAbsence(now - 24_800, now + 300, "silent")).toBe(false);
  expect(connection.machineAbsence({ id: "m1", name: "devbox" }, now - 190_000, now, "the stream went silent")).toBe(true);
  const rows = () => activity.list({ kinds: ["daemon"], limit: 100 }).items;
  expect(rows().map((r) => [r.sub, r.text.replace(/\d\d:\d\d:\d\d/, "T")]).sort()).toEqual([
    ["connection", "A page did not hear Keel for 25 s, from T: its connection went silent"],
    ["machine", "devbox was out of reach for 3 min 10 s, from T: the stream went silent"],
  ]);
  // Absences one after another are each listed, up to a dozen an hour.
  for (let i = 1; i <= 20; i++) connection.pageAbsence(now - i * 60_000 - 5_000, now - i * 60_000, "closed");
  expect(rows().filter((r) => r.sub === "connection")).toHaveLength(12);
  // Nonsense is not listed: a time that is no number, an end before its start, an end in the future.
  expect([connection.pageAbsence(NaN, now, "x"), connection.pageAbsence(now, now - 5_000, "x"), connection.machineAbsence({ id: "m2", name: "x" }, now, now + 3_600_000)]).toEqual([false, false, false]);
  expect(connection.span(59_400)).toBe("59 s");
  expect(connection.span(3_725_000)).toBe("1 h 2 min");
});
