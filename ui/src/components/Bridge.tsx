// The bridge: as many panes side by side as the owner chose, a session in
// each. The pane worked in is the helm and carries the full header. Keel
// never adds or removes a pane by itself: opening a session fills the pane
// worked in when it is empty, else a free one, else replaces the session
// there. Panes are resized by dragging the divider between them, reordered by
// dragging a header onto another pane, and a session dragged from the rail
// lands in the pane it is dropped on. The helm can be focused to the full
// width. On a phone the sessions are pages you swipe between, with a dock of
// their marks along the bottom.
import { ChevronLeft, ChevronRight, ListTree, Maximize2, Minimize2, Pin, PinOff, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { registerCommand } from "../lib/keys.ts";
import { paneMin, panesMax, useRail, useWidth } from "../lib/rail.ts";
import { byAttention, getStations, opened, shares, stations, target, useStations } from "../lib/stations.ts";
import { getState, useStore } from "../lib/store.ts";
import { getUI, navigate, savePref, setUI, useUI } from "../lib/ui.ts";
import { ago, when } from "../lib/utils.ts";
import { lastLine, useWatch, WATCH_LABEL, type Watch } from "../lib/watch.ts";
import { isPinned, pin as pinSession } from "../lib/sessops.ts";
import { reportError } from "../lib/store.ts";
import { Grip } from "./Grip.tsx";
import { DRAG, dragSession, setPanes } from "./Panes.tsx";
import { elapsed, folderOf, Mark, modelOf, useLive, useNow } from "./Mark.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { Boundary, SessionView } from "./SessionView.tsx";
import { StartBox } from "./StartBox.tsx";

const helmNow = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
const filled = () => getStations().slots.filter((x): x is string => !!x);
function step(by: -1 | 1) {
  const ids = filled();
  const h = helmNow();
  const i = h ? ids.indexOf(h) : -1;
  const next = ids[(i + by + ids.length) % ids.length];
  if (next) navigate({ name: "session", id: next });
}
registerCommand(
  { id: "station.next", label: "Next pane", group: "Bridge", keys: "alt+]", inInput: true, run: () => step(1) },
  { id: "station.prev", label: "Previous pane", group: "Bridge", keys: "alt+[", inInput: true, run: () => step(-1) },
  { id: "station.right", label: "Move the pane right", group: "Bridge", keys: "alt+shift+]", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, 1); } },
  { id: "station.left", label: "Move the pane left", group: "Bridge", keys: "alt+shift+[", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, -1); } },
  { id: "station.focus", label: "Focus the pane (full width) or show all", group: "Bridge", keys: "alt+enter", inInput: true, run: () => stations.toggleFocus() },
  { id: "station.pin", label: "Pin or unpin the session in the list", group: "Bridge", keys: "alt+p", run: () => { const h = helmNow(); if (h) pinSession(h, !isPinned(getState().sessions[h])).catch(reportError); } },
  { id: "station.close", label: "Close the session in the pane", group: "Bridge", keys: "alt+w", run: () => { const h = helmNow(); if (h) closeStation(h); } },
  { id: "panes.more", label: "One more pane", group: "Bridge", words: "window split add column", when: () => getStations().count < panesMax(), run: () => setPanes(getStations().count + 1) },
  { id: "panes.fewer", label: "One pane fewer", group: "Bridge", words: "window split remove column", when: () => getStations().count > 1, run: () => setPanes(getStations().count - 1) },
  { id: "panes.even", label: "Make the panes equal width", group: "Bridge", words: "reset size split", when: () => getStations().count > 1, run: () => stations.resize() },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `panes.${n}`, label: `${n} pane${n > 1 ? "s" : ""}`, group: "Bridge", words: "window split columns layout", when: () => n <= Math.max(panesMax(), getStations().count), run: () => setPanes(n) })),
);

// Empties the pane; the pane stays. The helm moves to a neighbour that holds a session.
function closeStation(id: string) {
  const { slots } = getStations();
  const i = slots.indexOf(id);
  const next = [...slots.slice(i + 1), ...slots.slice(0, Math.max(0, i)).reverse()].find((x) => x);
  stations.close(id);
  if (helmNow() === id) navigate(next ? { name: "session", id: next } : { name: "new" });
}

function Tool({ label, onClick, children, testid, on }: { label: string; onClick: () => void; children: React.ReactNode; testid?: string; on?: boolean }) {
  return (
    <button type="button" className="k-tool" title={label} aria-label={label} aria-pressed={on} data-testid={testid} onClick={(e) => { e.stopPropagation(); onClick(); }}>
      {children}
    </button>
  );
}

function StationHead({ s, w, helm, pinned }: { s: Session; w: Watch; helm: boolean; pinned: boolean }) {
  const events = useStore((x) => x.events[s.id]);
  const start = useMemo(() => [...(events ?? [])].reverse().find((e) => e.kind === "turn_start")?.ts, [events]);
  const now = useNow(w === "work");
  const focus = useStations((x) => x.focus);
  return (
    <header className="k-station-head" data-testid="station-head" draggable={!focus} onDragStart={dragSession(s.id)} title={focus ? undefined : "Drag onto another pane to trade places"}>
      <div className="k-station-row">
        <span className="k-station-word"><Mark w={w} />{WATCH_LABEL[w]}</span>
        {w === "work" && start && <span className="k-station-clock tabular-nums">{elapsed(now - start)}</span>}
        <span className="k-station-meta truncate">{s.workspace_gone ? <span className="k-gone" title={`${s.workspace} is not on disk`}>{folderOf(s)} gone</span> : folderOf(s)}  {modelOf(s.model)}</span>
        <span className="k-station-tools">
          {!focus && <Tool label="Move left (Alt Shift [)" onClick={() => stations.move(s.id, -1)}><ChevronLeft /></Tool>}
          {!focus && <Tool label="Move right (Alt Shift ])" onClick={() => stations.move(s.id, 1)}><ChevronRight /></Tool>}
          <Tool label={pinned ? "Unpin from the top of the list (Alt P)" : "Pin to the top of the list (Alt P)"} testid="station-pin" on={pinned} onClick={() => pinSession(s.id, !pinned).catch(reportError)}>{pinned ? <PinOff /> : <Pin />}</Tool>
          <Tool label={focus ? "Show all panes (Alt Enter)" : "Focus this pane (Alt Enter)"} testid="station-focus" on={focus} onClick={() => { if (!helm) navigate({ name: "session", id: s.id }); stations.toggleFocus(); }}>{focus ? <Minimize2 /> : <Maximize2 />}</Tool>
          <Tool label="Close the session here (Alt W)" testid="station-close" onClick={() => closeStation(s.id)}><X /></Tool>
        </span>
      </div>
      <h2 className="k-station-title" title={s.title}>{s.title || "New session"}</h2>
      <p className="k-station-line truncate">{lastLine(events, s.workspace) || " "}</p>
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

// A pane takes a dragged session: it shows where the drop lands.
function useDrop(slot: number | undefined) {
  const [over, setOver] = useState(false);
  if (slot === undefined) return {};
  const mine = (e: DragEvent) => e.dataTransfer.types.includes(DRAG);
  return {
    "data-drop": over || undefined,
    onDragOver: (e: DragEvent) => { if (!mine(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (!over) setOver(true); },
    onDragLeave: (e: DragEvent<HTMLElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(DRAG);
      setOver(false);
      if (!id) return;
      e.preventDefault();
      stations.place(id, slot);
      navigate({ name: "session", id });
    },
  };
}

function Station({ s, helm, slot, grow }: { s: Session; helm: boolean; slot?: number; grow?: number }) {
  const w = useWatch(s);
  const ref = useRef<HTMLElement>(null);
  const drop = useDrop(slot);
  // The helm scrolls into view when it changes (keyboard moves, the rail).
  useEffect(() => { if (helm) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); }, [helm]);
  return (
    <section
      ref={ref}
      className="k-station"
      style={grow === undefined ? undefined : { flexGrow: grow }}
      data-station={s.id}
      data-slot={slot}
      data-watch={w}
      data-helm={helm || undefined}
      data-testid="station"
      aria-label={`${s.title || "New session"}, ${WATCH_LABEL[w]}`}
      onPointerDownCapture={() => { if (!helm) navigate({ name: "session", id: s.id }); }}
      // Keyboard: tabbing into a pane takes the helm. Focus moved by code (an
      // approval card taking the keys in another pane) does not.
      onKeyUpCapture={(e) => { if (!helm && e.key === "Tab") navigate({ name: "session", id: s.id }); }}
      {...drop}
    >
      <div className="k-band" aria-hidden="true" />
      <Boundary>
        <SessionView
          id={s.id}
          panel={helm}
          focus={helm}
          header={<><StationHead s={s} w={w} helm={helm} pinned={isPinned(s)} />{helm && <SessionHeader session={s} />}</>}
        />
      </Boundary>
    </section>
  );
}

function NewStation({ slot, grow }: { slot?: number; grow?: number }) {
  const drop = useDrop(slot);
  return (
    <section className="k-station k-station-new" data-slot={slot} data-helm style={grow === undefined ? undefined : { flexGrow: grow }} aria-label="New session" {...drop}>
      <div className="k-band" aria-hidden="true" />
      <StartBox />
    </section>
  );
}

// A pane with no session: it waits for the owner to put one in. It offers the
// sessions not on screen, what needs him first, and takes a dragged one.
function EmptyPane({ slot, grow, next }: { slot: number; grow: number; next: boolean }) {
  const { list, watches } = useLive();
  const slots = useStations((x) => x.slots);
  const offer = useMemo(() => byAttention(list, watches).filter((s) => !slots.includes(s.id)).slice(0, 7), [list, watches, slots]);
  const drop = useDrop(slot);
  const put = (id: string) => { stations.place(id, slot); navigate({ name: "session", id }); };
  return (
    <section className="k-station k-pane-empty" data-slot={slot} data-next={next || undefined} data-testid="pane-empty" style={{ flexGrow: grow }} aria-label={`Empty pane ${slot + 1}`} onPointerDown={() => stations.setActive(slot)} {...drop}>
      <div className="k-band" aria-hidden="true" />
      <div className="k-pane-empty-body">
        <p className="k-pane-empty-word">Pane {slot + 1}<span>{next ? "the next session opens here" : "empty"}</span></p>
        <h2>Nothing here yet</h2>
        <p className="k-pane-empty-hint">Pick a session below or in the list, or drag one in.</p>
        {offer.length > 0 && (
          <div className="k-pane-empty-list">
            {offer.map((s) => (
              <button key={s.id} type="button" data-testid="pane-offer" data-session={s.id} data-watch={watches[s.id]} onClick={() => put(s.id)}>
                <span className="grid w-4 place-items-center" title={WATCH_LABEL[watches[s.id] ?? "idle"]}><Mark w={watches[s.id] ?? "idle"} /></span>
                <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                <span className="k-pane-empty-in">{folderOf(s)}</span>
                <span className="k-pane-empty-time tabular-nums" title={when(s.updated)}>{ago(s.updated)}</span>
              </button>
            ))}
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
  const fresh = useUI((s) => s.route.name === "new");
  const need = list.filter((s) => watches[s.id] === "need").length;
  return (
    <nav className="k-dock" aria-label="Stations">
      <button type="button" className="k-dock-btn" aria-label="All sessions" onClick={() => savePref("sidebar", true)}><ListTree /></button>
      <ol className="k-dock-list">
        {list.map((s) => (
          <li key={s.id}>
            <button type="button" className="k-dock-mark" data-watch={watches[s.id]} aria-current={helm === s.id ? "page" : undefined} aria-label={`${s.title || "New session"}, ${WATCH_LABEL[watches[s.id]!]}`} onClick={() => navigate({ name: "session", id: s.id })}>
              <Mark w={watches[s.id]!} />
            </button>
          </li>
        ))}
      </ol>
      {need > 0 && <span className="k-dock-need" aria-live="polite">{need} need you</span>}
      <button type="button" className="k-dock-btn" aria-label="New session" aria-current={fresh ? "page" : undefined} onClick={() => navigate({ name: "new" })}><Plus /></button>
    </nav>
  );
}

// A phone's pages: the helm and what asks for attention.
const PHONE_PAGES = 6;

export function Bridge() {
  const route = useUI((s) => s.route);
  const rail = useRail();
  const width = useWidth();
  const phone = width < 768;
  const { list, watches } = useLive();
  const kept = useStations((s) => s);
  const sessions = useStore((x) => x.sessions);
  const loaded = useStore((x) => x.loaded.sessions);
  const helm = route.name === "session" ? route.id : null;
  const fresh = route.name === "new";

  // The first layout, once: two panes when they fit beside the list, the helm and what asks for attention in them.
  useEffect(() => {
    if (kept.seeded || !loaded || phone) return;
    const count = width - rail.width >= 2 * 620 * getUI().scale ? 2 : 1;
    const ids = byAttention(list, watches).map((s) => s.id).filter((id) => id !== helm);
    stations.seed(count, [...(helm ? [helm] : []), ...ids]);
  }, [kept.seeded, loaded]);
  // Opening a session places it (kept below); this render already shows it there.
  const st = helm ? opened(kept, helm) : kept;
  useEffect(() => { if (helm && kept.seeded) stations.open(helm); }, [helm, kept.seeded]);
  // A session that is gone (deleted, archived) leaves its pane empty.
  const gone = (id: string) => id !== helm && (!sessions[id] || sessions[id]!.archived);
  useEffect(() => { if (loaded) stations.drop(gone); }, [loaded, sessions, helm]);

  const focus = kept.focus;
  const startAt = fresh ? target(st) : -1; // the pane a new session is started in
  const weights = shares(st);
  const slots = phone ? [] : st.slots.map((id, i) => ({ id, i })).filter((x) => !focus || x.i === (fresh ? startAt : st.active));
  const pages = useMemo(() => (phone ? [...(helm && sessions[helm] ? [sessions[helm]!] : []), ...byAttention(list, watches).filter((s) => s.id !== helm)].slice(0, PHONE_PAGES) : []), [phone, list, watches, helm, sessions]);
  const onScreen = phone ? pages.map((s) => s.id) : slots.map((x) => x.id).filter((x): x is string => !!x && !gone(x));
  useEffect(() => stations.setShown(onScreen));

  // The side panel is remembered per session: coming back to one brings its panel back.
  const panel = useUI((s) => s.panel);
  useEffect(() => {
    if (!helm) return;
    const m = JSON.parse(localStorage.getItem("keel.stationPanel") ?? "{}") as Record<string, string | null>;
    if (helm in m && m[helm] !== getUI().panel) setUI({ panel: m[helm] ?? null });
  }, [helm]);
  useEffect(() => {
    if (!helm) return;
    const m = JSON.parse(localStorage.getItem("keel.stationPanel") ?? "{}") as Record<string, string | null>;
    m[helm] = panel;
    localStorage.setItem("keel.stationPanel", JSON.stringify(m));
  }, [panel]);

  // Phone: the page in view is the helm.
  const track = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!phone || !track.current) return;
    const io = new IntersectionObserver((es) => {
      for (const e of es) {
        const id = (e.target as HTMLElement).dataset.station;
        if (e.isIntersecting && id && id !== helmNow()) navigate({ name: "session", id }, true);
      }
    }, { root: track.current, threshold: 0.6 });
    track.current.querySelectorAll("[data-station]").forEach((el) => io.observe(el));
    return () => io.disconnect();
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

  const missing = (id: string, slot?: number, grow?: number) => (
    <section key={id} className="k-station" data-helm data-station={id} data-slot={slot} data-watch="idle" data-missing style={grow === undefined ? undefined : { flexGrow: grow }} aria-label="Session not on this daemon"><div className="k-band" aria-hidden="true" /><SessionView id={id} missingHeader={<MissingHead id={id} />} /></section>
  );
  return (
    <>
      <main ref={track} className="k-stations" data-count={phone ? pages.length + (fresh ? 1 : 0) : slots.length} data-focus={focus || undefined} data-testid="bridge">
        {phone && helm && !sessions[helm] && missing(helm)}
        {phone && pages.map((s) => <Station key={s.id} s={s} helm={s.id === helm} />)}
        {phone && (fresh || (!helm && pages.length === 0)) && <NewStation />}
        {slots.flatMap(({ id, i }, n) => {
          const grow = focus ? 1 : weights[i]!;
          const pane = i === startAt ? <NewStation key={`new-${i}`} slot={i} grow={grow} />
            : id && sessions[id] && !gone(id) ? <Station key={id} s={sessions[id]!} helm={id === helm} slot={i} grow={grow} />
            : id && id === helm ? missing(id, i, grow)
            : <EmptyPane key={`empty-${i}`} slot={i} grow={grow} next={!fresh && target(st) === i} />;
          const before = slots[n - 1];
          return before ? [<Grip key={`grip-${i}`} className="k-split" testid="pane-grip" label={`Width of panes ${before.i + 1} and ${i + 1}`} now={(100 * weights[before.i]!) / (weights[before.i]! + weights[i]!)} {...grip(before.i)} />, pane] : [pane];
        })}
      </main>
      {phone && <PhoneDock list={pages} helm={helm} />}
    </>
  );
}
