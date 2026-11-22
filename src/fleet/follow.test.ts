// Following another machine: its alerts kept here across a link that drops,
// and one word to the owner per absence however often its link comes and
// goes. The timings an e2e cannot set up (a link that flaps every few
// seconds, an alert raised there while the link was down, a daemon that says
// less than a session needs).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own config folder, before any Keel source is loaded: nothing here reads or writes the owner's.
process.env.KEEL_CONFIG_DIR ??= join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-follow-test-")), "config");
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const activity = await import("../automation/activity.ts");
const alerts = await import("../automation/alerts.ts");
const connection = await import("../automation/connection.ts");
const { setDeps } = await import("../automation/core.ts");
const snooze = await import("../automation/snooze.ts");
const { bindFollow } = await import("./follow.ts");
const { Fleet, relayRetry, relaySilence, relayWait, RELAY_PING_MS, soundSession } = await import("./fleet.ts");
const { plainReason, whyUnreached } = await import("./link.ts");

// The waits are read when they are used, so they are set here, after every module is loaded
// (whichever test file loaded them first), and put back when this file is done.
const kept = { alert: process.env.KEEL_FLEET_OFFLINE_ALERT_MS, steady: process.env.KEEL_FLEET_STEADY_MS };
process.env.KEEL_FLEET_OFFLINE_ALERT_MS = "80";
process.env.KEEL_FLEET_STEADY_MS = "150";
afterAll(() => {
  for (const [k, v] of [["KEEL_FLEET_OFFLINE_ALERT_MS", kept.alert], ["KEEL_FLEET_STEADY_MS", kept.steady]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const scratch = (their: any[] = []) => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-follow-")));
  const bus = new Bus();
  // What is captured is kept, not thrown: the parts set here stay the process's own after this file, and a timer of another module may still report to them.
  const caught: unknown[] = [];
  const errors = { capture: (_s: string, e: unknown) => void caught.push(e) } as any;
  setDeps({ store, bus, errors } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  connection.reset();
  alerts.resetMinutes();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  // The real fleet over a machine nothing is sent to: its link is the test's.
  const f = new Fleet(store, bus, errors);
  const m = f.add({ name: "devbox", source: "daemon", daemon_url: "http://127.0.0.1:9" });
  const link = { up: true, asked: [] as string[] };
  (f as any).handsJson = async (_id: string, path: string) => {
    if (!link.up) throw new (await import("./link.ts")).LinkError("down");
    link.asked.push(path);
    return path.includes("/alerts?") ? { alerts: their } : {};
  };
  const frames: any[] = [];
  bus.on((fr) => { if (fr.t === "feature") frames.push(fr); });
  const off = bindFollow(f, bus, errors);
  // What the relay and the checks do to the machine's row.
  // `since`: when its stream last said anything (a stream that went silent was last heard then).
  const to = (state: "offline" | "ready", reason?: string, since?: number) => (f as any).set(m.id, { state, reason: reason ?? null, ...(since ? { offline_since: since } : {}) });
  const offline = () => alerts.list().filter((a) => a.data?.machine_offline === m.id);
  return { bus, f, m, frames, to, offline, link, caught, stop: () => { off(); f.stop(); } };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The reviewer's schedule: a machine that is out ten seconds of every twenty (here, tens of milliseconds).
test("a machine that comes and goes is out of reach once: one alert, one row, and it is back only when it has stayed", async () => {
  const { f, m, to, offline, stop } = scratch();
  try {
    const since = Date.now() - 5_000;
    to("offline", "cannot reach http://127.0.0.1:9: nothing answers there", since);
    expect(f.row(m.id)!.offline_since).toBe(since);
    for (let i = 0; i < 6; i++) {
      await wait(40);
      to("ready");
      // Heard again, not yet for long: still out of reach to every page (its absence stands).
      expect(f.view(f.row(m.id)!).offline_since_ms).toBe(since);
      await wait(40);
      to("offline", "the stream went silent");
      expect(f.row(m.id)!.offline_since).toBe(since);
    }
    // Said once, in the machine's own kind, in words without the link's address or the runtime's.
    expect(offline().map((a) => [a.kind, a.title, a.read, a.data.since_ms])).toEqual([["machine", "devbox is offline", false, since]]);
    expect(offline()[0]!.body).toMatch(/^devbox does not answer since \d\d:\d\d\. Its sessions show as they were then\.$/);
    expect(activity.list({ kinds: ["daemon"] }).items).toHaveLength(0);
    // Back, and it stays: the absence is over, the alert is read, and the whole of it is one row.
    to("ready");
    await wait(60);
    expect([f.row(m.id)!.offline_since, offline().map((a) => a.read)]).toEqual([since, [false]]);
    await wait(150);
    expect(f.row(m.id)!.offline_since).toBeNull();
    expect(offline().map((a) => a.read)).toEqual([true]);
    const rows = activity.list({ kinds: ["daemon"] }).items;
    expect(rows.map((a) => a.sub)).toEqual(["machine"]);
    expect(rows[0]!.text).toMatch(/^devbox was out of reach for [56] s, from \d\d:\d\d:\d\d: the stream went silent$/);
    // A blip never reaches the owner.
    to("offline", "the stream went silent");
    await wait(30);
    to("ready");
    await wait(250);
    expect(offline()).toHaveLength(1);
  } finally {
    stop();
  }
});

test("an alert of that machine is kept when its frame comes, and what was raised or read while the link was down when it opens", async () => {
  let n = 0;
  const far = (kind: string, session: string, ts: number) => ({ id: `far-${++n}`, ts, kind, session_id: session, title: `${kind} of ${session}`, body: "words", read: false, rev: n, kept: false });
  const old = far("finished", "s0", 1_000), missed = far("failed", "s1", 2_000), live = far("question", "s2", 3_000);
  const their: any[] = [old];
  const { bus, m, link, stop } = scratch(their);
  const relayed = (frame: unknown) => bus.emit({ t: "feature", name: "fleet_frame", data: { machine: m.id, frame } });
  const opened = () => bus.emit({ t: "feature", name: "fleet_sessions", data: { machine: m.id } });
  const kinds = () => alerts.list().map((a) => [a.kind, a.session_id]).sort();
  const here = (id: string) => `${m.id}--${id}`;
  try {
    // The first link: its history stays its own. The list asked for is the recent ones and every unread one.
    opened();
    await wait(10);
    expect(link.asked).toEqual(["/api/fleet/linked/alerts?limit=200&with_unread"]);
    expect(kinds()).toEqual([]);
    // The link drops; one is raised there; the link opens and a new one is told live before the list is read.
    their.push(missed, live);
    opened();
    relayed({ t: "feature", name: "automation", data: { kind: "alert", data: live } });
    expect(kinds()).toEqual([["question", here("s2")]]);
    await wait(10);
    expect(kinds()).toEqual([["failed", here("s1")], ["question", here("s2")]]);
    // Told again, read there, marked unread there, and the session deleted there.
    relayed({ t: "feature", name: "automation", data: { kind: "alert", data: live } });
    relayed({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { ids: [missed.id], changed: 1 } } });
    expect(alerts.list().map((a) => [a.session_id, a.read]).sort()).toEqual([[here("s1"), true], [here("s2"), false]]);
    relayed({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { unread: missed.id } } });
    expect(alerts.list().map((a) => [a.session_id, a.read, a.kept]).sort()).toEqual([[here("s1"), false, true], [here("s2"), false, false]]);
    // Read here while the link is down: kept to be told, and told when the link opens.
    link.up = false;
    alerts.markRead({ session_id: here("s2") });
    await wait(10);
    expect(alerts.pendingReads(m.id)).toEqual([live.id]);
    link.up = true;
    opened();
    await wait(10);
    expect(link.asked.at(-1)).toBe("/api/fleet/linked/alerts/read");
    expect(alerts.pendingReads(m.id)).toEqual([]);
    relayed({ t: "session", session: { id: "s2" }, deleted: true });
    expect(kinds()).toEqual([["failed", here("s1")]]);
  } finally {
    stop();
  }
});

test("a stream is given up after two missed pings, and a machine is asked again sooner the shorter it has been out", () => {
  expect(relaySilence(RELAY_PING_MS)).toBe(6_000);
  expect(relaySilence(undefined)).toBe(45_000); // a daemon that does not say keeps the long bound
  expect(relaySilence(5)).toBe(45_000);
  expect([0, 30_000, 300_000, 3_600_000].map(relayRetry)).toEqual([1_000, 3_000, 30_000, 60_000]);
  // A link that died: each try into it takes five seconds to give up, and the next is made at
  // once after it, not a wait later. So the machine is heard within about five seconds of its link.
  expect(relayWait({ cut: false, times: 0, outMs: 12_000, triedMs: 5_000 })).toBe(250);
  expect(relayWait({ cut: false, times: 4, outMs: 26_000, triedMs: 5_000 })).toBe(250); // whatever came before
  // A try that is refused at once waits the tenth; a machine out for an hour is asked once a minute.
  expect(relayWait({ cut: false, times: 0, outMs: 30_000, triedMs: 3 })).toBe(2_997);
  expect(relayWait({ cut: false, times: 0, outMs: 3_600_000, triedMs: 5_000 })).toBe(55_000);
  // A stream its own daemon ends as it opens backs off twice as long each time.
  expect([0, 1, 2, 3, 9].map((times) => relayWait({ cut: true, times, outMs: 0, triedMs: 0 }))).toEqual([1_000, 2_000, 4_000, 8_000, 60_000]);
});

test("a link's failure is said in a person's words, and a session that is not whole is no session", () => {
  expect(whyUnreached(Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe("nothing answers there");
  expect(whyUnreached(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"))).toBe("the connection was cut");
  expect(whyUnreached(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }), 5_000)).toBe("no answer within 5 s");
  expect(whyUnreached(new Error("certificate has expired. For more information, pass `verbose: true` in the second argument to fetch()"))).toBe("certificate has expired.");
  expect(plainReason("cannot reach http://127.0.0.1:41299: nothing answers there")).toBe("nothing answers there");
  expect(plainReason("the stream went silent")).toBe("the stream went silent");
  const whole = { id: "s1", title: "", model: "m", workspace: "/w", created: 1, updated: 2, phase: "idle", archived: false, usage: {}, head: null, settings: {} };
  expect([soundSession(whole), soundSession({ id: "s1" }), soundSession({ ...whole, id: "../x" }), soundSession(null), soundSession({ ...whole, settings: null })]).toEqual([true, false, false, false, false]);
});
