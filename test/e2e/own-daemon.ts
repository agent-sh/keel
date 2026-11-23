// A daemon of the spec's own on a scratch state (the scripted stand-in, its
// own config folder), for what the shared daemon cannot be given: a state
// written before it starts, a stop and a start.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { prepare, standIns } from "../../scripts/scratch-env.ts";

export const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

// The folder a spec's own daemon gives its sessions: beside its state folder,
// never the state folder itself. A session's tools write nothing into Keel's
// own state (the gate refuses it, in every mode), and no real session works
// there. It is in a folder of its own (`<state>-ws/work`), which is the
// daemon's home (specEnv): what Keel reads in a folder's parents (instruction
// files, agents) ends at the home, so nothing above it is read, however deep
// in the owner's home the run's folders are. Made when asked for, kept across
// the spec's restarts of its daemon, and removed when the spec's worker ends.
const folders = new Set<string>();
export function sessionsFolder(state: string): string {
  const home = `${state.replace(/\/+$/, "")}-ws`;
  const ws = join(home, "work");
  mkdirSync(ws, { recursive: true });
  if (!folders.size) process.on("exit", () => { for (const d of folders) try { rmSync(d, { recursive: true, force: true }); } catch {} });
  folders.add(home);
  return ws;
}

// The environment of a daemon a spec starts, made from nothing: of the run's
// own it takes TMPDIR only, and a PATH of Bun and the system's tools (no agent
// CLI or helper of the caller is on it). Whatever shell ran the specs, such a
// daemon reaches nothing of the owner's: its home is the folder its sessions'
// folder is in (`workspace`, sessionsFolder(root) unless named), so no sign-in
// file, harness setup or plugin of his, and no instruction file or agent of a
// folder above it; it has no
// session bus and no credential helper, so no keyring; no provider key, no
// session or job of his books it; and everything else it would reach on the
// machine is a stand-in or a scratch folder under `root` (scripts/scratch-env.ts,
// the list scripts/dev.sh exports). It runs no memory tool and no voice (a
// TACIT_BIN and a KEEL_PARLAR that name no file); a spec that wants the
// stand-ins names them in `more`, as it names any setting of its own there.
// (test/e2e/spec-env.spec.ts starts one and watches what it opens and runs.)
export const bareEnv = (home: string): Record<string, string> => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  return {
    PATH: cleanPath(), TMPDIR: process.env.TMPDIR || join(home, "tmp"), LANG: "C.UTF-8", HOME: home, XDG_RUNTIME_DIR: join(home, "run"),
    KEEL_KEYRING_SERVICE: "keel-scratch-empty", KEEL_CRED_GET: "/bin/false", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus", KEEL_DESKTOP_NOTIFY: "off",
    // The home has no git identity; sessions commit in scratch repositories.
    GIT_AUTHOR_NAME: "Keel spec", GIT_AUTHOR_EMAIL: "spec@example.invalid", GIT_COMMITTER_NAME: "Keel spec", GIT_COMMITTER_EMAIL: "spec@example.invalid",
  };
};
export function specEnv(root: string, more: Record<string, string | undefined> = {}, workspace = sessionsFolder(root)): Record<string, string> {
  const env: Record<string, string | undefined> = {
    ...bareEnv(dirname(workspace)), ...standIns(root),
    KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in",
    // Nothing leaves the machine: no models.dev catalog, and the ACP registry is a saved
    // copy beside the state (one with no agents unless a spec writes its own).
    KEEL_MODELS_DEV_URL: "http://127.0.0.1:9/api.json", KEEL_ACP_REGISTRY: join(root, "acp-registry.json"),
    TACIT_BIN: join(root, "no-tacit"), KEEL_PARLAR: join(root, "no-parlar"),
    ...more,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  prepare(env, root);
  const registry = join(root, "acp-registry.json");
  if (env.KEEL_ACP_REGISTRY === registry && !existsSync(registry)) writeFileSync(registry, JSON.stringify({ version: "1.0.0", agents: [] }));
  return env as Record<string, string>;
}
// The memory stand-in, for a spec that reads memory (TACIT_BIN in `more`).
export const TACIT_STANDIN = join(import.meta.dirname, "fixtures/tacit-standin.sh");

// The folder Bun is in (Playwright runs specs in Node, so not process.execPath; and not a
// modules folder's commands, which `bunx` puts first), then the system's.
function cleanPath(): string {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d && existsSync(join(d, "bun")));
  const bun = dirs.find((d) => !d.endsWith("node_modules/.bin")) ?? dirs[0];
  return [...(bun ? [bun] : []), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter);
}

// `dev`: the page as a development build (it has the counters a spec reads).
// `env`: what the daemon gets besides (a stand-in program it is to run).
export function daemon(state: string, port = 0, dev = false, env: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string }> {
  mkdirSync(state, { recursive: true });
  const proc = spawn("bun", ["src/main.ts", "serve", ...(dev ? ["--dev"] : []), "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", sessionsFolder(state)], {
    env: specEnv(state, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return listening(proc);
}

// The address a daemon says it listens on.
export function listening(proc: ChildProcess, ms = 60_000): Promise<{ proc: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), ms);
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
  const ids = JSON.parse(execFileSync("bun", [join(import.meta.dirname, "fixtures/long-transcript.ts"), state, state, String(events), ...titles], { encoding: "utf8", env: { ...specEnv(state), KEEL_FIXTURE_SHAPE: shape } })) as string[];
  return { state, ids };
}
