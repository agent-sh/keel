import { X } from "lucide-react";
import { Suspense, useSyncExternalStore } from "react";
import type { Session } from "../../../src/core/types.ts";
import { panels } from "../lib/extend.ts";
import { savePref, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { iconButton } from "./ui.tsx";

const visible = (s: Session) => panels.all().filter((p) => !p.when || p.when(s)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

// The header's toggles, one per registered panel.
export function PanelToggles({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  return (
    <>
      {visible(session).map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.label}
          aria-label={p.label}
          aria-pressed={open === p.id}
          data-testid={`panel-toggle-${p.id}`}
          onClick={() => savePref("panel", open === p.id ? null : p.id)}
          className={cn(iconButton, open === p.id && "bg-hover text-accent")}
        >
          {p.icon}
        </button>
      ))}
    </>
  );
}

// The panel beside the conversation on a wide screen, a sheet over it on a phone.
export function SidePanel({ session }: { session: Session }) {
  useSyncExternalStore(panels.subscribe, panels.version);
  const open = useUI((s) => s.panel);
  const list = visible(session);
  const cur = list.find((p) => p.id === open);
  if (!cur) return null;
  const Body = cur.component;
  return (
    <aside
      data-testid="side-panel"
      className="flex min-h-0 flex-col border-line bg-panel max-lg:fixed max-lg:inset-0 max-lg:z-40 lg:w-[min(44vw,40rem)] lg:shrink-0 lg:border-l animate-in"
    >
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        {list.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => savePref("panel", p.id)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-ui text-muted hover:bg-hover hover:text-fg [&>svg]:size-4",
              p.id === cur.id && "bg-raised text-fg shadow-1 hover:bg-raised",
            )}
          >
            {p.icon}
            {p.label}
          </button>
        ))}
        <button type="button" aria-label="Close the panel" title="Close the panel (Ctrl \)" onClick={() => savePref("panel", null)} className={cn(iconButton, "ml-auto")}>
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Suspense fallback={null}>
          <Body session={session} />
        </Suspense>
      </div>
    </aside>
  );
}
