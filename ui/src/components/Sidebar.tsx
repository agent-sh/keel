import { Bug, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { actions, useStore } from "../lib/store.ts";
import { ago, cn } from "../lib/utils.ts";

export function Sidebar({ current, onPick, onNew, onErrors, theme, onTheme }: {
  current: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onErrors: () => void;
  theme: "light" | "dark";
  onTheme: () => void;
}) {
  const sessions = useStore((s) => s.sessions);
  const errors = useStore((s) => s.errors.length);
  const connected = useStore((s) => s.connected);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived).sort((a, b) => b.updated - a.updated), [sessions]);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="grid size-6 place-items-center rounded-md bg-accent text-accent-fg text-[12px] font-bold">K</div>
        <span className="font-semibold tracking-tight">Keel</span>
        <span
          title={connected ? "Connected" : "Reconnecting"}
          className={cn("ml-1 size-1.5 rounded-full", connected ? "bg-ok" : "bg-warn animate-pulse-dot")}
        />
      </div>
      <div className="px-3">
        <button
          type="button"
          data-testid="new-session"
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium hover:bg-raised transition-colors"
        >
          <Plus className="size-4" /> New session
        </button>
      </div>
      <nav className="mt-2 flex-1 overflow-y-auto px-3 pb-3" data-testid="session-list">
        {list.length === 0 && <p className="px-2.5 py-6 text-[13px] text-faint">No sessions yet.</p>}
        {list.map((s) => (
          <div
            key={s.id}
            role="button"
            tabIndex={0}
            onClick={() => onPick(s.id)}
            onKeyDown={(e) => e.key === "Enter" && onPick(s.id)}
            className={cn(
              "group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13.5px] cursor-default outline-none",
              "hover:bg-raised focus-visible:ring-2 focus-visible:ring-accent/30",
              current === s.id && "bg-raised shadow-soft",
            )}
          >
            {s.phase === "working" && <span className="size-1.5 shrink-0 rounded-full bg-accent animate-pulse-dot" />}
            <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
            <span className="text-[11.5px] text-faint tabular-nums group-hover:hidden">{ago(s.updated)}</span>
            <button
              type="button"
              title="Delete"
              onClick={(e) => { e.stopPropagation(); actions.remove(s.id); }}
              className="hidden size-5 place-items-center rounded text-faint hover:text-danger group-hover:grid"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-1 border-t border-line px-3 py-2">
        <button
          type="button"
          data-testid="errors-button"
          onClick={onErrors}
          className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] hover:bg-raised", errors ? "text-danger" : "text-faint")}
        >
          <Bug className="size-3.5" /> {errors ? `${errors} error${errors > 1 ? "s" : ""}` : "No errors"}
        </button>
        <button
          type="button"
          data-testid="theme-toggle"
          onClick={onTheme}
          title="Toggle theme"
          className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:text-fg hover:bg-raised"
        >
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </button>
      </div>
    </aside>
  );
}
