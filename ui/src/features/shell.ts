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
import { pasteKey } from "../lib/paste-key.ts";
import { broughtHere, hexOf, pathParts, shell, shellSaving, soloWindow, type ShellTold } from "../lib/shell.ts";
import { reconnectNow } from "../lib/store.ts";
import { getUI, setScale, setUI, stepScale } from "../lib/ui.ts";

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

  // The app opened this page: on a launch, a link or its tray. Nobody chose where the keyboard is.
  broughtHere();
  // A card that already has the keyboard on an answer gives it to its list of requests.
  const offAnswers = () => {
    const at = document.activeElement as HTMLElement | null;
    const card = at?.closest<HTMLElement>("[data-approval-id]");
    if (card && (at?.dataset.testid === "allow-once" || at?.dataset.testid === "allow-always")) focusApproval(card.dataset.approvalId!, "card");
  };

  // What this page does with the app, said as it loads: it pastes where the owner is when the
  // app hands it the paste keys, and announces a file before it offers one. An app that hears
  // neither (a page from before them) leaves both to the engine, by its own rule.
  host.post({ t: "can", paste: true, saving: !!host.can.saving });
  // A file the page offers (a link that keeps one): announced to the app first, then offered.
  // In the app a file is kept only when this page announced its address at the owner's press.
  if (host.can.saving) addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[download]") : null;
    if (!a || a.dataset.keelSave || e.defaultPrevented) return;
    e.preventDefault();
    void shellSaving(a.href).then((answer) => {
      if (answer && !answer.ok) return;
      const again = document.createElement("a");
      again.href = a.href;
      again.download = a.download;
      again.dataset.keelSave = "1";
      again.hidden = true;
      document.body.append(again);
      again.click();
      again.remove();
    });
  }, true);

  addEventListener("keel-shell", (e) => {
    const detail = (e as CustomEvent<ShellTold>).detail;
    // The app saw the daemon come back: the page joins it now, not when its own wait ends.
    if (detail?.daemon === "up") { setUI({ shellAway: false }); reconnectNow(); }
    if (detail?.daemon === "away") setUI({ shellAway: true });
    // The page's own process ended (a crash, or more memory than the app gives a page) and the
    // app loaded the page again: said once, so a window that blinked is not a mystery.
    if (detail?.reloaded === "stopped") setUI({ shellNote: "This window stopped and was loaded again. It may have run out of memory. Your sessions went on in Keel." });
    // The paste keys, which the app took from the engine: the paste goes where the owner is.
    if (detail?.paste) void pasteKey();
    // The text size keys every desktop app has: one scale, the page's own setting.
    if (detail?.scale === "reset") setScale(1);
    else if (detail?.scale) stepScale(detail.scale === "up" ? 1 : -1);
    const open = detail?.open;
    if (typeof open !== "string") return;
    const { pathname, event, approval, inbox } = pathParts(open);
    // Only the click on a request's own notification may land on its answer.
    const chosen = detail?.from === "click";
    if (!chosen) { broughtHere(); offAnswers(); }
    if (event) setUI({ focusEvent: event });
    if (pathname !== location.pathname) {
      history.pushState(null, "", pathname);
      dispatchEvent(new PopStateEvent("popstate"));
    }
    if (approval && getUI().route.name === "session") focusApproval(approval, chosen ? "allow" : "card");
    if (inbox) dispatchEvent(new Event("keel-open-inbox"));
  });

  if (soloWindow) setUI({ sidebar: false });

  registerCommand({
    id: "shell-window", label: "Open in its own window", group: "View", icon: createElement(AppWindow, { className: "size-4" }), words: "desktop window separate detach pop out",
    when: () => !soloWindow && getUI().route.name === "session",
    run: () => { const r = getUI().route; if (r.name === "session") host.post({ t: "window", path: `/s/${encodeURIComponent(r.id)}` }); },
  });
}
