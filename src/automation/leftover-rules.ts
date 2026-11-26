// What an agent left behind, decided: which of its processes are stopped, whether the worktree Keel made for
// it goes, what else is new in its repositories (listed, never removed), and the one line its report carries.
// Pure: the facts are read in leftovers.ts.
//
// Keel removes by itself only what Keel made and recorded when it made it: the managed worktree of the agent's
// session and its branch. Nothing the agent can write (a command line, a file, a trace, a reflog) decides a
// removal: whatever else is new is only listed, with what is in it, for the owner to remove.

// A command of the agent's that still has processes alive. `clients`: open connections to its ports from
// processes that are not its own (something uses the server).
export type ProcLeft = { job: string; command: string; pids: number[]; ports: number[]; clients: number };
export type Fate = { act: "stop" | "remove" } | { act: "keep"; why: string };

export function processFate(p: ProcLeft): Fate {
  if (p.clients > 0) return { act: "keep", why: `${p.clients === 1 ? "a connection" : `${p.clients} connections`} of another process to port ${p.ports.join(", ")}` };
  return { act: "stop" };
}

// One entry of `git worktree list --porcelain`. The first is the main worktree.
export type GitTree = { path: string; head: string; branch?: string; main: boolean; locked?: boolean; prunable?: boolean };
export function parseWorktrees(text: string): GitTree[] {
  const out: GitTree[] = [];
  for (const block of text.split(/\n\n+/)) {
    let t: GitTree | undefined;
    for (const line of block.split("\n")) {
      const sp = line.indexOf(" ");
      const key = sp < 0 ? line : line.slice(0, sp), val = sp < 0 ? "" : line.slice(sp + 1);
      if (key === "worktree") t = { path: val, head: "", main: out.length === 0 };
      else if (!t) continue;
      else if (key === "HEAD") t.head = val;
      else if (key === "branch") t.branch = val.replace(/^refs\/heads\//, "");
      else if (key === "locked") t.locked = true;
      else if (key === "prunable") t.prunable = true;
      else if (key === "bare") t.main = true;
    }
    if (t) out.push(t);
  }
  return out;
}

// What a repository held before the agent started, when that was read: its worktrees' paths and its branches.
export type GitSnap = { worktrees: string[]; branches: Record<string, string> };

// What is new in a repository since the agent started: worktrees and branches that were not there. Who made
// them is not known (the agent, its commands' children, the owner, another session), so they are only listed.
// `skip`: Keel's own worktree and branch for the agent, told on their own, and the folders where Keel makes
// scratch worktrees of its own (`under`: a fails-before run, the landing queue), which come and go with Keel's
// own work and are never an agent's. `same`: the key a path is compared by.
export function newSince(before: GitSnap, trees: GitTree[], heads: Record<string, string>, skip: { trees: Set<string>; branches: Set<string>; under?: readonly string[] }, same: (p: string) => string = (p) => p): { trees: GitTree[]; branches: string[] } {
  const had = new Set(before.worktrees.map(same));
  const skipped = new Set([...skip.trees].map(same));
  const under = (skip.under ?? []).map((u) => same(u).replace(/\/+$/, ""));
  const keels = (p: string) => { const k = same(p); return under.some((u) => k === u || k.startsWith(`${u}/`)); };
  return {
    trees: trees.filter((t) => !t.main && !had.has(same(t.path)) && !skipped.has(same(t.path)) && !keels(t.path)),
    branches: Object.keys(heads).filter((b) => !(b in before.branches) && !skip.branches.has(b)),
  };
}

// ---- a branch that landed with another patch: rebased, cherry-picked with a conflict edit, squashed, a fix on top.
//
// Its commits are on no other branch, yet its work may be on the base. The one test of what the base holds is a
// merge: the branch merged on a commit of the base gives that commit's own tree (git merge-tree), which is what
// landing it there would make, so that commit holds every line the branch changes, whatever its commits look like.
// No patch id speaks for it: a patch id skips merge commits (a merge that adds work of its own) and ignores
// whitespace, a diff that applies fails on a later edit of the same lines, and both miss a squash. A revert on the
// base makes the merge give the branch's lines back, so a reverted change never counts as held at the tip.
//   "whole": the base's tip holds it. Nothing of it is lost when the branch goes.
//   "earlier": an older commit of the base held it (the one it landed as), the tip no longer does (a revert, a
//     later edit of its lines). Its branch stays; only its folder may go, which loses nothing committed.
//   "changed": the landing record names it (the landing queue landed this tip on a commit the base holds, or more
//     than one subject of it is on the base: all of them, or some and a review said land it) but no commit of the
//     base holds its lines as they are: what landed was edited (a conflict resolved, a fix on top). As "earlier".
// A branch with no commit over the base is merged, not landed: the other rules decide it.
export type Landed = { how: "whole" | "earlier"; at: string } | { how: "changed"; at: string; why: string };
// What the landing record says of a branch whose lines no commit of the base holds. `commits`: its commits over the
// base, by subject; `matched`: how many of those subjects a commit of the base since the fork has; `newest`: the
// newest such commit; `queued`: the commit the landing queue landed this tip as, when the base holds it;
// `reviewed`: a review said land it. One subject alone is too common a line to name a landing.
export type LandRecord = { commits: number; matched: number; newest?: string; queued?: string; reviewed?: boolean };
export function recordOf(r: LandRecord): { at: string; why: string } | undefined {
  if (r.queued) return { at: r.queued, why: "the landing queue landed it" };
  if (!r.newest || r.matched < 2) return undefined;
  if (r.matched >= r.commits) return { at: r.newest, why: `its ${r.commits} commits are on the base by subject` };
  if (r.reviewed) return { at: r.newest, why: `a review said land it, and ${r.matched} of its ${r.commits} commits are on the base by subject` };
  return undefined;
}
// The commits of the base worth a merge-tree, newest first: the one the landing queue landed it as, then those whose
// subject is one of the branch's (a rebase and a cherry-pick keep it). At most `max`.
export function candidatesOf(baseLog: { sha: string; subject: string }[], subjects: Set<string>, queued?: string, max = 8): string[] {
  const out = queued ? [queued] : [];
  for (const c of baseLog) {
    if (out.length >= max) break;
    if (subjects.has(c.subject) && !out.includes(c.sha)) out.push(c.sha);
  }
  return out;
}
export function landedWords(l: Landed): string {
  if (l.how === "changed") return `landed as ${l.at.slice(0, 10)} with changes (${l.why})`;
  if (l.how === "earlier") return `landed as ${l.at.slice(0, 10)}, and the base's tip no longer holds its every line (reverted or edited since)`;
  return `the base holds its every line at ${l.at.slice(0, 10)}`;
}
// What the landed pass and the page call a landing.
export function landedName(l: Landed): string {
  return l.how === "whole" ? "landed" : l.how === "earlier" ? "landed, changed since" : "landed with changes";
}

// What is in a worktree: uncommitted and untracked files, ignored ones (git worktree remove deletes them),
// commits that no other branch, remote branch or tag holds, a repository inside it with work of its own, a
// process or session in it. `landed`: the base holds its branch's work though not its commits (above).
export type TreeState = { dirty: number; ignored?: string[]; unique: number; busy?: string; unknown?: string; inner?: string; landed?: Landed };
export function treeHolds(s: TreeState): string {
  if (s.unknown) return `git could not read it: ${s.unknown}`;
  const parts: string[] = [];
  if (s.dirty) parts.push(count(s.dirty, "uncommitted file"));
  if (s.unique) parts.push(`${count(s.unique, "commit")} on no other branch`);
  if (s.ignored?.length) parts.push(ignoredWords(s.ignored));
  if (s.inner) parts.push(s.inner);
  if (s.busy) parts.push(s.busy);
  return parts.length ? parts.join(", ") : "nothing uncommitted, no commit of its own";
}
export function branchHolds(s: { unique: number; out?: string; unknown?: string }): string {
  if (s.unknown) return `git could not read it: ${s.unknown}`;
  const parts = [s.unique ? `${count(s.unique, "commit")} on no other branch` : "every commit on another branch"];
  if (s.out) parts.push(`checked out in ${s.out}`);
  return parts.join(", ");
}

// The worktree Keel made for the agent goes, with its branch, when nothing of it would be lost and nothing uses
// it: no uncommitted or untracked file, no commit that only its branch holds, no repository inside it with work
// of its own, no process or other session in it. Its ignored files go with it (build output, the files Keel
// copied in from .worktreeinclude), as they always have. A branch whose commits are its own goes too when the base
// holds its whole work (`landed` whole); one that landed with changes is kept, with its worktree, for the owner.
export function ownTreeFate(s: TreeState): Fate {
  if (s.unknown) return { act: "keep", why: `git could not read it: ${s.unknown}` };
  if (s.inner) return { act: "keep", why: s.inner };
  if (s.busy) return { act: "keep", why: s.busy };
  if (s.dirty) return { act: "keep", why: count(s.dirty, "uncommitted file") };
  if (s.unique && s.landed?.how !== "whole") return { act: "keep", why: `${count(s.unique, "commit")} on no other branch${s.landed ? `, ${landedWords(s.landed)}` : ""}` };
  return { act: "remove" };
}

// The landed pass of the page: a listed worktree that goes, and whether its branch goes with it. A worktree with
// anything uncommitted, locked, gone, or with no branch is not in it; a whole landing takes the branch, a changed
// or older one leaves it.
export function landedPass(t: { removable: boolean; branch?: string; missing?: boolean; landed?: Landed }): "tree-and-branch" | "tree" | undefined {
  if (!t.removable || !t.branch || t.missing || !t.landed) return undefined;
  return t.landed.how === "whole" ? "tree-and-branch" : "tree";
}

export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Ignored files in a few words: how many, and the first three by name.
export const ignoredWords = (names: string[]) => `${count(names.length, "ignored path")} (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", ..." : ""})`;
// A command as the line names it: one line, at most 60 characters.
export const cmd = (c: string) => `\`${c.replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 60)}\``;

export type Found = { kind: "worktree" | "branch"; repo: string; path?: string; name?: string; holds: string };
export type Settled = {
  stopped: (ProcLeft & { left?: number[] })[];   // `left`: pids the stop could not end
  kept: (ProcLeft & { why: string })[];
  found: Found[];                                 // new in its repositories since it started: listed, not removed
  units?: string[];                               // systemd units its commands name ("" for one with no name)
};

// The one line of the report: what was stopped, what is left and what is in it. Nothing when it left nothing.
export function leftLine(s: Settled): string {
  const parts: string[] = [];
  const procs = (list: ProcLeft[]) => list.map((p) => `${cmd(p.command)}${p.ports.length ? ` on port ${p.ports.join(", ")}` : ""}`).join(", ");
  const ended = s.stopped.filter((p) => !p.left?.length), stuck = s.stopped.filter((p) => p.left?.length);
  if (ended.length) parts.push(`stopped ${procs(ended)}`);
  if (stuck.length) parts.push(`could not stop ${stuck.map((p) => `${cmd(p.command)} (pid ${p.left!.join(", ")})`).join(", ")}`);
  if (s.kept.length) parts.push(`left running ${s.kept.map((p) => `${cmd(p.command)}${p.ports.length ? ` on port ${p.ports.join(", ")}` : ""} (${p.why})`).join(", ")}, which ${s.kept.length > 1 ? "run" : "runs"} until stopped from Settings, Leftovers`);
  if (s.found.length) {
    const one = (f: Found) => f.kind === "worktree" ? `worktree ${f.path} (${f.name ? `branch ${f.name}` : "detached"}: ${f.holds})` : `branch ${f.name} in ${f.repo} (${f.holds})`;
    const them = s.found.length > 1 ? "them" : "it";
    parts.push(`new in its repositories since it started, not removed (who made ${them} is not known; Settings, Leftovers removes ${them}): ${s.found.map(one).join(", ")}`);
  }
  if (s.units?.length) {
    const named = s.units.filter(Boolean), bare = s.units.length - named.length;
    if (named.length) parts.push(`its commands name systemd unit${named.length > 1 ? "s" : ""} ${named.join(", ")} (systemd-run), which Keel neither tracks nor stops (systemctl --user stop ${named.join(" ")})`);
    if (bare) parts.push(`its commands start ${bare === 1 ? "a systemd unit with no name" : `${bare} systemd units with no name`} (systemd-run), which Keel neither tracks nor stops`);
  }
  return parts.length ? `Left behind: ${parts.join("; ")}.` : "";
}

// ---- job scopes that outlive their command: a build tool's daemon, a server, a shell left waiting.
//
// Keel acts only on a scope it made: the name startJob gives (`keel-job-<id>-<6 letters>.scope`) in the
// user manager's app.slice, and this daemon's own record of that job naming that exact cgroup
// (src/tools/jobs.ts, adoptJobs and adoptScopes). Pure: the facts are read in scopes.ts.

// A build tool's own server, by its command line: a build starts it for the next build to reuse, and it
// stays when the build ends, by design (Gradle's for three hours by its own idle timeout).
const BUILD_DAEMONS: { kind: string; test: (argv: string[]) => boolean }[] = [
  { kind: "Gradle daemon", test: (a) => a.includes("org.gradle.launcher.daemon.bootstrap.GradleDaemon") },
  { kind: "Kotlin daemon", test: (a) => a.includes("org.jetbrains.kotlin.daemon.KotlinCompileDaemon") },
  { kind: "Bazel server", test: (a) => a.some((x) => /(^|\/)A-server\.jar$/.test(x)) },
  { kind: "sccache server", test: (a) => a.length === 1 && /(^|\/)sccache$/.test(a[0]!) },
];
export const buildKind = (argv: string[]): string | undefined => BUILD_DAEMONS.find((b) => b.test(argv))?.kind;
// A server that other tools share whoever started it: a scope that holds one is never stopped by Keel. adb's
// (`adb ... fork-server server`) is the one every device tool talks to; a stop drops every device's connection.
const SHARED: { kind: string; test: (argv: string[]) => boolean }[] = [
  { kind: "adb server", test: (a) => /(^|\/)adb$/.test(a[0] ?? "") && a.includes("fork-server") && a.includes("server") },
];
export const sharedKind = (argv: string[]): string | undefined => SHARED.find((b) => b.test(argv))?.kind;

// A sample (a minute) counts as idle when the scope (or a build daemon, by its own processor time) used less
// than this share of one core in it. Measured a minute at a time on scopes at rest: a Gradle or Kotlin daemon
// 0.1% (2% at most), an MCP server 0.2%, a Keel daemon with no turn 5%, a group of 18 shells that each poll for
// a file once a second 7%; scopes at work (a build, a test run, a browser spec) passed 10% in most minutes.
export const IDLE_SHARE = 0.1;
// How long a scope of an ended session is idle before it is stopped. Its session reads nothing of it any
// more; the bound only lets a command that is still at work finish what it does: one at work stays under
// the share above for ten minutes in a row only while it waits on something else.
export const SCOPE_IDLE_MS = 10 * 60_000;
// How long a build daemon whose command ended is idle before it is stopped while its session lives. Measured
// on the gaps between one session's build commands: nine in ten come within 19 minutes, so a daemon idle for
// 30 is reused by most next builds, and the rest start one again (seconds) instead of holding a gigabyte or
// two for hours.
export const BUILD_IDLE_MS = 30 * 60_000;

export type ScopeFacts = {
  ended?: string;          // how its session ended (gone, archived, its agent ended); absent: the session lives
  keep?: boolean;          // the owner marked it to keep
  owner?: boolean;         // the owner ran it from the terminal pane
  self?: boolean;          // this daemon, or a process above it, runs in it
  shared?: string;         // a server other tools share runs in it (sharedKind)
  attached?: string;       // a process in it is someone's: it has a terminal, or it was put in from outside
  clients: number;         // connections to its ports from processes that are not its own
  ports: number[];
  commandEnded: boolean;   // its command ended; what is left is what it started
  idleMs: number;          // how long the whole scope has been idle (IDLE_SHARE)
  builds: { pid: number; kind: string; idleMs: number }[];
};
export type ScopeFate = { act: "stop"; why: string } | { act: "stop-builds"; pids: number[]; why: string } | { act: "keep"; why: string };
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;
const kinds = (b: { kind: string }[]) => [...new Set(b.map((x) => x.kind))].join(" and ");

export function scopeFate(f: ScopeFacts, o: { idleMs?: number; buildIdleMs?: number } = {}): ScopeFate {
  const idle = o.idleMs ?? SCOPE_IDLE_MS, buildIdle = o.buildIdleMs ?? BUILD_IDLE_MS;
  if (f.self) return { act: "keep", why: "this daemon runs in it" };
  if (f.owner) return { act: "keep", why: "you ran it in the terminal" };
  if (f.keep) return { act: "keep", why: "you keep it" };
  if (f.attached) return { act: "keep", why: `${f.attached}: it is kept until you stop it` };
  if (f.shared) return { act: "keep", why: `its ${f.shared} is shared by other tools` };
  if (f.clients > 0) return { act: "keep", why: `${f.clients === 1 ? "a connection" : `${f.clients} connections`} of another process to port ${f.ports.join(", ")}` };
  if (f.ended) {
    if (f.idleMs >= idle) return { act: "stop", why: `${f.ended}, and it used no processor for ${mins(f.idleMs)}` };
    if (f.commandEnded && f.builds.length) return { act: "stop-builds", pids: f.builds.map((b) => b.pid), why: `${f.ended}: its ${kinds(f.builds)} served only its builds` };
    return { act: "keep", why: `${f.ended}; it is stopped once idle for ${mins(idle)}` };
  }
  const due = f.commandEnded ? f.builds.filter((b) => b.idleMs >= buildIdle) : [];
  if (due.length) return { act: "stop-builds", pids: due.map((b) => b.pid), why: `its ${kinds(due)} built nothing for ${mins(Math.min(...due.map((b) => b.idleMs)))}` };
  if (f.commandEnded && f.builds.length) return { act: "keep", why: `its session lives; its ${kinds(f.builds)} ${f.builds.length === 1 ? "is" : "are"} stopped once idle for ${mins(buildIdle)}` };
  return { act: "keep", why: "its session lives" };
}

// The next idle mark of a scope or a process from one sample of its processor time (ms): idle since when.
// A first sample starts the count; a sample over IDLE_SHARE of one core starts it again.
export type IdleMark = { cpu: number; at: number; since: number };
export function nextIdle(prev: IdleMark | undefined, cpu: number, at: number): IdleMark {
  if (!prev || at <= prev.at || cpu < prev.cpu) return { cpu, at, since: at };
  return { cpu, at, since: (cpu - prev.cpu) / (at - prev.at) >= IDLE_SHARE ? at : prev.since };
}

// Whether a process in a job's scope is someone's, so the scope is not stopped whole: one with a controlling
// terminal or a terminal's end open (an editor, tmux, a shell the owner attached), or one whose parent is
// outside the scope and is neither the job's own command (`job`: its pid and start time) nor where orphans go
// (`reapers`: the user manager, init). What the job's command started has its parent in the scope, or was
// orphaned there; a process moved in from outside (`echo $$ > cgroup.procs`) has neither.
export type ScopeProc = { pid: number; parent: number; start: string; tty: boolean; pty: boolean };
export function attachedWhy(procs: ScopeProc[], job: { pid: number; start?: string }, reapers: Set<number>): string | undefined {
  const t = procs.find((p) => p.tty || p.pty);
  if (t) return `process ${t.pid} in it has a terminal`;
  const inScope = new Set(procs.map((p) => p.pid));
  const own = (p: ScopeProc) => p.pid === job.pid && (job.start === undefined || p.start === job.start);
  const o = procs.find((p) => !inScope.has(p.parent) && !reapers.has(p.parent) && p.parent !== job.pid && !own(p));
  return o ? `process ${o.pid} was put in it from outside (its parent ${o.parent} is not of the command)` : undefined;
}
