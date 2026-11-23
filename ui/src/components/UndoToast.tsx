// The last act that can be put back (lib/undo.ts), over the page where it
// covers nothing being read or typed: at the foot of the session list, in its
// width, while the list is open; else (a folded list, a phone) in a tab that
// hangs from the top edge. It takes no room of its own, so nothing moves when
// it comes or goes. Its button and its key do the same.
import { Undo2 } from "lucide-react";
import { useLayoutEffect, useState, type CSSProperties } from "react";
import { useStations } from "../lib/stations.ts";
import { runUndo, useUndo } from "../lib/undo.ts";
import { cn } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";

// Where it stands: in the list's foot (its left edge and width, as measured now), or hanging from the top.
function useSpot(on: boolean): { left: number; width: number } | null {
  const [spot, setSpot] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!on) return;
    const read = () => {
      const list = document.querySelector<HTMLElement>('[data-testid="sidebar"]');
      const r = list?.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // A list that is open and holds a sentence: the offer stands in it, a little in from its edges.
      setSpot(r && r.width >= 15 * rem && r.left >= -1 && matchMedia("(min-width: 768px)").matches ? { left: r.left + 0.5 * rem, width: r.width - rem } : null);
    };
    read();
    addEventListener("resize", read);
    return () => removeEventListener("resize", read);
  }, [on]);
  return spot;
}

export function UndoToast() {
  const u = useUndo();
  const spot = useSpot(!!u);
  // Drawn again as the panes change: an act whose pane was given another session since is no longer offered.
  useStations((s) => `${s.slots.join()}|${s.over.join()}`);
  if (!u || !u.can()) return null;
  return (
    <div role="status" data-testid="undo-toast" key={u.n} data-at={spot ? "list" : "top"}
      style={spot ? ({ left: spot.left, width: spot.width } as CSSProperties) : undefined}
      className={cn(
        "fixed z-50 flex min-h-9 items-center gap-2 border border-line-strong bg-raised py-1 pl-3 pr-1 text-caption shadow-2 animate-appear",
        spot ? "bottom-12 rounded-md" : "top-0 left-1/2 max-w-[calc(100vw-1rem)] -translate-x-1/2 rounded-b-md border-t-0",
      )}>
      {/* (Two lines where the list is narrow, so the name is read whole more often than not.) */}
      <span className={cn("min-w-0 flex-1 leading-snug", spot ? "line-clamp-2" : "truncate")} dir="auto" data-testid="undo-words" title={u.words}>{u.words}</span>
      <button type="button" data-testid="undo" onClick={() => runUndo()}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 font-medium text-accent-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <Undo2 className="size-3.5" aria-hidden="true" />Undo<Kbd keys="mod+z" className="max-sm:hidden" />
      </button>
    </div>
  );
}
