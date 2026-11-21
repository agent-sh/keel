import { Popover } from "@base-ui/react/popover";
import { Check, CheckCheck, ChevronDown, FilePen, MessageSquareShare, ShieldAlert, SquareTerminal, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { shownInPart } from "../../../src/safety/summary.ts";
import { batches, batchName, coverName, hold, nextAction, pressable, READ_MS, settled, SETTLE_MS, spentAction, stand, type Action, type Batch, type Hold, type Stand } from "../lib/approvals.ts";
import { arrivalOf, arriving } from "../lib/automation.ts";
import { hasHidden, hasRtl } from "../lib/hidden-chars.ts";
import { mayTakeFocus } from "../lib/asks.ts";
import { composing } from "../lib/keys.ts";
import { safety, useSafety, type Approval, type Suggest } from "../lib/safety.ts";
import { failed, reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { BlockedCards } from "./BlockedCards.tsx";
import { Spelled } from "./Spelled.tsx";
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
// - `acts`: each "allow all" action, by tool: what it covers and whether it can be pressed.
type View = { read: Set<string>; live: Set<string>; grant: Set<string>; ripe: Set<string>; cut: Set<string>; acts: Map<string, Action>; key: string };
const NO_VIEW: View = { read: new Set(), live: new Set(), grant: new Set(), ripe: new Set(), cut: new Set(), acts: new Map(), key: "" };
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
// to be read (`open`), with nothing lying over its middle. (A control something lies over
// cannot be pressed by a pointer at all, so it is not asked.)
function seenAt(el: HTMLElement, c: Clip, open = false) {
  const r = el.getBoundingClientRect();
  let whole = r.width > 0 && r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
  if (whole && open) {
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    whole = !!top && el.contains(top);
  }
  return { r, at: { x: r.left, y: r.top, whole } };
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
    cards, seen: new Map<string, Reading>(), acts: new Map<string, Action>(), hot: new Set<string>(), spent: new Set<string>(), view: NO_VIEW,
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
          const at = seenAt(c, f.shown);
          return hold(prev, at.at, f.inList(at.r), s.input, listChanged, now);
        };
        seen.set(id, {
          born: was?.born ?? now,
          sum: sum ? stand(was?.sum, seenAt(sum, f.text, true).at, now) : undefined,
          once: control(part("allow-once"), was?.once),
          always: control(part("allow-always"), was?.always),
          cut: !!sum && sum.scrollHeight > sum.clientHeight + 1,
        });
      }
    }
    s.seen = seen;
    const read = new Set<string>(), live = new Set<string>(), grant = new Set<string>(), ripe = new Set<string>(), cut = new Set<string>();
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
    // A text with marked characters is read and answered on its own, as one cut by its box is.
    const alone = new Set([...cut, ...s.cards.filter((c) => hasHidden(c.summary, "\n\t")).map((c) => c.id)]);
    for (const g of batches(s.cards, read, alone)) acts.set(g.tool, nextAction(s.acts.get(g.tool), g.ids, s.hot.has(g.tool), now, open));
    s.acts = acts;
    const key = JSON.stringify([[...read], [...live], [...grant], [...ripe], [...cut], [...acts].map(([tool, a]) => [tool, a.covered, a.live])]);
    if (key !== s.view.key) setView((s.view = { read, live, grant, ripe, cut, acts, key }));
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
    if (tray) {
      sized.observe(tray);
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
  const groups = batches(waiting, view.read, new Set([...view.cut, ...waiting.filter((c) => hasHidden(c.summary, "\n\t")).map((c) => c.id)]));
  const [hot, setHotTools] = useState<string[]>([]); // the tools whose action the pointer or the keyboard is on
  const [at, setAt] = useState<{ on: "once" | "all" | "row"; id?: string } | null>(null); // where the keyboard is in the list
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
    for (const x of [bar, el, tray]) if (x) sized.observe(x);
    fit();
    return () => sized.disconnect();
  }, [many]);

  const allowAll = async (tool: string, ids: string[]) => {
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
    // Words typed while a card has the keyboard are for the message box: they go there, and so does the Enter after them.
    if (e.key.length === 1 && e.key !== " ") {
      e.currentTarget.closest(".k-session")?.querySelector<HTMLElement>('[data-testid="composer"]')?.focus({ preventScroll: true });
      return;
    }
    // Up and Down move between the list's stops: the "allow all" action, then each card's first answer.
    if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.shiftKey) return;
    const stops = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-stop]:not(:disabled)")];
    const i = stops.findIndex((s) => s === t || (s.dataset.stop === "card" && !!s.closest('[data-testid="approval"]')?.contains(t)));
    const down = e.key === "ArrowDown";
    const to = i >= 0 ? stops[i + (down ? 1 : -1)]
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
    setAt(!e.currentTarget.contains(t) || t.tagName === "INPUT" ? null : t.dataset.testid === "allow-once" ? { on: "once", id } : t.dataset.testid === "allow-all" ? { on: "all" } : id ? { on: "row", id } : null);
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
          role="region"
          aria-label={`${asker ? `${asker}: ` : ""}${cards.length === 1 ? "1 request waits" : `${cards.length} requests wait`} for your answer`}
          className={cn("k-ask-list mb-2 flex flex-col outline-none", many ? "gap-1.5" : "gap-2")}
          data-testid="approvals"
          onKeyDown={onKeyDown}
          // A key held down answers once: its repeats press nothing here (a button, the reason field's Enter).
          onKeyDownCapture={(e) => { if (e.key === "Enter" && e.repeat) e.preventDefault(); }}
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
                  : at?.on === "once" && view.live.has(at.id!) ? "Up and Down choose, Enter allows the framed one once"
                  : at?.on === "once" || at?.on === "row" ? "Up and Down choose a request"
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
              armed={(which) => tick()[which].has(a.id)}
              cut={view.cut.has(a.id)}
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
function useNudge() {
  const [why, setWhy] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    mark: why ? true : undefined,
    line: <span className="sr-only" role="status" data-testid="approval-refused">{why}</span>,
    refuse: (reason: string) => {
      window.clearTimeout(timer.current);
      setWhy(reason);
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
      else if (matchMedia("(min-width: 768px)").matches) box?.focus({ preventScroll: true });
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
        if (now && now.length > 1) onAllow(now);
        else nudge.refuse("Not yet: it covers requests once they have stood still for a second");
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
// for its Always allow; `armed` asks either at the instant of a press. `ripe`:
// it has been on the page that long. `cut`: its text is longer than its box.
function Card({ a, first, asker, list, many, plain, hot, locked, ripe, live, grant, armed, cut }: {
  a: Approval; first: boolean; asker?: string; list: RefObject<HTMLDivElement | null>; many: boolean; plain: boolean;
  hot: boolean; locked: boolean; ripe: boolean; live: boolean; grant: boolean; armed: (which: "live" | "grant") => boolean; cut: boolean;
}) {
  const dense = many && a.risk !== "high"; // a high-risk request keeps its whole card, with why it is one
  const Icon = a.risk === "high" ? ShieldAlert : ICON[a.kind];
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [answering, setAnswering] = useState(false);
  const [err, setErr] = useState("");
  const [closed, setClosed] = useState(false); // the daemon says it can no longer be answered
  const [whole, setWhole] = useState(false); // opened to its full text
  const root = useRef<HTMLDivElement>(null);
  const once = useRef<HTMLButtonElement>(null);
  const ids = `approval-${a.id}`;
  const busy = answering || locked;
  // A request is answered only for what was read. While its text is not all on
  // the card (cut by its box, shown only in part by the daemon, or holding a
  // character that had to be spelled out), the card takes no answer and never
  // has the keyboard on one: Allow once and Always allow refuse, and say to
  // open the whole text first. Opening it is the owner's own act.
  const part = shownInPart(a); // the daemon kept more of the input than the card shows
  const marked = hasHidden(a.summary, "\n\t");
  const mustOpen = !whole && (cut || part || marked);
  const unread = useRef(mustOpen);
  unread.current = mustOpen;
  const openFirst = `Open the whole ${a.kind === "shell" ? "command" : "text"} first`;
  const [told, setTold] = useState(false); // a press was refused for that reason: said on the card until it is opened
  const toList = () => list.current?.focus({ preventScroll: true });
  // Whether the card is in the window: a page of a phone's track that is not the one shown takes no keyboard.
  const inView = () => { const r = root.current?.getBoundingClientRect(); return !!r && r.width > 0 && r.right > 0 && r.left < innerWidth; };
  // Take focus so Enter answers, unless the owner is busy elsewhere: once, and
  // not while the card is new. A card that has just been drawn takes nothing:
  // an Enter on its way to the message box never lands on it. (Where the Allow
  // was out of view, the region brings it in, and it acts a moment after that.)
  // An arrival that asked for the list, or for the denial, is honoured instead,
  // however late the card is drawn (lib/automation.ts).
  const asked = useRef(false);
  const arrive = () => {
    const arrival = arrivalOf(a.id);
    if (!arrival) return false;
    asked.current = true;
    if (arrival.to === "deny") { setReason((r) => r + arrival.typed); setDenying(true); }
    else if (arrival.to === "card" || unread.current) toList();
    else once.current?.focus({ preventScroll: true });
    return true;
  };
  useEffect(() => {
    arrive();
    const el = root.current;
    const on = () => void arrive();
    el?.addEventListener("keel:arrive", on);
    return () => el?.removeEventListener("keel:arrive", on);
  }, []);
  useEffect(() => {
    if (!first || !ripe || asked.current || arriving(a.id)) return;
    asked.current = true;
    if (!mayTakeFocus() || !inView()) return;
    if (unread.current) toList();
    else once.current?.focus({ preventScroll: true });
  }, [first, ripe]);
  // The keyboard never rests on an answer of a card that is not all read (its text was found cut after the keyboard came).
  useEffect(() => {
    const at = document.activeElement as HTMLElement | null;
    if (mustOpen && at && root.current?.contains(at) && (at.dataset.testid === "allow-once" || at.dataset.testid === "allow-always")) toList();
  }, [mustOpen]);
  const held = useHandBack(root, list);
  // Leaving the reason (Esc, Back) puts the keyboard where the card's own rule would: on
  // Allow once for a card that is whole and read, so Enter answers again, and on the list
  // of requests for one whose text is not all on it. It is never lost to the page.
  const back = useRef(false);
  const leaveDeny = () => { back.current = true; setDenying(false); };
  useEffect(() => {
    if (denying || !back.current) return;
    back.current = false;
    if (unread.current) toList();
    else once.current?.focus({ preventScroll: true });
  }, [denying]);
  const pressed = usePress(() => !unread.current && armed("live"), (ok) => ok);
  const nudge = useNudge();
  // Why a press on one of its answers does nothing now.
  const notYet = ripe ? "Not yet: it moved a moment ago" : "Not yet: it has only just arrived";

  const answer = async (body: { choice: string; reason?: string; rules?: Suggest[] }) => {
    held.current = !!root.current?.contains(document.activeElement);
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
  // The whole of what the daemon kept of the input, when the card shows only its start.
  const kept = part ? (typeof a.input?._clipped === "string" ? a.input._clipped : JSON.stringify(a.input ?? {}, null, 2)) : "";
  const short = !whole && (cut || part);
  const summary = (
    <>
      <pre
        id={`${ids}-summary`}
        className={cn(
          "overflow-auto bg-code font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
          // A command is shown in the order it is written: letters written right to left are not reordered among the rest.
          a.kind === "shell" && "[direction:ltr] [unicode-bidi:bidi-override]",
          dense ? "rounded-md px-2.5 py-1.5" : "mx-4 mt-2.5 rounded-lg px-3 py-2",
          !whole && (dense ? "max-h-32" : "max-h-48"),
        )}
        data-testid="approval-summary"
        data-cut={short || undefined}
      >
        {a.kind === "shell" && <span className="select-none text-accent">$ </span>}
        <Spelled text={whole && part ? kept : a.summary} />
      </pre>
      {/* A character that hides or reorders text is spelled out above, and the card says that it did so. */}
      {hasHidden(a.summary, "\n\t") && (
        <p className={cn("mt-1 text-micro text-danger", !dense && "mx-4")} data-testid="approval-hidden">
          This text holds characters that do not show as written. Each is spelled out and marked.
        </p>
      )}
      {a.kind === "shell" && hasRtl(a.summary) && (
        <p className={cn("mt-1 text-micro text-warn", !dense && "mx-4")} data-testid="approval-rtl">
          It holds letters written right to left: they are shown in the order the command is written.
        </p>
      )}
      {/* Text that does not fit its box says so, and opens in place. Cut, it is read and answered on its own. */}
      {(short || whole || marked) && (
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
          <button
            type="button"
            data-testid="approval-expand"
            aria-expanded={whole}
            aria-controls={`${ids}-summary`}
            onClick={() => { setWhole(!whole); setTold(false); }}
            className="k-link rounded-sm text-accent-ink underline underline-offset-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
          >
            {whole ? "Fold" : a.kind === "shell" ? "Show the whole command" : "Show all of it"}
          </button>
          {/* Said once a press was refused for it, where the control that opens the text is. */}
          {mustOpen && told && <span className="text-warn" role="status" data-testid="approval-open-first">{openFirst}.</span>}
        </div>
      )}
    </>
  );

  return (
    <div
      ref={root}
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
      className={cn(
        "k-approval group/card animate-in overflow-hidden rounded-2xl border bg-raised shadow-2",
        a.risk === "high" ? "border-danger/50" : "border-accent/40",
        // A row: the request, then its answers beside it, or under it where the room ends.
        dense && "flex flex-wrap items-start",
      )}
      onKeyDown={(e) => {
        if (denying || closed || (e.target as HTMLElement).tagName === "INPUT") return;
        if (e.key === "Escape") { e.preventDefault(); setDenying(true); }
      }}
    >
      {dense ? (
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 py-2 pl-3 pr-1">
          <span className="mt-0.5">{icon}</span>
          <div className="min-w-0 flex-1">
            {(!plain || fromCode) && <div className="mb-1 flex flex-wrap items-center gap-2">{!plain && title}{fromCode}</div>}
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
        <div className={cn("flex items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")} data-testid="approval-closed">
          <span className="min-w-0 flex-1 text-caption text-muted">This request is no longer open: {err}</span>
          <button type="button" data-stop="card" onClick={() => safety.loadSession(a.session_id).catch(reportError)} className="h-8 shrink-0 rounded-lg border border-line px-3 text-ui hover:bg-hover">
            Refresh
          </button>
        </div>
      ) : denying ? (
        <form
          className={cn("flex flex-wrap items-center gap-2", dense ? "basis-full px-3 pb-2" : "px-4 py-3")}
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
        <div className={cn("flex flex-wrap items-center gap-1.5", dense ? "px-3 py-2" : "px-4 py-3")} data-testid="approval-actions">
          {/* Marked disabled, not disabled, while it waits: it keeps the keyboard when the list moves, and a press does nothing. */}
          <button
            ref={once}
            disabled={busy}
            aria-disabled={!live || mustOpen || undefined}
            data-nudge={nudge.mark}
            data-testid="allow-once"
            data-stop="card"
            data-ask=""
            onPointerDown={pressed.onPointerDown}
            onMouseDown={pressed.onMouseDown}
            onClick={(e) => { if (pressed.said(e)) answer({ choice: "once" }); else if (mustOpen) { setTold(true); nudge.refuse(openFirst); } else nudge.refuse(notYet); }}
            className="k-allow h-8 shrink-0 whitespace-nowrap rounded-lg bg-accent px-3 text-ui font-medium text-accent-fg hover:opacity-90 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-raised aria-disabled:cursor-default aria-disabled:opacity-50"
          >
            Allow once
          </button>
          {nudge.line}
          {a.risk === "low" && a.suggest.length > 0 && <AlwaysButton a={a} busy={busy} live={grant && !mustOpen} armed={() => !unread.current && armed("grant")} notYet={mustOpen ? openFirst : notYet} onRefused={() => { if (unread.current) setTold(true); }} onGrant={(rules, session) => answer({ choice: session ? "session" : "always", rules })} />}
          <button
            disabled={busy}
            data-testid="deny"
            onClick={() => setDenying(true)}
            className="h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-ui text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-50"
          >
            Deny
          </button>
          {err ? <span className={cn("ml-auto min-w-0 basis-full text-micro text-danger", !dense && "sm:basis-auto sm:truncate")} role="alert" title={err} data-testid="approval-error">{err}</span>
            // Said only while the card has the keyboard and its Allow acts: else Enter is not its, or does nothing yet.
            : !dense && <span className={cn("invisible ml-auto text-micro text-faint max-sm:hidden pointer-coarse:hidden", live && "group-focus-within/card:visible")} data-testid="approval-hint">Enter allows once, Esc to deny with a reason</span>}
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = { shell: "Commands", edit: "Edits under", tool: "Tool" } as const;

// `live` and `armed`: as the card's Allow once, the grant does not open within the settle time.
function AlwaysButton({ a, busy, live, armed, notYet, onRefused, onGrant }: { a: Approval; busy: boolean; live: boolean; armed: () => boolean; notYet: string; onRefused?: () => void; onGrant: (rules: Suggest[], session: boolean) => void }) {
  const [rules, setRules] = useState<Suggest[]>(a.suggest);
  const [open, setOpen] = useState(false);
  const pressed = usePress(armed, (ok) => ok);
  const nudge = useNudge();
  return (
    <Popover.Root open={open} onOpenChange={(o, d) => { if (!o || pressed.said({ detail: (d.event as { detail?: number }).detail ?? 0 })) setOpen(o); else { nudge.refuse(notYet); onRefused?.(); } }}>
      <Popover.Trigger
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
          <Popover.Popup className="w-[min(26rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-3 shadow-2 transition-[scale,opacity] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
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
