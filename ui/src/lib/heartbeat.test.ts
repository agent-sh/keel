import { expect, test } from "bun:test";
import { answerMakesTry, askLife, ASKS, BEAT_MS, GRACE_MS, idleCost, look, noWay, retryGap, rttOf, SLOW_BEAT_MS, socketBound, step, tripped, type Beat, type Trips, type Way } from "./heartbeat.ts";

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
// handshake at a time to a host, so there is one try, and small requests ask beside it or alone.
// `net(sent, kind)`: how long something sent then takes to be answered (null: never; 0: refused
// at once; below 0: refused after that long, as a socket the browser held back is).
type Net = (sent: number, kind: "socket" | "probe") => number | null;
function back(net: Net, until = 120_000, hidden = false) {
  const w: Way = noWay();
  let round = 0, now = 0;
  const sockets: number[] = [], probes: number[] = [];
  // What is on its way: when it ends, and how. A request is given up when its time is over.
  type Flight = { at: number; kind: "socket" | "probe"; sent: number; ok: boolean; life: number };
  let flights: Flight[] = [];
  const socket = (life: number, sure = false) => {
    flights = [];
    w.socket = { born: now, open: true, life, sure };
    w.ask = { ...w.ask, open: false };
    w.refused = false;
    sockets.push(now);
    const n = net(now, "socket");
    if (n !== null) flights.push({ at: now + Math.max(1, Math.abs(n)), kind: "socket", sent: now, ok: n > 0, life });
  };
  while (now <= until) {
    // What arrives now.
    for (const f of flights.filter((x) => x.at <= now).sort((x, y) => x.at - y.at)) {
      if (!flights.includes(f)) continue; // given up by what arrived before it
      flights = flights.filter((x) => x !== f);
      if (f.kind === "socket") {
        if (f.ok) return { at: f.at, sockets, probes };
        // Ended without a word: requests ask alone from here.
        w.socket.open = false;
        w.refused = true;
        continue;
      }
      if (f.at - f.sent > f.life) continue; // its time was over
      if (w.ask.born === f.sent) w.ask.open = false;
      if (f.ok) {
        // The daemon answered: a new try on its word, unless the one out was made on one.
        if (answerMakesTry(w)) { round = 0; socket(socketBound(0, f.at - f.sent), true); }
      } else {
        // Refused: the try that is out and the other requests are given up, and requests ask alone.
        flights = [];
        w.socket.open = false;
        w.ask.open = false;
        w.refused = true;
      }
    }
    const gap = retryGap(now, hidden);
    const s = step(w, now, gap, hidden);
    if (s.quiet) w.refused = false;
    if (s.socket) { if (w.socket.born !== null && w.socket.open) round++; socket(socketBound(round)); }
    if (s.ask) {
      const life = askLife(w);
      w.ask = { born: now, open: true, life };
      probes.push(now);
      const n = net(now, "probe");
      if (n !== null) flights.push({ at: now + Math.max(1, Math.abs(n)), kind: "probe", sent: now, ok: n > 0, life });
    }
    const next = now + step(w, now, gap, hidden).wait;
    now = Math.min(next, ...flights.map((f) => f.at).filter((at) => at > now));
  }
  return { at: null, sockets, probes };
}
const perMinute = (times: number[], m: number) => times.filter((t) => t >= m * 60_000 && t < (m + 1) * 60_000).length;

test("a daemon next door is back at once; one that is down is asked by requests, one each gap, and a socket is made only on an answer", () => {
  expect(back(() => 5).at).toBe(5);
  // The daemon is down and its machine says so: the first try ends at once, and from there
  // requests ask alone, one each gap (half a second at first, eight after eight minutes). No
  // socket is made while they are refused: failed sockets are what a browser counts against the page.
  const down = back(() => 0, 10 * 60_000);
  expect(down.sockets).toEqual([0]);
  expect(perMinute(down.probes, 0)).toBeLessThanOrEqual(121);
  expect(perMinute(down.probes, 2)).toBeLessThanOrEqual(31);
  expect(perMinute(down.probes, 9)).toBeLessThanOrEqual(8);
  // It starts again: the next request is answered, and the try made on its word is greeted.
  // Found within the gap, however long it was down.
  for (const at of [3_000, 10_000, 20_000, 45_000, 60_000, 75_000, 120_000, 180_000, 300_000]) {
    const r = back((sent) => (sent < at ? 0 : 5), at + 60_000);
    expect([at, r.at !== null && r.at - at <= retryGap(at) + 20]).toEqual([at, true]);
    expect([at, r.sockets.length]).toEqual([at, 2]);
  }
  // A hidden page asks every eight seconds.
  const hid = back(() => 0, 60_000, true);
  expect(hid.sockets.length + hid.probes.length).toBeLessThanOrEqual(9);
});

// The reviewer's schedule. A browser that has seen many sockets fail holds each new one back
// one to five seconds before it starts (Chrome counts failed sockets a page), while requests
// are answered at once. A try that is given up on every answer is then never greeted.
test("a try made on an answer is kept: a socket greeted two to five seconds after its start is still the way back", () => {
  for (const held of [2_000, 3_500, 5_000]) {
    for (const at of [20_000, 45_000, 60_000, 75_000, 120_000]) {
      // Down until `at`: sockets are refused after the browser's hold, requests at once. Then back.
      const r = back((sent, kind) => (kind === "probe" ? (sent < at ? 0 : 3) : sent < at ? -held : held + 10), at + 60_000);
      // Connected within the gap, the hold and a little of the daemon's first answer; with the tries it took.
      expect([held, at, r.at !== null && r.at - at <= retryGap(at) + held + 100]).toEqual([held, at, true]);
      // One try after the return, not one a second.
      expect([held, at, r.sockets.filter((t) => t >= at).length]).toEqual([held, at, 1]);
    }
    // The same on a network that had said nothing (a try is out, made into the silence, when the first answer comes).
    const r = back((sent, kind) => (sent < 30_000 ? null : kind === "probe" ? 3 : held + 10), 90_000);
    expect([held, r.at !== null && r.at - 30_000 <= 4_000 + held + 100]).toEqual([held, true]);
    expect([held, r.sockets.filter((t) => t >= 30_000).length]).toEqual([held, 1]);
  }
  // A daemon that answers requests and greets no socket at all: the try made on an answer has its nine
  // seconds, and the one after it is given up for the next answer: two tries in ten seconds, not one an answer.
  const never = back((_sent, kind) => (kind === "probe" ? 3 : null), 120_000);
  expect(never.at).toBeNull();
  expect(never.sockets.length).toBeLessThanOrEqual(24);
  // A socket the browser holds while the daemon is down is given up when a request is refused, and no more are made.
  const held = back((sent, kind) => (kind === "probe" ? 0 : -4_000), 120_000);
  expect(held.sockets).toEqual([0]);
});

test("on a network that says nothing, one try waits and requests ask beside it, every four seconds from the fourth", () => {
  const dead = back(() => null, 10 * 60_000);
  // One socket at a time, each given its time: nine seconds, then twenty-seven.
  expect(dead.sockets.slice(0, 4)).toEqual([0, 9_000, 36_000, 63_000]);
  // Beside the first try: a second, two, four and eight seconds in.
  expect(dead.probes.filter((t) => t < 9_000)).toEqual([1_000, 2_000, 4_000, 8_000]);
  // Beside each later one: the same, and every four seconds after.
  expect(dead.probes.filter((t) => t >= 9_000 && t < 36_000).map((t) => t - 9_000)).toEqual([1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000]);
  // So a link that comes back is asked within four seconds, at any time: eighteen requests a minute, and two tries.
  for (let m = 0; m < 10; m++) expect([m, perMinute(dead.probes, m) <= 19]).toEqual([m, true]);
  expect(perMinute(dead.sockets, 5)).toBeLessThanOrEqual(3);
  // A hidden page: a try, and a request every eight seconds.
  const hid = back(() => null, 60_000, true);
  expect(hid.sockets.length + hid.probes.length).toBeLessThanOrEqual(11);
});

// The reviewer's schedule: the old socket is dead for good and so is everything sent before the
// network is back (a network that changed); from then on the link has a delay each way. A request
// is answered after a round trip; a socket is greeted after one and a little more.
test("after a dead network the page is back within about a second on a fast link, and within seconds on a slow one", () => {
  const run = (each: number, backAt = 10_000) => back((sent, kind) => (sent < backAt ? null : 2 * each + (kind === "socket" ? 200 : 20)), backAt + 120_000);
  const after = (each: number, backAt = 10_000) => { const r = run(each, backAt); return r.at === null ? null : r.at - backAt; };
  // Fast: the next request is answered, and the try made on its word is greeted at once.
  // Within about a second in the first seconds of a try, and within four at any time, after any absence.
  for (let at = 3_000; at < 15 * 60_000; at += 2_300) expect([at, after(0, at)! <= 4_300]).toEqual([at, true]);
  expect(after(0)).toBeLessThanOrEqual(1_300);
  expect(after(0, 11 * 60_000)).toBeLessThanOrEqual(4_300);
  // Half a second to four seconds each way, whenever the link comes back: the next request is
  // answered after its round trip, and the try made on its word is greeted after its own.
  for (const each of [500, 1_000, 1_500, 2_000, 2_500, 4_000]) {
    for (let at = 3_000; at < 90_000; at += 700) {
      const took = after(each, at);
      expect([each, at, took !== null && took <= 4_000 + 4 * each + 300]).toEqual([each, at, true]);
    }
  }
  // At the reviewer's ten seconds.
  expect(after(1_500)).toBeLessThanOrEqual(8_000);
  expect(after(2_000)).toBeLessThanOrEqual(10_000);
  expect(after(2_500)).toBeLessThanOrEqual(12_000);
  // What a return costs in requests, whatever the link: four at most, not one a second.
  for (const each of [0, 500, 1_500, 2_000, 2_500, 4_000]) {
    const r = run(each);
    expect([each, r.probes.filter((t) => t >= 10_000).length <= 4]).toEqual([each, true]);
  }
  // A link slower than a request's nine seconds (five each way) is found by the try itself, in its twenty-seven.
  expect(after(5_000, 9_500)).toBeLessThanOrEqual(27_000 + 10_300);
});

test("an idle minute on screen costs thirty beats of about a kilobyte in all", () => {
  const c = idleCost();
  expect(c.beats).toBe(30);
  expect(c.bytes).toBeLessThan(1_200);
});
