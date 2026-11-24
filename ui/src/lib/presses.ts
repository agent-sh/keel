// What the owner presses, kept on this machine (src/admin/presses.ts is the
// other end, Settings > Telemetry reads it back). One capture listener on the
// page notes a press on a control: a button, a link, a menu item, a tab, a
// switch. The control is named by `data-press`, else by the `data-testid` it
// already carries; a control with neither is not recorded. What is kept is
// that name, the view, the session in view and the time: never a word typed,
// never a value, and a text field's click is no press. The desktop app and a
// phone are this same page, so they are recorded the same way, the surface
// said apart. The batches go every few seconds while there is anything to
// send, on the page's one clock; when the page is hidden what is left goes at
// once. The page also tells which controls it drew (in the view, a moment
// after it changes and after a press), so "never pressed" has something to be
// measured against.
import { every } from "./clock.ts";
import { Batcher, nameOf, type Body } from "./press-batch.ts";
import { keyRan } from "./keys.ts";
import { shell } from "./shell.ts";
import { getUI, onUI, phone } from "./ui.ts";

const CONTROL = "button, a[href], summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=radio], [role=switch], [role=checkbox], [role=option], input[type=checkbox], input[type=radio], input[type=button], input[type=submit]";
const SCAN_MAX = 500;

export const viewOf = (): string => {
  const r = getUI().route;
  return r.name === "settings" ? `settings/${r.section}` : r.name;
};
const sessionOf = (): string | undefined => {
  const r = getUI().route;
  return r.name === "session" ? r.id : undefined;
};

// A control's name: its own `data-press`, else its `data-testid`.
export const controlName = (el: Element): string | null => {
  const h = el as HTMLElement;
  return nameOf(h.dataset?.press ?? h.dataset?.testid);
};

const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute("aria-disabled") === "true";

async function send(b: Body, last: boolean): Promise<{ record: boolean } | void> {
  const r = await fetch("/api/presses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b), keepalive: last });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export const batcher = new Batcher(send, every, () => (shell ? "desktop" : phone() ? "phone" : "page"));

// A press that is not a click: a command run by its key. Named `key:<command>`.
export const notePress = (name: string) => {
  const n = nameOf(name);
  if (n) batcher.press(n, viewOf(), sessionOf());
};

// The owner turned recording off or on (Settings > Telemetry).
export const setRecording = (on: boolean) => { batcher.recording = on; };

let scanTimer: ReturnType<typeof setTimeout> | undefined;
// Tells the daemon which controls are drawn now, a moment after something changed.
function scanSoon() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    if (!batcher.recording || document.visibilityState !== "visible") return;
    const v = viewOf();
    let n = 0;
    for (const el of document.querySelectorAll(CONTROL)) {
      if (++n > SCAN_MAX) break;
      const name = controlName(el);
      if (name && el.getClientRects().length) batcher.see(name, v);
    }
  }, 1500);
}

let installed = false;
export function installPresses() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", (e) => {
    const t = e.target as Element | null;
    const el = t?.closest?.(CONTROL);
    if (!el || disabled(el)) return;
    const name = controlName(el);
    if (name) batcher.press(name, viewOf(), sessionOf());
    scanSoon();
  }, { capture: true, passive: true });
  let at = viewOf();
  onUI(() => { const v = viewOf(); if (v !== at) { at = v; scanSoon(); } });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void batcher.flush(true); else scanSoon(); });
  addEventListener("pagehide", () => void batcher.flush(true));
  keyRan.add((id) => notePress(`key:${id}`));
  scanSoon();
}
