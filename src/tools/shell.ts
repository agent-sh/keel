// The shell every family's command tool runs on: a per-session working
// directory that follows `cd` (inside the workspace only), merged
// stdout/stderr, and the move to the background when a foreground command
// outlives its timeout instead of killing it.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backgrounded, startJob, stopJob, takeUnread, waitJob, type Handle, type Job } from "./jobs.ts";
import { notFound } from "./missing.ts";
import { TRACE_CAP } from "../checks/named.ts";
import type { ToolContext } from "./types.ts";
import { SessionMap } from "../core/session-map.ts";
import { contains } from "../core/paths.ts";

const cwds = new SessionMap<string>(1024);

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export const shellCwd = (ctx: ToolContext) => cwds.get(ctx.sessionId) ?? ctx.cwd;
// Where a command left the shell, as a command's end moves it: inside the session's folder only.
export function moveShell(ctx: ToolContext, dir: string) {
  const next = real(dir);
  if (next === real(shellCwd(ctx))) return;
  if (contains(real(ctx.cwd), next)) cwds.set(ctx.sessionId, next);
}
export const logDir = (ctx: ToolContext) => join(ctx.spillDir, "jobs");

// Why no command can start in `dir`, or nothing when one can. A spawn into a
// folder that is not there fails as ENOENT of the program it was to start
// (`posix_spawn 'systemd-run'`), which a model reads as a missing sandbox and
// answers by asking to run unconfined. This names the folder and the places
// near it instead. A folder the shell had moved into and that was removed
// since is left: the next command starts in the session's folder.
export function goneCwd(ctx: ToolContext, dir: string): string | undefined {
  let why: string;
  try {
    if (statSync(dir).isDirectory()) return;
    why = `Not a directory: ${dir}`;
  } catch { why = notFound(dir, ctx.cwd, "Directory"); }
  const out = ["Nothing ran: the command's working directory is not there.", why];
  if (cwds.get(ctx.sessionId) === dir) { cwds.delete(ctx.sessionId); out.push(`Shell cwd was reset to ${ctx.cwd}`); }
  return out.join("\n\n");
}

export type ShellRun =
  | { state: "done"; output: string; exitCode: number | null; signal?: string | null; cwdNote?: string; job: Job }
  | { state: "running"; job: Job; output: string }
  | { state: "refused"; error: string };   // nothing started (see goneCwd)

export type ShellOpts = {
  command: string;
  description?: string;
  timeoutMs: number;
  cwd?: string;            // explicit directory (Codex workdir, Gemini dir_path): no cd tracking
  background?: boolean;    // start in the background right away
  onTimeout: "background" | "kill";
  pty?: boolean;
  handle?: Handle;         // how the family's tools name a job to the model (Claude's task ID by default)
};

export async function runShell(ctx: ToolContext, o: ShellOpts): Promise<ShellRun> {
  const track = !o.cwd;
  const cwd = o.cwd ?? shellCwd(ctx);
  const gone = goneCwd(ctx, cwd);
  if (gone) return { state: "refused", error: gone };
  const dir = logDir(ctx);
  const cwdFile = join(dir, `cwd-${ctx.callId ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  // A check's run (src/checks): each simple command the shell runs, in this
  // shell and its groups (set -T), is reported with its shell's process and
  // level and the statuses of the pipe before it, read first (anything in the
  // trap resets them; bash gives the command back its own). At most
  // TRACE_CAP lines a shell, 400 characters a command. The last line is the
  // end's statuses: the exit trap runs at line 1, where no command of the
  // script is, so its own commands are not reported (they would repeat the
  // last command's words), and it takes the statuses the debug trap read
  // before its first command. The trap's own lines are not traced (set -x
  // before the check stays the command's), and the file is the owner's alone:
  // it holds the command as it ran.
  const traceFile = ctx.checkRun ? `${cwdFile}.trace` : undefined;
  if (traceFile) { mkdirSync(dir, { recursive: true }); writeFileSync(traceFile, "", { mode: 0o600 }); }
  const quiet = (body: string, ps: string) => `{ ${ps}__keel_x=$-; set +x; } 2>/dev/null; ${body}; if [[ $__keel_x == *x* ]]; then set -x; fi`;
  const debug = traceFile ? quiet(`(( LINENO > 1 && __keel_n++ < ${TRACE_CAP} )) && printf 'D\\t%s\\t%s\\t%s\\t%s\\n' "$BASHPID" "$BASH_SUBSHELL" "$__keel_ps" "\${BASH_COMMAND:0:400}" >> ${shq(traceFile)} 2>/dev/null`, `__keel_ps="\${PIPESTATUS[*]}"; `) : "";
  const end = traceFile ? `{ __keel_e=$__keel_ps; set +x; } 2>/dev/null; printf 'E\\t%s\\n' "$__keel_e" >> ${shq(traceFile)} 2>/dev/null; ` : "";
  // The command is handed to bash as written; the trap records where it ended.
  // The traps' words are quoted as a whole around the quoted file names, so a
  // state folder with a space, a quote or a `$` in its name stays one word.
  const trap = `${end}${track ? `pwd -P >| ${shq(cwdFile)} 2>/dev/null` : ""}`;
  const head = `${debug ? `set -T\ntrap ${shq(debug)} DEBUG\n` : ""}${trap ? `trap ${shq(trap)} EXIT\n` : ""}`;
  const script = `${head}exec 2>&1\n${o.command}`;
  const job = startJob({
    sessionId: ctx.sessionId, command: o.command, description: o.description, cwd, logDir: dir,
    argv: ["bash", "-c", script], pty: o.pty, background: o.background, wrap: ctx.wrapSpawn, callId: ctx.callId,
    // In the foreground the call stops the command when its turn is stopped (below).
    handle: o.handle, stops: !o.background, traceFile,
  });
  if (o.background) return { state: "running", job, output: "" };

  const finished = await waitJob(job, o.timeoutMs, ctx.signal);
  if (!finished) {
    // Every command a tool says it moves is moved, one that starts with sleep
    // too: what follows the sleep still runs.
    if (ctx.signal.aborted || o.onTimeout === "kill") {
      await stopJob(job, ctx.signal.aborted ? "was interrupted" : `was killed at its ${Math.round(o.timeoutMs / 1000)}s timeout`);
      return { state: "done", output: takeUnread(job), exitCode: job.exitCode ?? null, signal: job.signal, job };
    }
    backgrounded(job);
    return { state: "running", job, output: takeUnread(job) };
  }
  let cwdNote: string | undefined;
  if (track && existsSync(cwdFile)) {
    const next = readFileSync(cwdFile, "utf8").trim();
    rmSync(cwdFile, { force: true });
    const root = real(ctx.cwd);
    if (next && next !== real(cwd)) {
      if (contains(root, next)) cwds.set(ctx.sessionId, next);
      else { cwds.set(ctx.sessionId, ctx.cwd); cwdNote = `Shell cwd was reset to ${ctx.cwd}`; }
    }
  }
  return { state: "done", output: takeUnread(job), exitCode: job.exitCode ?? null, signal: job.signal, cwdNote, job };
}

export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Head and tail of a long text, with what was cut in the middle.
export function headTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const head = text.slice(0, Math.floor(cap * 0.5));
  const tail = text.slice(-Math.floor(cap * 0.45));
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters cut ...]\n\n${tail}`;
}
