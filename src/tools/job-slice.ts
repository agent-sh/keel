// Which slice of the user manager a job's scope goes in (src/tools/jobs.ts, src/checks/before-run.ts).
//
// Each job has a scope of its own with its own CPU and IO weight. Scopes side by side in one slice each
// claim their weight: twelve unattended jobs at 50 would claim 600 against the owner's one command at 50.
// So the scopes are grouped by whose work they are, under two slices of app.slice:
//
//   owner       the jobs of a turn the owner's words started or steered (and of the agents his turn waits
//               on, as the load hold reads it), and what he types in a terminal: the default weight.
//   unattended  every other job: loop runs, wakes, agents of trees no owner turn started, Keel's own
//               checks beside an agent and pictures. One weight for all of them together: the weight one
//               sandboxed job scope had alone (KEEL_SANDBOX_CPU_WEIGHT, 50), so the whole fleet of
//               unattended work claims what one command used to.
//
// A weight only divides a processor that is short: on an idle machine the unattended slice takes all of it.
//
// A job's slice is decided once, when it starts, and kept for its life: a cgroup cannot move a running scope
// to another slice, so a background job an unattended turn started stays unattended after the owner steers
// the session (and one his turn started stays his).
export type JobSlice = "owner" | "unattended";

export const SLICES: Record<JobSlice, string> = { owner: "app-keelowner.slice", unattended: "app-keelunattended.slice" };

// Whose a job is: the owner's terminal command, or one of a turn the owner attends, is his; the rest unattended.
// A caller with the owner's own command decides "owner" without asking whether the turn is attended.
// A job whose session cannot be read is counted as attended (what a start did before the slices).
export function jobSlice(o: { byOwner?: boolean; attended?: boolean }): JobSlice {
  return o.byOwner || o.attended !== false ? "owner" : "unattended";
}

// The properties the unattended slice is given (systemctl set-property): its CPU and IO weight.
export function unattendedProps(env: Record<string, string | undefined> = process.env): string[] {
  const w = (v: string | undefined, d: number) => { const n = Math.floor(Number(v)); return n >= 1 && n <= 10_000 ? n : d; };
  return [`CPUWeight=${w(env.KEEL_SANDBOX_CPU_WEIGHT, 50)}`, `IOWeight=${w(env.KEEL_SANDBOX_IO_WEIGHT, 50)}`];
}

// A command that starts a scope (systemd-run's head, then its options) put in `slice`: the head given, its
// `--slice=` added after it (a later one would win over an earlier one, so any other is taken out).
export function inSlice(argv: string[], head: string[], slice: string): string[] {
  if (!head.length || !head.every((a, i) => argv[i] === a)) return argv;
  const end = argv.indexOf("--", head.length);
  if (end < 0) return argv;
  const opts = argv.slice(head.length, end).filter((a) => !a.startsWith("--slice="));
  return [...head, `--slice=${slice}`, ...opts, ...argv.slice(end)];
}
