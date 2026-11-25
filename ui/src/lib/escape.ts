// What Escape closes before it stops anything. Pressed in the message box while a turn
// works, Escape goes to the topmost thing the owner has open: a popup (a menu, a popover,
// a dialog), then the side panel of the pane, and only with nothing open does it stop the
// turn (or leave an agent's session, or a look). Claude Code and Codex order it the same
// way: Escape closes a dialog or popup first and interrupts the task only when none is up.
//
// A popup closes itself on the same key (its own listener), so the box leaves it be; a panel
// is closed here. Either way the next press is the double press the settle time holds
// (lib/looks.ts menuClosed): it stops nothing and says how.
import { modalOpen } from "./overlay.ts";

// An open popup: a modal's backdrop, the trigger a popup marks while it is open, a dialog or a menu, a
// list of choices in a portal. (A listbox in the page itself is page content, not a popup.)
const POPUP = '[data-popup-open], [role="dialog"], [role="alertdialog"], [role="menu"], [data-base-ui-portal] [role="listbox"]';
const shown = (el: Element) => !el.closest("[hidden], [inert]") && el.getClientRects().length > 0;

export type Over = "popup" | "panel" | null;

// What lies over the conversation of the pane `box` is in, topmost first.
export function overBox(box: Element | null | undefined, root: ParentNode = document): Over {
  if (modalOpen() || [...root.querySelectorAll(POPUP)].some(shown)) return "popup";
  // The pane's panel stands beside its conversation, or lies over it as a sheet.
  const side = box?.closest(".k-session")?.parentElement?.querySelector(":scope > .k-side");
  return side ? "panel" : null;
}
