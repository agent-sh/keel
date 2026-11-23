// The bridge: as many panes side by side as the owner chose, a session in
// each. The pane worked in is the helm and carries the full header: a rule
// under its band marks it, and a pane the pointer or the keys aim at from the
// list says what a click there will do. Keel never adds a pane by itself, and
// a pane holds the session the owner put in it: opening another one fills a
// pane they added and left empty, else it lies over the pane worked in as a
// look, with a bar that names the session the pane holds and leads back to it
// (lib/panes.ts has the rule). The session under a look, or under the start
// page, stays drawn and as it was. A look is the pane's session once it is
// placed: "Keep here", a double click on its row, a drop on the pane, the menu
// of panes. A second pane opens when asked for: the pane control, "open beside"
// (Ctrl or middle click in the list, the row's button, the palette), or a
// session dropped on a pane's left or right edge. Panes are resized by
// dragging the divider between them, reordered by dragging a header onto
// another pane, and a session dropped on a pane's middle lands in it. The helm can be focused to the full
// width. On a phone the sessions are pages you swipe between, with a dock of
// their marks along the bottom.
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, ListTree, Maximize2, Minimize2, PanelsTopLeft, Pin, PinOff, Plus, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, Fragment, type RefObject } from "react";
import type { Session } from "../../../src/core/types.ts";
import { isMac, registerCommand } from "../lib/keys.ts";
import { AIMS, keepLook, leaveHome, leaveLook, lookNow, noteLook, paneMove, setAim, tellSwap, useAim, useAimed, useNeedUnderLooks, usePaneNote, type Aim } from "../lib/looks.ts";
import { callsigns, paneMin, panesMax, usePanelSide, useWidth } from "../lib/rail.ts";
import { useSeenFailure } from "./Attention.tsx";
import { usePanelBesideShown } from "./SidePanel.tsx";
import { byAttention, getStations, opened, paneOf, shares, shownIn, stations, target, useStations } from "../lib/stations.ts";
import { getState, storeGate, useStore } from "../lib/store.ts";
import { Covered } from "../lib/cover.ts";
import { getUI, navigate, savePref, setUI, useUI } from "../lib/ui.ts";
import { watchPanes } from "../lib/automation.ts";
import { ago, clock, scrollMotion, when } from "../lib/utils.ts";
import { sequenceAt } from "../lib/asks.ts";
import { focusBox } from "../lib/utils.ts";
import { branchOf, lastLine, useNeedCount, useSessionState, useStateLabel, useWatch } from "../lib/watch.ts";
import { OFFLINE, STATE_WORD, asOf, countWord, lastTold, stateLabel } from "../../../src/core/state-words.ts";
import { MachineSep, machineRuns, useWhere, whereStyle, whereWords } from "./Where.tsx";
import { isPinned, pin as pinSession } from "../lib/sessops.ts";
import { soloWindow } from "../lib/shell.ts";
import { reportError } from "../lib/store.ts";
import { Grip } from "./Grip.tsx";
import { PaneMap } from "./PaneMap.tsx";
import { PaneMenu } from "./PaneMenu.tsx";
import { DRAG, dragSession, setPanes } from "./Panes.tsx";
import { elapsed, failWord, folderOf, Mark, modelOf, stateClock, tickOf, timed, useLive, useNow, whyText } from "./Mark.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { Boundary, SessionView } from "./SessionView.tsx";
import { Kbd } from "./Kbd.tsx";
import { WatchHeadline, WatchLists, useAttended } from "./HomeWatch.tsx";
import { StartBox } from "./StartBox.tsx";
import { goNextWaiting } from "./AnswerQueue.tsx";

const helmNow = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
// What the panes show, left to right: a look where one lies over a pane, else the pane's own session.
const filled = () => { const st = getStations(); return st.slots.map((_, i) => shownIn(st, i)).filter((x): x is string => !!x); };
function step(by: -1 | 1) {
  const ids = filled();
  const h = helmNow();
  const i = h ? ids.indexOf(h) : -1;
  const next = ids[(i + by + ids.length) % ids.length];
  if (next) { paneMove(next); navigate({ name: "session", id: next }); }
}
registerCommand(
  { id: "station.next", label: "Next pane", group: "Bridge", keys: "alt+]", inInput: true, run: () => step(1) },
  { id: "station.prev", label: "Previous pane", group: "Bridge", keys: "alt+[", inInput: true, run: () => step(-1) },
  { id: "station.right", label: "Move the pane right", group: "Bridge", keys: "alt+shift+]", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, 1); } },
  { id: "station.left", label: "Move the pane left", group: "Bridge", keys: "alt+shift+[", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, -1); } },
  // The session worked in goes to the pane with that number; the one there comes here.
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `station.to.${n}`, label: `Move this session to pane ${n}`, group: "Bridge", words: "place swap trade put", when: () => { const h = helmNow(); const st = getStations(); return !!h && n <= st.count && st.slots[n - 1] !== h; }, run: () => { const h = helmNow(); if (h) stations.place(h, n - 1); } })),
  { id: "station.focus", label: "Focus the pane (full width) or show all", group: "Bridge", keys: "alt+enter", inInput: true, run: () => stations.toggleFocus() },
  { id: "station.pin", label: "Pin or unpin the session in the list", group: "Bridge", keys: "alt+p", run: () => { const h = helmNow(); if (h) pinSession(h, !isPinned(getState().sessions[h])).catch(reportError); } },
  { id: "station.close", label: "Close the session in the pane", group: "Bridge", keys: "alt+w", run: () => { const h = helmNow(); if (h) closeStation(h); } },
  // A look becomes the pane's session. (On a Mac, Option with a letter types a character: in a field the key stays the field's.)
  { id: "look.keep", label: "Keep this session in the pane", group: "Bridge", keys: "alt+k", inInput: () => !isMac, words: "place pin stay hold look", when: () => !!lookNow(), run: () => { const l = lookNow(); if (l) keepLook(l.id); } },
  { id: "station.beside", label: "Open the session beside (new pane)", group: "Bridge", words: "split side second pane", when: () => !!helmNow() && getStations().count < panesMax(), run: () => { const h = helmNow(); if (h) stations.beside(h, panesMax()); } },
  { id: "panes.more", label: "One more pane", group: "Bridge", words: "window split add column", when: () => getStations().count < panesMax(), run: () => setPanes(getStations().count + 1) },
  { id: "panes.fewer", label: "One pane fewer", group: "Bridge", words: "window split remove column", when: () => getStations().count > 1, run: () => setPanes(getStations().count - 1) },
  { id: "panes.even", label: "Make the panes equal width", group: "Bridge", words: "reset size split", when: () => getStations().count > 1, run: () => stations.resize() },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `panes.${n}`, label: `${n} pane${n > 1 ? "s" : ""}`, group: "Bridge", words: "window split columns layout", when: () => n <= Math.max(panesMax(), getStations().count), run: () => setPanes(n) })),
);

// Closes the pane (the last one stays, empty). The helm moves to a neighbour that shows a session.
// A look is left instead: its pane shows the session it holds again.
function closeStation(id: string) {
  if (leaveLook(id)) return;
  const st = getStations();
  const i = st.slots.indexOf(id);
  const shown = st.slots.map((_, j) => shownIn(st, j));
  const next = [...shown.slice(i + 1), ...shown.slice(0, Math.max(0, i)).reverse()].find((x) => x);
  stations.close(id);
  if (helmNow() === id) navigate(next ? { name: "session", id: next } : { name: "new" });
}

function Tool({ label, onClick, children, testid, on, move }: { label: string; onClick: () => void; children: React.ReactNode; testid?: string; on?: boolean; move?: boolean }) {
  return (
    <button type="button" className={move ? "k-tool k-tool-move" : "k-tool"} title={label} aria-label={label} aria-pressed={on} data-testid={testid} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

// The tools of a pane's header: drawn again only when one of them changes, not with the header's
// clock (once a second) or with each event of its session.
const StationTools = memo(function StationTools({ id, helm, pinned, focus, panes }: { id: string; helm: boolean; pinned: boolean; focus: boolean; panes: number }) {
  return (
    <span className="k-station-tools">
      {!focus && panes > 1 && <PaneMenu id={id} label="Move to a pane" testid="station-place" className="k-tool k-tool-move"><PanelsTopLeft /></PaneMenu>}
      {!focus && <Tool move label="Move left (Alt Shift [)" onClick={() => stations.move(id, -1)}><ChevronLeft /></Tool>}
      {!focus && <Tool move label="Move right (Alt Shift ])" onClick={() => stations.move(id, 1)}><ChevronRight /></Tool>}
      <Tool label={pinned ? "Unpin from the top of the list (Alt P)" : "Pin to the top of the list (Alt P)"} testid="station-pin" on={pinned} onClick={() => pinSession(id, !pinned).catch(reportError)}>{pinned ? <PinOff /> : <Pin />}</Tool>
      <Tool label={focus ? "Show all panes (Alt Enter)" : "Focus this pane (Alt Enter)"} testid="station-focus" on={focus} onClick={() => { if (!helm) navigate({ name: "session", id }); stations.toggleFocus(); }}>{focus ? <Minimize2 /> : <Maximize2 />}</Tool>
      <Tool label="Close the session here (Alt W)" testid="station-close" onClick={() => closeStation(id)}><X /></Tool>
    </span>
  );
});

function StationHead({ s, helm, pinned }: { s: Session; helm: boolean; pinned: boolean }) {
  // What it last did is shown in a pane that is not the helm: only such a pane reads its events,
  // and works the line out when they changed, not at each tick of its clock.
  const events = useStore((x) => (helm ? undefined : x.events[s.id]));
  const line = useMemo(() => (helm ? "" : lastLine(branchOf(events, s.head), s.workspace)), [helm, events, s.head, s.workspace]);
  const st = useSessionState(s);
  const w = st.watch;
  // One clock for one state: the band shows what the row shows (the step's time, the ask's, the wait's).
  // A machine that does not answer says nothing new: the head reads Offline with when it last told, and its clock stands.
  const where = useWhere(s);
  const offline = where?.reach === "offline";
  const now = useNow(timed(st) && !offline, tickOf(st));
  const focus = useStations((x) => x.focus);
  const panes = useStations((x) => x.count);
  const told = st.text ? whyText(st, now) : "";
  const why = offline ? asOf(clock((st as { as_of?: number }).as_of ?? s.updated)) : told;
  // The tools the helm keeps in view take room beside the title (bridge.css counts them); another pane shows its tools over the header's end when it is pointed at.
  const tools = helm ? (!focus && panes > 1 ? 6 : !focus ? 5 : 3) : 0;
  return (
    <header className="k-station-head" data-testid="station-head" draggable={!focus} onDragStart={dragSession(s.id)} title={focus ? undefined : "Drag onto another pane to trade places"}
      style={{ "--k-tools": tools } as CSSProperties} data-whole={why ? `${s.title || "New session"}\n${why}` : s.title || "New session"}>
      {/* The title first, in the width it needs. The state and its reason beside it when they fit, else on the line under it. */}
      <div className="k-station-row k-station-identity">
        <h2 className="k-station-title" data-testid="station-title" title={s.title}>{s.title || "New session"}</h2>
        {/* Another machine's session names it beside the title, at any width of the pane (the folder and model give way first). */}
        {where && <span className="k-station-machine" data-testid="station-machine" data-reach={where.reach} title={where.title} style={whereStyle(where.colour)}>{where.name}</span>}
        <div className="k-station-rest">
        <span className="k-station-state">
          <span className="k-station-word" data-testid="station-word" data-offline={offline || undefined}><Mark w={w} />{offline ? OFFLINE : stateLabel(st)}</span>
          {!offline && w === "fail" && failWord(st.cls) && <span className="k-row-class" data-testid="station-class">{failWord(st.cls)}</span>}
          {timed(st) && !offline && <span className="k-station-clock tabular-nums" data-testid="station-clock">{stateClock(st, now)}</span>}
          {why && <span className="k-station-why" data-testid="station-why" data-why={offline ? "offline" : st.why} title={offline ? lastTold(stateLabel(st), st.text) : why}>{why}</span>}
        </span>
        <span className="k-station-meta" title={s.workspace}>
          <span className="k-station-where block truncate">{s.workspace_gone ? <span className="k-gone">{folderOf(s)} gone</span> : folderOf(s)}{!helm && ` / ${modelOf(s.model)}`}</span>
        </span>
        <StationTools id={s.id} helm={helm} pinned={pinned} focus={focus} panes={panes} />
        </div>
      </div>
      {!helm && <p className="k-station-line truncate">{line || " "}</p>}
      {pinned && <span className="k-pin-mark" aria-hidden="true" />}
    </header>
  );
}

// The head of a station whose session this daemon does not have (deleted, or
// a link from another machine): the same head, its word in steel, the id as its line.
function MissingHead({ id }: { id: string }) {
  return (
    <header className="k-station-head" data-testid="station-head">
      <div className="k-station-row">
        <span className="k-station-word"><Mark w="idle" />Not here</span>
        <span className="k-station-meta" />
        <span className="k-station-tools">
          <Tool label="Close the session here (Alt W)" testid="station-close" onClick={() => closeStation(id)}><X /></Tool>
        </span>
      </div>
      <h2 className="k-station-title">This session is not on this daemon</h2>
      <p className="k-station-line truncate font-mono text-caption" title={id}>{id}</p>
    </header>
  );
}

// A pane takes a dragged session: its middle puts the session in it, its
// left or right edge (a fifth of its width) opens a new pane on that side
// while another fits. It shows where the drop lands.
type Over = "in" | "left" | "right";
export const EDGE = 0.2;
function useDrop(slot: number | undefined) {
  const [over, setOver] = useState<Over | null>(null);
  if (slot === undefined) return {};
  const mine = (e: DragEvent) => e.dataTransfer.types.includes(DRAG);
  const where = (e: DragEvent<HTMLElement>): Over => {
    if (getStations().count >= panesMax()) return "in";
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    return x < EDGE ? "left" : x > 1 - EDGE ? "right" : "in";
  };
  return {
    "data-drop": over ?? undefined,
    onDragOver: (e: DragEvent<HTMLElement>) => { if (!mine(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; const w = where(e); if (w !== over) setOver(w); },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null); },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const id = e.dataTransfer.getData(DRAG);
      const w = where(e);
      setOver(null);
      if (!id) return;
      e.preventDefault();
      if (w === "in") stations.place(id, slot);
      else stations.beside(id, panesMax(), slot, w);
      navigate({ name: "session", id });
    },
  };
}

// What a click on the row the pointer or the keys are on will do to a pane: said on that pane, in a
// tab that hangs from its band. A pane with a bar (a look, the start page over a session) says it
// in the bar instead, where it covers nothing. The row itself is described by the same words for
// assistive technology (Bridge sets that as the keys reach it).
function AimTag({ slot }: { slot?: number }) {
  const how = useAim(slot);
  return how ? <span className="k-aim k-face-state" data-testid="pane-aim">{AIMS[how]}</span> : null;
}

// The bar across the top of what lies over a pane's session (a look, the start
// page). It says what this is and whose pane it is: the session looked at, the
// session the pane holds (its mark is live, and it says so in words when it
// needs the owner or failed under the look), then the way back and, for a
// look, the way to keep it. Escape is offered only where it leads back: not
// while the keyboard is on a card of the look or in a field that keeps Escape
// for itself (bridge.css). Where room is short the
// first sentence gives way (the header under the bar names the session looked
// at), then "This pane holds", and the held session's name is cut last. While
// a row of the list aims at the pane, the bar says what a click there will do
// in place of its sentences; the row of the session already shown changes
// nothing, and the sentences stay (the pane's band marks it).
// Whether the bar offers Escape (bridge.css): not while the keyboard is on a card of the look,
// where it is the card's own key, nor in a field that keeps it. Read off the focus when it moves.
function useEscOffered(bar: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const look = () => {
      const el = bar.current;
      if (!el) return;
      const at = document.activeElement;
      const off = !!at && at !== document.body
        && ((!!at.closest("[data-ask-card]") && !!el.closest(".k-view")?.contains(at)) || (at.matches("input, textarea, [contenteditable]") && !at.matches(".k-composer-box textarea")));
      el.toggleAttribute("data-esc-off", off);
    };
    look();
    document.addEventListener("focusin", look);
    document.addEventListener("focusout", look);
    return () => { document.removeEventListener("focusin", look); document.removeEventListener("focusout", look); };
  }, []);
}

function LookBar({ under, looking, slot, onBack, keep }: { under: Session; looking?: Session; slot?: number; onBack: () => void; keep?: () => void }) {
  const bar = useRef<HTMLDivElement>(null);
  useEscOffered(bar);
  const st = useSessionState(under);
  const w = st.watch;
  const how = useAim(slot);
  const title = under.title || "New session";
  const state = w === "need" || w === "fail" || w === "declined" ? STATE_WORD[w].toLowerCase() : "";
  return (
    <div ref={bar} className="k-look-bar" data-testid="look-bar" data-holds={under.id} data-under={state ? w : undefined} data-aim={how ?? undefined}>
      <p className="k-look-says" data-testid="look-says">
        {how && how !== "here" ? <span className="k-aim-in k-face-state" data-testid="pane-aim">{AIMS[how]}</span> : (
          <>
            <span className="k-look-this">{keep ? <>Looking at <b dir="auto">{looking?.title || "this session"}</b>.</> : "The start page."}</span>{" "}
            <span className="k-look-holds" title={`This pane holds ${title}${state ? `, ${state}` : ""}`}>
              <span className="k-look-lead">This pane holds </span>
              <span className="k-look-own" data-state={state ? w : undefined}>
                <Mark w={w} /><b className="k-look-title" data-testid="look-title"><bdi>{title}</bdi>{state ? "," : "."}</b>{state && " "}{state && <span className="k-look-state" data-testid="look-state">{state}.</span>}
              </span>
            </span>
          </>
        )}
      </p>
      <button type="button" className="k-look-act" data-testid="look-back" title={`Back to ${title}, the session this pane holds`} aria-label={`Back to ${title}${state ? `, ${state}` : ""}, the session this pane holds`} onClick={onBack}>
        <ArrowLeft aria-hidden="true" />Back<Kbd keys="escape" className="k-look-esc" />
      </button>
      {keep && <button type="button" className="k-look-act k-look-keep" data-testid="look-keep" title={`This becomes the pane's session, in place of ${title} (a double click on its row does the same)`} onClick={keep}>Keep here<Kbd keys="alt+k" /></button>}
    </div>
  );
}

// A line at the pane's foot for a few seconds: what left the pane, and where it is (lib/looks.ts).
function PaneNote({ slot }: { slot?: number }) {
  const text = usePaneNote(slot);
  return text ? <p className="k-pane-note" role="status" data-testid="pane-note">{text}</p> : null;
}

// Tells the page when a pane's own session goes under something, shows again, or leaves the pane (lib/looks.ts).
function Swap({ session, slot, covered }: { session: string; slot: number; covered: boolean }) {
  const at = useRef({ slot, first: true });
  at.current.slot = slot;
  useEffect(() => {
    if (at.current.first) { at.current.first = false; return; }
    tellSwap({ session, slot: at.current.slot, state: covered ? "covered" : "restored" });
  }, [covered]);
  // (A layout effect is undone while the pane's nodes are still in the page.)
  useLayoutEffect(() => () => tellSwap({ session, slot: at.current.slot, state: "left" }), []);
  return null;
}

const head = (x: Session, on: boolean) => <><StationHead s={x} helm={on} pinned={isPinned(x)} />{on && <SessionHeader session={x} />}</>;

// One session's view in a pane: the pane's own, or a look over it (`back` leads out of that).
// The same component in both places, so a look that is kept goes on as the pane's session
// without being drawn anew. `quiet`: something lies over it. The pane then does not draw it
// again (what changes in it draws itself: the conversation goes on), and its part of the
// pane, the header and the panel, is drawn when it shows again.
const Shown = memo(function Shown({ s, helm, quiet, back }: { s: Session; helm: boolean; quiet: boolean; back?: () => void }) {
  return <SessionView id={s.id} panel={helm && !quiet} focus={helm && !quiet} back={back} header={head(s, helm)} />;
}, (was, now) => (was.quiet && now.quiet) || (was.s === now.s && was.helm === now.helm && was.quiet === now.quiet && !was.back === !now.back));

// A pane and the session it holds (`s`). What lies over it for now is drawn on
// top, first in the pane so that whoever asks the pane for its message box or
// its cards finds the ones on top: the start page (`fresh`), a look (`look`).
// The pane's own session stays drawn under them, out of reach, as it was.
function Station({ s, helm, slot, grow, look, fresh }: { s: Session; helm: boolean; slot?: number; grow?: number; look?: { id: string; s?: Session }; fresh?: boolean }) {
  // What the pane shows on top: nothing of a session under the start page, the look, else its own.
  const top = fresh ? null : look ? look.s ?? null : s;
  const face = top ?? s;
  const shownId = fresh ? null : look ? look.id : s.id;
  const w = useWatch(face);
  // A pane of a desk is on screen; of a phone's pages (which have no slot) only the helm is.
  useSeenFailure(face, w, !!top && (slot !== undefined || helm));
  const label = useStateLabel();
  const ref = useRef<HTMLElement>(null);
  const drop = useDrop(slot);
  // The helm scrolls into view when it changes (keyboard moves, the rail).
  useEffect(() => { if (helm) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollMotion() }); }, [helm]);
  const covered = !!fresh || !!look;
  // What the bridge's style sheet reads of the pane, said on the pane itself: a selector that
  // asked the pane's whole tree for it (`:has` over the conversation) was matched again at
  // every restyle of the pane, over every row it holds.
  const aimed = !!useAim(slot);
  const beside = usePanelBesideShown(top ?? undefined, helm && !fresh);
  // The pane's own session is drawn from the first time it shows: a page that opens on a look draws only the look.
  const drawn = useRef(!covered);
  if (!covered) drawn.current = true;
  return (
    <section
      ref={ref}
      className={fresh ? "k-station k-station-new" : "k-station"}
      style={grow === undefined ? undefined : { flexGrow: grow }}
      data-station={shownId ?? undefined}
      data-holds={slot === undefined ? undefined : s.id}
      data-look={look && !fresh ? "" : undefined}
      data-slot={slot}
      data-watch={fresh ? undefined : top ? w : "idle"}
      data-helm={helm || undefined}
      data-aimed={aimed || undefined}
      data-beside={beside || undefined}
      data-missing={!fresh && look && !look.s ? "" : undefined}
      data-testid={fresh ? undefined : "station"}
      aria-label={fresh ? "New session" : top ? `${top.title || "New session"}, ${label(top.id, w)}${whereWords(top)}` : "Session not on this daemon"}
      onPointerDownCapture={() => { if (!helm && shownId) { paneMove(shownId); navigate({ name: "session", id: shownId }); } }}
      // Keyboard: tabbing into a pane takes the helm. Focus moved by code (an
      // approval card taking the keys in another pane) does not.
      onKeyUpCapture={(e) => { if (!helm && shownId && e.key === "Tab") { paneMove(shownId); navigate({ name: "session", id: shownId }); } }}
      {...drop}
    >
      <div className="k-band" aria-hidden="true" />
      {!covered && <AimTag slot={slot} />}
      <PaneNote slot={slot} />
      {fresh && (
        <div key="new" className="k-view k-view-over" data-view="new">
          <div key="band" className="k-band" aria-hidden="true" />
          <LookBar key="bar" under={look?.s ?? s} slot={slot} onBack={() => void leaveHome()} />
          <StartBox key="view" beside onBack={() => void leaveHome()} />
        </div>
      )}
      {look && (
        <div key={look.id} className="k-view k-view-over" data-view="look" inert={fresh} data-station={fresh ? look.id : undefined}>
          <div key="band" className="k-band" aria-hidden="true" />
          <LookBar key="bar" under={s} looking={look.s} slot={slot} onBack={() => leaveLook(look.id)} keep={() => keepLook(look.id)} />
          {/* Under the start page it is not drawn again until it shows (lib/cover.ts). */}
          <Covered key="held" on={!!fresh} make={storeGate}>
            <Boundary key="view">
              {/* In a pane that is not worked in a look is as compact as any other pane. */}
              {look.s
                ? <Shown s={look.s} helm={helm && !fresh} quiet={!!fresh} back={() => leaveLook(look.id)} />
                : <SessionView id={look.id} missingHeader={<MissingHead id={look.id} />} />}
            </Boundary>
          </Covered>
        </div>
      )}
      {drawn.current && (
        <div key={s.id} className="k-view" data-view="own" inert={covered} data-station={covered ? s.id : undefined}>
          {/* Under a look or the start page the pane's own session is not drawn again: it is drawn as it is when it shows. */}
          <Covered key="held" on={covered} make={storeGate}><Boundary key="view"><Shown s={s} helm={helm} quiet={covered} /></Boundary></Covered>
          {slot !== undefined && <Swap key="swap" session={s.id} slot={slot} covered={covered} />}
        </div>
      )}
    </section>
  );
}

// `beside`: other panes stand next to it: what needs the owner comes before the start box.
function NewStation({ slot, grow, beside }: { slot?: number; grow?: number; beside?: boolean }) {
  const drop = useDrop(slot);
  // A phone's new-session page stands after the sessions' pages: it comes into view as the
  // page the route names, at once, before the pages are read for the one in view. (Its box
  // taking the keyboard did that alone, so with a drawer or a dialog holding the keyboard
  // the first session's page was read as the helm and its alerts as seen.)
  const ref = useRef<HTMLElement>(null);
  const aimed = !!useAim(slot);
  useEffect(() => { if (slot === undefined) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); }, []);
  return (
    <section ref={ref} className="k-station k-station-new" data-slot={slot} data-helm data-aimed={aimed || undefined} style={grow === undefined ? undefined : { flexGrow: grow }} aria-label="New session" {...drop}>
      <div className="k-band" aria-hidden="true" />
      <AimTag slot={slot} />
      <PaneNote slot={slot} />
      <StartBox beside={beside} />
    </section>
  );
}

// A pane with no session: it waits for the owner to put one in. It says what
// needs them, as the start page does (the same headline and rows, answered
// from here), offers the other sessions not on screen, and takes a dragged one.
function EmptyPane({ slot, grow, next }: { slot: number; grow: number; next: boolean }) {
  const { list, watches } = useLive();
  const label = useStateLabel();
  const shown = useStations((x) => x.shown);
  const count = useStations((x) => x.count);
  const attended = useAttended();
  const offer = useMemo(() => byAttention(list, watches).filter((s) => !shown.includes(s.id) && !attended.has(s.id)).slice(0, 7), [list, watches, shown, attended]);
  const drop = useDrop(slot);
  const aimed = !!useAim(slot);
  const put = (id: string) => { stations.place(id, slot); navigate({ name: "session", id }); };
  return (
    <section className="k-station k-pane-empty" data-slot={slot} data-aimed={aimed || undefined} data-next={next || undefined} data-testid="pane-empty" style={{ flexGrow: grow }} aria-label={`Empty pane ${slot + 1}`} onPointerDown={() => stations.setActive(slot)} {...drop}>
      <div className="k-band" aria-hidden="true" />
      <AimTag slot={slot} />
      <PaneNote slot={slot} />
      <div className="k-pane-empty-body">
        <p className="k-pane-empty-word">Pane {slot + 1}<span>{next ? "the next session opens here" : "empty"}</span>
          {count > 1 && <button type="button" className="k-pane-empty-close" data-testid="pane-close" title="Close this pane" aria-label={`Close pane ${slot + 1}`} onClick={(e) => { e.stopPropagation(); stations.closePane(slot); }}><X /></button>}
        </p>
        <div className="k-pane-empty-watch"><WatchHeadline /></div>
        <WatchLists />
        <p className="k-pane-empty-hint">Pick a session below or in the list, or drag one in.</p>
        {offer.length > 0 && (
          <div className="k-pane-empty-list">
            {machineRuns(offer).map((run, ri, runs) => (<Fragment key={run.machine ?? "local"}>{runs.length > 1 && <MachineSep machine={run.machine} count={run.list.length} />}{run.list.map((s) => (
              <button key={s.id} type="button" data-testid="pane-offer" data-session={s.id} data-watch={watches[s.id]} onClick={() => put(s.id)}>
                <span className="grid w-4 place-items-center" title={label(s.id, watches[s.id] ?? "idle")}><Mark w={watches[s.id] ?? "idle"} /></span>
                <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                <span className="k-pane-empty-in">{folderOf(s)}</span>
                <span className="k-pane-empty-time tabular-nums" title={when(s.updated)}>{ago(s.updated)}</span>
              </button>
            ))}</Fragment>))}
          </div>
        )}
        <button type="button" className="k-pane-empty-new" data-testid="pane-new" onClick={() => { stations.setActive(slot); navigate({ name: "new" }); }}><Plus />New session here</button>
      </div>
    </section>
  );
}

// Phone: the marks of the stations along the bottom; tap one to go there.
function PhoneDock({ list, helm }: { list: Session[]; helm: string | null }) {
  const { watches } = useLive();
  const label = useStateLabel();
  const fresh = useUI((s) => s.route.name === "new");
  // The things that wait on the owner, in every session: the number the tab's title and the home headline show.
  const need = useNeedCount();
  // Each mark carries the session's short code, the one the folded rail gives it.
  const sessions = useStore((x) => x.sessions);
  const codes = useMemo(() => callsigns(Object.values(sessions).filter((s) => !s.archived && !s.settings.helper)), [sessions]);
  // The mark of the session on screen is in view: the dock's row scrolls sideways to it (only the row).
  const row = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const l = row.current, m = l?.querySelector<HTMLElement>(".k-dock-mark[aria-current]");
    if (!l || !m) return;
    const lb = l.getBoundingClientRect(), mb = m.getBoundingClientRect();
    const by = mb.left < lb.left ? mb.left - lb.left : mb.right > lb.right ? mb.right - lb.right : 0;
    if (by) l.scrollBy({ left: by, behavior: scrollMotion() });
  }, [helm, list.length]);
  return (
    <nav className="k-dock" aria-label="Panes">
      <button type="button" className="k-dock-btn" aria-label="All sessions" onClick={() => savePref("sidebar", true)}><ListTree /></button>
      <ol className="k-dock-list" ref={row}>
        {list.map((s) => (
          <li key={s.id}>
            <button type="button" className="k-dock-mark" data-watch={watches[s.id]} aria-current={helm === s.id ? "page" : undefined} aria-label={`${s.title || "New session"}, ${label(s.id, watches[s.id]!)}${whereWords(s)}`} onClick={() => navigate({ name: "session", id: s.id })}>
              <Mark w={watches[s.id]!} />
              <span className="k-dock-code" data-testid="dock-code" aria-hidden="true">{codes[s.id]}</span>
            </button>
          </li>
        ))}
      </ol>
      {/* The home screen's headline already says it. A tap goes to the card that has waited longest (the desk's Alt+A). */}
      {need > 0 && !fresh && (
        <button type="button" className="k-dock-need" data-testid="dock-need" onClick={goNextWaiting}>
          <span className="k-dock-need-n" aria-live="polite">{countWord("need", need)}</span>
        </button>
      )}
      <button type="button" className="k-dock-btn" aria-label="New session" aria-current={fresh ? "page" : undefined} onClick={() => navigate({ name: "new" })}><Plus /></button>
    </nav>
  );
}

// The tab's words for assistive technology (the row the keys are on is described by them), and,
// when the pane the row aims at is out of view in a row of panes that scrolls sideways, the tab
// itself at that edge of the row with an arrow.
function AimSays({ track }: { track: React.RefObject<HTMLElement | null> }) {
  const aim = useAimed();
  const [edge, setEdge] = useState<{ side: "left" | "right"; top: number; x: number } | null>(null);
  useLayoutEffect(() => {
    const row = track.current;
    const pane = aim && row?.querySelector<HTMLElement>(`:scope > [data-slot="${aim.slot}"]`);
    if (!row || !pane) return setEdge(null);
    const r = row.getBoundingClientRect(), p = pane.getBoundingClientRect();
    const mid = p.left + p.width / 2;
    setEdge(mid > r.right ? { side: "right", top: r.top, x: innerWidth - r.right } : mid < r.left ? { side: "left", top: r.top, x: r.left } : null);
  }, [aim?.slot, aim?.how]);
  return (
    <>
      <span id="k-aim-says" className="sr-only">{aim ? `${AIMS[aim.how]}, in pane ${aim.slot + 1}` : ""}</span>
      {aim && edge && (
        <span className="k-aim k-aim-edge k-face-state" data-testid="pane-aim-edge" data-side={edge.side} style={{ top: edge.top, [edge.side]: edge.x }}>
          {edge.side === "left" && <ArrowLeft aria-hidden="true" />}{AIMS[aim.how]}, pane {aim.slot + 1}{edge.side === "right" && <ArrowRight aria-hidden="true" />}
        </span>
      )}
    </>
  );
}

// A phone's pages: the helm and what asks for attention.
const PHONE_PAGES = 6;
// A row of the session list, when the pointer or the keys are on one.
const rowOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>('[data-testid="session-row"][data-session]') : null);

export function Bridge() {
  const route = useUI((s) => s.route);
  const width = useWidth();
  const phone = width < 768;
  const { list, watches } = useLive();
  const kept = useStations((s) => s);
  const sessions = useStore((x) => x.sessions);
  const loaded = useStore((x) => x.loaded.sessions);
  const helm = route.name === "session" ? route.id : null;
  const fresh = route.name === "new";

  // The first layout, once: one pane, with the session open. A second one is their to ask for.
  useEffect(() => {
    if (!kept.seeded && loaded && !phone) stations.seed(helm);
  }, [kept.seeded, loaded]);
  // Opening a session shows it (kept below, by the rule in lib/panes.ts); this render already shows it there.
  const st = helm && !phone ? opened(kept, helm) : kept;
  // A look opened from the start page leads back to it when it is left.
  const from = useRef(route.name);
  useEffect(() => {
    const was = from.current;
    from.current = route.name;
    // (A phone has pages, not panes: what its pages show changes no pane.)
    if (!helm || !kept.seeded || phone) return;
    stations.open(helm);
    if (getStations().over.includes(helm)) noteLook(helm, was === "new");
  }, [helm, kept.seeded, route.name, phone]);
  // The caret follows the helm. When the keys move it to another pane (Next pane, Previous
  // pane, a jump to a session that is on screen), the keyboard goes to that pane's message
  // box: what is typed next lands in the pane that is highlighted, not in the one left
  // behind. Never onto what the pane asks: a key pressed as the pane changed answers
  // nothing (the key that goes to what waits brings the keyboard there). Only from a pane
  // or from nothing: a field outside the panes (the list's filter, a dialog) keeps it.
  const helmWas = useRef(helm);
  useEffect(() => {
    const was = helmWas.current;
    helmWas.current = helm;
    if (!helm || helm === was || phone) return;
    const at = document.activeElement as HTMLElement | null;
    const from = at?.closest<HTMLElement>("[data-station]")?.dataset.station;
    if (at && at !== document.body && (!from || from === helm)) return;
    // The answering sequence moved the helm: it brings the keyboard to that pane's card, not to its box.
    if (sequenceAt() === helm) return;
    focusBox(helm, false);
  }, [helm]);
  // A session that is gone (deleted, archived) leaves its pane empty.
  const gone = (id: string) => id !== helm && (!sessions[id] || sessions[id]!.archived);
  useEffect(() => { if (loaded) stations.drop(gone); }, [loaded, sessions, helm]);

  const focus = kept.focus;
  const startAt = fresh ? target(st) : -1; // the pane the start page shows in
  const weights = shares(st);
  const slots = phone ? [] : st.slots.map((id, i) => ({ id, i })).filter((x) => !focus || x.i === (fresh ? startAt : st.active));
  // (A session in a window of its own is that session alone, however narrow the window.)
  const pages = useMemo(() => (phone ? [...(helm && sessions[helm] ? [sessions[helm]!] : []), ...(soloWindow ? [] : byAttention(list, watches).filter((s) => s.id !== helm))].slice(0, PHONE_PAGES) : []), [phone, list, watches, helm, sessions]);
  const onScreen = phone ? pages.map((s) => s.id) : slots.map((x) => (x.i === startAt ? null : shownIn(st, x.i))).filter((x): x is string => !!x && !gone(x));
  useEffect(() => stations.setShown(onScreen));

  // Before the click: the pane a row of the list will change says so, while the pointer or the
  // keys are on that row (lib/looks.ts keeps it, so moving over the list draws only the tab).
  // The tab stays while the pointer crosses the list between rows (a folder's heading), and
  // the row the keys are on is described by the tab's words. And a double click on a row keeps
  // the look it opened: only when both clicks were on that row. When the list moved between
  // them and the second click hit another row, nothing is placed, and that row is a look.
  const aimedAt = useRef<string | null>(null);
  const aimFor = (id: string | null): { slot: number; how: Aim } | null => {
    const now = getStations(), all = getState().sessions;
    if (!id || now.focus || now.slots.length < 2 || !all[id] || all[id]!.archived) return null;
    const at = paneOf(now, id);
    if (at >= 0) return { slot: at, how: "here" };
    const own = now.slots.indexOf(id);
    if (own >= 0) return { slot: own, how: "back" };
    const to = target(now);
    return { slot: to, how: now.slots[to] == null ? "fill" : "look" };
  };
  useEffect(() => {
    if (phone) return;
    const aimAt = (id: string | null) => { aimedAt.current = id; setAim(aimFor(id)); };
    const over = (e: Event) => {
      const row = rowOf(e.target);
      if (row) aimAt(row.dataset.session ?? null);
      else if (!(e.target instanceof Element && e.target.closest('[data-testid="session-list"]'))) aimAt(null);
    };
    const into = (e: FocusEvent) => {
      const row = rowOf(e.target);
      if (!row) return;
      aimAt(row.dataset.session ?? null);
      row.setAttribute("aria-describedby", "k-aim-says");
    };
    const out = (e: FocusEvent) => {
      const row = rowOf(e.target);
      if (!row) return;
      row.removeAttribute("aria-describedby");
      if (!rowOf(e.relatedTarget)) aimAt(null);
    };
    const clicks: (string | null)[] = [null, null];
    const click = (e: MouseEvent) => { clicks.shift(); clicks.push(rowOf(e.target)?.dataset.session ?? null); };
    const keep = (e: MouseEvent) => {
      const id = rowOf(e.target)?.dataset.session;
      if (id && clicks[0] === id && clicks[1] === id && !e.ctrlKey && !e.metaKey) keepLook(id);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("focusin", into);
    document.addEventListener("focusout", out);
    document.addEventListener("click", click, true);
    document.addEventListener("dblclick", keep);
    return () => {
      document.removeEventListener("pointerover", over); document.removeEventListener("focusin", into); document.removeEventListener("focusout", out);
      document.removeEventListener("click", click, true); document.removeEventListener("dblclick", keep);
      aimAt(null);
    };
  }, [phone]);
  // What the click will do changes with the panes (the row that was clicked is on screen now).
  useEffect(() => { if (aimedAt.current) setAim(aimFor(aimedAt.current)); }, [kept.slots, kept.over, kept.active, kept.focus, sessions]);
  // A window narrowed to a phone's width and widened again shows what it showed: the same page, the same looks.
  const desk = useRef<typeof route | null>(null);
  const wide = useRef(!phone);
  useEffect(() => {
    // (Only a window that was wide: a page opened on a phone has no panes to come back to.)
    if (phone) { if (wide.current) desk.current = getUI().route; wide.current = false; return; }
    wide.current = true;
    const was = desk.current;
    desk.current = null;
    if (was && (was.name === "new" || (was.name === "session" && sessions[was.id]))) navigate(was, true);
  }, [phone]);
  const needUnder = useNeedUnderLooks();

  // The width a panel beside the helm takes: the helm's narrowest grows by it (bridge.css).
  const side = usePanelSide();
  // The side panel starts closed in every session. One they opened in a
  // session comes back with it (and over a reload); closing it forgets it.
  const panel = useUI((s) => s.panel);
  const panels = () => JSON.parse(localStorage.getItem("keel.stationPanel") ?? "{}") as Record<string, string>;
  useEffect(() => {
    if (!helm) return;
    const want = panels()[helm] ?? null;
    if (want !== getUI().panel) setUI({ panel: want });
  }, [helm]);
  useEffect(() => {
    if (!helm) return;
    const m = panels();
    if (panel) m[helm] = panel; else delete m[helm];
    localStorage.setItem("keel.stationPanel", JSON.stringify(m));
  }, [panel]);

  // Phone: the page in view is the helm.
  const track = useRef<HTMLElement>(null);
  // Where the owner is follows the panes: the row tells when one comes, goes, changes size or scrolls (lib/automation.ts).
  useEffect(() => { watchPanes(track.current); return () => watchPanes(null); }, []);
  // A page comes into view as the helm only while the owner moves the track: a finger on it or
  // a wheel over it, until the scroll they started ends. A scroll made by the page (to the
  // page a dock mark names, smooth when motion is on) passes other pages on its way, and
  // each was taken for the one swiped to: the press ended on another conversation.
  const swipe = useRef({ owned: false, fingers: 0, moved: false, to: null as string | null });
  // The helm changed by anything but a swipe (a mark, a row, a key): the scroll that follows is the page's.
  useLayoutEffect(() => { if (helm !== swipe.current.to) { swipe.current.owned = false; swipe.current.to = null; } }, [helm]);
  useEffect(() => {
    const el = track.current;
    if (!phone || !el) return;
    const sw = swipe.current;
    const take = (id: string | undefined) => {
      if (!sw.owned || !id || id === helmNow()) return;
      sw.to = id;
      navigate({ name: "session", id }, true);
    };
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        // A page with no width is not in view (a window that has no size yet): every page of
        // such a track "intersects", and each would take the helm from the last, without end.
        if (e.isIntersecting && e.intersectionRect.width > 0) take((e.target as HTMLElement).dataset.station);
      }
    }, { root: el, threshold: 0.6 });
    el.querySelectorAll(":scope > [data-station]").forEach((p) => io.observe(p));
    const own = () => { sw.owned = true; sw.moved = false; };
    const down = (e: TouchEvent) => { sw.fingers = e.touches.length; own(); };
    const up = (e: TouchEvent) => { sw.fingers = e.touches.length; if (!sw.fingers && !sw.moved) sw.owned = false; };
    const moved = () => { sw.moved = true; };
    // Where the owner's scroll came to rest is the helm (the observer may not have said so yet).
    const rest = () => {
      if (!sw.owned || sw.fingers) return;
      const r = el.getBoundingClientRect();
      const at = [...el.querySelectorAll<HTMLElement>(":scope > [data-station]")].find((p) => { const b = p.getBoundingClientRect(); return b.width > 0 && b.left <= r.left + r.width / 2 && b.right > r.left + r.width / 2; });
      take(at?.dataset.station);
      sw.owned = false;
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", up, { passive: true });
    el.addEventListener("wheel", own, { passive: true });
    el.addEventListener("scroll", moved, { passive: true });
    el.addEventListener("scrollend", rest);
    return () => {
      io.disconnect();
      el.removeEventListener("touchstart", down); el.removeEventListener("touchend", up); el.removeEventListener("touchcancel", up);
      el.removeEventListener("wheel", own); el.removeEventListener("scroll", moved); el.removeEventListener("scrollend", rest);
    };
  }, [phone, pages.map((s) => s.id).join()]);

  // A divider between two panes moves width from one to the other; the rest keep theirs.
  // While it is dragged only the two panes' flex shares change, on the page
  // itself; the sizes are kept once, when the drag ends.
  const drag = useRef<{ w: number[]; px: number[]; els: HTMLElement[]; next?: number[] } | null>(null);
  const grip = (i: number) => ({
    onStart: () => {
      const els = [...(track.current?.querySelectorAll<HTMLElement>(":scope > [data-slot]") ?? [])];
      drag.current = { w: shares(getStations()), px: els.map((el) => el.getBoundingClientRect().width), els };
    },
    onMove: (dx: number) => {
      const d = drag.current;
      if (!d || d.px.length !== d.w.length) return;
      const pair = d.px[i]! + d.px[i + 1]!;
      const min = Math.min(paneMin(), pair / 2);
      const left = Math.min(pair - min, Math.max(min, d.px[i]! + dx));
      const share = d.w[i]! + d.w[i + 1]!;
      const w = [...d.w];
      w[i] = (share * left) / pair;
      w[i + 1] = share - w[i]!;
      d.next = w;
      d.els[i]!.style.flexGrow = String(w[i]);
      d.els[i + 1]!.style.flexGrow = String(w[i + 1]);
    },
    onEnd: () => { if (drag.current?.next) stations.resize(drag.current.next); drag.current = null; },
    onReset: () => stations.resize(),
  });

  const missing = (id: string, key: string, slot?: number, grow?: number) => (
    <section key={key} className="k-station" data-helm data-station={id} data-slot={slot} data-watch="idle" data-missing style={grow === undefined ? undefined : { flexGrow: grow }} aria-label="Session not on this daemon"><div className="k-band" aria-hidden="true" /><SessionView id={id} missingHeader={<MissingHead id={id} />} /></section>
  );
  // A phone's page keeps the name of the pane that holds its session at a desk: the session stays drawn when the window crosses phone width.
  const pageKey = (id: string) => kept.keys[kept.slots.indexOf(id)] ?? id;
  const stack = st.slots.length > 1;
  return (
    <>
      <main ref={track} className="k-stations" style={{ "--k-side-w": `${side.width}px` } as CSSProperties} data-count={phone ? pages.length + (fresh ? 1 : 0) : slots.length} data-focus={focus || undefined} data-need-under={needUnder.length || undefined} data-testid="bridge">
        {phone && helm && !sessions[helm] && missing(helm, helm)}
        {/* One keyed list for both layouts: a session keeps its pane (and what its panel shows) when the window crosses phone width. */}
        {[...(phone ? pages.map((s) => <Station key={pageKey(s.id)} s={s} helm={s.id === helm} />) : []), ...slots.flatMap(({ id, i }, n) => {
          const grow = focus ? 1 : weights[i]!;
          const key = st.keys[i]!;
          const own = id && sessions[id] && !gone(id) ? sessions[id]! : null;
          const over = st.over[i] && !gone(st.over[i]!) ? st.over[i]! : null;
          const isNew = i === startAt;
          const on = isNew || (!!helm && (over ?? id) === helm);
          // Beside other panes the start page lies over the pane's session, which stays drawn; one pane is a page that is turned.
          const pane = isNew && !stack ? <NewStation key={`new-${key}`} slot={i} grow={grow} />
            : own ? <Station key={key} s={own} helm={on} slot={i} grow={grow} fresh={isNew} look={over ? { id: over, s: sessions[over] } : undefined} />
            // Its own session is gone and a look lies over it: the look is its session (stations.drop says so next).
            : over && sessions[over] ? <Station key={key} s={sessions[over]!} helm={on} slot={i} grow={grow} fresh={isNew} />
            : isNew ? <NewStation key={`new-${key}`} slot={i} grow={grow} beside={stack} />
            : id && id === helm ? missing(id, `gone-${key}`, i, grow)
            : <EmptyPane key={`empty-${key}`} slot={i} grow={grow} next={!fresh && target(st) === i} />;
          const before = slots[n - 1];
          return before ? [<Grip key={`grip-${i}`} className="k-split" testid="pane-grip" label={`Width of panes ${before.i + 1} and ${i + 1}`} now={(100 * weights[before.i]!) / (weights[before.i]! + weights[i]!)} {...grip(before.i)} />, pane] : [pane];
        })]}
        {phone && (fresh || (!helm && pages.length === 0)) && <NewStation />}
      </main>
      {!phone && <PaneMap track={track} />}
      {phone && <PhoneDock list={pages} helm={helm} />}
      {!phone && <AimSays track={track} />}
    </>
  );
}
