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

export type LiveStatus = { working: number; needs: number; titles: string[]; since: number | null };

// A session's part in the status: its title, whether its turn runs and since when, and how many
// cards wait on the owner in it or in its agents (an agent's work is its root's: a root is listed).
export type LiveRow = { title: string; running: boolean; since?: number; needs: number };

export function liveStatus(rows: LiveRow[]): LiveStatus {
  // A session whose turn waits on the owner is counted with what needs them, not with what works.
  const run = rows.filter((r) => r.running && !r.needs);
  const starts = run.map((r) => r.since).filter((n): n is number => typeof n === "number");
  return {
    working: run.length, needs: rows.reduce((n, r) => n + r.needs, 0),
    // The longest-running first: the one the owner has waited on longest.
    titles: run.sort((a, b) => (a.since ?? 0) - (b.since ?? 0)).map((r) => r.title || "A session").slice(0, 4),
    since: starts.length ? Math.min(...starts) : null,
  };
}

const same = (a: LiveStatus | null, b: LiveStatus) => !!a && a.working === b.working && a.needs === b.needs && a.titles.join("\u0000") === b.titles.join("\u0000");

// The push's data: counts and a title and body the notification shows as they are.
export function liveData(s: LiveStatus): Record<string, string> {
  const what = [s.working ? `${s.working} session${s.working === 1 ? "" : "s"} working` : "", s.needs ? `${s.needs} need${s.needs === 1 ? "s" : ""} you` : ""].filter(Boolean).join(" · ");
  return { w: String(s.working), q: String(s.needs), title: what, body: s.titles.join(" · "), ...(s.since ? { since: String(s.since) } : {}) };
}

export class LiveTicker {
  private told: LiveStatus | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private read: () => LiveStatus,
    private send: (s: LiveStatus) => Promise<void> | void,
    private quietMs = 20_000,
    private on = () => true,
  ) {}

  /** Something that can change the status happened. */
  poke() {
    if (this.timer || !this.on()) return;
    this.timer = setTimeout(() => void this.flush(), this.quietMs);
    (this.timer as any).unref?.();
  }

  /** Sends the status now when it differs from the last one sent (the first is sent only when something runs or waits). */
  async flush() {
    this.timer = null;
    if (!this.on()) return;
    const now = this.read();
    if (same(this.told, now) || (!this.told && !now.working && !now.needs)) return;
    this.told = now;
    await this.send(now);
  }

  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
