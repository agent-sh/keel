// Following another machine: its alerts kept here across a link that drops,
// and one word to the owner per absence however often its stream flaps. The
// timings an e2e cannot set up (a stream cut again right after it opens, an
// alert raised there while the link was down).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Its own config folder and short waits, before any Keel source is loaded: nothing here reads or writes the owner's.
process.env.KEEL_CONFIG_DIR ??= join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-follow-test-")), "config");
process.env.KEEL_FLEET_OFFLINE_ALERT_MS = "80";
process.env.KEEL_FLEET_STEADY_MS = "150";
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const activity = await import("../automation/activity.ts");
const alerts = await import("../automation/alerts.ts");
const connection = await import("../automation/connection.ts");
const { setDeps } = await import("../automation/core.ts");
const snooze = await import("../automation/snooze.ts");
const { bindFollow } = await import("./follow.ts");
const { relayRetry, relaySilence, RELAY_PING_MS } = await import("./fleet.ts");

const scratch = (their: any[] = []) => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-follow-")));
  const bus = new Bus();
  // What is captured is kept, not thrown: the parts set here stay the process's own after this file, and a timer of another module may still report to them.
  const errors = { capture: () => {} } as any;
  setDeps({ store, bus, errors } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  connection.reset();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((k) => [k, []])) as any });
  const row: any = { id: "m1", name: "devbox", state: "ready", reason: null, offline_since: null, source: "daemon" };
  const asked: string[] = [];
  const f: any = {
    rows: () => [row], row: (id: string) => (id === row.id ? row : undefined), isSsh: () => false, remoteHas: () => true,
    handsJson: async (_id: string, path: string) => { asked.push(path); return path.includes("/alerts?") ? { alerts: their } : {}; },
  };
  const frames: any[] = [];
  bus.on((fr) => { if (fr.t === "feature") frames.push(fr); });
  const off = bindFollow(f, bus, errors);
  const reach = (state: "offline" | "back", since: number) => {
    Object.assign(row, state === "offline" ? { state: "offline", offline_since: since, reason: "the stream went silent" } : { state: "ready", offline_since: null, reason: null });
    f.onReach({ ...row, reason: "the stream went silent" }, { state, since });
  };
  const offline = () => alerts.list().filter((a) => a.data?.machine_offline === "m1");
  return { bus, f, frames, reach, offline, off, asked };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a machine out of reach is said once, also when its stream flaps, and the absence is kept when it is over", async () => {
  const { frames, reach, offline, off } = scratch();
  try {
    const since = Date.now() - 5_000;
    reach("offline", since);
    expect(offline()).toHaveLength(0); // already out long enough, but never in the same breath
    await wait(30);
    expect(offline().map((a) => [a.title, a.read, a.data.since_ms])).toEqual([["devbox is offline", false, since]]);
    expect(offline()[0]!.body).toMatch(/^Not heard from since \d\d:\d\d: the stream went silent\. Its sessions show as they were then\.$/);
    // Heard for a moment, lost again: the pages are told it is back at once, the alert stands, and no second one comes.
    reach("back", since);
    expect(frames.filter((fr) => fr.name === "fleet_back").map((fr) => [fr.data.machine, fr.data.name, fr.data.since])).toEqual([["m1", "devbox", since]]);
    await wait(40);
    reach("offline", Date.now());
    await wait(200);
    expect(offline().map((a) => a.read)).toEqual([false]);
    expect(activity.list({ kinds: ["daemon"] }).items).toHaveLength(0);
    // Back and steady: the alert is read and the whole absence is one row.
    reach("back", Date.now() - 200);
    await wait(60);
    expect(offline().map((a) => a.read)).toEqual([false]);
    await wait(150);
    expect(offline().map((a) => a.read)).toEqual([true]);
    expect(activity.list({ kinds: ["daemon"] }).items.map((a) => [a.sub, a.text.replace(/\d\d:\d\d:\d\d/, "T")])).toEqual([["machine", "devbox was out of reach for 5 s, from T: the stream went silent"]]);
    // A blip never reaches the owner.
    reach("offline", Date.now());
    await wait(30);
    reach("back", Date.now() - 30);
    await wait(220);
    expect(offline()).toHaveLength(1);
  } finally {
    off();
  }
});

test("an alert of that machine is kept when its frame comes, and what was raised while the link was down when it opens", async () => {
  let n = 0;
  const far = (kind: string, session: string, ts: number) => ({ id: `far-${++n}`, ts, kind, session_id: session, title: `${kind} of ${session}`, body: "words", read: false, rev: n, kept: false });
  const old = far("finished", "s0", 1_000), missed = far("failed", "s1", 2_000), live = far("question", "s2", 3_000);
  const their = [old];
  const { bus, off, asked } = scratch(their);
  const relayed = (frame: unknown) => bus.emit({ t: "feature", name: "fleet_frame", data: { machine: "m1", frame } });
  const kinds = () => alerts.list().map((a) => [a.kind, a.session_id]).sort();
  try {
    // The first link: its history stays its own.
    bus.emit({ t: "feature", name: "fleet_sessions", data: { machine: "m1" } });
    await wait(10);
    expect(asked).toEqual(["/api/fleet/linked/alerts?limit=200"]);
    expect(kinds()).toEqual([]);
    // The link drops; one is raised there; the link opens and a new one is told live before the list is read.
    their.push(missed, live);
    bus.emit({ t: "feature", name: "fleet_sessions", data: { machine: "m1" } });
    relayed({ t: "feature", name: "automation", data: { kind: "alert", data: live } });
    expect(kinds()).toEqual([["question", "m1--s2"]]);
    await wait(10);
    expect(kinds()).toEqual([["failed", "m1--s1"], ["question", "m1--s2"]]);
    // Told again, read there, and the session deleted there.
    relayed({ t: "feature", name: "automation", data: { kind: "alert", data: live } });
    relayed({ t: "feature", name: "automation", data: { kind: "alerts_read", data: { ids: [missed.id], changed: 1 } } });
    expect(alerts.list().map((a) => [a.session_id, a.read]).sort()).toEqual([["m1--s1", true], ["m1--s2", false]]);
    relayed({ t: "session", session: { id: "s2" }, deleted: true });
    expect(kinds()).toEqual([["failed", "m1--s1"]]);
  } finally {
    off();
  }
});

test("a stream is given up after two missed pings, and a machine is asked again sooner the shorter it has been out", () => {
  expect(relaySilence(RELAY_PING_MS)).toBe(6_000);
  expect(relaySilence(undefined)).toBe(45_000); // a daemon that does not say keeps the long bound
  expect(relaySilence(5)).toBe(45_000);
  expect([0, 30_000, 300_000, 3_600_000].map(relayRetry)).toEqual([1_000, 3_000, 30_000, 60_000]);
});
