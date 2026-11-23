// Frames of content: a page a session wrote (an artifact), a port a session
// serves (the preview). What runs in them is not Keel's. Such a frame gets
// the keyboard only by the owner's own act: a press with the pointer over it,
// or Tab into it. A frame the owner once clicked in can ask for the focus
// again from its own script, later and as often as it likes; the keyboard
// would then leave the message box for the frame, and what the owner types or
// pastes next would land there. So:
//   - a frame the owner was in and left is closed to the keyboard (inert)
//     until they come back to it: the pointer over it, or Tab. Its script's
//     asking does nothing meanwhile;
//   - and should the focus enter a content frame all the same, with the
//     pointer elsewhere and no Tab just before, it goes back to what had it;
//   - a frame that takes it that way while the owner is at work in the page
//     (a press or a key there within the last seconds), or a second time at
//     all, is stopped: what the owner types or pastes between its asking and
//     the page's answer would be the frame's. The page takes it away and says
//     so in its place, with a button that shows it again
//     (components/ContentFrame.tsx).
//
// Where the engine can refuse a frame the focus it was not given, it does:
// the frame carries the permissions policy `focus-without-user-activation
// 'none'` (FRAME_ALLOW), which the desktop app's Chromium honours. That
// covers a frame the owner has not pressed in. One they pressed in a moment
// ago may still ask and be given under Chromium, in the app and in a tab: the
// guard above is what gives the keyboard back and stops that frame.
//
// The paste keys are the one thing that must not wait for that answer: what
// is on the clipboard would be the frame's. In the app's Chromium window the
// app takes them from the engine and hands them to the page (`pasteTarget`
// below, lib/paste-key.ts): a paste goes where the owner is, never to a frame
// that took the keyboard by itself.
//
// What a page can know of a press inside a frame is where the pointer is: the
// press itself is the frame's. So a frame under a resting pointer can still
// take the focus by script.
//
// A frame is one of content when it carries `data-content-frame`.
const TAB_MS = 400;
// A content frame's `allow`: no focus without the owner's own act in it.
export const FRAME_ALLOW = "focus-without-user-activation 'none'";
// How often a frame may take the keyboard unasked before it is stopped, when the owner is
// not at work in the page.
export const TAKES = 2;
// For how long after the owner's press or key in the page itself they are at work there: a
// frame that takes the keyboard in that time is stopped at once.
export const AT_WORK_MS = 5000;
// Told on a frame that was stopped (the component that draws it takes it away).
export const STOPPED = "keel-frame-stopped";
// Whether a frame that took the keyboard unasked is stopped: `times` it did so, and
// `sinceOwner` ms after the owner's last press or key in the page itself.
export const stops = (times: number, sinceOwner = Infinity): boolean => times >= TAKES || sinceOwner < AT_WORK_MS;

// What a focus that entered `frame` is: the owner's (true) or the frame's own asking.
export function ownersFocus(frame: { matches(sel: string): boolean }, sinceTab: number): boolean {
  return frame.matches(":hover") || sinceTab < TAB_MS;
}
// Whether a frame the owner has been in is closed to the keyboard now.
export function closed(at: { focused: boolean; pointerOver: boolean; sinceTab: number }): boolean {
  return !at.focused && !at.pointerOver && at.sinceTab >= TAB_MS;
}

// Where a paste the owner keyed goes (set below, where the page's own state is).
let pasteTargetNow: () => HTMLElement | "frame" | null = () => null;
export const pasteTarget = (): HTMLElement | "frame" | null => pasteTargetNow();

if (typeof document !== "undefined") {
  let held: HTMLElement | null = null; // what had the keyboard in the page last
  let owned: HTMLIFrameElement | null = null; // the frame that has the keyboard by the owner's own act
  let tabbed = -Infinity;
  let worked = -Infinity; // the owner's last press or key in the page itself
  let px = -1, py = -1; // where the pointer last was, as the page saw it
  const entered = new Set<HTMLIFrameElement>(); // the frames the owner has been in
  const took = new WeakMap<HTMLIFrameElement, number>(); // how often a frame took the keyboard unasked
  const content = (el: Element | null): el is HTMLIFrameElement => el instanceof HTMLIFrameElement && el.hasAttribute("data-content-frame");
  const over = (f: HTMLIFrameElement) => { const r = f.getBoundingClientRect(); return px >= r.left && px < r.right && py >= r.top && py < r.bottom; };
  const settle = () => {
    for (const f of entered) {
      if (!f.isConnected) { entered.delete(f); continue; }
      const shut = closed({ focused: document.activeElement === f, pointerOver: over(f), sinceTab: performance.now() - tabbed });
      if (f.inert !== shut) f.inert = shut;
    }
  };
  // The focus entered a frame: the owner's own act, or the frame's asking.
  const check = () => {
    const at = document.activeElement;
    if (!content(at)) return;
    if (owned === at) return;
    if (ownersFocus(at, performance.now() - tabbed)) { owned = at; return void entered.add(at); }
    // (Once the change of focus is through: a focus set while it is under way is not kept.)
    window.focus();
    if (held?.isConnected) held.focus({ preventScroll: true });
    else at.blur();
    const times = (took.get(at) ?? 0) + 1;
    took.set(at, times);
    if (!stops(times, performance.now() - worked)) return;
    at.dispatchEvent(new CustomEvent(STOPPED));
    // Once it is off the page the keyboard is where it was before the frame took it: the frame
    // may have taken it once more on its way out.
    let tries = 0;
    const back = () => {
      if (at.isConnected && ++tries < 30) return void requestAnimationFrame(back);
      if (at.isConnected || content(document.activeElement)) return;
      window.focus();
      if (held?.isConnected) held.focus({ preventScroll: true });
    };
    requestAnimationFrame(back);
  };
  document.addEventListener("focusin", (e) => {
    if (e.target instanceof HTMLElement && !content(e.target)) { held = e.target; owned = null; }
    settle(); // the owner is in the page again: a frame they left is closed
  }, true);
  document.addEventListener("pointermove", (e) => { px = e.clientX; py = e.clientY; if (entered.size) settle(); }, true);
  // (A press or a key the page sees is one outside every frame: a frame's own are the frame's.)
  document.addEventListener("pointerdown", () => { worked = performance.now(); }, true);
  document.addEventListener("keydown", (e) => {
    worked = performance.now();
    if (e.key !== "Tab") return;
    tabbed = performance.now();
    settle();
    setTimeout(settle, TAB_MS + 20);
  }, true);
  // The focus going into a frame is the page's window losing it.
  addEventListener("blur", () => setTimeout(check, 0));
  // Where a paste the owner keyed goes, decided now (not when the page next looks): a frame of
  // content when the keyboard is there by the owner's own act; else the element of the page
  // that has the keyboard, after a frame that took it by itself was answered.
  pasteTargetNow = () => {
    worked = performance.now();
    check();
    const at = document.activeElement;
    if (content(at)) return "frame";
    return at instanceof HTMLElement ? at : null;
  };
}
