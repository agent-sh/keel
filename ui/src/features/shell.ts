// The page's side of the desktop shell (ui/src/lib/shell.ts, desktop/).
// Imported once from main.tsx; in a browser tab it does nothing.
//   - The shell's title bar takes the page's colors and text size.
//   - A path the shell asks for (a keel:// link, a notification's click, the
//     tray) is shown without a reload, so a draft is never lost to it.
//   - A session can be opened in a window of its own.
import { AppWindow } from "lucide-react";
import { createElement } from "react";
import { focusApproval } from "../lib/automation.ts";
import { registerCommand } from "../lib/keys.ts";
import { hexOf, pathParts, shell, soloWindow } from "../lib/shell.ts";
import { reconnectNow } from "../lib/store.ts";
import { getUI, setUI } from "../lib/ui.ts";

const host = shell;
if (host) {
  const root = document.documentElement;

  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  let last = "";
  const tell = () => {
    const css = getComputedStyle(root);
    const color = (name: string) => hexOf(css.getPropertyValue(name), ctx);
    const look = { t: "look", dark: root.classList.contains("dark"), bg: color("--bg"), panel: color("--panel"), fg: color("--fg"), muted: color("--muted"), line: color("--line"), need: color("--st-need"), scale: Number(css.getPropertyValue("--ui-scale")) || 1 };
    const text = JSON.stringify(look);
    if (text !== last) host.post(look);
    last = text;
  };
  // The theme and the text size change the root element; the colors settle a frame or two later.
  const later = () => requestAnimationFrame(() => requestAnimationFrame(tell));
  new MutationObserver(later).observe(root, { attributes: true, attributeFilter: ["class", "style"] });
  later();

  addEventListener("keel-shell", (e) => {
    const detail = (e as CustomEvent<{ open?: string; daemon?: string }>).detail;
    // The shell saw the daemon come back: the page joins it now, not when its own wait ends.
    if (detail?.daemon === "up") reconnectNow();
    const open = detail?.open;
    if (typeof open !== "string") return;
    const { pathname, event, approval, inbox } = pathParts(open);
    if (event) setUI({ focusEvent: event });
    if (pathname !== location.pathname) {
      history.pushState(null, "", pathname);
      dispatchEvent(new PopStateEvent("popstate"));
    }
    if (approval && getUI().route.name === "session") focusApproval(approval);
    if (inbox) dispatchEvent(new Event("keel-open-inbox"));
  });

  if (soloWindow) setUI({ sidebar: false });

  registerCommand({
    id: "shell-window", label: "Open in its own window", group: "View", icon: createElement(AppWindow, { className: "size-4" }), words: "desktop window separate detach pop out",
    when: () => !soloWindow && getUI().route.name === "session",
    run: () => { const r = getUI().route; if (r.name === "session") host.post({ t: "window", path: `/s/${encodeURIComponent(r.id)}` }); },
  });
}
