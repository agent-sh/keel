// Whether a folder is in use, the one check every guard that changes or moves
// a folder's files asks (a worktree's park, move, remove and prune; a
// checkpoint's rewind, file restore and hunk revert). In use: a turn running
// in it or around it (this session's or another's), a background command of
// any session whose folder overlaps it, and other sessions that work in it.
// Folders compare where their links land, nested either way.
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { contains, overlaps, realOf } from "../core/paths.ts";
import { jobsIn, leftText, stopJobs, type Job } from "../tools/jobs.ts";

export type FolderUse = { turns: Session[]; others: Session[]; jobs: Job[] };

export function folderUse(store: Store, isRunning: (id: string) => boolean, dir: string, selfId?: string): FolderUse {
  const d = realOf(dir);
  const all = store.sessions().filter((o) => !o.archived);
  const others = all.filter((o) => o.id !== selfId && contains(d, realOf(o.workspace)));
  const turns = all.filter((o) => isRunning(o.id) && (o.id === selfId || overlaps(o.workspace, dir)));
  return { turns, others, jobs: jobsIn(dir) };
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

// The answer when it is in use, or null when the change may go ahead. With
// `stopShells` the commands are stopped first (the owner asked for it), as
// archive does; other sessions in the folder are named, never stopped.
// `others`: whether other sessions working in the folder hold it (a move or a
// removal breaks them; a rewind does not).
export async function inUse(u: FolderUse, selfId: string, o: { stopShells: boolean; what: string; others: boolean }): Promise<Response | null> {
  if (u.turns.length) return json({ error: u.turns.some((t) => t.id === selfId) ? "a turn is running; stop it first" : `a turn of ${u.turns.map((t) => t.title || t.id).join(", ")} is running in this folder; stop it first` }, 409);
  if (o.others && u.others.length) return json({ error: `${u.others.map((t) => t.title || t.id).join(", ")} ${u.others.length > 1 ? "work" : "works"} in this folder too: move or archive ${u.others.length > 1 ? "them" : "it"} first.`, sessions: u.others.map((t) => ({ id: t.id, title: t.title })) }, 409);
  if (!u.jobs.length) return null;
  const n = u.jobs.length;
  if (!o.stopShells) return json({ error: `${n} background command${n > 1 ? "s" : ""} still run${n > 1 ? "" : "s"} in this folder: ${u.jobs.map((j) => j.command.slice(0, 80)).join("; ")}. Send stop_shells to stop ${n > 1 ? "them" : "it"} first.`, jobs: u.jobs.map((j) => ({ id: j.id, command: j.command, session_id: j.sessionId })) }, 409);
  // Nothing changes while any process of a stopped command is still alive: it could write after.
  const left = await stopJobs(u.jobs, `was stopped: the folder it ran in was ${o.what}`);
  if (left.length) return json({ error: `${left.length > 1 ? "these commands" : "this command"} would not stop, so nothing was ${o.what}: ${leftText(left)}`, jobs: left.map((j) => ({ id: j.id, command: j.command, session_id: j.sessionId, pids: j.left })) }, 409);
  return null;
}
