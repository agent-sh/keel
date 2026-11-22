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
export function withoutCollectorTimer() {
  if (process.env.BUN_GC_TIMER_DISABLE !== undefined) return;
  const execve = (process as { execve?: (file: string, args: string[], env: Record<string, string | undefined>) => never }).execve;
  if (typeof execve !== "function" || process.platform === "win32") return;
  // Under the runtime's profiler or inspector the process is signalled all the time, and a signal that lands as the
  // program is replaced ends it (seen with --cpu-prof): such a run keeps the timer.
  if (process.execArgv.some((a) => /^--(cpu-prof|heap-prof|inspect)/.test(a))) return;
  const argv = relaunchArgv();
  try { execve.call(process, argv[0]!, argv, { ...process.env, BUN_GC_TIMER_DISABLE: "1" }); } catch {}
}
