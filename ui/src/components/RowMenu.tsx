// A session row's own menu (right click, the Menu key or Shift F10 on the row): what the row's
// actions do, by name, for a hand that does not hover. Pin, open beside, move to one of the owner's
// folders, archive; a pinned row can be moved among the pinned. A session is filed from here in
// whatever way the list is grouped: no switch to "By my folders" and no drag.
import { Menu } from "@base-ui/react/menu";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronRight, Columns2, FolderInput, FolderMinus, FolderPlus, ListChecks, MailOpen, Pencil, Pin, PinOff } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { folders, getFolders, loadFolders, tree, useFolders } from "../lib/folders.ts";
import { listActed } from "../lib/list-hold.ts";
import { reportError } from "../lib/store.ts";
import { Kbd } from "./Kbd.tsx";
import { itemClass, popupClass } from "./ui.tsx";

export type RowMenuAt = { x: number; y: number };
export function RowMenu({ at, onClose, pinned, archived, beside, onPin, onMove, onBeside, onArchive, onUnread, onRename, onSelect, session }: {
  at: RowMenuAt; onClose: () => void; pinned: boolean; archived: boolean; beside: boolean;
  onPin: () => void; onMove?: (by: -1 | 1) => void; onBeside: () => void; onArchive: () => void;
  // Set where the row can be marked unread (a row that is read, of a session of this machine's own, not an agent's).
  onUnread?: () => void;
  // Set where the owner may name the session (one of Keel's own): F2 on the row does the same.
  onRename?: () => void;
  // Marks the row to act on with others (lib/select.ts).
  onSelect?: () => void;
  session?: { id: string; folder?: string | null };
}) {
  // The owner's folders are read when a menu first needs them (a list grouped another way has not).
  useEffect(() => { if (session && !getFolders().loaded) void loadFolders(); }, []);
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
          {/* (The menu is drawn in a portal but stands under its row in the tree: a press in it must not open the session as a press on the row does.) */}
          <Menu.Popup className={`${popupClass} min-w-48`} data-testid="row-menu" data-press-on={session?.id} onClick={(e) => e.stopPropagation()}>
            {onRename && item("row-menu-rename", <Pencil />, "Rename", onRename, "f2")}
            {!archived && item("row-menu-pin", pinned ? <PinOff /> : <Pin />, pinned ? "Unpin" : "Pin to the top", onPin)}
            {pinned && onMove && item("row-menu-up", <ArrowUp />, "Move up", () => onMove(-1), "alt+arrowup")}
            {pinned && onMove && item("row-menu-down", <ArrowDown />, "Move down", () => onMove(1), "alt+arrowdown")}
            {onSelect && !archived && item("row-menu-select", <ListChecks />, "Select", onSelect, "space")}
            {beside && item("row-menu-beside", <Columns2 />, "Open beside", onBeside)}
            {onUnread && !archived && item("row-menu-unread", <MailOpen />, "Mark as unread", onUnread)}
            {session && !archived && <MoveTo id={session.id} at={session.folder ?? null} />}
            {item("row-menu-archive", archived ? <ArchiveRestore /> : <Archive />, archived ? "Restore" : "Archive", onArchive)}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// "Move to folder": the owner's folders (a folder's own folders under it), the one it is in checked;
// out of its folder; or a new folder, made with the session in it (named and placed in "By my folders").
function MoveTo({ id, at }: { id: string; at: string | null }) {
  const list = useFolders((x) => x.folders);
  const file = (to: string | null) => { listActed(id); folders.file(id, to).catch(reportError); };
  const made = async () => {
    const names = new Set(list.map((f) => f.name));
    let name = "New folder";
    for (let n = 2; names.has(name); n++) name = `New folder ${n}`;
    const f = await folders.create(name);
    file(f.id);
  };
  const one = (fid: string, name: string, deep: boolean) => (
    <Menu.Item key={fid} className={itemClass} data-testid="row-menu-folder" data-folder={fid} onClick={() => file(fid)}>
      <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5">{fid === at ? <Check /> : null}</span>
      <span className={`min-w-0 flex-1 truncate${deep ? " pl-3" : ""}`}>{name}</span>
    </Menu.Item>
  );
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={itemClass} data-testid="row-menu-move">
        <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5"><FolderInput /></span>
        <span className="min-w-0 flex-1 truncate">Move to folder</span>
        <ChevronRight className="size-3.5 shrink-0 text-faint" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="right" align="start" sideOffset={2} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} min-w-44 max-w-72`} data-testid="row-menu-folders" data-press-on={id} onClick={(e) => e.stopPropagation()}>
            {tree(list).flatMap(({ folder, kids }) => [one(folder.id, folder.name, false), ...kids.map((k) => one(k.id, k.name, true))])}
            {list.length > 0 && <Menu.Separator className="mx-1 my-1 h-px bg-line" />}
            {at && (
              <Menu.Item className={itemClass} data-testid="row-menu-unfile" onClick={() => file(null)}>
                <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5"><FolderMinus /></span>
                <span className="min-w-0 flex-1 truncate">Out of its folder</span>
              </Menu.Item>
            )}
            <Menu.Item className={itemClass} data-testid="row-menu-new-folder" onClick={() => void made().catch(reportError)}>
              <span className="grid w-3.5 shrink-0 place-items-center [&>svg]:size-3.5"><FolderPlus /></span>
              <span className="min-w-0 flex-1 truncate">New folder</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
