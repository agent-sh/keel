// How long a press on a session took to show its conversation: from the press (the route change that
// opens it, or the view that shows it by itself) to the frame after its first rows were laid out.
// Each opening is one `keel:open-text` measure in the page's performance timeline, `detail.session`
// its session: the e2e reads it (test/e2e/open-speed.spec.ts), and so can anyone at the console.
// It is also told to whoever listens (lib/presses.ts sends it to the daemon's record, which
// Settings > Telemetry reads back as p50 and p95): its time, the session's events, whether the page
// held its text at the press (warm) or read it (cold), and the view that drew it.
export const OPEN_TEXT = "keel:open-text";

export type Shown = { session: string; ms: number; events: number; cold: boolean; view: "lens" | "stream" };
// What the page holds of a session: its text (for cold or warm) and its newest event's seq (its size).
type Hold = { held: (id: string) => boolean; events: (id: string) => number };
let hold: Hold = { held: () => false, events: () => 0 };
let told: ((s: Shown) => void) | undefined;
export function onShown(h: Hold, f: (s: Shown) => void) { hold = h; told = f; }

const started = new Map<string, { at: number; cold: boolean }>();
const start = (id: string) => started.set(id, { at: performance.now(), cold: !hold.held(id) });

// The press: the route goes to this session now.
export function opening(id: string) {
  start(id);
}

// A view that shows the session without a route change (a pane): its start is when it is drawn.
export function viewing(id: string) {
  if (!started.has(id)) start(id);
}

// The conversation's first rows are laid out: the measure ends at the next frame's paint.
export function shown(id: string, view: "lens" | "stream" = "stream") {
  const s = started.get(id);
  if (s === undefined) return;
  started.delete(id);
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      const m = performance.measure(OPEN_TEXT, { start: s.at, end: performance.now(), detail: { session: id } });
      // (A page that was hidden meanwhile paints when it shows again: that wait is not the open's.)
      if (document.visibilityState === "visible") told?.({ session: id, ms: m.duration, events: hold.events(id), cold: s.cold, view });
    };
    ch.port2.postMessage(0);
  });
}
