import { Popover } from "@base-ui/react/popover";
import { Check, CheckCheck, ChevronDown, FilePen, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { shownInPart } from "../../../src/safety/summary.ts";
import { batches, batchName, coverName, hold, nextAction, pressable, READ_MS, sawLines, settled, SETTLE_MS, spentAction, stand, unseenLines, type Action, type Batch, type Hold, type Lines, type Stand } from "../lib/approvals.ts";
import { arrivalOf, arriving } from "../lib/automation.ts";
import { wasBrought } from "../lib/shell.ts";
import { editBody, type EditBody } from "../lib/edit-body.ts";
import { hasHidden, hasRtl, lookAlikes, spellHidden } from "../lib/hidden-chars.ts";
import { dropRepeats, keyRefused, keysSettled, mayTake, noteAnswer, sequenceAt, takeKeys, typeToBox, useHold } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
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
  refused: "Refused",
};
const ICON = { shell: SquareTerminal, edit: FilePen, other: Wrench, read: Wrench, drive: MessageSquareShare, refused: X };
const EMPTY: Approval[] = [];

// What the list knows of its cards from where they stand on screen.
// - `read`: the request's text has stood whole on screen for the settle time.
// - `live`: its Allow once may be pressed (lib/approvals.ts: pressable). `grant`: the same for its Always allow.
// - `ripe`: the card has been on the page for the settle time (it may take the keyboard).
// - `cut`: its text is longer than the box that shows it.
// - `unseen`: the rows of its text, as it wraps now, that have not been in view (`n`, of `total`),
//   and how many of those the owner has to bring into view (`out`: lib/approvals.ts, sawLines).
//   A card is answered when none is left.
// - `acts`: each "allow all" action, by tool: what it covers and whether it can be pressed.
type Unseen = { n: number; out: number; begun: boolean; total: number };
type View = { read: Set<string>; live: Set<string>; grant: Set<string>; ripe: Set<string>; cut: Set<string>; unseen: Map<string, Unseen>; acts: Map<string, Action>; key: string };
const NO_VIEW: View = { read: new Set(), live: new Set(), grant: new Set(), ripe: new Set(), cut: new Set(), unseen: new Map(), acts: new Map(), key: "" };
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
type Reading = { born: number; sum?: Stand; once?: Hold; always?: Hold; cut: boolean };
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
// Where an element is, and whether all of it shows: inside the clip and, for text that is
// to be read or pressed (`open`), with nothing lying over its middle. (A pointer cannot
// press a control something lies over, but a key can: such a control does not act.)
function seenAt(el: HTMLElement, c: Clip, open = false) {
  const r = el.getBoundingClientRect();
  let whole = r.width > 0 && r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
  if (whole && open) {
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    whole = !!top && el.contains(top);
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
  if (!over || !pre.contains(over)) return { total, line, view: null };
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
    cards, seen: new Map<string, Reading>(), lines: new Map<string, Lines>(), acts: new Map<string, Action>(), hot: new Set<string>(), spent: new Set<string>(), view: NO_VIEW,
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
  const tick = useCallback((why?: "timer" | "scrollend"): View => {
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
        const tall = !!under && under.height > 0 && box.height > room && under.height * 3 <= room && box.bottom > f.shown.bottom + 1 && box.top < f.shown.bottom;
        el.toggleAttribute("data-foot", tall && (el.hasAttribute("data-foot") || (!!words && words.bottom > f.shown.bottom + 1 && words.top < f.shown.bottom)));
        const text = sum ? clipUnder(sum, foot, f.text) : f.text;
        // The view moved by the owner's own scroll when their hand came first and nothing in the list changed.
        if (sum) s.lines.set(id, sawLines(s.lines.get(id), rowsInView(sum, text), s.input && !listChanged, now));
        seen.set(id, {
          born: was?.born ?? now,
          sum: sum ? stand(was?.sum, seenAt(sum, text, true).at, now) : undefined,
          once: control(part("allow-once"), was?.once),
          always: control(part("allow-always"), was?.always),
          cut: !!sum && sum.scrollHeight > sum.clientHeight + 1,
        });
      }
    }
    s.seen = seen;
    // What was read of a text is kept while its request waits, also over a time the page was hidden
    // (where nothing shows and nothing more is read).
    for (const [id, l] of s.lines) {
      if (!s.cards.some((c) => c.id === id)) s.lines.delete(id);
      else if (!f) s.lines.set(id, { ...l, view: null, since: now });
    }
    const read = new Set<string>(), live = new Set<string>(), grant = new Set<string>(), ripe = new Set<string>(), cut = new Set<string>(), unseen = new Map<string, Unseen>();
    for (const [id, l] of s.lines) unseen.set(id, { ...unseenLines(l), total: l.total });
    for (const [id, r] of seen) {
      const old = now - r.born >= SETTLE_MS;
      if (settled(r.sum, now)) read.add(id);
      if (pressable(r.once, old, s.scrolling, now)) live.add(id);
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
    const key = JSON.stringify([[...read], [...live], [...grant], [...ripe], [...cut], [...unseen].map(([id, u]) => [id, u.n, u.out, u.begun, u.total]), [...acts].map(([tool, a]) => [tool, a.covered, a.live])]);
    if (key !== s.view.key) setView((s.view = { read, live, grant, ripe, cut, unseen, acts, key }));
    return s.view;
  }, [list]);
  const any = cards.length > 0;
  useEffect(() => {
    const root = list.current;
    if (!any || !root) return;
    const tray = root.closest<HTMLElement>('[data-testid="composer-tray"]');
    const read = () => { tick(); };
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
export function Approvals({ sessionId, asker }: { sessionId: string; asker?: string }) {
  const cards = useSafety((s) => s.approvals[sessionId] ?? EMPTY);
  const list = useRef<HTMLDivElement>(null);
  const { view, tick, waiting, setHot, spend } = useReadings(list, cards);
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
      className="k-allow-all inline-flex h-ctl-lg items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-raised"
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
function Card({ a, first, asker, list, many, plain, hot, locked, ripe, live, grant, armed, read, cut, unseen, whole, onWhole, enterOpens, keysOn, touch }: {
  a: Approval; first: boolean; asker?: string; list: RefObject<HTMLDivElement | null>; many: boolean; plain: boolean;
  hot: boolean; locked: boolean; ripe: boolean; live: boolean; grant: boolean; armed: (which: "live" | "grant") => boolean; read: () => unknown; cut: boolean; unseen?: Unseen;
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
  const [told, setTold] = useState(false);
  const left = unseen && (unseen.begun || told) ? unseen.out : 0;
  // What is counted is what is seen: the text's lines where none of them wraps, and rows (the
  // lines as the card draws them) where one does, so one long line is not called twenty.
  const kept = part ? (typeof a.input?._clipped === "string" ? a.input._clipped : JSON.stringify(a.input ?? {}, null, 2)) : "";
  const written = (whole && part ? kept : shown.text).replace(/\n$/, "").split("\n").length;
  const unit = unseen && unseen.total !== written ? "row" : "line";
  const count = (n: number) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const leftText = `${count(left)} not seen yet`;
  const shut = mustBeOpened(a, whole, cut, unseen);
  const shutNow = useRef(shut);
  shutNow.current = shut;
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
  const mayHold = () => !unread.current && inView() && !heldWhy;
  const refusalOf = (stood: boolean, key: Element | null): string => {
    // Not read: the text is to be opened first, or so many of its lines have not been in view.
    // (Said on the card from then on, where its text is all out of view and it said nothing by itself.)
    if (unread.current) { refused(); return shut ? openFirst : notYet; }
    if (!stood) return notYet;
    return key ? keyRefused(key) : "";
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
    if (arrival.to === "deny") { setReason((r) => r + arrival.typed); setDenying(true); }
    else if (arrival.to === "card") takeKeys(list.current, true, false);
    // (A card whose text must be opened is read on the list first, where Enter opens it; any other
    // takes the keyboard itself, and its Allow takes it from there once the card is read.)
    else if (shutNow.current) takeKeys(list.current, true);
    else takeKeys(root.current, true);
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
    if (!live && onceInRegion()) return;
    moved.current = hold.at;
    once.current?.focus({ preventScroll: true });
  }, [hold.keys, hold.take, hold.at, live, mustOpen]);
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
    if (!((shut && at === root.current) || (mustOpen && onAnswer))) return;
    moved.current = 0;
    if (shut || first) toList();
    else root.current.focus({ preventScroll: true });
  }, [mustOpen, shut]);
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
  // What the hint line may say (see where it is drawn): `ready` exactly when Enter on its Allow
  // would answer; `arming` while the page is about to make that so, or how to get there.
  const ready = keysOn === "once" && live && !mustOpen && hold.keys === "ready";
  const coming = keysOn === "card" || (keysOn === "list" && first);
  const heldLine = heldWhy ? `${heldWhy}: Down, then Enter allows once` : "";
  const arming = ready || shut || left > 0 ? ""
    : keysOn === "once" ? "Enter allows once in a moment"
    : !coming ? ""
    : heldWhy ? (mustOpen ? "" : heldLine)
    // (Only while the Allow is still to take the keyboard for this arrival: else Enter stays where
    // it is, as it does for an owner brought here from outside the page.)
    : hold.take && moved.current !== hold.at && (!wasBrought() || chosen.current) ? "Enter allows once in a moment"
    : "";

  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    noteAnswer(a.id);
    // (The grant's popup is the card's own, drawn outside it: an answer given there held the keyboard too.)
    held.current = !!root.current?.contains(document.activeElement) || !!document.activeElement?.closest("[data-ask-part]");
    setAnswering(true);
    setErr("");
    try {
      await safety.answer(a.session_id, a.id, body);
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
        "k-approval group/card animate-in overflow-clip rounded-2xl border bg-raised shadow-2 outline-none",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
        // A row: the request, then its answers beside it, or under it where the room ends.
        dense && "flex flex-wrap items-start",
      )}
      onKeyDown={(e) => {
        if (denying || closed || (e.target as HTMLElement).tagName === "INPUT") return;
        // (Not an Escape pressed as the keyboard arrived: it was meant for where the keyboard was.)
        if (e.key === "Escape" && keysSettled(e.currentTarget)) { e.preventDefault(); setDenying(true); }
      }}
    >
      {dense ? (
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 py-2 pl-3 pr-1">
          <span className="mt-0.5">{icon}</span>
          <div className="min-w-0 flex-1">
            {(!plain || fromCode || machine) && <div className="mb-1 flex flex-wrap items-center gap-2">{!plain && title}{machine}{fromCode}</div>}
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
          <button type="button" data-stop="card" onClick={() => safety.loadSession(a.session_id).catch(reportError)} className="h-8 shrink-0 rounded-lg border border-line px-3 text-ui hover:bg-hover">
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
            onKeyDown={(e) => { if (e.key === "Escape" && !composing(e)) { e.preventDefault(); e.stopPropagation(); leaveDeny(); } }}
            aria-label="Why you deny it (optional)"
            placeholder="Tell the model why, or what to do instead (optional)"
            className="h-8 min-w-[min(100%,14rem)] flex-1 rounded-lg border border-line bg-bg px-3 text-ui outline-none placeholder:text-faint focus:border-line-strong"
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
            aria-disabled={!live || mustOpen || undefined}
            data-nudge={nudge.mark}
            data-testid="allow-once"
            data-stop={shut ? undefined : "card"}
            onPointerDown={pressed.onPointerDown}
            onMouseDown={pressed.onMouseDown}
            onClick={(e) => {
              const why = refusalOf(pressed.said(e), e.detail === 0 ? e.currentTarget : null);
              if (why) nudge.refuse(why, e.currentTarget);
              else answer({ choice: "once" });
            }}
            className={cn(
              "k-allow h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui font-medium disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised aria-disabled:cursor-default aria-disabled:opacity-50",
              // Behind the control that opens the text, it is the second step: drawn as one.
              shut ? "border border-line text-fg" : "bg-accent text-accent-fg hover:opacity-90",
            )}
          >
            Allow once
          </button>
          {nudge.line}
          {a.risk === "low" && a.suggest.length > 0 && <AlwaysButton a={a} busy={busy} live={grant && !mustOpen} armed={() => !unread.current && armed("grant")} refusal={refusalOf} unread={mustOpen} onGrant={(rules, session) => { if (!unread.current) answer({ choice: session ? "session" : "always", rules }); }} />}
          <button
            disabled={busy}
            data-testid="deny"
            onClick={() => setDenying(true)}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            Deny
          </button>
          {err ? <span className={cn("ml-auto min-w-0 basis-full text-micro text-danger", !dense && "sm:basis-auto sm:truncate")} role="alert" title={err} data-testid="approval-error">{err}</span>
            // Why the answers wait, beside them, before anything was pressed: the text is to be opened
            // (the list's Enter does that while the list has the keyboard), or so many of its lines have
            // not been in view. (In the answers' own row, so the card keeps its height when it goes.)
            : shut ? <span className="ml-auto text-micro text-warn" role="status" data-testid="approval-open-first">{touch ? tapSays : enterOpens ? enterSays : openFirst}.</span>
            : left > 0 ? <span className="ml-auto text-micro text-warn tabular-nums" role="status" data-testid="approval-left">{leftText}</span>
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

// A card's foot: its answers (or the reason form, or the note that it is closed). While a card
// taller than the region above the message box is being read, the foot stays in the region's
// view (bridge.css, on the card's data-foot: at the region's foot, or under the list's bar for a
// row whose answers stand beside its text), so what is left to read is said and Deny can be
// pressed without scrolling to the card's end.
const FOOT = "k-ask-foot z-[1] bg-raised";

const KIND_LABEL = { shell: "Commands", edit: "Edits under", tool: "Tool" } as const;

// `live` and `armed`: as the card's Allow once, the grant does not open within the settle time.
// `unread`: the card is not all read: a grant opened while it was (the window was resized since,
// and the text wraps anew or is cut) closes, and grants nothing.
function AlwaysButton({ a, busy, live, armed, refusal, unread, onGrant }: { a: Approval; busy: boolean; live: boolean; armed: () => boolean; refusal: (stood: boolean, key: Element | null) => string; unread: boolean; onGrant: (rules: Suggest[], session: boolean) => void }) {
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
      const why = refusal(pressed.said({ detail }), detail === 0 ? document.activeElement : null);
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
        className="k-grant inline-flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg border border-line px-3 text-ui hover:bg-hover data-popup-open:bg-hover disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
      >
        Always allow <ChevronDown className="size-3.5 text-faint" />
      </Popover.Trigger>
      {nudge.line}
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          {/* (Marked as a part of the card: a press in it is a press on the card, for the answering sequence and for the hand-back.) */}
          <Popover.Popup data-ask-part="" className="w-[min(26rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-3 shadow-2 transition-[scale,opacity] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
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
                    className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg px-2.5 font-mono text-caption outline-none focus:border-line-strong"
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
                className="h-8 rounded-lg border border-line px-3 text-ui hover:bg-hover"
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
