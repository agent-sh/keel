// What a file or log wait's wake carries, as plain decisions (the reads are in
// src/automation/waits.ts): the file's new content, which Keel job writes the
// file, what is known of that job, and whether it stalled.
import { normalize } from "node:path";
import { OUTPUT_CAP } from "../tools/spill.ts";

// The most of the file a wake carries: the spill rule's size, as a tool's output.
export const CARRY_MAX = OUTPUT_CAP;

// Whether `command`, run in `cwd`, sends its output to `path`: a redirection
// (`>`, `>>`, `&>`, `2>`) or `tee` into it, with `~`, `$HOME` and the command's
// own assignments put in. A command that only reads the path is not its writer.
export function writesPath(command: string, cwd: string, home: string, path: string): boolean {
  const vars = new Map<string, string>([["HOME", home]]);
  const put = (s: string) => s.replace(/^~(?=\/|$)/, home).replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a?: string, b?: string) => vars.get((a ?? b)!) ?? m);
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) vars.set(m[1]!, put(m[2]!.replace(/^(["'])(.*)\1$/, "$2")));
  for (const m of command.matchAll(/(?:\d?>>?|&>>?|\btee(?:\s+-a)?)\s*("[^"]*"|'[^']*'|[^\s;&|)<>]+)/g)) {
    const t = put(m[1]!.replace(/^(["'])(.*)\1$/, "$2"));
    if (t.includes("$")) continue;
    if (normalize(t.startsWith("/") ? t : `${cwd}/${t}`) === normalize(path)) return true;
  }
  return false;
}

// The text a wake carries of a file: what it gained since the wait began
// (`fromStart`: all of it, the file is new or was replaced), its last
// CARRY_MAX characters when more, cut at a line's start, with where the rest
// is. `unchanged`: nothing was added, and the file's end is carried as it is.
// `skipped`: bytes of the new part before `text` that were not read (far more than is carried).
export function carryText(o: { path: string; text: string; from: number; size: number; fromStart: boolean; unchanged: boolean; binary: boolean; skipped?: number }): string {
  if (o.binary) return `${o.path} holds binary data (${o.size} bytes): it is not carried.`;
  if (!o.text) return o.unchanged ? `${o.path} is empty.` : `Nothing was added to ${o.path} since the wait began.`;
  let text = o.text;
  let cut = 0;
  const skipped = o.skipped ?? 0;
  if (text.length > CARRY_MAX || skipped) {
    const tail = text.slice(-CARRY_MAX);
    const nl = tail.indexOf("\n");
    // (A line the read began inside of is not carried in part.)
    const at = nl >= 0 && nl < 2000 && (text.length > CARRY_MAX || skipped) ? nl + 1 : 0;
    cut = text.length - tail.length + at;
    text = tail.slice(at);
  }
  const what = o.unchanged ? `The end of ${o.path} (nothing was added since the wait began)` : o.fromStart ? `${o.path} (${o.size} bytes)` : `What ${o.path} gained since the wait began (from byte ${o.from} of ${o.size})`;
  const rest = cut || skipped ? `\n[${skipped ? `${skipped} bytes and ` : ""}${cut} characters before this are not carried: Read the file for them]` : "";
  return `${what}:${rest}\n${text.replace(/\n$/, "")}`;
}

// What Keel knows of the job that writes the file, in a line.
export type JobFacts = {
  id: string; command: string; started: number;
  running: boolean;            // its command has not ended
  live: boolean;               // it or something it started still runs (its cgroup holds processes)
  exit?: number | null; signal?: string | null; ended?: number; stopReason?: string;
  lastOutput?: number;         // the last write to the file or to the job's own log
};
const ago = (ms: number) => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
export function jobLine(j: JobFacts, now: number): string {
  const cmd = j.command.replace(/\s+/g, " ").trim().slice(0, 80);
  const out = j.lastOutput ? `, its last output ${ago(now - j.lastOutput)} ago` : "";
  if (j.running) return `Job ${j.id} (\`${cmd}\`) that writes it is running, for ${ago(now - j.started)}${out}.`;
  const how = j.stopReason ? `it ${j.stopReason}` : j.signal ? `it was killed by ${j.signal}` : `exit ${j.exit ?? "unknown"}`;
  const left = j.live ? "; processes it started still run" : "";
  return `Job ${j.id} (\`${cmd}\`) that writes it ended ${j.ended ? `${ago(now - j.ended)} ago` : ""} (${how})${left}${out}.`;
}

// Programs that wait by design: a job whose processes include one is waiting
// on something else (another machine, a lock, a slot, a timer), not stalled.
export const WAITERS = new Set(["ssh", "scp", "rsync", "sftp", "mosh-client", "waitfor", "sleep", "flock", "inotifywait", "tail", "wait", "read", "systemd-run", "gh", "curl", "wget", "git-remote-http", "git-remote-https"]);

// A stall: the job still runs, nothing of it used the processor and nothing
// was written for `after` ms, and none of its processes is a waiter.
export function stalled(o: { now: number; since: number; waiting: boolean; after: number }): boolean {
  return !o.waiting && o.now - o.since >= o.after;
}
