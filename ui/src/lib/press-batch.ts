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
// While recording is off, a page asks this often whether it is on again, with a batch that holds
// nothing, so a tab that was open when the owner turned it back on resumes with no reload.
export const ASK_MS = 30_000;
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

// The session a control acts on when it is not the one in view: a row of the list, or the menu of a row, says so with
// `data-press-on`. Its id, never its title; anything that is not shaped like an id is dropped.
export const ON_ID = /^[A-Za-z0-9-]{8,64}$/;
export function actsOn(el: { closest(selector: string): { getAttribute(name: string): string | null } | null }): string | undefined {
  const id = el.closest("[data-press-on]")?.getAttribute("data-press-on");
  return id && ON_ID.test(id) ? id : undefined;
}

export type Pressed = { c: string; v: string; s?: string; t: number };
export type Drawn = { c: string; v: string };
// A session opened: ms from the press to its text's paint, its events (n), whether the page held its text, the view.
export type Opened = { ms: number; n: number; cold: boolean; v: "lens" | "stream"; t: number };
export type Body = { surface: "page" | "desktop" | "phone"; presses: Pressed[]; seen: Drawn[]; opens?: Opened[] };
// What a page needs to tell of a control to know it is drawn: a hidden or disabled one is not.
export type Control = { disabled?: boolean; getAttribute(name: string): string | null; getClientRects(): { length: number } };
export const isDrawn = (el: Control): boolean => el.disabled !== true && el.getAttribute("aria-disabled") !== "true" && el.getClientRects().length > 0;

export type Send = (b: Body, last: boolean) => Promise<{ record: boolean } | void>;

export class Batcher {
  private queue: Pressed[] = [];
  private drawn: Drawn[] = [];
  private opened: Opened[] = [];
  private sent = new Map<string, number>();
  private stop: (() => void) | undefined;
  private busy = false;
  private asking: (() => void) | undefined;
  private on = true;
  // `every`: a repeating call (the page's one clock), `surface`: where this page runs.
  constructor(private send: Send, private every: (ms: number, f: () => void) => () => void, private surface: () => Body["surface"], private now = Date.now) {}

  get recording() { return this.on; }
  // Off: what waits is dropped and the page asks on a slow beat whether it is on again.
  set recording(v: boolean) {
    this.on = v;
    if (v) { this.asking?.(); this.asking = undefined; return; }
    this.queue = []; this.drawn = []; this.opened = [];
    this.stop?.(); this.stop = undefined;
    this.asking ??= this.every(ASK_MS, () => void this.ask());
  }

  // An empty batch: the daemon's answer says whether it records.
  async ask() {
    try {
      const r = await this.send({ surface: this.surface(), presses: [], seen: [] }, false);
      if (r && r.record !== false) this.recording = true;
    } catch { /* asked again on the next beat */ }
  }

  get waiting() { return this.queue.length + this.drawn.length + this.opened.length; }

  // A session's text was painted after its press (lib/open-mark.ts).
  open(o: Omit<Opened, "t">) {
    if (!this.recording) return;
    this.opened.push({ ...o, t: this.now() });
    if (this.opened.length > QUEUE_MAX) this.opened.splice(0, this.opened.length - QUEUE_MAX);
    this.arm();
  }

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
    const opens = this.opened.splice(0, BATCH_MAX);
    try {
      const r = await this.send({ surface: this.surface(), presses, seen, ...(opens.length ? { opens } : {}) }, last);
      if (r && r.record === false) this.recording = false;
    } catch {
      // Not sent: put back in front, within the bound.
      this.queue = [...presses, ...this.queue].slice(-QUEUE_MAX);
      this.drawn = [...seen, ...this.drawn].slice(0, 4 * QUEUE_MAX);
      this.opened = [...opens, ...this.opened].slice(-QUEUE_MAX);
    } finally {
      this.busy = false;
    }
    if (!this.waiting) { this.stop?.(); this.stop = undefined; }
  }
}
