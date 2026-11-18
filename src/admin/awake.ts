// Keeps the machine from sleeping while a turn works (and while the owner asks
// for a timed hold), through logind's inhibitor lock: `systemd-inhibit` holds
// it for as long as its child runs. The child is `cat` on a pipe from the
// daemon, so a daemon that dies, however it dies, closes the pipe and the lock
// goes with it: no inhibitor is ever left behind.
import type { Subprocess } from "bun";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Bus } from "../core/bus.ts";
import { registerSettings, settings } from "./settings.ts";

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

export class Awake {
  private proc?: Subprocess<"pipe", "ignore", "pipe">;
  private working = new Set<string>();
  private untilMs: number | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private since?: number;
  private reason?: string;
  private locked = false;
  refused?: string;
  readonly available = process.platform === "linux" && which("systemd-inhibit") && existsSync("/run/dbus/system_bus_socket");
  draining = false;

  constructor(private bus: Bus, private capture: (e: unknown, ctx?: unknown) => void) {
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
    if (untilMs) this.refused = undefined; // asking again after a refusal tries again
    this.update();
  }

  private want(): string | undefined {
    if (this.untilMs && this.untilMs > Date.now()) return `held until ${new Date(this.untilMs).toISOString()}`;
    if (settings().keep_awake.mode === "never") return undefined;
    if (this.working.size) return `${this.working.size} turn${this.working.size > 1 ? "s" : ""} running`;
    if (this.draining) return "finishing turns before a restart";
    return undefined;
  }

  update() {
    const why = this.want();
    if (!why || !this.available) return this.release();
    if (this.refused) return;
    if (this.proc && this.reason === why) return;
    // The reason shown in the lock list changes with the count: take a new lock first.
    const old = this.proc;
    this.start(why);
    if (old) this.stop(old);
  }

  private start(why: string) {
    const p = Bun.spawn(["systemd-inhibit", "--what=sleep:idle", "--who=keel-bun", `--why=${why} (daemon pid ${process.pid})`, "--mode=block", "cat"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    this.proc = p;
    this.reason = why;
    this.since ??= Date.now();
    this.locked = false;
    // logind answers at once; a lock still held after half a second was handed out.
    setTimeout(() => { if (this.proc === p && p.exitCode === null) { this.locked = true; this.emit(); } }, 500);
    p.exited.then(async (code) => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.locked = false;
      const err = (await new Response(p.stderr).text().catch(() => "")).trim();
      this.refused = err || `systemd-inhibit ended with ${code}`;
      this.capture(new Error(`keep-awake refused: ${this.refused}`), { at: "keep-awake" });
      this.emit();
    });
    this.emit();
  }

  private stop(p: Subprocess<"pipe", "ignore", "pipe">) {
    try { p.stdin.end(); } catch {}
    p.kill();
  }

  private release() {
    if (!this.want()) this.refused = undefined; // the reason went: the next one asks again
    if (!this.proc) { if (this.since) { this.since = undefined; this.emit(); } return; }
    const p = this.proc;
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
