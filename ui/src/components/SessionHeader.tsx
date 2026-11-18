import { Menu } from "@base-ui/react/menu";
import { Archive, Copy, Ellipsis, Folder, FolderPlus, Link2, Menu as MenuIcon, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { headerActions } from "../lib/extend.ts";
import { actions, reportError } from "../lib/store.ts";
import { navigate, savePref, useUI } from "../lib/ui.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { ChangesButton } from "./ChangesPanel.tsx";
import { PermissionMenu } from "./PermissionMenu.tsx";
import { iconButton, itemClass, popupClass } from "./ui.tsx";

export function SidebarButton() {
  const sidebar = useUI((s) => s.sidebar);
  if (sidebar) return null;
  return (
    <button type="button" aria-label="Show the sidebar" title="Show the sidebar (Ctrl B)" data-testid="show-sidebar" onClick={() => savePref("sidebar", true)} className={iconButton}>
      <MenuIcon className="size-4" />
    </button>
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

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1.5 border-b border-line bg-bg/85 px-2 backdrop-blur-md md:px-4" data-testid="session-header">
      <SidebarButton />
      <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
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
            onClick={() => navigator.clipboard.writeText(session.workspace)}
            className="hidden h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption text-faint hover:bg-hover hover:text-muted sm:inline-flex"
          >
            <Folder className="size-3.5" />
            {folder}
          </button>
        )}
      </div>
      <span
        className="hidden shrink-0 px-2 text-caption tabular-nums text-faint md:inline"
        title={`Input ${input_.toLocaleString()} tokens (${u.cache_read.toLocaleString()} read from cache), output ${u.output.toLocaleString()}`}
        data-testid="session-usage"
      >
        {fmtTokens(input_)} in <span className="text-line-strong">/</span> {fmtTokens(u.output)} out{cached ? <span className="ml-1.5 text-ok">{cached}% cached</span> : null}
      </span>
      <ChangesButton sessionId={session.id} />
      <PermissionMenu sessionId={session.id} />
      {headerActions.all().filter((a) => !a.when || a.when(session)).map((a) => (
        <button key={a.id} type="button" title={a.label} aria-label={a.label} onClick={() => a.run(session)} className={iconButton}>{a.icon}</button>
      ))}
      <Menu.Root>
        <Menu.Trigger aria-label="Session actions" data-testid="session-menu" className={iconButton}>
          <Ellipsis className="size-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
            <Menu.Popup className={cn(popupClass, "min-w-52")}>
              <Menu.Item className={itemClass} onClick={() => setEditing(true)}><Pencil /> Rename</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => navigator.clipboard.writeText(location.href)}><Link2 /> Copy link</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => navigator.clipboard.writeText(session.workspace)}><Copy /> Copy folder path</Menu.Item>
              <Menu.Item className={itemClass} onClick={() => { savePref("newWorkspace", session.workspace); navigate({ name: "new" }); }}><FolderPlus /> New session here</Menu.Item>
              <Menu.Separator className="mx-1 my-1 h-px bg-line" />
              <Menu.Item className={itemClass} onClick={() => { actions.patch(session.id, { archived: true }).catch(reportError); navigate({ name: "new" }); }}><Archive /> Archive</Menu.Item>
              <Menu.Item
                className={cn(itemClass, "text-danger [&>svg]:text-danger")}
                onClick={() => { if (confirm(`Delete "${session.title || "this session"}" and its history?`)) { actions.remove(session.id).catch(reportError); navigate({ name: "new" }); } }}
              >
                <Trash2 /> Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {session.phase === "working" && (
        <div className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden" aria-hidden="true">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-brass to-transparent animate-wake" />
        </div>
      )}
    </header>
  );
}
