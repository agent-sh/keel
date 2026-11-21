// The state mark, a clock that ticks only while something works, and the
// live sessions in order of attention.
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { liveNow, useStore } from "../lib/store.ts";
import { WATCH_LABEL, WATCH_RANK, useWatches, type SessionState, type Watch } from "../lib/watch.ts";
import { cn } from "../lib/utils.ts";
import { span } from "../../../src/core/watch.ts";

export { failWord, span, whyText } from "../../../src/core/watch.ts";

// A state is a shape as well as a color, so it reads without color too.
export function Mark({ w, className }: { w: Watch; className?: string }) {
  return <span className={cn("k-mark", className)} data-watch={w} role="img" aria-label={WATCH_LABEL[w]} />;
}

// Re-renders every `ms` while `on`; idle screens do not tick. The time stops
// while the daemon is unreachable: the page does not know the work goes on.
export function useNow(on: boolean, ms = 1000) {
  const connected = useStore((s) => s.connected);
  const [now, setNow] = useState(liveNow);
  useEffect(() => {
    if (!on) return;
    setNow(liveNow());
    if (!connected) return;
    const t = setInterval(() => setNow(liveNow()), ms);
    return () => clearInterval(t);
  }, [on, ms, connected]);
  return now;
}

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// How long a state has held, or when what it waits for is due.
export function stateClock(st: SessionState, now: number): string {
  if (st.until) return st.until > now ? `due in ${span(st.until - now)}` : "due now";
  return st.since ? span(now - st.since) : "";
}
// A state that moves by itself or waits on the owner is timed; one at rest is not.
export const timed = (st: SessionState) => (st.watch === "need" || st.watch === "work" || st.watch === "wait") && !!(st.since || st.until);

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
