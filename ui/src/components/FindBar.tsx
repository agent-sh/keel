// The page's own Find in a conversation (lib/find.ts says what it counts). It
// opens on the find key over the transcript, counts every place of the branch
// shown that holds the text, the part not read included, and Next and
// Previous go to each: a row not drawn is drawn, a folded step and a closed
// call open, and a part of the history the page does not hold is read
// around the place. Every match drawn is marked, the current one more.
//
// A place is reached the way a search hit is (lib/ui.ts: focusEvent and
// focusCall), so whatever draws the transcript (its parts, its rows drawn
// late or held as light boxes far from the view) draws the place's block;
// the text is then found in the drawn row and brought into view.
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { findKey, fold, placeAgain, placesOf, rangesOf, tally, unitsOf, type Outside, type Place } from "../lib/find.ts";
import { composing, isMac } from "../lib/keys.ts";
import { api, reportError } from "../lib/store.ts";
import { getUI, setUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

const ALL = "keel-find";
const NOW = "keel-find-now";
// Matches marked at most at once (a common word in a long transcript).
const MARKED = 3000;
// How long a place is waited for: a part read around it, its row drawn, its step opened.
const REACH_MS = 6000;

const highlights = () => (typeof CSS !== "undefined" && "highlights" in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : null);
const mark = (name: string, ranges: Range[]) => {
  const h = highlights();
  if (!h || typeof Highlight === "undefined") return;
  if (ranges.length) h.set(name, new Highlight(...ranges));
  else h.delete(name);
};

// The text of some elements as one string, with the node and offset each character came from.
function textOf(els: Element[]): { text: string; nodes: Text[]; starts: number[] } {
  let text = "";
  const nodes: Text[] = [], starts: number[] = [];
  for (const el of els) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      // Not what no reader sees: words for a screen reader, a button's hidden label.
      acceptNode: (n) => (n.parentElement?.closest(".sr-only, [aria-hidden='true'], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    text += "\n";
  }
  return { text, nodes, starts };
}
function rangeAt(t: ReturnType<typeof textOf>, from: number, to: number): Range | null {
  const at = (pos: number, end: boolean): [Text, number] | null => {
    let lo = 0, hi = t.nodes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t.starts[mid]! <= pos - (end ? 1 : 0)) lo = mid; else hi = mid - 1; }
    const n = t.nodes[lo];
    return n ? [n, Math.min(n.data.length, pos - t.starts[lo]!)] : null;
  };
  const a = at(from, false), b = at(to, true);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1]);
  return r;
}
function ranges(els: Element[], needle: string, most = Infinity): Range[] {
  const t = textOf(els);
  const out: Range[] = [];
  for (const [a, b] of rangesOf(t.text, needle)) {
    if (out.length >= most) break;
    const r = rangeAt(t, a, b);
    if (r) out.push(r);
  }
  return out;
}

// Drawn: on the page and not one of the light boxes a far block stands as.
const drawn = (el: Element | null | undefined): el is HTMLElement => !!el && !el.closest(".k-hold") && el.getClientRects().length > 0;
// The elements a place's text is drawn in, once they are: a prompt's or a reply's row (and what the
// reply said between calls, in its steps), or a call's card opened (not the copy a closed step shows).
function placeEls(c: HTMLElement, p: Place): HTMLElement[] | null {
  const q = CSS.escape(p.ev);
  if (p.call) {
    const card = [...c.querySelectorAll<HTMLElement>(`[data-call="${CSS.escape(p.call)}"]`)].find((x) => drawn(x) && !x.closest('[data-testid="step-peek"]'));
    // (A card that does not fold, a question's, is open as it is.)
    return card && !card.hasAttribute("data-closed") ? [card] : null;
  }
  const els = [...c.querySelectorAll<HTMLElement>(`[data-event-id="${q}"], [data-events~="${q}"] [data-testid="assistant-text"]`)].filter(drawn);
  return els.length ? els : null;
}

export type FindProps = {
  sessionId: string;
  events: readonly StoredEvent[];
  // The branch shown when it is not the session's own, and the part held: from `before` to `after`
  // (seqs; no `after`: to the branch's end). `whole`: the page holds the branch from its root.
  head?: string;
  before: number;
  after?: number;
  whole: boolean;
  content: RefObject<HTMLDivElement | null>;
  // Brings a range into the view (Transcript.tsx: the reader's own move).
  bring: (r: DOMRect) => void;
  // A request to take the keyboard (each open of the find key).
  ask: number;
  onClose: () => void;
};

export function FindBar({ sessionId, events, head, before, after, whole, content, bring, ask, onClose }: FindProps) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setNeedle(fold(q.trim())), 120);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [ask]);

  // What the daemon finds in the part not held, asked for again when the part changes.
  const [outside, setOutside] = useState<{ key: string; places: Outside[]; more: boolean; failed?: string } | null>(null);
  const key = `${sessionId} ${needle} ${head ?? ""} ${before} ${after ?? ""}`;
  const asks = !!needle && (!whole || after !== undefined);
  useEffect(() => {
    if (!asks) return;
    const ctl = new AbortController();
    const p = new URLSearchParams({ q: needle, before: String(before) });
    if (head) p.set("head", head);
    if (after !== undefined) p.set("after", String(after));
    if (whole) p.delete("before");
    api<{ places: Outside[]; more: boolean }>(`/api/sessions/${sessionId}/find?${p}`, { signal: ctl.signal })
      .then((r) => setOutside({ key, places: r.places, more: r.more }))
      // 409: a newer Find of the session (another tab's) took this one's place before it ran: no fault.
      .catch((e) => { if (e.name !== "AbortError") { if (e.status !== 409) reportError(e, { at: "find in conversation" }); setOutside({ key, places: [], more: false, failed: "Earlier messages were not searched." }); } });
    return () => ctl.abort();
  }, [key, asks]);
  const theirs = asks && outside?.key === key ? outside : null;
  const searching = asks && !theirs;

  const units = useMemo(() => unitsOf(events), [events]);
  const list = useMemo(() => (needle ? placesOf(units, theirs?.places ?? [], needle, events[0]?.seq ?? 0) : []), [units, theirs, needle, events]);
  // The current place, kept by what it is: the list changes under it as parts are read.
  const [cur, setCur] = useState<Place | null>(null);
  const at = cur ? placeAgain(list, cur) : -1;
  const now = at >= 0 ? list[at]! : null;

  // Where a place's match stands once its row is drawn and its call open: marked as the current one.
  const markNow = (p: Place): Range | null | undefined => {
    const c = content.current;
    const els = c && getUI().focusEvent === null && getUI().focusCall === null ? placeEls(c, p) : null;
    if (!els) return undefined;
    const found = ranges(els, needle);
    const r = found[Math.min(p.k, found.length - 1)] ?? null;
    mark(NOW, r ? [r] : []);
    return r ?? els[0]!.ownerDocument.createRange();
  };
  // Reaching a place: drawn and open already, or asked for as a search hit is, and waited for.
  const reach = useRef(0);
  const go = (p: Place) => {
    const token = ++reach.current;
    const c = content.current;
    if (!c) return;
    const land = () => {
      const r = markNow(p);
      if (r === undefined) return false;
      const els = placeEls(c, p)!;
      bring(r && !r.collapsed ? r.getBoundingClientRect() : els[0]!.getBoundingClientRect());
      return true;
    };
    if (land()) return;
    mark(NOW, []);
    const held = events.some((e) => e.id === p.ev);
    // (A call whose step is drawn needs only its card opened; anything else is reached as a hit is.)
    const step = held && p.call && [...c.querySelectorAll(`[data-events~="${CSS.escape(p.ev)}"]`)].some(drawn);
    setUI({ ...(step ? {} : { focusEvent: p.ev, focusStay: p.ev }), focusCall: p.call ?? null });
    const until = performance.now() + REACH_MS;
    let quiet = 0;
    const look = () => {
      if (token !== reach.current) return;
      const ok = getUI().focusEvent === null && getUI().focusCall === null && !!placeEls(c, p);
      // (Three frames after the hit is taken: the card scrolls itself into view two frames after it opens.)
      if (ok && ++quiet > 3 && land()) return;
      if (!ok) quiet = 0;
      if (performance.now() < until) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  };

  // A new text: the first place at or under the top of the view that the page holds, else the last one above it.
  useEffect(() => {
    if (!needle || !list.length) { setCur(null); return; }
    if (cur && placeAgain(list, cur) >= 0 && list[placeAgain(list, cur)]!.key === cur.key) return;
    const c = content.current;
    const top = c?.closest(".k-reading")?.getBoundingClientRect().top ?? 0;
    // (Where a place stands: its row, drawn or held as a light box; a row not on the page yet is above the view.)
    const stands = (p: Place) => c?.querySelector(`[data-event-id="${CSS.escape(p.ev)}"], [data-events~="${CSS.escape(p.ev)}"]`);
    const first = list.find((p) => { const el = p.held && stands(p); return !!el && el.getClientRects().length > 0 && el.getBoundingClientRect().bottom > top; });
    // None under it (a reader at the end): the nearest above, the newest the page holds.
    const pick = first ?? list.findLast((p) => p.held) ?? null;
    setCur(pick);
    if (pick) go(pick);
  }, [needle, list.length > 0]);

  // Every match drawn in and near the view is marked, again when the view moves or the transcript
  // changes (a row drawn, a step opened). Only the rows within a view's height of it are read: a long
  // transcript is not walked at every frame of a scroll.
  useEffect(() => {
    const c = content.current;
    const sc = c?.closest<HTMLElement>(".k-reading");
    if (!c || !sc) return;
    let raf = 0;
    const paint = () => {
      raf = 0;
      if (!now) mark(NOW, []);
      if (!needle) return mark(ALL, []);
      const box = sc.getBoundingClientRect(), h = box.height;
      const near = [...c.children].filter((row) => { const r = row.getBoundingClientRect(); return r.height > 0 && r.bottom >= box.top - h && r.top <= box.bottom + h && !row.classList.contains("k-hold"); });
      mark(ALL, ranges(near, needle, MARKED));
      if (now) markNow(now);
    };
    paint();
    const soon = () => { raf ||= requestAnimationFrame(paint); };
    const seen = new MutationObserver(soon);
    seen.observe(c, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-open", "data-closed"] });
    sc.addEventListener("scroll", soon, { passive: true });
    return () => { seen.disconnect(); sc.removeEventListener("scroll", soon); cancelAnimationFrame(raf); };
  }, [needle, now?.key, now?.k]);
  useEffect(() => () => { reach.current++; mark(ALL, []); mark(NOW, []); }, []);

  const step = (dir: 1 | -1) => {
    if (!list.length) return;
    const i = at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
    const p = list[i]!;
    setCur(p);
    go(p);
  };
  const close = () => { reach.current++; onClose(); };
  useFindOn(step);

  const total = list.length;
  const more = !!theirs?.more;
  const notHeld = list.filter((p) => !p.held).length;
  const says = !needle ? "" : searching && !total ? "Searching" : at < 0 && total ? `${total}${more ? "+" : ""} ${total === 1 ? "match" : "matches"}` : tally(at, total, more);
  const room = useRoom(content);
  return (
    <Bar input={input} q={q} setQ={setQ} says={says} none={!!needle && !total && !searching} busy={searching && total > 0} total={total} step={step} close={close}
      title={notHeld ? `${notHeld} in messages not loaded here` : theirs?.failed} label="Find in this conversation" placeholder="Find in conversation" room={room} />
  );
}

// The room right of the conversation's column, where its lines end (px, as
// measured): the bar stands there, beside the lines, when it fits, so it
// covers no line's end (transcript.css, .k-findbar).
function useRoom(content: RefObject<HTMLDivElement | null>) {
  const [room, setRoom] = useState<number>();
  useEffect(() => {
    const col = content.current, scroll = col?.parentElement, pane = scroll?.parentElement;
    if (!col || !scroll || !pane) return;
    const measure = () => {
      const end = col.getBoundingClientRect().right - parseFloat(getComputedStyle(col).paddingRight || "0");
      const right = pane.getBoundingClientRect().right - (scroll.offsetWidth - scroll.clientWidth);
      setRoom(Math.max(0, Math.floor(right - end)));
    };
    measure();
    const o = new ResizeObserver(measure);
    o.observe(col);
    o.observe(scroll);
    return () => o.disconnect();
  }, [content]);
  return room;
}

// The bar itself, the same for a conversation and for the app's page.
type BarProps = {
  input: RefObject<HTMLInputElement | null>; q: string; setQ: (q: string) => void; says: string; none: boolean; busy: boolean; total: number;
  step: (dir: 1 | -1) => void; close: () => void; title?: string; label: string; placeholder: string; page?: boolean; room?: number;
};
function Bar({ input, q, setQ, says, none, busy, total, step, close, title, label, placeholder, page, room }: BarProps) {
  return (
    <div role="search" data-testid="find-bar" data-page={page || undefined} className="k-findbar animate-pop"
      style={room === undefined ? undefined : ({ "--find-room": `${room}px` } as CSSProperties)}>
      <Search className="size-4 shrink-0 text-faint" aria-hidden="true" />
      <input
        ref={input}
        data-testid="find-input"
        aria-label={label}
        placeholder={placeholder}
        value={q}
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (composing(e)) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
          else if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
        }}
        className="k-findbar-input"
      />
      <span data-testid="find-count" aria-live="polite" className={cn("k-findbar-count", none && "text-warn")} title={title}>
        {busy && <LoaderCircle className="size-3 animate-spin" aria-label="Searching earlier messages" />}
        {says}
      </span>
      <button type="button" data-testid="find-prev" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!total} onClick={() => step(-1)} className="k-findbar-btn"><ChevronUp className="size-4" /></button>
      <button type="button" data-testid="find-next" aria-label="Next match" title="Next match (Enter)" disabled={!total} onClick={() => step(1)} className="k-findbar-btn"><ChevronDown className="size-4" /></button>
      <button type="button" data-testid="find-close" aria-label="Close Find" title="Close (Escape)" onClick={close} className="k-findbar-btn"><X className="size-4" /></button>
    </div>
  );
}

// F3 and Ctrl+G go on, as in a browser, while a bar is open.
function useFindOn(step: (dir: 1 | -1) => void) {
  const steps = useRef(step);
  steps.current = step;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const g = e.key.toLowerCase() === "g" && (e.ctrlKey || e.metaKey) && !e.altKey;
      if (e.key !== "F3" && !g) return;
      e.preventDefault();
      steps.current(e.shiftKey ? -1 : 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

// The desktop app's Find for the rest of the page. A browser tab has the browser's Find there; the
// app's web view has none, so on the find key outside a conversation (whose own bar takes it first,
// on the document) and outside a text field, this bar finds the words the page shows.
export function PageFind({ at }: { at: string }) {
  const [ask, setAsk] = useState(0);
  const from = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !findKey(e, isMac)) return;
      const t = document.activeElement as HTMLElement | null;
      if (t && (t.matches("input, textarea, select") || t.isContentEditable) && !t.closest('[data-testid="find-bar"][data-page]')) return;
      e.preventDefault();
      if (!t?.closest('[data-testid="find-bar"]')) from.current = t;
      setAsk((n) => n + 1);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setAsk(0), [at]);
  if (!ask) return null;
  const close = () => {
    setAsk(0);
    const back = from.current;
    from.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };
  return <PageBar ask={ask} onClose={close} />;
}

function PageBar({ ask, onClose }: { ask: number; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [needle, setNeedle] = useState("");
  useEffect(() => { const t = setTimeout(() => setNeedle(fold(q.trim())), 120); return () => clearTimeout(t); }, [q]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [ask]);
  const [found, setFound] = useState<Range[]>([]);
  const [at, setAt] = useState(-1);
  // The words the page shows (not the bar's own), found again when the page changes.
  useEffect(() => {
    const root = document.querySelector(".k-app") ?? document.body;
    let raf = 0;
    const read = () => {
      raf = 0;
      const list = needle ? ranges([root], needle, MARKED).filter((r) => r.getClientRects().length > 0) : [];
      setFound(list);
      mark(ALL, list);
    };
    read();
    const seen = new MutationObserver(() => { raf ||= requestAnimationFrame(read); });
    seen.observe(root, { childList: true, subtree: true, characterData: true });
    return () => { seen.disconnect(); cancelAnimationFrame(raf); };
  }, [needle]);
  useEffect(() => setAt(found.length ? 0 : -1), [needle]);
  const now = at >= 0 && at < found.length ? found[at]! : null;
  useEffect(() => {
    mark(NOW, now ? [now] : []);
    if (now) (now.startContainer.parentElement)?.scrollIntoView({ block: "center" });
  }, [now]);
  useEffect(() => () => { mark(ALL, []); mark(NOW, []); }, []);
  const step = (dir: 1 | -1) => { if (found.length) setAt((i) => (i < 0 ? (dir > 0 ? 0 : found.length - 1) : (i + dir + found.length) % found.length)); };
  useFindOn(step);
  const says = !needle ? "" : tally(Math.min(at, found.length - 1), found.length, found.length >= MARKED);
  return <Bar page input={input} q={q} setQ={setQ} says={says} none={!!needle && !found.length} busy={false} total={found.length} step={step} close={onClose} label="Find in this page" placeholder="Find in page" />;
}
