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
  if (!Bun.which("gdbus") || !process.env.DBUS_SESSION_BUS_ADDRESS) return;
  // The real parser, on a method that takes one string and shows nothing.
  const parses = (arg: string) =>
    Bun.spawnSync(["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", arg], { timeout: 5000 }).exitCode === 0;
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
