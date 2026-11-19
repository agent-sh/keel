// The shell every family's command tool runs on: a per-session working
// directory that follows `cd` (inside the workspace only), merged
// stdout/stderr, and the move to the background when a foreground command
// outlives its timeout instead of killing it.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startJob, stopJob, takeUnread, waitJob, type Job } from "./jobs.ts";
import type { ToolContext } from "./types.ts";
import { SessionMap } from "../core/session-map.ts";
import { contains } from "../core/paths.ts";

const cwds = new SessionMap<string>(1024);

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export const shellCwd = (ctx: ToolContext) => cwds.get(ctx.sessionId) ?? ctx.cwd;
export const logDir = (ctx: ToolContext) => join(ctx.spillDir, "jobs");

export type ShellRun =
  | { state: "done"; output: string; exitCode: number | null; signal?: string | null; cwdNote?: string; job: Job }
  | { state: "running"; job: Job; output: string };

export type ShellOpts = {
  command: string;
  description?: string;
  timeoutMs: number;
  cwd?: string;            // explicit directory (Codex workdir, Gemini dir_path): no cd tracking
  background?: boolean;    // start in the background right away
  onTimeout: "background" | "kill";
  pty?: boolean;
};

export async function runShell(ctx: ToolContext, o: ShellOpts): Promise<ShellRun> {
  const track = !o.cwd;
  const cwd = o.cwd ?? shellCwd(ctx);
  const dir = logDir(ctx);
  const cwdFile = join(dir, `cwd-${ctx.callId ?? Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  // The command is handed to bash as written; the trap records where it ended.
  const script = track ? `trap 'pwd -P >| ${shq(cwdFile)} 2>/dev/null' EXIT\nexec 2>&1\n${o.command}` : `exec 2>&1\n${o.command}`;
  const job = startJob({
    sessionId: ctx.sessionId, command: o.command, description: o.description, cwd, logDir: dir,
    argv: ["bash", "-c", script], pty: o.pty, background: o.background, wrap: ctx.wrapSpawn, callId: ctx.callId,
  });
  if (o.background) return { state: "running", job, output: "" };

  const finished = await waitJob(job, o.timeoutMs, ctx.signal);
  if (!finished) {
    if (ctx.signal.aborted || o.onTimeout === "kill" || /^\s*sleep\b/.test(o.command)) {
      await stopJob(job, ctx.signal.aborted ? "was interrupted" : `was killed at its ${Math.round(o.timeoutMs / 1000)}s timeout`);
      return { state: "done", output: takeUnread(job), exitCode: job.exitCode ?? null, signal: job.signal, job };
    }
    job.background = true;
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
