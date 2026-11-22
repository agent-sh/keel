// The daemon's own life: one daemon per state folder, a drain that turns new
// work away while the engine lets running turns finish and parks the rest,
// and a restart that starts the same binary again. Continuing parked and
// crash-cut turns is the engine's (Engine.recover, from main.ts).
import { heapSize } from "bun:jsc";
import { checkpointerOf, type StoreDisk } from "../core/checkpoint.ts";
import type { Store } from "../core/store.ts";
import type { Deps } from "../server/app.ts";
import { flushAll } from "../automation/core.ts";
import { buildInfo } from "../core/build.ts";
import { handLock } from "../core/daemon-lock.ts";
import { relaunchArgv } from "../core/relaunch.ts";
import { Rest } from "../core/rest.ts";
import { startTimes } from "../core/start-trace.ts";
import { addAdmission } from "../server/admission.ts";
import { earlierStarts, keepStall, type EarlierStart } from "./daemon-facts.ts";
import { backupLine, drainLine, exitLine, say } from "./daemon-log.ts";
import { IDLE_MAX_MS, pulse } from "../core/pulse.ts";
import { beatLife, endLife, restarts } from "./life.ts";
import { describeStall, type Stall, StallMonitor, TurnWatch, unanswered, watchWith } from "./stall.ts";
import type { Dirs } from "./stall-cause.ts";
import { StallWatch } from "./stall-watch.ts";

export * from "../core/daemon-lock.ts";
export { relaunchArgv };

// What a draining daemon takes besides GET, since none of it starts work:
// its own (errors, awake, the drain), a read whose question is in the body
// (which paths of a reply are files, what the transcript marks on its
// calls), what the page says by itself (which
// session the owner is at, alerts they have seen, the unsent draft of a message
// box, which a reload after the restart brings back), what the owner answers
// a running turn (the drain is waiting for that turn; the passkey check is
// for an answer from a remote device), and a stop.
const DRAIN_PASSES = new RegExp(
  "^/api/(?:" +
    "(?:errors|awake|drain)(?:/|$)" +
    "|presence$|connection$|alerts/read$" +
    "|owner-presence/authenticate/(?:start|finish)$" +
    "|sessions/[^/]+/(?:" +
      "files/exist|call-marks|interrupt|as-agent/stop|presence|draft(?:/files/[^/]+)?" +
      "|(?:approvals|questions|plan|secrets)/[^/]+" +
      "|(?:jobs|terminal|agents)/[^/]+/stop" +
    ")$" +
  ")",
);

// What a daemon whose store takes no writes (src/core/checkpoint.ts) takes
// besides GET: what stops work, what answers a running turn, and the way
// out. Whatever the store's state, the owner can stop what runs, answer what
// waits, and stop or restart the daemon. Each of these acts in memory and
// owes its writes (Store.orLater). So are what the page asks by itself and
// what keeps nothing in the store (which session the owner is at, a read
// whose question is in the body): turned away, the page would only ask
// again. What only writes (a draft, a setting, a new prompt) is turned away
// with the reason.
export const STORE_PASSES = new RegExp(
  "^/api/(?:" +
    "(?:errors|drain)(?:/|$)" +
    "|presence$|storage/retention/removed$" +
    "|owner-presence/authenticate/(?:start|finish)$" +
    "|sessions/[^/]+/(?:" +
      "files/exist|interrupt|as-agent/stop" +
      "|(?:approvals|questions|plan|secrets)/[^/]+" +
      "|(?:jobs|terminal|agents)/[^/]+/stop" +
    ")$" +
  ")",
);

// What the daemon before this one left to be said at this start (filled by the start: src/server/start.ts).
export const startNotes: string[] = [];
const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

// At a stop of the daemon, after the checkpoint thread is closed: what the
// store still owes is in its file, which the next start applies before
// anything else. `notes`: what to tell the one who asked; `lost`: the file
// could not be written, and the note says exactly what is lost with this
// daemon.
export async function owedAtStop(store: Store, how: "restart" | "stop"): Promise<{ notes: string[]; lost: boolean }> {
  let left: Awaited<ReturnType<Store["closeOwed"]>>;
  try { left = await store.closeOwed(); } catch (e) { return { notes: [`What the store owed at this ${how} could not be looked at: ${(e as Error).message}`], lost: true }; }
  const made = left.made ? `${left.made} write${left.made === 1 ? "" : "s"} from while the disk did not answer ${left.made === 1 ? "was" : "were"} made before the ${how}. ` : "";
  if (!left.owed) return { notes: made ? [made.trim()] : [], lost: false };
  if (left.lost.length) {
    const by = new Map<string, number>();
    for (const w of left.lost) by.set(w, (by.get(w) ?? 0) + 1);
    const what = [...by].map(([w, n]) => (n > 1 ? `${w} (${n})` : w)).join(", ");
    const kept = left.owed - left.lost.length;
    return { notes: [`${made}Not saved at the ${how} at ${clock(Date.now())}: the store's disk did not answer and the file that keeps what is owed ${kept ? "was full" : "could not be written"}. Lost: ${what}. A turn among them is closed as cut at the next start, and a card among them is asked again.${kept ? ` ${kept} other${kept === 1 ? " is" : "s are"} kept in the file for the next start.` : ""}`], lost: true };
  }
  return { notes: [`${made}${left.owed} write${left.owed === 1 ? "" : "s"} from while the disk did not answer ${left.owed === 1 ? "is" : "are"} kept in a file for the next start${left.synced ? "" : " (the disk has not confirmed the file: a loss of power now would lose it)"}.`], lost: false };
}

// What an exit waits for: every request taken has its answer, and the loop
// has turned so the answers and the last frames are written to their
// sockets. No fixed time: a restart is unanswered for as long as this takes.
// A request that is still open after EXIT_WAIT_MS does not hold the exit.
const EXIT_WAIT_MS = 200;
async function answersOut() {
  const turn = () => new Promise<void>((r) => setImmediate(r));
  const until = performance.now() + EXIT_WAIT_MS;
  await turn();
  while (unanswered() > 0 && performance.now() < until) await new Promise<void>((r) => setTimeout(r, 2));
  await turn();
  await turn();
}

// One stall as the Daemon panel lists it: when it ended, how long, and what took the time.
export type StallRow = { ts_ms: number; ms: number; what: string; kind: string; error_id?: string };
const STALLS_KEPT = 20;

export class Daemon {
  // `backup_since_ms`: the running turns had their time and the backup the
  // restart waits on is being made.
  // `notes`: what this stop or restart did not do or could not save, in words for the one who asked for it.
  draining: { since_ms: number; restart: boolean; deadline_ms: number; backup_since_ms?: number; notes?: string[] } | null = null;
  // The process's start (a hot reload makes a new Daemon in the same process).
  readonly started: number = ((globalThis as any).__keelStarted ??= Date.now());
  // The last restart that was called off (what had to hold before it did not),
  // until the next drain: the page and `keel restart` say so.
  restartFailed: { ts_ms: number; error: string } | null = null;
  // The process was told to stop (a signal): it stops, whatever a restart was doing.
  private stopping = false;
  private beforeExit: (() => void | Promise<void>)[] = [];
  private beforeRestart: (() => void | string | Promise<void | string>)[] = [];
  // The stalls of this process, the newest first (the Daemon panel lists them).
  private stalls: StallRow[] = [];
  private sight?: StallWatch;
  // What was last given back to the system, and why (the resources report shows it).
  rest?: Rest;

  constructor(private deps: Deps) {
    // While draining, nothing that would start work is taken.
    addAdmission((req, path) => {
      if (!this.draining || req.method === "GET" || req.method === "HEAD" || DRAIN_PASSES.test(path)) return;
      const why = this.draining.restart ? "the daemon is restarting and takes no new work until it is back" : "the daemon is stopping and takes no new work";
      return Response.json({ error: why, draining: true }, { status: 503 });
    });
  }

  onExit(f: () => void | Promise<void>) { this.beforeExit.push(f); }
  // What must hold before a restart (the backup). It runs once the running
  // turns had their time and before any is parked; one that fails calls the
  // restart off, and the daemon takes work again.
  // `f` may answer with what it made, in a few words (a backup's name): the log's line says it.
  onRestart(f: () => void | string | Promise<void | string>) { this.beforeRestart.push(f); }

  runningSessions(): string[] {
    return this.deps.store.db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((r) => r.id).filter((id) => this.deps.engine.isRunning(id));
  }

  // The daemon's own unresponsiveness (src/admin/stall.ts): each stall is one
  // error row and, through the capture, one log line. The error names no
  // stack: the code that held the loop is not on it any more.
  // It is started once the server listens (src/server/start.ts): the start-up
  // itself is not a stall of a daemon that was answering. Its timer is the
  // daemon's one periodic timer: the sign of life and the rest of what the
  // daemon does by the clock run from it.
  // What took the time comes from the watcher's thread (stall-watch.ts),
  // asked once the loop runs again: the row waits for its answer, never the
  // loop, and is written without one when none comes.
  // `onRow`: what else a stall's row becomes (its span in the trace of each turn that ran through it).
  watchStalls(dirs: Dirs, onRow?: (context: Record<string, unknown>, what: string, errorId?: string) => void): StallMonitor {
    const watch = new TurnWatch();
    // A turn that starts while the timer waits out its idle second brings its next tick forward.
    this.deps.bus.on((f) => { watch.frame(f as any); if (f.t === "event" && f.event.kind === "turn_start") monitor.wake(); });
    const G = globalThis as { __keelStallWatch?: StallWatch };
    G.__keelStallWatch?.stop();
    const sight = (G.__keelStallWatch = new StallWatch(dirs, (e) => this.deps.errors.capture("server", e, { at: "stall watcher" })));
    this.sight = sight;
    sight.start();
    const told = async (stall: Stall, row: boolean) => {
      const ended = Date.now();
      const d = describeStall({ ...stall, cause: await sight.ask(stall.ms, stall.window_ms ?? stall.ms) });
      if (!row) return console.warn(`[daemon] ${d.message}`);
      const context = { ...d.context, ended_ms: ended };
      const rec = this.deps.errors.capture("server", Object.assign(new Error(d.message), { stack: undefined }), context, { group: d.group });
      try { onRow?.(context, d.what, rec.id || undefined); } catch (e) { console.warn(`[daemon] a stall's span was not written: ${(e as Error).message}`); }
      this.stalls.unshift({ ts_ms: ended, ms: d.ms, what: d.what, kind: d.kind, ...(rec.id ? { error_id: rec.id } : {}) });
      // Kept past this process too: the away digest tells of the stalls of an absence.
      try { keepStall(this.deps.store.db, { ts_ms: ended, ms: d.ms, what: d.what, kind: d.kind }); } catch (e) { console.warn(`[daemon] a stall was not kept: ${(e as Error).message}`); }
      this.stalls.length = Math.min(this.stalls.length, STALLS_KEPT);
      this.emit();
    };
    // The monitor's timer is the daemon's one tick (src/core/pulse.ts): what
    // the daemon does by the clock runs from it, and when the daemon is
    // idle it rests until the first of those is due.
    const beats = pulse();
    const monitor = new StallMonitor({
      turns: (when) => watch.at(when),
      working: () => watch.running(),
      tick: (working) => beats.tick(working),
      idleMs: () => beats.delay(false),
      report: (stall) => void told(stall, true).catch((e) => this.deps.errors.capture("server", e, { at: "stall report" })),
      note: (stall) => void told(stall, false).catch(() => {}),
    });
    watchWith(monitor);
    beats.drivenBy(() => monitor.wake());
    // The sign of life: a second apart when the daemon works, the tick's longest rest apart when it is idle, and the sign says which.
    beats.join("sign of life", () => beatLife(monitor.working() ? 1000 : IDLE_MAX_MS), { every: 1000 });
    // The collector is asked for as long as the daemon works, as the runtime's own timer for it did (that
    // timer is off: src/core/relaunch.ts): at each tick after which the heap's size changed, ten times a
    // second at the most. Asked once a second only, the heap grew between two asks until a collection the
    // loop had to wait for (stalls of over a second under twelve working sessions).
    let heapWas = 0;
    beats.join("collector", () => {
      if (!monitor.working()) return;
      const size = heapSize();
      if (size === heapWas) return;
      heapWas = size;
      Bun.gc(false);
    }, { every: 100 });
    // Memory given back: once no turn has run for a minute, and when its unit's bound is passed (src/core/rest.ts).
    const rest = (this.rest = new Rest({ store: this.deps.store, say: (line) => this.deps.errors.capture("server", Object.assign(new Error(line), { stack: undefined }), { at: "memory pressure" }, { group: "memory pressure" }) }));
    beats.join("memory", (now) => rest.tick(watch.running(), now), { every: 1000, due: () => rest.due() });
    // A stall that began when the loop was idle, seen by the watcher alone.
    sight.onHeld = (ms) => void monitor.unsaid(ms);
    return monitor;
  }

  status() {
    return {
      pid: process.pid,
      started_ms: this.started,
      uptime_ms: Date.now() - this.started,
      state_dir: this.deps.store.stateDir,
      bun: Bun.version,
      build: buildInfo(),
      argv: relaunchArgv(),
      systemd: process.env.KEEL_SUPERVISED === "systemd",
      running: this.runningSessions(),
      draining: this.draining,
      // What the daemon before this one left to be said at this start (a restart that made no backup, writes it could not save).
      start_notes: startNotes,
      // The store's disk does not answer (src/core/checkpoint.ts): since when, and whether the store takes no writes by now.
      store: this.disk(),
      restart_failed: this.restartFailed,
      stalls: this.stalls,
      // The thread that looks at the main one when the loop is held, or why there is none.
      stall_watch: this.sight ? { running: this.sight.running, ...(this.sight.tid ? { tid: this.sight.tid } : {}), ...(this.sight.why ? { off: this.sight.why } : {}) } : null,
      // This start: when the daemon before it went down, how (when that is known), and what became of the turns that cut.
      last_start: restarts()?.last() ?? null,
      // The nine starts before it, each with the stalls of its life: the page keeps the last ten.
      earlier_starts: this.earlier(),
      // How long this start took and where the time went (src/core/start-trace.ts).
      start_times: startTimes() ?? null,
    };
  }

  // Read once a process: what is before this start does not change while it runs.
  private earlierRead?: EarlierStart[];
  private earlier(): EarlierStart[] {
    const now = restarts()?.last();
    if (!now) return [];
    try { return (this.earlierRead ??= earlierStarts(this.deps.store.db, now)); } catch { return []; }
  }

  private disk(): StoreDisk | null {
    return checkpointerOf(this.deps.store)?.said ?? null;
  }
  // The store's disk does not answer at all (not: it is slow).
  private silent(): boolean { return this.disk()?.silent_since_ms !== undefined; }

  emit() {
    this.deps.bus.emit({ t: "feature", name: "daemon", data: this.status() });
  }

  // New work is turned away from now on (the process is stopping).
  refuseWork() {
    this.stopping = true;
    if (this.draining) return;
    this.draining = { since_ms: Date.now(), restart: false, deadline_ms: Date.now() + Number(process.env.KEEL_DRAIN_MS ?? 10_000) };
    this.emit();
  }

  // Stops taking work, lets running turns finish until the deadline, and the
  // engine parks the rest (their end reason is "restart": the next daemon
  // continues them once). Then it exits, and starts again for a restart.
  // `reason`: why, in a few words, for the log's line (who asked, or what for).
  async drain(opts: { timeoutMs: number; restart: boolean; reason?: string }) {
    if (this.draining) {
      this.draining.restart ||= opts.restart; // a second ask can add the restart
      this.emit();
      return this.finished;
    }
    this.draining = { since_ms: Date.now(), restart: opts.restart, deadline_ms: Date.now() + opts.timeoutMs };
    this.restartFailed = null;
    // With the store's disk not answering nothing is made before the
    // restart (a backup would wait on the same disk, and a restart is the
    // way out the daemon itself names). It is said where the one who asked
    // reads it: in the answer to the request, by `keel restart`, and in
    // Errors at the next start.
    // (Said once: the words carry the time the restart was asked, not the time they are said again.)
    const words = `No backup was made before the restart at ${clock(Date.now())}: the store's disk did not answer.`;
    const noBackup = () => {
      if (this.silent() && this.draining!.restart && this.beforeRestart.length) this.say(words);
      return this.silent();
    };
    noBackup();
    this.emit();
    say(drainLine({ restart: opts.restart, running: this.runningSessions().length, timeoutMs: opts.timeoutMs, reason: opts.reason }));
    this.finished = (async () => {
      await this.deps.engine.settle(opts.timeoutMs);
      const silent = noBackup();
      if (this.draining!.restart && !silent) {
        const t0 = Date.now();
        try {
          if (this.beforeRestart.length) { this.draining!.backup_since_ms = Date.now(); this.emit(); }
          // What each step says it made (the backup's name) goes on the log's line.
          const made: string[] = [];
          for (const f of this.beforeRestart) { const said = await f(); if (typeof said === "string" && said) made.push(said); }
          if (made.length) say(backupLine({ ok: true, ms: Date.now() - t0, name: made.join(", ") }));
        } catch (e) {
          say(backupLine({ ok: false, ms: Date.now() - t0, error: (e as Error)?.message }), "warn");
          // Called off before a turn was cut: this daemon goes on as it was.
          const rec = this.deps.errors.capture("server", e, { at: "before a restart" });
          this.restartFailed = { ts_ms: Date.now(), error: rec.message };
          // A stop by signal meanwhile goes on (main.ts parks the turns and exits): no turn starts.
          if (this.stopping) return this.emit();
          this.draining = null;
          this.deps.engine.undrain();
          flushAll();
          this.emit();
          return;
        }
      }
      let parked = 0;
      const off = this.deps.bus.on((f) => { if (f.t === "event" && f.event.kind === "turn_end" && f.event.data?.reason === "restart") parked++; });
      await this.deps.engine.park();
      off();
      say(exitLine({ restart: this.draining!.restart, parked, upMs: Date.now() - this.started, reason: opts.reason }));
      for (const f of this.beforeExit) await (async () => f())().catch((e) => this.deps.errors.capture("server", e, { at: "shutdown" }));
      // What the store still owes (the owner's stops and answers from while its disk did not answer) is
      // in its file for the next start, or is said exactly when that file could not be written either.
      const left = await owedAtStop(this.deps.store, this.draining!.restart ? "restart" : "stop");
      for (const n of left.notes) this.say(n, false);
      this.deps.providers.shutdown();
      endLife(this.draining!.restart ? "restart" : "stop");
      if (this.draining!.restart) this.relaunch();
      this.emit();
      // Under systemd a restart exits 75 (EX_TEMPFAIL): Restart=on-failure starts it again.
      const code = this.draining!.restart && process.env.KEEL_SUPERVISED === "systemd" ? 75 : 0;
      // A word about what was owed stays up for the command that follows the stop: it reads the daemon twice a second.
      if (left.notes.length) await new Promise<void>((r) => setTimeout(r, 1500));
      // The answers still on their way go out first (the request that asked for the drain, a page's last read).
      await answersOut();
      process.exit(code);
    })();
    return this.finished;
  }
  private finished?: Promise<void>;

  // A word about this stop or restart: in the daemon's state (the answer, the command line), on the
  // console, and kept for the next start (`next`: unless the file it would be kept in is what failed).
  private say(note: string, next = true) {
    const d = this.draining;
    if (!d || d.notes?.includes(note)) return;
    (d.notes ??= []).push(note);
    console.error(`[daemon] ${note}`);
    if (next) try { this.deps.store.noteNext(note); } catch {}
  }

  private relaunch() {
    // Under systemd (the unit sets KEEL_SUPERVISED) the unit starts it again; a child would
    // die with the unit's cgroup.
    if (process.env.KEEL_SUPERVISED === "systemd") return;
    const argv = relaunchArgv();
    const p = Bun.spawn(argv, {
      cwd: process.cwd(),
      // (What this daemon has to say to the next start goes with it too: the file may be what could not be written.)
      env: { ...process.env, KEEL_WAIT_FOR_PID: String(process.pid), ...(this.draining?.notes?.length ? { KEEL_START_NOTES: JSON.stringify(this.draining.notes) } : {}) },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    p.unref();
    handLock(this.deps.store.stateDir, p.pid);
  }
}
