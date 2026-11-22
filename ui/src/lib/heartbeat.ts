// Proof that the page still hears the daemon. A socket that goes silent
// without closing (a network change, a tunnel that stalls) tells the page
// nothing: so while the page is on screen and nothing arrived for a beat, it
// asks. Two asks with no word back and the daemon is slow to answer (the logo
// says so); a third, and it is not heard (the band, the clocks stop).
//
// The numbers. The leading socket libraries beat every 15 to 25 s and give up
// after one to two more (socket.io: a ping every 25 s, 20 s to answer; SignalR:
// every 15 s, timeout at twice that), which leaves a page saying it is live
// for 30 to 45 s after the network went. Their interval is chosen for sockets
// that also beat in the background. Android's network guide says why a slower
// beat does not help a phone that is on screen: a transfer keeps the radio up
// for about 18 s after it (5 s at full power, 12 s low), so three small
// transfers a minute already keep it on for good, and bundling or stopping is
// what saves energy, not spacing. So this beat is fast and short-lived: every
// 2 s, only while the page is visible and the socket is otherwise quiet (any
// frame is proof, a streaming reply sends no ping at all), and never while the
// page is hidden, where the old 20 s ping kept a phone's radio up all day.
// A browser asked to save data gets the slow beat.
//   https://socket.io/docs/v4/server-options/ (pingInterval, pingTimeout)
//   https://learn.microsoft.com/en-us/aspnet/core/signalr/configuration (KeepAliveInterval)
//   https://developer.android.com/develop/connectivity/network-ops/network-access-optimization
//   RFC 6455 section 5.5.2 (a ping may be sent to verify the far end still answers)
//
// Every bound knows the link. The page measures the round trip of each ask
// (the daemon answers them in order, so no ask carries a mark), and an ask is
// given twice the link's round trip when that is more than the fixed wait: a link with two seconds each way is asked every eight
// seconds and never taken for lost while it answers. A daemon that is busy
// for a few seconds is not lost either: with the fixed waits the page says
// "slow to answer" after four seconds of silence and "not reachable" after
// seven.
export const BEAT_MS = 2_000;
// How long the last ask gets. With it the page knows 7 s after the last frame.
export const GRACE_MS = 1_000;
// Asks with no word back before the daemon is not heard; from the second on it is slow to answer.
export const ASKS = 3;
// Save-Data: a fifth of the traffic, and a drop is known within 31 s.
export const SLOW_BEAT_MS = 10_000;
// A timer that ran this late was held up: the page was busy or asleep, and
// frames may be waiting behind it. Silence measured across that proves nothing.
export const LATE_MS = 250;
// A timer that ran this late was asleep with its page (a closed lid, a frozen
// tab). What the page shows is from before: one ask decides, with the last
// ask's wait, instead of three. The same when a page is seen again after it
// was hidden that long.
export const SLEPT_MS = 5_000;
// Hidden this long, the page reads what it holds again when it is back.
export const HIDDEN_RESYNC_MS = 60_000;
// The round trip a bound is stretched for, at most: a link slower than this is judged as this slow.
export const RTT_MAX_MS = 8_000;
const RTT_KEPT = 3;

// The round trips of the last few asks. The link's round trip is the
// quickest of them: a slow link is slow every time, while a daemon that was
// busy for a moment answers one or two asks late and the next at once. (The
// slowest would take such a moment for a slow link, and the page would then
// be slow to see a real loss right after it.) An ask is given twice that, so
// a link that jitters by as much as its round trip is still not lost.
export type Trips = number[];
export const tripped = (trips: Trips, ms: number): Trips => [...trips, Math.max(0, ms)].slice(-RTT_KEPT);
export const rttOf = (trips: Trips) => (trips.length ? Math.min(RTT_MAX_MS, Math.min(...trips)) : 0);

// `heard`: when the socket last delivered anything. `pings`: asks sent since
// then (the caller sets it to 0 with every frame). `due`: when this look was due.
export type Beat = { heard: number; pings: number; due: number };
export type Look = { ping: boolean; lost: boolean; slow: boolean; pings: number; due: number };

// One look at the socket: whether to ask now, whether the daemon is slow to
// answer or lost, and when to look again. `rtt`: the link's round trip.
export function look(b: Beat, now: number, every = BEAT_MS, grace = GRACE_MS, rtt = 0): Look {
  const step = Math.max(every, 2 * rtt), last = Math.max(grace, 2 * rtt);
  const after = (pings: number) => (pings >= ASKS ? last : step);
  // Asleep: what is shown is old, and one ask says whether the daemon is still there.
  if (now - b.due > SLEPT_MS) return { ping: true, lost: false, slow: false, pings: ASKS, due: now + last };
  // Held up: start over with a fresh ask instead of counting silence the page was too busy to hear through.
  if (now - b.due > LATE_MS && b.pings > 0) return { ping: true, lost: false, slow: false, pings: 1, due: now + step };
  if (b.pings === 0) {
    const quiet = now - b.heard;
    if (quiet < every) return { ping: false, lost: false, slow: false, pings: 0, due: b.heard + every };
    return { ping: true, lost: false, slow: false, pings: 1, due: now + after(1) };
  }
  if (b.pings < ASKS) return { ping: true, lost: false, slow: true, pings: b.pings + 1, due: now + after(b.pings + 1) };
  return { ping: false, lost: true, slow: true, pings: b.pings, due: now };
}

// ---- the way back
//
// While the daemon is not heard the page looks for it with two things: a new
// socket (the first of it and the silent one to speak is the connection), and
// small requests that ask whether the daemon answers at all. Which of the two
// does the looking depends on what the absence is.
//
// The network says nothing. How long a try needs is not known: a daemon next
// door greets in milliseconds, a phone on a train needs seconds for the
// handshake alone, and after a network change a try made before it is dead
// for good. A browser makes one socket handshake at a time to a host, so a
// second try only waits behind the first. So the one try is given long (nine
// seconds, then twenty-seven), which a slow link needs, and requests ask
// beside it: a second, two and four seconds into the try and every four
// seconds after, each given nine seconds, so one sent after the network is
// back is answered on a slow link too. The first answer says the network is
// back and how slow it is, and a new try is made on its word, with its bound
// from what was measured. A link that comes back is found within four
// seconds and its round trip, after an absence of any length; one that is
// slow costs three or four requests that could not help, not one a second.
//
// A try made on an answer is the daemon's to take: it is not given up for
// another answer and nothing asks beside it, for nine seconds at least. (A
// try was once replaced on every answer. A browser that has seen many
// sockets fail holds each new one back for seconds, so every try was given
// up a second into that wait and none ever opened: the page stayed
// "Reconnecting" beside a daemon that answered.)
//
// The daemon's machine answers and the daemon does not (it is down, starting
// or being replaced: a try ends at once, or a request is refused). Then
// requests ask alone, one each gap (a sixtieth of the absence, between half a
// second and eight; a hidden page eight), and a socket is made only when one
// is answered. Sockets that fail are what a browser counts before it holds
// new ones back; requests it does not count, so the try made when the daemon
// is back opens at once. A request that gets no answer at all says the
// network went quiet: the try is made again and the asking goes on beside it.
//
// Chrome's count: services/network/websocket_throttler.cc
// (WebSocketPerProcessThrottler::CalculateDelay: with sixteen times more
// failed than opened sockets in its window every new one waits one to five seconds).
// What a request that asks beside a try is given.
export const ASK_MS = 9_000;
// How long the try has been out with no word before the first asks beside it; the next
// comes as long after that as the try had been out, up to this often.
export const ASK_AFTER_MS = 1_000;
export const ASK_EVERY_MS = 4_000;
// What a request that asks alone is given before the network is taken to say nothing.
export const ALONE_MS = 3_000;
// What a try is given: the first of an absence, then each one after.
export const SOCKET_MS = [9_000, 27_000] as const;
export const SOCKET_MAX_MS = 60_000;
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 8_000;
export const retryGap = (downFor: number, hidden = false) => (hidden ? RETRY_MAX_MS : Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(downFor / 60))));
// A try's bound. `answered`: how long the request that found the daemon took (a socket's handshake is two such trips and its greeting).
export const socketBound = (round: number, answered?: number) =>
  Math.min(SOCKET_MAX_MS, Math.max(SOCKET_MS[Math.min(round, SOCKET_MS.length - 1)]!, answered === undefined ? 0 : 4 * answered + 1_000));

// One thing on its way: when it was made (null: none yet in this absence),
// whether it is still out (false: it ended, refused or failed), and how long it is given.
export type Out = { born: number | null; open: boolean; life: number };
// The way back in one absence. `socket.sure`: the try was made on an answer.
// `ask`: the last request made (earlier ones may still be out: each has its own time).
// `refused`: the daemon's machine answers and the daemon does not, so requests ask alone.
export type Way = { socket: Out & { sure?: boolean }; ask: Out; refused: boolean };
export const noWay = (): Way => ({ socket: { born: null, open: false, life: 0 }, ask: { born: null, open: false, life: 0 }, refused: false });
// What to make now, and when to look again. `quiet`: the request that asked alone got no answer in its time.
export type Step = { socket: boolean; ask: boolean; wait: number; quiet?: boolean };
export function step(w: Way, now: number, gap: number, hidden = false): Step {
  const s = w.socket, p = w.ask;
  const within = (wait: number) => Math.max(50, Math.min(wait, RETRY_MAX_MS));
  if (w.refused) {
    if (p.open && p.born !== null) {
      // Not refused and not answered: the network says nothing now, and a try is made.
      if (now - p.born >= p.life) return { socket: true, ask: false, wait: within(gap), quiet: true };
      return { socket: false, ask: false, wait: within(p.born + p.life - now) };
    }
    const from = Math.max(s.born ?? now, p.born ?? 0) + gap;
    return now >= from ? { socket: false, ask: true, wait: within(Math.min(gap, ALONE_MS)) } : { socket: false, ask: false, wait: within(from - now) };
  }
  const age = s.born === null ? 0 : now - s.born;
  const socket = s.born === null || (s.open ? age >= Math.max(s.life, gap) : age >= gap);
  let wait = socket ? gap : s.open ? Math.max(s.life, gap) - age : gap - age;
  let ask = false;
  // Requests ask only beside a try that is still out and was not made on an answer.
  if (!socket && s.open && !s.sure) {
    const born = s.born!;
    const last = p.born !== null && p.born >= born ? p.born : null;
    // A hidden page asks every eight seconds.
    const from = hidden ? (last ?? born) + RETRY_MAX_MS : last === null ? born + ASK_AFTER_MS : last + Math.min(ASK_EVERY_MS, Math.max(ASK_AFTER_MS, last - born));
    if (now >= from) ask = true;
    else wait = Math.min(wait, from - now);
  }
  return { socket, ask, wait: within(wait) };
}
// What a request made now is given.
export const askLife = (w: Way) => (w.refused ? ALONE_MS : ASK_MS);
// A request was answered: whether a new try is made on its word. Not beside a try that was itself made on one.
export const answerMakesTry = (w: Way) => !(w.socket.open && w.socket.sure);

// What a ping and its answer weigh on the wire, as WebSocket frames (the
// payload, 6 bytes of header and mask up, 2 bytes of header down).
export const PING = JSON.stringify({ op: "ping" });
export const beatBytes = (pong = JSON.stringify({ t: "pong" })) => PING.length + 6 + pong.length + 2;
// An idle minute on screen: beats, and the bytes they carry.
export const idleCost = (every = BEAT_MS) => ({ beats: Math.floor(60_000 / every), bytes: Math.floor(60_000 / every) * beatBytes() });
