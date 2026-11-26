// The sessions Claude Code and Codex run now on a machine reached over ssh,
// in this daemon's list under that machine's line: read-only rows, as the
// sessions they run here are (src/integrations/outside/service.ts). The
// helper there names what its harnesses hold open (src/fleet/hands-sessions.ts,
// `running`); a row carries its harness, its title, its folder and its state,
// and nothing else of what it says: its replies and its transcript stay on that
// machine until the owner imports it. The title is the harness's own, which may
// be the first prompt's words, as for a local outside row. Nothing is kept on
// disk: the rows are what the machine said last, while it answers (a machine
// that is offline or removed has none; a brief failure of a ready one keeps them).
//
// Cost: one request a machine every POLL_MS, only while a page hears the
// `fleet_outside` feed (its list shows an External section that can hold these
// rows), outside sessions are on, and the machine answers. The helper reads its process table and Claude Code's
// own list of live sessions for it, and walks its stores at most every 30 s.
import type { Bus } from "../core/bus.ts";
import { emptyUsage, type OutsideMark, type Session } from "../core/types.ts";
import type { Found } from "../integrations/import/types.ts";
import { excluded, outsideSettings } from "../integrations/outside/settings.ts";
import type { MachineRow } from "./db.ts";
import { LinkError } from "./link.ts";

export const POLL_MS = 30_000;

// A row of the helper's running list: a transcript and what its harness does now.
export type FarRunning = Found & { original?: { state: "idle" | "active"; brief?: string } };

// The id a row has under its machine: the page names it `<machine>--<this>`, so only word characters and dashes.
export const farRowId = (harness: string, id: string) => `outside-${harness}-${id}`.replace(/[^\w-]/g, "_");

// A row as the list shows it. Only what a list needs: no prompt, no reply, no
// line of what the harness does (its brief names counts, but the row's state says enough).
export function farSession(r: FarRunning): Session | null {
  if (r.harness !== "claude" && r.harness !== "codex") return null;
  if (!r.original) return null; // the harness does not hold it open now
  const state: OutsideMark["state"] = r.original.brief?.includes("on a prompt") ? "waiting" : r.original.state === "active" ? "working" : "done";
  const at = Math.round(r.updated_ms) || 0;
  return {
    id: farRowId(r.harness, r.id),
    title: r.title || "",
    model: r.model ?? r.harness,
    workspace: r.cwd ?? "",
    created: at,
    updated: at,
    phase: state === "working" ? "working" : "idle",
    archived: false,
    usage: emptyUsage(),
    head: null,
    settings: {},
    outside: { harness: r.harness, source_id: r.id, state, since: at, files: 0, failures: 0 },
  };
}

// The rows of one machine's running list the owner's settings let show: an
// interactive session (a script's `claude -p` run is no session of his), in a
// folder he did not exclude, with outside sessions on at all.
export function farSessions(rows: FarRunning[], cfg: { enabled: boolean; exclude: string[] }): Session[] {
  if (!cfg.enabled) return [];
  const out: Session[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.kind !== "interactive" || excluded(r.cwd, cfg.exclude)) continue;
    const s = farSession(r);
    if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); }
  }
  return out.sort((a, b) => b.updated - a.updated);
}

type FleetLike = {
  rows(): MachineRow[];
  isSsh(m: MachineRow): boolean;
  handsJson<T>(id: string, path: string, init?: RequestInit & { timeout?: number; idempotent?: boolean }): Promise<T>;
};

export class FarOutside {
  private rows = new Map<string, { sessions: Session[]; print: string; at: number }>();
  private asking = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private d: { fleet: FleetLike; bus: Bus; heard: () => boolean; capture: (e: unknown, ctx: Record<string, unknown>) => void; settings?: () => { enabled: boolean; exclude: string[] } }) {}

  start() {
    this.timer ??= setInterval(() => { if (this.d.heard()) void this.poll(); }, POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private cfg() {
    return (this.d.settings ?? outsideSettings)();
  }

  // The rows a machine showed last, while it answers; a list older than POLL_MS is asked for again behind the answer.
  sessions(machine: string): Session[] {
    this.prune();
    const m = this.d.fleet.rows().find((r) => r.id === machine);
    if (!m || !this.askable(m)) return [];
    const had = this.rows.get(machine);
    if (!had || Date.now() - had.at >= POLL_MS) void this.ask(m);
    return had?.sessions ?? [];
  }

  // Every machine that answers, now; the rows of one that went offline or was removed go.
  poll(): Promise<void> {
    this.prune();
    if (!this.cfg().enabled) return Promise.resolve();
    return Promise.all(this.d.fleet.rows().filter((m) => this.askable(m)).map((m) => this.ask(m))).then(() => {});
  }

  // Rows only of a machine that answers, with outside sessions on: the others' go, each change one frame.
  private prune() {
    const on = this.cfg().enabled;
    const live = new Set(this.d.fleet.rows().filter((m) => this.askable(m)).map((m) => m.id));
    for (const [id, had] of this.rows) {
      if (on && live.has(id)) continue;
      this.rows.delete(id);
      if (had.print !== "[]") this.d.bus.emit({ t: "feature", name: "fleet_outside", data: { machine: id } });
    }
  }

  private askable(m: MachineRow) {
    return this.cfg().enabled && this.d.fleet.isSsh(m) && (m.state === "ready" || m.state === "busy");
  }

  private async ask(m: MachineRow): Promise<void> {
    if (this.asking.has(m.id)) return;
    this.asking.add(m.id);
    try {
      const r = await this.d.fleet.handsJson<{ sessions?: FarRunning[] }>(m.id, "/api/fleet/hands/transcripts?running=1&peek=1&limit=50", { timeout: 20_000, idempotent: true });
      // The machine may have gone while it answered: what it said then is no row.
      const now = this.d.fleet.rows().find((x) => x.id === m.id);
      if (now && this.askable(now)) this.take(m.id, farSessions(Array.isArray(r.sessions) ? r.sessions : [], this.cfg()));
    } catch (e) {
      // Out of reach: the machine's line says so, and its rows stand as it last told them until it answers.
      if (!(e instanceof LinkError)) this.d.capture(e, { at: "fleet far outside", machine: m.id });
    } finally {
      this.asking.delete(m.id);
    }
  }

  private take(machine: string, sessions: Session[]) {
    const print = JSON.stringify(sessions);
    const had = this.rows.get(machine);
    this.rows.set(machine, { sessions, print, at: Date.now() });
    if ((had?.print ?? "[]") !== print) this.d.bus.emit({ t: "feature", name: "fleet_outside", data: { machine } });
  }
}
