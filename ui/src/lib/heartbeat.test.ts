import { expect, test } from "bun:test";
import { ASKS, BEAT_MS, GRACE_MS, idleCost, look, PROBE_MS, retryGap, rttOf, SLOW_BEAT_MS, socketBound, step, tripped, type Beat, type Trips, type Way } from "./heartbeat.ts";

// A socket on a fake clock. `answer(askedAt)`: when the daemon's answer to an ask
// sent then reaches the page (null: never). `frames`: other frames, by arrival time.
// The round trip is measured as the store does: each answer against its ask.
function run(o: { until: number; every?: number; answer?: (at: number) => number | null; frames?: number[]; late?: Record<number, number>; trips?: Trips }) {
  const every = o.every ?? BEAT_MS;
  let b: Beat = { heard: 0, pings: 0, due: every };
  let trips: Trips = o.trips ?? [];
  const pings: number[] = [], slow: number[] = [];
  let lost: number | null = null;
  // What is on its way to the page: [arrival, the ask it answers (or null for a frame)].
  const coming: [number, number | null][] = (o.frames ?? []).map((t) => [t, null]);
  while (b.due <= o.until && lost === null) {
    const now = b.due + (o.late?.[b.due] ?? 0);
    coming.sort((x, y) => x[0] - y[0]);
    while (coming.length && coming[0]![0] <= now) {
      const [at, asked] = coming.shift()!;
      b = { ...b, heard: at, pings: 0 };
      if (asked !== null) trips = tripped(trips, at - asked);
    }
    const l = look(b, now, every, GRACE_MS, rttOf(trips));
    if (l.ping) {
      pings.push(now);
      const back = o.answer?.(now) ?? null;
      if (back !== null) coming.push([back, now]);
    }
    if (l.slow && !l.lost) slow.push(now);
    if (l.lost) lost = now;
    b = { heard: b.heard, pings: l.pings, due: l.due };
  }
  return { pings, slow, lost, rtt: rttOf(trips) };
}

test("a silent socket is slow to answer after two asks and lost after three and a grace", () => {
  const r = run({ until: 60_000 });
  expect(r.pings).toEqual([BEAT_MS, 2 * BEAT_MS, 3 * BEAT_MS]);
  expect(r.slow[0]).toBe(2 * BEAT_MS);
  expect(r.lost).toBe(ASKS * BEAT_MS + GRACE_MS);
  expect(r.lost).toBe(7_000);
});

// The reviewer's schedule: the daemon answers nothing for a while at a random moment (a stopped
// process, a long collection), then answers everything. No band for a silence under seven seconds.
test("a daemon that answers nothing for four or six seconds is never lost, at any moment of the beat", () => {
  for (const stop of [3_200, 4_000, 6_000, 6_900]) {
    for (let from = 10_000; from < 12_000; from += 100) {
      // An ask that reaches the daemon inside the stop is answered when it ends.
      const answer = (at: number) => (at >= from && at < from + stop ? from + stop + 20 : at + 20);
      // The last frame before the stop came just before it.
      const r = run({ until: 40_000, answer, frames: [from - 1] });
      expect([stop, from, r.lost]).toEqual([stop, from, null]);
    }
  }
  // Eight seconds is a loss, said seven seconds after the last frame.
  const r = run({ until: 40_000, answer: (at) => (at >= 10_000 && at < 18_000 ? 18_020 : at + 20), frames: [9_999] });
  expect(r.lost).toBe(16_999);
});

test("an answer to each ask keeps the socket, one ask a beat and no more", () => {
  const r = run({ until: 60_000, answer: (at) => at + 30 });
  expect(r.lost).toBeNull();
  expect(r.slow).toEqual([]);
  expect(r.pings.length).toBeGreaterThanOrEqual(28);
  expect(r.pings.length).toBeLessThanOrEqual(30);
  expect(r.rtt).toBe(30);
});

test("a socket that delivers needs no ask", () => {
  // A reply streaming: a frame every 100 ms.
  const r = run({ until: 29_000, frames: Array.from({ length: 300 }, (_, i) => i * 100) });
  expect(r).toMatchObject({ pings: [], lost: null });
});

// The reviewer's slow links: 1.5, 2 and 2.5 s each way, with up to half a second of jitter.
// The first round trip is known from the socket's own handshake (the store takes it as the
// first measure); the asks then wait for twice the link's round trip.
test("a link whose answers take three to five and a half seconds is asked less often and never lost", () => {
  for (const each of [1_500, 2_000, 2_500]) {
    let n = 0;
    const jitter = () => [0, 480, 130, 500, 60, 310][n++ % 6]!;
    const r = run({ until: 5 * 60_000, answer: (at) => at + 2 * each + jitter(), trips: [2 * each] });
    expect([each, r.lost]).toEqual([each, null]);
    expect(r.slow).toEqual([]);
    // One ask at a time: the next goes when the last was answered, not every two seconds.
    expect(r.pings.length).toBeLessThan((5 * 60_000) / (2 * each));
    expect(r.rtt).toBeGreaterThanOrEqual(2 * each);
  }
  // With no measure at all (a link that turned slow under an open socket) the first slow answer is the measure.
  const cold = run({ until: 60_000, answer: (at) => at + 3_000 });
  expect(cold.lost).toBeNull();
  expect(cold.rtt).toBe(3_000);
  // And a slow link that dies is still found: three asks, each given twice the round trip.
  const dead = run({ until: 5 * 60_000, answer: (at) => (at < 60_000 ? at + 4_000 : null), trips: [4_000] });
  expect(dead.lost).toBeGreaterThan(60_000);
  expect(dead.lost).toBeLessThanOrEqual(60_000 + 4 * 8_000);
});

// The reviewer's schedule again, then a real loss right after: a daemon that was busy for four
// seconds answers one or two asks late. That is no slow link, and the loss is seen as fast as ever.
test("a busy moment is not taken for a slow link: a loss right after it is seen seven seconds after the last frame", () => {
  let t: Trips = [];
  for (const ms of [20, 3_900, 1_900, 20]) t = tripped(t, ms);
  expect(rttOf(t)).toBe(20);
  for (const ms of [4_000, 4_300, 4_900]) t = tripped(t, ms);
  expect(rttOf(t)).toBe(4_000); // a slow link is slow every time
  expect(rttOf(tripped([], 60_000))).toBe(8_000); // and no link is given more than the cap
  expect(rttOf([])).toBe(0);
  // Busy from 10 s to 14 s, answering again for three seconds, then gone for good at 17 s.
  const answer = (at: number) => (at >= 17_000 ? null : at >= 10_000 && at < 14_000 ? 14_020 : at + 20);
  const r = run({ until: 60_000, answer, frames: [9_999] });
  expect(r.lost).toBeGreaterThan(17_000);
  expect(r.lost).toBeLessThanOrEqual(17_000 + 7_000 + BEAT_MS);
});

test("a look that ran late starts the count over; one that slept decides with a single ask", () => {
  // The page was busy for a second under the second ask's look: frames may wait behind the timer.
  const busy = run({ until: 9_000, late: { [2 * BEAT_MS]: 1_000 } });
  expect(busy.pings.slice(0, 3)).toEqual([BEAT_MS, 2 * BEAT_MS + 1_000, 2 * BEAT_MS + 1_000 + BEAT_MS]);
  expect(busy.lost).toBeNull();
  // The page slept 30 s (a closed lid): what it shows is old. One ask, and a second later it is lost.
  const slept = run({ until: 60_000, late: { [BEAT_MS]: 30_000 } });
  expect(slept.pings).toEqual([BEAT_MS + 30_000]);
  expect(slept.lost).toBe(BEAT_MS + 30_000 + GRACE_MS);
  // With the daemon still there, that one ask is answered and nothing is lost.
  expect(run({ until: 60_000, late: { [BEAT_MS]: 30_000 }, answer: (at) => at + 20 }).lost).toBeNull();
});

test("the slow beat asks a fifth as often", () => {
  const r = run({ until: 60_000, every: SLOW_BEAT_MS });
  expect(r.pings).toEqual([SLOW_BEAT_MS, 2 * SLOW_BEAT_MS, 3 * SLOW_BEAT_MS]);
  expect(r.lost).toBe(3 * SLOW_BEAT_MS + GRACE_MS);
});

// ---- the way back, on a fake clock. The absence begins at 0. A browser makes one socket
// handshake at a time to a host, so there is one try, and small requests ask beside it.
// `net(sent, kind)`: how long something sent then takes to be answered (null: never; 0: refused at once).
function back(net: (sent: number, kind: "socket" | "probe") => number | null, until = 120_000, hidden = false) {
  const w: Way = { socket: { born: null, open: false, life: 0 }, probes: [] };
  let round = 0, now = 0;
  const sockets: number[] = [], probes: number[] = [];
  // What is on its way: when it ends, and how.
  type Flight = { at: number; kind: "socket" | "probe"; k: number; sent: number; ok: boolean };
  let flights: Flight[] = [];
  const socket = (life: number) => {
    flights = flights.filter((f) => f.kind !== "socket");
    w.socket = { born: now, open: true, life };
    sockets.push(now);
    const n = net(now, "socket");
    if (n !== null) flights.push({ at: now + n, kind: "socket", k: 0, sent: now, ok: n > 0 });
  };
  while (now <= until) {
    // What arrives now.
    for (const f of flights.filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
      flights = flights.filter((x) => x !== f);
      if (f.kind === "socket") { if (f.ok) return { at: f.at, sockets, probes }; w.socket.open = false; continue; }
      const p = w.probes[f.k];
      if (!p || p.born !== f.sent) continue; // given up meanwhile
      p.open = false;
      // The daemon answered: a try made before this request left is given up for a new one.
      if (f.ok && !(w.socket.open && w.socket.born! >= f.sent)) { flights = flights.filter((x) => x.kind !== "probe"); w.probes = []; round = 0; socket(socketBound(0, f.at - f.sent)); }
    }
    const gap = retryGap(now, hidden);
    const s = step(w, now, gap);
    if (s.socket) { if (w.socket.born !== null && w.socket.open) round++; socket(socketBound(round)); }
    for (const k of s.probes) {
      flights = flights.filter((f) => !(f.kind === "probe" && f.k === k));
      w.probes[k] = { born: now, open: true, life: Math.max(PROBE_MS[k]!, gap) };
      probes.push(now);
      const n = net(now, "probe");
      if (n !== null) flights.push({ at: now + n, kind: "probe", k, sent: now, ok: n > 0 });
    }
    const next = now + step(w, now, gap).wait;
    now = Math.min(next, ...flights.map((f) => f.at).filter((at) => at > now));
  }
  return { at: null, sockets, probes };
}
const perMinute = (times: number[], m: number) => times.filter((t) => t >= m * 60_000 && t < (m + 1) * 60_000).length;

test("a daemon next door is back at once; one that is down is asked again after the gap, and less often the longer it is gone", () => {
  expect(back(() => 5).at).toBe(5);
  // The daemon is down and its machine says so: every try ends at once, no request asks beside it,
  // and the next is made after the gap (half a second at first, eight after eight minutes).
  const down = back(() => 0, 10 * 60_000);
  expect(down.probes).toEqual([]);
  expect(perMinute(down.sockets, 0)).toBeLessThanOrEqual(121);
  expect(perMinute(down.sockets, 2)).toBeLessThanOrEqual(31);
  expect(perMinute(down.sockets, 9)).toBeLessThanOrEqual(8);
  // It starts ten seconds in: found within the gap.
  expect(back((sent) => (sent < 10_000 ? 0 : 5)).at).toBeLessThanOrEqual(10_000 + 500 + 5);
  // A hidden page asks every eight seconds.
  expect(back(() => 0, 60_000, true).sockets.length).toBeLessThanOrEqual(9);
});

test("on a network that says nothing, one try waits and small requests ask beside it, fewer as time goes", () => {
  const dead = back(() => null, 10 * 60_000);
  // One socket at a time, each given its time: nine seconds, then twenty-seven.
  expect(dead.sockets.slice(0, 4)).toEqual([0, 9_000, 36_000, 63_000]);
  expect(perMinute(dead.probes, 0)).toBeLessThanOrEqual(87);
  expect(perMinute(dead.probes, 4)).toBeLessThanOrEqual(22);
  expect(perMinute(dead.probes, 9)).toBeLessThanOrEqual(8);
  const hid = back(() => null, 60_000, true);
  expect(hid.sockets.length + hid.probes.length).toBeLessThanOrEqual(11);
});

// The reviewer's schedule: the old socket is dead for good and so is everything sent before the
// network is back (a network that changed); from then on the link has a delay each way. A request
// is answered after a round trip; a socket is greeted after one and a little more.
test("after ten dead seconds the page is back within about a second on a fast link, and within seconds on a slow one", () => {
  const after = (each: number, backAt = 10_000) => {
    const r = back((sent, kind) => (sent < backAt ? null : 2 * each + (kind === "socket" ? 200 : 20)));
    return r.at === null ? null : r.at - backAt;
  };
  // Fast: the next small request is answered, and the try made on its word is greeted at once.
  // Within about a second for an absence of up to a minute; then within a twentieth of the absence, eight seconds at most.
  for (let at = 3_000; at < 60_000; at += 700) expect([at, after(0, at)! <= 1_300]).toEqual([at, true]);
  for (let at = 60_000; at < 15 * 60_000; at += 7_100) expect([at, after(0, at)! <= Math.min(8_300, Math.max(3_300, at / 20))]).toEqual([at, true]);
  // 1.5, 2 and 2.5 s each way: a request given nine seconds is answered, and the try made on its
  // word is given the time it needs (before, no try was given more than four seconds in all).
  // Whenever the link comes back: the request's turn, its round trip, and the try's.
  for (const each of [1_500, 2_000, 2_500]) {
    for (let at = 3_000; at < 60_000; at += 700) {
      const took = after(each, at);
      expect([each, at, took !== null && took <= 9_000 + 4 * each + 600]).toEqual([each, at, true]);
    }
  }
  // At the reviewer's ten seconds.
  expect(after(1_500)).toBeLessThanOrEqual(8_000);
  expect(after(2_000)).toBeLessThanOrEqual(10_000);
  expect(after(2_500)).toBeLessThanOrEqual(12_000);
  // Four seconds each way is still found: by the try itself, in its twenty-seven seconds.
  expect(after(4_000)).toBeLessThanOrEqual(27_000 + 8_300);
});

test("an idle minute on screen costs thirty beats of about a kilobyte in all", () => {
  const c = idleCost();
  expect(c.beats).toBe(30);
  expect(c.bytes).toBeLessThan(1_200);
});
