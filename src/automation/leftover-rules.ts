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

// What is in a worktree: uncommitted and untracked files, ignored ones (git worktree remove deletes them),
// commits that no other branch, remote branch or tag holds, a repository inside it with work of its own, a
// process or session in it.
export type TreeState = { dirty: number; ignored?: string[]; unique: number; busy?: string; unknown?: string; inner?: string };
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
// copied in from .worktreeinclude), as they always have.
export function ownTreeFate(s: TreeState): Fate {
  if (s.unknown) return { act: "keep", why: `git could not read it: ${s.unknown}` };
  if (s.inner) return { act: "keep", why: s.inner };
  if (s.busy) return { act: "keep", why: s.busy };
  if (s.dirty) return { act: "keep", why: count(s.dirty, "uncommitted file") };
  if (s.unique) return { act: "keep", why: `${count(s.unique, "commit")} on no other branch` };
  return { act: "remove" };
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
