// The keel: the rail along the left edge. It is the list whenever there is
// room: sessions by folder and machine, each with its title, state and time,
// and the archive. A row keeps its place and its height: it is one line (two
// by the owner's choice), what its session needs is said by its mark, and
// counted on the line above the list, where a press goes to the next one's
// row. Under the pointer or the keyboard nothing moves at all, and what moves
// when the hand rests or has left moves around the row it was on
// (lib/list-order.ts, lib/list-hold.ts). A row is pinned from the row itself
// (its actions, its menu), and the pinned stand in the order the owner gave
// them. With little room beside the panes a row is the mark and the title alone. Folded (Ctrl B, or no room for a title) it is a column of marks,
// each a session's state and a short code of its title, banded by what it
// needs from you. A card beside the entry under the pointer or the focus says
// the rest. On a phone the list is a drawer.
import { Archive, ArchiveRestore, ArrowDown, Bug, Columns2, Folder, Layers2, MessageSquareMore, Moon, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Pin, PinOff, Plus, Search, ServerOff, Settings, Sparkles, Sun, SunMoon, Tag, X } from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { runCommand } from "../lib/keys.ts";
import { machineName, machineReach, useFleet } from "../lib/fleet.ts";
import { stations, useStations } from "../lib/stations.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { actedOn, anchorRow, dropAnchor, focusRow, forgetActed, jumpNext, listActed, nameCounts, nameUnder, onReveal, reanchor, useActed, useAnchor, useCounts, useHand, useUnderLook, type Hand, type Kind } from "../lib/list-hold.ts";
import { around, folders, held as heldList, pinnedOrder, tally } from "../lib/list-order.ts";
import { focusAsk } from "../lib/asks.ts";
import { announce } from "../lib/announce.ts";
import { useNeedUnderLooks } from "../lib/looks.ts";
import { useQueued } from "../lib/queued.ts";
import { callsigns, listBounds, listWidth, panesMax, toggleList, useRail } from "../lib/rail.ts";
import { opened, openFocus } from "../lib/self-focus.ts";
import { fitBands } from "../lib/rail-fit.ts";
import { navigate, phone, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, clock, cn, folderNames, when } from "../lib/utils.ts";
import { AT_REST, branchOf, lastLine, useLastLine, useNeedCount, useSessionState, useSessionStates, type SessionState, type Watch } from "../lib/watch.ts";
import { COUNTERS, JUST_ARRIVED, NEW, NEW_SINCE, OFFLINE, STATE_WORD, asOf, countName, holdsWords, lastTold, queuedWord, stateAlone, stateLabel, wentWrongWord } from "../../../src/core/state-words.ts";
import { useUnsent, useWaitingSend } from "../lib/send-drafts.ts";
import { MachineSep, machineRuns, useWhere, WherePip, whereWords } from "./Where.tsx";
import { finished, ListFind, matches, order, readNote, setArrange, useArrange, useNote } from "./ListArrange.tsx";
import { useAuto } from "../lib/automation.ts";
import { failWord, folderOf, Mark, modelOf, stateClock, timed, useNow, whyText } from "./Mark.tsx";
import { AutomationFooter, SessionBadges, SessionChildren } from "./automation/SidebarExtras.tsx";
import { DRAG, dragSession, PaneCount } from "./Panes.tsx";
import { PaneMenu } from "./PaneMenu.tsx";
import { Grip } from "./Grip.tsx";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";
import { archive, movePin, pin, pinnedNow, placePin } from "../lib/sessops.ts";
import { RowMenu, type RowMenuAt } from "./RowMenu.tsx";
import { ProjectGroups } from "./SidebarProjects.tsx";
import { FolderGroups } from "./SidebarFolders.tsx";
import { openHelper } from "../lib/helper.ts";
import { Seg, tabId } from "./Seg.tsx";
import { StuckStrip } from "./Stuck.tsx";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// What the list is drawn from, for every group in it: the states its order and
// its folds read (held still under the hand), the sessions that left while it
// was held, and whether the list is the narrow one.
// `key`: what the owner chose for the list (its tab, filter and arrangement): a list they changed is drawn in its own order.
// `fluid`: the order moves rows as their sessions work (by recent activity, by state).
const ListCtx = createContext<{ watches: Record<string, Watch>; gone: Set<string>; narrow: boolean; lines: "one" | "two"; key: string; fluid: boolean }>({ watches: {}, gone: new Set(), narrow: false, lines: "one", key: "", fluid: false });

// The card beside an entry: shown at once for a mark (it has no words of its
// own), after a pause for a list row (its title is already there), and at
// once for either on keyboard focus.
// `row`: the entry is a list row, which already shows the title, the state and the folder
// (a row of one line shows the title only: its card is the whole one).
// `cut`: the row shows less than the whole title.
type Card = { s: Session; y: number; left: number; row: boolean; cut: boolean };
const CardCtx = createContext<(s: Session, wait: number, row?: boolean) => Record<string, (e: { currentTarget: HTMLElement }) => void>>(() => ({}));
function useCard() {
  const [card, setCard] = useState<Card | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hide = () => { clearTimeout(timer.current); setCard(null); };
  const bind = (s: Session, wait: number, row = wait > 0) => {
    const show = (ms: number) => (e: { currentTarget: HTMLElement }) => {
      const r = e.currentTarget.getBoundingClientRect();
      const edge = e.currentTarget.closest(".k-rail")?.getBoundingClientRect().right ?? r.right;
      clearTimeout(timer.current);
      const title = e.currentTarget.querySelector(".k-row-title");
      const cut = !!title && title.scrollWidth > title.clientWidth + 1;
      const set = () => setCard({ s, y: r.top + r.height / 2, left: edge + 8, row, cut });
      if (ms) timer.current = setTimeout(set, ms); else set();
    };
    return { onPointerEnter: show(wait), onPointerLeave: hide, onFocus: show(0), onBlur: hide, onClick: hide, onDragStart: hide };
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return { card, bind, hide };
}

// Up and Down step through the entries, Home and End reach the ends. A row is
// one Tab stop: Right goes to its own actions (open beside, archive), Left
// comes back to it.
function stepRows(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-testid="session-row"]')];
  const at = document.activeElement as HTMLElement;
  const row = at.closest<HTMLElement>('[data-testid="session-row"]');
  const i = row ? rows.indexOf(row) : -1;
  if (i < 0) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const stops = [row!, ...row!.querySelectorAll<HTMLElement>(".k-row-act")];
    if (stops.length < 2 || !stops.includes(at)) return;
    e.preventDefault();
    stops[stops.indexOf(at) + (e.key === "ArrowRight" ? 1 : -1)]?.focus();
    return;
  }
  e.preventDefault();
  (e.key === "Home" ? rows[0] : e.key === "End" ? rows.at(-1) : rows[i + (e.key === "ArrowDown" ? 1 : -1)])?.focus();
}

// Whether the hand is on the list (lib/list-hold.ts): the rail says, the lists in it read.
const HandCtx = createContext<Pick<Hand, "held"> & Partial<Pick<Hand, "on" | "keep" | "touch">>>({ held: false });

// Whether the list is held still under the hand, for the groups drawn by other files.
export const useListHeld = () => useContext(HandCtx).held;

// The sessions and the states a list is ordered from: as they are, or, while
// the hand is on the list, as they were when it arrived (lib/list-order.ts).
// `key`: what the owner chose for the list (its tab, filter and arrangement):
// a change of theirs is drawn at once.
const NONE = new Set<string>(), NO_LATE: Session[] = [];
function useHeld(held: boolean, key: string, now: Session[], watches: Record<string, Watch>, current: string | null = null) {
  const snap = useRef<{ key: string; list: Session[]; watches: Record<string, Watch> } | null>(null);
  useActed();
  const was = held && snap.current?.key === key ? snap.current : null;
  if (!was) {
    snap.current = { key, list: now, watches };
    return { list: now, watches, gone: NONE, late: NO_LATE };
  }
  const r = heldList(was.list, now, actedOn, (id) => id === current);
  // A session the owner acted on, and one that came since, are in the state they are in now.
  const ws = { ...was.watches };
  for (const s of [...r.list, ...r.late]) if (actedOn(s.id) || !(s.id in ws)) ws[s.id] = watches[s.id] ?? "idle";
  snap.current = { key, list: r.list, watches: was.watches };
  return { list: r.list, watches: ws, gone: r.gone, late: r.late };
}

// States a row spells out in their ink; a session at rest says none.
const SPELLED: Watch[] = ["need", "work", "wait", "fail", "declined", "resume", "stop"];
// States whose session may hold a message of the owner's in its queue.
const QUEUES: Watch[] = ["work", "wait", "need", "stop", "resume"];

// Opens a session in a new pane beside the one worked in (Ctrl or middle click, the row's button).
export function openBeside(id: string) {
  if (phone()) return navigate({ name: "session", id });
  stations.beside(id, panesMax());
  navigate({ name: "session", id });
}

// The row of a session a pane already shows was pressed: the keyboard goes to
// that pane. Where a card waits on the owner there, to the card, by the cards'
// own rule (lib/asks.ts: a region of it, never an answer, and no key answers
// until it has settled). Else to the pane's message box, by the rule for a
// box that takes the keyboard by itself (lib/self-focus.ts).
function intoBox(id: string) {
  const pane = document.querySelector(`.k-station[data-station="${CSS.escape(id)}"]`);
  if (!pane) return;
  const cards = pane.querySelector<HTMLElement>('[data-testid="composer-asks"]');
  if (cards && cards.childElementCount > 0 && cards.offsetHeight > 0) return focusAsk(id);
  opened();
  openFocus(pane.querySelector<HTMLElement>('[data-testid="composer"]'));
}

// The row after this one in the list (before it, for the last): where the keyboard goes when this one leaves.
function neighbour(row: HTMLElement | null): HTMLElement | undefined {
  const rows = [...(row?.closest('[data-testid="session-list"]')?.querySelectorAll<HTMLElement>('[data-testid="session-row"]') ?? [])];
  const i = row ? rows.indexOf(row) : -1;
  return i < 0 ? undefined : rows[i + 1] ?? rows[i - 1];
}

// The second line of a session at rest, in a list of two lines a row: what it last said or did,
// when this page holds its events (it opened the session), else the model it runs on.
function RestLine({ s }: { s: Session }) {
  const line = useStore((x) => lastLine(branchOf(x.events[s.id], s.head), s.workspace));
  return <span className="k-row-why k-row-last" data-testid="row-last">{line || modelOf(s.model)}</span>;
}

// `given`: the session as the list ordered it (held still under the hand); the row shows it as it is now.
// `gone`: it left the list while the list was held, and its row stays, dimmed, until the hand has left.
function Row({ s: given, active, where, gone }: { s: Session; active: boolean; where?: boolean; gone?: boolean }) {
  const live = useStore((x) => x.sessions[given.id]);
  const deleted = useStore((x) => !!x.gone[given.id]);
  const s = live ?? given;
  const { narrow, lines } = useContext(ListCtx);
  const restore = s.archived;
  const st = useSessionState(s);
  const w = st.watch;
  // A machine that does not answer: what its rows say is the last it told, so they are dimmed and their clocks stand.
  const offline = useWhere(s)?.reach === "offline";
  const now = useNow(timed(st) && !offline);
  // A row of one line may have no room for its reason: the card beside it comes sooner.
  const card = useContext(CardCtx)(s, lines === "one" ? 250 : 450, lines === "two");
  // A message of the session waits for the daemon to be back and goes out by itself: said on the
  // state line, whatever the state is (it is the reason itself when the session is otherwise at rest).
  const waitingSend = useWaitingSend(s.id);
  const queued = useQueued(s.id, QUEUES.includes(w) && !restore);
  // When its machine last told of it (the state says so once the daemon serves it; until then, its last change).
  const toldAt = (st as { as_of?: number }).as_of ?? s.updated;
  const shown = useStations((x) => x.shown.includes(s.id));
  const panes = useStations((x) => x.count);
  const [placing, setPlacing] = useState(false);
  const [menu, setMenu] = useState<RowMenuAt | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const unread = useAuto((x) => (x.unread.sessions[s.id] ?? 0) > 0);
  const pinned = !!s.settings.pinned_ms && !restore;
  // It, or an agent of it, needs the owner while its pane shows another session for now (a look lies over it).
  const under = useUnderLook(s.id);
  // A menu of the row is the hand on the list: the list is held while one is open.
  const keep = useContext(HandCtx).keep;
  const over = placing || !!menu;
  useEffect(() => { if (!over) return; keep?.(true); return () => keep?.(false); }, [over, keep]);
  // A pinned row moves among the pinned (Alt Up, Alt Down, its menu); the keyboard stays on it.
  const move = (by: -1 | 1) => {
    movePin(s.id, by).then((moved) => {
      if (!moved) return;
      announce(`${s.title || "New session"} moved ${by < 0 ? "up" : "down"}`);
      focusRow(s.id);
    }, reportError);
  };
  // Pinned or unpinned from the keyboard, the keyboard stays with the row, in the group it went to.
  const togglePin = (keys = false) => pin(s.id, !pinned).then(() => { if (keys) focusRow(s.id); }, reportError);
  const left = !gone ? null : deleted || (!live && !given.archived) ? "deleted" : given.archived ? "restored" : "archived";
  // The card beside the row is away while a menu of the row is open over it.
  useEffect(() => { if (over && row.current) card.onClick?.({ currentTarget: row.current }); }, [over]);
  const open = (beside: boolean) => {
    if (left === "deleted") return;
    if (beside) return openBeside(s.id);
    navigate({ name: "session", id: s.id });
    if (shown) intoBox(s.id);
  };
  return (
    <div
      ref={row}
      role="link"
      tabIndex={0}
      data-testid="session-row"
      data-session={s.id}
      data-watch={w}
      data-shown={shown || undefined}
      data-unread={unread || undefined}
      data-offline={offline || undefined}
      data-gone={gone || undefined}
      data-pinned={pinned || undefined}
      data-under={under || undefined}
      aria-disabled={left === "deleted" || undefined}
      aria-current={active ? "page" : undefined}
      aria-haspopup="menu"
      {...(over ? {} : card)}
      draggable
      onDragStart={(e) => { card.onDragStart?.(e); dragSession(s.id)(e); }}
      onClick={(e) => { card.onClick?.(e); open(e.ctrlKey || e.metaKey); }}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); openBeside(s.id); } }}
      onContextMenu={(e) => {
        // The row's own menu (Shift keeps the browser's, as elsewhere). From the keyboard it opens at the row.
        if (e.shiftKey || left || phone()) return;
        e.preventDefault();
        const b = e.currentTarget.getBoundingClientRect();
        setMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { x: b.left + 24, y: b.bottom });
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.altKey && pinned && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); return move(e.key === "ArrowUp" ? -1 : 1); }
        if (e.key !== "Enter") return;
        // Shift Enter: the menu of panes, to place the session in one of them.
        if (e.shiftKey && panes > 1 && !restore && !phone()) { e.preventDefault(); return setPlacing(true); }
        open(e.ctrlKey || e.metaKey);
      }}
      className="k-row group"
    >
      <Mark w={w} />
      {/* The title and the row's own line: the state with why (and the folder, where the list is not
          grouped by it). In a row of one line the words follow the title where it leaves them room,
          and are on the card beside the row where it does not; in a row of two they are the second
          line, as wide as the row. A session at rest says no word the mark already says. */}
      <span className="k-row-main">
        <span className="k-row-title">{s.title || "New session"}</span>
        <span className="k-row-sub">
          {/* A machine that does not answer says nothing new: the row's word is Offline (at the line's end), with when it last told here and what under the pointer. */}
          {offline
            ? <span className="k-row-why" data-testid="row-why" data-why="offline">{asOf(clock(toldAt))}</span>
            : SPELLED.includes(w)
            ? <span className="k-row-state" data-testid="row-state">{stateLabel(st)}</span>
            : lines === "two" && <RestLine s={s} />}
          {!offline && w === "fail" && failWord(st.cls) && <span className="k-row-class" data-testid="row-class">{failWord(st.cls)}</span>}
          {!offline && SPELLED.includes(w) && st.text && st.why !== "send" && <span className="k-row-why" data-testid="row-why" data-why={st.why}>{whyText(st, now)}</span>}
          {waitingSend && <span className="k-row-send" data-testid="waiting-send-mark" title="A message here waits for Keel and goes out by itself when it is back.">waits to send</span>}
          {where && <span className="k-row-in" data-testid="row-folder">{folderOf(s)}</span>}
        </span>
      </span>
      {/* The first line's end: the tag, the marks, the time, and under the pointer the row's actions in the time's place. */}
      <span className="k-row-end">
        {(s.settings.tags ?? []).slice(0, 1).map((t) => <span key={t} title={(s.settings.tags ?? []).join(", ")} className="k-row-tag shrink truncate rounded-xs bg-sunken px-1 text-micro text-faint" data-testid="row-tag">{t}</span>)}
        <SessionBadges sessionId={s.id} />
        {/* What it needs is under a look: its pane shows another session for now. */}
        {under && <span className="k-row-under" data-testid="row-under" role="img" aria-label={`${STATE_WORD.need}, under a look`} title={`${STATE_WORD.need} while its pane shows another session for now`}><Layers2 aria-hidden="true" /></span>}
        {/* A message of theirs that waits in the session's queue. */}
        {queued > 0 && !left && <span className="k-row-queued" data-testid="row-queued" role="img" aria-label={queuedWord(queued)} title={`${queued} message${queued > 1 ? "s" : ""} of yours ${queued > 1 ? "wait" : "waits"} here for the turn to end`}><MessageSquareMore aria-hidden="true" />{queued}</span>}
        {/* The time a glance wants: how long it has needed them, worked on this step or waited (when a timer is due); at rest, when it last moved. */}
        {left
          ? <span className="k-row-time" data-testid="row-gone" data-offline title="It left the list while your hand was on it, and goes when your hand has left">{left}</span>
          : offline
          ? <span className="k-row-time group-hover:hidden group-focus-within:hidden" data-testid="row-time" data-offline title={`Its machine does not answer: this is the last it told, ${when(toldAt)}`}>{OFFLINE}</span>
          : timed(st)
          ? <span className="k-row-time tabular-nums group-hover:hidden group-focus-within:hidden" data-testid="row-time" data-live title={st.until ? `Due ${when(st.until)}` : `Since ${when(st.since!)}`}>{stateClock(st, now, true)}</span>
          : <span className="k-row-time tabular-nums group-hover:hidden group-focus-within:hidden" data-testid="row-time" title={when(s.updated)}>{ago(s.updated)}</span>}
        {/* (A row whose session left has no actions: there is nothing to act on.) */}
        {!left && !restore && !phone() && (
          <button type="button" tabIndex={-1} title={pinned ? "Unpin" : "Pin to the top of the list"} aria-label={pinned ? "Unpin" : "Pin"} aria-pressed={pinned} data-testid="row-pin" onClick={(e) => { e.stopPropagation(); togglePin(e.detail === 0); }} className="k-row-act hidden group-hover:grid group-focus-within:grid">
            {pinned ? <PinOff /> : <Pin />}
          </button>
        )}
        {!left && !restore && !shown && !phone() && (
          <button type="button" tabIndex={-1} title="Open beside, in a new pane (Ctrl click)" aria-label="Open beside" data-testid="row-beside" onClick={(e) => { e.stopPropagation(); openBeside(s.id); }} className="k-row-act hidden group-hover:grid group-focus-within:grid">
            <Columns2 />
          </button>
        )}
        {!left && !restore && panes > 1 && !phone() && (
          <PaneMenu id={s.id} label="Place in a pane (Shift Enter)" testid="row-place" tabIndex={-1} open={placing} onOpenChange={setPlacing} back={row} className="k-row-act hidden group-hover:grid group-focus-within:grid data-popup-open:grid">
            <PanelsTopLeft />
          </PaneMenu>
        )}
        {!left && (
        <button
          type="button"
          tabIndex={-1}
          data-testid="row-archive"
          title={restore ? "Restore" : "Archive"}
          aria-label={restore ? "Restore session" : "Archive session"}
          onClick={(e) => {
            e.stopPropagation();
            // What the owner does to a row shows at once, also in a list held still under their hand.
            listActed(s.id);
            // Done from the keyboard, the keyboard goes on to the next row (a press with the pointer leaves it to the message box).
            if (e.detail === 0) neighbour(row.current)?.focus();
            archive(s, !restore).catch(reportError);
          }}
          className="k-row-act hidden group-hover:grid group-focus-within:grid"
        >
          {restore ? <ArchiveRestore /> : <Archive />}
        </button>
        )}
      </span>
      {menu && (
        <RowMenu
          at={menu}
          onClose={() => { setMenu(null); requestAnimationFrame(() => { if (document.activeElement === document.body) row.current?.focus(); }); }}
          pinned={pinned}
          archived={restore}
          beside={!restore && !shown}
          onPin={() => togglePin(true)}
          onMove={pinnedNow().length > 1 ? move : undefined}
          onBeside={() => openBeside(s.id)}
          onArchive={() => { listActed(s.id); archive(s, !restore).catch(reportError); }}
        />
      )}
    </div>
  );
}

// An agent's route belongs to its root's group in the index.
function rootSessionId(sessions: Record<string, Session>, current: string | null) {
  let s = current ? sessions[current] : undefined;
  for (let n = 0; s?.parent_id && n < 32; n++) s = sessions[s.parent_id] ?? undefined;
  return s?.id ?? current;
}

// A folder shows its first sessions; the rest open on request (and the open
// one is always shown, also when it is a subagent's: its parent's row then).
// A session that needs the owner, failed, works or waits is never folded
// away, nor one with something they have not read: only the ones at rest and
// read are (done, stopped, not started), and a press on a count above the
// list unfolds the one it goes to. What it reads is held with the list. A row that was shown
// stays shown until they ask for fewer, so a turn that ends takes no row away. The order is the list's own
// (lib/list-order.ts): a row is where the arrangement puts it, not where its state would.
const SHOWN = 6;
export function Group({ list, current, every, where }: { list: Session[]; current: string | null; every?: boolean; where?: boolean }) {
  const [more, setAll] = useState(false);
  const all = more || !!every;
  const root = useStore((x) => rootSessionId(x.sessions, current));
  const { watches, gone, key, fluid } = useContext(ListCtx);
  const kept = useRef(new Set<string>());
  useActed();
  const held = useContext(HandCtx).held;
  const unreadNow = useAuto((x) => x.unread.sessions);
  const unreadHeld = useRef(unreadNow);
  if (!held) unreadHeld.current = unreadNow;
  const unread = unreadHeld.current;
  const fits = all ? list : list.filter((s, i) => i < SHOWN || s.id === root || kept.current.has(s.id) || actedOn(s.id) || (unread[s.id] ?? 0) > 0 || !AT_REST.includes(watches[s.id] ?? "idle"));
  // In an order that moves rows as their sessions work, the row the hand is on keeps its place
  // among these, whatever the order makes of it meanwhile: the others sort around it. (Not what
  // the owner moved themselves, and not across a list they arranged anew. In an order where rows
  // keep their places every row is where the order puts it, and the list's scroll alone keeps the
  // hand's row where it is: lib/list-hold.ts.)
  const drawn = useRef({ key, ids: [] as string[] });
  const on = anchorRow();
  const shown = fluid && drawn.current.key === key && on && !actedOn(on) ? around(fits, drawn.current.ids, on, (s) => s.id) : fits;
  drawn.current = { key, ids: shown.map((s) => s.id) };
  for (const s of shown) kept.current.add(s.id);
  return (
    <div className="flex flex-col gap-px">
      {shown.map((s) => (
        <div key={s.id}>
          <Row s={s} active={current === s.id} where={where} gone={gone.has(s.id)} />
          {/* The agents' line under the row. Its height is held with the list's (see Index). */}
          <div className="k-row-kids" onClickCapture={(e) => { e.currentTarget.style.height = ""; e.currentTarget.style.overflow = ""; }}>
            <SessionChildren parentId={s.id} current={current} />
          </div>
        </div>
      ))}
      {list.length > shown.length && <button type="button" onClick={() => setAll(true)} className="k-more">{list.length - shown.length} more</button>}
      {more && list.length > SHOWN && <button type="button" onClick={() => { kept.current.clear(); setAll(false); }} className="k-more">Show fewer</button>}
    </div>
  );
}

// Sessions arrived while the list was held and wait below what it shows: said at the list's foot,
// and a press goes to them. The pointer on the line is a hand on the list: they do not take their
// places from under it.
function LateLine({ n, to }: { n: number; to: { current: HTMLElement | null } }) {
  const { keep, touch } = useContext(HandCtx);
  const on = useRef(false);
  const hold = (next: boolean) => { if (on.current !== next) { on.current = next; keep?.(next); } };
  useEffect(() => () => hold(false), []);
  return (
    <button type="button" className="k-late-line" data-testid="late-line" title="They take their places when your hand has left the list"
      onPointerEnter={() => hold(true)} onPointerLeave={() => hold(false)}
      onClick={() => { touch?.(); to.current?.scrollIntoView({ block: "end" }); }}>
      <ArrowDown aria-hidden="true" /><span className="min-w-0 truncate">{n} {JUST_ARRIVED.toLowerCase()}, below</span>
    </button>
  );
}

// The pinned group, in the order of its pins. A session dragged over it is dropped where the line
// shows: a pinned one moves there, another is pinned there (lib/sessops.ts: the order is stored
// with the pins, the same on every device). Alt Up and Alt Down on a pinned row move it too.
function PinnedGroup({ list, current, every }: { list: Session[]; current: string | null; every: boolean }) {
  const box = useRef<HTMLElement>(null);
  const [line, setLine] = useState<number | null>(null);
  // Where a drop at this height would put the session: before the row whose middle is under it.
  const aim = (y: number) => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-testid="session-row"]') ?? [])].map((r) => r.getBoundingClientRect());
    const at = rows.findIndex((b) => y < (b.top + b.bottom) / 2);
    const top = box.current!.getBoundingClientRect().top;
    return { at: at < 0 ? rows.length : at, y: (at < 0 ? rows.at(-1)?.bottom ?? top : rows[at]!.top) - top };
  };
  return (
    <section
      ref={box}
      className="k-group k-pinned"
      data-testid="pinned-group"
      onDragOver={(e) => { if (!e.dataTransfer.types.includes(DRAG)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setLine(aim(e.clientY).y); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLine(null); }}
      onDrop={(e) => {
        setLine(null);
        const id = e.dataTransfer.getData(DRAG);
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        const from = list.findIndex((s) => s.id === id);
        const to = aim(e.clientY).at;
        // (Among the rows without the one that is dragged: a row dropped on its own place stays.)
        if (from >= 0 && (to === from || to === from + 1)) return;
        placePin(id, from >= 0 && to > from ? to - 1 : to).catch(reportError);
      }}
    >
      <h2 className="k-group-head"><Pin /><span className="truncate">Pinned</span></h2>
      <Group list={list} current={current} every={every} where />
      {line !== null && <span className="k-drop-line" style={{ top: line }} aria-hidden="true" />}
    </section>
  );
}

// What a message kept in the New box says on the New session button.
const NEW_UNSENT = {
  refused: { word: "not sent", line: "a first message was not sent", title: "A first message was not sent. Open New session to send it again or discard it." },
  unconfirmed: { word: "unconfirmed", line: "a new session's start is unconfirmed", title: "Nobody confirmed that a new session was made. Open New session and check the list before sending again." },
} as const;

// The tab the index opens on (the folded rail's archive button asks for "archived").
let openOn: "active" | "archived" = "active";

// Folded: one mark per session, banded by what each needs from you, each band
// headed by its word and count, in the list's order: what needs you, what
// failed, what waits, what works, then what is at rest. Within a band the
// newest session is on top, and a mark keeps that place while its session
// works. Under the hand the marks stay in the band they were in: the mark
// itself shows the state as it is. Every band is on screen: one with more marks than
// the rail has room for ends in a count that opens the list. A finished
// session you have not looked at keeps a full mark; one you have seen goes
// quiet. Hovering or focusing a mark shows its card.
const BANDS: { w: Watch[] }[] = [{ w: ["need"] }, { w: ["fail", "declined"] }, { w: ["wait"] }, { w: ["work"] }, { w: ["resume", "stop"] }, { w: ["done", "idle"] }];
// The folded rail keeps every band on screen. When the marks do not fit at
// their usual size the rail sets them tighter (smaller marks, slimmer heads);
// only when they do not fit even so does a band hold some back behind a count.
// Returns how many marks there is room for (null: all of them), measured on the rail itself.
function useRailRoom(bands: number, marks: number) {
  const probe = useRef<HTMLSpanElement>(null);
  const [tight, setTight] = useState(false);
  const [rows, setRows] = useState<number | null>(null);
  const loose = useRef({ tick: 0, over: 0 }); // the usual sizes, kept to know when they fit again
  useLayoutEffect(() => {
    const nav = probe.current?.parentElement;
    if (!nav) return;
    nav.toggleAttribute("data-tight", tight);
    const measure = () => {
      const tick = nav.querySelector<HTMLElement>(".k-tick");
      const band = nav.querySelector<HTMLElement>(".k-marks");
      if (!tick || !band) return setRows(null);
      const cs = getComputedStyle(nav), bs = getComputedStyle(band), gap = parseFloat(getComputedStyle(band.querySelector("ol")!).rowGap) || 0;
      const over = (band.querySelector<HTMLElement>(".k-marks-head")?.offsetHeight ?? 0) + parseFloat(bs.paddingTop) + parseFloat(bs.paddingBottom) + 1;
      const room = nav.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const need = (t: number, o: number, g: number) => marks * (t + g) + bands * o;
      if (!tight) {
        loose.current = { tick: tick.offsetHeight + gap, over };
        setRows(null);
        if (need(tick.offsetHeight, over, gap) > room) setTight(true);
        return;
      }
      if (loose.current.tick && marks * loose.current.tick + bands * loose.current.over <= room) return setTight(false);
      setRows(need(tick.offsetHeight, over, gap) <= room ? null : Math.max(bands, Math.floor((room - bands * over) / (tick.offsetHeight + gap))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [bands, marks, tight]);
  return { probe, rows };
}
function Marks({ current }: { current: string | null }) {
  const sessions = useStore((s) => s.sessions);
  const live = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper).sort((a, b) => b.created - a.created || b.id.localeCompare(a.id)), [sessions]);
  const codes = useMemo(() => callsigns(live), [live]);
  const states = useSessionStates(live);
  const now = useMemo(() => Object.fromEntries(live.map((s) => [s.id, states[s.id]!.watch])) as Record<string, Watch>, [live, states]);
  // Held: each mark in the band it was in, one whose session left still there (dimmed), and what came since in a band of its own at the end.
  const { list: ordered, watches: banded, gone, late } = useHeld(useContext(HandCtx).held, "marks", live, now);
  const list = ordered.map((s) => sessions[s.id] ?? s);
  const watches = now;
  const shown = useStations((x) => x.shown);
  const unread = useAuto((s) => s.unread.sessions);
  const bind = useContext(CardCtx);
  const bands = [
    // A band's words are the states of the sessions in it (src/core/state-words.ts): "Failed or declined", "Done or not started".
    ...BANDS.map((b) => { const items = list.filter((s) => b.w.includes(banded[s.id] ?? "idle")); return { ...b, key: b.w[0]!, label: holdsWords(items.map((s) => banded[s.id] ?? "idle")), items, late: false }; }),
    { w: ["idle"] as Watch[], key: "late", label: JUST_ARRIVED, items: late, late: true },
  ].filter((b) => b.items.length);
  const { probe, rows } = useRailRoom(bands.length, list.length + late.length);
  const fit = fitBands(bands.map((b) => b.items.length), rows);
  return (
    <>
      <span ref={probe} hidden />
      {bands.map((b, bi) => {
        const all = b.items;
        // A band cut to its room keeps the session on screen among its marks and ends in a count of the rest.
        const room = fit[bi]! < all.length ? Math.max(0, fit[bi]! - 1) : all.length;
        const at = all.findIndex((s) => s.id === current);
        const items = (at >= room ? [all[at]!, ...all.filter((s) => s.id !== current)] : all).slice(0, room);
        const rest = all.length - items.length;
        return (
          <section key={b.key} className="k-marks" data-watch={b.w[0]} aria-label={`${b.label}: ${all.length}`} title={`${b.label}: ${all.length}`} data-testid="rail-band">
            {/* The band's mark and how many: the rail has no room for the word, which is the band's name and tooltip. */}
            <h3 className="k-marks-head" aria-hidden="true">{b.late ? <Plus aria-hidden="true" /> : <Mark w={b.w.find((w) => all.some((x) => (banded[x.id] ?? "idle") === w)) ?? b.w[0]!} />}<span className="tabular-nums">{all.length}</span></h3>
            <ol>
              {items.map((s) => {
                const card = bind(s, 0);
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className="k-tick"
                      data-testid="session-row"
                      data-session={s.id}
                      data-watch={watches[s.id]}
                      data-shown={shown.includes(s.id) || undefined}
                      data-unread={unread[s.id] ? true : undefined}
                      data-gone={gone.has(s.id) || undefined}
                      aria-current={current === s.id ? "page" : undefined}
                      aria-label={`${s.title || "New session"}, ${stateAlone(states[s.id] ?? { watch: watches[s.id] ?? "idle" })}${states[s.id]?.text ? `: ${states[s.id]!.text}` : ""}, ${folderOf(s)}${whereWords(s)}, ${ago(s.updated)}`}
                      {...card}
                      draggable
                      onDragStart={(e) => { card.onDragStart?.(e); dragSession(s.id)(e); }}
                      onClick={(e) => { card.onClick?.(e); navigate({ name: "session", id: s.id }); }}
                    >
                      <Mark w={watches[s.id] ?? "idle"} />
                      <span className="k-tick-code" data-testid="rail-code" aria-hidden="true">{codes[s.id]}</span>
                      <WherePip s={s} />
                      <span className="sr-only">{s.title || "New session"}</span>
                      <span className="k-tick-badges"><SessionBadges sessionId={s.id} /></span>
                    </button>
                    <div className="k-tick-kids"><SessionChildren parentId={s.id} current={current} /></div>
                  </li>
                );
              })}
              {rest > 0 && (
                <li>
                  <button type="button" className="k-tick k-tick-more" data-testid="rail-more" aria-label={`${rest} more ${b.label.toLowerCase()}. Show the list`} title={`${rest} more: ${all.filter((s) => !items.includes(s)).map((s) => s.title || "New session").join(", ")}`} onClick={() => toggleList(true)}>
                    +{rest}
                  </button>
                </li>
              )}
            </ol>
          </section>
        );
      })}
    </>
  );
}

// The card beside an entry: what the session is, where, and what it last did.
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, "~");
function RailCard({ s: given, y, left, row, cut }: { s: Session; y: number; left: number; row?: boolean; cut?: boolean }) {
  const s = useStore((x) => x.sessions[given.id]) ?? given;
  const st = useSessionState(s);
  const w = st.watch;
  // A machine that does not answer says nothing new: the card reads Offline with when it last told, as the row and the pane's head do, and no clock runs.
  const offline = useWhere(s)?.reach === "offline";
  const now = useNow(timed(st) && !offline);
  const unread = useAuto((x) => x.unread.sessions[s.id] ?? 0);
  const events = useStore((x) => x.events[s.id]);
  // What it last did or ended with: from the events the page holds, else asked of the daemon (a session never opened here).
  const told = useLastLine(s, !events);
  const line = events ? lastLine(branchOf(events, s.head), s.workspace) : told;
  const toldAt = (st as { as_of?: number }).as_of ?? s.updated;
  const why = offline ? lastTold(stateLabel(st), st.text) : whyText(st, now);
  const top = Math.min(Math.max(y, 96), innerHeight - 96);
  // Beside a list row the card adds what the row has no room for and repeats nothing of it:
  // the reason in full, what the session last did, its model, the whole path, the exact time.
  if (row) {
    return (
      <div className="k-rail-card" data-kind="row" data-watch={w} style={{ top, left }} data-testid="rail-card" aria-hidden="true">
        {cut && <p className="k-rail-card-title">{s.title}</p>}
        {why && <p className="k-rail-card-why" data-testid="rail-card-why" data-why={offline ? "offline" : st.why}>{why}</p>}
        {line && line !== why && <p className="k-rail-card-line">{line}</p>}
        <dl className="k-rail-card-meta">
          <dt>Model</dt><dd>{modelOf(s.model)}</dd>
          <dt>Path</dt><dd title={s.workspace}>{home(s.workspace)}{s.machine ? ` on ${machineName(s.machine)}` : ""}</dd>
          <dt>Active</dt><dd>{when(s.updated)}</dd>
        </dl>
      </div>
    );
  }
  return (
    <div className="k-rail-card" data-watch={w} style={{ top, left }} data-testid="rail-card" aria-hidden="true">
      <div className="k-rail-card-row">
        <Mark w={w} />
        <span className="k-rail-card-word" data-testid="rail-card-word" data-offline={offline || undefined}>{offline ? OFFLINE : stateLabel(st)}</span>
        {!offline && w === "fail" && failWord(st.cls) && <span className="k-row-class">{failWord(st.cls)}</span>}
        {offline
          ? <span className="k-rail-card-time" data-testid="rail-card-time" title={when(toldAt)}>{asOf(clock(toldAt))}</span>
          : timed(st)
          ? <span className="k-rail-card-time tabular-nums" data-live>{stateClock(st, now)}</span>
          : <span className="k-rail-card-time" title={when(s.updated)}>{ago(s.updated) === "now" ? "just now" : `${ago(s.updated)} ago`}</span>}
      </div>
      <p className="k-rail-card-title">{s.title || "New session"}</p>
      {/* Why it is in its state: what waits on the owner, the step, what it waits for, how it failed. */}
      {why && <p className="k-rail-card-why" data-testid="rail-card-why" data-why={offline ? "offline" : st.why}>{why}</p>}
      {line && line !== why && <p className="k-rail-card-line">{line}</p>}
      {unread > 0 && w !== "need" && <p className="k-rail-card-new">{NEW_SINCE}</p>}
      <dl className="k-rail-card-meta">
        <dt>Folder</dt><dd title={s.workspace}><b>{folderOf(s)}</b>{s.machine ? ` on ${machineName(s.machine)}` : ""} in {home(s.workspace.replace(/\/[^/]*\/?$/, "")) || "/"}</dd>
        <dt>Model</dt><dd>{modelOf(s.model)}</dd>
        <dt>Active</dt><dd>{when(s.updated)}</dd>
      </dl>
    </div>
  );
}

// The line above the list: how many sessions need the owner, failed, work, have
// something new, or sit on a machine that does not answer. It is always there
// and always as high, so nothing under it moves when a count comes or goes. A
// press on a count goes to the row of the next session it names, wherever
// that row is (Alt A, the key that was there before, opens the next that needs them).
// The words are the vocabulary's (src/core/state-words.ts). What needs the owner is counted as
// things, each once, as the tab's title and the home headline count them (a session with three
// requests is three); the others count sessions, and "failed" says so when a turn was declined instead.
const COUNTS: { kind: Kind; watch?: Watch; says: string }[] = [
  { kind: "need", watch: "need", says: STATE_WORD.need },
  { kind: "fail", watch: "fail", says: STATE_WORD.fail },
  { kind: "work", watch: "work", says: STATE_WORD.work },
  { kind: "unread", says: NEW_SINCE },
  { kind: "offline", says: "On a machine that does not answer" },
];
// The line fits its bar at every width and text size, and a figure is never cut: measured on the
// line itself. Every count keeps its mark and its figure, and the words take the room that is
// left, the one that calls the owner first. With no room for a word the line's calm sentence
// goes, then the room between the counts, and at the very narrowest whole counts, the ones that
// call the owner last.
const WORDS_STAY: Kind[] = ["need", "fail", "offline", "unread", "work"];
const COUNTS_GO: Kind[] = ["work", "unread", "offline"];
function fitSummary(el: HTMLElement) {
  const chips = [...el.querySelectorAll<HTMLElement>(".k-sum-chip")];
  const chip = (k: Kind) => chips.find((c) => c.dataset.kind === k);
  const calm = el.querySelector<HTMLElement>(".k-sum-calm");
  const over = () => el.scrollWidth > el.clientWidth || (!!calm && !calm.hidden && calm.scrollWidth > calm.clientWidth);
  el.removeAttribute("data-tight");
  if (calm) calm.hidden = false;
  for (const c of chips) { c.hidden = false; c.setAttribute("data-bare", ""); }
  if (!over()) {
    for (const k of WORDS_STAY) {
      const c = chip(k);
      if (!c) continue;
      c.removeAttribute("data-bare");
      // A word that says less is not shown where one that says more has no room.
      if (over()) { c.setAttribute("data-bare", ""); break; }
    }
    return;
  }
  const steps: (() => void)[] = [
    () => { if (calm) calm.hidden = true; },
    () => el.setAttribute("data-tight", ""),
    ...COUNTS_GO.map((k) => () => { const c = chip(k); if (c) c.hidden = true; }),
  ];
  for (const step of steps) { step(); if (!over()) break; }
}

function Summary() {
  const counts = useCounts();
  const sessions = useStore((s) => s.sessions);
  const shown = COUNTS.filter((c) => counts[c.kind].length > 0);
  const calls = counts.need.length + counts.fail.length > 0;
  const line = useRef<HTMLDivElement>(null);
  // How many a count says, and in what words.
  const need = useNeedCount();
  const failed = useMemo(() => counts.fail.map((id) => sessions[id]).filter((x): x is Session => !!x), [counts.fail, sessions]);
  const failedStates = useSessionStates(failed);
  const declined = counts.fail.filter((id) => failedStates[id]?.watch === "declined").length;
  const said = (kind: Kind, ids: string[]): { n: number; word: string } => {
    if (kind === "need") { const n = Math.max(ids.length, need); return { n, word: countName("need", n) }; }
    if (kind === "fail") return { n: ids.length, word: wentWrongWord(ids.length - declined, declined) };
    return { n: ids.length, word: kind === "work" ? countName("work", ids.length) : kind === "unread" ? NEW.toLowerCase() : OFFLINE.toLowerCase() };
  };
  const figures = COUNTS.map((c) => { const x = said(c.kind, counts[c.kind]); return `${x.n} ${x.word}`; }).join("|");
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const fit = () => fitSummary(el);
    fit();
    // Measured again when the bar or a count changes width: the edge dragged, the text size, a face that arrived after the first paint.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    document.fonts?.addEventListener("loadingdone", fit);
    return () => { ro.disconnect(); document.fonts?.removeEventListener("loadingdone", fit); };
  }, [figures]);
  // One stop for Tab: the arrows move between the counts, Home and End reach the ends.
  const [stop, setStop] = useState<Kind | null>(null);
  const at = shown.some((c) => c.kind === stop) ? stop : shown[0]?.kind;
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const chips = [...e.currentTarget.querySelectorAll<HTMLElement>(".k-sum-chip:not([hidden])")];
    const i = chips.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    (e.key === "Home" ? chips[0] : e.key === "End" ? chips.at(-1) : chips[i + (e.key === "ArrowRight" ? 1 : -1)])?.focus();
  };
  return (
    <div ref={line} className="k-sum" data-testid="list-summary" role="toolbar" aria-label="What the sessions need" onKeyDown={step}>
      {!calls && <span className="k-sum-calm" data-testid="sum-calm">{COUNTERS.calm}</span>}
      {shown.map((c) => {
        const ids = counts[c.kind];
        const names = ids.slice(0, 6).map((id) => sessions[id]?.title || "New session").join("; ");
        const { n, word } = said(c.kind, ids);
        return (
          <button key={c.kind} type="button" className="k-sum-chip" data-kind={c.kind} data-testid={`sum-${c.kind}`} tabIndex={c.kind === at ? 0 : -1} onFocus={() => setStop(c.kind)} onClick={() => jumpNext(c.kind)}
            aria-label={`${n} ${word}. Go to the next`} title={`${c.says}: ${names}${ids.length > 6 ? `, and ${ids.length - 6} more` : ""}. Press to go to the next one's row${c.kind === "need" ? " (Alt A opens it)" : ""}.`}>
            {c.watch ? <Mark w={c.watch} /> : c.kind === "offline" ? <ServerOff aria-hidden="true" /> : <span className="k-sum-dot" aria-hidden="true" />}
            <b className="k-sum-n">{n}</b>
            <span className="k-sum-word">{word}</span>
          </button>
        );
      })}
    </div>
  );
}

// Keeps whom each count names, for the line above the list and for the key, also while the list is folded.
function CountsKeeper() {
  const sessions = useStore((s) => s.sessions);
  const top = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper), [sessions]);
  const states = useSessionStates(top);
  const unread = useAuto((x) => x.unread.sessions);
  // The machines that do not answer, as one word: it changes when one of them does.
  const down = useFleet((x) => [...new Set(top.map((s) => s.machine).filter((m): m is string => !!m))].filter((m) => machineReach(m, x).state === "offline").sort().join(" "));
  // A session that needs them while its pane shows another for now (a look lies over it) is on no
  // screen: it is counted with what needs them, by the row that stands for it (its own, or its
  // root's when it is an agent's), whatever that row's own state says.
  const under = useNeedUnderLooks().map((id) => rootSessionId(sessions, id) ?? id).join(" ");
  const counts = useMemo(() => {
    const off = new Set(down.split(" ").filter(Boolean));
    const t = tally(top, states as Record<string, SessionState>, unread);
    const more = under.split(" ").filter((id) => id && !t.need.includes(id) && top.some((s) => s.id === id));
    return { ...t, need: [...t.need, ...more], offline: top.filter((s) => s.machine && off.has(s.machine)).map((s) => s.id) };
  }, [top, states, unread, down, under]);
  useEffect(() => nameCounts(counts), [counts]);
  useEffect(() => nameUnder(under.split(" ").filter(Boolean)), [under]);
  return null;
}

function Index({ current }: { current: string | null }) {
  const sessions = useStore((s) => s.sessions);
  const hand = useContext(HandCtx), held = hand.held;
  const narrow = useRail().narrow;
  const nav = useRef<HTMLElement>(null);
  // What moves in the list moves around the row the hand is on (lib/list-hold.ts).
  useAnchor(nav);
  const note = useNote();
  useFleet((s) => s.machines.length); // machine names in the group heads
  const [tab, setTab] = useState<"active" | "archived">(() => { const t = openOn; openOn = "active"; return t; });
  const panel = useId();
  const [archived, setArchived] = useState<Session[]>([]);
  // The archive is asked for when its tab opens and when what it lists moved:
  // a session was archived or restored, or one is gone. A status or a title
  // of a session is no reason (the list shows the store's row of each). The
  // answer of a request that a newer one overtook is dropped. A page that was
  // cut off reads it again when it is back: what was archived or deleted
  // meanwhile reached it by no frame.
  const inArchive = useStore((s) => Object.values(s.sessions).filter((x) => x.archived).map((x) => x.id).sort().join(" "));
  const gone = useStore((s) => s.gone);
  const connected = useStore((s) => s.connected);
  const asked = useRef(0);
  useEffect(() => {
    if (tab !== "archived" || !connected) return;
    const n = ++asked.current;
    api<{ sessions: Session[] }>("/api/sessions?archived").then((r) => { if (n === asked.current) setArchived(r.sessions); }).catch(reportError);
  }, [tab, inArchive, gone, connected]);
  // A tag picked above the list narrows it; pinned sessions lead it.
  // Each tab keeps its own tag: one picked in Sessions does not empty Archived.
  const [tags_, setTags] = useState<Record<string, string | null>>({});
  const base_ = useMemo(
    () => (tab === "active" ? Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper) : archived.map((a) => sessions[a.id] ?? a).filter((s) => s.archived && !gone[s.id])),
    [sessions, tab, archived, gone],
  );
  const tags = useMemo(() => [...new Set(base_.flatMap((s) => s.settings.tags ?? []))].sort((a, b) => a.localeCompare(b)), [base_]);
  const picked = tags_[tab] ?? null;
  const tag = picked && tags.includes(picked) ? picked : null; // a tag no session has any more filters nothing
  const setTag = (t: string | null) => setTags((m) => ({ ...m, [tab]: t }));
  // The filter words and the arrangement (ListArrange.tsx): pinned sessions stay in view unless the words leave them out.
  const [q, setQ] = useState("");
  const arr = useArrange();
  const states = useSessionStates(base_);
  const liveWatches = useMemo(() => Object.fromEntries(Object.entries(states).map(([id, st]) => [id, st.watch])) as Record<string, Watch>, [states]);
  // Under the hand the list is drawn from what it held when the hand arrived: no row moves.
  // (The session on screen is theirs: one they just made or opened from this page takes its place at once.)
  const listKey = `${tab}|${tag ?? ""}|${q}|${arr.group}|${arr.sort}|${arr.hideDone}`;
  const from = useHeld(held, listKey, base_, liveWatches, current);
  // A list the owner arranged anew is drawn as they asked, not around where a row stood before.
  const scale = useUI((x) => x.scale);
  useLayoutEffect(reanchor, [listKey, arr.lines, narrow, scale]);
  const watches = from.watches;
  const fits = (s: Session) => (!tag || (s.settings.tags ?? []).includes(tag)) && (!q || matches(s, q));
  const listed = from.list.filter(fits);
  // What came while the list was held waits at its end.
  const late = from.late.filter(fits);
  // What the owner did is in the list once it is drawn free of the hand: nothing of it is kept for the next hold.
  const acts = useActed();
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => { forgetActed(); dropAnchor(); }, 2000);
    return () => clearTimeout(t);
  }, [held, acts]);
  // The agents' line under a row is as high as it was when the hand arrived (a press on it is theirs: Group lets it go).
  useLayoutEffect(() => {
    const els = held ? [...(nav.current?.querySelectorAll<HTMLElement>(".k-row-kids") ?? [])] : [];
    for (const el of els) { el.style.height = `${el.getBoundingClientRect().height}px`; el.style.overflow = "clip"; }
    return () => { for (const el of els) { el.style.height = ""; el.style.overflow = ""; } };
  }, [held]);
  // A count pressed above the list goes to a row: one this list does not draw (the archive is open, the
  // filter leaves it out) is drawn first. Folds open by themselves for a session the owner went to.
  useEffect(() => { onReveal(() => { setTab("active"); setQ(""); setTags({}); }); return () => onReveal(null); }, []);
  const pinned = pinnedOrder(listed);
  // Keep the open branch in the list even when its root finishes.
  const root = rootSessionId(sessions, current);
  const rest = listed.filter((s) => !s.settings.pinned_ms && !(arr.hideDone && finished(watches[s.id]) && s.id !== current && s.id !== root && !actedOn(s.id)));
  const hidden = listed.length - pinned.length - rest.length;
  const cmp = order<Session>(arr, watches);
  // Where the order moves rows as their sessions work, the folder of the row the hand is on keeps
  // its place among the folders, as the row does in it (see Group).
  const fluid = arr.sort === "recent" || arr.sort === "state";
  const drawnGroups = useRef({ key: listKey, keys: [] as string[] });
  const on = anchorRow();
  const sorted = arr.group === "folder" ? folders(rest, arr, watches) : [];
  const grouped = fluid && drawnGroups.current.key === listKey && on && !actedOn(on) ? around(sorted, drawnGroups.current.keys, sorted.find((g) => g.list.some((s) => s.id === on))?.key, (g) => g.key) : sorted;
  drawnGroups.current = { key: listKey, keys: grouped.map((g) => g.key) };
  // The arrivals' group at the list's end: whether it is on screen (else a line at the list's foot says they wait).
  const lateBox = useRef<HTMLElement>(null);
  const [lateSeen, setLateSeen] = useState(true);
  const waits = late.length > 0;
  useEffect(() => {
    const el = lateBox.current;
    if (!waits || !el || !nav.current) return setLateSeen(true);
    const io = new IntersectionObserver(([e]) => setLateSeen(!!e?.isIntersecting), { root: nav.current });
    io.observe(el);
    return () => io.disconnect();
  }, [waits]);
  // By project or by their folders, the archive is one list (a project's archived sessions are on its page).
  const flat = arr.group === "flat" || ((arr.group === "project" || arr.group === "mine") && tab !== "active") ? [...rest].sort(cmp) : [];
  // Same-named folders read apart (beta/api, alpha/api); a machine's folders are named among its own.
  const heads = useMemo(() => {
    const by = new Map<string, string[]>();
    for (const g of grouped) (by.get(g.machine ?? "") ?? by.set(g.machine ?? "", []).get(g.machine ?? "")!).push(g.ws);
    const out = new Map<string, string>();
    for (const [m, list] of by) for (const [ws, name] of folderNames(list)) out.set(`${m}\u0000${ws}`, name);
    return out;
  }, [grouped]);
  const sections = useMemo(() => machineRuns(rest), [rest]);
  return (
    <>
      <Seg kind="tabs" panel={panel} fill className="k-list-tabs mx-2.5 mb-1" label="Session list" value={tab} onChange={setTab} options={[{ value: "active", label: "Sessions", testid: "tab-active" }, { value: "archived", label: "Archived", testid: "tab-archived" }]} />
      <ListFind q={q} setQ={setQ} narrow={narrow} />
      {tags.length > 0 && !narrow && (
        <div className="flex flex-wrap gap-1 px-3 pb-2" role="group" aria-label="Filter by tag" data-testid="tag-filter">
          {tags.map((t) => (
            <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
              className={cn("inline-flex h-ctl-sm min-w-0 max-w-full items-center gap-1 rounded-xs px-1.5 text-caption", tag === t ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted hover:text-fg")}>
              <Tag className="size-3 shrink-0" /><span className="truncate">{t}</span>
            </button>
          ))}
        </div>
      )}
      {/* The tabs' panel: it takes no box of its own, the list keeps its place in the rail. */}
      <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="contents">
      <Summary />
      {/* Said once to whom the order changed under, where they will see it: gone when dismissed or when the Arrange menu was opened. */}
      {note && !narrow && (
        <p className="k-list-note" data-testid="list-note">
          <span className="min-w-0 flex-1 truncate">Sessions now keep their place.</span>
          <button type="button" className="k-link shrink-0 text-accent-ink underline-offset-2 hover:underline" data-testid="list-note-arrange" onClick={() => dispatchEvent(new Event("keel:arrange"))}>Arrange</button>
          <button type="button" className="k-find-btn" data-testid="list-note-dismiss" aria-label="Dismiss" title="Dismiss" onClick={readNote}><X /></button>
        </p>
      )}
      <ListCtx.Provider value={{ watches, gone: from.gone, narrow, lines: narrow ? "one" : arr.lines, key: listKey, fluid }}>
      <nav ref={nav} className="k-index" data-testid="session-list" data-lines={narrow ? "one" : arr.lines} data-held={held || undefined} aria-label="Sessions" onKeyDown={stepRows} {...hand.on}>
        {pinned.length > 0 && (
          <PinnedGroup list={pinned} current={current} every={!!q} />
        )}
        {(arr.group === "folder" || arr.group === "flat" || tab !== "active") && grouped.length === 0 && flat.length === 0 && pinned.length === 0 && late.length === 0 && (
          q
            ? <p className="k-empty" data-testid="filter-empty">No sessions match {q}. <button type="button" className="k-link text-accent-ink underline-offset-2 hover:underline" onClick={() => setQ("")}>Clear the filter</button></p>
            : hidden > 0
            ? <p className="k-empty">All {hidden} sessions here are finished and hidden. <button type="button" className="k-link text-accent-ink underline-offset-2 hover:underline" onClick={() => setArrange({ hideDone: false })}>Show them</button></p>
            : tag
            ? <p className="k-empty" data-testid="tag-empty">No sessions match the tag {tag}. <button type="button" className="k-link text-accent-ink underline-offset-2 hover:underline" onClick={() => setTag(null)}>Show all</button></p>
            : <p className="k-empty">{tab === "active" ? "Sessions you start show up here, grouped by folder." : "Archived sessions show up here. Restore one to bring it back."}</p>
        )}
        {sections.map((sec) => {
          const own = sec.machine === undefined ? grouped.filter((g) => !g.machine) : grouped.filter((g) => g.machine === sec.machine);
          const ownFlat = flat.filter((s) => (s.machine ?? undefined) === sec.machine);
          return (
            <Fragment key={sec.machine ?? "local"}>
              {sections.length > 1 && <MachineSep machine={sec.machine} count={sec.list.length} />}
              {arr.group === "project" && tab === "active" && <ProjectGroups list={sec.list} cmp={cmp} current={current} every={!!q} />}
              {arr.group === "mine" && tab === "active" && <FolderGroups list={sec.list} cmp={cmp} current={current} every={!!q} />}
              {own.map((g) => (
                <section key={g.key} className="k-group" data-machine={g.machine}>
                  <h2 className="k-group-head" title={g.machine ? `${g.ws} on ${machineName(g.machine)}` : g.ws}>
                    <Folder />
                    <span className="truncate">{heads.get(`${g.machine ?? ""}\u0000${g.ws}`) ?? base(g.ws)}</span>
                  </h2>
                  <Group list={g.list} current={current} every={!!q} />
                </section>
              ))}
              {ownFlat.length > 0 && (
                <section className="k-group" data-testid="flat-group">
                  <Group list={ownFlat} current={current} every={!!q} where />
                </section>
              )}
            </Fragment>
          );
        })}
        {hidden > 0 && (grouped.length > 0 || flat.length > 0) && (
          <button type="button" className="k-more" data-testid="hidden-done" onClick={() => setArrange({ hideDone: false })}>{hidden} finished hidden</button>
        )}
        {/* What came while the list was held: at its end, the first of them (the rest behind "N more"), until the hand has left. */}
        {waits && (
          <section ref={lateBox} className="k-group" data-testid="late-group">
            <h2 className="k-group-head"><Plus /><span className="truncate">{JUST_ARRIVED}</span><span className="tabular-nums text-faint">{late.length}</span></h2>
            <Group list={late} current={current} where />
          </section>
        )}
      </nav>
      {/* They are below what the list shows: said at its foot, and a press goes to them. */}
      {waits && !lateSeen && <LateLine n={late.length} to={lateBox} />}
      </ListCtx.Provider>
      </div>
    </>
  );
}

export function Sidebar({ open }: { open: boolean }) {
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts && !e.read_ts).length);
  const connected = useStore((s) => s.connected);
  const route = useUI((s) => s.route);
  const newUnsent = useUnsent("new");
  const theme = useUI((s) => s.theme);
  const rail = useRail();
  const current = route.name === "session" ? route.id : null;
  const onHelper = useStore((s) => (current ? !!s.sessions[current]?.settings.helper : false));
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  const { card, bind, hide } = useCard();
  const grip = useRef<{ from: number; to: number | null }>({ from: 0, to: null });
  const aside = useRef<HTMLElement>(null);
  useUI((s) => s.listW);
  useEffect(hide, [open, current]);
  // The hand on the list: while it is there, nothing in the list moves, and what stands above it keeps its height.
  const hand = useHand();
  useEffect(() => hand.reset(), [open]);
  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = hand.held ? top.current : null;
    if (!el) return;
    el.style.height = `${el.getBoundingClientRect().height}px`;
    el.style.overflow = "clip";
    return () => { el.style.height = ""; el.style.overflow = ""; };
  }, [hand.held]);
  // The one control that shows the list or folds it, in the same corner either way.
  const Toggle = open ? PanelLeftClose : PanelLeftOpen;
  const toggle = (
    <button
      type="button"
      className="k-act k-fold"
      data-testid="rail-toggle"
      aria-expanded={open}
      aria-controls="k-sessions"
      aria-label={open ? "Fold the session list" : "Show the session list"}
      title={open ? "Fold the session list (Ctrl B)" : rail.tight ? "Show the session list over the panes (Ctrl B)" : "Show the session list (Ctrl B)"}
      onClick={() => toggleList()}
    >
      <Toggle />
    </button>
  );

  return (
    <aside ref={aside} className="k-rail" data-open={open || undefined} data-over={rail.over || undefined} data-narrow={(open && rail.narrow) || undefined} data-testid="sidebar" aria-label="Sessions" style={open && !phone() ? { width: rail.over ? listWidth() : rail.width } : undefined}>
      <div className="k-rail-brand">
        <span className="k-logo" data-live={connected || undefined} title={connected ? "Connected to the daemon" : "Reconnecting to the daemon"}><Logo /></span>
        <span className="k-brand-name">Keel</span>
        {open && !phone() && <PaneCount />}
        {open && toggle}
      </div>
      {open && !rail.over && !rail.narrow && !phone() && (
        <Grip
          className="k-rail-grip"
          testid="list-grip"
          label="Width of the session list"
          now={(100 * (listWidth() - listBounds().min)) / Math.max(1, listBounds().max - listBounds().min)}
          onStart={() => { grip.current = { from: listWidth(), to: null }; }}
          onMove={(dx) => {
            // The list follows the pointer on the page itself; the width is kept when the drag ends.
            const to = Math.round(Math.min(listBounds().max, Math.max(listBounds().min, grip.current.from + dx)));
            grip.current.to = to;
            if (aside.current) aside.current.style.width = `${to}px`;
          }}
          onEnd={() => { if (grip.current.to !== null) savePref("listW", grip.current.to); }}
          onReset={() => savePref("listW", null)}
        />
      )}
      <div className="k-rail-acts">
        {!open && toggle}
        {!open && <PaneCount />}
        <button type="button" className="k-new-session k-act" data-testid="new-session" aria-label={newUnsent ? `New session, ${NEW_UNSENT[newUnsent].line}` : "New session"} title={newUnsent ? NEW_UNSENT[newUnsent].title : "New session (Ctrl Shift O)"} aria-current={route.name === "new" ? "page" : undefined} onClick={() => runCommand("new-session")}>
          <Plus /><span className="k-act-label">New session</span>
          {/* A first message kept in the New box, which nobody may be looking at: said here, in words when the list is open (in the shortcut's place). */}
          {newUnsent && <span data-testid="new-unsent-mark" className="k-act-mark">{NEW_UNSENT[newUnsent].word}</span>}
          {open && !newUnsent && <Kbd keys="mod+shift+o" className="k-act-key ml-auto" />}
        </button>
        <button type="button" className="k-act" data-testid="open-palette" aria-label="Search and commands" title="Search and commands (Ctrl K)" onClick={() => setUI({ palette: true })}>
          <Search /><span className="k-act-label">Search and commands</span>{open && <Kbd keys="mod+k" className="k-act-key ml-auto" />}
        </button>
        {/* The helper: one conversation kept above the sessions (src/helper/). */}
        <button type="button" className="k-act" data-testid="open-helper" aria-label="Helper" title="Helper (Ctrl J)" aria-current={onHelper ? "page" : undefined} onClick={() => void openHelper().catch(reportError)}>
          <Sparkles /><span className="k-act-label">Helper</span>{open && <Kbd keys="mod+j" className="k-act-key ml-auto" />}
        </button>
      </div>
      <div ref={top} className="k-rail-top"><StuckStrip open={open} /></div>
      <CountsKeeper />
      <CardCtx.Provider value={bind}>
        <HandCtx.Provider value={hand}>
          <div id="k-sessions" className="k-rail-body">
            {open ? <Index current={current} /> : <nav className="k-rail-list" data-testid="session-list" data-held={hand.held || undefined} aria-label="Sessions by state" onKeyDown={stepRows} {...hand.on}><Marks current={current} /></nav>}
          </div>
        </HandCtx.Provider>
      </CardCtx.Provider>
      {card && <RailCard s={card.s} y={card.y} left={card.left} row={card.row} cut={card.cut} />}
      <div className="k-rail-foot">
        {!open && (
          <button type="button" className="k-act" data-testid="tab-archived" aria-label="Archived sessions" title="Archived sessions" onClick={() => { openOn = "archived"; toggleList(true); }}>
            <Archive />
          </button>
        )}
        <button type="button" className="k-act k-act-word" data-testid="settings-button" aria-label="Settings" title="Settings" aria-current={route.name === "settings" ? "page" : undefined} onClick={() => navigate({ name: "settings", section: "general" })}>
          <Settings /><span className="k-act-label">Settings</span>
        </button>
        <button type="button" className={cn("k-act", errors > 0 && "k-alert")} data-testid="errors-button" aria-label={`Errors. ${COUNTERS.errors(errors)}`} title={`Errors. ${COUNTERS.errors(errors)}`} onClick={() => setUI({ errors: true })}>
          <Bug />{errors > 0 && <span className="k-act-n">{errors}</span>}
        </button>
        <AutomationFooter />
        <button type="button" className="k-theme-toggle k-act" data-testid="theme-toggle" onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Change`}>
          <ThemeIcon />
        </button>
      </div>
    </aside>
  );
}
