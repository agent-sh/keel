import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { QUESTION_CUT } from "../core/stops.ts";
import { ask, answer } from "../tools/interact.ts";
import * as activity from "./activity.ts";
import * as alerts from "./alerts.ts";
import { clip, setDeps } from "./core.ts";
import * as failures from "./failures.ts";
import { IncidentBook } from "./incident-book.ts";
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

// A question put back after a restart is not raised again; the same call id in another session is another question.
test("an alert raised for a call is known by its session", () => {
  const { session } = scratch();
  const a = session("One"), b = session("Two"), p = session("Parent"), child = session("Agent", p);
  alerts.raise("question", a, "Question: One", "Which?", { call_id: "call-1-0", open_session: a });
  alerts.raise("question", child, "Question: Agent", "Which?", { call_id: "call-9", open_session: child });
  expect(alerts.raisedFor("call_id", "call-1-0", a)).toBe(true);
  expect(alerts.raisedFor("call_id", "call-1-0", b)).toBe(false);
  expect(alerts.raisedFor("call_id", "call-9", child)).toBe(true);
  expect(alerts.raisedFor("call_id", "call-9", p)).toBe(false);
  // The same id asked in the other session: its own row, and the first one's stays.
  alerts.raise("question", b, "Question: Two", "Which?", { call_id: "call-1-0", open_session: b });
  expect(alerts.list({ unread: true }).filter((x) => x.data.call_id === "call-1-0").map((x) => x.session_id).sort()).toEqual([a, b].sort());
  // Answered in one session: only that one's row is read.
  alerts.readWhere("call_id", "call-1-0", b);
  expect(alerts.list({ unread: true }).filter((x) => x.data.call_id === "call-1-0").map((x) => x.session_id)).toEqual([a]);
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

// What calls the owner is not read because its session is on screen, and its notification is held
// back only while they are at it: a page left open, focused, mutes nothing.
test("an ask or a failure in a watched session stays unread; its notification waits only while the owner attends it", async () => {
  const { session } = scratch();
  const a = session("A");
  const got: string[] = [];
  alerts.registerChannel({ id: "rec2", label: "rec2", available: () => true, deliver: (x) => void got.push(x.kind) });
  alerts.saveSettings({ routes: { failed: ["rec2"], question: ["rec2"], finished: ["rec2"] } as any, completion: "always" });
  // The page shows the session, has focus, and the owner did something in it two seconds ago.
  alerts.setPresence(a, true, "desk", [], 2000);
  const sig = new AbortController().signal;
  void ask({ sessionId: a, callId: "q1", signal: sig } as any);
  const asked = alerts.raise("question", a, "Question: A", "Which?", { call_id: "q1", open_session: a })!;
  const failed = alerts.raise("failed", a, "Failed: A", "HTTP 500")!;
  const done = alerts.raise("finished", a, "A", "done")!;
  await settle();
  // The finish is seen there: read, and nothing leaves the machine for it.
  expect([done.read, done.channels]).toEqual([true, []]);
  // The ask and the failure are unread, open, and held back while the owner is at the session.
  expect([asked.read, asked.open, asked.channels, asked.data.withheld]).toEqual([false, true, [], ["rec2"]]);
  expect([failed.read, failed.channels, failed.data.withheld]).toEqual([false, [], ["rec2"]]);
  expect(got).toEqual([]);
  alerts.tickWithheld(Date.now() + 10_000);
  await settle();
  expect(got).toEqual([]);
  // The page reading the session on screen leaves both; the owner acting in its pane reads them.
  expect(alerts.markRead({ session_id: a, auto: true })).toBe(0);
  // They stop attending (a minute with no input: the page still has focus): both go out, once.
  alerts.setPresence(a, true, "desk", [], 61_000);
  alerts.tickWithheld(Date.now() + 20_000);
  await settle();
  expect(got.sort()).toEqual(["failed", "question"]);
  alerts.tickWithheld(Date.now() + 30_000);
  await settle();
  expect(got).toHaveLength(2);
  expect(alerts.list({ unread: true }).every((x) => x.data?.withheld === undefined)).toBe(true);
  expect(alerts.markRead({ session_id: a, touch: true })).toBe(2);
  answer(a, "q1", {});
});

test("an ask the owner looked at is still open until it is answered; an answered one held back is never sent", async () => {
  const { session } = scratch();
  const a = session("A");
  const got: string[] = [];
  alerts.registerChannel({ id: "rec3", label: "rec3", available: () => true, deliver: (x) => void got.push(x.id) });
  alerts.saveSettings({ routes: { question: ["rec3"] } as any });
  alerts.setPresence(a, true, "desk", [], 1000);
  const sig = new AbortController().signal;
  void ask({ sessionId: a, callId: "q2", signal: sig } as any);
  const asked = alerts.raise("question", a, "Question: A", "Which?", { call_id: "q2", open_session: a })!;
  // Read (they opened the session), not answered: the lists still say it waits, however they are asked.
  alerts.markRead({ ids: [asked.id] });
  expect(alerts.list({}).find((x) => x.id === asked.id)).toMatchObject({ read: true, open: true });
  expect(alerts.list({ limit: 1, withUnread: true }).some((x) => x.id === asked.id && x.open)).toBe(true);
  // Answered: it waits no more, and what was held back for it never goes out.
  answer(a, "q2", {});
  alerts.readWhere("call_id", "q2", a);
  expect(alerts.list({}).find((x) => x.id === asked.id)?.open).toBeUndefined();
  alerts.setPresence(null, false, "desk");
  alerts.tickWithheld(Date.now() + 10_000);
  await settle();
  expect(got).toEqual([]);
});

test("a session marked unread gets its own newest word back, never an answered ask", () => {
  const { session } = scratch();
  const a = session("A");
  alerts.raise("finished", a, "A", "The parser moved.");
  alerts.raise("approval", a, "Approval: A", "Bash: ls", { approval_id: "ap-1", open_session: a });
  alerts.markRead({ all: true });
  expect(alerts.markSessionUnread(a)).toBe(true);
  expect(alerts.list({ unread: true }).map((x) => [x.kind, x.kept])).toEqual([["finished", true]]);
  // The page showing the session, and the owner acting in it, leave what they kept; going to it reads it.
  expect(alerts.markRead({ session_id: a, auto: true })).toBe(0);
  expect(alerts.markRead({ session_id: a, touch: true })).toBe(0);
  expect(alerts.markRead({ session_id: a })).toBe(1);
  // A session nothing was raised for gets a row of its own.
  const b = session("B");
  expect(alerts.markSessionUnread(b)).toBe(true);
  expect(alerts.unreadCounts().sessions[b]).toBe(1);
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

test("an approval the owner looked at, told of again while it waits, is one row", () => {
  const { session } = scratch();
  const s = session("Rotate the certificates");
  const told = () => alerts.raise("approval", s, "Approval: Rotate the certificates", "Bash: touch renewed.txt", { approval_id: "ap1", open_session: s, risk: "low" });
  told();
  told(); // not looked at yet: the newer one replaces it
  expect(alerts.list({ limit: 10 }).filter((a) => a.data?.approval_id === "ap1")).toHaveLength(1);
  alerts.markRead({ session_id: s });
  told();
  const rows = alerts.list({ limit: 10 }).filter((a) => a.data?.approval_id === "ap1");
  expect(rows.map((a) => a.read)).toEqual([true]);
  // Another approval of the same session is another decision.
  alerts.raise("approval", s, "Approval: Rotate the certificates", "Bash: touch other.txt", { approval_id: "ap2", open_session: s, risk: "low" });
  expect(alerts.unreadCounts().sessions[s]).toBe(1);
});

// A declined turn has an alert kind of its own, and every channel reads its title.
test("a turn the model declined is told as Declined, on every channel", () => {
  const { store, session } = scratch();
  const s = session("Draft the notice");
  store.append(s, "turn_start", { model: "m" });
  store.append(s, "assistant", { blocks: [{ type: "text", text: "I will not" }] });
  alerts.onTurnEnd(s, "refusal", { subagent: false, loopRun: false, more: false });
  const a = alerts.list({ limit: 1 })[0]!;
  expect([a.kind, a.title, a.body]).toEqual(["declined", "Declined: Draft the notice", "I will not"]);
});

// A question whose turn was stopped has no card left: nothing waits on the owner.
test("a question whose card went with a stopped turn is read; one that waits, an expired one and a kept one stay", () => {
  const { session } = scratch();
  const s = session("Pick a window"), t = session("Pick a color");
  const stop = new AbortController();
  void ask({ sessionId: s, callId: "q1", signal: stop.signal } as any).catch(() => {});
  void ask({ sessionId: t, callId: "q2", signal: new AbortController().signal } as any);
  alerts.raise("question", s, "Question: Pick a window", "Which window?", { call_id: "q1", open_session: s });
  alerts.raise("question", t, "Question: Pick a color", "Which color?", { call_id: "q2", open_session: t });
  alerts.raise("question", s, "Unanswered question: Pick a window", "Expired before you answered: Which day?", { call_id: "q0", open_session: s, expired: true });
  // While its card waits a turn's end reads nothing.
  alerts.settleAsks(s);
  expect(alerts.unreadCounts().sessions[s]).toBe(2);
  stop.abort();
  alerts.settleAsks(s);
  alerts.settleAsks(t);
  const of = (call: string) => alerts.list({ limit: 10 }).find((a) => a.data?.call_id === call)!;
  expect([of("q1").read, of("q2").read, of("q0").read]).toEqual([true, false, false]);
  // Marked unread by the owner, it is theirs to keep.
  alerts.markUnread(of("q1").id);
  alerts.settleAsks(s);
  expect(of("q1").read).toBe(false);
});

// A question a restart could not put back expired unanswered: the turn that
// went on without it is filed as a decision the owner owes, not as finished.
test("a turn whose question expired unanswered is filed as a question, not as finished", () => {
  const { store, session } = scratch();
  const s = session("Pick a color");
  store.append(s, "turn_start", { model: "m" });
  store.append(s, "assistant", { blocks: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which color?" }] } }] });
  store.append(s, "turn_end", { reason: "restart" });
  const turn = (after: () => void) => {
    store.append(s, "turn_start", { model: "m" });
    store.append(s, "tool_result", { results: [{ type: "tool_result", tool_use_id: "q1", is_error: true, content: QUESTION_CUT }] });
    after();
    store.append(s, "assistant", { blocks: [{ type: "text", text: "Went on with teal." }] });
    alerts.onTurnEnd(s, "end_turn", { subagent: false, loopRun: false, more: false });
    return alerts.list({ limit: 1 })[0]!;
  };
  const a = turn(() => {});
  expect([a.kind, a.title, a.body, a.read]).toEqual(["question", "Unanswered question: Pick a color", "Expired before you answered: Which color?", false]);
  expect(a.data).toMatchObject({ call_id: "q1", expired: true });
  // Asked again and answered in the same turn: nothing is owed, the turn finished.
  const b = turn(() => store.append(s, "tool_result", { results: [{ type: "tool_result", tool_use_id: "q2", content: "answered" }], shown: { q2: { answers: { "0": { picked: ["Teal"] } } } } }));
  expect([b.kind, b.body]).toEqual(["finished", "Went on with teal."]);
});

test("the desktop gets what needs the owner; a routine finish stays in the inbox, one row per session", async () => {
  const { session } = scratch();
  const s = session("S");
  const kid = session("Agent", s);
  const sent: string[] = [];
  alerts.registerChannel({ id: "desktop", label: "Desktop", available: () => true, deliver: (a) => void sent.push(`${a.kind}:${a.title}`) });
  for (const k of alerts.KINDS) alerts.saveSettings({ route: { kind: k, channel: "desktop", on: true } });
  alerts.raise("finished", s, "short", "done", { ran_ms: 20_000 });
  const short = alerts.raise("finished", s, "short again", "done", { ran_ms: 30_000 });
  expect(short?.data?.inbox_only).toEqual({ routine: true });
  expect(alerts.list({ unread: true }).filter((a) => a.kind === "finished")).toHaveLength(1); // the repeat replaced it
  alerts.raise("finished", s, "long", "done", { ran_ms: alerts.LONG_TURN_MS });
  alerts.raise("approval", kid, "approve", "a write", { approval_id: "ap1" });
  alerts.raise("failed", s, "failed", "stopped");
  alerts.raise("snooze_over", s, "snooze over", "back");
  await settle();
  expect(sent).toEqual(["finished:long", "approval:approve", "failed:failed"]);
  alerts.saveSettings({ completion: "always" });
  alerts.raise("finished", s, "asked for", "done", { ran_ms: 1000 });
  await settle();
  expect(sent.at(-1)).toBe("finished:asked for");
});

// The desktop channel hands gdbus its strings as GVariant text. A body that
// carries JSON (a backslash before a quote) was refused when passed bare, and
// a title starting with dashes was read as an option.
test("a notification's title and body reach gdbus as quoted GVariant strings", () => {
  const json = String.raw`send: {"text":"line\n\nHis words: \"yes\""}`;
  expect(alerts.gvariantString(json)).toBe(String.raw`'send: {"text":"line\\n\\nHis words: \\"yes\\""}'`);
  expect(alerts.gvariantString("it's\ntwo lines\0")).toBe(String.raw`'it\'s\ntwo lines'`);
});
// The real parser: skipped by name on a machine without the two programs (a server has neither).
test.skipIf(!Bun.which("gdbus") || !Bun.which("dbus-run-session"))("gdbus takes the quoted strings as they are, and refuses the bare ones (needs gdbus and dbus-run-session)", () => {
  const json = String.raw`send: {"text":"line\n\nHis words: \"yes\""}`;
  // On a method that takes one string and shows nothing, over a bus of the
  // test's own: the caller may have no session bus, or one that is not reachable.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) delete env[key];
  const parses = (arg: string) =>
    Bun.spawnSync(["dbus-run-session", "--", "gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", arg], { env, timeout: 5000 }).exitCode === 0;
  expect(parses(json)).toBe(false);
  for (const s of [json, "--help", "C:\\", "it's", "'quoted'", "true", "a\nb\tc", "@s x", "<b>&"]) expect(parses(alerts.gvariantString(s))).toBe(true);
});

const privateDesktop = test.skipIf(!Bun.which("dbus-run-session") || !Bun.which("gjs") || !Bun.which("gdbus"));
for (const [mode, reason] of [
  ["actions", "clicking the replacement GNOME notification opens its current Keel deep link"],
  ["no-actions", "a notification server without actions still shows passive alerts"],
  ["broken-gjs", "a GJS helper that cannot start does not block passive alerts"],
  ["notify-error", "a Notify error does not trigger a second delivery"],
] as const) {
  privateDesktop(reason, () => {
    const env: NodeJS.ProcessEnv = { ...process.env, KEEL_PRIVATE_DESKTOP_FIXTURE: "1", KEEL_DESKTOP_NOTIFY: "on" };
    for (const key of ["DBUS_SESSION_BUS_ADDRESS", "DBUS_SYSTEM_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) delete env[key];
    env.KEEL_FIXTURE_SERVICE_GJS = Bun.which("gjs")!;
    const bin = mode === "broken-gjs" ? mkdtempSync(join(tmpdir(), "keel-broken-gjs-")) : null;
    try {
      if (bin) {
        writeFileSync(join(bin, "gjs"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        env.PATH = `${bin}:${env.PATH}`;
      }
      const run = Bun.spawnSync(["dbus-run-session", "--", process.execPath, join(import.meta.dir, "../../test/fixtures/desktop-alert.ts"), mode], { env, timeout: 10_000 });
      if (run.exitCode !== 0) throw new Error(run.stderr.toString() || `notification fixture exited ${run.exitCode}`);
    } finally {
      if (bin) rmSync(bin, { recursive: true, force: true });
    }
  }, 12_000);
}

// What became of a question is kept with its alert: the Inbox says it after a restart, when this
// daemon no longer remembers the answer.
test("a question's outcome is stored with its alert as it closes", async () => {
  const { session } = scratch();
  const a = session("Answers"), b = session("Stopped");
  const stop = new AbortController();
  void ask({ sessionId: a, callId: "qo-a", signal: new AbortController().signal } as any);
  void ask({ sessionId: b, callId: "qo-b", signal: stop.signal } as any);
  alerts.raise("question", a, "Question: Answers", "Which?", { call_id: "qo-a", open_session: a });
  alerts.raise("question", b, "Question: Stopped", "Which?", { call_id: "qo-b", open_session: b });
  answer(a, "qo-a", {});
  stop.abort();
  alerts.keepOutcome("call_id", "qo-a", a, "answered");
  alerts.keepOutcome("call_id", "qo-b", b, "not answered");
  const kept = (id: string) => alerts.list().find((x) => x.data?.call_id === id);
  expect([kept("qo-a")?.data.outcome, kept("qo-b")?.data.outcome]).toEqual(["answered", "not answered"]);
  expect([kept("qo-a")?.outcome, kept("qo-b")?.outcome]).toEqual(["answered", "not answered"]);
});

test("an open incident takes a touched session's failure alert only when the failure is of its cause and class", () => {
  const { session } = scratch();
  const p = session("Coordinator"), a = session("Lane", p), b = session("Other lane", p);
  const book = new IncidentBook(() => "inc");
  const at = Date.now();
  for (const id of [a, b]) book.hit({ key: "account:p", cause: "account", label: "P", cls: "auth", at, message: "HTTP 401: bad key", session: { id, title: id, parent: p }, failed: true });
  alerts.absorbHook.of = (sid, cls) => book.absorbs(sid, cls, Date.now())?.id;
  try {
    const of = (x: ReturnType<typeof alerts.raise>) => (x?.data as { in_incident?: string } | undefined)?.in_incident;
    // The incident's own failure: filed silently, the incident's alert stands for it.
    expect(of(alerts.raise("failed", a, "Failed: Lane", "HTTP 401: bad key", { cls: "auth" }))).toBe("inc");
    // The same session failing of another class, a reply cut at its limit, a loop: told on their own.
    expect(of(alerts.raise("failed", a, "Failed: Lane", "prompt is too long", { cls: "context_overflow" }))).toBeUndefined();
    expect(of(alerts.raise("failed", a, "Cut off: Lane", "The reply reached the model's output limit."))).toBeUndefined();
    expect(of(alerts.raise("loop_failed", a, "Loop failed: x", "HTTP 401", { cls: "auth" }))).toBeUndefined();
    // A provider's class in a session the account incident touched is another cause.
    expect(of(alerts.raise("limit", a, "Rate limited: Lane", "HTTP 429", { cls: "rate_limit" }))).toBeUndefined();
    // An agent's failure on its parent: the agent's own session decides, never "any agent of the parent".
    expect(of(alerts.raise("failed", p, "Coordinator: 1 agent failed: auth", "401", { cls: "auth", agent_session: b }))).toBe("inc");
    const c = session("Untouched", p);
    expect(of(alerts.raise("failed", p, "Coordinator: 1 agent failed: auth", "401", { cls: "auth", agent_session: c }))).toBeUndefined();
  } finally {
    alerts.absorbHook.of = undefined;
  }
});

// One approval answered while another of its session waits: what shows for that approval alone is taken back.
test("an answered approval is taken back alone while its session has another; the last one takes back the session", async () => {
  const { session } = scratch();
  const s = session("Two approvals");
  const taken: string[] = [];
  const withdrawn: string[] = [];
  alerts.registerChannel({ id: "take-back", label: "take back", available: () => true, deliver: () => {}, withdraw: (id) => void withdrawn.push(id), take: (a) => void taken.push(String(a.data?.approval_id)) });
  alerts.raise("approval", s, "Approval: Two approvals", "Bash: touch a", { approval_id: "apA", open_session: s, risk: "low" });
  alerts.raise("approval", s, "Approval: Two approvals", "Bash: touch b", { approval_id: "apB", open_session: s, risk: "low" });
  alerts.readWhere("approval_id", "apA");
  await settle();
  expect(taken).toEqual(["apA"]);
  expect(withdrawn).toEqual([]);
  alerts.readWhere("approval_id", "apB");
  await settle();
  expect(taken).toEqual(["apA"]);
  expect(withdrawn).toEqual([s]);
});

// The cost a card's wait began with is read by the card's own key, on its index: a read of what
// waits costs what waits, not a walk over a month of alerts.
test("a card's wait is read by its key on its index, however old and among however many", () => {
  const { store, session } = scratch();
  const a = session("Asks");
  const old = Date.now() - 40 * 86_400_000;
  const ins = store.db.query("INSERT INTO alerts (id, ts, kind, session_id, title, body, read, data, rev, kept) VALUES (?, ?, ?, ?, 'x', 'x', 1, ?, 0, 0)");
  store.db.transaction(() => {
    for (let i = 0; i < 2_000; i++) ins.run(`n${i}`, Date.now() - i, i % 2 ? "approval" : "question", a, JSON.stringify(i % 2 ? { approval_id: `ap${i}` } : { call_id: `c${i}`, open_session: a }));
  })();
  const wait = { at: old, agents: 2, rate: 0.1, key: 0.1 };
  ins.run("old-ap", old, "approval", a, JSON.stringify({ approval_id: "ap-old", open_session: a, wait }));
  ins.run("old-q", old, "question", a, JSON.stringify({ call_id: "c-old", open_session: a, wait: { ...wait, key: 0.2 } }));
  ins.run("old-plan", old, "question", a, JSON.stringify({ plan_id: "p-old", open_session: a }));
  expect(alerts.waitOf({ approval: "ap-old" })).toEqual({ ts: old, wait });
  expect(alerts.waitOf({ call: "c-old", session: a })?.wait?.key).toBe(0.2);
  expect(alerts.waitOf({ call: "c-old", session: "elsewhere" })).toBeUndefined();
  expect(alerts.waitOf({ plan: "p-old", session: a })).toEqual({ ts: old });
  const plan = (sql: string) => store.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join("; ");
  expect(plan(alerts.WAIT_OF_SQL.approval)).toContain("alerts_approval_id");
  expect(plan(alerts.WAIT_OF_SQL.call)).toContain("alerts_call_id");
  expect(plan(alerts.WAIT_OF_SQL.plan)).toContain("alerts_plan_id");
});

// The order's key is the one a wait began with; the line it says is what it costs as it is read:
// the agents that wait now, the cache's life now (a warm ping lengthened it).
test("a wait's line says what it costs as the list is read; its key stays the one it began with", () => {
  const { store, session } = scratch();
  const p = session("Lead"), a = session("Asker", p), f = session("Broke"), fine = session("Fine");
  const began = { at: Date.now(), agents: 3, rate: 0.12, tokens: 180_000, usd: 0.9, until: Date.now() + 60_000, key: 0.57 };
  const now = { agents: 1, rate: 0.04, tokens: 180_000, usd: 0.9, until: Date.now() + 50 * 60_000 };
  const was = { ...alerts.waitHook };
  try {
    alerts.waitHook.of = () => began;
    alerts.waitHook.now = () => now;
    const sig = new AbortController().signal;
    void ask({ sessionId: a, callId: "qa", signal: sig } as any);
    alerts.raise("question", a, "Question: Asker", "Which?", { call_id: "qa", open_session: a });
    alerts.raise("failed", f, "Failed: Broke", "HTTP 500", {});
    alerts.raise("failed", fine, "Failed: Fine", "HTTP 500", {});
    store.updateSession(f, { settings: { failed_ms: Date.now() } } as any);
    const listed = alerts.list({ withUnread: true });
    const q = listed.find((x) => x.kind === "question")!;
    expect(q.data.wait.key).toBe(0.57);
    expect(q.wait_now).toEqual(now);
    expect(listed.find((x) => x.session_id === f)!.wait_now).toEqual(now);
    // A failure the session has gone on from waits on nobody.
    expect(listed.find((x) => x.session_id === fine)!.wait_now).toBeUndefined();
    expect(alerts.waitsNow([q.id, listed.find((x) => x.session_id === fine)!.id])).toEqual({ [q.id]: now });
    expect(alerts.liveWait(q)).toEqual(now);
    answer(a, "qa", {});
  } finally {
    alerts.waitHook.of = was.of;
    alerts.waitHook.now = was.now;
  }
});

test("a failure with no session to open leads to the Errors panel; anything else with none to the inbox", () => {
  const { session } = scratch();
  const s = session("Build");
  const outage = alerts.raise("outage", null, "Provider outage: 3 sessions", "HTTP 529")!;
  expect([alerts.alertPath(outage.id), alerts.opensErrors(outage)]).toEqual(["/?errors=1", true]);
  const failed = alerts.raise("failed", s, "Failed: Build", "HTTP 500")!;
  expect([alerts.alertPath(failed.id), alerts.opensErrors(failed)]).toEqual([`/s/${s}`, false]);
  // A loop's failure names no session: the Errors panel.
  const loop = alerts.raise("loop_failed", null, "Loop failed: nightly", "exit 1")!;
  expect([alerts.alertPath(loop.id), alerts.opensErrors(loop)]).toEqual(["/?errors=1", true]);
  const back = alerts.raise("snooze_over", null, "Alerts are back", "")!;
  expect([alerts.alertPath(back.id), alerts.opensErrors(back)]).toEqual(["/?inbox=1", false]);
});

// One cause, told once: a growing count replaces the notification on the desktop where it stands, with no sound.
test("a failure cause pushes once: a growing count replaces its notification in place, quietly, read or not; an hour with no failure starts a new episode", async () => {
  const { session, store } = scratch();
  failures.migrate();
  const parent = session("Coordinator");
  const sent: { title: string; sound: boolean; key: string }[] = [];
  alerts.registerChannel({
    id: "desktop", label: "Desktop", available: () => true,
    deliver: (a) => void sent.push({ title: a.title, sound: alerts.settings().sound && !a.data?.in_place, key: a.session_id ?? "_" }),
  });
  alerts.saveSettings({ route: { kind: "failed", channel: "desktop", on: true } });
  const fail = async (n: number) => {
    const kid = session(`Agent ${n}`, parent);
    failures.record(parent, { kind: "agent", cls: "quota", message: "Your account has no available credit", ref: { id: kid, label: `Agent ${n}` } });
    alerts.agentsFailed({ id: kid, parent_id: parent });
    await settle();
  };
  await fail(1);
  await fail(2);
  expect(sent.map((s) => [s.title.replace(/^\S+ /, ""), s.sound])).toEqual([["1 agent failed: billing", true], ["2 agents failed: billing", false]]);
  expect(new Set(sent.map((s) => s.key)).size).toBe(1);
  expect(alerts.list({ unread: true }).filter((a) => a.kind === "failed")).toHaveLength(1);
  // The owner reads it: the episode goes on, a later count replaces the notification in place, no sound.
  alerts.markRead({ session_id: parent });
  await fail(3);
  expect(sent.map((s) => s.sound)).toEqual([true, false, false]);
  expect(new Set(sent.map((s) => s.key)).size).toBe(1);
  const rows = alerts.list().filter((a) => a.kind === "failed");
  expect(rows.map((a) => a.read)).toEqual([false, true]);
  expect(rows[0]!.title).toContain("3 agents failed");
  // An hour with no failure of the cause ends the episode: the next failure is a new one and pushes with its sound.
  store.db.query("UPDATE alerts SET ts = ts - ?").run(alerts.EPISODE_GAP_MS + 60_000);
  await fail(4);
  expect(sent.map((s) => s.sound)).toEqual([true, false, false, true]);
  expect(sent[3]!.title).toContain("4 agents failed");
});

test("a change of tools reported by two entries of one server is one alert naming both", () => {
  scratch();
  const change = { mcp_server: "computer-use-linux", mcp_servers: ["computer-use-linux", "linux-computer-use"], mcp_change: "abc123" };
  const first = alerts.raise("mcp", null, "computer-use-linux and linux-computer-use changed their tools", "one server configured twice", change);
  const second = alerts.raise("mcp", null, "linux-computer-use changed their tools", "one server configured twice", { ...change, mcp_server: "linux-computer-use" });
  expect(first).toBeDefined();
  expect(second).toBeUndefined();
  expect(alerts.list().filter((a) => a.kind === "mcp")).toHaveLength(1);
  // Another change of the same server is another alert.
  expect(alerts.raise("mcp", null, "changed", "again", { ...change, mcp_change: "def456" })).toBeDefined();
});

test("the helper's reply to a digest is never a push: its own notify is the decision", async () => {
  const { session, store } = scratch();
  const s = session("Helper");
  const sent: string[] = [];
  alerts.registerChannel({ id: "desktop", label: "Desktop", available: () => true, deliver: (a) => void sent.push(`${a.kind}:${a.title}`) });
  for (const k of alerts.KINDS) alerts.saveSettings({ route: { kind: k, channel: "desktop", on: true } });
  const turn = (kind: string | undefined, ms: number) => {
    store.append(s, "turn_start", { model: "m" });
    store.append(s, "user", { text: "[helper digest] ...", ...(kind ? { kind } : {}) });
    store.append(s, "assistant", { blocks: [{ type: "text", text: "No notification: the Wi-Fi dropped." }] });
    store.append(s, "turn_end", { ms });
    alerts.onTurnEnd(s, "end_turn", { subagent: false, loopRun: false, more: false });
  };
  turn("helper_digest", alerts.LONG_TURN_MS + 1000);
  await settle();
  expect(sent).toEqual([]);
  expect(alerts.list({ limit: 1 })[0]!.data.inbox_only).toEqual({ routine: true });
  // The owner's own long chat with it is still a finish worth a notice.
  turn(undefined, alerts.LONG_TURN_MS + 1000);
  await settle();
  expect(sent).toHaveLength(1);
});

// A caller that is not shown a session another harness runs (automation/index.ts unseen) marks none of its
// alerts read: neither by their ids nor in a mark of all, and the count it is told leaves them out.
test("a mark of read leaves the sessions it is told to leave, by ids and in a mark of all", () => {
  const { session } = scratch();
  const a = session("Here"), b = session("Elsewhere");
  alerts.raise("question", a, "Question: Here", "Which?", { call_id: "ra" });
  alerts.raise("question", b, "Question: Elsewhere", "Which?", { call_id: "rb" });
  const of = (s: string) => alerts.list({ unread: true }).filter((x) => x.session_id === s).map((x) => x.id);
  const bIds = of(b);
  expect(bIds.length).toBe(1);
  expect(alerts.markRead({ ids: bIds, except: [b] })).toBe(0);
  expect(alerts.markRead({ all: true, except: [b] })).toBe(1);
  expect(of(a)).toEqual([]);
  expect(of(b)).toEqual(bIds);
  expect(alerts.markRead({ all: true })).toBe(1);
});
