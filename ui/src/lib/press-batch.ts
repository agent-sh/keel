// What the page keeps of the owner's presses before it sends them: a name
// for the control, the view, the session in view and the time. Never a word
// typed and never a value (src/admin/presses.ts is the other end and says what
// the daemon keeps). Pure: the clock, the sender and the timer are given, so
// the batching is tested without a page.

// Presses are sent together, this often while there are any; a page at rest has no timer.
export const FLUSH_MS = 5000;
// At most this many in one batch, and this many waiting (the oldest are dropped past it).
export const BATCH_MAX = 100;
export const QUEUE_MAX = 400;
// A control drawn is told to the daemon once, and again after this long so it stays "seen in the last 30 days".
export const SEEN_AGAIN_MS = 6 * 3_600_000;

// A control's name from the page's source, or null when it has none fit to keep. The digits that
// name a thing (a session's id, a row's number) are taken out: "session-row-01a1fb6f" is "session-row-*".
export function nameOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = raw.trim()
    .replace(/[0-9a-f]{8,}(-[0-9a-f]{4,})*/gi, "*")
    .replace(/\d{2,}/g, "*")
    .replace(/\*(?:[-_.:/]?\*)+/g, "*")
    .slice(0, 64);
  return /^[A-Za-z][A-Za-z0-9_.:/*-]{0,63}$/.test(n) ? n : null;
}

export type Pressed = { c: string; v: string; s?: string; t: number };
export type Drawn = { c: string; v: string };
export type Body = { surface: "page" | "desktop" | "phone"; presses: Pressed[]; seen: Drawn[] };
export type Send = (b: Body, last: boolean) => Promise<{ record: boolean } | void>;

export class Batcher {
  private queue: Pressed[] = [];
  private drawn: Drawn[] = [];
  private sent = new Map<string, number>();
  private stop: (() => void) | undefined;
  private busy = false;
  recording = true;
  // `every`: a repeating call (the page's one clock), `surface`: where this page runs.
  constructor(private send: Send, private every: (ms: number, f: () => void) => () => void, private surface: () => Body["surface"], private now = Date.now) {}

  get waiting() { return this.queue.length + this.drawn.length; }

  press(c: string, v: string, s?: string) {
    if (!this.recording) return;
    this.queue.push({ c, v, ...(s ? { s } : {}), t: this.now() });
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX);
    this.arm();
  }

  // A control the page drew: told once per SEEN_AGAIN_MS.
  see(c: string, v: string) {
    if (!this.recording) return;
    const k = `${c}\n${v}`, at = this.now();
    if (at - (this.sent.get(k) ?? -Infinity) < SEEN_AGAIN_MS) return;
    this.sent.set(k, at);
    this.drawn.push({ c, v });
    this.arm();
  }

  private arm() {
    this.stop ??= this.every(FLUSH_MS, () => void this.flush());
  }

  // Sends what waits (a batch at a time). `last`: the page is going away, send what is left now.
  async flush(last = false) {
    if (this.busy && !last) return;
    if (!this.waiting) { this.stop?.(); this.stop = undefined; return; }
    this.busy = true;
    const presses = this.queue.splice(0, BATCH_MAX);
    const seen = this.drawn.splice(0, 4 * BATCH_MAX);
    try {
      const r = await this.send({ surface: this.surface(), presses, seen }, last);
      if (r && r.record === false) { this.recording = false; this.queue = []; this.drawn = []; }
    } catch {
      // Not sent: put back in front, within the bound.
      this.queue = [...presses, ...this.queue].slice(-QUEUE_MAX);
      this.drawn = [...seen, ...this.drawn].slice(0, 4 * QUEUE_MAX);
    } finally {
      this.busy = false;
    }
    if (!this.waiting) { this.stop?.(); this.stop = undefined; }
  }
}
