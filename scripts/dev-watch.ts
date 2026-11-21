// Dev only: the launcher of the dev daemon (scripts/dev.sh), and what
// `bun --hot` and Bun's dev bundler miss by themselves.
//
//   bun scripts/dev-watch.ts <state-dir> -- <daemon command...>
//
// It starts the daemon and stays for as long as its daemon holds the state
// folder: a dev daemon that restarts itself hands the folder's lock to the
// process it started, and the launcher follows the lock to it, so reloads go
// on. Stopping the launcher (Ctrl-C, SIGTERM) stops that daemon as one signal
// to it does: its turns drain. A daemon that ended, or was stopped from
// outside, takes the launcher with it within a moment.
//
// What it watches:
// - Bun's dev bundler rebuilds the stylesheet when ui/src/styles.css changes
//   or is replaced, but not when a file it imports does: when any other
//   stylesheet under ui/src changes or is replaced (a checkout, a rebase),
//   styles.css is poked.
// - `bun --hot` stops watching a source file that went missing and came back
//   (a rebase or checkout passing through a commit without it): later edits
//   to it reload nothing. When a file under src/ appears, src/main.ts is
//   poked: the reload that follows watches the whole module graph again.
// - A changed package.json or bun.lock (a lane added a dependency) runs
//   `bun install` first, one install at a time, so the reload finds the new
//   package. A failed install is reported and reloads nothing.
//
// A poke writes the first byte of a file back in place through one
// descriptor: watchers take the file as changed, its content never changes,
// nothing is truncated, and a file git replaced meanwhile is not written.
import { closeSync, existsSync, openSync, readFileSync, readSync, watch, writeSync } from "node:fs";
import { join } from "node:path";

export function poke(file: string) {
  let fd: number;
  try { fd = openSync(file, "r+"); } catch { return; }
  try {
    const b = Buffer.alloc(1);
    if (readSync(fd, b, 0, 1, 0) === 1) writeSync(fd, b, 0, 1, 0);
  } finally { closeSync(fd); }
}

type Opts = {
  top: string;
  // Runs the dependency install; resolves its exit code.
  install: () => Promise<number>;
  poke?: (file: string) => void;
  log?: (line: string) => void;
  // How long a burst of notifications is gathered, in ms.
  settle?: { css: number; reload: number };
};

// What each notification leads to. The three handlers take what fs.watch
// reports; `idle` resolves when nothing is pending or running.
export function reloader(opts: Opts) {
  const ui = join(opts.top, "ui", "src");
  const src = join(opts.top, "src");
  const styles = join(ui, "styles.css");
  const touch = opts.poke ?? poke;
  const log = opts.log ?? ((l: string) => console.error(l));
  const settle = opts.settle ?? { css: 30, reload: 300 };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const waiters: (() => void)[] = [];
  let busy = false;
  const settled = () => { if (!busy && !timers.size) for (const w of waiters.splice(0)) w(); };
  const debounce = (ms: number, f: () => void | Promise<void>) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (t) { clearTimeout(t); timers.delete(t); }
      t = setTimeout(() => { timers.delete(t!); t = undefined; void f(); }, ms);
      timers.add(t);
    };
  };

  const css = debounce(settle.css, () => { touch(styles); settled(); });

  // One run at a time. A run installs until no manifest change is left, then
  // reloads once: a notification that arrives meanwhile is covered by that
  // run, so the last manifest change is installed before the last reload.
  let install = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      let failed = false;
      while (install) {
        install = false;
        const code = await opts.install().catch((e) => (log(`dev-watch: bun install could not run: ${(e as Error).message}`), -1));
        failed = code !== 0;
        if (failed && code !== -1) log(`dev-watch: bun install failed (exit ${code}); nothing is reloaded. Fix package.json or bun.lock: the next change to either installs again.`);
      }
      if (!failed) touch(join(src, "main.ts"));
    } finally {
      busy = false;
      settled();
    }
  };
  const reload = debounce(settle.reload, run);

  return {
    css(_kind: string, file: string | null) { if (file?.endsWith(".css") && join(ui, file) !== styles) css(); },
    source(kind: string, file: string | null) { if (kind === "rename" && file && /\.tsx?$/.test(file) && existsSync(join(src, file))) reload(); },
    manifest(_kind: string, file: string | null) { if (file === "package.json" || file === "bun.lock") { install = true; reload(); } },
    idle: () => new Promise<void>((done) => { waiters.push(done); settled(); }),
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as any).code === "EPERM"; } };

// The live daemon that holds the state folder, from its lock, when it took the
// folder at `since` or later. A lock left by a daemon that ended before (a
// crash, a reboot) names a pid that may be another program's by now: it is
// never taken for the daemon.
export function holder(state: string, since = 0): number | undefined {
  try {
    const lock = JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")) as { pid?: number; started_ms?: number };
    return lock.pid && (lock.started_ms ?? 0) >= since && alive(lock.pid) ? lock.pid : undefined;
  } catch { return undefined; }
}

// How long the folder may be without a daemon before the launcher ends. A
// daemon that restarts itself hands its lock to the one it started before it
// exits, so there is no gap to wait out: this only covers a lock read while it
// is being written.
const GAP_MS = 1_500;

// Starts the daemon and stays with it. `follow` is the launcher's daemon: the
// one it started, then whichever daemon that one handed the folder to.
export function launch(state: string, command: string[], cwd: string, onStop: () => void = () => {}) {
  const since = Date.now();
  // In a session of its own: a signal sent to the launcher's process group
  // (Ctrl-C in the terminal) reaches the launcher only, which passes it on
  // once, so the daemon drains its turns as it does for one signal.
  const child = Bun.spawn(command, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
  let childCode: number | undefined;
  void child.exited.then((c) => { childCode = c; });
  // Never a pid the launcher's daemon did not lead to: its own child while it
  // lives, after that the holder of a lock taken since the launcher started.
  const follow = () => (childCode === undefined ? child.pid : holder(state, since));

  // Stopped: its daemon is asked to stop (it drains), and the launcher ends
  // when it has. A second signal stops the daemon at once, and the launcher.
  let stopping = false;
  const stop = () => {
    const pid = follow();
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
    if (stopping) process.exit(130);
    stopping = true;
    onStop();
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, stop);

  // A daemon runs while the one started here has not ended or one it led to holds the folder.
  // When none does, the launcher ends with the code of the daemon it started (a taken port,
  // a folder in use, a daemon stopped from outside).
  let last = Date.now();
  setInterval(() => {
    if (follow()) { last = Date.now(); return; }
    if (stopping || childCode !== 0 || Date.now() - last > GAP_MS) process.exit(childCode ?? 0);
  }, 250);
}

async function main() {
  const at = process.argv.indexOf("--");
  const state = process.argv[2];
  const command = at < 0 ? [] : process.argv.slice(at + 1);
  if (!state || at !== 3 || !command.length) {
    console.error("usage: bun scripts/dev-watch.ts <state-dir> -- <daemon command...>");
    process.exit(2);
  }
  const top = join(import.meta.dir, "..");
  let installing: Bun.Subprocess | undefined;
  const r = reloader({
    top,
    install: async () => {
      installing = Bun.spawn(["bun", "install", "--silent"], { cwd: top, stdout: "inherit", stderr: "inherit" });
      try { return await installing.exited; } finally { installing = undefined; }
    },
  });
  watch(join(top, "ui", "src"), { recursive: true }, r.css);
  watch(join(top, "src"), { recursive: true }, r.source);
  watch(top, r.manifest);
  launch(state, command, top, () => installing?.kill());
}

if (import.meta.main) await main();
