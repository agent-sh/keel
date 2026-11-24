import { execClean, restoreSecretEnv, startedWithSecrets, wasCleaned } from "../safety/closed-env.ts";

// The command that starts this process again: a compiled binary is its own
// path; under bun it is bun with its flags (--hot) and the script.
export function relaunchArgv(): string[] {
  const a = process.argv;
  if (a[1]?.startsWith("/$bunfs/") || a[1]?.startsWith("B:/~BUN/")) return [process.execPath, ...a.slice(2)];
  return [process.execPath, ...process.execArgv, ...a.slice(1)];
}

// The runtime keeps a collector timer in every thread: a collection each
// second, and one more a few milliseconds after any turn of the event loop
// that changed the heap's size, for as long as something allocates at least
// twice a minute. Each collection wakes the collector's helper threads. In a
// daemon with nothing to do that was 130 to 200 wakeups a second, most of
// what an idle daemon did. The daemon runs without that timer: the
// collector still runs when allocation calls for it, the daemon asks it once
// a second while it works (src/admin/daemon.ts) and for a whole collection
// when it comes to rest (src/core/rest.ts).
//
// The runtime reads the setting once, when it starts, so a daemon started
// without it becomes the same program again with it: the same process id,
// the same arguments, nothing opened yet. A unit that sets the variable
// (src/admin/unit.ts) skips this. Where the call does not exist, or fails,
// the daemon runs as it was started.
//
// The setting is the daemon's alone. Once the runtime has it (it is read at
// the start, and the daemon's own threads take it from the runtime, not
// from the environment), it is taken out of the environment the daemon
// gives to what it starts: a session's commands, MCP and language servers,
// hooks and agents are built from `process.env`, and a program of the same
// runtime among them keeps its own collector timer.
export function withoutCollectorTimer() {
  const g = globalThis as { __keelCollectorTimer?: "off" | "kept" };
  if (g.__keelCollectorTimer) return;
  if (process.env.BUN_GC_TIMER_DISABLE !== undefined) {
    g.__keelCollectorTimer = "off";
    delete process.env.BUN_GC_TIMER_DISABLE;
    return;
  }
  g.__keelCollectorTimer = "kept";
  if (!canExec()) return;
  const argv = relaunchArgv();
  // The same exec takes the secrets out of the environment (src/safety/closed-env.ts).
  execClean(argv, { ...process.env, BUN_GC_TIMER_DISABLE: "1" });
}

// Whether this process can start itself again in place. Under the runtime's profiler or inspector the
// process is signalled all the time, and a signal that lands as the program is replaced ends it (seen
// with --cpu-prof): such a run is not started again.
function canExec(): boolean {
  const execve = (process as { execve?: unknown }).execve;
  if (typeof execve !== "function" || process.platform === "win32") return false;
  return !process.execArgv.some((a) => /^--(cpu-prof|heap-prof|inspect)/.test(a));
}

// The daemon's environment holds no secret (src/safety/closed-env.ts): when it was started with some in
// it, which the collector's exec above did not take out (the unit that started it sets the collector's
// variable, so there was none), the process is started again once without them. The exec leaves a mark;
// a process that finds it does not look again.
export function withoutSecretEnvironment() {
  if (wasCleaned()) return;
  if (!startedWithSecrets()?.length || !canExec()) return;
  const g = globalThis as { __keelCollectorTimer?: "off" | "kept" };
  execClean(relaunchArgv(), g.__keelCollectorTimer === "off" ? { ...process.env, BUN_GC_TIMER_DISABLE: "1" } : { ...process.env });
}

// What the daemon does first, in this order: starts again without the collector timer and without the
// secrets in its environment (one exec), takes the secrets from the pipe the new image was given, and
// starts again once more if it still holds some (a unit that set the collector's variable).
export function startClean() {
  withoutCollectorTimer();
  restoreSecretEnv();
  withoutSecretEnvironment();
}
