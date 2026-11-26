// The page's own Find (components/FindBar.tsx) on the find key, for a view of a conversation (the
// full stream, the Conversation lens): the browser's reaches only what is drawn, and this one every
// place of the branch shown, folded, not drawn or not read yet. The key is the conversation's in its
// pane (the pane with the keys; with the keys in no pane, the one at the helm or the only one) from
// anywhere but a text field: in the message box it is the conversation's too, and any other field
// (a terminal's, a panel's, a menu's) keeps its own.
import { useEffect, useRef, useState, type RefObject } from "react";
import { findKey } from "./find.ts";
import { isMac } from "./keys.ts";
import { focusBox } from "./utils.ts";

// `ask`: a request to take the keyboard (each press; 0 while closed). `close` gives the keyboard back.
export function useFindAsk(scroller: RefObject<HTMLElement | null>, sessionId: string): { ask: number; close: () => void } {
  const [ask, setAsk] = useState(0);
  const from = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !findKey(e, isMac)) return;
      const mine = scroller.current?.closest("[data-station]");
      const t = document.activeElement as HTMLElement | null;
      const at = t?.closest("[data-station]");
      if (at ? at !== mine : !!mine && !mine.hasAttribute("data-helm")) return;
      const field = !!t && (t.matches("input, textarea, select") || t.isContentEditable);
      if (field && !t.matches('[data-testid="composer"], [data-testid="find-input"]')) return;
      if (!scroller.current?.offsetParent) return; // not shown (a view under another)
      e.preventDefault();
      if (!t?.closest('[data-testid="find-bar"]')) from.current = t;
      setAsk((n) => n + 1);
    };
    // (On the document: it is asked before the page's Find of the desktop app, on the window, at any order of mounting.)
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setAsk(0), [sessionId]);
  const close = () => {
    setAsk(0);
    const back = from.current;
    from.current = null;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    else focusBox(sessionId);
  };
  return { ask, close };
}
