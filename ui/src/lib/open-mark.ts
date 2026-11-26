// How long a press on a session took to show its conversation: from the press (the route change that
// opens it, or the view that shows it by itself) to the frame after its first rows were laid out.
// Each opening is one `keel:open-text` measure in the page's performance timeline, `detail.session`
// its session: the e2e reads it (test/e2e/open-speed.spec.ts), and so can anyone at the console.
export const OPEN_TEXT = "keel:open-text";

const started = new Map<string, number>();

// The press: the route goes to this session now.
export function opening(id: string) {
  started.set(id, performance.now());
}

// A view that shows the session without a route change (a pane): its start is when it is drawn.
export function viewing(id: string) {
  if (!started.has(id)) started.set(id, performance.now());
}

// The conversation's first rows are laid out: the measure ends at the next frame's paint.
export function shown(id: string) {
  const at = started.get(id);
  if (at === undefined) return;
  started.delete(id);
  requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { performance.measure(OPEN_TEXT, { start: at, end: performance.now(), detail: { session: id } }); };
    ch.port2.postMessage(0);
  });
}
