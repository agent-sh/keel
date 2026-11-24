import { MessageSquareQuote, Quote, Send, ListPlus } from "lucide-react";
import { createPortal } from "react-dom";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { boxOf, commentMessage, tighten, whereOf } from "../lib/quote.ts";
import { QUEUE_KEYS, composing, isMac, keyLabel, registerCommand } from "../lib/keys.ts";
import { Kbd } from "./Kbd.tsx";
import { popupClass } from "./ui.tsx";

// Words selected in the conversation (a reply, a tool's output, a diff hunk, the board) offer two
// things: Quote puts them in the message box as a quote block; Comment takes one line and sends
// "On <where>:", the quote and the line as the owner's message now (Enter sends, and steers a turn
// that works; the queue key queues it). It is an ordinary message of the owner's: the cache prefix
// of the history is what a typed one would have made. Keys: Alt+Q quotes, Alt+C comments.
const TOUCH = matchMedia("(hover: none) and (pointer: coarse)");
const KEYS = { quote: "alt+q", comment: "alt+c" } as const;
// What takes Escape for itself while it has the focus.
const OWNS_ESCAPE = 'input, textarea, select, [contenteditable], [role="dialog"], [role="listbox"], [role="menu"], [role="combobox"]';

// `ends`: where the words begin and end on the screen (their first and last line).
type Ends = { first: DOMRect; last: DOMRect };
type Pick = { text: string; where: string; range: Range; ends: Ends };
// The bar that holds a selection now, for the keys.
let active: { ask: (kind: "quote" | "comment") => void } | null = null;
registerCommand(
  { id: "selection.quote", label: "Quote the selection in the message box", group: "Selection", where: "with a selection", keys: KEYS.quote, when: () => !!active, run: () => active?.ask("quote") },
  { id: "selection.comment", label: "Comment on the selection", group: "Selection", where: "with a selection", keys: KEYS.comment, when: () => !!active, run: () => active?.ask("comment") },
);

const endsOf = (r: Range): Ends => {
  const list = [...r.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
  const all = r.getBoundingClientRect();
  return { first: list[0] ?? all, last: list[list.length - 1] ?? all };
};

export const SelectionBar = memo(function SelectionBar({ sid, root, working }: { sid: string; root: { current: HTMLElement | null }; working: boolean }) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const commenting = comment !== null;
  const now = useRef({ pick, commenting });
  now.current = { pick, commenting };

  const close = () => { setPick(null); setComment(null); };
  const quote = () => { if (pick) { boxOf(sid)?.quote(pick.text); getSelection()?.removeAllRanges(); close(); } };
  const send = (queue: boolean) => {
    const words = comment?.trim();
    if (!pick || !words) return;
    boxOf(sid)?.say(commentMessage(pick.where, pick.text, words), queue);
    getSelection()?.removeAllRanges();
    close();
  };

  // The selection, read when it settles: not while a button of the mouse is down on the page.
  useEffect(() => {
    let down = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (down) return;
      const s = getSelection();
      const el = root.current;
      // The comment box keeps what it was opened on: the focus in its field moved the selection there.
      if (now.current.commenting) return;
      let range = s && !s.isCollapsed && s.rangeCount ? s.getRangeAt(0) : null;
      let at = range && (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement);
      // (Only a selection of the conversation is cut back to its words: the page's other selections are left as they are.)
      if (range && at && el?.contains(at) && !at.closest(".k-compose, input, textarea, [contenteditable], [data-selbar]")) {
        const tight = tighten(range);
        if (tight && tight !== range) { s!.removeAllRanges(); s!.addRange(tight); range = tight; at = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement; }
        else if (!tight) range = null;
      }
      const text = range ? (s?.toString() ?? "") : "";
      const where = range && at && el?.contains(at) && !at.closest(".k-compose, input, textarea, [contenteditable], [data-selbar]") && text.trim() ? whereOf(range) : null;
      if (!range || !where) return setPick((p) => (p ? null : p));
      const copy = range.cloneRange();
      const ends = endsOf(copy);
      setPick((p) => (p && p.text === text && p.where === where && p.ends.first.top === ends.first.top && p.ends.first.left === ends.first.left && p.ends.last.bottom === ends.last.bottom ? p : { text, where, range: copy, ends }));
    };
    const later = () => { clearTimeout(timer); timer = setTimeout(read, 150); };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") down = true;
      if (now.current.commenting && !(e.target instanceof Element && e.target.closest("[data-selbar]"))) { setComment(null); setPick(null); }
    };
    const onUp = () => { if (down) { down = false; later(); } };
    document.addEventListener("selectionchange", later);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", later);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
    };
  }, []);

  // Escape puts the offer away and leaves the words selected as they are (and does not stop the turn).
  // A field, a menu or a dialog that has the focus keeps its own Escape (a picker opened over the page closes).
  useEffect(() => {
    if (!pick || commenting) return;
    const f = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || composing(e)) return;
      if (e.target instanceof Element && e.target.closest(OWNS_ESCAPE)) return;
      e.preventDefault(); e.stopPropagation(); setPick(null);
    };
    addEventListener("keydown", f, true);
    return () => removeEventListener("keydown", f, true);
  }, [!pick, commenting]);
  // The keys act on the bar that holds a selection.
  useEffect(() => {
    if (!pick) return;
    const me = { ask: (kind: "quote" | "comment") => (kind === "quote" ? quote() : setComment((c) => c ?? "")) };
    active = me;
    return () => { if (active === me) active = null; };
  });
  useEffect(() => { if (commenting) field.current?.focus({ preventScroll: true }); }, [commenting]);
  // The focus in the comment box takes the selection's mark away: the words stay marked by a highlight of their own.
  useEffect(() => {
    if (!commenting || !pick || typeof Highlight === "undefined") return;
    CSS.highlights.set("keel-quote", new Highlight(pick.range));
    return () => void CSS.highlights.delete("keel-quote");
  }, [commenting, pick?.range]);

  // Placed above the first line of the words, or under the last one when there is no room above (on a phone
  // or a narrow window: under them first, the system's own bar is above). Never over the words themselves.
  const place = () => {
    const el = bar.current;
    if (!el || !pick) return;
    // (The range is followed while its words are there; the rectangles read at the start when they are not.)
    const { first, last } = pick.range.collapsed ? pick.ends : endsOf(pick.range);
    const em = parseFloat(getComputedStyle(el).fontSize) || 16;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 0.5 * em;
    const roomAbove = first.top - h - gap >= gap, roomBelow = last.bottom + h + 2 * gap <= innerHeight;
    const above = !TOUCH.matches && innerWidth >= 768 ? roomAbove || !roomBelow : roomAbove && !roomBelow;
    const at = above ? first : last;
    const left = Math.min(Math.max(at.left + at.width / 2 - w / 2, gap), innerWidth - w - gap);
    const top = above ? first.top - h - gap : last.bottom + gap;
    el.style.left = `${left}px`;
    el.style.top = `${Math.min(Math.max(top, gap), Math.max(innerHeight - h - gap, gap))}px`;
  };
  useLayoutEffect(place, [pick, commenting, working]);
  useEffect(() => {
    if (!pick) return;
    let frame = 0;
    const on = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
    addEventListener("scroll", on, true);
    addEventListener("resize", on);
    return () => { cancelAnimationFrame(frame); removeEventListener("scroll", on, true); removeEventListener("resize", on); };
  }, [pick]);

  if (!pick) return null;
  // (A press on a button must not take the selection away from the words it is about.)
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  return createPortal(
    <div ref={bar} data-selbar="" data-testid="selection-bar" data-mode={commenting ? "comment" : "pick"} role="toolbar" aria-label="Selected words"
      className={`${popupClass} fixed z-50 flex items-center gap-1 p-1 animate-appear ${commenting ? "w-[min(26rem,calc(100vw-1rem))]" : ""}`}>
      {commenting ? (
        <>
          <input ref={field} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="selection-comment" aria-label="Comment on the selection"
            placeholder={`Comment on ${pick.where}`} className="k-field k-field-sm min-w-0 flex-1"
            onKeyDown={(e) => {
              if (composing(e)) return;
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
              const mod = isMac ? e.metaKey : e.ctrlKey;
              if (e.key !== "Enter" || e.altKey || (e.shiftKey && !mod)) return;
              e.preventDefault();
              send(e.shiftKey);
            }} />
          {working && <button type="button" data-testid="selection-queue" className="k-btn" data-quiet="" disabled={!comment.trim()} onPointerDown={keep} onClick={() => send(true)} title={`Queue for after this turn (${keyLabel(QUEUE_KEYS).join(" ")})`}><ListPlus className="size-3.5" />Queue</button>}
          <button type="button" data-testid="selection-send" className="k-btn" data-ink="" disabled={!comment.trim()} onPointerDown={keep} onClick={() => send(false)} title={working ? "Joins the running turn at its next step (Enter)" : "Send (Enter)"}><Send className="size-3.5" />{working ? "Send now" : "Send"}</button>
        </>
      ) : (
        <>
          <button type="button" data-testid="selection-quote" className="k-btn" data-quiet="" onPointerDown={keep} onClick={quote}><Quote className="size-3.5" />Quote<Kbd keys={KEYS.quote} /></button>
          <button type="button" data-testid="selection-comment-open" className="k-btn" data-quiet="" onPointerDown={keep} onClick={() => setComment("")}><MessageSquareQuote className="size-3.5" />Comment<Kbd keys={KEYS.comment} /></button>
        </>
      )}
    </div>,
    document.body,
  );
});
