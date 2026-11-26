// The phone's lasting notification while turns run: one push of kind "live" when what runs or what
// waits on the owner changed, collapsed on the push service so only the newest is kept, and normal
// priority, so the phone wakes for it no more than for any other app's news. The phone keeps no
// connection and runs no service for it: the notification stays up between pushes and is taken down
// by the push that says nothing runs. Android's own rules for a lasting connection point the same
// way: a dataSync foreground service is cut after 6 hours in 24 (Android 15), and a message push
// (FCM) is what Google recommends for news from a server.
//
// A change is held for `quietMs` before it is sent, and what changed in that time goes as one push:
// a turn that starts and ends inside it sends nothing, and a session that works for an hour sends
// one push when it starts and one when it ends.

import type { Store } from "../../core/store.ts";
import { newestTurn } from "../../admin/marks.ts";

// `failed`: the open errors not read yet (the Errors view's count), said only beside work or a wait:
// the lasting notification is for what runs, and a failure has a notification of its own.
export type LiveStatus = { working: number; needs: number; failed: number; titles: string[]; since: number | null };

// Where a tap on the lasting notification leads: what waits on the owner first, then what failed,
// else the sessions at work.
export type LiveTo = "needs" | "errors" | "sessions";
export const liveTo = (s: Pick<LiveStatus, "needs" | "failed">): LiveTo => (s.needs ? "needs" : s.failed ? "errors" : "sessions");

// A session's part in the status: its title, whether its turn runs and since when, and how many
// cards wait on the owner in it or in its agents (an agent's work is its root's: a root is listed).
export type LiveRow = { title: string; running: boolean; since?: number; needs: number };

// `rows` lists the sessions that wait in the order their waits began (readLive puts them first).
export function liveStatus(rows: LiveRow[], failed = 0): LiveStatus {
  // A session whose turn waits on the owner is counted with what needs them, not with what works.
  const run = rows.filter((r) => r.running && !r.needs);
  const waits = rows.filter((r) => r.needs);
  const starts = run.map((r) => r.since).filter((n): n is number => typeof n === "number");
  const out: LiveStatus = {
    working: run.length, needs: rows.reduce((n, r) => n + r.needs, 0), failed: 0,
    // What waits on the owner is named first, as the count and the tap lead there; then what runs, the
    // longest-running first: the one the owner has waited on longest.
    titles: [...waits, ...run.sort((a, b) => (a.since ?? 0) - (b.since ?? 0))].map((r) => r.title || "A session").slice(0, 4),
    since: starts.length ? Math.min(...starts) : null,
  };
  out.failed = out.working || out.needs ? Math.max(0, failed) : 0;
  return out;
}

const same = (a: LiveStatus | null, b: LiveStatus) => !!a && a.working === b.working && a.needs === b.needs && (a.failed ?? 0) === b.failed && a.titles.join("\u0000") === b.titles.join("\u0000");

// The push's data: counts and a title and body the notification shows as they are.
export function liveData(s: LiveStatus): Record<string, string> {
  const what = [
    s.working ? `${s.working} session${s.working === 1 ? "" : "s"} working` : "",
    s.needs ? `${s.needs} need${s.needs === 1 ? "s" : ""} you` : "",
    s.failed ? `${s.failed} error${s.failed === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ");
  return { w: String(s.working), q: String(s.needs), f: String(s.failed), to: liveTo(s), title: what, body: s.titles.join(" · "), ...(s.since ? { since: String(s.since) } : {}) };
}

// What the status is read from: the store, the sessions whose turns run, the sessions a card waits on
// the owner in (an approval, a question, a plan), and how many agents work below each session
// (agentCounts, src/automation/state.ts).
// `failed`: the open errors not read yet, as the Errors view counts them.
export type LiveDeps = { store: Store; running(): Iterable<string>; waiting(): Iterable<string>; below(): Map<string, number>; failed?(): number };

// The status now, per session nobody started (an agent's part is its root's; an archived one is not
// counted). Only the sessions that run, lead agents or wait are read, each by its id, and a turn's
// start is one seek of the turn index: the read runs on the loop at every change.
export function readLive(d: LiveDeps): LiveStatus {
  const { store } = d;
  const rootOf = (id: string) => {
    let at = id;
    for (let n = 0, p = store.session(at)?.parent_id; p && n < 32; n++, p = store.session(at)?.parent_id) at = p;
    return at;
  };
  const waits = new Map<string, number>();
  for (const sid of d.waiting()) { const r = rootOf(sid); waits.set(r, (waits.get(r) ?? 0) + 1); }
  const below = d.below();
  const runs = new Set(d.running());
  const rows: LiveRow[] = [];
  // The sessions that wait first, in the order their cards are listed: the notification names them first.
  for (const id of new Set([...waits.keys(), ...runs, ...below.keys()])) {
    const s = store.session(id);
    if (!s || s.parent_id || s.archived) continue;
    const running = runs.has(id) || (below.get(id) ?? 0) > 0;
    rows.push({ title: s.title, running, since: running ? newestTurn(store, id)?.ts : undefined, needs: waits.get(id) ?? 0 });
  }
  return liveStatus(rows, rows.length ? d.failed?.() ?? 0 : 0);
}

// What was last told, kept where the next daemon reads it (the mobile settings): a daemon that stops
// inside a hold, after it told the phone that something works, leaves the next one to say it ended.
export type LiveKeep = { get(): LiveStatus | null; set(s: LiveStatus): void };

// A push that did not go is tried again after the hold, doubled each time it fails again, up to 32
// holds (about ten minutes at the daemon's 20 s): a phone that cannot be reached is not tried every
// hold for hours, and one that comes back is told within minutes.
const MAX_BACKOFF = 5;

export class LiveTicker {
  private told: LiveStatus | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;
  /**
   * `send` says whether the status reached at least one phone; a status is told only then.
   * `failed` hears a send that threw.
   */
  constructor(
    private read: () => LiveStatus,
    private send: (s: LiveStatus) => Promise<boolean> | boolean,
    private quietMs = 20_000,
    private on = () => true,
    private keep?: LiveKeep,
    private failed: (e: unknown) => void = () => {},
  ) {
    this.told = keep?.get() ?? null;
  }

  /** Something that can change the status happened. */
  poke() {
    if (this.timer || !this.on()) return;
    this.later(this.quietMs);
  }

  private later(ms: number) {
    this.timer = setTimeout(() => void this.flush(), ms);
    (this.timer as any).unref?.();
  }

  /** Sends the status now when it differs from the last one told (the first is sent only when something runs or waits). */
  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.on()) return;
    const now = this.read();
    if (same(this.told, now) || (!this.told && !now.working && !now.needs)) { this.fails = 0; return; }
    let ok = false;
    try { ok = await this.send(now); } catch (e) { this.failed(e); }
    if (ok) {
      this.told = now;
      this.fails = 0;
      try { this.keep?.set(now); } catch (e) { this.failed(e); }
      return;
    }
    // Not told: tried again after a longer hold. A change that set a shorter
    // one while this send was out gives way to it, so a busy daemon backs off too.
    this.fails = Math.min(this.fails + 1, MAX_BACKOFF);
    if (this.timer) clearTimeout(this.timer);
    this.later(this.quietMs * 2 ** this.fails);
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
