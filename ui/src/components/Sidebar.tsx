import { Archive, ArchiveRestore, Bug, Folder, Server, Moon, PanelLeftClose, Plus, Search, Settings, Sun, SunMoon } from "lucide-react";
import { useSafety } from "../lib/safety.ts";
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { machineColour, machineName, useFleet } from "../lib/fleet.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate, savePref, setTheme, setUI, useUI } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { Kbd } from "./Kbd.tsx";
import { Logo } from "./Logo.tsx";
import { AutomationFooter, SessionBadges, SessionChildren } from "./automation/SidebarExtras.tsx";

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

// Sessions grouped by folder (and machine, for another machine's), the folder
// with the newest work first.
function groups(sessions: Session[]) {
  const by = new Map<string, Session[]>();
  for (const s of sessions) {
    const k = `${s.machine ?? ""}\u0000${s.workspace}`;
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  return [...by.entries()]
    .map(([k, list]) => ({ key: k, ws: list[0]!.workspace, machine: list[0]!.machine ?? undefined, list: list.sort((a, b) => b.updated - a.updated) }))
    .sort((a, b) => b.list[0]!.updated - a.list[0]!.updated);
}

function Row({ s, active }: { s: Session; active: boolean }) {
  const restore = s.archived;
  return (
    <div
      role="link"
      tabIndex={0}
      data-testid="session-row"
      data-session={s.id}
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
      <NeedsYou sessionId={s.id} />
      <SessionBadges sessionId={s.id} />
      <span className="text-micro text-faint tabular-nums group-hover:hidden group-focus-within:hidden" title={when(s.updated)}>{ago(s.updated)}</span>
      <button
        type="button"
        title={restore ? "Restore" : "Archive"}
        aria-label={restore ? "Restore session" : "Archive session"}
        onClick={(e) => {
          e.stopPropagation();
          actions.patch(s.id, { archived: !restore }).catch(reportError);
        }}
        className="hidden size-6 place-items-center rounded-sm text-faint hover:bg-hover hover:text-fg group-hover:grid group-focus-within:grid"
      >
        {restore ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
      </button>
    </div>
  );
}

// A folder shows its newest sessions; the rest open on request (and the open one is always shown).
const SHOWN = 6;
function Group({ list, current }: { list: Session[]; current: string | null }) {
  const [all, setAll] = useState(false);
  const shown = all ? list : list.filter((s, i) => i < SHOWN || s.id === current);
  return (
    <div className="flex flex-col gap-px">
      {shown.map((s) => (
        <div key={s.id}>
          <Row s={s} active={current === s.id} />
          <SessionChildren parentId={s.id} current={current} />
        </div>
      ))}
      {list.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="h-7 rounded-md pl-6 text-left text-caption text-faint hover:bg-hover hover:text-muted">
          {list.length - shown.length} more
        </button>
      )}
      {all && list.length > SHOWN && (
        <button type="button" onClick={() => setAll(false)} className="h-7 rounded-md pl-6 text-left text-caption text-faint hover:bg-hover hover:text-muted">
          Show fewer
        </button>
      )}
    </div>
  );
}

// A session waiting on an approval.
export function NeedsYou({ sessionId }: { sessionId: string }) {
  const n = useSafety((s) => s.approvals[sessionId]?.length ?? 0);
  if (!n) return null;
  return (
    <span data-testid="needs-you" title={`${n} approval${n === 1 ? "" : "s"} waiting`} className="shrink-0 rounded-full bg-accent-soft px-1.5 text-micro font-medium text-accent-ink">
      needs you
    </span>
  );
}

export function Sidebar() {
  const sessions = useStore((s) => s.sessions);
  const errors = useStore((s) => s.errors.filter((e) => !e.resolved_ts).length);
  const connected = useStore((s) => s.connected);
  useFleet((s) => s.machines.length); // machine names in the group heads
  const route = useUI((s) => s.route);
  const theme = useUI((s) => s.theme);
  const current = route.name === "session" ? route.id : null;
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [archived, setArchived] = useState<Session[]>([]);
  useEffect(() => {
    if (tab === "archived") api<{ sessions: Session[] }>("/api/sessions?archived").then((r) => setArchived(r.sessions)).catch(reportError);
  }, [tab, sessions]);
  const grouped = useMemo(
    () => groups(tab === "active" ? Object.values(sessions).filter((s) => !s.archived && !s.parent_id) : archived.map((a) => sessions[a.id] ?? a).filter((s) => s.archived)),
    [sessions, tab, archived],
  );
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

      <div role="tablist" aria-label="Session list" className="mx-2.5 mb-1 flex gap-0.5 rounded-md bg-sunken p-0.5">
        {(["active", "archived"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
            className={cn("h-6 flex-1 rounded-sm text-caption text-muted", tab === t ? "bg-raised text-fg shadow-1" : "hover:text-fg")}
          >
            {t === "active" ? "Sessions" : "Archived"}
          </button>
        ))}
      </div>
      <nav className="flex-1 overflow-y-auto px-2.5 pb-3" data-testid="session-list" aria-label="Sessions">
        {grouped.length === 0 && (
          <p className="px-2.5 pt-6 text-ui leading-relaxed text-faint">
            {tab === "active" ? "Sessions you start show up here, grouped by folder." : "Archived sessions show up here. Restore one to bring it back."}
          </p>
        )}
        {grouped.map((g) => (
          <section key={g.key} className="mt-3 first:mt-1" data-machine={g.machine}>
            <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-caption font-medium text-faint" title={g.machine ? `${g.ws} on ${machineName(g.machine)}` : g.ws}>
              {g.machine ? <Server className="size-3.5" style={machineColour(g.machine) ? { color: machineColour(g.machine) } : undefined} /> : <Folder className="size-3.5" />}
              <span className="truncate">{base(g.ws)}</span>
              {g.machine && <span className="ml-auto shrink-0 rounded-full bg-sunken px-1.5 py-px text-micro font-normal text-muted" data-testid="group-machine">{machineName(g.machine)}</span>}
            </h2>
            <Group list={g.list} current={current} />
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
          title={errors ? `${errors} open failures` : "No failures recorded"}
          className={cn("flex h-8 items-center gap-1.5 rounded-md px-2 text-ui hover:bg-hover", errors ? "text-danger" : "text-faint hover:text-fg")}
        >
          <Bug className="size-4" /> {errors ? errors : ""}
        </button>
        <AutomationFooter />
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
