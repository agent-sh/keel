// A repository's setup for the worktrees Keel makes: .keel/worktree.json
// {"setup": ["bun install", ...]} runs once in a new worktree, after git made
// it and the files .worktreeinclude names were copied in, so ten agents of one
// repository do not each spend their first steps installing.
//
// It runs commands, so it is held the way a hooks file is: it runs only while
// the owner's pin holds exactly its content and the content of every file of
// .keel/ its commands run (a new or changed file is held and says so). It runs
// as the session's own commands do: under the session's sandbox and network
// rules (src/safety/gate.ts confineFor), nothing when that sandbox is
// read-only (it could write nothing). Its output goes to a file. A line
// NAME=value written to the file $KEEL_ENV_FILE names becomes part of the
// environment of the session's later commands.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Store } from "../core/store.ts";
import { coveredFiles, linksOut, pinDigest, pinKey, projectRoot } from "../integrations/hooks.ts";
import { registerEnv, toolEnv } from "../tools/jobs.ts";

export type SetupState = "ok" | "failed" | "held" | "skipped";
// What a setup came to, kept with the worktree: shown on its chip and on the agent's card.
// `ms`: wall time (0 when nothing ran); `note`: why it failed, was held or skipped, or what it left out;
// `log`: the file its output is in; `env`: the file its variables were written to (read for every later command).
export type SetupOutcome = { state: SetupState; ms: number; steps: number; note?: string; log?: string; env?: string };

export const SETUP_FILE = join(".keel", "worktree.json");
// A file longer than this is not pinned: the owner pins what they were shown.
export const SETUP_SHOWN_MAX = 100_000;
// The time one setup may take whole when its file names none: a dependency install on a cold cache and a slow line.
export const SETUP_SECONDS = 900;
const STEPS_MAX = 50, STEP_CHARS = 4_000, ENV_MAX = 64 * 1024, TAIL_CHARS = 1_500;

export type SetupSpec = { commands: string[]; seconds: number; problems: string[] };

// The file's words: {"setup": ["command", ...], "timeout": seconds}. Anything else it holds is named and left alone.
export function parseSetup(text: string): SetupSpec {
  const out: SetupSpec = { commands: [], seconds: SETUP_SECONDS, problems: [] };
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { out.problems.push(`not JSON: ${(e as Error).message}`); return out; }
  if (!j || typeof j !== "object" || Array.isArray(j)) { out.problems.push("the file is one JSON object"); return out; }
  const o = j as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "setup" && k !== "timeout") out.problems.push(`"${k}" is not read`);
  if (!Array.isArray(o.setup)) out.problems.push('"setup" is a list of shell commands');
  else if (o.setup.length > STEPS_MAX) out.problems.push(`"setup" has more than ${STEPS_MAX} commands`);
  else if (!o.setup.every((c) => typeof c === "string" && c.trim() && c.length <= STEP_CHARS)) out.problems.push(`every command of "setup" is a non-empty string of at most ${STEP_CHARS} characters`);
  else out.commands = (o.setup as string[]).map((c) => c.trim());
  if (o.timeout !== undefined) {
    if (typeof o.timeout === "number" && o.timeout > 0 && Number.isFinite(o.timeout)) out.seconds = o.timeout;
    else out.problems.push('"timeout" is a number of seconds above 0');
  }
  // A file with a problem runs nothing: what it meant is not known.
  if (out.problems.some((p) => !p.endsWith("is not read"))) out.commands = [];
  return out;
}

// A repository's file as it is on disk now, with the digest a pin holds.
export type SetupFile = SetupSpec & { path: string; root: string; text: string; sha256: string; covers: string[]; links: string[] };
export function readSetup(cwd: string): SetupFile | null {
  const root = projectRoot(cwd);
  const path = join(root, SETUP_FILE);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const spec = parseSetup(text);
  // The scripts the commands run from .keel/ are part of what is pinned (as for a hook's commands).
  const groups = { setup: [{ hooks: spec.commands.map((command) => ({ type: "command" as const, command })) }] };
  const covers = coveredFiles(root, groups as any).filter((f) => f !== path);
  return { ...spec, path, root, text, sha256: pinDigest(text, root, covers), covers: covers.map((f) => f.slice(root.length + 1)), links: linksOut(root, covers).map((f) => f.slice(root.length + 1)) };
}

export class SetupPins {
  constructor(private store: Store) {
    store.migrate("CREATE TABLE IF NOT EXISTS worktree_setup_pins (root TEXT PRIMARY KEY, sha256 TEXT NOT NULL, created INTEGER NOT NULL);");
  }
  pinned(root: string): string | undefined {
    return this.store.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM worktree_setup_pins WHERE root = ?").get(pinKey(root))?.sha256;
  }
  // The file as the owner sees it, and whether it runs.
  show(cwd: string): { path: string; exists: boolean; state: "none" | "new" | "changed" | "pinned" | "refused"; text?: string; sha256?: string; commands?: string[]; covers?: string[]; problems: string[] } {
    const f = readSetup(cwd);
    const path = join(projectRoot(cwd), SETUP_FILE);
    if (!f) return { path, exists: false, state: "none", problems: [] };
    const pin = this.pinned(f.root);
    const problems = [...f.problems];
    if (f.links.length) problems.push(`${f.links.join(", ")} ${f.links.length > 1 ? "are links" : "is a link"} out of .keel/: the pin cannot hold what ${f.links.length > 1 ? "they run" : "it runs"}`);
    if (f.text.length > SETUP_SHOWN_MAX) problems.push(`the file is longer than Keel shows whole (${SETUP_SHOWN_MAX} characters), so it cannot be pinned`);
    const refused = problems.some((p) => !p.endsWith("is not read"));
    return { path, exists: true, state: refused ? "refused" : !pin ? "new" : pin === f.sha256 ? "pinned" : "changed", text: f.text.slice(0, SETUP_SHOWN_MAX), sha256: f.sha256, commands: f.commands, covers: f.covers, problems };
  }
  pin(cwd: string, digest: string): string | null {
    const s = this.show(cwd);
    if (!s.exists) return "this folder has no .keel/worktree.json";
    if (s.state === "refused") return s.problems.join("; ");
    if (s.sha256 !== digest) return "the file is no longer the one that was shown: read it again";
    this.store.db.query("INSERT INTO worktree_setup_pins (root, sha256, created) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET sha256 = excluded.sha256, created = excluded.created").run(pinKey(projectRoot(cwd)), digest, Date.now());
    return null;
  }
}

// What the daemon gives this module (src/server/routes/worktrees.ts and permissions.ts): how the session's
// commands are confined, and how a setup that did not run well is told on its session.
export const setupHook: {
  // The session's confinement for a command that runs in `path`, `tool` being a folder it may write besides.
  // `skip`: why none may run; no wrap: the session's commands run unconfined.
  confine?: (sessionId: string, path: string, tool: string) => { wrap?: (argv: string[]) => string[]; skip?: string };
  told?: (sessionId: string, o: SetupOutcome, cause: string) => void;
  // The env file a session's worktree setup wrote.
  envOf?: (sessionId: string) => string | undefined;
} = {};

// The variables a setup wrote: NAME=value lines (a value may be quoted); a line that is not one, and a name of Keel's own,
// are left out and named.
export function parseEnvFile(text: string): { env: Record<string, string>; left: string[] } {
  const env: Record<string, string> = {}, left: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || m[1]!.startsWith("KEEL_") || m[2]!.includes("\0")) { left.push(line.slice(0, 40)); continue; }
    let v = m[2]!;
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    env[m[1]!] = v;
  }
  return { env, left };
}

// The file is read again only when it changed (a command asks for the environment at every start).
const envCache = new Map<string, { key: string; env: Record<string, string> }>();
export function envFrom(file: string): Record<string, string> {
  let st;
  try { st = statSync(file, { bigint: true }); } catch { return {}; }
  const key = `${st.ino}:${st.size}:${st.mtimeNs}`;
  const hit = envCache.get(file);
  if (hit?.key === key) return hit.env;
  let text = "";
  try { text = readFileSync(file, "utf8").slice(0, ENV_MAX); } catch { return {}; }
  const { env } = parseEnvFile(text);
  if (envCache.size > 256) envCache.clear();
  envCache.set(file, { key, env });
  return env;
}
registerEnv((sessionId) => { const f = setupHook.envOf?.(sessionId); return f ? envFrom(f) : {}; });

const tail = (file: string) => { try { return readFileSync(file, "utf8").trimEnd().slice(-TAIL_CHARS); } catch { return ""; } };
const words = (s: string) => s.length > 80 ? `${s.slice(0, 77)}...` : s;

// Runs the setup of the worktree at `path` (null when it names none). `dir`: a folder of the setup's own, outside
// the worktree, holding its output and its variables. `madeFor`: the session whose rules confine it.
export async function runSetup(o: { path: string; dir: string; madeFor: string; pins: SetupPins }): Promise<SetupOutcome | null> {
  const f = readSetup(o.path);
  if (!f) return null;
  const shown = o.pins.show(o.path);
  const held = (note: string): SetupOutcome => ({ state: "held", ms: 0, steps: 0, note });
  if (shown.state === "refused") return held(`.keel/worktree.json cannot run: ${shown.problems.join("; ")}`);
  if (shown.state === "new") return held("the repository's .keel/worktree.json is not pinned: you read it and pin it in the Trust panel before it runs, and a worktree made after that runs it");
  if (shown.state === "changed") return held("the repository's .keel/worktree.json changed since you pinned it (the file or a script it runs): pin it again in the Trust panel, and a worktree made after that runs it");
  if (!f.commands.length) return { state: "ok", ms: 0, steps: 0, note: "the file names no command" };
  const how = setupHook.confine?.(o.madeFor, o.path, o.dir);
  if (!how) return { state: "skipped", ms: 0, steps: 0, note: "not run: the daemon's permission rules are not loaded" };
  if (how.skip) return { state: "skipped", ms: 0, steps: 0, note: `not run: ${how.skip}` };
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const log = join(o.dir, "output.log"), envFile = join(o.dir, "env");
  writeFileSync(log, ""); writeFileSync(envFile, "", { mode: 0o600 });
  const started = Date.now(), deadline = started + f.seconds * 1000;
  const env = { ...toolEnv(o.madeFor), KEEL_ENV_FILE: envFile, KEEL_WORKTREE: o.path };
  let step = 0;
  for (const command of f.commands) {
    step++;
    appendFileSync(log, `$ ${command}\n`);
    const left = deadline - Date.now();
    let code: number | null = null, signal: string | null = null, why = "";
    if (left <= 0) why = `the ${f.seconds} s the setup may take were used up before step ${step}`;
    else {
      const fd = openSync(log, "a");
      try {
        const p = Bun.spawn(how.wrap ? how.wrap(["bash", "-c", command]) : ["bash", "-c", command], { cwd: o.path, env, stdin: "ignore", stdout: fd, stderr: fd, timeout: left, killSignal: "SIGKILL" });
        code = await p.exited;
        signal = p.signalCode == null ? null : String(p.signalCode);
      } catch (e) { why = `step ${step} did not start: ${(e as Error).message}`; }
      finally { closeSync(fd); }
      if (!why && signal) why = signal === "SIGKILL" && Date.now() >= deadline - 50 ? `stopped at the ${f.seconds} s the setup may take, in step ${step} (${words(command)})` : `step ${step} (${words(command)}) ended on ${signal}`;
      else if (!why && code !== 0) why = `step ${step} (${words(command)}) exited ${code}`;
    }
    if (why) {
      const out = tail(log);
      return { state: "failed", ms: Date.now() - started, steps: step - 1, note: `${why}${out ? `. Its last output:\n${out}` : ""}`, log, env: envFile };
    }
  }
  const { env: vars, left } = parseEnvFile((() => { try { return readFileSync(envFile, "utf8").slice(0, ENV_MAX); } catch { return ""; } })());
  const set = Object.keys(vars);
  return { state: "ok", ms: Date.now() - started, steps: step, log, env: envFile, ...(set.length || left.length ? { note: `${set.length ? `sets ${set.join(", ")} for the session's commands` : ""}${left.length ? `${set.length ? "; " : ""}${left.length} line${left.length > 1 ? "s" : ""} of $KEEL_ENV_FILE left out (not NAME=value, or a KEEL_ name)` : ""}` } : {}) };
}

// Where a worktree's setup keeps its files: beside the folder Keel makes worktrees in, never inside one.
export const setupDir = (worktreesRoot: string, path: string) => join(dirname(worktreesRoot), "worktree-setup", basename(path));
export const has = (path: string) => existsSync(join(path, SETUP_FILE));
