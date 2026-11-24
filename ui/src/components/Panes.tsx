// The pieces of the pane layout the rail needs too: the choice of how many
// panes are open, and the drag of a session into one.
import type { DragEvent } from "react";
import { panesMax, useWidth } from "../lib/rail.ts";
import { getStations, stations, useStations } from "../lib/stations.ts";
import { useUI } from "../lib/ui.ts";
import { Menu } from "@base-ui/react/menu";
import { Columns3 } from "lucide-react";
import { popupClass } from "./ui.tsx";

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
// How many panes: the owner's number, 1 up to what the window holds, as the first row of the
// Arrange menu above the list (ListArrange.tsx), and the palette's commands. A rare act: it does
// not stand beside the logo. Each choice is a glyph of its columns, named in words.
export function PaneChoices() {
  const width = useWidth();
  useUI((s) => s.scale);
  const count = useStations((x) => x.count);
  const focus = useStations((x) => x.focus);
  const max = Math.max(panesMax(width), count);
  const shown = focus ? 1 : count;
  if (max < 2) return null;
  return (
    <>
      <div className="k-label px-2.5 pt-1.5 pb-1">Panes</div>
      <div className="k-panes" role="group" aria-label="Panes" data-testid="pane-count">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          // (The number shown again, one pane while only the helm shows, still sets it.)
          <Menu.Item key={n} className="k-panes-item" role="menuitemradio" aria-checked={shown === n} aria-label={`${n} pane${n > 1 ? "s" : ""}`} title={`${n} pane${n > 1 ? "s" : ""}`} data-testid={`panes-${n}`} onClick={() => setPanes(n)}>
            <span aria-hidden="true" className="k-panes-glyph">{Array.from({ length: n }, (_, j) => <i key={j} />)}</span>
          </Menu.Item>
        ))}
      </div>
    </>
  );
}

// The folded rail has no Arrange menu (it is the list's), so the same choice is a menu of its own at
// its foot, its glyph the count in use. (A phone has one pane: no choice to make.)
export function PanesButton() {
  const width = useWidth();
  useUI((s) => s.scale);
  const count = useStations((x) => x.count);
  const focus = useStations((x) => x.focus);
  if (Math.max(panesMax(width), count) < 2) return null;
  const shown = focus ? 1 : count;
  const name = `Panes: ${shown} open`;
  return (
    <Menu.Root>
      <Menu.Trigger className="k-act" data-testid="panes-button" aria-label={name} title={name}>
        <Columns3 />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="right" align="end" sideOffset={8} className="z-50 outline-none">
          <Menu.Popup className={popupClass} data-testid="panes-menu">
            <PaneChoices />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
