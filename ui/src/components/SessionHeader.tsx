import { copyOrSay } from "../lib/copy.ts";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Archive, ArchiveRestore, ChevronDown, Copy, Ellipsis, Folder, FolderPlus, GitBranch, Link2, Menu as MenuIcon, Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { Session } from "../../../src/core/types.ts";
import { headerActions } from "../lib/extend.ts";
import { composing } from "../lib/keys.ts";
import { actions, getState, reportError } from "../lib/store.ts";
import { navigate, phone, savePref, useUI } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { archive } from "../lib/sessops.ts";
import { BackgroundButton, useBackgroundLive } from "./automation/BackgroundPopover.tsx";
import { SessionSnoozeButton } from "./automation/Snooze.tsx";
import { PanelHand, PanelsButton } from "./SidePanel.tsx";
import { MachineChip } from "./Fleet.tsx";
import { iconButton, itemClass, popupClass } from "./ui.tsx";

// Popovers of the header load after the page (their Base UI parts are large).
const PermissionMenu = lazy(() => import("./PermissionMenu.tsx").then((m) => ({ default: m.PermissionMenu })));
const WorktreeChip = lazy(() => import("./WorktreeChip.tsx").then((m) => ({ default: m.WorktreeChip })));

export function SidebarButton() {
  const sidebar = useUI((s) => s.sidebar);
  // Desktop has the rail; a phone opens the list from here.
  if (sidebar || !phone()) return null;
  return (
    <button type="button" aria-label="Show the sidebar" title="Show the sidebar (Ctrl B)" data-testid="show-sidebar" onClick={() => savePref("sidebar", true)} className={iconButton}>
      <MenuIcon className="size-4" />
    </button>
  );
}

// The toolbar holds what fits. Session actions and the Panels chooser never
// leave it. The token counts and the panel shortcuts give way first (the turn
// footer has the counts, the chooser every panel). After them the tools of the
// session move, lowest rank first, into the More menu: the same controls as a
// labeled list. Nothing scrolls out of sight.
type Tool = { id: string; label: string; rank: number; node: ReactNode; item?: (close: () => void) => ReactNode };
const GIVE_WAY = ["usage", "hand"];
const TITLE_ROOM = 11; // rem the title's field keeps while it is renamed

function useFit(tools: Tool[], reserve: number) {
  const head = useRef<HTMLElement>(null);
  const list = useRef<HTMLElement | null>(null); // the More menu's rows, while it has any
  const widths = useRef<Record<string, number>>({});
  // A folded tool is measured in the list, where it may be styled a little
  // differently: its row width is the one it folded at, moved by what it gained or lost since.
  const folded = useRef<Record<string, { row: number; list: number }>>({});
  const more = useRef(0);
  const [out, setOut] = useState<string[]>([]);
  const fit = useRef(() => {});
  fit.current = () => {
    const el = head.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    let room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - reserve * root + gap;
    // What stays whatever happens, and what each tool in the row measures now.
    const measure = (c: HTMLElement) => {
      const w = Math.ceil(c.getBoundingClientRect().width);
      if (c.dataset.tool) { widths.current[c.dataset.tool] = w; delete folded.current[c.dataset.tool]; }
      else if (c.dataset.tools !== undefined) { room -= gap; for (const t of c.children as Iterable<HTMLElement>) measure(t); }
      else if (c.dataset.more !== undefined) more.current = w || more.current;
      else if (c.dataset.flex !== undefined) room -= gap + Math.ceil(parseFloat(getComputedStyle(c).paddingLeft) + parseFloat(getComputedStyle(c).paddingRight));
      else if (w && getComputedStyle(c).position !== "absolute") room -= w + gap;
    };
    for (const c of el.children as Iterable<HTMLElement>) measure(c);
    // The folded ones: a closed menu is laid out for the reading and put back before anything paints.
    const empty = new Set<string>();
    const pos = list.current?.closest<HTMLElement>("[data-stow]");
    if (list.current && pos) {
      const shut = pos.hidden, style = pos.style.cssText;
      if (shut) { pos.hidden = false; pos.style.cssText = `${style};position:fixed;visibility:hidden`; }
      for (const r of list.current.querySelectorAll<HTMLElement>(".k-stow-row")) {
        // The control is the widest thing in its slot (an open popup adds focus guards beside it).
        const id = r.dataset.tool!, parts = [...r.querySelectorAll<HTMLElement>(".k-stow-slot > *")];
        if (!parts.length) { empty.add(id); continue; }
        const w = Math.max(...parts.map((c) => c.offsetWidth));
        if (!w) continue;
        const at = (folded.current[id] ??= { row: widths.current[id] || w, list: w });
        widths.current[id] = Math.max(1, at.row + w - at.list);
      }
      if (shut) { pos.hidden = true; pos.style.cssText = style; }
    }
    const cost = (id: string) => { const w = empty.has(id) ? 0 : widths.current[id] ?? 0; return w ? w + gap : 0; };
    const sum = (ids: string[]) => ids.reduce((n, id) => n + cost(id), 0);
    const ranked = [...tools].sort((a, b) => b.rank - a.rank).map((t) => t.id);
    const next: string[] = [];
    for (let i = 0; i <= GIVE_WAY.length && sum([...GIVE_WAY.slice(i), ...ranked]) > room; i++) {
      if (i < GIVE_WAY.length) { next.push(GIVE_WAY[i]!); continue; }
      // Still too many: the row keeps the highest ranks beside the More button
      // and stops at the first that does not fit, so nothing folded outranks one that stayed.
      // A folded tool with nothing to show stays where it is and costs nothing.
      let left = room - (more.current || 5 * root) - gap;
      let full = false;
      for (const id of ranked) {
        const c = cost(id);
        if (empty.has(id) || (c && (full || c > left))) { full ||= !empty.has(id); next.push(id); } else left -= c;
      }
    }
    setOut((prev) => (prev.join() === next.join() ? prev : next));
  };
  // Every render measures before paint. A resize of the row or of a tool, or a
  // change in a folded one, measures again on the next frame (not inside the
  // observer's own delivery, which may not change what it observes).
  const ro = useRef<ResizeObserver | null>(null);
  const frame = useRef(0);
  const later = useRef(() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => fit.current()); }).current;
  const watch = () => {
    if (head.current && ro.current) for (const c of [head.current, ...head.current.children, ...head.current.querySelectorAll("[data-tools] > *")]) ro.current.observe(c);
  };
  useLayoutEffect(() => { fit.current(); watch(); });
  useEffect(() => {
    ro.current = new ResizeObserver(later);
    watch();
    return () => { cancelAnimationFrame(frame.current); ro.current?.disconnect(); };
  }, []);
  return { head, list, out, later };
}

// The tools the row has no room for, as a labeled list behind one button.
// They stay mounted while it is closed, so the button knows how many of them
// the session has now (a tool with nothing to show takes no row).
function MoreTools({ tools, live, list, changed }: { tools: Tool[]; live: boolean; list: { current: HTMLElement | null }; changed: () => void }) {
  const [open, setOpen] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [n, setN] = useState(tools.length);
  useEffect(() => {
    list.current = el;
    if (!el) return;
    const read = () => { setN(el.querySelectorAll(".k-stow-slot:not(:empty), .k-stow-item").length); changed(); };
    read();
    const mo = new MutationObserver((recs) => {
      // A folded control opened from elsewhere (a command, a shortcut) shows in its place: the menu opens with it.
      if (recs.some((r) => r.type === "attributes" && (r.target as Element).hasAttribute("data-popup-open") && (r.target as Element).closest(".k-stow-slot"))) setOpen(true);
      read();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-popup-open"] });
    return () => { mo.disconnect(); list.current = null; };
  }, [el]);
  // A press anywhere on a row reaches its control. A press inside the control,
  // or in a popup it opened (React hands those up through the portal), is the control's own.
  const reach = (e: MouseEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest(".k-stow-slot")) return;
    e.currentTarget.querySelector<HTMLElement>(".k-stow-slot button")?.click();
  };
  return (
    <Popover.Root open={open && n > 0} onOpenChange={setOpen}>
      <Popover.Trigger data-more="" hidden={!n} aria-label={`${n} more actions`} title="More actions" data-testid="header-more-button" className="k-head-more">
        {live && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" data-testid="more-live" />}{n} more<ChevronDown />
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner data-stow="" sideOffset={6} align="end" className="z-50 outline-none">
          <Popover.Popup className="k-stow" data-testid="header-more" aria-label="More actions">
            <div ref={setEl}>
              {tools.map((t) => t.item ? <div key={t.id} className="k-stow-act">{t.item(() => setOpen(false))}</div> : (
                <div key={t.id} className="k-stow-row" role="group" aria-label={t.label} data-tool={t.id} onClick={reach}>
                  <span className="k-stow-label">{t.label}</span>
                  <span className="k-stow-slot">{t.node}</span>
                </div>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SessionHeader({ session }: { session: Session }) {
  const menuButton = useRef<HTMLButtonElement>(null); // where a menu item's failed copy is said
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);
  const input = useRef<HTMLInputElement>(null);
  useSyncExternalStore(headerActions.subscribe, headerActions.version);
  useEffect(() => setTitle(session.title), [session.title]);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const save = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== session.title) actions.patch(session.id, { title: t }).catch(reportError);
    else setTitle(session.title);
  };
  const u = session.usage;
  const input_ = u.input + u.cache_read + u.cache_write;
  const cached = input_ ? Math.round((100 * u.cache_read) / input_) : 0;
  const folder = session.workspace.split("/").pop();

  // In the row's order; the rank says which stays longest when the row is short.
  const tools: Tool[] = [
    { id: "machine", label: "Runs on", rank: 4, node: <MachineChip session={session} /> },
    { id: "background", label: "Background", rank: 3, node: <BackgroundButton sessionId={session.id} /> },
    { id: "worktree", label: "Worktree", rank: 5, node: <Suspense fallback={null}><WorktreeChip session={session} /></Suspense> },
    { id: "permissions", label: "Permissions", rank: 6, node: <Suspense fallback={null}><PermissionMenu sessionId={session.id} /></Suspense> },
    ...(session.parent_id ? [] : [{ id: "snooze", label: "Snooze", rank: 2, node: <SessionSnoozeButton sessionId={session.id} /> }]),
    ...headerActions.all().filter((a) => !a.when || a.when(session)).map((a) => ({
      id: `action:${a.id}`,
      label: a.label,
      rank: 1,
      node: <button type="button" title={a.label} aria-label={a.label} data-testid={`header-action-${a.id}`} onClick={() => a.run(session)} className={iconButton}>{a.icon}</button>,
      item: (close: () => void) => <button type="button" data-testid={`header-action-${a.id}`} onClick={() => { close(); a.run(session); }} className="k-stow-item">{a.label}</button>,
    })),
  ];
  const { head, list, out, later } = useFit(tools, editing ? TITLE_ROOM : 0);
  const folded = tools.filter((t) => out.includes(t.id));
  const live = useBackgroundLive(session.id) > 0 && out.includes("background");

  return (
    <header ref={head} className="k-session-header relative flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-bg/85 px-2 backdrop-blur-md md:px-4" data-testid="session-header">
      <SidebarButton />
      <div data-flex="" className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
        {editing ? (
          <input
            ref={input}
            value={title}
            aria-label="Session title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter") save(); if (e.key === "Escape") { setTitle(session.title); setEditing(false); } }}
            className="h-8 min-w-0 flex-1 rounded-sm bg-sunken px-2 text-base font-medium outline-none ring-2 ring-ring"
          />
        ) : (
          <h1
            className="k-session-title min-w-0 truncate rounded-sm px-1 text-base font-medium hover:bg-hover"
            data-testid="session-title"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
          >
            {session.title || "New session"}
          </h1>
        )}
        {!editing && (
          <button
            type="button"
            title={`${session.workspace}\nClick to copy the path`}
            onClick={(e) => void copyOrSay(session.workspace, e.currentTarget)}
            className="k-head-folder hidden h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption text-faint hover:bg-hover hover:text-muted sm:inline-flex"
          >
            <Folder className="size-3.5" />
            {folder}
          </button>
        )}
      </div>
      <div data-tools="" className="k-head-tools">
      {input_ + u.output > 0 && !out.includes("usage") && <span
        data-tool="usage"
        className="k-session-usage hidden shrink-0 px-2 text-caption tabular-nums text-faint md:inline"
        title={`Input ${input_.toLocaleString()} tokens (${u.cache_read.toLocaleString()} read from cache), output ${u.output.toLocaleString()}`}
        data-testid="session-usage"
      >
        {fmtTokens(input_)} in <span className="text-faint">/</span> {fmtTokens(u.output)} out{cached ? <span className="ml-1.5 text-ok">{cached}% cached</span> : null}{u.cost !== undefined ? <span className="ml-1.5" data-testid="session-cost">${u.cost.toFixed(u.cost < 1 ? 4 : 2)}</span> : null}
      </span>}
      {tools.filter((t) => !out.includes(t.id)).map((t) => <span key={t.id} data-tool={t.id} className="k-head-tool">{t.node}</span>)}
      </div>
      {folded.length > 0 && <MoreTools tools={folded} live={live} list={list} changed={later} />}
      {!out.includes("hand") && <span data-tool="hand" className="k-head-tool"><PanelHand session={session} /></span>}
      <PanelsButton session={session} />
      <Menu.Root>
        <Menu.Trigger ref={menuButton} aria-label="Session actions" data-testid="session-menu" className={iconButton}>
          <Ellipsis className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
            <Menu.Popup className={cn(popupClass, "min-w-52")}>
              <Menu.Item className={itemClass} data-testid="menu-rename" onClick={() => setEditing(true)}><Pencil /> Rename</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => void copyOrSay(location.href, menuButton.current)}><Link2 /> Copy link</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => void copyOrSay(session.workspace, menuButton.current)}><Copy /> Copy folder path</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => { savePref("newWorkspace", session.workspace); navigate({ name: "new" }); }}><FolderPlus /> New session here</Menu.Item>
              <Menu.Separator className="mx-1 my-1 h-px bg-line" />
              <Menu.Item
                className={itemClass}
                data-testid="menu-fork"
                disabled={!session.head}
                onClick={() => session.head && actions.fork(session.id, session.head).then((f) => navigate({ name: "session", id: f.id }), reportError)}
              >
                <GitBranch /> Fork
              </Menu.Item>
              <Menu.Separator className="mx-1 my-1 h-px bg-line" />
              {session.archived ? (
                <Menu.Item className={itemClass} data-testid="menu-restore" onClick={() => actions.patch(session.id, { archived: false }).catch(reportError)}><ArchiveRestore /> Restore</Menu.Item>
              ) : (
                <Menu.Item className={itemClass} data-testid="menu-archive" onClick={() => archive(session).catch(reportError)}><Archive /> Archive</Menu.Item>
              )}
              <Menu.Item
                className={cn(itemClass, "text-danger [&>svg]:text-danger")}
                data-testid="menu-delete"
                onClick={async () => {
                  // Its subagents' sessions go with it: the dialog says how many before anything is removed.
                  const all = Object.values(getState().sessions);
                  const below = (id: string): number => all.filter((x) => x.parent_id === id).reduce((n, x) => n + 1 + below(x.id), 0);
                  const kids = below(session.id);
                  const ok = await confirmAction({ title: "Delete this session?", body: `"${session.title || "New session"}" and its whole history are removed${kids ? `, with the sessions of its ${kids === 1 ? "subagent" : `${kids} subagents`}` : ""}. This cannot be undone; Archive keeps it.`, action: "Delete", danger: true });
                  if (ok) { actions.remove(session.id).catch(reportError); navigate({ name: "new" }); }
                }}
              >
                <Trash2 /> Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {session.phase === "working" && <div className="k-wake-line" aria-hidden="true" data-testid="wake-line" />}
    </header>
  );
}
