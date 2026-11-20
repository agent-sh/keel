// The pieces of the pane layout the rail needs too: the control for how many
// panes are open, and the drag of a session into one.
import type { DragEvent } from "react";
import { panesMax, useWidth } from "../lib/rail.ts";
import { getStations, stations, useStations } from "../lib/stations.ts";
import { useUI } from "../lib/ui.ts";

// A session being dragged: from the rail, or a pane by its header.
export const DRAG = "application/x-keel-session";
export const dragSession = (id: string) => (e: DragEvent<HTMLElement>) => {
  e.dataTransfer.setData(DRAG, id);
  e.dataTransfer.setData("text/plain", `${location.origin}/s/${id}`);
  e.dataTransfer.effectAllowed = "move";
};

// The owner's number of panes, within what the window holds.
export function setPanes(n: number) {
  stations.setFocus(false);
  stations.setCount(Math.min(n, Math.max(panesMax(), getStations().count)));
}
// How many panes: the owner's number, 1 up to what the window holds.
export function PaneCount() {
  const width = useWidth();
  useUI((s) => s.scale);
  const count = useStations((x) => x.count);
  const focus = useStations((x) => x.focus);
  const max = Math.max(panesMax(width), count);
  const shown = focus ? 1 : count;
  return (
    <div className="k-panes" role="radiogroup" aria-label="Panes" data-testid="pane-count" title="How many panes are open">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" role="radio" aria-checked={shown === n} aria-label={`${n} pane${n > 1 ? "s" : ""}`} data-testid={`panes-${n}`} onClick={() => setPanes(n)}>
          <span aria-hidden="true" className="k-panes-glyph">{Array.from({ length: n }, (_, j) => <i key={j} />)}</span>
        </button>
      ))}
    </div>
  );
}
