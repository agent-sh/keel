// What the cards that wait above the message box share (an approval, a
// question, a plan): when one may take the keyboard, and where the keyboard
// goes when the card is answered and leaves.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { SETTLE_MS } from "./approvals.ts";

// Focus may move to a new card only when nothing else holds it (or the
// message box is empty): never out of a field the owner is typing in, or
// out of another card.
export function mayTakeFocus(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  if (el instanceof HTMLTextAreaElement) return el.value.trim() === "" && !el.closest("[data-testid=approval]");
  return false;
}

// A card that takes the keyboard when it opens, so one key answers it:
// `target` gets the focus once the card has been on the page for the settle
// time, unless the owner is busy elsewhere. A card that has just been drawn
// takes nothing: a key on its way to the message box never lands on it.
// `ripe` says that the time has passed (its keys act from then on). When the
// card leaves while it held the keyboard, the pane's message box gets it (at
// a desk; on a phone that would raise the keyboard). An answer disables the
// card's controls and the browser then takes the focus off them: set `held`
// as the answer is sent.
export function useAskKeys(root: RefObject<HTMLElement | null>, target: RefObject<HTMLElement | null>) {
  const [ripe, setRipe] = useState(false);
  const held = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      setRipe(true);
      if (mayTakeFocus()) target.current?.focus({ preventScroll: true });
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, []);
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    if (!root.current?.contains(a) && !(held.current && (!a || a === document.body))) return;
    const box = root.current?.closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]');
    queueMicrotask(() => {
      const now = document.activeElement;
      if ((!now || now === document.body || !now.isConnected) && matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
    });
  }, []);
  return { ripe, held };
}
