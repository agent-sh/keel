// The helper's pure rules: which events wake it, when the next wake may
// come, what an error spike is, and which remembered items a turn recalls.
// Everything here is plain data in, plain data out (helper.test.ts).

export type MemoryKind = "preference" | "decision" | "person" | "commitment" | "fact";
export const MEMORY_KINDS: MemoryKind[] = ["preference", "decision", "person", "commitment", "fact"];
export type MemoryItem = { id: string; ts: number; updated: number; kind: MemoryKind; text: string; source: "helper" | "owner"; used?: number };

// An event the helper is told about. `wake`: worth starting a turn for (they
// may be away and something broke or needs them); `feed`: told with the next
// turn, whoever starts it.
export type Level = "wake" | "feed";
export type DigestEvent = { id: string; ts: number; kind: string; session_id: string | null; title: string; body: string; level: Level };

// Alert kinds (src/automation/alerts.ts) as the helper weighs them. An
// approval or a question already reaches them on their channels: the helper
// hears of it with their next word, it does not wake for it. A failure, a usage
// limit and a failed loop are what they would want summed up while away. A
// finished turn matters only when it was long work (the alert rule's own
// threshold, passed in). A snooze ending is routine.
export function levelOfAlert(kind: string, data: { ran_ms?: number } | undefined, longTurnMs: number): Level | null {
  if (kind === "failed" || kind === "limit" || kind === "loop_failed") return "wake";
  if (kind === "approval" || kind === "question" || kind === "agent") return "feed";
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
export function spike(times: number[], ts: number, windowMs: number, threshold: number): { times: number[]; spiked: boolean } {
  const kept = [...times.filter((t) => ts - t < windowMs), ts];
  return kept.length >= threshold ? { times: [], spiked: true } : { times: kept, spiked: false };
}

// One line per event, newest last, at most `max` lines (older ones counted).
export function digestLines(events: DigestEvent[], max: number, title: (sessionId: string | null) => string): string {
  const shown = events.slice(-max);
  const lines = shown.map((e) => {
    const when = new Date(e.ts).toISOString().slice(11, 16);
    const where = e.session_id ? ` [${title(e.session_id)} ${e.session_id}]` : "";
    return `- ${when} UTC ${e.kind}${where}: ${e.title}${e.body ? `: ${e.body}` : ""}`;
  });
  const older = events.length - shown.length;
  return (older > 0 ? `- (${older} older events not shown)\n` : "") + lines.join("\n");
}

const STOP = new Set("the and for are but not you your with that this from have has was were will what when where which who how about into over than then them they their there these those its our out off can could would should just also very more most some any all each".split(" "));
export const words = (s: string) => new Set(s.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));

// The items a turn recalls: those sharing words with what the turn answers,
// best first, then their standing preferences and commitments the context has
// not seen since its last summary; never one recalled since then (`seen`);
// within `budget` characters. Recall is context for the model, so a short
// list it can trust beats a long one it must sift.
export function recall(items: MemoryItem[], query: string, seen: Set<string>, budget: number): MemoryItem[] {
  const q = words(query);
  const scored = items
    .filter((m) => !seen.has(m.id))
    .map((m) => {
      let hits = 0;
      for (const w of words(m.text)) if (q.has(w)) hits++;
      const standing = m.kind === "preference" || m.kind === "commitment" ? 1 : 0;
      return { m, hits, standing };
    })
    .filter((x) => x.hits > 0 || x.standing)
    .sort((a, b) => b.hits - a.hits || b.standing - a.standing || b.m.updated - a.m.updated);
  const out: MemoryItem[] = [];
  let used = 0;
  for (const { m } of scored) {
    const n = m.text.length + 24;
    if (used + n > budget) continue;
    out.push(m);
    used += n;
  }
  return out;
}

export const memoryLine = (m: MemoryItem) => `- [${m.id.slice(-6)}] (${m.kind}) ${m.text}`;
