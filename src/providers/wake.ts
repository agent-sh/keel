// What a machine's sleep does to the connections the process keeps for model requests.
//
// Bun keeps a finished request's connection in a pool and the next request to that host takes it, however long
// it sat. After a sleep the peer's end may be gone and the network may drop what is sent to it without a word:
// the request on that socket then waits for headers until the stream's idle window ends (300 s by default).
// An abort closes the socket it used, which is the only way to take one out of Bun's pool, and a request sent
// with `keepalive: false` never takes a pooled one.
//
// So when the daemon notices a sleep, each host it talked to is marked. A request to a marked host opens a
// connection of its own, and in the background a few cheap probes with a short limit take the old sockets out:
// one that does not answer in time is aborted and gone. When a round of probes all answer, the host is clean and
// its requests use the pool again. Without a sleep nothing here runs and requests are sent as they always were.
import { joinPulse } from "../core/pulse.ts";

// The wall clock ran this much past the monotonic one between two beats: the machine was asleep (the monotonic
// clock does not count a suspend on Linux; a clock set by hand or by a time server counts the same, which only
// costs a purge). A beat comes every ten seconds at the latest, so this is far past what a busy loop adds.
export const WAKE_JUMP_MS = 30_000;
// A probe that does not answer in this long found a dead connection.
export const PROBE_MS = 2_000;
// Probes sent together in a round: one takes one pooled connection. A round whose probes all answer ends the purge.
export const PROBES = 6;
const ROUNDS = 6;
// Rounds in a row with no answer at all: the host is slow to answer a HEAD, not holding dead sockets, and more
// rounds would only add waiting. The purge ends there.
const SILENT_ROUNDS = 2;

// Pure: did the machine sleep between two beats? `wall`: Date.now, `mono`: a clock that stops while it sleeps.
export const slept = (prev: { wall: number; mono: number }, now: { wall: number; mono: number }, jump = WAKE_JUMP_MS) =>
  now.wall - prev.wall - (now.mono - prev.mono) > jump;

// The hosts requests went to (an origin each), and the ones marked after a sleep, with the purge under way.
const used = new Set<string>();
const marked = new Map<string, Promise<void>>();
// What runs when a sleep is found, beside the purge: others that keep connections of their own (a socket pool) close theirs.
const hooks = new Set<() => void>();
export function onWoke(hook: () => void): () => void {
  hooks.add(hook);
  return () => void hooks.delete(hook);
}

// The clocks and the reading of the last look. The tick looks every few seconds, and a request looks too: a turn
// that starts in the seconds before the tick would otherwise take a pooled socket the sleep has already killed.
type Clocks = { wall: () => number; mono: () => number };
const realClocks: Clocks = { wall: Date.now, mono: () => performance.now() };
let clocks = realClocks;
let prev = { wall: clocks.wall(), mono: clocks.mono() };
let probing = probeOf;

// Reads both clocks and says whether the machine slept since the last read, by anyone.
function look(): boolean {
  const now = { wall: clocks.wall(), mono: clocks.mono() };
  const was = prev;
  prev = now;
  return slept(was, now);
}

// For tests: the hosts, the marks and the hooks forgotten, the clocks and the probe as given (the real ones by default).
export function reset(opts: { clocks?: Clocks; probe?: typeof probeOf } = {}) {
  used.clear();
  marked.clear();
  hooks.clear();
  clocks = opts.clocks ?? realClocks;
  probing = opts.probe ?? probeOf;
  prev = { wall: clocks.wall(), mono: clocks.mono() };
}

// Whether a request to `origin` must open its own connection now. Also remembers the host. Two clock reads: a
// sleep that the tick has not yet seen is found here, and this request is already one of the marked ones.
export function avoidPool(origin: string): boolean {
  used.add(origin);
  if (look()) void woke(probing);
  return marked.has(origin);
}

// One round: `PROBES` requests at once, each limited to `PROBE_MS`. Returns how many got no answer.
async function round(origin: string, probe: (origin: string, ms: number) => Promise<boolean>): Promise<number> {
  const answered = await Promise.all(Array.from({ length: PROBES }, () => probe(origin, PROBE_MS)));
  return answered.filter((a) => !a).length;
}
// The default probe: HEAD of the origin's root. Any answer, an error status included, shows the socket lives; a
// refused or reset connection is gone from the pool as well. Only a silence of `ms` is a dead one (and the abort closes it).
async function probeOf(origin: string, ms: number): Promise<boolean> {
  try { await fetch(origin, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(ms) }); return true; }
  catch (e) { return (e as Error)?.name !== "TimeoutError" && (e as Error)?.name !== "AbortError"; }
}

// Marks every host used so far and purges each in the background. Returns when all are clean.
export function woke(probe: (origin: string, ms: number) => Promise<boolean> = probing): Promise<void> {
  for (const hook of [...hooks]) try { hook(); } catch {}
  const all = [...used].map((origin) => {
    const held = marked.get(origin);
    if (held) return held;
    const p = (async () => {
      for (let i = 0, silent = 0; i < ROUNDS && silent < SILENT_ROUNDS; i++) {
        const missed = await round(origin, probe);
        if (!missed) break;
        silent = missed === PROBES ? silent + 1 : 0;
      }
    })().finally(() => { marked.delete(origin); });
    marked.set(origin, p);
    return p;
  });
  return Promise.all(all).then(() => {});
}

// The daemon's tick checks for a sleep each time it runs. `onWake`: what to do (the purge).
export function watchWake(onWake: () => void = () => void woke(), join: typeof joinPulse = joinPulse, own?: Clocks) {
  if (own) { clocks = own; prev = { wall: own.wall(), mono: own.mono() }; }
  return join("wake", () => { if (look()) onWake(); }, { every: 5_000 });
}
