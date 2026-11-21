// Dev only: the launcher of the dev daemon (scripts/dev.sh), and what
// `bun --hot` and Bun's dev bundler miss by themselves.
//
//   bun scripts/dev-watch.ts <state-dir> -- <daemon command...>
//
// It starts the daemon and stays for as long as a daemon holds the state
// folder: a dev daemon that restarts itself is replaced by a process of its
// own, and the launcher follows the folder's lock to it, so reloads go on.
// Stopping the launcher (Ctrl-C, SIGTERM) stops the daemon that holds the
// folder now; a daemon that ended takes the launcher with it.
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

// The live daemon that holds the state folder, from its lock.
export function holder(state: string): number | undefined {
  try {
    const pid = JSON.parse(readFileSync(join(state, "daemon.lock"), "utf8")).pid as number;
    return pid && alive(pid) ? pid : undefined;
  } catch { return undefined; }
}

// How long the folder may be without a daemon before the launcher gives up:
// a daemon that restarts itself waits for the old one to exit, then starts.
const GAP_MS = 20_000;

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

  const child = Bun.spawn(command, { cwd: top, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  let childCode: number | undefined;
  void child.exited.then((c) => { childCode = c; });

  // Stopped: the daemon that holds the folder now is asked to stop (it drains),
  // and the launcher ends when it has. A second signal ends it at once.
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    installing?.kill();
    const pid = holder(state) ?? (childCode === undefined ? child.pid : undefined);
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
  };
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, stop);

  // A daemon runs while the one started here has not ended or one holds the folder.
  let last = Date.now();
  setInterval(() => {
    if (childCode === undefined || holder(state)) { last = Date.now(); return; }
    // The daemon it started failed (a taken port, a folder in use): its exit code is the launcher's.
    if (stopping || childCode !== 0 || Date.now() - last > GAP_MS) process.exit(childCode);
  }, 500);
}

if (import.meta.main) await main();
