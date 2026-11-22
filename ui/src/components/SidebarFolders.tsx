// The session list by the owner's own folders: their folders in their order, each
// folded or open, a level of folders inside a top one, then the sessions in
// none. A session dragged onto a folder's head is filed there; a folder
// dragged onto another's head goes before it, or into it from the lower half
// of a top folder's head. Double-click a name to rename it.
import { ChevronRight, Folder, FolderPlus, Plus, Trash2 } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type DragEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { folders, tree, useFolders, type SessionFolder } from "../lib/folders.ts";
import { actedOn, actedRev, listActed, useActed } from "../lib/list-hold.ts";
import { useWatches, type Watch } from "../lib/watch.ts";
import { Mark } from "./Mark.tsx";
import { composing } from "../lib/keys.ts";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { DRAG } from "./Panes.tsx";
import { Group, useListHeld } from "./Sidebar.tsx";

const FOLDER = "application/x-keel-folder";

// What this page does to the folders itself (fold, rename, move, make, delete) shows as soon as
// it has landed, also in a list held still under the hand; what another device does to them
// waits for the hand to leave, like the rows.
let landed = 0;
const landSubs = new Set<() => void>();
const mine = <T,>(act: Promise<T>): Promise<T> => act.finally(() => { landed++; landSubs.forEach((f) => f()); });
// The folders the owner folded by their heads, each with the owner's last act on the list when they did.
const foldedAt = new Map<string, number>();
const useLanded = () => useSyncExternalStore((f) => (landSubs.add(f), () => landSubs.delete(f)), () => landed);
// Quiet until the head is hovered or holds the keyboard; shown from the start where nothing hovers.
const headAct = "grid size-6 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:bg-hover hover:text-fg group-hover/head:opacity-100 group-focus-within/head:opacity-100 focus-visible:opacity-100 touch:size-7 touch:opacity-100";

// `calls`: the folder is folded over a session that needs the owner or failed: its head says so.
function Head({ f, n, nested, canNest, calls }: { f: SessionFolder; n: number; nested: boolean; canNest: boolean; calls?: Watch }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(f.name);
  const [over, setOver] = useState<"" | "session" | "before" | "into">("");
  const zone = (e: DragEvent<HTMLElement>): typeof over => {
    if (e.dataTransfer.types.includes(DRAG)) return "session";
    if (!e.dataTransfer.types.includes(FOLDER)) return "";
    const r = e.currentTarget.getBoundingClientRect();
    return !nested && canNest && e.clientY > r.top + r.height / 2 ? "into" : "before";
  };
  const done = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== f.name) mine(folders.rename(f.id, name.trim())).catch(reportError);
    else setName(f.name);
  };
  return (
    <h2
      className={cn("k-group-head group/head relative rounded-sm", nested && "pl-5", (over === "session" || over === "into") && "bg-accent-soft text-accent-ink")}
      data-testid="folder-head"
      data-folder={f.id}
      draggable={!editing}
      onDragStart={(e) => { e.dataTransfer.setData(FOLDER, f.id); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { const z = zone(e); if (z) { e.preventDefault(); setOver(z); } }}
      onDragLeave={() => setOver("")}
      onDrop={(e) => {
        const z = zone(e);
        setOver("");
        if (!z) return;
        e.preventDefault();
        if (z === "session") { const sid = e.dataTransfer.getData(DRAG); listActed(sid); return void folders.file(sid, f.id).catch(reportError); }
        const id = e.dataTransfer.getData(FOLDER);
        if (id && id !== f.id) mine(folders.place(id, f, z === "into")).catch(reportError);
      }}
    >
      {over === "before" && <span aria-hidden="true" className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
      <button type="button" className="grid size-4 place-items-center" aria-label={f.collapsed ? `Open ${f.name}` : `Fold ${f.name}`} aria-expanded={!f.collapsed} data-testid="folder-toggle" onClick={() => { if (f.collapsed) foldedAt.delete(f.id); else foldedAt.set(f.id, actedRev()); mine(folders.collapse(f.id, !f.collapsed)).catch(reportError); }}>
        <ChevronRight className={cn("transition-transform", !f.collapsed && "rotate-90")} />
      </button>
      <Folder />
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter") done(); if (e.key === "Escape") { setName(f.name); setEditing(false); } }}
          aria-label="Folder name"
          data-testid="folder-rename"
          className="h-6 min-w-0 flex-1 rounded-sm bg-sunken px-1 text-fg outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <span className="min-w-0 truncate" onDoubleClick={() => setEditing(true)} title="Double-click to rename">{f.name}</span>
      )}
      <span className="tabular-nums text-faint">{n || ""}</span>
      {calls && <Mark w={calls} className="k-head-calls" />}
      <span className="ml-auto flex items-center">
        {!nested && <button type="button" className={headAct} aria-label={`New folder in ${f.name}`} title="New folder inside" onClick={() => mine(folders.create("New folder", f.id)).catch(reportError)}><FolderPlus /></button>}
        <button
          type="button"
          className={headAct}
          aria-label={`Delete ${f.name}`}
          title="Delete the folder (its sessions stay)"
          data-testid="folder-delete"
          onClick={async () => { if (await confirmAction({ title: `Delete the folder ${f.name}?`, body: "Its sessions stay in the list, unfiled; its folders move up a level.", action: "Delete folder", danger: true })) mine(folders.remove(f.id)).catch(reportError); }}
        ><Trash2 /></button>
      </span>
    </h2>
  );
}

export function FolderGroups({ list, cmp, current, every }: { list: Session[]; cmp: (a: Session, b: Session) => number; current: string | null; every: boolean }) {
  // The folders as the list was drawn from them when the hand arrived: a fold, a name or a
  // place changed on another device moves no row under the hand.
  const live = useFolders((s) => s.folders);
  const held = useListHeld();
  const own = useLanded();
  const snap = useRef({ own, all: live });
  if (!held || snap.current.own !== own) snap.current = { own, all: live };
  const all = snap.current.all;
  const by = new Map<string, Session[]>();
  for (const s of list) {
    const k = s.settings.folder_id && all.some((f) => f.id === s.settings.folder_id) ? s.settings.folder_id : "";
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  const of = (id: string) => (by.get(id) ?? []).sort(cmp);
  const loose = of("");
  // A folded folder opens for a session the owner went to (a count above the list), and folds
  // again when they have left the list: what they chose for the folder is not changed.
  // A folder the owner folded after that stays folded: the fold is what they did last (a session
  // dragged into a folder, then its head pressed to fold it). A later act in it opens it again.
  const rev = useActed();
  const went = (f: SessionFolder) => foldedAt.get(f.id) !== rev && of(f.id).some((s) => actedOn(s.id));
  // What a folded head says of the sessions it hides, as they are now: needs the owner, else failed.
  const watches = useWatches(list);
  const calls = (ss: Session[]): Watch | undefined => (ss.some((s) => watches[s.id] === "need") ? "need" : ss.some((s) => watches[s.id] === "fail" || watches[s.id] === "declined") ? "fail" : undefined);
  // A filter shows only the folders with a match, open.
  const show = (f: SessionFolder, kids: SessionFolder[] = []) => !every || of(f.id).length > 0 || kids.some((k) => of(k.id).length > 0);
  return (
    <>
      {tree(all).map(({ folder: f, kids }) => {
        if (!show(f, kids)) return null;
        const count = of(f.id).length + kids.reduce((n, k) => n + of(k.id).length, 0);
        // (A fold of the folder itself stands over what was done in the folders it holds too.)
        const open = every || !f.collapsed || went(f) || (foldedAt.get(f.id) !== rev && kids.some(went));
        return (
          <section key={f.id} className="k-group" data-testid="folder-group" data-folder={f.id}>
            <Head f={f} n={count} nested={false} canNest={true} calls={open ? undefined : calls([...of(f.id), ...kids.flatMap((k) => of(k.id))])} />
            {open && (
              <>
                {kids.filter((k) => show(k)).map((k) => (
                  <div key={k.id} data-testid="folder-group" data-folder={k.id}>
                    <Head f={k} n={of(k.id).length} nested canNest={false} calls={every || !k.collapsed || went(k) ? undefined : calls(of(k.id))} />
                    {(every || !k.collapsed || went(k)) && of(k.id).length > 0 && <div className="pl-3"><Group list={of(k.id)} current={current} every={every} where /></div>}
                  </div>
                ))}
                {of(f.id).length > 0 ? <Group list={of(f.id)} current={current} every={every} where /> : !kids.length && <p className="px-2 pb-1 text-caption text-faint">Drag sessions here</p>}
              </>
            )}
          </section>
        );
      })}
      {loose.length > 0 && (
        <section className="k-group" data-testid="folder-group" data-folder="none">
          <UnfiledHead n={loose.length} />
          <Group list={loose} current={current} every={every} where />
        </section>
      )}
      <button type="button" className="k-more flex items-center gap-1.5" data-testid="folder-create" onClick={() => mine(folders.create(`Folder ${all.length + 1}`)).catch(reportError)}><Plus className="size-3.5" />New folder</button>
    </>
  );
}

// Sessions in no folder; a session dropped here leaves its folder.
function UnfiledHead({ n }: { n: number }) {
  const [over, setOver] = useState(false);
  return (
    <h2
      className={cn("k-group-head rounded-sm", over && "bg-accent-soft text-accent-ink")}
      data-testid="folder-head"
      data-folder="none"
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); const id = e.dataTransfer.getData(DRAG); if (id) { e.preventDefault(); listActed(id); folders.file(id, null).catch(reportError); } }}
    >
      <span className="truncate">Unfiled</span>
      <span className="tabular-nums text-faint">{n}</span>
    </h2>
  );
}
