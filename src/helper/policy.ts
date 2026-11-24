// The helper's pure rules: which events wake it, when the next wake may
// come and what an error spike is (the memory's rules are records.ts).
// Everything here is plain data in, plain data out (policy.test.ts).

// An event the helper is told about. `wake`: worth starting a turn for (they
// may be away and something broke or needs them); `feed`: told with the next
// turn, whoever starts it.
import { zoned } from "../core/clock.ts";
export type Level = "wake" | "feed";
export type DigestEvent = { id: string; ts: number; kind: string; session_id: string | null; title: string; body: string; level: Level };

// Alert kinds (src/automation/alerts.ts) as the helper weighs them. An
// approval or a question already reaches them on their channels: the helper
// hears of it with their next word, it does not wake for it. A failure, a turn
// the model declined (the work stopped there, as with a failure), a usage
// limit and a failed loop are what they would want summed up while away. A
// finished turn matters only when it was long work (the alert rule's own
// threshold, passed in). A snooze ending is routine.
// A word about a machine of the fleet (it went out of reach) is told with the next turn.
export function levelOfAlert(kind: string, data: { ran_ms?: number } | undefined, longTurnMs: number): Level | null {
  if (kind === "failed" || kind === "declined" || kind === "limit" || kind === "loop_failed") return "wake";
  if (kind === "approval" || kind === "question" || kind === "agent" || kind === "machine") return "feed";
  if (kind === "finished") return Number(data?.ran_ms) >= longTurnMs ? "feed" : null;
  return null;
}

// When the next wake may run: a burst is gathered for `coalesceMs` after its
// first event, and two wakes are at least `gapMs` apart (a failing loop does
// not wake the helper once per failure).
export function nextWakeAt(now: number, lastWake: number, coalesceMs: number, gapMs: number): number {
  return Math.max(now + coalesceMs, lastWake ? lastWake + gapMs : 0);
}

// A spike: `threshold` failures captured within `windowMs`. Returns the
// times still inside the window (with `ts`), and whether this one made a
// spike; after a spike the window starts empty, so one spike is told once.
// Errors: this many captures within the window is a spike worth a wake.
export const SPIKE_WINDOW_MS = 10 * 60_000;
export const SPIKE_COUNT = 5;
// A captured failure the spike counts: a new one, not a repeat a row already said (ErrorPlace.repeat).
export const spikeCounts = (c: { repeat?: true }) => !c.repeat;

export function spike(times: number[], ts: number, windowMs: number, threshold: number): { times: number[]; spiked: boolean } {
  const kept = [...times.filter((t) => ts - t < windowMs), ts];
  return kept.length >= threshold ? { times: [], spiked: true } : { times: kept, spiked: false };
}

// One line per event, newest last, at most `max` lines (older ones counted).
// Times are local, as in every text Keel writes; the text that holds the
// lines says the zone once (digestZone), and a time at another offset says its own.
export const digestZone = (now = Date.now()) => `times are local, ${zoned(now).label}`;
export function digestLines(events: DigestEvent[], max: number, title: (sessionId: string | null) => string, now = Date.now()): string {
  const shown = events.slice(-max);
  const z = zoned(now);
  const lines = shown.map((e) => {
    const t = z.time(e.ts);
    const where = e.session_id ? ` [${title(e.session_id)} ${e.session_id}]` : "";
    return `- ${t.slice(0, 5)}${t.slice(8)} ${e.kind}${where}: ${e.title}${e.body ? `: ${e.body}` : ""}`;
  });
  const older = events.length - shown.length;
  return (older > 0 ? `- (${older} older events not shown)\n` : "") + lines.join("\n");
}
