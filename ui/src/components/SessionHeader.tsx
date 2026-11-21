import { copyText } from "../lib/copy.ts";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { Archive, ArchiveRestore, ChevronDown, Copy, Ellipsis, Folder, FolderPlus, GitBranch, Link2, Menu as MenuIcon, Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { Session } from "../../../src/core/types.ts";
import { headerActions } from "../lib/extend.ts";
import { actions, getState, reportError } from "../lib/store.ts";
import { navigate, phone, savePref, useUI } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { archive } from "../lib/sessops.ts";
import { BackgroundButton } from "./automation/BackgroundPopover.tsx";
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
  const widths = useRef<Record<string, number>>({});
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
    for (const c of el.children as Iterable<HTMLElement>) {
      const w = Math.ceil(c.getBoundingClientRect().width);
      if (c.dataset.tool) widths.current[c.dataset.tool] = w;
      else if (c.dataset.more !== undefined) more.current = w || more.current;
      else if (c.dataset.flex !== undefined) room -= gap + Math.ceil(parseFloat(getComputedStyle(c).paddingLeft) + parseFloat(getComputedStyle(c).paddingRight));
      else if (w && getComputedStyle(c).position !== "absolute") room -= w + gap;
    }
    const cost = (id: string) => { const w = widths.current[id] ?? 0; return w ? w + gap : 0; };
    const sum = (ids: string[]) => ids.reduce((n, id) => n + cost(id), 0);
    const ranked = [...tools].sort((a, b) => b.rank - a.rank).map((t) => t.id);
    const next: string[] = [];
    for (let i = 0; i <= GIVE_WAY.length && sum([...GIVE_WAY.slice(i), ...ranked]) > room; i++) {
      if (i < GIVE_WAY.length) { next.push(GIVE_WAY[i]!); continue; }
      // Still too many: the highest ranks that fit beside the More button stay.
      let left = room - (more.current || 5 * root) - gap;
      for (const id of ranked) { const c = cost(id); if (!c || c <= left) left -= c; else next.push(id); }
    }
    setOut((prev) => (prev.join() === next.join() ? prev : next));
  };
  // Every render measures before paint. A resize of the row or of a tool
  // measures again on the next frame (not inside the observer's own delivery,
  // which may not change what it observes).
  const ro = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    fit.current();
    if (head.current && ro.current) for (const c of [head.current, ...head.current.children]) ro.current.observe(c);
  });
  useEffect(() => {
    let frame = 0;
    const o = (ro.current = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fit.current()); }));
    if (head.current) for (const c of [head.current, ...head.current.children]) o.observe(c);
    return () => { cancelAnimationFrame(frame); o.disconnect(); };
  }, []);
  return { head, out };
}

// The tools the row has no room for, as a labeled list behind one button.
// They stay mounted while it is closed, so the button knows how many of them
// the session has now (a tool with nothing to show takes no row).
function MoreTools({ tools }: { tools: Tool[] }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const [n, setN] = useState(tools.length);
  useEffect(() => {
    if (!list) return;
    const count = () => setN(list.querySelectorAll(".k-stow-slot:not(:empty), .k-stow-item").length);
    count();
    const mo = new MutationObserver(count);
    mo.observe(list, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [list]);
  // A press anywhere on a row reaches its control.
  const reach = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest(".k-stow-slot")) return;
    e.currentTarget.querySelector<HTMLElement>(".k-stow-slot button")?.click();
  };
  return (
    <Popover.Root open={open && n > 0} onOpenChange={setOpen}>
      <Popover.Trigger data-more="" hidden={!n} aria-label="More actions" title="More actions" data-testid="header-more-button" className="k-head-more">
        {n} more<ChevronDown />
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Popover.Popup className="k-stow" data-testid="header-more" aria-label="More actions">
            <div ref={setList}>
              {tools.map((t) => t.item ? <div key={t.id} className="k-stow-act">{t.item(() => setOpen(false))}</div> : (
                <div key={t.id} className="k-stow-row" onClick={reach}>
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
    { id: "background", label: "Background work", rank: 3, node: <BackgroundButton sessionId={session.id} /> },
    { id: "worktree", label: "Worktree", rank: 5, node: <Suspense fallback={null}><WorktreeChip session={session} /></Suspense> },
    { id: "permissions", label: "Permissions", rank: 6, node: <Suspense fallback={null}><PermissionMenu sessionId={session.id} /></Suspense> },
    ...(session.parent_id ? [] : [{ id: "snooze", label: "Snooze", rank: 2, node: <SessionSnoozeButton sessionId={session.id} /> }]),
    ...headerActions.all().filter((a) => !a.when || a.when(session)).map((a) => ({
      id: `action:${a.id}`,
      label: a.label,
      rank: 1,
      node: <button type="button" title={a.label} aria-label={a.label} data-testid={`header-action-${a.id}`} onClick={() => a.run(session)} className={iconButton}>{a.icon}</button>,
      item: (close: () => void) => <button type="button" data-testid={`header-action-${a.id}`} onClick={() => { close(); a.run(session); }} className="k-stow-item">{a.icon}<span>{a.label}</span></button>,
    })),
  ];
  const { head, out } = useFit(tools, editing ? TITLE_ROOM : 0);
  const folded = tools.filter((t) => out.includes(t.id));

  return (
    <header ref={head} className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-bg/85 px-2 backdrop-blur-md md:px-4" data-testid="session-header">
      <SidebarButton />
      <div data-flex="" className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
        {editing ? (
          <input
            ref={input}
            value={title}
            aria-label="Session title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { setTitle(session.title); setEditing(false); } }}
            className="h-8 min-w-0 flex-1 rounded-sm bg-sunken px-2 text-base font-medium outline-none ring-2 ring-ring"
          />
        ) : (
          <h1
            className="min-w-0 truncate rounded-sm px-1 text-base font-medium hover:bg-hover"
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
            onClick={() => copyText(session.workspace)}
            className="hidden h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption text-faint hover:bg-hover hover:text-muted sm:inline-flex"
          >
            <Folder className="size-3.5" />
            {folder}
          </button>
        )}
      </div>
      {input_ + u.output > 0 && !out.includes("usage") && <span
        data-tool="usage"
        className="hidden shrink-0 px-2 text-caption tabular-nums text-faint md:inline"
        title={`Input ${input_.toLocaleString()} tokens (${u.cache_read.toLocaleString()} read from cache), output ${u.output.toLocaleString()}`}
        data-testid="session-usage"
      >
        {fmtTokens(input_)} in <span className="text-line-strong">/</span> {fmtTokens(u.output)} out{cached ? <span className="ml-1.5 text-ok">{cached}% cached</span> : null}{u.cost !== undefined ? <span className="ml-1.5" data-testid="session-cost">${u.cost.toFixed(u.cost < 1 ? 4 : 2)}</span> : null}
      </span>}
      {tools.filter((t) => !out.includes(t.id)).map((t) => <span key={t.id} data-tool={t.id} className="k-head-tool">{t.node}</span>)}
      {folded.length > 0 && <MoreTools tools={folded} />}
      {!out.includes("hand") && <span data-tool="hand" className="k-head-tool"><PanelHand session={session} /></span>}
      <PanelsButton session={session} />
      <Menu.Root>
        <Menu.Trigger aria-label="Session actions" data-testid="session-menu" className={iconButton}>
          <Ellipsis className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
            <Menu.Popup className={cn(popupClass, "min-w-52")}>
              <Menu.Item className={itemClass} data-testid="menu-rename" onClick={() => setEditing(true)}><Pencil /> Rename</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => copyText(location.href)}><Link2 /> Copy link</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => copyText(session.workspace)}><Copy /> Copy folder path</Menu.Item>
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
