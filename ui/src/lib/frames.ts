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
//     pointer elsewhere and no Tab just before, it goes back to what had it.
//
// What a page can know of a press inside a frame is where the pointer is: the
// press itself is the frame's. So a frame under a resting pointer can still
// take the focus by script.
//
// A frame is one of content when it carries `data-content-frame`.
const TAB_MS = 400;

// What a focus that entered `frame` is: the owner's (true) or the frame's own asking.
export function ownersFocus(frame: { matches(sel: string): boolean }, sinceTab: number): boolean {
  return frame.matches(":hover") || sinceTab < TAB_MS;
}
// Whether a frame the owner has been in is closed to the keyboard now.
export function closed(at: { focused: boolean; pointerOver: boolean; sinceTab: number }): boolean {
  return !at.focused && !at.pointerOver && at.sinceTab >= TAB_MS;
}

if (typeof document !== "undefined") {
  let held: HTMLElement | null = null; // what had the keyboard in the page last
  let tabbed = -Infinity;
  let px = -1, py = -1; // where the pointer last was, as the page saw it
  const entered = new Set<HTMLIFrameElement>(); // the frames the owner has been in
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
    if (ownersFocus(at, performance.now() - tabbed)) return void entered.add(at);
    // (Once the change of focus is through: a focus set while it is under way is not kept.)
    window.focus();
    if (held?.isConnected) held.focus({ preventScroll: true });
    else at.blur();
  };
  document.addEventListener("focusin", (e) => {
    if (e.target instanceof HTMLElement && !content(e.target)) held = e.target;
    settle(); // the owner is in the page again: a frame they left is closed
  }, true);
  document.addEventListener("pointermove", (e) => { px = e.clientX; py = e.clientY; if (entered.size) settle(); }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    tabbed = performance.now();
    settle();
    setTimeout(settle, TAB_MS + 20);
  }, true);
  // The focus going into a frame is the page's window losing it.
  addEventListener("blur", () => setTimeout(check, 0));
}
