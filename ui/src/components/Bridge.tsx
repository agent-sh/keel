// The bridge: every live session that matters open at once, a station each,
// side by side across the width. The station you work in (the helm) is wider
// and carries the full header. Stations can be pinned, moved, closed, or the
// helm focused to the full width. On a phone the stations are pages you
// swipe between, with a dock of their marks along the bottom.
import { ChevronLeft, ChevronRight, ListTree, Maximize2, Minimize2, Pin, PinOff, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { registerCommand } from "../lib/keys.ts";
import { getStations, pickStations, stations, useStations } from "../lib/stations.ts";
import { useStore } from "../lib/store.ts";
import { getUI, navigate, savePref, setUI, useUI } from "../lib/ui.ts";
import { lastLine, useWatch, WATCH_LABEL, type Watch } from "../lib/watch.ts";
import { pin as pinSession } from "../lib/sessops.ts";
import { reportError } from "../lib/store.ts";
import { elapsed, folderOf, Mark, modelOf, useLive, useNow } from "./Mark.tsx";
import { SessionHeader } from "./SessionHeader.tsx";
import { Boundary, SessionView } from "./SessionView.tsx";
import { StartBox } from "./StartBox.tsx";

const STATION = 560; // narrowest station worth working in, px
const RAIL = 64;

function useWidth() {
  const [w, setW] = useState(innerWidth);
  useEffect(() => {
    const f = () => setW(innerWidth);
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return w;
}

// The stations on screen, in order, for the keyboard commands and the rail.
let shownNow: string[] = [];
const helmNow = () => { const r = getUI().route; return r.name === "session" ? r.id : null; };
function step(by: -1 | 1) {
  const h = helmNow();
  const i = h ? shownNow.indexOf(h) : -1;
  const next = shownNow[(i + by + shownNow.length) % shownNow.length];
  if (next) navigate({ name: "session", id: next });
}
registerCommand(
  { id: "station.next", label: "Next station", group: "Bridge", keys: "alt+]", inInput: true, run: () => step(1) },
  { id: "station.prev", label: "Previous station", group: "Bridge", keys: "alt+[", inInput: true, run: () => step(-1) },
  { id: "station.right", label: "Move the station right", group: "Bridge", keys: "alt+shift+]", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, shownNow, 1); } },
  { id: "station.left", label: "Move the station left", group: "Bridge", keys: "alt+shift+[", inInput: true, run: () => { const h = helmNow(); if (h) stations.move(h, shownNow, -1); } },
  { id: "station.focus", label: "Focus the station (full width) or show all", group: "Bridge", keys: "alt+enter", inInput: true, run: () => stations.toggleFocus() },
  { id: "station.pin", label: "Pin or unpin the station", group: "Bridge", keys: "alt+p", run: () => { const h = helmNow(); if (h) pinSession(h, !getStations().pinned.includes(h)).catch(reportError); } },
  { id: "station.close", label: "Close the station", group: "Bridge", keys: "alt+w", run: () => { const h = helmNow(); if (h) closeStation(h); } },
);

function closeStation(id: string) {
  const i = shownNow.indexOf(id);
  const next = shownNow[i + 1] ?? shownNow[i - 1];
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

function StationHead({ s, w, helm, pinned, shown }: { s: Session; w: Watch; helm: boolean; pinned: boolean; shown: string[] }) {
  const events = useStore((x) => x.events[s.id]);
  const start = useMemo(() => [...(events ?? [])].reverse().find((e) => e.kind === "turn_start")?.ts, [events]);
  const now = useNow(w === "work");
  const focus = useStations((x) => x.focus);
  return (
    <header className="k-station-head" data-testid="station-head">
      <div className="k-station-row">
        <span className="k-station-word">{WATCH_LABEL[w]}</span>
        {w === "work" && start && <span className="k-station-clock tabular-nums">{elapsed(now - start)}</span>}
        <span className="k-station-meta truncate">{folderOf(s)}  {modelOf(s.model)}</span>
        <span className="k-station-tools">
          {!focus && <Tool label="Move left (Alt Shift [)" onClick={() => stations.move(s.id, shown, -1)}><ChevronLeft /></Tool>}
          {!focus && <Tool label="Move right (Alt Shift ])" onClick={() => stations.move(s.id, shown, 1)}><ChevronRight /></Tool>}
          <Tool label={pinned ? "Unpin (Alt P)" : "Pin here (Alt P)"} testid="station-pin" on={pinned} onClick={() => pinSession(s.id, !pinned).catch(reportError)}>{pinned ? <PinOff /> : <Pin />}</Tool>
          <Tool label={focus ? "Show all stations (Alt Enter)" : "Focus this station (Alt Enter)"} testid="station-focus" on={focus} onClick={() => { if (!helm) navigate({ name: "session", id: s.id }); stations.toggleFocus(); }}>{focus ? <Minimize2 /> : <Maximize2 />}</Tool>
          <Tool label="Close the station (Alt W)" testid="station-close" onClick={() => closeStation(s.id)}><X /></Tool>
        </span>
      </div>
      <h2 className="k-station-title truncate" title={s.title}>{s.title || "New session"}</h2>
      <p className="k-station-line truncate">{lastLine(events, s.workspace) || " "}</p>
      {pinned && <span className="k-pin-mark" aria-hidden="true" />}
    </header>
  );
}

function Station({ s, helm, pinned, shown }: { s: Session; helm: boolean; pinned: boolean; shown: string[] }) {
  const w = useWatch(s);
  const ref = useRef<HTMLElement>(null);
  // The helm scrolls into view when it changes (keyboard moves, the rail).
  useEffect(() => { if (helm) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); }, [helm]);
  return (
    <section
      ref={ref}
      className="k-station"
      data-station={s.id}
      data-watch={w}
      data-helm={helm || undefined}
      data-testid="station"
      aria-label={`${s.title || "New session"}, ${WATCH_LABEL[w]}`}
      onPointerDownCapture={() => { if (!helm) navigate({ name: "session", id: s.id }); }}
      // Keyboard: tabbing into a station takes the helm. Focus moved by code (an
      // approval card taking the keys in another station) does not.
      onKeyUpCapture={(e) => { if (!helm && e.key === "Tab") navigate({ name: "session", id: s.id }); }}
    >
      <div className="k-band" aria-hidden="true" />
      <Boundary>
        <SessionView
          id={s.id}
          panel={helm}
          focus={helm}
          header={<><StationHead s={s} w={w} helm={helm} pinned={pinned} shown={shown} />{helm && <SessionHeader session={s} />}</>}
        />
      </Boundary>
    </section>
  );
}

function NewStation() {
  return (
    <section className="k-station k-station-new" aria-label="New session">
      <div className="k-band" aria-hidden="true" />
      <StartBox />
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

export function Bridge() {
  const route = useUI((s) => s.route);
  const sidebar = useUI((s) => s.sidebar);
  const width = useWidth();
  const phone = width < 768;
  const { list, watches } = useLive();
  const st = useStations((s) => s);
  const helm = route.name === "session" ? route.id : null;
  const fresh = route.name === "new";
  const railW = sidebar && !phone ? 280 : RAIL;
  // Room on a wide screen is what fits; on a phone it is the stations you
  // swipe between: the helm and what needs you or works.
  // An open side panel widens the helm by about one station.
  const panelOpen = useUI((s) => !!s.panel) && !!helm;
  const room = phone ? 6 : Math.max(1, Math.floor((width - railW) / STATION) - (fresh ? 1 : 0) - (panelOpen ? 1 : 0));
  const picked = useMemo(() => pickStations(list, watches, helm, Math.max(room, helm ? 1 : 0), st), [list, watches, helm, room, st]);
  const focus = st.focus;
  const shown = focus ? picked.filter((s) => s.id === helm) : picked;
  // A helm that is not a live session (archived, or not on this daemon) still gets its station.
  const sessions = useStore((x) => x.sessions);
  const orphan = helm && !picked.some((s) => s.id === helm) ? helm : null;
  const all = shown;
  shownNow = picked.map((s) => s.id);
  useEffect(() => stations.setShown(all.map((s) => s.id)));

  // The side panel is remembered per station: coming back to one brings its panel back.
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
  }, [phone, all.map((s) => s.id).join()]);

  return (
    <>
      <main ref={track} className="k-stations" data-count={all.length + (fresh ? 1 : 0)} data-focus={focus || undefined} data-testid="bridge">
        {orphan && (sessions[orphan] ? <Station key={orphan} s={sessions[orphan]!} helm pinned={false} shown={shownNow} /> : (
          <section className="k-station" data-helm data-station={orphan} aria-label="Session"><div className="k-band" aria-hidden="true" /><SessionView id={orphan} /></section>
        ))}
        {all.map((s) => <Station key={s.id} s={s} helm={s.id === helm} pinned={st.pinned.includes(s.id) || !!s.settings.pinned_ms} shown={shownNow} />)}
        {fresh && <NewStation />}
        {!fresh && all.length === 0 && <NewStation />}
      </main>
      {phone && <PhoneDock list={picked} helm={helm} />}
    </>
  );
}

