// A session put in the pane the owner picks, without dragging: a menu of the
// panes, each with what it holds. Picking one places the session there (as a
// drop on that pane does): a session that already has a pane trades places
// with the one picked. Escape leaves the layout as it was.
import { Menu } from "@base-ui/react/menu";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { stations, useStations } from "../lib/stations.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { itemClass, popupClass } from "./ui.tsx";

// The panes. The popup mounts this only while the menu is open: a closed menu
// (there is one on every row of the list) follows nothing.
function Panes({ id }: { id: string }) {
  const slots = useStations((x) => x.slots);
  const titles = useStore((x) => slots.map((s) => (s ? x.sessions[s]?.title || "New session" : "")).join("\n")).split("\n");
  const from = slots.indexOf(id);
  return (
    <>
      {slots.map((held, i) => (
        <Menu.Item key={i} className={itemClass} disabled={i === from} data-testid="pane-menu-item" data-slot={i}
          onClick={() => { stations.place(id, i); navigate({ name: "session", id }); }}>
          <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-sunken font-mono text-micro tabular-nums text-muted">{i + 1}</span>
          <span className={cn("min-w-0 flex-1 truncate", !held && "text-muted")}>{held ? titles[i] : "Empty pane"}</span>
          <span className="shrink-0 text-micro text-faint">{i === from ? "here" : held && from >= 0 ? "trade places" : held ? "takes its place" : ""}</span>
        </Menu.Item>
      ))}
    </>
  );
}

export function PaneMenu({ id, label, testid, className, children, open, onOpenChange, back }: {
  id: string; label: string; testid: string; className?: string; children: ReactNode;
  open?: boolean; onOpenChange?: (open: boolean) => void;
  back?: RefObject<HTMLElement | null>; // where the keys go when the menu closes (default: its button)
}) {
  // Opened by a key on the row (not from its button): the keys start on the
  // first pane it can go to, as they do when the button opens it.
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      if (popup.current?.contains(document.activeElement) && document.activeElement !== popup.current) return;
      popup.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger aria-label={label} title={label} data-testid={testid} className={className} onClick={(e) => e.stopPropagation()}>{children}</Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="z-50 outline-none">
          <Menu.Popup ref={popup} className={cn(popupClass, "w-72")} data-testid="pane-menu" aria-label={label} finalFocus={back}>
            <Panes id={id} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
