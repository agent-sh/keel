// Whether something lies over the page. A modal dialog or menu (the palette,
// the shortcut sheet, the inbox, the errors, a confirmation, a menu, an open
// select) puts a backdrop of its own under itself that takes every press
// outside it: that backdrop is what is read here, from the moment the popup
// opens to the moment it starts to close. A popover that leaves the page in
// use beside it has none. A panel lying over a conversation makes that pane
// inert, and the session list laid over the panes has a scrim. While any of
// them covers a thing, no command key acts on it, the keyboard is not moved
// into it by code, and nothing in it is answered.
const BACKDROP = '[role="presentation"][data-base-ui-inert]:not([inert])';
const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

// The element is inside a popup (a dialog, a menu, a list of choices), not in the page under it.
export const inPopup = (el: Element | null | undefined): boolean => !!el?.closest(POPUP);
// A portal can stay mounted under a hidden ancestor after it closes.
export const popupShown = (el: Element): boolean => !el.closest("[hidden], [inert]") && el.getClientRects().length > 0;
// A modal dialog or menu is open over the page.
export const modalOpen = (): boolean => [...document.querySelectorAll<HTMLElement>(BACKDROP)].some((el) => el.style.position === "fixed");
// Something lies over `el` (over the page, when none is given). What is inside a popup is not under it.
export const overlayOver = (el?: Element | null): boolean => {
  if (el?.closest(POPUP)) return false;
  if (modalOpen() || el?.closest("[inert]")) return true;
  // The scrim is in the page whenever the list is wanted; it is drawn only while the list lies over the panes.
  const scrim = document.querySelector(".k-scrim");
  return !!scrim && getComputedStyle(scrim).display !== "none" && !el?.closest(".k-rail-wrap");
};
