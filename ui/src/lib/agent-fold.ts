// Which of a session's agents a panel lists. By default what is live (working, needs the owner, waits,
// queued) and what ended lately or since the owner looked, then one row, "N earlier", that opens the
// rest a page at a time. A session that ran hundreds of agents shows the few that matter now; the
// counts on its agents' line stay whole. An agent above a listed one is listed too, so a row is never
// left without its parent.
import { useEffect, useState } from "react";
import type { Watch } from "../../../src/core/watch.ts";
import { every } from "./clock.ts";
import { endedUnseen, useAgentsSeen } from "./agent-seen.ts";

// An agent that ended this recently is still listed.
export const RECENT_MS = 30 * 60_000;
// How many of the earlier ones one press opens.
export const PAGE = 20;

type Kept = Parameters<typeof endedUnseen>[1];
type Agent = { id: string; status: string; ended?: number | null };

// Pure: whether an agent is listed on its own account: it is live, it ended in the last RECENT_MS, or it ended
// since the owner looked (a failure the owner has not seen is that). `watch`: its one state (src/core/state-words.ts).
export function listedOnItsOwn(a: Agent, watch: Watch | undefined, seen: Kept, now = Date.now()): boolean {
  if (a.status === "running" || a.status === "waiting") return true;
  if (watch === "need" || watch === "work" || watch === "wait" || watch === "resume") return true;
  if (a.ended && a.ended > now - RECENT_MS) return true;
  return endedUnseen({ id: a.id, status: a.status, ended: a.ended }, seen);
}

// Pure: of rows in tree order (each with its depth, the first level at 1), which are listed. `keep[i]` lists a
// row on its own account; the rows above a listed one, up to the top, are listed with it.
export function listedRows(depth: readonly number[], keep: readonly boolean[]): boolean[] {
  const out = keep.slice();
  const need = new Set<number>();
  for (let i = depth.length - 1; i >= 0; i--) {
    const d = depth[i]!;
    if (need.has(d)) out[i] = true;
    for (const n of [...need]) if (n >= d) need.delete(n);
    if (out[i] && d > 1) need.add(d - 1);
  }
  return out;
}

// Pure: the rows of the earlier ones that `opened` pages show: the newest first, so each press goes back in
// time. `newest`: where the newest of the rows are in the list's order ("last" for a list that runs oldest first).
export function openedRows(listed: readonly boolean[], opened: number, newest: "first" | "last" = "last"): Set<number> {
  const hidden: number[] = [];
  listed.forEach((on, i) => { if (!on) hidden.push(i); });
  const n = opened * PAGE;
  return new Set(newest === "last" ? hidden.slice(Math.max(0, hidden.length - n)) : hidden.slice(0, n));
}

// The time, moved on once a minute while the panel is open: a row that ended half an hour ago leaves the
// listed ones without the owner touching anything.
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (on ? (setNow(Date.now()), every(60_000, () => setNow(Date.now()))) : undefined), [on]);
  return now;
}

export type Fold = {
  // Whether row i is shown (listed, or opened) and how many earlier are still folded.
  show: boolean[];
  earlier: number;
  more: () => void;
  // How many pages are open: the page asks for the rest of the agents' sessions when one is.
  opened: number;
};

// The fold of one panel's rows: their depths, which of them are listed on their own account (a row the owner
// keeps open, or has on screen, is one), and a key that starts the fold again (the session the panel is of).
export function useFold(depth: readonly number[], keep: readonly boolean[], key: string, newest: "first" | "last" = "last"): Fold {
  const [state, setState] = useState({ key, opened: 0 });
  // Another session's panel, or one closed and opened again, starts folded again.
  if (state.key !== key) setState({ key, opened: 0 });
  const opened = state.key === key ? state.opened : 0;
  const listed = listedRows(depth, keep);
  const shown = openedRows(listed, opened, newest);
  const show = listed.map((on, i) => on || shown.has(i));
  const earlier = show.filter((on) => !on).length;
  return { show, earlier, opened, more: () => setState({ key, opened: opened + 1 }) };
}

export { useAgentsSeen };
