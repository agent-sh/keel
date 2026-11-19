// The daemon's own life: one daemon per state folder, a drain that turns new
// work away while the engine lets running turns finish and parks the rest,
// and a restart that starts the same binary again. Continuing parked and
// crash-cut turns is the engine's (Engine.recover, from main.ts).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../server/app.ts";
import { addAdmission } from "../server/admission.ts";

const LOCK = "daemon.lock";

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

// Refuses a second daemon on the same state folder. A lock left by a daemon
// that died is taken over. A restart passes the old pid: wait for it to exit.
export function acquireLock(stateDir: string) {
  const path = join(stateDir, LOCK);
  waitForPredecessor();
  if (existsSync(path)) {
    const held = JSON.parse(readFileSync(path, "utf8") || "{}") as { pid?: number; bind?: string };
    if (held.pid && held.pid !== process.pid && alive(held.pid)) {
      console.error(`keel: another daemon (pid ${held.pid}${held.bind ? `, ${held.bind}` : ""}) uses ${stateDir}`);
      process.exit(1);
    }
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, started_ms: Date.now(), argv: process.argv.slice(1) }), { mode: 0o600 });
  process.on("exit", () => {
    try { if (JSON.parse(readFileSync(path, "utf8")).pid === process.pid) rmSync(path); } catch {}
  });
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

export class Daemon {
  draining: { since_ms: number; restart: boolean; deadline_ms: number } | null = null;
  // The process's start (a hot reload makes a new Daemon in the same process).
  readonly started: number = ((globalThis as any).__keelStarted ??= Date.now());
  private beforeExit: (() => void | Promise<void>)[] = [];

  constructor(private deps: Deps) {
    // While draining, nothing that would start work is taken.
    addAdmission((req, path) => {
      if (!this.draining || req.method === "GET" || req.method === "HEAD") return;
      if (/^\/api\/(errors|awake|drain|sessions\/[^/]+\/interrupt)(\/|$)/.test(path)) return;
      return Response.json({ error: "the daemon is draining for a restart; try again when it is back", draining: true }, { status: 503 });
    });
  }

  onExit(f: () => void | Promise<void>) { this.beforeExit.push(f); }

  runningSessions(): string[] {
    return this.deps.store.db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((r) => r.id).filter((id) => this.deps.engine.isRunning(id));
  }

  status() {
    return {
      pid: process.pid,
      started_ms: this.started,
      uptime_ms: Date.now() - this.started,
      state_dir: this.deps.store.stateDir,
      bun: Bun.version,
      argv: relaunchArgv(),
      systemd: process.env.KEEL_SUPERVISED === "systemd",
      running: this.runningSessions(),
      draining: this.draining,
    };
  }

  private emit() {
    this.deps.bus.emit({ t: "feature", name: "daemon", data: this.status() });
  }

  // New work is turned away from now on (the process is stopping).
  refuseWork() {
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
    this.emit();
    this.finished = (async () => {
      await this.deps.engine.drain(opts.timeoutMs);
      for (const f of this.beforeExit) await Promise.resolve(f()).catch((e) => this.deps.errors.capture("server", e, { at: "shutdown" }));
      this.deps.providers.shutdown();
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
  }
}
