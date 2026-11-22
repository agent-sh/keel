// A session row's own menu (right click, the Menu key or Shift F10 on the row): what the row's
// actions do, by name, for a hand that does not hover. Pin, open beside, archive; a pinned row
// can be moved among the pinned.
import { Menu } from "@base-ui/react/menu";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Columns2, Pin, PinOff } from "lucide-react";
import type { ReactNode } from "react";
import { Kbd } from "./Kbd.tsx";
import { itemClass, popupClass } from "./ui.tsx";

export type RowMenuAt = { x: number; y: number };
export function RowMenu({ at, onClose, pinned, archived, beside, onPin, onMove, onBeside, onArchive }: {
  at: RowMenuAt; onClose: () => void; pinned: boolean; archived: boolean; beside: boolean;
  onPin: () => void; onMove?: (by: -1 | 1) => void; onBeside: () => void; onArchive: () => void;
}) {
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) };
  const item = (testid: string, icon: ReactNode, label: string, run: () => void, keys?: string) => (
    <Menu.Item className={itemClass} data-testid={testid} onClick={run}>
      <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {keys && <Kbd keys={keys} className="shrink-0" />}
    </Menu.Item>
  );
  return (
    <Menu.Root open onOpenChange={(o) => { if (!o) onClose(); }} modal={false}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} min-w-48`} data-testid="row-menu">
            {!archived && item("row-menu-pin", pinned ? <PinOff /> : <Pin />, pinned ? "Unpin" : "Pin to the top", onPin)}
            {pinned && onMove && item("row-menu-up", <ArrowUp />, "Move up", () => onMove(-1), "alt+arrowup")}
            {pinned && onMove && item("row-menu-down", <ArrowDown />, "Move down", () => onMove(1), "alt+arrowdown")}
            {beside && item("row-menu-beside", <Columns2 />, "Open beside", onBeside)}
            {item("row-menu-archive", archived ? <ArchiveRestore /> : <Archive />, archived ? "Restore" : "Archive", onArchive)}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
