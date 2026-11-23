import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { callsigns, paneOver, useRail, useWidth } from "../lib/rail.ts";
import { useStations } from "../lib/stations.ts";
import { useStore } from "../lib/store.ts";
import { scrollMotion } from "../lib/utils.ts";
import { useStateLabel } from "../lib/watch.ts";
import { Mark, useLive } from "./Mark.tsx";

// More panes than the window holds: the row of panes scrolls sideways, and a
// pane past its edge would be out of mind. At the row's right edge stands the
// map of the panes, one mark each in their order: the session's state and its
// short code (the ones the folded rail and a phone's dock give it). A pane in
// view carries the shown bar; one out of it says on which side, and a press
// brings it into view. The column is there for as long as the panes do not
// fit, so nothing moves when one comes into view or leaves it; its width
// comes off the panes that fit (rail.ts: paneOver), which the row is told.
type Pane = { id: string; slot: number; off: "" | "left" | "right" };

// A pane is out of view when less than half of it shows in the row.
function read(row: HTMLElement): Pane[] {
  const r = row.getBoundingClientRect();
  return [...row.querySelectorAll<HTMLElement>(":scope > .k-station[data-slot][data-station]")].map((el) => {
    const b = el.getBoundingClientRect();
    const shows = Math.min(b.right, r.right) - Math.max(b.left, r.left);
    const off = shows * 2 >= b.width ? "" : b.left + b.width / 2 < r.left + r.width / 2 ? "left" : "right";
    return { id: el.dataset.station!, slot: Number(el.dataset.slot), off };
  });
}

export function PaneMap({ track }: { track: RefObject<HTMLElement | null> }) {
  const width = useWidth();
  useStations((s) => `${s.count}|${s.focus}`);
  useRail();
  const paneW = paneOver(width), over = paneW !== null;
  useLayoutEffect(() => {
    const row = track.current;
    if (!row) return;
    row.toggleAttribute("data-over", over);
    if (over) row.style.setProperty("--k-pane-over", `${paneW}px`);
    else row.style.removeProperty("--k-pane-over");
  }, [track, over, paneW]);
  const [panes, setPanes] = useState<Pane[]>([]);
  useEffect(() => {
    const row = track.current;
    if (!row || !over) return setPanes([]);
    let raf = 0;
    const key = (l: Pane[]) => l.map((p) => `${p.id}:${p.slot}:${p.off}`).join();
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { const next = read(row); setPanes((was) => (key(was) === key(next) ? was : next)); });
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const sized = new ResizeObserver(update);
    sized.observe(row);
    const changed = new MutationObserver(update);
    changed.observe(row, { childList: true, attributes: true, attributeFilter: ["data-station", "data-slot"], subtree: false });
    return () => { cancelAnimationFrame(raf); row.removeEventListener("scroll", update); sized.disconnect(); changed.disconnect(); };
  }, [track, over]);
  const { watches } = useLive();
  const label = useStateLabel();
  const sessions = useStore((x) => x.sessions);
  const codes = useMemo(() => callsigns(Object.values(sessions).filter((s) => !s.archived && !s.settings.helper)), [sessions]);
  if (!over || !panes.length) return null;
  const bring = (slot: number) => track.current?.querySelector<HTMLElement>(`:scope > .k-station[data-slot="${slot}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest", behavior: scrollMotion() });
  return (
    <nav className="k-pane-map" aria-label="Panes" data-testid="pane-map">
      {panes.map((p) => {
        const s = sessions[p.id], w = watches[p.id] ?? "idle";
        const where = p.off ? `out of view to the ${p.off}` : "in view";
        const name = `${s?.title || "New session"}, ${label(p.id, w)}, pane ${p.slot + 1}, ${where}`;
        return (
          <button key={p.slot} type="button" className="k-pane-map-mark" data-testid="pane-map-mark" data-session={p.id} data-slot={p.slot} data-watch={w} data-off={p.off || undefined} data-shown={p.off ? undefined : ""}
            aria-label={p.off ? `${name}. Bring it into view` : name} title={name} onClick={() => bring(p.slot)}>
            <Mark w={w} />
            <span className="k-pane-map-code" aria-hidden="true">{codes[p.id] ?? "?"}</span>
          </button>
        );
      })}
    </nav>
  );
}
