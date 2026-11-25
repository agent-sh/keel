// What a write to a terminal is to the permission gate. A terminal that runs with no sandbox around it (its launch
// left the sandbox, or the session has none) runs whatever is typed into it as the owner's account would: a shell
// takes each line as a command. The call that started it was judged as the command it was, so the lines typed
// afterwards are judged too, as the commands they are, by the same rules, in the same modes:
//
//   - A terminal that runs in the sandbox, an empty write (a poll) and a write that completes no line (text that
//     waits for its Enter, Ctrl-C, Ctrl-D, an arrow key) are free: nothing runs from them that was not judged.
//   - The program the terminal's input goes to decides how a line is read (foreground.ts):
//       a shell: each line is a command, read as the gate reads a command (the whole write as one script, so a
//         heredoc or a block typed in one write is read whole);
//       an interpreter (a language's prompt, a database client, a debugger, ssh, docker exec, an editor): the line
//         is code that program runs, which no rule of the shell can read, so it asks, once a line, and the
//         owner's "always" names the program (`write_stdin:python3`);
//       any other program: the line answers its prompt, and the program is what the launch was allowed to run.
//   - A line whose text is not what was typed (history, completion, the kill ring...) is not read as a command:
//     it asks as a call the rules do not cover (typed-lines.ts).
//   - What the tool then writes is checked against what was judged: the line being typed is a value on the job, and a
//     write whose judgement started from another value (two writes in one reply, one changed the line) is refused
//     and sent again.
import { findJob, running, type Job } from "./jobs.ts";
import { readerOfTerminal } from "./foreground.ts";
import { EMPTY, step, type Typing } from "./typed-lines.ts";
import type { Tool } from "./types.ts";

type Target = Awaited<ReturnType<NonNullable<Tool["target"]>>>;

// How long after its start a terminal's foreground is still its launcher's.
const YOUNG_MS = 3000;

const lineOf = (job: Job): Typing => (job.typed as Typing | undefined) ?? EMPTY;

// How the gate judges a write: nothing (a free write), or the class of what it types.
export async function typedTarget(input: any, sessionId: string): Promise<Target> {
  const chars = typeof input?.chars === "string" ? input.chars : "";
  if (!chars) return null;
  const job = findJob(sessionId, Number(input?.session_id));
  if (!job || !job.pty || !job.unconfined || !running(job)) return null;
  const before = lineOf(job);
  const { lines } = step(before, chars);
  if (!lines.length) return null;
  // (A write that completes a line is looked at, whatever the look finds: it runs from this value of the line only.)
  const seen = (job.typedJudged ??= new Set());
  if (seen.size >= 64) seen.clear();
  seen.add(before.n);
  const reader = await readerOfTerminal(job.pid);
  const unsure = lines.some((l) => l.unsure);
  const code = (grant: string): Target => ({ name: "write_stdin", readOnly: false, input, cls: { kind: "other", grant } });
  // (What cannot be read is read as a shell, the strictest, and so is a terminal that has just started: until its
  // program has taken over, the processes in it are the launcher's.)
  if (reader?.kind === "program" && Date.now() - job.started > YOUNG_MS) return null;
  if (reader?.kind === "interpreter") return code(`write_stdin:${reader.name}`);
  if (unsure) return code("write_stdin:edited line");
  const command = lines.map((l) => l.text).filter((t) => t.trim()).join("\n");
  if (!command) return null;
  const name = reader?.kind === "shell" ? reader.name : "bash";
  return {
    name: "write_stdin", readOnly: false, input,
    cls: { kind: "shell", command, unconfined: true, cwd: (reader?.kind === "shell" ? reader.cwd : undefined) ?? job.cwd, ...(name === "bash" ? {} : { interpreter: name }) },
    // Auto's reviewer reads bash, sh and dash as commands; any other shell is not verified.
    ...(/^(bash|sh|dash)$/.test(name) ? { shell: { command, interpreter: `${name}, typed into a terminal`, options: { session_id: job.num } } } : {}),
  };
}

// The write goes in. A write that completes a line runs from the value of the line it was judged from; when another
// write went first (two writes of one reply), it is refused and sent again. (A job no gate looked at, one on another
// machine's daemon, has no look to compare with.) Else the job's line is what the write leaves.
export function typedWrite(job: Job, chars: string): string | undefined {
  if (!job.unconfined) return undefined;
  const now = lineOf(job);
  if (job.typedJudged && !job.typedJudged.has(now.n) && step(now, chars).lines.length) return "the line being typed into this terminal changed since this write was judged (another write went first): write it again";
  return undefined;
}

export function typedWrote(job: Job, chars: string) {
  if (job.unconfined) job.typed = step(lineOf(job), chars).next;
}
