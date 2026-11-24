// Who holds a state folder: one daemon per folder, found by its lock file and
// the kernel's claim. A start claims the folder before it opens anything of
// it, a restart hands the lock to the daemon it starts, and a client command
// reads the lock to find the daemon. Nothing of the daemon itself is imported
// here: a client command loads this file, not the daemon (src/cli/index.ts).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claimState, hasClaim } from "./claim.ts";
import { pidBorn, pidHolds, pidLive, pidState } from "./pid.ts";
import { homeDir } from "./paths";

export { claimState };

const LOCK = "daemon.lock";

// The daemon a service manager runs (KEEL_SUPERVISED) is the machine's own,
// whatever state folder its unit names: it leaves a note in the user's runtime
// folder so a bare client command finds it without --url or --state-dir.
export const serviceNote = () =>
  join(process.env.XDG_RUNTIME_DIR || join(homeDir(), ".cache"), "keel-bun", "service.json");

export function servicedDaemon(): { pid: number; url: string; state_dir: string } | undefined {
  try {
    const n = JSON.parse(readFileSync(serviceNote(), "utf8"));
    return n.pid && n.url && n.state_dir && alive(n.pid) ? n : undefined;
  } catch { return undefined; }
}

// A daemon that works. One that was killed or has exited keeps its pid for a
// while (src/core/pid.ts): it is no daemon any more.
const alive = pidLive;

// How long a start waits for a daemon that is going to be gone: the one a
// restart names, and one that was killed and is still leaving. One minute for
// the whole start, whichever of them it waits for and however often it looks.
const GOING_MS = 60_000;
// A wait this long is said, once for a pid: a start that sits there says why.
const SAY_AFTER_MS = 1000;
let goingUntil = 0;
const waitSaid = new Set<number>();

function waitWhile(pid: number, going: () => boolean, stepMs: number, ms: number) {
  if (!going()) return;
  goingUntil ||= Date.now() + ms;
  const since = Date.now();
  while (going() && Date.now() < goingUntil) {
    if (Date.now() - since >= SAY_AFTER_MS && !waitSaid.has(pid)) {
      waitSaid.add(pid);
      console.error(`keel: waiting for the daemon before this one (pid ${pid}) to go, up to ${Math.max(1, Math.round((goingUntil - Date.now()) / 1000))} s more`);
    }
    Bun.sleepSync(stepMs);
  }
}

// A restart passes the old daemon's pid: wait (up to a minute) until it has
// let go of its port and its folder. One that has ended and only waits for a
// parent to read its end holds neither, and is not waited for.
export function waitForPredecessor(ms = GOING_MS) {
  const waitFor = Number(process.env.KEEL_WAIT_FOR_PID || 0);
  // Looked at often: the time between the old daemon's exit and this look is time nothing answers.
  if (waitFor && waitFor !== process.pid) waitWhile(waitFor, () => pidHolds(waitFor), 10, ms);
  delete process.env.KEEL_WAIT_FOR_PID;
}

// A start right after a daemon of this folder was killed: the kernel keeps
// that daemon's port and its claim until its last thread is out, which takes
// a moment, and longer on a busy disk. The start waits for it, as a restart
// waits for the daemon before it, instead of finding the port taken or the
// folder claimed by a process that is already going. One that is still
// leaving when the time is up is refused (acquireLock).
export function waitForLeaving(stateDir: string, ms = GOING_MS) {
  waitForPredecessor(ms);
  let pid = 0;
  try { pid = Number(JSON.parse(readFileSync(join(stateDir, LOCK), "utf8")).pid) || 0; } catch {}
  if (!pid || pid === process.pid) return;
  waitWhile(pid, () => pidState(pid) === "leaving", 25, ms);
}

// How long the daemon a restart handed the folder to tries for its claim: a
// start by hand that took the free claim a moment before it lets go at once,
// since the lock names this one.
const HANDED_MS = 2000;

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
// state is opened. A restart passes the old pid: wait for it to exit, and for
// one that was killed to have left. The lock file says who holds the folder
// and where it answers; one left by a daemon that died is written over, also
// while that daemon's pid is still there as a zombie, or has gone to another
// process since.
export function acquireLock(stateDir: string, goingMs = GOING_MS) {
  if (hasClaim(stateDir)) return;
  const path = join(stateDir, LOCK);
  waitForLeaving(stateDir, goingMs);
  type Held = { pid?: number; url?: string; born?: string };
  const held = (): Held => {
    try { return JSON.parse(readFileSync(path, "utf8") || "{}") as Held; } catch { return {}; }
  };
  // The process the lock names, while it still has what a daemon holds. A
  // pid that has gone to another process since the lock was written (the lock
  // says when its daemon was born) is not that daemon.
  const holder = (h: Held) => (h.pid && h.pid !== process.pid && pidHolds(h.pid) && !(h.born && pidBorn(h.pid) !== h.born) ? h.pid : undefined);
  const refuse = (h: Held) => {
    console.error(`keel: another daemon${holder(h) ? ` (pid ${h.pid}${h.url ? `, ${h.url}` : ""})` : ""} uses ${stateDir}`);
    process.exit(1);
  };
  let claimed = claimState(stateDir);
  // The folder was handed to this daemon by the one that restarted, and
  // something else took the claim a moment ago: a start by hand, which gives
  // it up as soon as it reads the lock.
  for (const until = Date.now() + HANDED_MS; !claimed && held().pid === process.pid && Date.now() < until; claimed = claimState(stateDir)) Bun.sleepSync(25);
  if (!claimed) refuse(held());
  // A daemon named in the lock file holds the folder whatever the claim
  // says, while its process has anything left that runs: a daemon from
  // before the claim has none, and a claim can be lost (the kernel drops it
  // when its holder closes any handle of the file).
  const h = held();
  if (holder(h)) refuse(h);
  writeFileSync(path, JSON.stringify({ pid: process.pid, born: pidBorn(process.pid), started_ms: Date.now(), argv: process.argv.slice(1) }), { mode: 0o600 });
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
    if (held.pid === process.pid) writeFileSync(path, JSON.stringify({ ...held, pid, born: pidBorn(pid) }), { mode: 0o600 });
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
