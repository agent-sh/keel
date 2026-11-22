// Keeps the machine from sleeping while a turn works (and while the owner asks
// for a timed hold), through logind's inhibitor lock: `systemd-inhibit` holds
// it for as long as its child runs. The child is `cat` on a pipe from the
// daemon, so a daemon that dies, however it dies, closes the pipe and the lock
// goes with it: no inhibitor is ever left behind.
// One lock is held for as long as any reason holds: it is taken when the
// first reason appears and given back when the last is gone. The reasons
// between (another turn starts, one ends, a loop comes due) change what the
// daemon shows, not the lock, so a dozen working sessions start one
// `systemd-inhibit`, not one at each change of their count.
// A machine whose logind does not give this account the lock (a server reached
// over ssh, a container) says so at once. That is how the machine is set up,
// not a failure of a turn: it is written to the log once, shown in the
// daemon's state, and not asked again at every turn. Only a hold the owner
// asks for asks again, and a refusal of that one is an error they are shown.
import { zonedStamp } from "../core/clock.ts";
import type { Subprocess } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Bus } from "../core/bus.ts";
import { registerSettings, settings } from "./settings.ts";
import { readText } from "../core/proc.ts";

registerSettings("keep_awake", { mode: "turns" }, (v) => (["turns", "never"].includes(v.mode) ? undefined : "mode is turns or never"));

function onBattery(): boolean {
  try {
    const dir = "/sys/class/power_supply";
    let battery = false;
    for (const d of readdirSync(dir)) {
      const type = readFileSync(`${dir}/${d}/type`, "utf8").trim();
      if (type === "Mains" && readFileSync(`${dir}/${d}/online`, "utf8").trim() === "1") return false;
      if (type === "Battery") battery = true;
    }
    return battery;
  } catch { return false; }
}

const which = (bin: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(`${d}/${bin}`));

// Other modules add reasons to stay awake (a loop whose next run is near) and
// hear when a hold ends (the activity list). `recheck` asks again when a reason
// may have changed without a session frame.
export const awakeReasons: (() => string | undefined)[] = [];
export const awakeHolds: { ended?: (since: number, ms: number, reason: string) => void } = {};
let current: Awake | undefined;
export const recheckAwake = () => current?.update();

// The lock's process: `systemd-inhibit` in the daemon, a stand-in in a test.
type Lock = Pick<Subprocess<"pipe", "ignore", "pipe">, "stdin" | "stderr" | "exited" | "exitCode" | "kill">;
const inhibit = (why: string): Lock => Bun.spawn(["systemd-inhibit", "--what=sleep:idle", "--who=keel-bun", `--why=${why}`, "--mode=block", "cat"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });

export class Awake {
  private proc?: Lock;
  private working = new Set<string>();
  private untilMs: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private since?: number;
  private reason?: string;
  private locked = false;
  refused?: string;
  // logind refused a lock that turns wanted: the answer stands until the owner asks for a hold.
  private denied = false;
  readonly available: boolean;
  draining = false;

  private firstReason?: string;

  // `lock`: what takes the lock (a test's stand-in; the daemon asks logind).
  constructor(private bus: Bus, private capture: (e: unknown, ctx?: unknown) => void, private lock?: (why: string) => Lock) {
    this.available = lock ? true : process.platform === "linux" && which("systemd-inhibit") && existsSync("/run/dbus/system_bus_socket");
    current = this;
    bus.on((f) => {
      if (f.t !== "session") return;
      if (f.session.phase === "working") this.working.add(f.session.id);
      else this.working.delete(f.session.id);
      this.update();
    });
  }

  // A hold until a time, or null to end it.
  hold(untilMs: number | null) {
    clearTimeout(this.timer);
    this.untilMs = untilMs;
    if (untilMs) this.timer = setTimeout(() => { this.untilMs = null; this.update(); }, untilMs - Date.now());
    if (untilMs) { this.refused = undefined; this.denied = false; } // asking again after a refusal tries again
    this.update();
  }

  private want(): string | undefined {
    if (this.untilMs && this.untilMs > Date.now()) return `held until ${zonedStamp(this.untilMs)}`;
    if (settings().keep_awake.mode === "never") return undefined;
    if (this.working.size) return `${this.working.size} turn${this.working.size > 1 ? "s" : ""} running`;
    if (this.draining) return "finishing turns before a restart";
    for (const r of awakeReasons) {
      const why = r();
      if (why) return why;
    }
    return undefined;
  }

  update() {
    const why = this.want();
    if (!why || !this.available) return this.release();
    if (this.refused) return;
    // Held already: the lock stays, only the reason shown follows.
    if (this.proc) {
      if (this.reason !== why) { this.reason = why; this.emit(); }
      return;
    }
    this.start(why);
  }

  private start(why: string) {
    // The lock list names the daemon; why it holds now is in the daemon's own state.
    const p = (this.lock ?? inhibit)(`a turn, a hold or a loop that is due (daemon pid ${process.pid})`);
    this.proc = p;
    this.reason = why;
    this.since ??= Date.now();
    this.firstReason ??= why;
    this.locked = false;
    // logind answers at once; a lock still held after half a second was handed out.
    setTimeout(() => { if (this.proc === p && p.exitCode === null) { this.locked = true; this.emit(); } }, 500).unref?.();
    p.exited.then(async (code) => {
      if (this.proc !== p) return;
      this.proc = undefined;
      const granted = this.locked;
      this.locked = false;
      const err = (await readText(p.stderr).catch(() => "")).trim();
      this.refused = err || `systemd-inhibit ended with ${code}`;
      // Refused at once, with nobody asking for a hold: this machine does not give the lock.
      if (!granted && !this.untilMs) {
        this.denied = true;
        console.warn(`[keep-awake] logind refused the lock (${this.refused}): the machine is not kept awake while turns run, and is not asked again until a hold is asked for`);
      } else this.capture(new Error(`keep-awake refused: ${this.refused}`), { at: "keep-awake" });
      this.emit();
    });
    this.emit();
  }

  private stop(p: Lock) {
    try { p.stdin.end(); } catch {}
    p.kill();
  }

  private release() {
    if (!this.want() && !this.denied) this.refused = undefined; // the reason went: the next one asks again
    if (!this.proc) { if (this.since) { this.since = undefined; this.emit(); } return; }
    const p = this.proc;
    if (this.since) {
      try { awakeHolds.ended?.(this.since, Date.now() - this.since, this.firstReason ?? this.reason ?? ""); } catch (e) { this.capture(e, { at: "keep-awake hold ended" }); }
    }
    this.firstReason = undefined;
    this.proc = undefined;
    this.locked = false;
    this.since = undefined;
    this.reason = undefined;
    this.stop(p);
    this.emit();
  }

  stopAll() { this.untilMs = null; this.working.clear(); this.release(); }

  state() {
    return {
      available: this.available && !this.refused,
      held: !!this.proc,
      locked: this.locked,
      mode: settings().keep_awake.mode as string,
      on_battery: onBattery(),
      since_ms: this.since,
      reason: this.reason,
      refused: this.refused,
      until_ms: this.untilMs ?? undefined,
    };
  }

  private emit() { this.bus.emit({ t: "feature", name: "awake", data: this.state() }); }
}
