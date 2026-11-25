// The hooks that hold a press until it is safe, shared by the approval cards and the cards of the
// start page and the blocked list. They stand apart from the cards (ApprovalCard.tsx) so a page
// that shows none of those draws no card code.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { READ_MS, settled, SETTLE_MS, stand, type Stand } from "./approvals.ts";
import { every } from "./clock.ts";
import { tipSay } from "./tips.ts";

// When a press is judged. A pointer's press is judged as it goes down: the
// press itself can move the control before the button comes up (taking the
// focus brings its card into view), and that move is the press's own. A press
// with no pointer (the keyboard, a program) is judged as it is made. `ok` says
// whether a judgement lets the press through: one that does not takes no
// keyboard either (`onMouseDown`), so a row that slid under the pointer is
// not left holding it.
export function usePress<T>(judge: () => T, ok: (said: T) => boolean) {
  const down = useRef<{ said: T } | null>(null);
  return {
    onPointerDown: () => { down.current = { said: judge() }; },
    onMouseDown: (e: { preventDefault: () => void }) => { if (down.current && !ok(down.current.said)) e.preventDefault(); },
    said: (e: { detail: number }): T => {
      const was = e.detail > 0 ? down.current : null;
      down.current = null;
      return was ? was.said : judge();
    },
  };
}

// A press that was refused is never kept for later, and never dropped with no
// sign: the control is marked for the settle time (`mark`, and it moves once),
// and the reason is said once for a screen reader (`line`).
export function useNudge() {
  const [why, setWhy] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    mark: why ? true : undefined,
    line: <span className="sr-only" role="status" data-testid="approval-refused">{why}</span>,
    // `at`: the control that was pressed. The words stand at it for as long as the ring, for those who see.
    refuse: (reason: string, at?: Element | null) => {
      window.clearTimeout(timer.current);
      setWhy(reason);
      if (at) tipSay(at, reason, SETTLE_MS);
      timer.current = window.setTimeout(() => setWhy(""), SETTLE_MS);
    },
  };
}

// A control outside the lists of requests that is held like an answer: it acts once it has stood
// whole in the window, unmoved, for the settle time, so not as it appears and not as something
// moves it under the hand. `ready` is for how it is drawn; `now` judges at the instant of a press.
export function useStood(ref: RefObject<HTMLElement | null>) {
  const at = useRef<Stand | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const now = useCallback(() => {
    const el = ref.current, t = performance.now();
    if (!el || document.visibilityState !== "visible") { at.current = undefined; return false; }
    const r = el.getBoundingClientRect();
    at.current = stand(at.current, { x: r.left, y: r.top, whole: r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }, t);
    return settled(at.current, t);
  }, [ref]);
  useEffect(() => {
    setReady(now());
    return every(READ_MS, () => setReady(now()));
  }, [now]);
  return { ready, now };
}
