import { copyOrSay } from "../lib/copy.ts";
import { Popover } from "@base-ui/react/popover";
import { Archive, ArchiveRestore, Copy, Ellipsis, Folder, FolderPlus, GitBranch, Link2, MailOpen, Menu as MenuIcon, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { Fragment, lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { Session } from "../../../src/core/types.ts";
import { headerActions } from "../lib/extend.ts";
import { composing, runCommand } from "../lib/keys.ts";
import { actions, getState, reportError } from "../lib/store.ts";
import { navigate, phone, savePref, useUI } from "../lib/ui.ts";
import { openPlaced } from "../lib/looks.ts";
import { useStations } from "../lib/stations.ts";
import { cn, fmtSessionCost, fmtTokens } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { archive, isPinned } from "../lib/sessops.ts";
import { auto } from "../lib/automation.ts";
import { BackgroundButton, useBackgroundLive } from "./automation/BackgroundPopover.tsx";
import { SessionSnoozeButton } from "./automation/Snooze.tsx";
import { openPanel, PanelsButton } from "./SidePanel.tsx";
import { MachineChip } from "./Fleet.tsx";
import { CapControl } from "./CapControl.tsx";
import { useCap } from "../lib/caps.ts";
import { iconButton } from "./ui.tsx";

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

// The toolbar rests with what the owner reads or reaches every few minutes: the permission mode (a
// safety state), the worktree a session has (where its edits land), the Panels chooser and the session's
// one menu. Everything else is in that menu, as the same controls in labeled rows over the session's
// actions: the cost, background work (a dot on the menu while it runs; the head says what runs), the
// machine (the head names another machine), snooze and the actions of features. A resting tool that has
// no room folds there too, lowest rank first. Nothing scrolls out of sight, and nothing in the row
// comes or goes with a turn, so the head beside it keeps its form.
type Tool = { id: string; label: string; rank: number; rest?: boolean; node: ReactNode; item?: (close: () => void) => ReactNode };
const TITLE_ROOM = 11; // rem the title's field keeps while it is renamed
const ROW_TOOLS = 3; // the tools the row shows at most; the rest are in More
// In the pane's one top bar the row is as wide as what it shows, and folds within this share of the
// bar, at most TOOLS_MAX rem (bridge.css gives the row the same max-width): the head takes the rest.
const TOOLS_SHARE = 0.5, TOOLS_MAX = 44;

function useFit(tools: Tool[], reserve: number) {
  const head = useRef<HTMLElement>(null);
  const list = useRef<HTMLElement | null>(null); // the More menu's rows, while it has any
  const widths = useRef<Record<string, number>>({});
  // A folded tool is measured in the list, where it may be styled a little
  // differently: its row width is the one it folded at, moved by what it gained or lost since.
  const folded = useRef<Record<string, { row: number; list: number }>>({});
  const [out, setOut] = useState<string[]>([]);
  const fit = useRef(() => {});
  fit.current = () => {
    const el = head.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const gap = parseFloat(cs.columnGap) || 0;
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const bar = el.parentElement;
    const inBar = !!bar?.classList.contains("k-top-in") && getComputedStyle(bar).flexDirection === "row";
    const width = inBar ? Math.min(TOOLS_MAX * root, bar!.clientWidth * TOOLS_SHARE) : el.clientWidth;
    let room = width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - reserve * root + gap;
    // What stays whatever happens, and what each tool in the row measures now.
    const measure = (c: HTMLElement) => {
      const w = Math.ceil(c.getBoundingClientRect().width);
      if (c.dataset.tool) { widths.current[c.dataset.tool] = w; delete folded.current[c.dataset.tool]; }
      else if (c.dataset.tools !== undefined) { room -= gap; for (const t of c.children as Iterable<HTMLElement>) measure(t); }
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
    // What has no resting place is in the menu whatever the room.
    const next: string[] = tools.filter((t) => !t.rest).map((t) => t.id);
    const ranked = tools.filter((t) => t.rest).sort((a, b) => b.rank - a.rank).map((t) => t.id);
    if (sum(ranked) > room) {
      // Too many: the row keeps the highest ranks beside the menu and stops at the first that does
      // not fit, so nothing folded outranks one that stayed. One with nothing to show costs nothing.
      let left = room, full = false;
      for (const id of ranked) {
        const c = cost(id);
        if (empty.has(id) || (c && (full || c > left))) { full ||= !empty.has(id); next.push(id); } else left -= c;
      }
    }
    // However wide the row, it keeps the three tools of the highest rank that have something to show:
    // the rest are in More, by name. (A head of nine controls a pane read as noise, and each pane has its own.)
    let kept = 0;
    for (const id of ranked) if (!next.includes(id) && cost(id) > 0 && ++kept > ROW_TOOLS) next.push(id);
    setOut((prev) => (prev.join() === next.join() ? prev : next));
  };
  // Every render measures before paint. A resize of the row or of a tool, or a
  // change in a folded one, measures again on the next frame (not inside the
  // observer's own delivery, which may not change what it observes).
  const ro = useRef<ResizeObserver | null>(null);
  const frame = useRef(0);
  const later = useRef(() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => fit.current()); }).current;
  const watch = () => {
    // (In the bar the row is as wide as its tools: the bar's own width is what gives them room.)
    if (head.current && ro.current) for (const c of [head.current, ...(head.current.parentElement ? [head.current.parentElement] : []), ...head.current.children, ...head.current.querySelectorAll("[data-tools] > *")]) ro.current.observe(c);
  };
  // A render that changed what is in the row (a tool came or went, the title
  // is renamed, tools folded) measures before paint. One that left the row as
  // it was measures nothing: the header renders with every event of its
  // session, and a measure makes the browser lay the page out on the spot. A
  // tool that only changed width is seen by the observer below.
  const shape = useRef("");
  useLayoutEffect(() => {
    const el = head.current;
    const now = `${reserve}|${tools.map((t) => t.id).join()}|${out.join()}|${el ? [...el.children].map((c) => (c as HTMLElement).dataset.tool ?? c.tagName).join() : ""}|${el?.querySelectorAll("[data-tools] > *").length ?? 0}|${list.current?.childElementCount ?? 0}`;
    if (now === shape.current) return;
    shape.current = now;
    fit.current();
    watch();
  });
  useEffect(() => {
    ro.current = new ResizeObserver(later);
    watch();
    return () => { cancelAnimationFrame(frame.current); ro.current?.disconnect(); };
  }, []);
  return { head, list, out, later };
}

// The session's one menu: the tools that rest elsewhere or have no room, as a labeled list of the
// same controls, over the session's actions. The tools stay mounted while it is closed, so a folded
// control opened from elsewhere (a command, a shortcut) opens the menu with it, and the row measures
// what they would take back.
type Act = { id: string; label: string; icon: ReactNode; run: () => void; danger?: boolean; disabled?: boolean; gap?: boolean };
function SessionMenu({ tools, live, list, changed, acts, button }: { tools: Tool[]; live: string; list: { current: HTMLElement | null }; changed: () => void; acts: Act[]; button: RefObject<HTMLButtonElement | null> }) {
  const [open, setOpen] = useState(false);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [n, setN] = useState(tools.length);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current = el;
    if (!el) return;
    const read = () => { setN(el.querySelectorAll(".k-stow-slot:not(:empty), .k-stow-item").length); changed(); };
    read();
    const mo = new MutationObserver((recs) => {
      if (recs.some((r) => r.type === "attributes" && (r.target as Element).hasAttribute("data-popup-open") && (r.target as Element).closest(".k-stow-slot"))) setOpen(true);
      read();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-popup-open"] });
    return () => { mo.disconnect(); list.current = null; };
  }, [el]);
  // An action closes the menu and gives the keys back to its button first: what it opens (a dialog, the
  // title's field) is then what the keys go to, and the button is where they come back after.
  const close = () => { button.current?.focus(); setOpen(false); };
  const reach = (e: MouseEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest(".k-stow-slot")) return;
    e.currentTarget.querySelector<HTMLElement>(".k-stow-slot button")?.click();
  };
  // Up and Down walk the actions, as in any menu; Tab walks every control of it.
  const walk = (e: KeyboardEvent<HTMLElement>) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    // Tab past the last action leaves the menu: the keys come back to its button, not out into the page.
    if (e.key === "Tab" && !e.shiftKey && items.length && document.activeElement === items[items.length - 1]) { e.preventDefault(); close(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[i < 0 && e.key === "ArrowUp" ? items.length - 1 : i < 0 && e.key === "ArrowDown" ? 0 : to]!.focus();
  };
  return (
    // Modal, as a menu is: the page under it takes no press while it is open, and a key that closes it is
    // the owner's double press, not a Stop (lib/looks.ts, lib/overlay.ts).
    <Popover.Root open={open} onOpenChange={setOpen} modal>
      <Popover.Trigger ref={button} data-more="" aria-label={live ? `Session actions, ${live}` : "Session actions"} title={live ? `Session actions. ${live}: its list is here` : "Session actions"} data-testid="session-menu" className={cn(iconButton, "relative")}>
        <Ellipsis className="size-4" />
        {live && <span className="k-menu-live" data-testid="more-live" role="img" aria-label={live} title={live} />}
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner data-stow="" sideOffset={6} align="end" className="z-50 outline-none">
          {/* Kept in the page while closed (it measures its rows), it is a dialog only while open: a closed one
              is not a second dialog under the one that is (the shortcut sheet). */}
          {/* Opened by the keys, they go to its first control; by a pointer, to the list itself (no row lights up under nothing). */}
          <Popover.Popup ref={popup} tabIndex={-1} className="k-stow" data-testid="header-more" aria-label="Session actions" role={open ? "dialog" : "none"} finalFocus={button} initialFocus={(how) => (how === "keyboard" ? true : popup.current)}>
            <div ref={setEl} hidden={!n || undefined}>
              {tools.map((t) => t.item ? <div key={t.id} className="k-stow-act">{t.item(close)}</div> : (
                <div key={t.id} className="k-stow-row" role="group" aria-label={t.label} data-tool={t.id} onClick={reach}>
                  <span className="k-stow-label">{t.label}</span>
                  <span className="k-stow-slot">{t.node}</span>
                </div>
              ))}
            </div>
            {/* (A menu only while open: a closed one kept in the page is not a menu over it.) */}
            <div role={open ? "menu" : undefined} aria-label="Actions" className="k-stow-acts" onKeyDown={walk}>
              {acts.map((a) => (
                <Fragment key={a.id}>
                  {a.gap && <div role="separator" className="k-stow-rule" />}
                  <button type="button" role="menuitem" data-testid={a.id} disabled={a.disabled} data-danger={a.danger || undefined}
                    className="k-stow-cmd" onClick={() => { close(); a.run(); }}>
                    {a.icon}{a.label}
                  </button>
                </Fragment>
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
  const tokenWords = `${fmtTokens(input_)} in (${cached}% cached), ${fmtTokens(u.output)} out`;
  const usageId = useId();
  const folder = session.workspace.split("/").pop();
  // A cap that is set rests in the row, below the permission mode (a safety state) and above the worktree; the button that sets one is in the menu.
  const capped = !!useCap(session.id, !!session.settings.cap_usd || !!session.parent_id);

  // In the row's order; the rank says which stays longest when the row is short. `rest`: it has a place in
  // the row (the rest are in the menu, in this order).
  const tools: Tool[] = [
    { id: "permissions", label: "Permissions", rank: 6, rest: true, node: <Suspense fallback={null}><PermissionMenu sessionId={session.id} /></Suspense> },
    { id: "worktree", label: "Worktree", rank: 5, rest: true, node: <Suspense fallback={null}><WorktreeChip session={session} /></Suspense> },
    // What the session cost, one figure; the tokens behind it are in its title and the Usage panel it opens.
    // The title is a tip under the pointer and the keyboard (lib/tips.ts), and steps aside while it shows: the
    // counts are its description too (a hidden line: the button's text stays one figure), so a screen reader
    // says them on focus.
    ...(input_ + u.output > 0 ? [{ id: "usage", label: "Cost", rank: 0, node: <><button
      type="button"
      className="k-session-usage inline-flex h-7 shrink-0 items-center rounded-md px-2 text-caption tabular-nums text-muted hover:bg-hover hover:text-fg"
      title={`${tokenWords}. Open Usage`}
      aria-label={`${u.cost !== undefined ? `Cost ${fmtSessionCost(u.cost)}` : `${fmtTokens(input_ + u.output)} tokens`}. Open Usage`}
      aria-describedby={usageId}
      data-testid="session-usage"
      onClick={() => openPanel("usage")}
    >
      {u.cost !== undefined ? <span data-testid="session-cost">{fmtSessionCost(u.cost)}</span> : `${fmtTokens(input_ + u.output)} tokens`}
    </button><span id={usageId} hidden>{tokenWords}</span></> }] : []),
    { id: "cap", label: "Dollar cap", rank: capped ? 5.5 : 0, rest: capped, node: <CapControl session={session} /> },
    { id: "background", label: "Background", rank: 3, node: <BackgroundButton sessionId={session.id} /> },
    { id: "machine", label: "Runs on", rank: 4, node: <MachineChip session={session} /> },
    ...(session.parent_id ? [] : [{ id: "snooze", label: "Snooze", rank: 2, node: <SessionSnoozeButton sessionId={session.id} /> }]),
    ...headerActions.all().filter((a) => !a.when || a.when(session)).map((a) => ({
      id: `action:${a.id}`,
      label: a.label,
      rank: 1,
      node: <button type="button" title={a.label} aria-label={a.label} data-testid={`header-action-${a.id}`} onClick={() => a.run(session)} className={iconButton}>{a.icon}</button>,
      item: (close: () => void) => <button type="button" data-testid={`header-action-${a.id}`} onClick={() => { close(); a.run(session); }} className="k-stow-item">{a.icon}{a.label}</button>,
    })),
  ];
  const { head, list, out, later } = useFit(tools, editing ? TITLE_ROOM : 0);
  const folded = tools.filter((t) => out.includes(t.id));
  const bg = useBackgroundLive(session.id);
  // What the dot at the menu counts, in words (a title is not shown on touch: the name has it).
  const live = bg.live > 0 && out.includes("background") ? `${bg.words} in the background` : "";
  // Its subagents' sessions go with it: the dialog says how many before anything is removed.
  // (The list leaves out the ones at rest and counts them under the session it carries.)
  const remove = async () => {
    const all = Object.values(getState().sessions), left = getState().agentsLeft;
    const below = (id: string): number => (left[id] ?? 0) + all.filter((x) => x.parent_id === id).reduce((n, x) => n + 1 + below(x.id), 0);
    const kids = below(session.id);
    const ok = await confirmAction({ title: "Delete this session?", body: `"${session.title || "New session"}" and its whole history are removed${kids ? `, with the sessions of its ${kids === 1 ? "subagent" : `${kids} subagents`}` : ""}. This cannot be undone; Archive keeps it.`, action: "Delete", danger: true });
    if (ok) { actions.remove(session.id).catch(reportError); navigate({ name: "new" }); }
  };
  // A phone's head holds no tools (bridge.css), and a pane alone has none at rest: the pane's pin and close are the
  // first rows of the menu then.
  const pinned = isPinned(session);
  const panes = useStations((x) => x.count);
  const alone = phone() || panes < 2;
  const acts: Act[] = [
    ...(alone ? [
      { id: "menu-pin", label: pinned ? "Unpin from the top of the list" : "Pin to the top of the list", icon: pinned ? <PinOff /> : <Pin />, run: () => runCommand("station.pin") },
      { id: "menu-close", label: "Close the session here", icon: <X />, run: () => runCommand("station.close") },
    ] : []),
    { id: "menu-rename", label: "Rename", icon: <Pencil />, gap: alone, run: () => setEditing(true) },
    { id: "menu-link", label: "Copy link", icon: <Link2 />, run: () => void copyOrSay(location.href, menuButton.current) },
    { id: "menu-path", label: "Copy folder path", icon: <Copy />, run: () => void copyOrSay(session.workspace, menuButton.current) },
    { id: "menu-new-here", label: "New session here", icon: <FolderPlus />, run: () => { savePref("newWorkspace", session.workspace); navigate({ name: "new" }); } },
    // To come back to it: its row keeps its unread mark until the session is opened again.
    ...(!session.parent_id && !session.machine ? [{ id: "menu-unread", label: "Mark unread", icon: <MailOpen />, run: () => void auto.unreadSession(session.id).catch(reportError) }] : []),
    { id: "menu-fork", label: "Fork", icon: <GitBranch />, gap: true, disabled: !session.head, run: () => { if (session.head) actions.fork(session.id, session.head).then((f) => openPlaced(f.id, session.id), reportError); } },
    session.archived
      ? { id: "menu-restore", label: "Restore", icon: <ArchiveRestore />, gap: true, run: () => void actions.patch(session.id, { archived: false }).catch(reportError) }
      : { id: "menu-archive", label: "Archive", icon: <Archive />, gap: true, run: () => void archive(session).catch(reportError) },
    { id: "menu-delete", label: "Delete", icon: <Trash2 />, danger: true, run: () => void remove() },
  ];

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
            data-testid="head-folder"
            className="k-head-folder hidden h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption text-faint hover:bg-hover hover:text-muted sm:inline-flex"
          >
            <Folder className="size-3.5" />
            {folder}
          </button>
        )}
      </div>
      <div data-tools="" className="k-head-tools">
      {tools.filter((t) => !out.includes(t.id)).map((t) => <span key={t.id} data-tool={t.id} className="k-head-tool">{t.node}</span>)}
      </div>
      <PanelsButton session={session} />
      <SessionMenu tools={folded} live={live} list={list} changed={later} acts={acts} button={menuButton} />
      {session.phase === "working" && <div className="k-wake-line" aria-hidden="true" data-testid="wake-line" />}
    </header>
  );
}
