// Pieces the direction shells share: the state mark, a clock that ticks only
// while something works, the full session index as a drawer, and the
// sessions in order of attention.
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../../src/core/types.ts";
import { useStore } from "../../lib/store.ts";
import { savePref, setUI, useUI } from "../../lib/ui.ts";
import { WATCH_LABEL, WATCH_RANK, useWatches, type Watch } from "../../lib/watch.ts";
import { cn } from "../../lib/utils.ts";
import { Sidebar } from "../Sidebar.tsx";

// A state is a shape as well as a color, so it reads without color too.
export function Mark({ w, className }: { w: Watch; className?: string }) {
  return <span className={cn("k-mark", className)} data-watch={w} role="img" aria-label={WATCH_LABEL[w]} />;
}

// Re-renders every `ms` while `on`; idle screens do not tick.
export function useNow(on: boolean, ms = 1000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// The shells have their own way around; the full index (folders, archive)
// opens as a drawer. It starts closed whatever the classic layout kept.
export function IndexDrawer() {
  const open = useUI((s) => s.sidebar);
  useEffect(() => { setUI({ sidebar: false }); }, []);
  return (
    <>
      <div className={cn("k-drawer fixed inset-y-0 left-0 z-40 shadow-3 transition-transform duration-200 ease-[var(--ease-out)]", open ? "translate-x-0" : "-translate-x-full invisible")}>
        <Sidebar />
      </div>
      {open && <div className="fixed inset-0 z-30 bg-overlay" onClick={() => savePref("sidebar", false)} aria-hidden="true" />}
    </>
  );
}

// Live (not archived) sessions with their watch word, most urgent first.
export function useLive() {
  const sessions = useStore((s) => s.sessions);
  const list = useMemo(() => Object.values(sessions).filter((s) => !s.archived), [sessions]);
  const watches = useWatches(list);
  const ranked = useMemo(
    () => [...list].sort((a, b) => WATCH_RANK[watches[a.id]!] - WATCH_RANK[watches[b.id]!] || b.updated - a.updated),
    [list, watches],
  );
  return { list, ranked, watches };
}

export const folderOf = (s: Session) => s.workspace.split("/").filter(Boolean).pop() ?? s.workspace;
export const modelOf = (id: string) => id.replace(/^[^:]+:/, "").replace(/^(global|us|eu)\.anthropic\./, "").replace(/-v\d.*$/, "");
