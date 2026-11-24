// The daemon's own environment holds no secret. A command a session runs as the same
// user (the sandbox off, or Full auto) reads /proc/<daemon>/environ: the kernel shows
// what the process was started with, whatever it changed since. The daemon is started with
// the provider keys in its environment (a unit's environment file, a shell that sourced one),
// so that file would hand every one of them over.
//
// At start the daemon is started again, once, in the same process (an exec): the names that
// carry a secret (src/safety/env-secret.ts) are taken out of the environment it is started
// with and go through a pipe, which stands in the place of its standard input for that one
// step (the runtime closes every other descriptor at an exec). The new image reads the pipe
// at once, puts the values into the process, and gives standard input back as /dev/null.
// /proc/<daemon>/environ then shows no secret, and what the daemon starts gets the
// whole environment as it did.
//
// Memory is not closed here: with Yama's ptrace_scope at 1 or more (Settings > Health says it)
// only an ancestor can attach to the daemon or read its memory, and a session's command is its
// descendant. Making the process non-dumpable would close /proc/self for the daemon itself
// and every other process that reads its processes' /proc (the stall watcher, resources, the
// leftovers, a unit's checks). The pipe itself can be read through /proc/<daemon>/fd for the
// few milliseconds between the exec and the read.
//
// Linux only. Where the runtime has no `execve` (or a profiler is attached) the environment
// stays as it was, and Settings > Health says which names it holds.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { secretEnvNames } from "./env-secret.ts";

// The handover: "<pid>:0", the process it is for and the descriptor, set by the process that exec'd.
const SPEC = "KEEL_SECRET_ENV";
// Set on an exec that had secrets to take out, so the new image does not try again if that could not be done.
const DONE = "KEEL_ENV_CLEANED";
const OWN = new Set([SPEC, DONE]);
// A pipe holds 64 KiB; the writer fills it before the exec and must not wait for a reader.
const PIPE_MAX = 60_000;

type Env = Record<string, string | undefined>;
type Libc = { pipe2(fds: unknown, flags: number): number; dup2(from: number, to: number): number };
let libc: Libc | null | undefined;
function lib(): Libc | null {
  if (libc !== undefined) return libc;
  libc = null;
  if (process.platform !== "linux") return libc;
  try {
    libc = dlopen("libc.so.6", {
      pipe2: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols as unknown as Libc;
  } catch {}
  return libc;
}

// What of an environment holds a secret, and the rest.
export function splitEnv(env: Env): { kept: Record<string, string>; held: Record<string, string> } {
  const names = new Set(secretEnvNames(env));
  const kept: Record<string, string> = {}, held: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || OWN.has(k)) continue;
    (names.has(k) ? held : kept)[k] = v;
  }
  return { kept, held };
}

// The names this process was started with that carry a secret: what another process of the account can read
// in /proc/<pid>/environ. null: not known (no /proc).
export function startedWithSecrets(): string[] | null {
  if (process.platform !== "linux") return null;
  try {
    const env: Env = {};
    for (const l of readFileSync("/proc/self/environ", "utf8").split("\0")) {
      const i = l.indexOf("=");
      if (i > 0) env[l.slice(0, i)] = l.slice(i + 1);
    }
    return secretEnvNames(env).filter((n) => !OWN.has(n));
  } catch {
    return null;
  }
}

// Standard input becomes /dev/null.
function nullStdin(): void {
  const l = lib();
  if (!l) return;
  try {
    const fd = openSync("/dev/null", "r");
    l.dup2(fd, 0);
    if (fd !== 0) closeSync(fd);
  } catch {}
}

// A pipe holding `payload`, in the place of standard input. False: standard input is as it was.
function pipeAsStdin(payload: string): boolean {
  const l = lib();
  if (!l || Buffer.byteLength(payload) > PIPE_MAX) return false;
  const fds = new Int32Array(2);
  if (l.pipe2(ptr(fds), 0) !== 0) return false;
  const [r, w] = [fds[0]!, fds[1]!];
  let ok = false;
  try {
    writeSync(w, payload);
    ok = l.dup2(r, 0) === 0;
  } catch {}
  try { closeSync(w); } catch {}
  try { closeSync(r); } catch {}
  return ok;
}

// Starts `argv` in this process with `env`, the secrets taken out and handed through the pipe. Returns only
// when the exec could not be made (the process goes on as it was, standard input again what it was not: /dev/null).
export function execClean(argv: string[], env: Env): void {
  const execve = (process as { execve?: (file: string, args: string[], env: Env) => never }).execve;
  if (typeof execve !== "function") return;
  const { kept, held } = splitEnv(env);
  let piped = false;
  if (Object.keys(held).length) {
    kept[DONE] = "1";
    piped = pipeAsStdin(JSON.stringify(held));
    if (piped) kept[SPEC] = `${process.pid}:0`;
    else Object.assign(kept, held);
  }
  try { execve.call(process, argv[0]!, argv, kept); } catch { if (piped) nullStdin(); }
}

// The new image's first step: takes the secrets out of the pipe into the process. The runtime starts what
// it is asked to start without an `env` from the environment it began with, not from `process.env`
// (which is where the secrets are now): from here a start with no `env` is given `process.env`.
export function restoreSecretEnv(): "none" | "restored" | "failed" {
  const spec = process.env[SPEC];
  if (spec === undefined) return "none";
  delete process.env[SPEC];
  if (spec !== `${process.pid}:0`) return "failed"; // not for this process: left over from another
  let held: Record<string, unknown> | undefined;
  try {
    if (!fstatSync(0).isFIFO()) return "failed";
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(16_384);
    for (let n = readSync(0, buf, 0, buf.length, null); n > 0; n = readSync(0, buf, 0, buf.length, null)) chunks.push(Buffer.from(buf.subarray(0, n)));
    held = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return "failed";
  } finally {
    nullStdin();
  }
  for (const [k, v] of Object.entries(held ?? {})) if (typeof v === "string") process.env[k] = v;
  spawnWithEnvironment();
  return "restored";
}

// Bun.spawn and Bun.spawnSync with no `env` start the program with the environment the process began with.
export function spawnWithEnvironment(): void {
  const g = globalThis as { __keelSpawnEnv?: boolean };
  if (g.__keelSpawnEnv) return;
  g.__keelSpawnEnv = true;
  const wrap = <F extends (...a: any[]) => unknown>(real: F): F => (function (this: unknown, a: any, b?: any) {
    if (Array.isArray(a)) return real.call(Bun, a, { ...b, env: b?.env ?? process.env });
    return real.call(Bun, { ...a, env: a?.env ?? process.env });
  }) as unknown as F;
  Bun.spawn = wrap(Bun.spawn);
  Bun.spawnSync = wrap(Bun.spawnSync);
}

// Whether the exec that took the secrets out was made for this process (and forgets it, so what the
// daemon starts later, a daemon of its own included, does not carry it).
export function wasCleaned(): boolean {
  const done = process.env[DONE] !== undefined;
  delete process.env[DONE];
  return done;
}
