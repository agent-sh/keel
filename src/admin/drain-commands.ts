// What a restart does with the commands a turn runs in front (a tool call that waits on its command).
// The call stops its command when the turn is parked, so a restart that parks a turn mid-command
// loses the command's work. The drain therefore waits for the commands that run when its time for
// the turns is over, up to a bound, and parks the turns only then. The wait ends as soon as the
// commands it began with have ended. A restart waits only for the commands in a terminal the daemon
// holds: every other one runs on past it and the next daemon takes it back (releaseFronts in
// src/tools/jobs.ts), so its work is not lost and the turns are not held for it.
//
// The bound is one minute. Measured over the last restarts of a busy daemon, the foreground commands
// a restart cut had run 0 s to 5 min, and about 58 percent of the commands that had run as long
// finished within a minute more (the finished foreground commands of the same sessions; most take
// seconds, the tail is builds and waits). A longer bound costs every restart that much more for a
// shrinking share of commands.
export const COMMAND_WAIT_MS = 60_000;

export type Front = { id: string; session: string };

// Waits until every command that runs now has ended, or `boundMs` has passed. Says how many it began
// with (`waited`) and how many still ran at the end (`cut`). A command that starts meanwhile is not waited for.
export async function waitForCommands(o: { list: () => Front[]; boundMs: number; pollMs?: number; now?: () => number; wait?: (ms: number) => Promise<unknown> }): Promise<{ waited: number; cut: number }> {
  const now = o.now ?? Date.now, wait = o.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const first = new Set(o.list().map((c) => c.id));
  if (!first.size) return { waited: 0, cut: 0 };
  const until = now() + o.boundMs;
  let left = first.size;
  while (left) {
    const rest = until - now();
    if (rest <= 0) break;
    await wait(Math.min(rest, o.pollMs ?? 100));
    left = o.list().filter((c) => first.has(c.id)).length;
  }
  return { waited: first.size, cut: left };
}

const times = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// The drain's words about the commands: said when the wait begins and, when some still run at its end, again.
export const commandsBegin = (n: number, boundMs: number) =>
  `${times(n, "command")} ${n === 1 ? "runs" : "run"} in front of a turn: the restart waits up to ${Math.round(boundMs / 1000)} s more for ${n === 1 ? "it" : "them"} before it parks the turns.`;
export const commandsEnd = (cut: number, boundMs: number) =>
  `${times(cut, "command")} still ran after ${Math.round(boundMs / 1000)} s and ${cut === 1 ? "was" : "were"} stopped by the restart: ${cut === 1 ? "its call says" : "their calls say"} so, and the turn runs ${cut === 1 ? "it" : "them"} again if the work is still needed.`;
