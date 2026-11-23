import { runsAt, type Where } from "../lib/runs-at.ts";
import { Popover } from "@base-ui/react/popover";
import { Check, CheckCheck, ChevronDown, FilePen, Globe, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { shownInPart } from "../../../src/safety/summary.ts";
import { batches, batchName, coverName, hold, keyPressable, KEY_MS, nextAction, paintedReader, pressable, readOnSteps, READ_MS, sawLines, settled, SETTLE_MS, spentAction, stand, unseenLines, type Action, type Batch, type Hold, type Lines, type PaintedReader, type Stand } from "../lib/approvals.ts";
import { arrivalOf, arriving } from "../lib/automation.ts";
import { wasBrought } from "../lib/shell.ts";
import { editBody, type EditBody } from "../lib/edit-body.ts";
import { hasHidden, hasRtl, lookAlikes, spellHidden } from "../lib/hidden-chars.ts";
import { dropRepeats, keyedTo, keyRefused, keyTried, keysArrived, mayTake, noteAnswer, owned, pageFocus, pressKeysSettled, sequenceAt, takeKeys, typeToBox, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { modalOpen } from "../lib/overlay.ts";
import { safety, useSafety, type Approval, type Suggest } from "../lib/safety.ts";
import { failed, reportError } from "../lib/store.ts";
import { tipSay } from "../lib/tips.ts";
import { cn } from "../lib/utils.ts";
import { BlockedCards } from "./BlockedCards.tsx";
import { Spelled } from "./Spelled.tsx";
import { trayGauge } from "./Composer.tsx";
import { SecretCards } from "./SecretCards.tsx";
import { TrustCards } from "./TrustCards.tsx";
import { PlanCards } from "./PlanCard.tsx";

const TITLE: Record<Approval["kind"], string> = {
  shell: "Run this command?",
  edit: "Change these files?",
  other: "Use this tool?",
  read: "Read this?",
  drive: "Drive a session?",
  send: "Send to this address?",
  refused: "Refused",
};
const ICON = { shell: SquareTerminal, edit: FilePen, other: Wrench, read: Wrench, drive: MessageSquareShare, send: Globe, refused: X };
const EMPTY: Approval[] = [];

// What the list knows of its cards from where they stand on screen.
// - `read`: the request's text has stood whole on screen for the settle time.
// - `live`: its Allow once may be pressed (lib/approvals.ts: pressable). `grant`: the same for its Always allow.
// - `ripe`: the card has been on the page for the settle time (it may take the keyboard).
// - `cut`: its text is longer than the box that shows it.
// - `unseen`: the rows of its text, as it wraps now, that have not been in view (`n`, of `total`),
//   and how many of those the owner has to bring into view (`out`: lib/approvals.ts, sawLines).
//   A card is answered when none is left. `long`: the text is over three times the region's height.
//   `tall`: the card is taller than the region (it cannot be seen whole, so it is scrolled through).
// - `acts`: each "allow all" action, by tool: what it covers and whether it can be pressed.
type Unseen = { n: number; out: number; begun: boolean; total: number; long: boolean; tall: boolean };
// - `keyLive`, `keyUnseen`: the same for a key press (lib/approvals.ts, KEY_MS): its Allow once stood
//   whole and still that long, and the lines of its text not yet in view for that long.
type View = { read: Set<string>; live: Set<string>; grant: Set<string>; ripe: Set<string>; cut: Set<string>; unseen: Map<string, Unseen>; acts: Map<string, Action>; keyLive: Set<string>; keyUnseen: Map<string, number>; key: string };
const NO_VIEW: View = { read: new Set(), live: new Set(), grant: new Set(), ripe: new Set(), cut: new Set(), unseen: new Map(), acts: new Map(), keyLive: new Set(), keyUnseen: new Map(), key: "" };
// The text a card shows of a request (its summary and, for an edit, what the edit writes:
// `body`), and what in it a reader could miss, read once for each request:
// - `hidden`: characters that do not show as written (they are spelled out and marked);
// - `alike`: letters that are not plain ASCII and can pass for plain ones (they are named);
// - `rtl`: letters written right to left (each run stands by itself, in the order written).
// A text with any of them is `flagged`: it is answered on its own, and its Allow never takes
// the keyboard by the page's own doing.
type Shown = { body: EditBody | null; text: string; hidden: number; alike: ReturnType<typeof lookAlikes>; rtl: boolean; flagged: boolean };
const shownCache = new WeakMap<Approval, Shown>();
function shownOf(a: Approval): Shown {
  let s = shownCache.get(a);
  if (!s) {
    const body = a.kind === "edit" ? editBody(a.input) : null;
    const text = body ? `${a.summary}\n${body.lines.map((l) => l.text).join("\n")}` : a.summary;
    const hidden = spellHidden(text).filter((p) => p.hidden).length, alike = lookAlikes(text), rtl = hasRtl(text);
    shownCache.set(a, (s = { body, text, hidden, alike, rtl, flagged: hidden > 0 || alike.length > 0 || rtl }));
  }
  return s;
}
// A card whose text is to be opened before it is answered: the daemon shows only its start, it
// holds a character that had to be spelled out, or it is longer than its box and not yet read
// there. `whole`: the owner opened it.
const mustBeOpened = (a: Approval, whole: boolean, cut: boolean, unseen: Unseen | undefined) =>
  !whole && (shownInPart(a) || shownOf(a).hidden > 0 || (cut && (!unseen || unseen.n > 0)));
type Reading = { born: number; sum?: Stand; once?: Hold; always?: Hold; cut: boolean; width: number };
type Clip = { top: number; bottom: number; left: number; right: number };

// The frame a list's cards show in: the window as it is now (less where an
// on-screen keyboard covers it), inside the region above the message box, and
// under the list's own bar where that stays at the region's top while the list
// is scrolled. `text` is where words can be read: less the edge that fades where
// more is scrolled out of view. `inList` gives a point's place in the list
// whatever the region is scrolled to; `sig` changes when the region's own
// frame or the length of what it holds does; `top` is how far it is scrolled.
function frameOf(list: HTMLElement) {
  const vv = window.visualViewport;
  const shown: Clip = vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height, left: vv.offsetLeft, right: vv.offsetLeft + vv.width } : { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  const tray = list.closest<HTMLElement>('[data-testid="composer-tray"]');
  if (!tray) return { shown, text: shown, sig: "", top: 0, inList: (r: DOMRect) => ({ x: r.left, y: r.top }) };
  const r = tray.getBoundingClientRect();
  shown.top = Math.max(shown.top, r.top);
  shown.bottom = Math.min(shown.bottom, r.bottom);
  const bar = list.hasAttribute("data-bar-stays") ? list.querySelector<HTMLElement>(":scope > .k-ask-bar") : null;
  if (bar) shown.top = Math.max(shown.top, bar.getBoundingClientRect().bottom);
  const fade = 1.25 * parseFloat(getComputedStyle(document.documentElement).fontSize); // the tray's fade (styles.css)
  const text = { ...shown };
  if (!bar && tray.scrollTop > 1) text.top = Math.max(text.top, r.top + fade);
  if (tray.scrollHeight - tray.scrollTop - tray.clientHeight > 1) text.bottom = Math.min(text.bottom, r.bottom - fade);
  const top = tray.scrollTop;
  return {
    shown, text, top,
    sig: [r.top, r.bottom, r.left, r.right, tray.scrollHeight].map(Math.round).join(),
    inList: (at: DOMRect) => ({ x: at.left - r.left, y: at.top - r.top + top }),
  };
}
// A layer on its way out (a closing sheet, its backdrop) takes no press, so no point hits it (styles.css),
// but it still lies over what is under it until it is gone: nothing under it is in view yet.
function underLeaving(el: Element, x: number, y: number): boolean {
  for (const g of document.querySelectorAll<HTMLElement>("[data-ending-style]")) {
    if (g.contains(el)) continue;
    const q = g.getBoundingClientRect();
    if (x >= q.left && x <= q.right && y >= q.top && y <= q.bottom) return true;
  }
  return false;
}
// Where an element is, and whether all of it shows: inside the clip and, for text that is
// to be read or pressed (`open`), with nothing lying over its middle. (A pointer cannot
// press a control something lies over, but a key can: such a control does not act.)
function seenAt(el: HTMLElement, c: Clip, open = false) {
  const r = el.getBoundingClientRect();
  let whole = r.width > 0 && r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
  if (whole && open) {
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    whole = !!top && el.contains(top);
    if (whole && underLeaving(el, x, y)) whole = false;
  }
  return { r, at: { x: r.left, y: r.top, whole } };
}

// The frame a card's text can be read in: the list's, less what the card's own answers lie over
// while they stay in view for a card taller than its room (they stand at the region's foot, over
// the text that goes on under them).
function clipUnder(pre: HTMLElement, foot: HTMLElement | null, c: Clip): Clip {
  if (!foot) return c;
  const r = pre.getBoundingClientRect(), a = foot.getBoundingClientRect();
  if (a.height <= 0 || a.left >= r.right - 1 || a.right <= r.left + 1 || a.bottom <= r.top + 1 || a.top >= r.bottom - 1) return c;
  return a.top > r.top + 1 ? { ...c, bottom: Math.min(c.bottom, a.top) } : { ...c, top: Math.max(c.top, a.bottom) };
}

// What shows of a request's text in the frame where words can be read: the text's lines in all
// (as it wraps now), a line's height, and the rows in view in the text's own coordinates. Nothing
// shows of a text that is cut at a side, or that something lies over.
function rowsInView(pre: HTMLElement, c: Clip): { total: number; line: number; view: [number, number] | null } {
  const r = pre.getBoundingClientRect(), cs = getComputedStyle(pre);
  const line = parseFloat(cs.lineHeight) || 1.2 * parseFloat(cs.fontSize) || 16;
  const padTop = parseFloat(cs.paddingTop) || 0, padBottom = parseFloat(cs.paddingBottom) || 0;
  const total = Math.max(1, Math.round((pre.scrollHeight - padTop - padBottom) / line));
  const top = Math.max(c.top, r.top), bottom = Math.min(c.bottom, r.bottom);
  if (!(r.width > 0) || r.left < c.left - 0.5 || r.right > c.right + 0.5 || bottom <= top) return { total, line, view: null };
  const over = document.elementFromPoint(r.left + r.width / 2, (top + bottom) / 2);
  if (!over || !pre.contains(over) || underLeaving(pre, r.left + r.width / 2, (top + bottom) / 2)) return { total, line, view: null };
  const y = (v: number) => v - r.top - pre.clientTop + pre.scrollTop - padTop;
  return { total, line, view: [y(top), y(bottom)] };
}

// Reads where the list's cards stand: when the region scrolls, when it or the
// window changes size, when the list changes, and ten times a second for what
// none of those tell (a move with no event, a hold that runs out). Only a
// reading that changes what is shown draws again. `tick` reads now: every
// answer asks it as it is pressed, so a control that moved since the last
// reading does not act.
function useReadings(list: RefObject<HTMLDivElement | null>, cards: Approval[]) {
  const [view, setView] = useState(NO_VIEW);
  const st = useRef({
    cards, seen: new Map<string, Reading>(), lines: new Map<string, Lines>(), quick: new Map<string, Lines>(), tall: new Set<string>(), acts: new Map<string, Action>(), hot: new Set<string>(), spent: new Set<string>(), view: NO_VIEW,
    reader: null as PaintedReader | null, // takes the readings after a paint (lib/approvals.ts)
    sig: "",          // the region's frame at the last reading
    top: 0,           // how far it was scrolled then, and at the last timed reading
    timedTop: 0,
    scrolling: false, // it is being scrolled (until the scroll ends, or a timed reading finds it where it was)
    input: false,     // the owner's hand is behind that scroll: a wheel, a finger, a key or the scroll bar came first
    inputAt: 0,       // when the hand was last felt
  });
  // A request the action answered may still be listed for a moment (its frame is on its way): it no longer waits.
  for (const id of st.current.spent) if (!cards.some((a) => a.id === id)) st.current.spent.delete(id);
  const waiting = cards.filter((a) => !st.current.spent.has(a.id));
  st.current.cards = waiting;
  // `painted`: taken by the painted reader (lib/approvals.ts), after the frame that drew it.
  const tick = useCallback((why?: "timer" | "scrollend", painted = false): View => {
    const s = st.current, root = list.current, now = performance.now();
    const seen: typeof s.seen = new Map();
    // A hidden page, or a pane something covers, shows nothing: every time starts again.
    const f = root && document.visibilityState === "visible" && !root.closest("[inert]") ? frameOf(root) : null;
    const listChanged = (f?.sig ?? "") !== s.sig;
    s.sig = f?.sig ?? "";
    if (f) {
      if (f.top !== s.top) s.scrolling = true;
      if (why === "scrollend" || (why === "timer" && f.top === s.timedTop)) {
        s.scrolling = false;
        // The hand is forgotten when the region rests, but not one felt this instant: its scroll has yet to begin.
        if (now - s.inputAt > READ_MS) s.input = false;
      }
      if (why === "timer") s.timedTop = f.top;
      s.top = f.top;
      for (const el of root!.querySelectorAll<HTMLElement>(':scope > [data-testid="approval"]')) {
        const id = el.dataset.approvalId!, was = s.seen.get(id);
        const part = (testid: string) => el.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
        const sum = part("approval-summary");
        const control = (c: HTMLElement | null, prev?: Hold) => {
          if (!c) return undefined;
          const at = seenAt(c, f.shown, true);
          return hold(prev, at.at, f.inList(at.r), s.input, listChanged, now);
        };
        // A card's foot (its answers) stays in the region's view while the card is being read and is
        // taller than its room: from when its text goes on under the region's foot, until the card's
        // own end comes into view. Not for a card that fits the region (a row coming into view keeps
        // its answers where they are in it), not where the text is all in view and only the answers
        // are below (the keyboard brings those in, and nothing lies over a line), and not in a region
        // too short to give the foot a third of itself. What the foot lies over is not text in view.
        const foot = el.querySelector<HTMLElement>(":scope > .k-ask-foot"), box = el.getBoundingClientRect(), under = foot?.getBoundingClientRect(), words = sum?.getBoundingClientRect();
        const room = f.shown.bottom - f.shown.top;
        if (box.height > room) s.tall.add(id); else s.tall.delete(id);
        const tall = !!under && under.height > 0 && box.height > room && under.height * 3 <= room && box.bottom > f.shown.bottom + 1 && box.top < f.shown.bottom;
        el.toggleAttribute("data-foot", tall && (el.hasAttribute("data-foot") || (!!words && words.bottom > f.shown.bottom + 1 && words.top < f.shown.bottom)));
        const text = sum ? clipUnder(sum, foot, f.text) : f.text;
        // The view moved by the owner's own scroll when their hand came first and nothing in the list changed.
        if (sum) {
          const rows = { ...rowsInView(sum, text), painted }, own = s.input && !listChanged;
          s.lines.set(id, sawLines(s.lines.get(id), rows, own, now));
          s.quick.set(id, sawLines(s.quick.get(id), rows, own, now, KEY_MS));
        }
        seen.set(id, {
          born: was?.born ?? now,
          sum: sum ? stand(was?.sum, seenAt(sum, text, true).at, now) : undefined,
          once: control(part("allow-once"), was?.once),
          always: control(part("allow-always"), was?.always),
          // Once cut, cut while the card keeps its width: the card says so with lines of its own, which can
          // give the text the width it fits in, and a cut read again from that would draw the card one way,
          // then the other, every reading (and no answer on the list would ever stand still long enough to
          // count). A card whose own width changed (its pane widened or narrowed) is read again.
          cut: !!sum && ((!!was?.cut && was.width === el.offsetWidth) || sum.scrollHeight > sum.clientHeight + 1),
          width: el.offsetWidth,
        });
      }
    }
    s.seen = seen;
    // What was read of a text is kept while its request waits, also over a time the page was hidden
    // (where nothing shows and nothing more is read).
    for (const kept of [s.lines, s.quick]) for (const [id, l] of kept) {
      if (!s.cards.some((c) => c.id === id)) kept.delete(id);
      else if (!f) kept.set(id, { ...l, view: null, since: now });
    }
    const keyLive = new Set<string>(), keyUnseen = new Map<string, number>();
    for (const [id, l] of s.quick) keyUnseen.set(id, unseenLines(l).n);
    const read = new Set<string>(), live = new Set<string>(), grant = new Set<string>(), ripe = new Set<string>(), cut = new Set<string>(), unseen = new Map<string, Unseen>();
    const room = f ? f.shown.bottom - f.shown.top : 0;
    for (const [id, l] of s.lines) unseen.set(id, { ...unseenLines(l), total: l.total, long: room > 0 && l.total * l.line > 3 * room, tall: s.tall.has(id) });
    for (const [id, r] of seen) {
      const old = now - r.born >= SETTLE_MS;
      if (settled(r.sum, now)) read.add(id);
      if (pressable(r.once, old, s.scrolling, now)) live.add(id);
      if (now - r.born >= KEY_MS && keyPressable(r.once, s.scrolling, now)) keyLive.add(id);
      if (pressable(r.always, old, s.scrolling, now)) grant.add(id);
      if (old) ripe.add(id);
      if (r.cut) cut.add(id);
    }
    const acts = new Map<string, Action>();
    const open = new Set(s.cards.filter((a) => a.state === "pending").map((a) => a.id));
    // A text that is flagged (marked characters, look-alike letters, letters written right to left)
    // is read and answered on its own, as one cut by its box is.
    const alone = new Set([...cut, ...s.cards.filter((c) => shownOf(c).flagged).map((c) => c.id)]);
    for (const g of batches(s.cards, read, alone)) acts.set(g.tool, nextAction(s.acts.get(g.tool), g.ids, s.hot.has(g.tool), now, open));
    s.acts = acts;
    const key = JSON.stringify([[...read], [...live], [...grant], [...ripe], [...cut], [...keyLive], [...keyUnseen], [...unseen].map(([id, u]) => [id, u.n, u.out, u.begun, u.total, u.long, u.tall]), [...acts].map(([tool, a]) => [tool, a.covered, a.live])]);
    if (key !== s.view.key) setView((s.view = { read, live, grant, ripe, cut, unseen, acts, keyLive, keyUnseen, key }));
    return s.view;
  }, [list]);
  const any = cards.length > 0;
  useEffect(() => {
    const root = list.current;
    if (!any || !root) return;
    const tray = root.closest<HTMLElement>('[data-testid="composer-tray"]');
    // Every move is read at once (for the answers' places) and again once it was painted (for the lines seen).
    const reader = (st.current.reader = paintedReader(() => [...(tray ? [tray] : []), ...root.querySelectorAll('[data-testid="approval-summary"]')], () => tick(undefined, true)));
    const read = () => { tick(); reader.ask(); };
    const ended = () => { tick("scrollend"); };
    // What comes before a scroll the owner makes: a wheel, a key, a finger put down on the
    // list, or a press on the region itself (its scroll bar).
    const hand = (e: Event) => {
      if (e.type === "pointerdown" && e.target !== tray && (e as PointerEvent).pointerType !== "touch") return;
      st.current.input = true;
      st.current.inputAt = performance.now();
    };
    const hands = ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"];
    const timer = window.setInterval(() => tick("timer"), READ_MS);
    const sized = new ResizeObserver(read);
    sized.observe(root);
    // A text scrolled inside its own box (a long one, not opened) is read as it moves too.
    root.addEventListener("scroll", read, { capture: true, passive: true });
    if (tray) {
      sized.observe(trayGauge(tray)!);
      tray.addEventListener("scroll", read, { passive: true });
      tray.addEventListener("scrollend", ended);
      for (const h of hands) tray.addEventListener(h, hand, { capture: true, passive: true });
    }
    addEventListener("resize", read);
    visualViewport?.addEventListener("resize", read);
    visualViewport?.addEventListener("scroll", read);
    // Read as the page hides, so the time away counts for nothing.
    document.addEventListener("visibilitychange", read);
    return () => {
      reader.stop();
      st.current.reader = null;
      window.clearInterval(timer);
      sized.disconnect();
      root.removeEventListener("scroll", read, { capture: true });
      if (tray) {
        tray.removeEventListener("scroll", read);
        tray.removeEventListener("scrollend", ended);
        for (const h of hands) tray.removeEventListener(h, hand, { capture: true });
      }
      removeEventListener("resize", read);
      visualViewport?.removeEventListener("resize", read);
      visualViewport?.removeEventListener("scroll", read);
      document.removeEventListener("visibilitychange", read);
    };
  }, [any, tick, list]);
  // Before the first paint of a changed list: which texts are cut is known at once.
  useLayoutEffect(() => { tick(); }, [cards, tick]);
  return {
    view,
    tick,
    waiting,
    setHot: (tool: string, on: boolean) => { if (on) st.current.hot.add(tool); else st.current.hot.delete(tool); tick(); },
    // The owner's key moves the region (End, Space): read as their own scroll, step by step.
    own: () => { st.current.input = true; st.current.inputAt = performance.now(); },
    // The reader that takes the readings after a paint, and the newest reading (not the drawn one).
    reader: () => st.current.reader,
    latest: () => st.current.view,
    // The action answered these: they wait no more, and it starts again from what is ready, after a beat.
    spend: (tool: string, ids: string[]) => {
      for (const id of ids) st.current.spent.add(id);
      st.current.acts.set(tool, spentAction(performance.now()));
      tick();
    },
  };
}

// The open approval cards of a session, docked above the composer. The turn
// waits until each is answered. `asker` names whose cards these are when a
// parent page shows its agents' cards.
//
// Several at once are a list: each a row with its own answers, and over them
// what waits and one action per tool that allows that tool's requests
// together. What the action may cover is decided in lib/approvals.ts from
// where the rows stand: only requests of this list (an agent's have a list
// and an action of their own under its name), low risk, whose text is whole
// on screen and has stood still for a second. It names how many those are,
// and pointing at it frames exactly those rows. A row's own Allow acts under
// the same rule: not within a second of arriving or of moving under the hand.
// `where`: the folder (and branch) the asker works in, when that is not the folder of the page the
// cards are answered on: an agent's own worktree. Each card says it.
export function Approvals({ sessionId, asker, where }: { sessionId: string; asker?: string; where?: Where }) {
  const cards = useSafety((s) => s.approvals[sessionId] ?? EMPTY);
  const list = useRef<HTMLDivElement>(null);
  const { view, tick, waiting, setHot, spend, own, reader, latest } = useReadings(list, cards);
  // A reading on by keys under way (End, Space): one at a time, and a press meanwhile joins it.
  const steps = useRef<{ on: boolean; more: number; end: boolean; at: number }>({ on: false, more: 0, end: false, at: 0 });
  // How the list holds the keyboard (lib/asks.ts): said on it for the page and its tests.
  const hold = useHold(list);
  const groups = batches(waiting, view.read, new Set([...view.cut, ...waiting.filter((c) => shownOf(c).flagged).map((c) => c.id)]));
  const [hot, setHotTools] = useState<string[]>([]); // the tools whose action the pointer or the keyboard is on
  const [at, setAt] = useState<{ on: "once" | "all" | "row" | "card" | "list"; id?: string } | null>(null); // where the keyboard is in the list (`card`: on a card itself)
  // The cards the owner opened to their whole text, by the list's Enter or a card's own control.
  const [opened, setOpened] = useState<Record<string, true>>({});
  const shut = waiting.filter((a) => mustBeOpened(a, !!opened[a.id], view.cut.has(a.id), view.unseen.get(a.id)));
  const setWhole = (id: string, on: boolean) => setOpened((o) => { const { [id]: _was, ...rest } = o; return on ? { ...rest, [id]: true } : rest; });
  const [sending, setSending] = useState<string[]>([]); // the ids an action is answering
  const [note, setNote] = useState("");
  const many = cards.length > 1;
  const uniform = many && cards.every((a) => a.tool === cards[0]!.tool);
  const open = (ids: string[]) => ids.filter((id) => waiting.some((a) => a.id === id));
  const covered = (tool: string) => open(view.acts.get(tool)?.covered ?? []);
  // The rows an action covers are framed while the pointer or the keyboard is on it. A finger
  // has neither before it lands: where one is used, the rows of every action that can be
  // pressed are framed all the time.
  const byFinger = useMedia("(pointer: coarse), (max-width: 40rem)");
  const touch = useMedia("(pointer: coarse)"); // what a card says of a key is said of a tap there
  const marked = new Set((byFinger ? groups.map((g) => g.tool).filter((t) => view.acts.get(t)?.live) : hot).flatMap(covered));
  const dull = groups.find((g) => hot.includes(g.tool) && !view.acts.get(g.tool)?.live);

  // One request to the daemon with the ids the action named when it was
  // pressed: a card that arrives meanwhile is not among them, and the daemon
  // refuses the list whole if it names a card that is answered alone.
  // The bar stays at the region's top while its list is scrolled, so the action is always in
  // reach: but only where a whole row still shows under it. In a region too short for that
  // (a small window at a large text size) it scrolls away with the list's top. Where it
  // stays, its height is told to the rows: brought into view, they stop under it.
  useLayoutEffect(() => {
    const el = list.current, bar = el?.querySelector<HTMLElement>(":scope > .k-ask-bar");
    if (!el || !bar) {
      el?.removeAttribute("data-bar-stays");
      el?.style.removeProperty("--k-ask-bar");
      return;
    }
    const tray = el.closest<HTMLElement>('[data-testid="composer-tray"]');
    const fit = () => {
      const tallest = Math.max(0, ...[...el.querySelectorAll<HTMLElement>(':scope > [data-testid="approval"]')].map((r) => r.offsetHeight));
      const stays = !!tray && bar.offsetHeight + tallest <= tray.clientHeight;
      el.toggleAttribute("data-bar-stays", stays);
      el.style.setProperty("--k-ask-bar", stays ? `${bar.offsetHeight}px` : "0px");
    };
    const sized = new ResizeObserver(fit);
    for (const x of [bar, el, trayGauge(tray)]) if (x) sized.observe(x);
    fit();
    return () => sized.disconnect();
  }, [many]);

  const allowAll = async (tool: string, ids: string[]) => {
    noteAnswer(...ids);
    setSending(ids);
    setNote("");
    let allowed: string[] = [];
    try {
      const { results } = await safety.answerMany(sessionId, ids);
      allowed = results.filter((r) => "ok" in r).map((r) => r.id);
      const done = allowed.length;
      // Not answered, and not because it was settled elsewhere meanwhile (a grant, another device, a stop).
      const left = results.filter((r): r is Exclude<typeof r, { ok: true }> => !("ok" in r) && !(r.status === 409 && !!r.state && r.state !== "pending"));
      if (done < results.length) await safety.loadSession(sessionId).catch(reportError);
      if (left.length) setNote(`${done} of ${ids.length} allowed. ${left.length === 1 ? "One still waits" : `${left.length} still wait`}: ${left[0]!.error}`);
    } catch (e) {
      const why = failed(e, { at: "approval answer" });
      const st = (e as { status?: number }).status;
      // The daemon turned the list away before answering any of it: nothing was allowed. With
      // no such word from it (the reply was lost, a failure on the way) the answer may have
      // landed: nothing is claimed, and the cards are read again to show what still waits.
      setNote(st && st >= 400 && st < 500 ? `None allowed: ${why}` : `The answer may not have arrived (${why}). What still waits is shown.`);
      await safety.loadSession(sessionId).catch(reportError);
    } finally {
      setSending([]);
      spend(tool, allowed);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // Not from a field, and not from a popup a card opened (its events come here through React, not the page).
    if (!e.currentTarget.contains(t) || t.tagName === "INPUT" || e.altKey || e.ctrlKey || e.metaKey || composing(e)) return;
    // Enter on the list itself opens the first request that must be opened: the step its card asks
    // for first. It answers nothing. Like a key on an answer, it acts only once the keyboard has
    // been on the list for the settle time (lib/asks.ts): an Enter on its way somewhere else, or
    // pressed as the card arrives, opens nothing.
    if (e.key === "Enter" && t === e.currentTarget) {
      // (The owner's own move on the list: the settle time runs anew, and the card's Allow may take
      // the keyboard after it once the text is read, where the card lets it.)
      if (!e.repeat && !e.shiftKey && shut[0] && !keyRefused(e.currentTarget)) { e.preventDefault(); setWhole(shut[0].id, true); takeKeys(e.currentTarget, true); }
      // (An Enter the list has nothing to do with was meant for an answer: a key refused, lib/asks.ts.)
      else if (!e.repeat && !shut[0]) keyTried(e.currentTarget);
      return;
    }
    // Reading on through a long text by keys, while some of it was never in view: End reads to the
    // end of the card, Space a page on. (Once all of it was in view they are what they always are.)
    if ((e.key === "End" || e.key === " ") && !e.shiftKey && readOn(t, e.key === "End")) { e.preventDefault(); return; }
    // The answers' own numbers: 1 Allow once, 2 Always allow, 3 Deny, of the card the keyboard is on (on
    // the list itself, its first card). Only once the owner put the keyboard there (Alt A, Tab, an arrow,
    // a press on the card): a card that took it by itself from an empty message box was not looked at,
    // and a number then was meant for the box; it goes on as any key typed at such a card does (typeToBox).
    // The numbers are drawn exactly while they answer. Each is that answer's own press by a key, under
    // the same rule (an Allow of a text not read, or pressed too soon after it showed, does nothing and
    // says why); a number no answer has types nothing anywhere.
    // On the list, the first card is the one named at the press. When it goes (answered elsewhere), the
    // next becomes first and moves up into its place: a 1 then is refused while that card's Allow once
    // has not stood still a key's settle time where it is now (about 300 ms, "it moved a moment ago"),
    // and taken after it.
    if (/^[1-3]$/.test(e.key) && !e.shiftKey && owned(t)) {
      e.preventDefault();
      const card = t.closest<HTMLElement>('[data-testid="approval"]') ?? e.currentTarget.querySelector<HTMLElement>(':scope > [data-testid="approval"]');
      const answer = card?.querySelector<HTMLElement>(`:scope [data-testid="${ANSWER_KEYS[Number(e.key) - 1]}"]:not(:disabled)`);
      if (!answer || e.repeat) return;
      // (Deny answers nothing by itself, it opens the reason: still not as the keyboard arrives.)
      const no = e.key === "3" ? keyRefused(t, e.repeat) : "";
      if (no) { tipSay(answer, no, SETTLE_MS); return; }
      answer.click();
      return;
    }
    // Words typed while a card has the keyboard are for the message box: they go there, and so does the Enter after them.
    if (typeToBox(e)) return;
    // Up and Down move between the list's stops: the "allow all" action, then each card's first answer.
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.shiftKey) return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-stop]:not(:disabled)")];
    const down = e.key === "ArrowDown";
    const own = stops.find((s) => s.dataset.stop === "card" && s.closest('[data-testid="approval"]') === t);
    const i = stops.findIndex((s) => s === t || (s.dataset.stop === "card" && !!s.closest('[data-testid="approval"]')?.contains(t)));
    // From a card itself (the keyboard was brought to it, not to an answer): Down is its own first answer.
    const to = own ? (down ? own : stops[i - 1])
      : i >= 0 ? stops[i + (down ? 1 : -1)]
      : down ? stops.find((s) => s.dataset.stop === "card")
      : stops.findLast((s) => s.dataset.stop === "all");
    if (!to) return;
    e.preventDefault();
    to.focus();
  };
  // Moves the region above the message box on through the text of the card the keyboard is on
  // (on the list itself: the first card with lines not seen), a step at a time, each step read as
  // the owner's own scroll. A step is the height the text can be read in, less a line (with the
  // fades at both edges and the card's foot counted out), so two views always share a line and
  // none is jumped over. The steps are lib/approvals.ts's readOnSteps on the list's painted reader:
  // a step is made two frames after the key or after the reading of the step before, never in the
  // frame of either, and its view counts once it was painted. One run of steps at a time: a press
  // while one is under way joins it (Space is one step more, End goes on to the end), and so does a
  // key the browser repeats. It goes on while the card has lines not seen and the region can move.
  // `end`: on to the card's end, else one step. Not for a card whose text must be opened first.
  const readOn = (from: HTMLElement, end: boolean): boolean => {
    const r = reader();
    if (!list.current || !r) return false;
    const unread = (c: HTMLElement) => (latest().unseen.get(c.dataset.approvalId!)?.n ?? 0) > 0 && !shut.some((x) => x.id === c.dataset.approvalId);
    const own_ = from.closest<HTMLElement>('[data-testid="approval"]');
    const first = own_ ? (unread(own_) ? own_ : null) : [...list.current.querySelectorAll<HTMLElement>(':scope > [data-testid="approval"]')].find(unread);
    const run = steps.current;
    // (A run that made no step for a second is over, whatever ended it: a reader stopped with its list.)
    if (run.on && performance.now() - run.at < SETTLE_MS) { if (end) run.end = true; else run.more++; return true; }
    if (!first?.querySelector('[data-testid="approval-summary"]')) return false;
    const id = first.dataset.approvalId!;
    // Found again at every step: the pane may draw the list anew meanwhile (the run goes on in the new one).
    const parts = () => {
      const el = list.current, card = el?.querySelector<HTMLElement>(`:scope > [data-approval-id="${CSS.escape(id)}"]`);
      const text = card?.querySelector<HTMLElement>('[data-testid="approval-summary"]'), tray = el?.closest<HTMLElement>('[data-testid="composer-tray"]');
      return el && card && text && tray ? { el, card, text, tray } : null;
    };
    const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const foot = (card: HTMLElement) => (card.hasAttribute("data-foot") ? card.querySelector<HTMLElement>(":scope > .k-ask-foot")?.offsetHeight ?? 0 : 0);
    // What of the text is still under the readable frame's foot (the fade and the card's foot counted out).
    const rest = ({ card, text, tray }: NonNullable<ReturnType<typeof parts>>) => text.getBoundingClientRect().bottom - (tray.getBoundingClientRect().bottom - foot(card) - 1.25 * rem());
    const stepBy = ({ el, card, text, tray }: NonNullable<ReturnType<typeof parts>>) => {
      const b = tray.getBoundingClientRect(), fade = 1.25 * rem(); // the region's fades (styles.css), counted whether they show or not
      const bar = el.hasAttribute("data-bar-stays") ? el.querySelector<HTMLElement>(":scope > .k-ask-bar")?.getBoundingClientRect().bottom ?? 0 : 0;
      const top = Math.max(b.top + fade, bar), bottom = b.bottom - foot(card) - fade;
      const line = parseFloat(getComputedStyle(text).lineHeight) || 1.5 * rem();
      return Math.max(line, Math.floor(bottom - top - line));
    };
    const left = (p: ReturnType<typeof parts>) => !!p && (latest().unseen.get(id)?.n ?? 0) > 0 && p.tray.scrollTop + p.tray.clientHeight < p.tray.scrollHeight - 1 && rest(p) > -1.25 * rem();
    if (!left(parts())) return false;
    run.on = true; run.more = end ? 0 : 1; run.end = end; run.at = performance.now();
    const go = (): boolean | "wait" => {
      // (Each step is the run's: an End, or a press of Space not yet made.)
      if (!run.end && run.more <= 0) return false;
      const p = parts();
      if (!p || !left(p)) return false;
      run.at = performance.now();
      own();
      // (Lines in view not counted yet: not carried out of view unread. Read again first.)
      const u = latest().unseen.get(id);
      if (u && u.n > u.out) return "wait";
      if (!run.end) run.more--;
      p.tray.scrollTop += Math.min(stepBy(p), Math.max(1, Math.ceil(rest(p)) + 1));
      return true;
    };
    // (The list's reader, also when the list was drawn anew: whichever is the list's now.)
    readOnSteps(go, { ask: (then) => (reader() ?? r).ask(then), stop: () => {} }, true, () => { run.on = false; run.more = 0; run.end = false; });
    return true;
  };
  const onFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    // (In a field the arrows are the field's: nothing is said.)
    const id = t.closest<HTMLElement>('[data-testid="approval"]')?.dataset.approvalId;
    setAt(!e.currentTarget.contains(t) || t.tagName === "INPUT" ? null : t.dataset.testid === "allow-once" ? { on: "once", id } : t.dataset.testid === "allow-all" ? { on: "all" } : t === e.currentTarget ? { on: "list" } : t.dataset.testid === "approval" ? { on: "card", id } : id ? { on: "row", id } : null);
  };

  return (
    <>
      <SecretCards sessionId={sessionId} />
      <BlockedCards sessionId={sessionId} />
      <TrustCards sessionId={sessionId} />
      <PlanCards sessionId={sessionId} />
      {cards.length > 0 && (
        <div
          ref={list}
          tabIndex={-1}
          data-ask-card=""
          data-ask=""
          data-keys={hold.keys || undefined}
          role="region"
          aria-label={`${asker ? `${asker}: ` : ""}${cards.length === 1 ? "1 request waits" : `${cards.length} requests wait`} for your answer`}
          className={cn("k-ask-list mb-2 flex flex-col outline-none", many ? "gap-1.5" : "gap-2")}
          data-testid="approvals"
          onKeyDown={onKeyDown}
          // A key held down answers once: its repeats press nothing here (a button, the reason field's Enter).
          onKeyDownCapture={dropRepeats}
          onFocus={onFocus}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setAt(null); }}
        >
          {many && (
            <div className="k-ask-bar flex min-h-ctl-lg flex-wrap items-center gap-x-3 gap-y-1.5 pl-0.5" data-testid="approvals-bar">
              <span className="k-face-state k-ask-count" data-testid="approvals-count">
                {uniform ? batchName(cards[0]!, cards.length) : `${cards.length} requests`} wait
              </span>
              {/* What the keyboard does where it is, or why the pointed action waits. Its room is kept, so nothing moves when it changes. */}
              <span className="min-w-0 flex-1 basis-0 truncate text-micro text-faint max-sm:hidden pointer-coarse:hidden" data-testid="approvals-hint">
                {dull ? "It covers requests that are whole on screen and have stood still for a second"
                  : at?.on === "all" ? "Enter allows the framed ones once"
                  : hot.length ? "A click allows the framed ones once"
                  : at?.on === "once" && view.live.has(at.id!) && hold.keys === "ready" ? "Up and Down choose, Enter allows the framed one once"
                  // (True at every moment: while its Allow waits, Enter does nothing yet, and the line says so.)
                  : at?.on === "once" && !shut.some((c) => c.id === at.id) ? "Up and Down choose; Enter allows the framed one in a moment"
                  : at?.on === "once" || at?.on === "row" || at?.on === "card" ? "Up and Down choose a request"
                  : at?.on === "list" && shut.length && hold.keys === "ready" ? "Enter opens the first request that must be opened"
                  : ""}
              </span>
              <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                {groups.map((g) => (
                  <AllowAll
                    key={g.tool}
                    g={g}
                    ids={covered(g.tool)}
                    on={!!view.acts.get(g.tool)?.live}
                    cards={cards}
                    busy={sending.length > 0}
                    list={list}
                    onHot={(on) => { setHot(g.tool, on); setHotTools((h) => (on ? [...h.filter((x) => x !== g.tool), g.tool] : h.filter((x) => x !== g.tool))); }}
                    // Read again as it is pressed: only what is whole and still at this instant is answered.
                    press={() => { const a = tick().acts.get(g.tool); return a?.live ? open(a.covered) : null; }}
                    onAllow={(ids) => allowAll(g.tool, ids)}
                  />
                ))}
              </span>
            </div>
          )}
          {/* Said for as long as a request is left, also when that is one card with no bar over it. */}
          {note && <p className="pl-0.5 text-micro text-danger" role="alert" data-testid="approvals-error">{note}</p>}
          {cards.map((a, i) => (
            <Card
              key={a.id}
              a={a}
              first={i === 0}
              asker={asker}
              where={where}
              list={list}
              many={many}
              plain={uniform}
              hot={marked.has(a.id)}
              locked={sending.includes(a.id) || !waiting.includes(a)}
              ripe={view.ripe.has(a.id)}
              live={view.live.has(a.id)}
              grant={view.grant.has(a.id)}
              // Read again as it is pressed: it acts where it has stood, for a text whose every line has been in view.
              armed={(which) => { const v = tick(); return v[which].has(a.id) && v.unseen.get(a.id)?.n === 0; }}
              keyLive={view.keyLive.has(a.id)}
              keyUnseen={view.keyUnseen.get(a.id)}
              // The same for a key press: the Allow stood still for KEY_MS, and every line stood in view that long.
              armedKey={() => { const v = tick(); return v.keyLive.has(a.id) && v.keyUnseen.get(a.id) === 0; }}
              read={tick}
              cut={view.cut.has(a.id)}
              unseen={view.unseen.get(a.id)}
              whole={!!opened[a.id]}
              onWhole={(on) => setWhole(a.id, on)}
              enterOpens={at?.on === "list" && shut[0]?.id === a.id && hold.keys === "ready"}
              touch={touch}
              keysOn={at?.on === "list" ? "list" : at?.id !== a.id ? "" : at.on === "once" ? "once" : at.on === "card" ? "card" : ""}
            />
          ))}
        </div>
      )}
    </>
  );
}

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

// Whether a media query holds now.
function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (f) => { const m = matchMedia(query); m.addEventListener("change", f); return () => m.removeEventListener("change", f); },
    () => matchMedia(query).matches,
  );
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
    const timer = window.setInterval(() => setReady(now()), READ_MS);
    return () => window.clearInterval(timer);
  }, [now]);
  return { ready, now };
}

// A control that held the focus and goes away hands it to its list's label,
// never to another card's Allow. The last one takes the list with it: the
// focus goes to the pane's message box (at a desk; on a phone that raises the
// keyboard). (An answer disables the control, and the browser then takes the
// focus off it: `held` remembers that it had it.)
function useHandBack(root: RefObject<HTMLElement | null>, list: RefObject<HTMLDivElement | null>) {
  const held = useRef(false);
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    if (!root.current?.contains(a) && !(held.current && (!a || a === document.body))) return;
    const to = list.current;
    const box = root.current?.closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]');
    queueMicrotask(() => {
      if (to?.isConnected) to.focus({ preventScroll: true });
      // (Not while the answering sequence is on: it moves the keyboard to what waits next, never by way of a message box.)
      else if (!sequenceAt() && matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
    });
  }, []);
  return held;
}

// One action for a tool's open requests. It says how many of them it answers
// (`ids`), and while the pointer or the keyboard is on it those rows are the
// framed ones. It is never disabled the browser's way, which would drop the
// keyboard from it each time the list moves: while it waits it is marked
// disabled and a press does nothing.
function AllowAll({ g, ids, on, cards, busy, list, onHot, press, onAllow }: {
  g: Batch; ids: string[]; on: boolean; cards: Approval[]; busy: boolean; list: RefObject<HTMLDivElement | null>;
  onHot: (on: boolean) => void; press: () => string[] | null; onAllow: (ids: string[]) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  useHandBack(root, list);
  const over = useRef({ pointer: false, keys: false });
  const hot = (patch: Partial<typeof over.current>) => {
    const was = over.current.pointer || over.current.keys;
    Object.assign(over.current, patch);
    const now = over.current.pointer || over.current.keys;
    if (now !== was) onHot(now);
  };
  useEffect(() => () => onHot(false), []);
  const pressed = usePress(press, (ids) => !!ids && ids.length > 1);
  const nudge = useNudge();
  const able = on && !busy;
  const names = cards.filter((a) => ids.includes(a.id)).map((a) => a.summary);
  return (
    <>
    <button
      ref={root}
      type="button"
      data-testid="allow-all"
      data-tool={g.tool}
      data-stop="all"
      aria-disabled={!able || undefined}
      data-nudge={nudge.mark}
      aria-label={`Allow ${coverName(g, ids.length)} once`}
      aria-description={able ? `Allows once, in this order: ${names.join("; ")}` : "It covers requests that are whole on screen and have stood still for a second. High-risk and cut ones are answered on their own."}
      onPointerEnter={() => hot({ pointer: true })}
      onPointerLeave={() => hot({ pointer: false })}
      onPointerDown={pressed.onPointerDown}
      onMouseDown={pressed.onMouseDown}
      onFocus={() => hot({ keys: true })}
      onBlur={() => hot({ keys: false })}
      onClick={(e) => {
        const now = pressed.said(e);
        if (busy) return;
        const why = e.detail === 0 ? keyRefused(e.currentTarget) : "";
        if (!now || now.length < 2) nudge.refuse("Not yet: it covers requests once they have stood still for a second", e.currentTarget);
        else if (why) nudge.refuse(why, e.currentTarget);
        else onAllow(now);
      }}
      className="k-btn k-btn-lg k-allow-all whitespace-nowrap aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
    >
      <CheckCheck className="size-3.5 text-st-need" aria-hidden="true" />
      {/* The widest label it can have holds its room, so the bar does not wrap anew when the count changes. */}
      <span className="grid text-left tabular-nums">
        <span className="invisible col-start-1 row-start-1" aria-hidden="true">Allow {g.waiting} of {batchName(g, g.waiting)}</span>
        <span className="col-start-1 row-start-1" data-testid="allow-all-label">Allow {coverName(g, ids.length)}</span>
      </span>
    </button>
    {nudge.line}
    </>
  );
}

// `many`: one of several, drawn as a row (the request beside its answers, no
// hint: the list says it once), framed only while it has the keyboard.
// `plain`: every row is the same tool and the list's heading names it, so the
// row's title is for screen readers only. `hot`: the pointed "allow all"
// covers it. `locked`: that action is answering it. `live`: its Allow once
// has stood whole and still for the settle time, so it acts; `grant`: the same
// for its Always allow; `armed` asks either at the instant of a press, `read` reads the list now. `ripe`:
// it has been on the page that long. `cut`: its text is longer than its box.
// `unseen`: the lines of its text that have not been in view (none known yet: not read).
// `whole`: the owner opened its whole text, by the list's Enter or by the card's own control
// (`onWhole`). `enterOpens`: the list has the keyboard and its Enter would open this card now.
// `keysOn`: where the keyboard is, as far as this card goes: on its Allow once, on the card
// itself, or on the list. `touch`: the pointer is a finger.
function Card({ a, first, asker, where, list, many, plain, hot, locked, ripe, live, grant, armed, read, cut, unseen, keyLive, keyUnseen, armedKey, whole, onWhole, enterOpens, keysOn, touch }: {
  a: Approval; first: boolean; asker?: string; where?: Where; list: RefObject<HTMLDivElement | null>; many: boolean; plain: boolean;
  hot: boolean; locked: boolean; ripe: boolean; live: boolean; grant: boolean; armed: (which: "live" | "grant") => boolean; read: () => unknown; cut: boolean; unseen?: Unseen;
  keyLive: boolean; keyUnseen?: number; armedKey: () => boolean;
  whole: boolean; onWhole: (on: boolean) => void; enterOpens: boolean; keysOn: "" | "once" | "card" | "list"; touch: boolean;
}) {
  const dense = many && a.risk !== "high"; // a high-risk request keeps its whole card, with why it is one
  const Icon = a.risk === "high" ? ShieldAlert : ICON[a.kind];
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [answering, setAnswering] = useState(false);
  const [err, setErr] = useState("");
  const [closed, setClosed] = useState(false); // the daemon says it can no longer be answered
  const root = useRef<HTMLDivElement>(null);
  const once = useRef<HTMLButtonElement>(null);
  const ids = `approval-${a.id}`;
  const busy = answering || locked;
  // A request is answered only for what was read. Until every line of its text
  // has been in view (the list keeps count: a text longer than its box, a card
  // the region above the message box cuts, a long text opened and not scrolled
  // through), and while the daemon shows only its start or it holds a
  // character that had to be spelled out and it was not opened, the card takes
  // no answer and never has the keyboard on one: Allow once and Always allow
  // refuse, and say what is left. Bringing the text into view is the owner's own act.
  const part = shownInPart(a); // the daemon kept more of the input than the card shows
  const shown = shownOf(a);
  const marked = shown.hidden > 0;
  // The lines the owner has yet to bring into view: said where the text is in view or has been, or
  // once a press was refused for them (a card whose text is all out of view says nothing by
  // itself, and so does not change as it comes into view).
  // Only where the text has to be scrolled through: it is longer than its box, or its card is
  // taller than the region. A short card that merely stands at the region's fold says nothing,
  // and keeps its height as it comes into view.
  const [told, setTold] = useState(false);
  const left = unseen && (told || (unseen.begun && (cut || unseen.tall))) ? unseen.out : 0;
  // What is counted is what is seen: the text's lines where none of them wraps, and rows (the
  // lines as the card draws them) where one does, so one long line is not called twenty.
  const kept = part ? (typeof a.input?._clipped === "string" ? a.input._clipped : JSON.stringify(a.input ?? {}, null, 2)) : "";
  const written = (whole && part ? kept : shown.text).replace(/\n$/, "").split("\n").length;
  const unit = unseen && unseen.total !== written ? "row" : "line";
  const count = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const leftText = `${count(left)} not seen yet`;
  const shut = mustBeOpened(a, whole, cut, unseen);
  // Where the keyboard is on this card or its list, the key that reads on is named with it (the list's End and Space).
  const readKey = !touch && keysOn !== "" && !shut;
  const shutNow = useRef(shut);
  shutNow.current = shut;
  const firstNow = useRef(first);
  firstNow.current = first;
  const mustOpen = !unseen || unseen.n > 0 || shut;
  // All of a short text with marked characters is on the card: what its first control does is show the marks.
  const marks = shown.hidden;
  const onlyMarks = marked && !part && !cut;
  const thing = a.kind === "shell" ? "command" : "text";
  const openLabel = onlyMarks ? `Show the ${marks} marked character${marks === 1 ? "" : "s"}` : a.kind === "shell" ? "Show the whole command" : "Show all of it";
  const openFirst = onlyMarks ? `Look at the marked character${marks === 1 ? "" : "s"} first` : `Open the whole ${thing} first`;
  const enterSays = onlyMarks ? `Enter shows the marked character${marks === 1 ? "" : "s"}` : `Enter opens the whole ${thing}`;
  const tapSays = onlyMarks ? `Tap to show the marked character${marks === 1 ? "" : "s"}` : `Tap to open the whole ${thing}`;
  const unread = useRef(mustOpen);
  unread.current = mustOpen;
  // The same for what a key may do (KEY_MS, lib/approvals.ts): every line stood in view that long.
  const mustOpenKey = keyUnseen === undefined || keyUnseen > 0 || shut;
  const unreadKey = useRef(mustOpenKey);
  unreadKey.current = mustOpenKey;
  const heldDown = useRef(false); // the last press on Allow once went down where it held the keyboard, ready
  const toList = () => list.current?.focus({ preventScroll: true });
  // Whether the card is in the window: a page of a phone's track that is not the one shown takes no keyboard.
  const inView = () => { const r = root.current?.getBoundingClientRect(); return !!r && r.width > 0 && r.right > 0 && r.left < innerWidth; };
  // The two questions every way to an answer of this card asks, each answered in one place.
  // The card's own rule is the stricter one and comes first in both.
  // - May an answer of the card have the keyboard by the page's own doing: only when its text
  //   is read (every line of it has been in view, and what had to be opened was), the card is
  //   in the window, and nothing about the request asks for a second look (`heldWhy`): high
  //   risk, an input the daemon shows in part, a text that is flagged. Such an answer is the
  //   owner's to go to (Down from the card or its list, or Tab), after a load, a return, a step
  //   of a sequence or the Enter that opened the text: Enter alone never both opens and allows it.
  // - Why a press on an answer does nothing, or "" when it answers: the card's rule (a text
  //   not all read takes no answer), then the control's (it stands, and has stood for the
  //   settle time: `stood`), then the keyboard's for a press made by a key (lib/asks.ts: not
  //   within the settle time of the keyboard arriving by code, not under a dialog).
  const heldWhy = a.risk === "high" ? "High risk" : part ? "Shown in part" : marked ? "Marked characters" : shown.alike.length ? "Not plain ASCII" : shown.rtl ? "Right-to-left letters" : "";
  const mayHold = () => !unreadKey.current && inView() && !heldWhy;
  const refusalOf = (stood: boolean, key: Element | null): string => {
    // Not read: the text is to be opened first, or so many of its lines have not been in view.
    // (Said on the card from then on, where its text is all out of view and it said nothing by itself.)
    // A key is judged by its own times (KEY_MS): what stood in view that long, a control that stood that long.
    if (key) {
      if (unreadKey.current) { refused(); keyTried(key); return shut ? openFirst : notYet; }
      if (!armedKey()) { keyTried(key); return notYet; }
      return keyRefused(key);
    }
    if (unread.current) { refused(); return shut ? openFirst : notYet; }
    if (!stood) return notYet;
    return "";
  };
  // Where the keyboard goes (lib/asks.ts): code brings it to the list of requests or to the
  // card, never to an answer, and the card's Allow once takes it after the settle time,
  // counted from when the keyboard came, if the card may have it there.
  // An arrival says where it lands, however late the card is drawn (lib/automation.ts):
  // "card" stays on the list (the request is read here first), "allow" is this card and
  // then its Allow, "deny" opens the denial with the keyboard in the reason field.
  const hold = useHold(list);
  const asked = useRef(false);
  const chosen = useRef(false); // an arrival named this card's answer (the click on its own notification)
  const arrive = () => {
    const arrival = arrivalOf(a.id);
    if (!arrival) return false;
    asked.current = true;
    chosen.current = arrival.to === "allow";
    // A card takes no keyboard under a dialog or a menu. What the owner asked from one (a row of
    // the Inbox, the palette) is on its way out as the card hears of it: the arrival lands when it
    // is gone, about a second at most.
    let frames = 0;
    const land = (target: () => Element | null, advance = true) => {
      if (!root.current?.isConnected) return;
      if (modalOpen() && ++frames < 60) return void requestAnimationFrame(() => land(target, advance));
      takeKeys(target(), true, advance);
    };
    if (arrival.to === "deny") { setReason((r) => r + arrival.typed); setDenying(true); }
    else if (arrival.to === "card") land(() => list.current, false);
    // One rule for every way the owner asks for a request (a row, the palette, a link, the key
    // that goes to what waits): the keyboard lands on the list of requests, and after the settle
    // time the Allow of the list's first card takes it if that card may hold it. So does a card
    // whose text must be opened: Enter on the list opens it. Only a request that is named and is
    // not the first of its list takes the keyboard itself (the card answers nothing there), so
    // that its own Allow, not the first card's, is the one that takes it.
    else land(() => (shutNow.current || firstNow.current ? list.current : root.current));
    return true;
  };
  useEffect(() => {
    arrive();
    const el = root.current;
    const on = () => void arrive();
    el?.addEventListener("keel:arrive", on);
    return () => el?.removeEventListener("keel:arrive", on);
  }, []);
  // With no arrival named, the first card brings the keyboard to its list as it appears,
  // unless the owner is busy elsewhere (mayTake) or the card is not in the window: once. A
  // key on its way to the message box lands on nothing that answers, and typed words go
  // back to the box. (Only the card that is first as it is drawn: one that becomes first
  // because the one before it was answered takes nothing, and the keyboard stays where
  // that answer left it.)
  useEffect(() => {
    if (!first || asked.current || arriving(a.id)) return;
    asked.current = true;
    if (mayTake(list.current) && inView()) takeKeys(list.current, false);
  }, []);
  // Once the keyboard has been on the list (for the first card) or on this card for the
  // settle time and nothing else was done with it, the card's Allow once takes it, if it
  // may and can be pressed: Enter then answers what was read. Once for each time the
  // keyboard is brought: an answer that hands the focus back to the list leaves it there,
  // and a card that is out of the window leaves it on the list.
  // Where the Allow is not whole in the region above the message box (a card taller than
  // the region), there is nothing to wait for: it takes the keyboard, the region brings it
  // into view, and it acts once it has stood there (its own settle time still applies).
  const moved = useRef(0);
  const onceInRegion = () => {
    const r = once.current?.getBoundingClientRect();
    const tray = once.current?.closest('[data-testid="composer-tray"]')?.getBoundingClientRect();
    return !!r && r.height > 0 && r.top >= Math.max(0, tray?.top ?? 0) - 0.5 && r.bottom <= Math.min(innerHeight, tray?.bottom ?? innerHeight) + 0.5;
  };
  useEffect(() => {
    if (hold.keys !== "ready" || !hold.take || moved.current === hold.at) return;
    const at = document.activeElement;
    if (!(at === root.current || (first && at === list.current))) { moved.current = hold.at; return; }
    // Brought here from outside the page (a link, a second launch of the desktop app): the
    // keyboard stays where it is read and does not move onto an answer by itself, unless the
    // arrival named this card's answer.
    if (wasBrought() && !chosen.current) { moved.current = hold.at; return; }
    // A card that is not read keeps the keyboard on the list and is asked again once it is (this
    // runs again as that changes): its text opened and its lines seen, its Allow takes the keyboard.
    if (!mayHold()) { if (!unread.current) moved.current = hold.at; return; }
    if (!keyLive && onceInRegion()) return;
    moved.current = hold.at;
    // (An arrival of its own: Enter allows only after a key's settle time from its paint, lib/asks.ts.)
    pageFocus(once.current);
  }, [hold.keys, hold.take, hold.at, keyLive, mustOpenKey]);
  // The marked characters of a text opened for them are brought into view.
  useEffect(() => {
    if (whole && marked) root.current?.querySelector('[data-testid="hidden-char"]')?.scrollIntoView({ block: "nearest" });
  }, [whole]);
  // The control that opens the text leads the answers, and stays in its place once it was
  // there: opened, it folds the text; read in its box, it still opens it. It keeps the width
  // of its longest label (bridge.css), so no answer ever comes under a pointer that rests on
  // it, and the keyboard that pressed it stays on it.
  const slot = useRef(false);
  if (shut || whole) slot.current = true;
  // Opened or folded, the card is read where it stands before anything else looks at it: its foot
  // is in the region's view by then, so the region does not go looking for the control that was
  // pressed at the far end of the text.
  useLayoutEffect(() => { read(); }, [whole]);
  // The keyboard never rests on an answer of a card that is not all read, nor on the card
  // itself when its text must be opened (it was found cut after the keyboard came): it is read
  // on the list, where Enter opens it.
  // Read again (its text wrapped anew when the window or the text size changed, and its lines
  // were seen once more), its Allow may take the keyboard back as when it first came: the card
  // itself sent it off, so that arrival is not used up. The keyboard waits on the list for the
  // first card and for one that must be opened, on the card itself for any other.
  useEffect(() => {
    const at = document.activeElement as HTMLElement | null;
    if (!at || !root.current?.contains(at)) return;
    const onAnswer = at.dataset.testid === "allow-once" || at.dataset.testid === "allow-always";
    if (!((shut && at === root.current) || (mustOpenKey && onAnswer))) return;
    moved.current = 0;
    if (shut || first) toList();
    else root.current.focus({ preventScroll: true });
  }, [mustOpenKey, shut]);
  const held = useHandBack(root, list);
  // Leaving the reason (Esc, Back) puts the keyboard where the card's own rule would: on
  // Allow once for a card that is whole and read, so Enter answers again, and on the list
  // of requests for one whose text is not all on it. It is never lost to the page.
  // The answers that come back act only after the settle time, by a key and by a press: in
  // the reason field Enter sends the denial, and on a narrow screen "Send denial" stands
  // where Allow once comes back and "Back" where Always allow does. An Enter or a second
  // tap meant for the denial must not allow the request. So the answers are read as gone
  // the moment the reason opens: however short it was open, they stand anew when they return.
  useEffect(() => { if (denying) armed("live"); }, [denying]);
  const back = useRef(false);
  const leaveDeny = () => { back.current = true; setDenying(false); };
  useEffect(() => {
    if (denying || !back.current) return;
    back.current = false;
    if (mayHold()) once.current?.focus({ preventScroll: true });
    else toList();
  }, [denying]);
  const pressed = usePress(() => !unread.current && armed("live"), (ok) => ok);
  const nudge = useNudge();
  // Why a press on one of its answers does nothing now.
  const unreadLines = unseen?.out ?? 0;
  const notYet = unreadLines > 0 ? `Not yet: ${count(unreadLines)} not seen yet` : ripe ? "Not yet: it moved a moment ago" : "Not yet: it has only just arrived";
  const refused = () => { if (unreadLines > 0) setTold(true); };
  // A text over three screens long says so, with the way that is not an allow: reading all of
  // it is the price of allowing it, and denying it costs nothing. (The line stays once the text
  // was read, in its other words: nothing moves under the hand as the answers come alive.)
  const longLine = !unseen?.long ? "" : mustOpen ? `Long ${thing}: ${count(unseen.total)}. Deny, or scroll through to allow.` : `Long ${thing}: ${count(unseen.total)}, all seen.`;
  // What the hint line may say (see where it is drawn): `ready` exactly when Enter on its Allow
  // would answer; `arming` while the page is about to make that so, or how to get there.
  const ready = keysOn === "once" && keyLive && !mustOpenKey && hold.keys === "ready";
  // The answers' numbers are drawn exactly while they answer (the list's keys, Approvals' onKeyDown): the
  // keyboard is on this card or on the list it leads, the owner put it there, and it has settled (not on a
  // finger's screen). Each one besides only while its own answer would take it: 1 and 2 once the text
  // was read as a key reads it, 2 once Always allow is drawn live, 3 always (a denial costs nothing).
  const numbers = !touch && hold.own && hold.keys === "ready" && !busy && (keysOn === "once" || keysOn === "card" || (keysOn === "list" && first));
  const digits = { once: numbers && keyLive && !mustOpenKey, always: numbers && keyLive && !mustOpenKey && grant && !mustOpen, deny: numbers };
  const coming = keysOn === "card" || (keysOn === "list" && first);
  const heldLine = heldWhy ? `${heldWhy}: Down, then Enter allows once` : "";
  const arming = ready || shut || left > 0 ? ""
    : keysOn === "once" ? ARMING
    : !coming ? ""
    : heldWhy ? (mustOpen ? "" : heldLine)
    // (Only while the Allow is still to take the keyboard for this arrival: else Enter stays where
    // it is, as it does for an owner brought here from outside the page.)
    : hold.take && moved.current !== hold.at && (!wasBrought() || chosen.current) ? ARMING
    // (A key typed at it took the move back, or the keyboard was brought to rest on the list after an
    // answer one key gave by itself: the owner goes to the answer.)
    : keysOn === "list" && first && !hold.take && hold.keys !== "" && !mustOpen ? "Down, then Enter allows once"
    : "";

  // How long the arming line takes to fill: what is left of the settle time of the keyboard's
  // arrival, counted from when the line came. (It fills by then and stays full until Enter works.)
  // (Only while Enter is about to allow: not for the words that say how to reach the answer of a card held for a second look.)
  const armingNow = arming === ARMING;
  const armFrom = useRef<{ at: number; from: number } | null>(null);
  if (!armingNow) armFrom.current = null;
  else if (!armFrom.current || armFrom.current.at !== hold.at + hold.key) armFrom.current = { at: hold.at + hold.key, from: performance.now() };
  // (A key's settle time, KEY_MS, from the arrival's paint: about a frame after the arrival.)
  const armFor = armingNow ? Math.round(Math.max(120, Math.min(KEY_MS + 34, (Math.max(hold.at, hold.key) || armFrom.current!.from) + KEY_MS + 34 - armFrom.current!.from))) : 0;
  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    noteAnswer(a.id);
    // (The grant's popup is the card's own, drawn outside it: an answer given there held the keyboard too.)
    held.current = !!root.current?.contains(document.activeElement) || !!document.activeElement?.closest("[data-ask-part]");
    setAnswering(true);
    setErr("");
    try {
      await safety.answer(a.session_id, a.id, body.choice === "deny" ? body : { ...body, seen: "whole" });
    } catch (e) {
      const st = (e as { status?: number }).status;
      const was = (e as { body?: { approval?: Approval } }).body?.approval;
      setErr(failed(e, { at: "approval answer" }));
      if (st === 409) {
        // Answered elsewhere, cancelled, or nothing waits on it: say how it ended, offer no decision.
        setClosed(true);
        if (was && was.state !== "pending") window.setTimeout(() => safety.loadSession(a.session_id).catch(reportError), 4000);
      } else if (!st) {
        // The answer may have landed before the reply was lost: read the card again before a retry.
        await safety.loadSession(a.session_id).catch(reportError);
      }
    } finally {
      setAnswering(false);
    }
  };

  // A command for another machine of the fleet says which, and where there: the same text is a
  // different act on another machine. (The names are the model's words: shown with nothing hidden.)
  const far = a.kind === "shell" && a.input && typeof a.input === "object" && !("_clipped" in a.input) && typeof a.input.machine === "string" && a.input.machine
    ? { machine: a.input.machine as string, cwd: typeof a.input.cwd === "string" && a.input.cwd ? (a.input.cwd as string) : "" } : null;
  const machine = far && (
    <span className="rounded-full border border-line-strong px-2 py-0.5 text-micro font-medium text-warn" dir="ltr" data-testid="approval-machine">
      on <Spelled text={far.machine} />{far.cwd && <>, in <Spelled text={far.cwd} /></>}
    </span>
  );
  // Where it runs, when that is not this page's folder: the folder the command starts in when it
  // moved, else the asker's own (an agent's worktree). The asker's branch is named only for a folder
  // in its worktree: a command an agent runs in another checkout acts on that checkout's branch, not
  // its own. The same command is another act in another checkout. (Folder and branch names are the
  // model's or the repository's: shown with nothing hidden.)
  const runsIn = runsAt(a.at, where, a.kind === "shell" || !!a.at);
  const place = runsIn && (
    <span className={cn("max-w-full truncate rounded-full border px-2 py-0.5 text-micro font-medium", a.at?.away ? "border-line-strong text-warn" : "border-line text-muted")} dir="ltr" title={`${runsIn.folder}${runsIn.branch ? `, branch ${runsIn.branch}` : ""}`} data-testid="approval-where">
      in <Spelled text={runsIn.folder.split("/").filter(Boolean).at(-1) ?? runsIn.folder} />{runsIn.branch && <>, branch <Spelled text={runsIn.branch} /></>}
    </span>
  );
  const fromCode = a.call_id.includes("~") && <span className="rounded-full bg-sunken px-1.5 py-px text-micro text-muted" data-testid="approval-from-code">from a program</span>;
  const title = (
    <span id={`${ids}-title`} className={cn(dense ? "text-caption font-medium" : "text-ui font-medium", dense && plain && "sr-only")}>
      {asker && <span className="sr-only">{asker}: </span>}
      {TITLE[a.kind]} <span className="font-mono text-caption font-normal text-faint">{a.tool}</span>
    </span>
  );
  const icon = (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-md", a.risk === "high" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent")}>
      <Icon className="size-3.5" />
    </span>
  );
  const notice = a.notice && <p className={cn("text-caption text-warn", dense ? "mb-1" : "mx-4 mt-2")} data-testid="approval-notice">{a.notice}</p>;
  // (`kept`: the whole of what the daemon kept of the input, when the card shows only its start.)
  const short = !whole && (cut || part);
  // What an edit would write, under its paths: read like any other text of a request. Its lines are
  // counted, and each is shown as it is written (Spelled): a character in it that hides or
  // reorders text is spelled out and marked, as in a command.
  const body = whole && part ? null : shown.body;
  // (Opened to all the daemon kept of a long input: that text is what is shown, and what is named.)
  const alike = whole && part ? lookAlikes(kept) : shown.alike;
  const rtl = whole && part ? hasRtl(kept) : shown.rtl;
  const hiddenNow = whole && part ? hasHidden(kept, "\n\t") : marked;
  const summary = (
    <>
      <pre
        id={`${ids}-summary`}
        className={cn(
          "overflow-auto bg-code font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
          dense ? "rounded-md px-2.5 py-1.5" : "mx-4 mt-2.5 rounded-lg px-3 py-2",
          !whole && (dense ? "max-h-32" : "max-h-48"),
        )}
        // Whatever is asked (a command, a path, a tool's input) is shown in the order it is written:
        // letters written right to left stand in their runs (Spelled) and are not reordered among the rest.
        dir="ltr"
        data-testid="approval-summary"
        data-cut={short || undefined}
        data-marks={whole && marked ? "shown" : undefined}
      >
        {a.kind === "shell" && <span className="select-none text-accent">$ </span>}
        {body ? <span className="font-semibold"><Spelled text={a.summary} shown={whole} /></span> : <Spelled text={whole && part ? kept : a.summary} shown={whole} />}
        {body && (
          <span data-testid="approval-body">
            {body.lines.map((l, i) => (
              <span key={i} className={l.tone === "add" ? "text-ok" : l.tone === "del" ? "text-danger" : l.tone === "note" ? "text-faint" : undefined}>{"\n"}<Spelled text={l.text} shown={whole} /></span>
            ))}
          </span>
        )}
      </pre>
      {/* A character that hides or reorders text is spelled out above, and the card says that it did so. */}
      {hiddenNow && (
        <p className={cn("mt-1 text-micro text-danger", !dense && "mx-4")} data-testid="approval-hidden">
          This text holds characters that do not show as written. Each is spelled out and marked.
        </p>
      )}
      {body?.clipped && (
        <p className={cn("mt-1 text-micro text-warn", !dense && "mx-4")} data-testid="approval-clipped">
          It writes more than a card keeps: this is the start of the call as it was sent, and the rest is not shown here.
        </p>
      )}
      {/* Letters that are not plain ASCII and are not hidden either: named, since one can pass for a plain one. */}
      {alike.length > 0 && (
        <p className={cn("mt-1 text-micro text-warn", !dense && "mx-4")} data-testid="approval-nonascii">
          Not all of it is plain ASCII, and some of these can pass for plain letters:{" "}
          <span className="font-mono">{alike.slice(0, 6).map((c) => (c.shown ? `${c.shown} ${c.code}` : c.code)).join(", ")}</span>
          {alike.length > 6 ? `, and ${alike.length - 6} more` : ""}.
        </p>
      )}
      {rtl && (
        <p className={cn("mt-1 text-micro text-warn", !dense && "mx-4")} data-testid="approval-rtl">
          It holds letters written right to left: each word reads as written, and the words stand in the order the {a.kind === "shell" ? "command" : "text"} is written.
        </p>
      )}
      {/* Text that does not fit its box says so. (The control that opens and folds it leads the answers.) */}
      {(short || (whole && part)) && (
        <div className={cn("mt-1 flex flex-wrap items-center gap-x-2 text-micro", !dense && "mx-4")}>
          {short && (
            <span className="text-warn" data-testid="approval-cut">
              {part ? "Only the start is shown" : "Cut here"}{many && a.risk === "low" ? ", so it is answered on its own" : ""}
            </span>
          )}
          {whole && part && (
            <span className="text-muted">
              {typeof a.input?._clipped === "string" ? "The start of the input: the rest was not kept. It is answered on its own" : "The whole input. It is answered on its own"}
            </span>
          )}
        </div>
      )}
    </>
  );

  return (
    <div
      ref={root}
      // The keyboard can be brought to the card itself (a link that names it): it answers nothing there.
      tabIndex={-1}
      role="group"
      aria-labelledby={`${ids}-title`}
      aria-describedby={`${ids}-summary`}
      data-testid="approval"
      data-approval-id={a.id}
      data-tool={a.tool}
      data-risk={a.risk}
      data-many={many || undefined}
      data-dense={dense || undefined}
      data-hot={hot || undefined}
      data-live={live || undefined}
      data-must-open={mustOpen || undefined}
      data-unseen={unseen?.n}
      className={cn(
        // (Clipped to its corners without being a scroll box: its foot can stay in the region's view.)
        // (It fades in where it stands: its Allow acts once it stood still, so it does not slide in.)
        "k-approval group/card animate-appear overflow-clip rounded-2xl border bg-raised shadow-2 outline-none",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
        // A row: the request, then its answers beside it, or under it where the room ends.
        dense && "flex flex-wrap items-start",
      )}
      onKeyDown={(e) => {
        if (denying || closed || (e.target as HTMLElement).tagName === "INPUT") return;
        // (Not an Escape pressed as the keyboard arrived: it was meant for where the keyboard was.)
        // (Shift Escape is not the card's: in a look it leads back, lib/builtins.ts.)
        // (A key refused just before does not hold it: Escape opens the reason and answers nothing.)
        if (e.key === "Escape" && !e.shiftKey && keysArrived(e.currentTarget)) { e.preventDefault(); setDenying(true); }
      }}
    >
      {dense ? (
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 py-2 pl-3 pr-1">
          <span className="mt-0.5">{icon}</span>
          <div className="min-w-0 flex-1">
            {(!plain || fromCode || machine || place) && <div className="mb-1 flex flex-wrap items-center gap-2">{!plain && title}{machine}{place}{fromCode}</div>}
            {plain && title}
            {notice}
            {summary}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5 px-4 pt-3">
            {icon}
            {title}
            {machine}
            {place}
            {fromCode}
            {a.risk === "high" && (
              <span className="ml-auto rounded-full bg-danger-soft px-2 py-0.5 text-micro font-medium text-danger" data-testid="approval-risk">
                {a.why ? `High risk: ${a.why}` : "High risk"}
              </span>
            )}
          </div>
          {notice}
          {summary}
        </>
      )}
      {closed ? (
        <div className={cn(FOOT, "flex items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")} data-testid="approval-closed">
          <span className="min-w-0 flex-1 text-caption text-muted">This request is no longer open: {err}</span>
          <button type="button" data-stop="card" onClick={() => safety.loadSession(a.session_id).catch(reportError)} className="k-btn k-btn-lg shrink-0">
            Refresh
          </button>
        </div>
      ) : denying ? (
        <form
          className={cn(FOOT, "flex flex-wrap items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")}
          onSubmit={(e) => { e.preventDefault(); answer({ choice: "deny", reason }); }}
        >
          <input
            autoFocus
            data-testid="deny-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape" && !e.shiftKey && !composing(e)) { e.preventDefault(); e.stopPropagation(); leaveDeny(); } }}
            aria-label="Why you deny it (optional)"
            placeholder="Tell the model why, or what to do instead (optional)"
            className="k-field min-w-[min(100%,14rem)] flex-1"
          />
          <button type="submit" disabled={busy} data-testid="deny-send" className="h-8 rounded-lg bg-danger px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50">
            Send denial
          </button>
          <button type="button" onClick={leaveDeny} className="h-8 rounded-lg px-2.5 text-ui text-faint hover:bg-hover hover:text-fg" title="Back to the request (Esc)">
            Back
          </button>
          {err && <span className="basis-full text-micro text-danger" role="alert" data-testid="approval-error">{err}</span>}
        </form>
      ) : (
        // The three answers keep their order and wrap when the card is narrow: none is cut, Deny least of all.
        <div className={cn(FOOT, "flex flex-wrap items-center gap-1.5", dense ? "px-3 py-2" : "px-4 py-3")} data-testid="approval-actions">
          {longLine && <span className="order-first basis-full text-micro text-muted" role="status" data-testid="approval-long">{longLine}</span>}
          {/* A card that must be opened leads with the control that opens it: the step it asks for first. */}
          {slot.current && (
            <button
              type="button"
              data-testid="approval-expand"
              data-stop={shut ? "card" : undefined}
              data-wide={openLabel}
              aria-expanded={whole}
              aria-controls={`${ids}-summary`}
              onClick={() => onWhole(!whole)}
              className={cn(
                "k-ask-open h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised",
                // (A border in both looks: the control is as wide folded as open.)
                shut ? "border border-transparent bg-accent text-accent-fg hover:opacity-90" : "border border-line text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <span>{whole ? "Fold" : openLabel}</span>
            </button>
          )}
          {/* Marked disabled, not disabled, while it waits: it keeps the keyboard when the list moves, and a press does nothing. */}
          <button
            ref={once}
            disabled={busy}
            // (With the keyboard on it by the owner's own Tab or arrow, a key's times decide, as they do for a
            // pointer's press then. Else a pointer's: a page that moved the keyboard here may have moved it
            // under a pointer too, and the control is not drawn live before a press of it would count. The
            // card's hint and data-ready still say when Enter allows.)
            aria-disabled={(keysOn === "once" && keyedTo(once.current) ? !keyLive || mustOpenKey || hold.keys !== "ready" : !live || mustOpen) || undefined}
            data-nudge={nudge.mark}
            // The read-first latch is arming: Enter allows once in a moment (a line fills under the label meanwhile).
            data-arming={armingNow ? "" : undefined}
            data-ready={ready || undefined}
            data-testid="allow-once"
            data-stop={shut ? undefined : "card"}
            onPointerDown={(e) => {
              // Pressed where the owner's own key put the keyboard, ready for a key (it says "Enter allows once"):
              // the press is judged as a key's is (lib/approvals.ts, KEY_MS). It stood whole and still that
              // long, and the card shows it is ready; the press began with it there. Anywhere else a
              // pointer's press waits for the settle time of the control under it.
              // Only where the owner's own Tab or arrow put the keyboard: a request that came under the pointer and
              // whose Allow took the keyboard by itself was not seen by that hand, and its press waits the second.
              // (The keyboard's times as the press went down: when it arrived, and a key refused since. The press
              // has made the hold the owner's by the time this runs, lib/asks.ts.)
              heldDown.current = keyedTo(e.currentTarget) && !unreadKey.current && armedKey() && pressKeysSettled(e.currentTarget);
              pressed.onPointerDown();
            }}
            onMouseDown={pressed.onMouseDown}
            onClick={(e) => {
              const key = e.detail === 0 || heldDown.current;
              heldDown.current = false;
              const why = refusalOf(key ? false : pressed.said(e), key ? e.currentTarget : null);
              if (why) nudge.refuse(why, e.currentTarget);
              else answer({ choice: "once" });
            }}
            className={cn(
              "k-allow h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui font-medium disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised aria-disabled:cursor-default aria-disabled:opacity-50",
              // Behind the control that opens the text, it is the second step: drawn as one.
              shut ? "border border-line text-fg" : "bg-accent text-accent-fg hover:opacity-90",
            )}
          >
            Allow once{!touch && <Digit n={1} on={digits.once} />}
            {/* (Drawn anew with each arrival of the keyboard, so it fills for that arrival's settle time.) */}
            {armingNow && <span key={hold.at + hold.key} className="k-arm" aria-hidden="true" data-testid="allow-arming" style={{ "--k-arm": `${armFor}ms` } as CSSProperties} />}
          </button>
          {nudge.line}
          {a.risk === "low" && a.suggest.length > 0 && <AlwaysButton a={a} digits={touch ? null : digits.always} busy={busy} live={grant && !mustOpen} armed={() => !unread.current && armed("grant")} refusal={refusalOf} unread={mustOpen} onGrant={(rules, session) => { if (!unread.current) answer({ choice: session ? "session" : "always", rules }); }} />}
          <button
            disabled={busy}
            data-testid="deny"
            onClick={() => setDenying(true)}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            Deny{!touch && <Digit n={3} on={digits.deny} />}
          </button>
          {err ? <span className={cn("ml-auto min-w-0 basis-full text-micro text-danger", !dense && "sm:basis-auto sm:truncate")} role="alert" title={err} data-testid="approval-error">{err}</span>
            // Why the answers wait, beside them, before anything was pressed: the text is to be opened
            // (the list's Enter does that while the list has the keyboard), or so many of its lines have
            // not been in view. (In the answers' own row, so the card keeps its height when it goes.)
            // The room of these lines is held, so the answers beside them never wrap anew under the text as
            // one line gives way to another (the text would then fit, the line go, and the text be cut again:
            // a card drawn one way, then the other, and no Allow on the list ever standing still). A card that
            // must be opened holds the room of all its opening words; a row (a dense card) once cut, or once
            // to be opened, holds that and the room of its longest count of lines not seen (with the key
            // that reads on, whether it is named now or not), whether a line shows or not. (That it stays cut while it waits is the other half: useReadings.)
            : shut || left > 0 || (dense && (cut || slot.current)) ? (
              <span className="ml-auto grid justify-items-end text-micro text-warn">
                {(shut || dense) && [`${tapSays}.`, `${enterSays}.`, `${openFirst}.`, ...(dense ? [`${count(unseen?.total ?? 0)} not seen yet. End reads on`] : [])].map((w) => <span key={w} className="invisible col-start-1 row-start-1" aria-hidden="true">{w}</span>)}
                {shut ? <span className="col-start-1 row-start-1" role="status" data-testid="approval-open-first">{touch ? tapSays : enterOpens ? enterSays : openFirst}.</span>
                  : left > 0 ? <span className="col-start-1 row-start-1 tabular-nums" role="status" data-testid="approval-left">{leftText}{readKey && <span className="text-faint max-sm:hidden" data-testid="approval-read-key">. End reads on</span>}</span> : null}
              </span>
            )
            // What Enter does, true at every moment. "Enter allows once" stands only while its Allow has
            // the keyboard and a press would answer. Before that, while the keyboard is on its way to the
            // Allow or the Allow still waits out its settle time, the line says so, dimmer; for a
            // request that asks for a second look it says how to reach the answer. The longest line the
            // card can say holds the room, so nothing moves as one gives way to another.
            : !dense && (
              <span className="ml-auto grid justify-items-end text-micro text-faint max-sm:hidden pointer-coarse:hidden">
                <span className="invisible col-start-1 row-start-1" aria-hidden="true">Enter allows once, Esc to deny with a reason</span>
                {heldLine && <span className="invisible col-start-1 row-start-1" aria-hidden="true">{heldLine}</span>}
                {ready ? <span className="col-start-1 row-start-1" data-testid="approval-hint">Enter allows once, Esc to deny with a reason</span>
                  : arming ? <span className="col-start-1 row-start-1 opacity-70" data-testid="approval-arming">{arming}</span>
                  : null}
              </span>
            )}
        </div>
      )}
    </div>
  );
}

// An answer's number, after its label, shown while the number answers (bridge.css: .k-digit). Its room
// is always there on a keyboard's screen: a control that grew as the numbers came would move under a
// pointer pressing it (and a control that moved waits again before a press counts).
function Digit({ n, on }: { n: number; on: boolean }) {
  // (The number is drawn by the style sheet from data-n, so it is no part of the answer's text or name: Allow once reads "Allow once".)
  return <kbd aria-hidden="true" className="k-digit k-cap-n" data-n={n} data-on={on || undefined} data-testid={on ? "approval-digit" : undefined} />;
}
// The answers a number names on an approval card, in their order on it.
const ANSWER_KEYS = ["allow-once", "allow-always", "deny"] as const;

// A card's foot: its answers (or the reason form, or the note that it is closed). While a card
// taller than the region above the message box is being read, the foot stays in the region's
// view (bridge.css, on the card's data-foot: at the region's foot, or under the list's bar for a
// row whose answers stand beside its text), so what is left to read is said and Deny can be
// pressed without scrolling to the card's end.
const FOOT = "k-ask-foot z-[1] bg-raised";
// What a card says while Enter is about to allow once (its Allow shows the arming line meanwhile).
const ARMING = "Enter allows once in a moment";

const KIND_LABEL = { shell: "Commands", edit: "Edits under", tool: "Tool" } as const;

// `live` and `armed`: as the card's Allow once, the grant does not open within the settle time.
// `unread`: the card is not all read: a grant opened while it was (the window was resized since,
// and the text wraps anew or is cut) closes, and grants nothing.
function AlwaysButton({ a, digits, busy, live, armed, refusal, unread, onGrant }: { a: Approval; digits: boolean | null; busy: boolean; live: boolean; armed: () => boolean; refusal: (stood: boolean, key: Element | null) => string; unread: boolean; onGrant: (rules: Suggest[], session: boolean) => void }) {
  const [rules, setRules] = useState<Suggest[]>(a.suggest);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (unread) setOpen(false); }, [unread]);
  const pressed = usePress(armed, (ok) => ok);
  const nudge = useNudge();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Popover.Root open={open} onOpenChange={(o, d) => {
      if (!o) return setOpen(o);
      const detail = (d.event as { detail?: number }).detail ?? 0;
      // A key opens the choices only while they are drawn live, as a pointer's press does: its number
      // is drawn on it only then (the choices grant nothing by themselves, a second press does).
      const why = refusal(pressed.said({ detail }), detail === 0 ? document.activeElement : null) || (detail === 0 && !live ? refusal(false, null) : "");
      if (why) nudge.refuse(why, trigger.current);
      else setOpen(o);
    }}>
      <Popover.Trigger
        ref={trigger}
        disabled={busy}
        data-nudge={nudge.mark}
        onPointerDown={pressed.onPointerDown}
        onMouseDown={pressed.onMouseDown}
        aria-disabled={!live || undefined}
        data-testid="allow-always"
        className="k-btn k-btn-lg k-grant shrink-0 gap-1 whitespace-nowrap data-popup-open:bg-hover aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
      >
        Always allow <ChevronDown className="size-3.5 text-faint" />{digits !== null && <Digit n={2} on={digits} />}
      </Popover.Trigger>
      {nudge.line}
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          {/* (Marked as a part of the card: a press in it is a press on the card, for the answering sequence and for the hand-back.) */}
          <Popover.Popup data-ask-part="" className="w-[min(26rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-3 shadow-2 transition-[scale,opacity] data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
            <Popover.Title className="text-ui font-medium">Grant</Popover.Title>
            <Popover.Description className="mt-0.5 text-caption text-muted">
              {a.kind === "shell" ? "A trailing * covers any arguments. Edit the rule to narrow it." : "Calls this rule covers run without asking."}
            </Popover.Description>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {rules.map((r, i) => (
                <label key={i} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-caption text-faint">{KIND_LABEL[r.kind]}</span>
                  <input
                    data-testid="grant-pattern"
                    value={r.pattern}
                    onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
                    className="k-field min-w-0 flex-1 font-mono text-caption"
                  />
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-1.5">
              <button
                data-testid="grant-always"
                onClick={() => { setOpen(false); onGrant(rules, false); }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90"
              >
                <Check className="size-3.5" /> In this folder
              </button>
              <button
                data-testid="grant-session"
                onClick={() => { setOpen(false); onGrant(rules, true); }}
                className="k-btn k-btn-lg"
              >
                This session only
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// A session that waits on the owner's answer, in the session list.
