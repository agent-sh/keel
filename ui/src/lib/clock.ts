// One clock for what the page does on a beat: a time that counts on screen
// ("12s", "in 3m"), the word that the owner is here. It runs only while
// something asked for it and the page is visible: a page at rest has no timer
// of its own, and a hidden page has none at all. Everything on the same beat
// shares one timer; when the page is seen again every beat fires once at
// once, so what it shows is right before the next beat.
type Beat = { subs: Set<() => void>; timer?: ReturnType<typeof setInterval> };
const beats = new Map<number, Beat>();
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";

function sync(ms: number, b: Beat) {
  const run = b.subs.size > 0 && visible();
  if (run && b.timer === undefined) b.timer = setInterval(() => { for (const f of [...b.subs]) f(); }, ms);
  else if (!run && b.timer !== undefined) { clearInterval(b.timer); b.timer = undefined; }
  if (!b.subs.size) beats.delete(ms);
}

// Calls `f` every `ms` while the page is visible. Returns what stops it.
export function every(ms: number, f: () => void): () => void {
  const b = beats.get(ms) ?? { subs: new Set() };
  beats.set(ms, b);
  b.subs.add(f);
  sync(ms, b);
  return () => { b.subs.delete(f); sync(ms, b); };
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const [ms, b] of [...beats]) {
      sync(ms, b);
      if (visible()) for (const f of [...b.subs]) f();
    }
  });
}

// How often a time that counts from `at` (or down to it) changes what it says:
// every second while it says seconds (under a minute), a few times a minute after.
export const beatOf = (at: number | undefined, now = Date.now()) => (at === undefined || Math.abs(now - at) < 60_000 ? 1000 : 15_000);
