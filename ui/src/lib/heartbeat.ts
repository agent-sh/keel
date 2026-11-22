// Proof that the page still hears the daemon. A socket that goes silent
// without closing (a network change, a tunnel that stalls) tells the page
// nothing: so while the page is on screen and nothing arrived for a beat, it
// asks, and two asks in a row with no word back mean the daemon is not heard.
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
export const BEAT_MS = 2_000;
// How long the second ask gets. With it the page knows 5 s after the last frame.
export const GRACE_MS = 1_000;
// Save-Data: a fifth of the traffic, and a drop is known within 22 s.
export const SLOW_BEAT_MS = 10_000;
// A timer that ran this late was held up: the page was busy or asleep, and
// frames may be waiting behind it. Silence measured across that proves nothing.
export const LATE_MS = 250;
// A try that has not opened by then is given up and made again.
export const CONNECT_MS = 4_000;
// Hidden this long, the page reads what it holds again when it is back.
export const HIDDEN_RESYNC_MS = 60_000;

// `heard`: when the socket last delivered anything. `pings`: asks sent since
// then (the caller sets it to 0 with every frame). `due`: when this look was due.
export type Beat = { heard: number; pings: number; due: number };
export type Look = { ping: boolean; lost: boolean; pings: number; due: number };

// One look at the socket: whether to ask now, whether the daemon is lost, and
// when to look again.
export function look(b: Beat, now: number, every = BEAT_MS, grace = GRACE_MS): Look {
  // Held up: start over with a fresh ask instead of counting silence the page slept through.
  if (now - b.due > LATE_MS && b.pings > 0) return { ping: true, lost: false, pings: 1, due: now + every };
  if (b.pings === 0) {
    const quiet = now - b.heard;
    if (quiet < every) return { ping: false, lost: false, pings: 0, due: b.heard + every };
    return { ping: true, lost: false, pings: 1, due: now + every };
  }
  if (b.pings === 1) return { ping: true, lost: false, pings: 2, due: now + grace };
  return { ping: false, lost: true, pings: b.pings, due: now };
}

// The gap between two tries while the daemon is not heard: a sixtieth of how
// long it has been, between half a second and eight. A drop of half a minute
// is over within half a second of the network's return; a daemon that has
// been gone an hour is asked every eight seconds. A hidden page waits the
// longest gap: nobody is looking.
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 8_000;
export const retryGap = (downFor: number, hidden = false) => (hidden ? RETRY_MAX_MS : Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Math.round(downFor / 60))));

// What a ping and its answer weigh on the wire, as WebSocket frames (the
// payload, 6 bytes of header and mask up, 2 bytes of header down).
export const PING = JSON.stringify({ op: "ping" });
export const beatBytes = (pong = JSON.stringify({ t: "pong" })) => PING.length + 6 + pong.length + 2;
// An idle minute on screen: beats, and the bytes they carry.
export const idleCost = (every = BEAT_MS) => ({ beats: Math.floor(60_000 / every), bytes: Math.floor(60_000 / every) * beatBytes() });
