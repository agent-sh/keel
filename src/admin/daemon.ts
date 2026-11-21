// The daemon's own life: one daemon per state folder, a drain that turns new
// work away while the engine lets running turns finish and parks the rest,
// and a restart that starts the same binary again. Continuing parked and
// crash-cut turns is the engine's (Engine.recover, from main.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Deps } from "../server/app.ts";
import { flushAll } from "../automation/core.ts";
import { buildInfo } from "../core/build.ts";
import { claimState, hasClaim } from "../core/claim.ts";
import { addAdmission } from "../server/admission.ts";
import { beatLife, endLife, restarts } from "./life.ts";
import { describeStall, type Stall, StallMonitor, TurnWatch, watchWith } from "./stall.ts";
import type { Dirs } from "./stall-cause.ts";
import { StallWatch } from "./stall-watch.ts";

export { claimState };

const LOCK = "daemon.lock";

// The daemon a service manager runs (KEEL_SUPERVISED) is the machine's own,
// whatever state folder its unit names: it leaves a note in the user's runtime
// folder so a bare client command finds it without --url or --state-dir.
export const serviceNote = () =>
  join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "keel-bun", "service.json");

export function servicedDaemon(): { pid: number; url: string; state_dir: string } | undefined {
  try {
    const n = JSON.parse(readFileSync(serviceNote(), "utf8"));
    return n.pid && n.url && n.state_dir && alive(n.pid) ? n : undefined;
  } catch { return undefined; }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as any).code === "EPERM"; }
};

// A restart passes the old daemon's pid: wait (up to a minute) until it exits.
export function waitForPredecessor() {
  const waitFor = Number(process.env.KEEL_WAIT_FOR_PID || 0);
  if (waitFor && waitFor !== process.pid) {
    const until = Date.now() + 60_000;
    while (alive(waitFor) && Date.now() < until) Bun.sleepSync(100);
  }
  delete process.env.KEEL_WAIT_FOR_PID;
}

// Who answers on host:port, if anything does: Bun lets a second server bind a
// port another process listens on, and both then answer. A Keel daemon says
// its pid and state folder.
export async function portHolder(host: string, port: number): Promise<string | null> {
  const h = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const open = await Bun.connect({ hostname: h, port, socket: { data() {}, error() {} } }).then((s) => (s.end(), true), () => false);
  if (!open) return null;
  try {
    const r = await fetch(`http://${h.includes(":") ? `[${h}]` : h}:${port}/api/daemon`, { signal: AbortSignal.timeout(1500) });
    const d = (await r.json()) as { pid?: number; state_dir?: string };
    if (d.pid) return `a Keel daemon (pid ${d.pid}, state ${d.state_dir ?? "?"})`;
  } catch {}
  return "another program";
}

// Refuses a second daemon on the same state folder, before anything of the
// state is opened. A restart passes the old pid: wait for it to exit. The
// lock file says who holds the folder and where it answers; one left by a
// daemon that died is written over.
export function acquireLock(stateDir: string) {
  if (hasClaim(stateDir)) return;
  const path = join(stateDir, LOCK);
  waitForPredecessor();
  const held = () => {
    try { return JSON.parse(readFileSync(path, "utf8") || "{}") as { pid?: number; url?: string }; } catch { return {}; }
  };
  const refuse = (h: { pid?: number; url?: string }) => {
    console.error(`keel: another daemon${h.pid && alive(h.pid) ? ` (pid ${h.pid}${h.url ? `, ${h.url}` : ""})` : ""} uses ${stateDir}`);
    process.exit(1);
  };
  if (!claimState(stateDir)) refuse(held());
  // A live daemon named in the lock file holds the folder whatever the claim
  // says: a daemon from before the claim has none, and a claim can be lost
  // (the kernel drops it when its holder closes any handle of the file).
  const h = held();
  if (h.pid && h.pid !== process.pid && alive(h.pid)) refuse(h);
  writeFileSync(path, JSON.stringify({ pid: process.pid, started_ms: Date.now(), argv: process.argv.slice(1) }), { mode: 0o600 });
  process.on("exit", () => {
    try { if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) rmSync(path); } catch {}
  });
}

// A restart hands the folder's lock to the daemon it started, before this one
// exits: the lock names a live daemon all the way through, so what follows the
// folder by its lock (the dev launcher, a client command) sees one daemon
// replaced by the next and never an unowned folder. The new daemon writes its
// own lock once it holds the claim; this one's exit leaves a lock that is no
// longer its own alone.
export function handLock(stateDir: string, pid: number) {
  const path = join(stateDir, LOCK);
  try {
    const held = JSON.parse(readFileSync(path, "utf8"));
    if (held.pid === process.pid) writeFileSync(path, JSON.stringify({ ...held, pid }), { mode: 0o600 });
  } catch {}
}

// The address the daemon answers at, kept in its lock so a client command
// finds it from the state folder alone. `client` marks a daemon a command
// started inside its own process (it ends with the command).
export function recordUrl(stateDir: string, url: string, client = false) {
  const path = join(stateDir, LOCK);
  try {
    const held = JSON.parse(readFileSync(path, "utf8"));
    if (held.pid !== process.pid) return;
    writeFileSync(path, JSON.stringify({ ...held, url, ...(client ? { client: true } : {}) }), { mode: 0o600 });
  } catch {}
  if (client || !process.env.KEEL_SUPERVISED) return;
  const note = serviceNote();
  try {
    mkdirSync(dirname(note), { recursive: true, mode: 0o700 });
    writeFileSync(note, JSON.stringify({ pid: process.pid, url, state_dir: stateDir }), { mode: 0o600 });
    process.on("exit", () => {
      try { if (JSON.parse(readFileSync(note, "utf8")).pid === process.pid) rmSync(note); } catch {}
    });
  } catch {}
}

export function lockedDaemon(stateDir: string): { pid: number; url?: string; client?: boolean } | undefined {
  try {
    const held = JSON.parse(readFileSync(join(stateDir, LOCK), "utf8"));
    return held.pid && alive(held.pid) ? held : undefined;
  } catch { return undefined; }
}

export function lockHolder(stateDir: string): number | undefined {
  try {
    const pid = JSON.parse(readFileSync(join(stateDir, LOCK), "utf8")).pid as number;
    return pid && alive(pid) ? pid : undefined;
  } catch { return undefined; }
}

// The command that starts this daemon again: a compiled binary is its own
// path; under bun it is bun with its flags (--hot) and the script.
export function relaunchArgv(): string[] {
  const a = process.argv;
  if (a[1]?.startsWith("/$bunfs/") || a[1]?.startsWith("B:/~BUN/")) return [process.execPath, ...a.slice(2)];
  return [process.execPath, ...process.execArgv, ...a.slice(1)];
}

// What a draining daemon takes besides GET, since none of it starts work:
// its own (errors, awake, the drain), a read whose question is in the body
// (which paths of a reply are files), what the page says by itself (which
// session the owner is at, alerts they have seen, the unsent draft of a message
// box, which a reload after the restart brings back), what the owner answers
// a running turn (the drain is waiting for that turn; the passkey check is
// for an answer from a remote device), and a stop.
const DRAIN_PASSES = new RegExp(
  "^/api/(?:" +
    "(?:errors|awake|drain)(?:/|$)" +
    "|presence$|alerts/read$" +
    "|owner-presence/authenticate/(?:start|finish)$" +
    "|sessions/[^/]+/(?:" +
      "files/exist|interrupt|as-agent/stop|presence|draft(?:/files/[^/]+)?" +
      "|(?:approvals|questions|plan|secrets)/[^/]+" +
      "|(?:jobs|terminal|agents)/[^/]+/stop" +
    ")$" +
  ")",
);

// One stall as the Daemon panel lists it: when it ended, how long, and what took the time.
export type StallRow = { ts_ms: number; ms: number; what: string; kind: string; error_id?: string };
const STALLS_KEPT = 20;

export class Daemon {
  // `backup_since_ms`: the running turns had their time and the backup the
  // restart waits on is being made.
  draining: { since_ms: number; restart: boolean; deadline_ms: number; backup_since_ms?: number } | null = null;
  // The process's start (a hot reload makes a new Daemon in the same process).
  readonly started: number = ((globalThis as any).__keelStarted ??= Date.now());
  // The last restart that was called off (what had to hold before it did not),
  // until the next drain: the page and `keel restart` say so.
  restartFailed: { ts_ms: number; error: string } | null = null;
  // The process was told to stop (a signal): it stops, whatever a restart was doing.
  private stopping = false;
  private beforeExit: (() => void | Promise<void>)[] = [];
  private beforeRestart: (() => void | Promise<void>)[] = [];
  // The stalls of this process, the newest first (the Daemon panel lists them).
  private stalls: StallRow[] = [];
  private sight?: StallWatch;

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
  onRestart(f: () => void | Promise<void>) { this.beforeRestart.push(f); }

  runningSessions(): string[] {
    return this.deps.store.db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((r) => r.id).filter((id) => this.deps.engine.isRunning(id));
  }

  // The daemon's own unresponsiveness (src/admin/stall.ts): each stall is one
  // error row and, through the capture, one log line. The error names no
  // stack: the code that held the loop is not on it any more.
  // It is started once the server listens (src/server/start.ts): the start-up
  // itself is not a stall of a daemon that was answering. Its timer is the
  // daemon's one periodic timer: the sign of life is written from it.
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
      this.stalls.length = Math.min(this.stalls.length, STALLS_KEPT);
      this.emit();
    };
    const monitor = new StallMonitor({
      turns: (began) => watch.at(began),
      working: () => watch.running(),
      tick: beatLife,
      report: (stall) => void told(stall, true).catch((e) => this.deps.errors.capture("server", e, { at: "stall report" })),
      note: (stall) => void told(stall, false).catch(() => {}),
    });
    watchWith(monitor);
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
      restart_failed: this.restartFailed,
      stalls: this.stalls,
      // The thread that looks at the main one when the loop is held, or why there is none.
      stall_watch: this.sight ? { running: this.sight.running, ...(this.sight.tid ? { tid: this.sight.tid } : {}), ...(this.sight.why ? { off: this.sight.why } : {}) } : null,
      // This start: when the daemon before it went down, how (when that is known), and what became of the turns that cut.
      last_start: restarts()?.last() ?? null,
    };
  }

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
  async drain(opts: { timeoutMs: number; restart: boolean }) {
    if (this.draining) {
      this.draining.restart ||= opts.restart; // a second ask can add the restart
      this.emit();
      return this.finished;
    }
    this.draining = { since_ms: Date.now(), restart: opts.restart, deadline_ms: Date.now() + opts.timeoutMs };
    this.restartFailed = null;
    this.emit();
    this.finished = (async () => {
      await this.deps.engine.settle(opts.timeoutMs);
      if (this.draining!.restart) {
        try {
          if (this.beforeRestart.length) { this.draining!.backup_since_ms = Date.now(); this.emit(); }
          for (const f of this.beforeRestart) await f();
        } catch (e) {
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
      await this.deps.engine.park();
      for (const f of this.beforeExit) await (async () => f())().catch((e) => this.deps.errors.capture("server", e, { at: "shutdown" }));
      this.deps.providers.shutdown();
      endLife(this.draining!.restart ? "restart" : "stop");
      if (this.draining!.restart) this.relaunch();
      // Let the last frames and the HTTP answer go out. Under systemd a
      // restart exits 75 (EX_TEMPFAIL): Restart=on-failure starts it again.
      const code = this.draining!.restart && process.env.KEEL_SUPERVISED === "systemd" ? 75 : 0;
      setTimeout(() => process.exit(code), 200);
    })();
    return this.finished;
  }
  private finished?: Promise<void>;

  private relaunch() {
    // Under systemd (the unit sets KEEL_SUPERVISED) the unit starts it again; a child would
    // die with the unit's cgroup.
    if (process.env.KEEL_SUPERVISED === "systemd") return;
    const argv = relaunchArgv();
    const p = Bun.spawn(argv, {
      cwd: process.cwd(),
      env: { ...process.env, KEEL_WAIT_FOR_PID: String(process.pid) },
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
    });
    p.unref();
    handLock(this.deps.store.stateDir, p.pid);
  }
}
