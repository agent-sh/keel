import { Archive, Bug, Folder, Moon, PanelLeftClose, Plus, Search, Settings, Sun, SunMoon } from "lucide-react";
import { useMemo } from "react";
import type { Session } from "../../../src/core/types.ts";
import { actions, useStore } from "../lib/store.ts";
import { navigate, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// Sessions grouped by folder, the folder with the newest work first.
function groups(sessions: Session[]) {
  const by = new Map<string, Session[]>();
  for (const s of sessions) (by.get(s.workspace) ?? by.set(s.workspace, []).get(s.workspace)!).push(s);
  return [...by.entries()]
    .map(([ws, list]) => ({ ws, list: list.sort((a, b) => b.updated - a.updated) }))
    .sort((a, b) => b.list[0]!.updated - a.list[0]!.updated);
}

function Row({ s, active }: { s: Session; active: boolean }) {
  return (
    <div
      role="link"
      tabIndex={0}
      data-testid="session-row"
      aria-current={active ? "page" : undefined}
      onClick={() => navigate({ name: "session", id: s.id })}
      onKeyDown={(e) => e.key === "Enter" && navigate({ name: "session", id: s.id })}
      className={cn(
        "group relative flex h-8 items-center gap-2 rounded-md pl-2.5 pr-1.5 text-ui cursor-default select-none",
        "text-muted hover:bg-hover hover:text-fg",
        active && "bg-raised text-fg shadow-1 hover:bg-raised",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          s.phase === "working" ? "bg-brass animate-pulse-dot" : s.phase === "error" ? "bg-danger" : "bg-transparent",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
      <span className="text-micro text-faint tabular-nums group-hover:hidden group-focus-within:hidden">{ago(s.updated)}</span>
      <button
        type="button"
        title="Archive"
        aria-label="Archive session"
        onClick={(e) => {
          e.stopPropagation();
          actions.patch(s.id, { archived: true });
        }}
        className="hidden size-6 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg group-hover:grid group-focus-within:grid"
      >
        <Archive className="size-3.5" />
      </button>
    </div>
  );
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const errors = useStore((s) => s.errors.length);
  const connected = useStore((s) => s.connected);
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const current = route.name === "session" ? route.id : null;
  const grouped = useMemo(() => groups(Object.values(sessions).filter((s) => !s.archived)), [sessions]);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;

  return (
    <aside className="flex h-full w-[272px] flex-col border-r border-line bg-panel" data-testid="sidebar">
      <div className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-2">
        <Logo />
        <span className="text-[15px] font-semibold tracking-[-0.01em]">Keel</span>
        <span
          title={connected ? "Connected to the daemon" : "Reconnecting to the daemon"}
          className={cn("size-1.5 rounded-full", connected ? "bg-ok" : "bg-warn animate-pulse-dot")}
        />
        <button
          type="button"
          onClick={() => savePref("sidebar", false)}
          title="Hide the sidebar"
          aria-label="Hide the sidebar"
          className="ml-auto grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pb-2">
        <button
          type="button"
          data-testid="new-session"
          onClick={() => navigate({ name: "new" })}
          className={cn(
            "group/new flex h-8 items-center gap-2 rounded-md px-2.5 text-ui font-medium text-fg hover:bg-hover",
            route.name === "new" && "bg-raised shadow-1 hover:bg-raised",
          )}
        >
          <Plus className="size-4 text-accent" strokeWidth={2.25} /> New session
          <Kbd keys="mod+shift+o" className="ml-auto opacity-0 transition-opacity group-hover/new:opacity-100" />
        </button>
        <button
          type="button"
          data-testid="open-palette"
          onClick={() => setUI({ palette: true })}
          className="flex h-8 items-center gap-2 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg"
        >
          <Search className="size-4" /> Search and commands
          <Kbd keys="mod+k" className="ml-auto" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-3" data-testid="session-list" aria-label="Sessions">
        {grouped.length === 0 && (
          <p className="px-2.5 pt-6 text-ui leading-relaxed text-faint">Sessions you start show up here, grouped by folder.</p>
        )}
        {grouped.map((g) => (
          <section key={g.ws} className="mt-3 first:mt-1">
            <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-caption font-medium text-faint" title={g.ws}>
              <Folder className="size-3.5" />
              <span className="truncate">{base(g.ws)}</span>
            </h2>
            <div className="flex flex-col gap-px">
              {g.list.map((s) => <Row key={s.id} s={s} active={current === s.id} />)}
            </div>
          </section>
        ))}
      </nav>

      <div className="flex shrink-0 items-center gap-0.5 border-t border-line px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          data-testid="settings-button"
          onClick={() => navigate({ name: "settings", section: "general" })}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-hover hover:text-fg",
            route.name === "settings" && "text-fg",
          )}
        >
          <Settings className="size-4" /> Settings
        </button>
        <button
          type="button"
          data-testid="errors-button"
          onClick={() => setUI({ errors: true })}
          title={errors ? `${errors} recorded failures` : "No failures recorded"}
          className={cn("flex h-8 items-center gap-1.5 rounded-md px-2 text-ui hover:bg-hover", errors ? "text-danger" : "text-faint hover:text-fg")}
        >
          <Bug className="size-4" /> {errors ? errors : ""}
        </button>
        <button
          type="button"
          data-testid="theme-toggle"
          onClick={() => setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")}
          title={`Theme: ${theme}`}
          aria-label={`Theme: ${theme}. Change`}
          className="ml-auto grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
        >
          <ThemeIcon className="size-4" />
        </button>
      </div>
    </aside>
  );
}
