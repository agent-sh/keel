// What is still running when a checkpoint is made: the session's live agents
// and its background commands, read from the daemon's state at that moment and
// written by the harness. A summary is the model's words and may have lost them
// (or kept a command that ended), so the rebuilt history carries this block
// beside it. Nothing is written when nothing runs.
import type { Store } from "../core/store.ts";
import { jobsOf, running as jobRuns } from "../tools/jobs.ts";

export const RUNNING_MAX = 20;
const WORDS = 200;

export type RunningNow = {
  agents: { id: string; task: string; state: string }[];
  jobs: { id: string; command: string; since: number }[];
  more: number;
};

const oneLine = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > WORDS ? `${t.slice(0, WORDS - 1)}…` : t; };

// The session's agents at work (running or waiting) and its commands that run on, at most RUNNING_MAX together,
// agents first, the rest counted.
export function runningOf(store: Pick<Store, "db">, sessionId: string): RunningNow {
  let agents: { id: string; title: string; status: string }[] = [];
  try {
    agents = store.db.query<{ id: string; title: string; status: string }, [string]>(
      "SELECT id, title, status FROM agents WHERE parent_id = ? AND status IN ('running', 'waiting') ORDER BY created, id").all(sessionId);
  } catch {} // no agents table: a store that never started one
  const jobs = jobsOf(sessionId).filter((j) => j.background && jobRuns(j)).sort((a, b) => a.started - b.started);
  const room = (n: number, from: number) => Math.max(0, Math.min(n, RUNNING_MAX - from));
  const a = agents.slice(0, room(agents.length, 0));
  const j = jobs.slice(0, room(jobs.length, a.length));
  return {
    agents: a.map((x) => ({ id: x.id, task: oneLine(x.title), state: x.status })),
    jobs: j.map((x) => ({ id: x.id, command: oneLine(x.command), since: x.started })),
    more: agents.length + jobs.length - a.length - j.length,
  };
}

const clock = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";

// The block as the model reads it, or "" when nothing runs.
export function runningText(r: RunningNow): string {
  if (!r.agents.length && !r.jobs.length) return "";
  const out = ["[Still running at this compaction, from the session's state (not from the summary):]"];
  if (r.agents.length) out.push("Agents:", ...r.agents.map((x) => `- ${x.id} ${x.state}: ${x.task}`));
  if (r.jobs.length) out.push("Background commands:", ...r.jobs.map((x) => `- ${x.id} since ${clock(x.since)}: ${x.command}`));
  if (r.more) out.push(`(${r.more} more not listed)`);
  return out.join("\n");
}

// What a checkpoint stores: `{ running_text }`, or nothing.
export const runningData = (store: Pick<Store, "db">, sessionId: string): { running_text?: string } => {
  const text = runningText(runningOf(store, sessionId));
  return text ? { running_text: text } : {};
};
