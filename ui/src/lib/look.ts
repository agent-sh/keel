// How this page is drawn, told to the daemon on its socket (src/core/look.ts, op "look"): the view it shows,
// its text size, its theme, its window size and what draws it. Said as each socket opens and when one of
// these changes (a resize when it has settled), so a change's pictures can be taken as the owner sees the
// page. Only the main window says it: a session or a panel in a window of its own is not the owner's layout.
import type { Look } from "../../../src/core/look.ts";
import { shell, soloWindow } from "./shell.ts";
import { sayOnOpen, sayOnSocket } from "./store.ts";
import { getUI, lookShown, onUI, phone } from "./ui.ts";

const SETTLE_MS = 1000; // a resize is told once the window has kept its size this long

// The theme the page's own choice gives (a picture that switches the root's class for a moment is not it).
const darkMedia = typeof matchMedia === "undefined" ? undefined : matchMedia("(prefers-color-scheme: dark)");
function now(): Look {
  const ui = getUI();
  const dark = ui.theme === "dark" || (ui.theme === "system" && !!darkMedia?.matches);
  const engine = shell?.engine === "webkit" || shell?.engine === "qt" ? shell.engine : "browser";
  return { view: ui.workbench ? "workbench" : "focus", scale: ui.scale, theme: dark ? "dark" : "light", width: innerWidth, height: innerHeight, engine, phone: phone() };
}

if (!soloWindow && typeof window !== "undefined") {
  let told = "";
  const tell = (always = false) => {
    if (lookShown) return undefined;
    const look = now();
    const text = JSON.stringify(look);
    if (!always && text === told) return undefined;
    told = text;
    return { op: "look", look };
  };
  sayOnOpen(() => tell(true));
  const changed = () => { const m = tell(); if (m && !sayOnSocket(m)) told = ""; };
  onUI(changed);
  darkMedia?.addEventListener("change", changed);
  let settle: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => { clearTimeout(settle); settle = setTimeout(changed, SETTLE_MS); });
}
