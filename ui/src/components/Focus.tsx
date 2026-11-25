// What Focus draws around the session (lib/focus.ts): the window's left edge,
// a press on which lays the list over the page; the quiet control that leaves
// for the workbench; and one line at the bottom edge while other sessions wait
// on the owner, a press on which (or Alt A) goes to the next.
import { PanelLeft } from "lucide-react";
import { commandKeys } from "../lib/keys.ts";
import { toggleList } from "../lib/rail.ts";
import { toggleFocus, useFocus } from "../lib/focus.ts";
import { useUI } from "../lib/ui.ts";
import { goNextOther, useOthersWaiting } from "./AnswerQueue.tsx";

const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
export const othersWords = (n: number) => `${WORDS[n] ?? n} other session${n === 1 ? " needs" : "s need"} you`;

export function FocusChrome() {
  const on = useFocus();
  const here = useUI((s) => (s.route.name === "session" ? s.route.id : null));
  const over = useUI((s) => s.peek);
  const others = useOthersWaiting(on ? here : null);
  if (!on) return null;
  const list = commandKeys("sidebar"), leave = commandKeys("focus-mode"), next = commandKeys("next-waiting");
  return (
    <>
      {!over && (
        <button type="button" className="k-focus-edge" data-testid="focus-edge" aria-label={`Sessions${list ? ` (${list})` : ""}`} title={`Sessions${list ? ` (${list})` : ""}`} onClick={() => toggleList(true)} />
      )}
      <button type="button" className="k-focus-leave" data-testid="focus-leave" aria-label={`Show the workbench${leave ? ` (${leave})` : ""}`} title={`Show the workbench${leave ? ` (${leave})` : ""}`} onClick={() => toggleFocus(false)}>
        <PanelLeft aria-hidden="true" />
      </button>
      {others > 0 && (
        <button type="button" className="k-focus-line" data-testid="focus-others" title={next ? `${next} goes to the next` : undefined} onClick={goNextOther}>
          <span role="status">{othersWords(others)}</span>
        </button>
      )}
    </>
  );
}
