// The state mark, a clock that ticks only while something works, and the
// live sessions in order of attention.
import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { downSince, liveNow, useStore } from "../lib/store.ts";
import { WATCH_LABEL, WATCH_RANK, useStatesSince, useWatches, type SessionState, type Watch } from "../lib/watch.ts";
import { cn } from "../lib/utils.ts";
import { beatOf, every } from "../lib/clock.ts";
import { asOf, span } from "../../../src/core/watch.ts";

export { failWord, span, whyText } from "../../../src/core/watch.ts";

// A state is a shape as well as a color, so it reads without color too.
export function Mark({ w, className }: { w: Watch; className?: string }) {
  return <span className={cn("k-mark", className)} data-watch={w} role="img" aria-label={WATCH_LABEL[w]} />;
}

// Re-renders every `ms` while `on`; idle screens do not tick. The time stops
// while the daemon is unreachable: the page does not know the work goes on.
export function useNow(on: boolean, ms = 1000) {
  // Stopped from the loss until the states are read again, not only until a socket speaks.
  const stale = useStatesSince() !== null;
  const [now, setNow] = useState(liveNow);
  useEffect(() => {
    if (!on) return;
    setNow(stale ? liveNow() : Date.now());
    if (stale) return;
    // The page's one clock (lib/clock.ts): shared by every time on screen, and still while the page is hidden.
    return every(ms, () => setNow(Date.now()));
  }, [on, ms, stale]);
  return now;
}

export function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// How long a state has held, or when what it waits for is due. `short`: for a
// row's narrow time column ("in 14m").
export function stateClock(st: SessionState, at: number, short = false): string {
  // A state that is not current (the daemon or its machine is not heard) stops where it was last
  // known. One told while the page still catches up is current: it counts from the real time.
  const now = st.as_of === undefined && downSince() !== null ? Math.max(at, Date.now()) : asOf(st, at);
  if (st.until) return st.until > now ? `${short ? "in" : "due in"} ${span(st.until - now)}` : short ? "due" : "due now";
  return st.since ? span(now - st.since) : "";
}
// The clock of a row in a list: to the minute ("now" under one, as a row at rest says it), so a list of
// sessions that work does not tick every second; the pane and the card beside the row say the seconds.
export function rowClock(st: SessionState, at: number): string {
  const now = st.as_of === undefined && downSince() !== null ? Math.max(at, Date.now()) : asOf(st, at);
  if (st.until) return st.until - now >= 60_000 ? `in ${span(st.until - now)}` : st.until > now ? "in <1m" : "due";
  return st.since && now - st.since >= 60_000 ? span(now - st.since) : "now";
}
export const ROW_BEAT = 15_000;

// How often a timed state's clock changes what it says: each second under a minute, a few times a minute after.
export const tickOf = (st: SessionState) => beatOf(st.until ?? st.since);
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
