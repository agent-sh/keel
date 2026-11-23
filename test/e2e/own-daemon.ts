// A daemon of the spec's own on a scratch state (the scripted stand-in, its
// own config folder), for what the shared daemon cannot be given: a state
// written before it starts, a stop and a start.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

// The folder a spec's own daemon gives its sessions: beside its state folder,
// never the state folder itself. A session's tools write nothing into Keel's
// own state (the gate refuses it, in every mode), and no real session works
// there. Made when asked for, kept across the spec's restarts of its daemon,
// and removed when the spec's worker ends.
const folders = new Set<string>();
export function sessionsFolder(state: string): string {
  const ws = `${state.replace(/\/+$/, "")}-ws`;
  mkdirSync(ws, { recursive: true });
  if (!folders.size) process.on("exit", () => { for (const d of folders) try { rmSync(d, { recursive: true, force: true }); } catch {} });
  folders.add(ws);
  return ws;
}

// What a daemon of a spec gets in place of the shell's: no memory tool (a
// TACIT_BIN that names no file: Keel looks nowhere else then; a spec that
// reads memory passes the stand-in, fixtures/tacit-standin.sh, itself), a
// stand-in store under its state, and the other harnesses' setups read from
// a home under its state. Whatever the shell that ran the specs holds, a
// spec's daemon never runs the owner's tacit or reads his home's setups.
export const ownEnv = (state: string): Record<string, string> => ({
  TACIT_BIN: join(state, "no-tacit"),
  TACIT_STANDIN_STORE: join(state, "tacit-store"),
  KEEL_IMPORT_HOME: join(state, "import-home"),
});

// `dev`: the page as a development build (it has the counters a spec reads).
// `env`: what the daemon gets besides (a stand-in program it is to run).
export function daemon(state: string, port = 0, dev = false, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  mkdirSync(state, { recursive: true });
  const proc = spawn("bun", ["src/main.ts", "serve", ...(dev ? ["--dev"] : []), "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", sessionsFolder(state)], {
    env: { ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_CONFIG_DIR: join(state, "config"), KEEL_DESKTOP_NOTIFY: "off", ...ownEnv(state), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 60_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}

export const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

// A state folder with sessions that already hold a long transcript (fixtures/long-transcript.ts).
export function seeded(name: string, events: number, shape: "notes" | "turns" | "run", ...titles: string[]) {
  const state = join(ROOT, `${name}-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  const ids = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), state, state, String(events), ...titles], { encoding: "utf8", env: { ...process.env, KEEL_FIXTURE_SHAPE: shape, KEEL_CONFIG_DIR: join(state, "config") } })) as string[];
  return { state, ids };
}
