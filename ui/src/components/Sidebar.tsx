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
import { Archive, ArchiveRestore, ArrowDown, Blocks, Bug, ChevronRight, Columns2, Folder, Gauge, Layers2, ListFilter, MessageSquareMore, Moon, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Pin, PinOff, Plus, Search, ServerOff, Settings, Sun, SunMoon, Tag, X } from "lucide-react";
import { createContext, Fragment, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { composing, runCommand } from "../lib/keys.ts";
import { machineName, machineReach, useFleet } from "../lib/fleet.ts";
import { getStations, stations, useStations } from "../lib/stations.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { actedOn, anchorRow, dropAnchor, focusRow, forgetActed, jumpNext, listActed, nameCounts, nameUnder, onReveal, reanchor, scrollerOf, useActed, useAnchor, useCounts, useHand, usePhoneWidth, useUnderLook, type Hand, type Kind } from "../lib/list-hold.ts";
import { around, folders, held as heldList, isNews, pinnedOrder, tally } from "../lib/list-order.ts";
import { countedState, withAgentFailures } from "../lib/home.ts";
import { focusAsk } from "../lib/asks.ts";
import { announce } from "../lib/announce.ts";
import { useNeedUnderLooks } from "../lib/looks.ts";
import { useQueued } from "../lib/queued.ts";
import { useCap } from "../lib/caps.ts";
import { capTip, dollars } from "../../../src/automation/cap-rules.ts";
import { callsigns, listBounds, listWidth, panesMax, toggleList, useRail } from "../lib/rail.ts";
import { opened, openFocus } from "../lib/self-focus.ts";
import { fitBands } from "../lib/rail-fit.ts";
import { navigate, phone, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, clock, cn, folderNames, timeBucket, when } from "../lib/utils.ts";
import { AT_REST, branchOf, lastLine, useLastLine, useNeedCount, useSessionState, useSessionStates, type SessionState, type Watch } from "../lib/watch.ts";
import { COUNTERS, WAITS_ON_YOU, backgroundOf, dotWord, DECLINED_WORD, agentsFailedWord, JUST_ARRIVED, NEW, NEW_SINCE, OFFLINE, STATE_WORD, STALE_WORD, asOf, countName, countWord, countsNow, holdsWords, lastTold, queuedWord, stateAlone, stateLabel, stateWords, wentWrongWord } from "../../../src/core/state-words.ts";
import { OUTSIDE_LABEL, hhmm } from "../../../src/core/watch.ts";
import { useUnsent, useWaitingSend } from "../lib/send-drafts.ts";
import { MachineSep, machineRuns, useWhere, WherePip, whereWords } from "./Where.tsx";
import { finished, ListFind, matches, order, readNote, sawNote, setArrange, useArrange, useNote } from "./ListArrange.tsx";
import { useLink } from "./Stale.tsx";
import { useReach } from "../lib/reach.ts";
import { auto, useAuto } from "../lib/automation.ts";
import { setAgentsOpen, useAgentsOpen } from "../lib/agents-open.ts";
import { isCounted } from "../../../src/core/agent-count.ts";
import { briefText, failWord, folderOf, Mark, modelOf, ROW_BEAT, rowClock, stateClock, tickOf, timed, useNow, whyText } from "./Mark.tsx";
import { AutomationFooter, SessionBadges, SessionChildren } from "./automation/SidebarExtras.tsx";
import { DRAG, dragSession, PanesButton } from "./Panes.tsx";
import { PaneMenu } from "./PaneMenu.tsx";
import { Grip } from "./Grip.tsx";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";
import { archive, movePin, pin, pinnedNow, placePin } from "../lib/sessops.ts";
import { RowMenu, type RowMenuAt } from "./RowMenu.tsx";
import { ProjectGroups } from "./SidebarProjects.tsx";
import { FolderGroups } from "./SidebarFolders.tsx";
import { openHelper } from "../lib/helper.ts";
import { HelperFace, useHelperName } from "./HelperFace.tsx";
import { Seg, tabId } from "./Seg.tsx";
import { StuckStrip } from "./Stuck.tsx";
import { calls, useSettled, useSettledState, useSettledStates } from "../lib/settle.ts";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
// The filter box draws again only when its words or its width change, not with every change of the list
// under it (a field drawn again is written again: React sets its name, many times a second in a busy list).
const Find = memo(ListFind);

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

// The row's chevron for the agents the session started: the tree opens under the row (SessionChildren) and
// the owner's choice is kept. How many work, wait, failed or are done is said in the session itself
// (AgentsDock.tsx); the row says only that there is a tree. Shown only for a session that has agents.
function AgentsToggle({ id }: { id: string }) {
  const has = useAuto((x) => Object.values(x.agents).some((a) => a.parent_id === id && isCounted(a)));
  const open = useAgentsOpen(id);
  if (!has) return null;
  const words = open ? "Hide agents" : "Show agents";
  return (
    <button
      type="button"
      tabIndex={-1}
      className="k-row-act k-row-kids-toggle"
      data-testid="children-toggle"
      aria-expanded={open}
      aria-label={words}
      title={words}
      onClick={(e) => {
        e.stopPropagation();
        // The list held under the hand keeps the height of what is under a row: this press is the owner's, so it lets go.
        const kids = e.currentTarget.closest<HTMLElement>('[data-testid="session-row"]')?.parentElement?.querySelector<HTMLElement>(".k-row-kids");
        if (kids) { kids.style.height = ""; kids.style.overflow = ""; }
        if (e.detail > 0) e.currentTarget.blur();
        setAgentsOpen(id, !open);
      }}
    >
      <ChevronRight className="k-row-kids-fold" aria-hidden="true" />
    </button>
  );
}

// `given`: the session as the list ordered it (held still under the hand); the row shows it as it is now.
// `gone`: it left the list while the list was held, and its row stays, dimmed, until the hand has left.
// A row draws again only for what it shows: its own reads (the session as it is now, its state,
// its queue) tell it. The list draws again with every change of any session and asks none of
// its rows to follow: a new session object with the same id and the same archive mark is the same row.
// Rows at rest say no age until they are this old (lib/utils.ts, timeBucket: 0 now, 1 within the hour).
const QUIET_BUCKET = 2;
const Row = memo(RowOf, (a, b) => a.s.id === b.s.id && !!a.s.archived === !!b.s.archived && a.active === b.active && a.where === b.where && a.gone === b.gone && a.calm === b.calm && a.said === b.said);
// The row's end is one slot, and it always holds the row's age; before it, the word of a row that waits on the
// owner (you) or was declined. A failure's class is on the row's line and in the slot's tooltip. The chevron of a
// session that started agents stands left of its title. News is the title's ink (bridge.css) and a word for a
// reader, not a dot in that slot.
// `calm`: a session at rest whose time says nothing the quiet row above it did not (the same bucket,
// timeBucket): its time is in its tooltip only.
// `said`: the time the row says at rest, read on the page's clock by the list (the row is drawn again when the words change).
function RowOf({ s: given, active, where, gone, calm, said }: { s: Session; active: boolean; where?: boolean; gone?: boolean; calm?: boolean; said?: string }) {
  const live = useStore((x) => x.sessions[given.id]);
  const deleted = useStore((x) => !!x.gone[given.id]);
  const s = live ?? given;
  const { narrow, lines, watches: heldWatches } = useContext(ListCtx);
  const restore = s.archived;
  // A session whose agents failed reads Failed until the owner looks at it, as the counters count it (lib/home.ts);
  // as the list shows it: a change that calls the owner at once, any other once it has held (lib/settle.ts).
  const own = useSessionState(s);
  const counted = useMemo(() => countedState(s, own), [s, own]);
  // (Its own entry: the counted state can differ from the one the order and the counts read.)
  const st = useSettledState(`row:${s.id}`, counted);
  const w = st.watch;
  // A machine that does not answer: what its rows say is the last it told, so they are dimmed and their clocks stand.
  // The state says so itself (lib/watch.ts: `offline`, and `as_of` when it was last told), until the machine has stayed heard.
  const offline = !!st.offline;
  const now = useNow(timed(st) && !offline, ROW_BEAT);
  // A row of one line may have no room for its reason: the card beside it comes sooner.
  const card = useContext(CardCtx)(s, lines === "one" ? 250 : 450, lines === "two");
  // A message of the session waits for the daemon to be back and goes out by itself: said on the
  // state line, whatever the state is (it is the reason itself when the session is otherwise at rest).
  const waitingSend = useWaitingSend(s.id);
  const queued = useQueued(s.id, QUEUES.includes(w) && !restore);
  // Its dollar cap, when it has one: the share spent and the rate of the last ten minutes (lib/caps.ts).
  const cap = useCap(s.id, !!s.settings.cap_usd);
  // When its machine last told of it (the state says so once the daemon serves it; until then, its last change).
  const toldAt = (st as { as_of?: number }).as_of ?? s.updated;
  const shown = useStations((x) => x.shown.includes(s.id));
  const panes = useStations((x) => x.count);
  const [placing, setPlacing] = useState(false);
  const [menu, setMenu] = useState<RowMenuAt | null>(null);
  // Renamed in place (F2, or Rename in the row's menu): the name the owner gives is the session's own and no
  // auto title or import replaces it (title_by is empty then, as when it is renamed in the header).
  const [renaming, setRenaming] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const unread = useAuto((x) => (x.unread.sessions[s.id] ?? 0) > 0);
  const pinned = !!s.settings.pinned_ms && !restore;
  // It, or an agent of it, needs the owner while its pane shows another session for now (a look lies over it).
  const under = useUnderLook(s.id);
  // Who a row that calls the owner waits on, in the time's place on a row of one line: the owner, or the
  // failure's class (what to see to). The time is the word's tooltip. A row of two lines says it on its
  // second line and keeps the time; a list too narrow for the time says it on the reason's line.
  // A row red for its agents says how many failed; a failure with no class still says so in a word.
  const cls = failWord(st.cls);
  const agents = w === "fail" && st.why === "agents" ? agentsFailedWord(st.agents_failed ?? 1) : "";
  const on = !narrow && lines === "one" && !offline && !gone ? (w === "need" ? WAITS_ON_YOU : w === "declined" ? DECLINED_WORD : "") : "";
  // A menu of the row is the hand on the list: the list is held while one is open.
  const keep = useContext(HandCtx).keep;
  const over = placing || !!menu || renaming;
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
  const togglePin = (keys = false) => pin(s.id, !pinned, !keys).then(() => { if (keys) focusRow(s.id); }, reportError);
  const left = !gone ? null : deleted || (!live && !given.archived) ? "deleted" : given.archived ? "restored" : "archived";
  // News is a dot at the row's end, where the list's count of what is new counts it (lib/list-order.ts: isNews).
  const news = unread && !gone && !left && !offline && isNews(w);
  // The dot's word a phone shows in the row (bridge.css): what the row does not say in words, apart from a session at rest (done
  // is the dot, one line), and what it waits on in the background.
  const dotWords = !offline && !left && (backgroundOf(st) ? true : !SPELLED.includes(w) && w !== "done" && w !== "idle");
  // The card beside the row is away while a menu of the row is open over it.
  useEffect(() => { if (over && row.current) card.onClick?.({ currentTarget: row.current }); }, [over]);
  // A session of another harness that Keel only shows has no name of Keel's to give.
  const canRename = !left && !s.outside && !phone();
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
      data-news={news || undefined}
      data-offline={offline || undefined}
      data-dotword={dotWords ? (backgroundOf(st) ? "long" : "short") : undefined}
      data-gone={gone || undefined}
      data-pinned={pinned || undefined}
      data-under={under || undefined}
      // In a list too narrow for words beside the title, a row that calls the owner keeps its reason on a
      // line of its own. Decided by the state the list holds: no row grows under the hand.
      data-reason={(narrow && calls(heldWatches[s.id] ?? w) && !offline && !left) || undefined}
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
        if (e.key === "F2" && canRename) { e.preventDefault(); e.stopPropagation(); return setRenaming(true); }
        if (e.altKey && pinned && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); return move(e.key === "ArrowUp" ? -1 : 1); }
        if (e.key !== "Enter") return;
        // Shift Enter: the menu of panes, to place the session in one of them.
        if (e.shiftKey && panes > 1 && !restore && !phone()) { e.preventDefault(); return setPlacing(true); }
        open(e.ctrlKey || e.metaKey);
      }}
      className="k-row group"
    >
      <Mark w={w} st={st} />
      <AgentsToggle id={s.id} />
      {/* The title and the row's own line: the state with why (and the folder, where the list is not
          grouped by it). In a row of one line the words follow the title where it leaves them room,
          and are on the card beside the row where it does not; in a row of two they are the second
          line, as wide as the row. A session at rest says no word the mark already says. */}
      <span className="k-row-main">
        {renaming
          ? <RowName s={s} done={() => { setRenaming(false); requestAnimationFrame(() => row.current?.focus()); }} />
          : (
            /* Another harness's session says which in its tooltip, not in a chip beside the title. */
            <span className="k-row-title" title={s.outside ? outsideTip(s.outside) : undefined}>{s.title || "New session"}</span>
          )}
        <span className="k-row-sub">
          {/* A machine that does not answer says nothing new: the row's word is Offline (at the line's end), with when it last told here and what under the pointer. */}
          {offline
            ? <span className="k-row-why" data-testid="row-why" data-why="offline">{asOf(clock(toldAt))}</span>
            : SPELLED.includes(w)
            ? <span className="k-row-state" data-testid="row-state">{/* One line: how many agents work is said in the session itself, not on its row. */lines === "one" ? stateWords(st).word : stateLabel(st)}</span>
            : lines === "two" && <RestLine s={s} />}
          {/* On a phone there is no tooltip to read the dot's word in: a state the row does not say in words (a session at rest,
              what it waits on in the background) and the white news dot are said here, in the row (bridge.css shows it there only). */}
          {dotWords && (
            <span className="k-row-dot-word" aria-hidden="true" data-testid="row-dot-word" data-bg={backgroundOf(st)}>{dotWord(st)}</span>
          )}
          {/* A state that is not current because the page does not hear the daemon says since when. (A machine out of reach: above.) */}
          {!left && !offline && !!st.as_of && <span className="shrink-0 whitespace-nowrap text-micro text-muted" data-testid="row-asof">{asOf(clock(st.as_of))}</span>}
          {!offline && w === "fail" && failWord(st.cls) && !on && <span className="k-row-class" data-testid="row-class">{failWord(st.cls)}</span>}
          {!offline && SPELLED.includes(w) && st.text && st.why !== "send" && <span className="k-row-why" data-testid="row-why" data-why={st.why}>{briefText(st, now)}</span>}
          {waitingSend && <span className="k-row-send" data-testid="waiting-send-mark" title="A message here waits for Keel and goes out by itself when it is back.">waits to send</span>}
          {where && <span className="k-row-in" data-testid="row-folder">{folderOf(s)}</span>}
        </span>
      </span>
      {/* The first line's end: the tag, the marks, the time, and under the pointer the row's actions in the time's place. */}
      <span className="k-row-end">
        {(s.settings.tags ?? []).slice(0, 1).map((t) => <span key={t} title={(s.settings.tags ?? []).join(", ")} className="k-row-tag shrink truncate rounded-xs bg-sunken px-1 text-micro text-faint" data-testid="row-tag">{t}</span>)}
        {s.outside && <OutsideTag o={s.outside} />}
        <SessionBadges sessionId={s.id} />
        {/* What it needs is under a look: its pane shows another session for now. */}
        {under && <span className="k-row-under" data-testid="row-under" role="img" aria-label={`${STATE_WORD.need}, under a look`} title={`${STATE_WORD.need} while its pane shows another session for now`}><Layers2 aria-hidden="true" /></span>}
        {/* Its dollar cap: what share is spent, and the rate an hour. */}
        {cap && !left && <span className="k-row-cap" data-testid="row-cap" data-level={cap.level} title={capTip(cap, s.title || "This session")}><Gauge aria-hidden="true" />{Math.floor(cap.pct * 100)}%{cap.burn_hour > 0 && <span className="k-row-cap-rate">{dollars(cap.burn_hour)}/h</span>}</span>}
        {/* A message of theirs that waits in the session's queue. */}
        {queued > 0 && !left && <span className="k-row-queued" data-testid="row-queued" role="img" aria-label={queuedWord(queued)} title={`${queued} message${queued > 1 ? "s" : ""} of yours ${queued > 1 ? "wait" : "waits"} here for the turn to end`}><MessageSquareMore aria-hidden="true" />{queued}</span>}
        {/* The time a glance wants: how long it has needed them, worked on this step or waited (when a timer is due); at rest, when it last moved. */}
        {left
          ? <span className="k-row-time" data-testid="row-gone" data-offline title="It left the list while your hand was on it, and goes when your hand has left">{left}</span>
          : offline
          ? <span className="k-row-time group-hover:hidden group-focus-within:hidden" data-testid="row-time" data-offline title={`Its machine does not answer: this is the last it told, ${when(toldAt)}`}>{OFFLINE}</span>
          // One slot: the age of every row, and before it the word of a row that waits on the owner or was declined.
          // (A reader hears the state before the word: the line's own state word gives way to it.)
          : <span className="k-row-time tabular-nums group-hover:hidden group-focus-within:hidden" data-testid="row-time" data-live={timed(st) || undefined} data-calm={(!timed(st) && !SPELLED.includes(w) && calm) || undefined} data-on={on || undefined}
              title={timed(st) ? (st.until ? `Due ${when(st.until)}` : w === "need" ? `${STATE_WORD.need} since ${when(st.since!)}` : `Since ${when(st.since!)}`) : on ? `${STATE_WORD[w]} ${when(st.since ?? s.updated)}` : w === "fail" ? `${[STATE_WORD.fail, agents || cls].filter(Boolean).join(": ")}, ${when(s.updated)}` : when(s.updated)}>
              {/* What waits on the owner is its dot's yellow and its title's weight: no word of its own in the slot (a reader has it here). */}
              {on && <span className="k-row-on" data-testid="row-on" data-on={w}>{w === "need" ? <span className="sr-only">{STATE_WORD.need} </span> : on}</span>}{on && w !== "need" && " "}
              {timed(st) ? rowClock(st, now) : said ?? ago(s.updated)}
            </span>}
        {/* (A row whose session left has no actions: there is nothing to act on.) */}
        {/* (Pressed with the pointer, it leaves the keyboard where it was: a focus the owner did not give
            the row would hold the list after the pointer left, and the pinned row would not take its place.) */}
        {!left && !restore && !phone() && (
          <button type="button" tabIndex={-1} title={pinned ? "Unpin" : "Pin to the top of the list"} aria-label={pinned ? "Unpin" : "Pin"} aria-pressed={pinned} data-testid="row-pin" onClick={(e) => { e.stopPropagation(); if (e.detail > 0) e.currentTarget.blur(); togglePin(e.detail === 0); }} className="k-row-act hidden group-hover:grid group-focus-within:grid">
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
      {/* News is the title's weight (bridge.css), not a dot: the state's dot is the row's one colour. A reader is told in words. */}
      {news && <span className="sr-only" data-testid="row-new">{NEW}</span>}
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
          onRename={canRename ? () => setRenaming(true) : undefined}
          onArchive={() => { listActed(s.id); archive(s, !restore).catch(reportError); }}
          // The same mark the row's dot reads (the command and the session menu set it too): kept until the session is opened again.
          onUnread={!unread && !s.machine && !s.parent_id ? () => { listActed(s.id); auto.unreadSession(s.id).catch(reportError); } : undefined}
          session={s.machine ? undefined : { id: s.id, folder: s.settings.folder_id ?? null }}
        />
      )}
    </div>
  );
}

// A row's title as a field: Enter or leaving it keeps the name, Escape leaves it as it was. An empty name
// asks for none (the title stays).
function RowName({ s, done }: { s: Session; done: () => void }) {
  const [v, setV] = useState(s.title);
  const input = useRef<HTMLInputElement>(null);
  const over = useRef(false);
  // From the row's menu the menu gives the focus back to the row as it closes: the field takes it again, and
  // a blur before that is not the owner leaving it.
  const armed = useRef(false);
  useEffect(() => {
    input.current?.focus(); input.current?.select();
    const t = setTimeout(() => { armed.current = true; if (document.activeElement !== input.current) { input.current?.focus(); input.current?.select(); } }, 150);
    return () => clearTimeout(t);
  }, []);
  const keep = (save: boolean) => {
    if (over.current) return;
    over.current = true;
    const t = v.trim();
    if (save && t && t !== s.title) actions.patch(s.id, { title: t }).catch(reportError);
    done();
  };
  return (
    <input
      ref={input}
      value={v}
      data-testid="row-rename"
      aria-label="Session name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (armed.current) keep(true); }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e)) return;
        if (e.key === "Enter") { e.preventDefault(); keep(true); }
        if (e.key === "Escape") { e.preventDefault(); keep(false); }
      }}
      className="k-row-title k-row-name"
    />
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
  const now = useNow(true, ROW_BEAT);
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
  // A quiet row's time shows past the hour, where it starts a new bucket after the quiet row above it: a calm list is
  // not a column of the same "7m" or "now". (A live clock, a word in the time's place: always shown. News is the title's
  // ink, so a row with news follows the same rule.)
  // The buckets are read on the page's clock (lib/clock.ts), so a list nobody touched changes with the time.
  const calm = new Set<string>();
  let above = -1;
  for (const s of shown) {
    if (!AT_REST.includes(watches[s.id] ?? "idle")) continue;
    const b = timeBucket(s.updated, now);
    // Within the hour a finished row says no age: its dot says it, and its tooltip has the time.
    if (b === above || b < QUIET_BUCKET) calm.add(s.id);
    above = b;
  }
  return (
    <div className="flex flex-col gap-px">
      {shown.map((s) => (
        <div key={s.id}>
          <Row s={s} active={current === s.id} where={where} gone={gone.has(s.id)} calm={calm.has(s.id)} said={ago(s.updated, now)} />
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

// What calls the owner and is out of the list's view: named at the list's foot, each a press away.
// With many sessions the rows that need the owner or failed are below what the list shows (they are
// never folded away, but a list of fifty rows is three screens): the line above the list counts them,
// and here they are named. At the foot, so the list's rows stand where they stand when a name comes
// or goes: what shrinks is the room under them. A press opens the session, as its row does.
// Another machine's part of the list, when it begins below what the list shows: its name and count at
// the list's foot, a press away (a long list of this machine's sessions hid that there are others).
// The observers that say what is out of view watch what the list scrolls in (scrollerOf, in
// lib/list-hold.ts), and look again when the screen crosses the phone's width or the text size changes.
// What stands over the top of that box: on a phone the find stays there as the rows scroll under it
// (bridge.css), so a row behind it is out of view. Its height and the room above it, as a root margin
// (the band of the panel's color under it is paint, not cover: a row whose edge it touches is read whole).
const coverOf = (root: HTMLElement) => {
  const find = root.querySelector<HTMLElement>(":scope > .k-find");
  if (!find || !find.offsetHeight || getComputedStyle(find).position !== "sticky") return "0px";
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return `${-Math.ceil(find.offsetHeight + 0.25 * rem)}px 0px 0px 0px`;
};

function MachinesBelow({ nav, machines }: { nav: { current: HTMLElement | null }; machines: { machine: string; list: Session[] }[] }) {
  const key = machines.map((m) => `${m.machine}:${m.list.length}`).join(" ");
  // What waits on the owner and what works there, in the words of the counts: a folded part still says it.
  const states = useSessionStates(useMemo(() => machines.flatMap((m) => m.list), [machines]));
  const [below, setBelow] = useState<string[]>([]);
  const narrowScreen = usePhoneWidth();
  useEffect(() => {
    const root = scrollerOf(nav.current);
    if (!root || !machines.length) return setBelow([]);
    const at = new Map<string, boolean>();
    const io = new IntersectionObserver((es) => {
      for (const e of es) at.set((e.target as HTMLElement).dataset.machine!, !e.isIntersecting && e.boundingClientRect.top >= (e.rootBounds?.bottom ?? 0) - 1);
      const next = machines.map((m) => m.machine).filter((m) => at.get(m));
      setBelow((was) => (was.join(" ") === next.join(" ") ? was : next));
    }, { root });
    for (const m of machines) { const el = root.querySelector(`[data-testid="machine-sep"][data-machine="${CSS.escape(m.machine)}"]`); if (el) io.observe(el); }
    return () => io.disconnect();
  }, [key, nav, narrowScreen]);
  if (!below.length) return null;
  return (
    <div className="k-machines-below" data-testid="machines-below">
      {machines.filter((m) => below.includes(m.machine)).map((m) => (
        <button key={m.machine} type="button" className="k-late-line" data-testid="machine-foot" data-machine={m.machine} title={`The sessions on ${machineName(m.machine) ?? m.machine}, below`}
          onClick={() => nav.current?.querySelector(`[data-testid="machine-sep"][data-machine="${CSS.escape(m.machine)}"]`)?.scrollIntoView({ block: "start" })}>
          <ArrowDown aria-hidden="true" /><span className="min-w-0 truncate">{machineName(m.machine) ?? m.machine}</span>
          {(["need", "work"] as const).map((w) => { const n = m.list.filter((s) => states[s.id]?.watch === w).length; return n > 0 ? <span key={w} className={cn("shrink-0 tabular-nums", w === "need" ? "text-st-need" : "text-st-work")} data-testid={`machine-foot-${w}`}>{countWord(w, n)}</span> : null; })}
          <span className="ml-auto tabular-nums text-faint">{m.list.length}</span>
        </button>
      ))}
    </div>
  );
}

// What is out of the list's view is one chip, "Next: <title>", with the count of the rest behind "+N": the foot
// does not repeat the rows the list holds, and it takes the room of one row.
const STRIP_MOST = 1;
function NeedStrip({ nav, open }: { nav: { current: HTMLElement | null }; open: (id: string) => void }) {
  const counts = useCounts();
  const ids = useMemo(() => [...counts.need, ...counts.fail], [counts]);
  const titles = useStore((x) => ids.map((id) => x.sessions[id]?.title || "New session").join("\u0000"));
  const title = (id: string) => titles.split("\u0000")[ids.indexOf(id)] ?? "New session";
  const key = ids.join(" ");
  const [found, setOut] = useState<string[]>([]);
  const narrowScreen = usePhoneWidth();
  // The find's height, which the observer leaves out on a phone, goes with the text size.
  const scale = useUI((x) => x.scale);
  // ... and with the find's coming and going: a slim drawer keeps it behind an icon (it has no height then).
  const [cover, setCover] = useState("0px");
  useEffect(() => {
    const root = scrollerOf(nav.current);
    const find = root?.querySelector<HTMLElement>(":scope > .k-find");
    if (!root || !find) return setCover("0px");
    const look = () => setCover(coverOf(root));
    look();
    const ro = new ResizeObserver(look);
    ro.observe(find);
    return () => ro.disconnect();
  }, [nav, narrowScreen, scale]);
  useEffect(() => {
    const root = scrollerOf(nav.current);
    if (!root || !ids.length) return setOut([]);
    // What the observer said of each row it watches. A row it has not spoken of yet is left out: named
    // before the first word, every row was named for a frame each time the set of sessions changed.
    // A session the list does not draw (another tab, filtered out) is out of view and named.
    const seen = new Map<Element, boolean>();
    let at: (Element | null)[] = [], frame = 0;
    const say = () => { const next = ids.filter((_, i) => (at[i] ? seen.get(at[i]!) === false : true)); setOut((was) => (was.join(" ") === next.join(" ") ? was : next)); };
    const io = new IntersectionObserver((es) => { for (const e of es) seen.set(e.target, e.intersectionRatio > 0.99); say(); }, { root, rootMargin: cover, threshold: [0, 1] });
    // The rows are looked for again when the list draws others (a fold, a group, a row that came).
    const watch = () => {
      frame = 0;
      const rows = ids.map((id) => root.querySelector(`[data-testid="session-row"][data-session="${CSS.escape(id)}"]`));
      if (rows.length === at.length && rows.every((r, i) => r === at[i])) return;
      for (const r of at) if (r && !rows.includes(r)) { io.unobserve(r); seen.delete(r); }
      for (const r of rows) if (r && !at.includes(r)) io.observe(r);
      at = rows;
      say();
    };
    watch();
    const mo = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(watch); });
    mo.observe(root, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); cancelAnimationFrame(frame); };
  }, [key, nav, narrowScreen, scale, cover]);
  // While the hand is on the list the strip stands as it was: it never grows over the row under the pointer.
  const held = useContext(HandCtx).held;
  const kept = useRef(found);
  if (!held) kept.current = found;
  const out = kept.current.filter((id) => ids.includes(id));
  // The first name, and the rest behind "+N": nothing in it scrolls out of
  // sight. Counted down before the frame is painted, from the most (STRIP_MOST) each time what it
  // names or its room changes.
  const box = useRef<HTMLDivElement>(null);
  const most = Math.min(out.length, STRIP_MOST);
  const outKey = out.join(" ");
  const [fit, setFit] = useState({ key: "", n: most });
  const [room, setRoom] = useState("");
  const n = fit.key === `${outKey}|${room}` ? fit.n : most;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const over = el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    setFit((was) => {
      const k = `${outKey}|${room}`;
      const from = was.key === k ? was.n : most;
      const next = over && from > 0 ? from - 1 : from;
      return was.key === k && was.n === next ? was : { key: k, n: next };
    });
  }, [outKey, room, n, most]);
  // Its room: its width, and the height of the rail's body its most is a part of (never its own
  // height, which follows what it holds).
  const shown = out.length > 0;
  useEffect(() => {
    const el = box.current, body = el?.closest<HTMLElement>(".k-rail-body");
    if (!el || !body) return;
    const ro = new ResizeObserver(() => setRoom(`${Math.round(el.getBoundingClientRect().width)}x${Math.round(body.getBoundingClientRect().height)}`));
    ro.observe(el);
    ro.observe(body);
    return () => ro.disconnect();
  }, [shown, scale]);
  if (!out.length) return null;
  const need = new Set(counts.need);
  const rest = out.slice(n);
  return (
    <div ref={box} className="k-need-strip" data-testid="need-strip" role="group" aria-label="Out of view in the list: what needs you or failed">
      {out.slice(0, n).map((id) => (
        <button key={id} type="button" className="k-need-name" data-session={id} data-watch={need.has(id) ? "need" : "fail"} title={`${title(id)}: ${need.has(id) ? STATE_WORD.need.toLowerCase() : STATE_WORD.fail.toLowerCase()}. Open it`} onClick={() => open(id)}>
          <Mark w={need.has(id) ? "need" : "fail"} /><span className="k-need-title"><span className="k-need-next">Next: </span>{title(id)}</span>
        </button>
      ))}
      {rest.length > 0 && <button type="button" className="k-need-name k-need-more" data-testid="need-strip-more" title={rest.map(title).join(", ")} onClick={() => jumpNext(need.has(rest[0]!) ? "need" : "fail")}>+{rest.length}</button>}
    </div>
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
  const states = useSettledStates(useSessionStates(live));
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
                      aria-label={`${s.title || "New session"}, ${stateAlone(states[s.id] ?? { watch: watches[s.id] ?? "idle" })}${states[s.id]?.text ? `: ${states[s.id]!.text}` : ""}, ${folderOf(s)}${whereWords(s)}, ${ago(s.updated)}${unread[s.id] && AT_REST.includes(watches[s.id] ?? "idle") ? `, ${NEW.toLowerCase()}` : ""}`}
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
  const now = useNow(timed(st) && !offline, tickOf(st));
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
          {s.outside && <><dt>Runs in</dt><dd>{OUTSIDE_LABEL[s.outside.harness] ?? s.outside.harness}</dd></>}
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
        {s.outside && <><dt>Runs in</dt><dd>{OUTSIDE_LABEL[s.outside.harness] ?? s.outside.harness}</dd></>}
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
  { kind: "wait", watch: "wait", says: STATE_WORD.wait },
  { kind: "unread", says: NEW_SINCE },
  { kind: "offline", says: "On a machine that does not answer" },
];
// The line fits its bar at every width and text size, and a figure is never cut: measured on the
// line itself. Every count keeps its mark and its figure, and the words take the room that is
// left, the one that calls the owner first, the states before what is new (whose mark is the
// rows' own dot for news), the room between the counts given up before a word. With no room for
// a word the line's calm sentence goes, then the room between the counts, and at the very
// narrowest whole counts, the ones that call the owner last.
const WORDS_STAY: Kind[] = ["need", "fail", "offline", "work", "wait", "unread"];
const COUNTS_GO: Kind[] = ["wait", "work", "unread", "offline"];
// A count's tooltip starts with the count in its words, which a count whose word has no room keeps there.
const tipHead = (c: (typeof COUNTS)[number], n: number, word: string) => c.kind === "offline" ? c.says : `${n} ${c.kind === "unread" ? NEW_SINCE.toLowerCase() : word}`;
function fitSummary(el: HTMLElement) {
  const chips = [...el.querySelectorAll<HTMLElement>(".k-sum-chip")];
  const chip = (k: Kind) => chips.find((c) => c.dataset.kind === k);
  const calm = el.querySelector<HTMLElement>(".k-sum-calm");
  const over = () => el.scrollWidth > el.clientWidth || (!!calm && !calm.hidden && calm.scrollWidth > calm.clientWidth);
  el.removeAttribute("data-tight");
  if (calm) calm.hidden = false;
  for (const c of chips) { c.hidden = false; c.setAttribute("data-bare", ""); c.removeAttribute("data-short"); }
  if (!over()) {
    for (const k of WORDS_STAY) {
      const c = chip(k);
      if (!c) continue;
      c.removeAttribute("data-bare");
      // "failed or declined" gives up its second half before a count loses its word: the tooltip has it whole.
      if (over()) chips.find((x) => x.querySelector(".k-sum-or"))?.setAttribute("data-short", "");
      // Closer counts first, then the word goes: a word that says less is not shown where one that says more has no room.
      if (over() && !el.hasAttribute("data-tight")) { el.setAttribute("data-tight", ""); if (!over()) continue; el.removeAttribute("data-tight"); }
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
  // The machines out of reach, for the offline count: its name when it is one machine, and since when in its tip.
  const out = useReach((x) => x.unheard);
  const down = [...new Set(counts.offline.map((id) => sessions[id]?.machine).filter((m): m is string => !!m && !!out[m]))].map((m) => out[m]!);
  const since = down.map((m) => `${m.name}${m.since ? ` since ${clock(m.since)}` : ""}`).join(", ");
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
    return { n: ids.length, word: kind === "work" || kind === "wait" ? countName(kind, ids.length) : kind === "unread" ? NEW.toLowerCase() : OFFLINE.toLowerCase() };
  };
  // What the fit depends on: which counts show, how many figures each has and its word. A count that
  // goes from 4 to 5 is as wide as it was, and is not measured again (a fit writes every chip twice).
  const figures = COUNTS.filter((c) => counts[c.kind].length > 0).map((c) => { const x = said(c.kind, counts[c.kind]); return `${c.kind}:${String(x.n).length}:${x.word}`; }).join("|");
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
            aria-label={`${n} ${c.kind === "offline" && since ? `on ${since}, ${word}` : word}. Go to the next`} title={`${tipHead(c, n, word)}${c.kind === "offline" && since ? ` (${since})` : ""}: ${names}${ids.length > 6 ? `, and ${ids.length - 6} more` : ""}. Press to go to the next one's row${c.kind === "need" ? " (Alt A opens it)" : ""}.`}>
            {/* One sentence in the text face: the rows' marks say each state, the line says how many. */}
            {c.kind === "offline" && <ServerOff aria-hidden="true" />}
            {/* A count whose word has no room keeps its state's mark, so the figure still says what it counts. */}
            {c.watch && c.kind !== "need" && c.kind !== "fail" && <span className="k-sum-mark" aria-hidden="true"><Mark w={c.watch} /></span>}
            {c.kind === "unread" && <span className="k-sum-mark" aria-hidden="true"><span className="k-sum-dot" /></span>}
            <b className="k-sum-n">{n}</b>
            <span className="k-sum-word">{c.kind === "offline" && down.length === 1 && <span className="inline-block max-w-[6.5rem] truncate align-bottom" data-testid="sum-offline-name">{down[0]!.name}</span>}{c.kind === "offline" && down.length === 1 ? " " : ""}{c.kind === "fail" && word.includes(" or ") ? <>{word.split(" or ")[0]}<span className="k-sum-or"> or {word.split(" or ")[1]}</span></> : word}</span>
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
  // Counted as the rows show them (lib/settle.ts): the line above the list moves with the rows.
  const states = useSettledStates(useSessionStates(top));
  // What is new, as the rows show it: a finish comes to the count once it has settled, a read leaves it at once.
  const liveUnread = useAuto((x) => x.unread.sessions);
  const unreadKey = Object.entries(liveUnread).filter(([, n]) => (n ?? 0) > 0).map(([id]) => id).sort().join(" ");
  const unread = useSettled("unread", liveUnread, unreadKey, (was) => Object.keys(was).some((id) => (was[id] ?? 0) > 0 && !((liveUnread[id] ?? 0) > 0)));
  // The machines that do not answer, as one word: it changes when one of them does. A machine is
  // among them until it has stayed heard a while (lib/reach.ts), so the count does not come and go with a link that does.
  const down = useReach((x) => Object.keys(x.unheard).sort().join(" "));
  // A session that needs them while its pane shows another for now (a look lies over it) is on no
  // screen: it is counted with what needs them, by the row that stands for it (its own, or its
  // root's when it is an agent's), whatever that row's own state says.
  const under = useNeedUnderLooks().map((id) => rootSessionId(sessions, id) ?? id).join(" ");
  const counts = useMemo(() => {
    const off = new Set(down.split(" ").filter(Boolean));
    // (A session whose machine does not answer is counted as offline, below, and as nothing else.)
    // A failure counts as the home screen's headline counts it: until the owner has looked at it, a
    // session's own or its agents' (lib/home.ts). Looked at, it is a failed row in the list, not news:
    // two counters on one screen give one number.
    const counted = withAgentFailures(top, states as Record<string, SessionState>);
    const t = tally(top.filter((s) => countsNow(states[s.id])), counted.states, unread);
    t.fail = t.fail.filter((id) => counted.unseen.has(id));
    const more = under.split(" ").filter((id) => id && !t.need.includes(id) && top.some((s) => s.id === id));
    return { ...t, need: [...t.need, ...more], offline: top.filter((s) => s.machine && off.has(s.machine)).map((s) => s.id) };
  }, [top, states, unread, down, under]);
  useEffect(() => nameCounts(counts), [counts]);
  useEffect(() => nameUnder(under.split(" ").filter(Boolean)), [under]);
  return null;
}

// The note above the list was on screen: it is read for the next load (ListArrange.tsx).
const sawNoteRef = (el: HTMLElement | null) => { if (el) sawNote(); };

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
  const states = useSettledStates(useSessionStates(base_));
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
  const shown = listed.filter((s) => !s.settings.pinned_ms && !(arr.hideDone && finished(watches[s.id]) && s.id !== current && s.id !== root && !actedOn(s.id)));
  // Sessions of other harnesses that are not Keel's own go under a line of their own at the list's end; an
  // imported or taken-over one is a Keel session (its copy), and the source is no row anywhere.
  const rest = shown.filter((s) => !s.outside || s.machine);
  const hidden = listed.length - pinned.length - shown.length;
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
  const narrowScreen = usePhoneWidth();
  useEffect(() => {
    const el = lateBox.current;
    if (!waits || !el || !nav.current) return setLateSeen(true);
    const io = new IntersectionObserver(([e]) => setLateSeen(!!e?.isIntersecting), { root: scrollerOf(nav.current) });
    io.observe(el);
    return () => io.disconnect();
  }, [waits, narrowScreen]);
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
  const external = useMemo(() => shown.filter((s) => s.outside && !s.machine).sort(cmp), [shown, cmp]);
  return (
    <>
      {/* What scrolls: on a phone the tabs, the tags and the counts go with the rows (the find stays),
          and below it the list's foot, which never covers a row it names. Elsewhere both are no box. */}
      <div className="k-list-scroll">
      <Seg kind="tabs" panel={panel} bare className="k-list-tabs mx-2.5 mb-1" label="Session list" value={tab} onChange={setTab} options={[{ value: "active", label: "Sessions", testid: "tab-active" }, { value: "archived", label: "Archived", testid: "tab-archived" }]} />
      <Find q={q} setQ={setQ} narrow={narrow} />
      {tags.length > 0 && !narrow && (
        <div className="k-tag-row" role="group" aria-label="Filter by tag" data-testid="tag-filter">
          {tags.map((t) => (
            <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}
              className="k-tag-pick">
              <Tag className="size-3 shrink-0" /><span className="truncate">{t}</span>
            </button>
          ))}
        </div>
      )}
      {/* The tabs' panel: it takes no box of its own, the list keeps its place in the rail. */}
      <div role="tabpanel" id={panel} aria-labelledby={tabId(panel, tab)} className="contents">
      <Summary />
      {/* Said once to whom the order changed under, where they will see it: a hint for the load it was
          seen on, gone with the next one, or before when dismissed or when the Arrange menu was opened. */}
      {note && !narrow && (
        <p ref={sawNoteRef} className="k-list-note" data-testid="list-note">
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
        {(arr.group === "folder" || arr.group === "flat" || tab !== "active") && grouped.length === 0 && flat.length === 0 && pinned.length === 0 && late.length === 0 && external.length === 0 && (
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
        {external.length > 0 && (
          <>
            <MachineSep external count={external.length} />
            <section className="k-group" data-testid="external-group">
              <Group list={external} current={current} every={!!q} where />
            </section>
          </>
        )}
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
      </ListCtx.Provider>
      </div>
      </div>
      <div className="k-list-foot" data-testid="list-foot">
        {sections.length > 1 && <MachinesBelow nav={nav} machines={sections.filter((x) => x.machine).map((x) => ({ machine: x.machine!, list: x.list }))} />}
        <NeedStrip nav={nav} open={(id) => { navigate({ name: "session", id }); if (getStations().shown.includes(id)) intoBox(id); }} />
        {/* They are below what the list shows: said at its foot, and a press goes to them. */}
        {waits && !lateSeen && <LateLine n={late.length} to={lateBox} />}
      </div>
    </>
  );
}

// The foot names Inbox, Loops and Errors in words where the words and their counts fit, and is glyphs
// where they do not. What they need is measured with the words shown, each time (the counts, the fonts as
// they load and the rail's width change it), within one frame: the words' width, not the state the foot
// is in, decides, so the foot does not flip at its edge.
function useFootFit(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    const fit = () => {
      el.removeAttribute("data-tight");
      const cs = getComputedStyle(el);
      const kids = [...el.children].filter((k): k is HTMLElement => k instanceof HTMLElement && k.getClientRects().length > 0);
      let need = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + (parseFloat(cs.columnGap) || 0) * Math.max(0, kids.length - 1);
      for (const k of kids) need += Math.max(k.getBoundingClientRect().width, k.scrollWidth);
      // The room in fractions of a pixel (clientWidth rounds), and the words as laid out: a glyph past the
      // foot's end or a word its button clips is tight too, whatever the sum said.
      const room = el.getBoundingClientRect().width - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      const end = el.getBoundingClientRect().right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const spills = kids.some((k) => k.getBoundingClientRect().right > end + 0.5 || k.scrollWidth > k.clientWidth + 0.5);
      el.toggleAttribute("data-tight", room < need + 0.5 || spills);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const mo = new MutationObserver(fit);
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    document.fonts?.addEventListener("loadingdone", fit);
    return () => { ro.disconnect(); mo.disconnect(); document.fonts?.removeEventListener("loadingdone", fit); el.removeAttribute("data-tight"); };
  }, [open]);
  return ref;
}

// The room, in fingers' heights, a phone's drawer keeps for its list before it slims its chrome: the find, the
// counts and the folder's head, and eight rows.
const SLIM_TAPS = 11;

export function Sidebar({ open }: { open: boolean }) {
  const foot = useFootFit(open);
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts && !e.read_ts).length);
  // The link in a word: connected, slow to answer, reconnecting, or catching up (the rows are not current before that is done).
  const link = useLink();
  const route = useUI((s) => s.route);
  const newUnsent = useUnsent("new");
  const theme = useUI((s) => s.theme);
  const rail = useRail();
  const current = route.name === "session" ? route.id : null;
  const onHelper = useStore((s) => (current ? !!s.sessions[current]?.settings.helper : false));
  const helperName = useHelperName();
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  const { card, bind, hide } = useCard();
  const grip = useRef<{ from: number; to: number | null }>({ from: 0, to: null });
  const aside = useRef<HTMLElement>(null);
  useUI((s) => s.listW);
  useEffect(hide, [open, current]);
  // A row that leaves the list under the pointer (archived from its own button) takes its card with it.
  const cardGone = useStore((x) => !!card && (!x.sessions[card.s.id] || !!x.sessions[card.s.id]!.archived));
  useEffect(() => { if (cardGone) hide(); }, [cardGone]);
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
  // A phone's drawer with little room for its rows: room for the find, the counts and eight rows is the
  // least it keeps, and below that its chrome is slim (bridge.css, data-short): the acts are a row of
  // icons with the filter behind one of them, the brand is gone and the foot is one row. It stays so
  // until the drawer is taller than it was when it slimmed.
  const [short, setShort] = useState<number | null>(null);
  // The filter, asked for from its icon while the drawer is slim (a filter in use stays in view by itself).
  const [finding, setFinding] = useState(false);
  useEffect(() => { if (short === null) setFinding(false); }, [short]);
  useLayoutEffect(() => {
    const el = aside.current;
    if (!el || !open || !phone()) return setShort(null);
    const look = () => {
      const list = el.querySelector<HTMLElement>(".k-list-scroll");
      if (!list || el.querySelector(".k-find:focus-within")) return;
      const tap = parseFloat(getComputedStyle(el).getPropertyValue("--spacing-tap")) * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      setShort((was) => (was !== null ? (el.clientHeight > was ? null : was) : list.clientHeight < SLIM_TAPS * tap ? el.clientHeight : null));
    };
    look();
    const ro = new ResizeObserver(look);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, short]);
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
    <aside ref={aside} className="k-rail" data-open={open || undefined} data-over={rail.over || undefined} data-narrow={(open && rail.narrow) || undefined} data-short={short !== null || undefined} data-find={(short !== null && finding) || undefined} data-testid="sidebar" aria-label="Sessions" style={open && !phone() ? { width: rail.over ? listWidth() : rail.width } : undefined}>
      <div className="k-rail-brand">
        <span className="k-logo" data-live={link.live || undefined} title={link.word}><Logo /></span>
        <span className="k-brand-name">Keel</span>
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
        {/* Where the drawer is slim the filter is behind this icon until it is used (bridge.css, k-act-filter). */}
        <button type="button" className="k-act k-act-filter" data-testid="open-filter" aria-label="Filter or switch to Archived" aria-pressed={finding} title="Filter sessions, or show the archived ones" onClick={() => {
          setFinding(!finding);
          if (!finding) requestAnimationFrame(() => aside.current?.querySelector<HTMLInputElement>('[data-testid="list-filter"]')?.focus());
        }}>
          <ListFilter /><span className="k-act-label">Filter sessions</span>
        </button>
        <button type="button" className="k-act" data-testid="open-helper" aria-label={helperName} title={`${helperName} (Ctrl J)`} aria-current={onHelper ? "page" : undefined} onClick={() => void openHelper().catch(reportError)}>
          <HelperFace size="rail" testid="helper-rail-face" /><span className="k-act-label" data-testid="helper-rail-name">{helperName}</span>{open && <Kbd keys="mod+j" className="k-act-key ml-auto" />}
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
      <div ref={foot} className="k-rail-foot" data-testid="rail-foot">
        {!open && (
          <button type="button" className="k-act" data-testid="tab-archived" aria-label="Archived sessions" title="Archived sessions" onClick={() => { openOn = "archived"; toggleList(true); }}>
            <Archive />
          </button>
        )}
        {/* How many panes: the open list has it in its Arrange menu; folded, it is a menu here. */}
        {!open && !phone() && <PanesButton />}
        <button type="button" className="k-act k-act-word" data-testid="settings-button" aria-label="Settings" title="Settings" aria-current={route.name === "settings" ? "page" : undefined} onClick={() => navigate({ name: "settings", section: "general" })}>
          <Settings /><span className="k-act-label">Settings</span>
        </button>
        <button type="button" className="k-act k-act-word k-foot-more" data-testid="customize-button" aria-label="Customize" title="Customize: instructions, skills, hooks, MCP servers and the rest" aria-current={route.name === "customize" ? "page" : undefined} onClick={() => navigate({ name: "customize", section: "instructions" })}>
          <Blocks /><span className="k-act-label">Customize</span>
        </button>
        {/* What waits on the owner first, then the loops, then the errors. */}
        <AutomationFooter />
        <button type="button" className={cn("k-act k-foot-named", errors > 0 && "k-alert")} data-testid="errors-button" aria-label={`Errors. ${COUNTERS.errors(errors)}`} title={`Errors. ${COUNTERS.errors(errors)}`} onClick={() => setUI({ errors: true })}>
          <Bug /><span className="k-foot-word">Errors</span>{errors > 0 && <span className="k-act-n">{errors}</span>}
        </button>
        <button type="button" className="k-theme-toggle k-act" data-testid="theme-toggle" onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")} title={`Theme: ${theme}`} aria-label={`Theme: ${theme}. Change`}>
          <ThemeIcon />
        </button>
      </div>
    </aside>
  );
}

// A row of a session another harness runs: which one is in the title's tooltip and the hover card. A stale one (no record for
// a while, nothing to vouch for it) says so beside the title, in a word.
const outsideTip = (o: NonNullable<Session["outside"]>) => {
  const where = OUTSIDE_LABEL[o.harness] ?? o.harness;
  return o.state === "stale" ? `Runs in ${where}: no record${o.since ? ` since ${hhmm(o.since)}` : ""}, read-only here` : `Runs in ${where}: read-only here`;
};
export function OutsideTag({ o }: { o: NonNullable<Session["outside"]> }) {
  if (o.state !== "stale") return null;
  return <span className="k-row-outside" data-testid="row-outside" data-state="stale" title={outsideTip(o)}>{STALE_WORD.toLowerCase()}</span>;
}
