// A push by hand to the base of a repository that lands through its own queue. A repository whose .keel/checks.json
// has a land block (or the owner's checks setting for it) lands by the landing queue (src/landing/queue.ts): the queue
// builds the branch on the base, runs the checks the base names, fast-forwards the base and pushes it, and moves the pins
// of the instruction files it landed (landed-trust.ts). A `git push <commit>:main` from a model's shell skips all of it,
// and asks the owner as any push does. The gate sends such a line back to the model once with the queue call to make
// instead (gate.ts); the same line again is judged as it is. A turn with no word of the owner's in it is refused, as a
// merge is (unstarted.ts).
//
// The words are read here (pure); the repository's facts come from git (landPushOf).
import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { git, locate } from "../core/git.ts";
import { settings } from "../admin/settings.ts";
import { sandboxScope } from "./sandbox-scope.ts";
import { laid } from "./risk.ts";
import { name as baseName } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";

// One git push of a line: the folder it runs in (null: the line does not say one the rules can follow), the remote it
// names as written (null: none, so the branch's own), the refspecs as written, and whether it pushes every branch. A
// dry run (-n, --dry-run) is no push.
export type Push = { dir: string | null; remote: string | null; specs: string[]; all: boolean };

const GIT_VALUED = new Set(["-c", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const PUSH_VALUED = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);

const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

// The pushes of a line, read from its words. A part the line spells with an expansion keeps its folder unknown.
export function pushesOf(command: string, cwd: string, home: string): Push[] {
  if (!/\bpush\b/.test(command)) return [];
  const parts = splitCommand(command);
  if (!parts) return [];
  const pre = laid(parts, cwd, home);
  const out: Push[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!, run = pre.runs[i]!, w = run.words;
    if (part.heredoc || baseName(w[0]) !== "git") continue;
    let dir: string | null = pre.dirs[i] ?? null;
    let k = 1;
    for (; k < w.length && w[k]!.startsWith("-"); k++) {
      const o = w[k]!;
      if (o === "-C") {
        const v = w[++k];
        if (v === undefined || part.dyn?.includes(run.at + k)) dir = null;
        else { const e = expand(v, home); dir = isAbsolute(e) ? e : dir === null ? null : resolve(dir, e); }
      } else if (GIT_VALUED.has(o) || o === "--git-dir") k++;
    }
    if (w[k] !== "push") continue;
    const specs: string[] = [];
    let all = false, dry = false, remote: string | null = null, named = false;
    for (let n = k + 1; n < w.length; n++) {
      const a = w[n]!;
      if (a === "--") continue;
      if (a === "--repo") { remote = w[++n] ?? null; named = true; continue; }
      if (a.startsWith("--repo=")) { remote = a.slice(7); named = true; continue; }
      if (PUSH_VALUED.has(a)) { n++; continue; }
      if (a === "--all" || a === "--mirror" || a === "--branches") { all = true; continue; }
      if (a === "-n" || a === "--dry-run") { dry = true; continue; }
      if (a.startsWith("-")) { if (/^-[a-zA-Z]*n/.test(a) && !a.startsWith("--")) dry = true; continue; }
      if (!named) { named = true; remote = a; continue; }
      specs.push(a);
    }
    if (!dry) out.push({ dir, remote, specs, all });
  }
  return out;
}

// A refspec's source and destination: `a:b`, `+a:b`, `a` (the same name on the remote).
export function specOf(spec: string): { src: string; dst: string } {
  const s = spec.startsWith("+") ? spec.slice(1) : spec;
  const at = s.indexOf(":");
  return at < 0 ? { src: s, dst: s } : { src: s.slice(0, at), dst: s.slice(at + 1) };
}

const short = (ref: string) => ref.replace(/^refs\/heads\//, "");

// Whether a refspec moves the branch `base` (its short name) on the remote. `current`: the branch the folder has out,
// for a spec of HEAD. A delete (`:main`) is not a landing (unstarted.ts reads it), and a destination an expansion makes
// is not read.
export function movesBase(spec: string, base: string, current: string | null): boolean {
  const { src, dst } = specOf(spec);
  if (!src || /[$`]/.test(dst)) return false;
  const to = dst === "HEAD" ? current : short(dst);
  return to === base;
}

// What a hand landing pushes, for the model to be told: the branches it can queue instead.
// `sure`: the line names the folder (or runs in the call's), so the push is known to be in this repository; a folder
// spelled with an expansion is only taken to be.
export type LandPush = { repo: string; base: string; branches: string[]; commits: string[]; sure: boolean };

type Repo = { top: string; common: string; scope: string };
const repoAt = (dir: string): Repo | null => {
  try {
    const w = locate(dir);
    if (!w?.top) return null;
    return { top: w.top, common: realpathSync(w.common), scope: sandboxScope(w.top) };
  } catch { return null; }
};

// The base the queue lands on (queue.ts baseOf): the local branch origin/HEAD names, else main or master; only a local
// branch, as the queue lands only one.
async function baseOf(top: string): Promise<{ ref: string; name: string } | null> {
  const origin = (await git(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { read: true })).out.trim();
  const cands = origin ? [`refs/heads/${origin.split("/").slice(3).join("/")}`] : ["refs/heads/main", "refs/heads/master"];
  for (const ref of cands) {
    if ((await git(top, ["rev-parse", "--verify", "--quiet", ref], { read: true })).code !== 0) continue;
    return { ref, name: short(ref) };
  }
  return null;
}

// The remote the queue pushes the base to when the repository lands through it, or null when it does not: a land block
// in the owner's checks setting for it, else in the base's own .keel/checks.json (what the queue reads). Its push remote
// is `land.push`, origin when it names none.
const pushRemote = (land: unknown) => {
  const p = land && typeof land === "object" ? (land as { push?: unknown }).push : undefined;
  return typeof p === "string" && p.trim() ? p.trim() : "origin";
};
async function lands(top: string, scope: string, base: string): Promise<string | null> {
  const setting = (settings().checks?.repos as Record<string, { land?: unknown } | undefined> | undefined)?.[scope];
  if (setting && typeof setting === "object" && setting.land !== undefined) return pushRemote(setting.land);
  const shown = await git(top, ["show", `${base}:.keel/checks.json`], { read: true });
  if (shown.code !== 0) return null;
  try { const land = (JSON.parse(shown.out) as { land?: unknown })?.land; return land === undefined ? null : pushRemote(land); } catch { return null; }
}

const commitOf = async (dir: string, rev: string) => {
  const r = await git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { read: true });
  return r.code === 0 ? r.out.trim() : null;
};

// The hand landing a line makes, or null. `cwd`: where the call runs; `home`: the shell's home; `own`: the session's
// folder, whose repository the queue lands. A push whose folder the line does not say is read in the call's folder.
// Only a push in the repository of the session's own folder counts: the queue lands that one. A push of the commit
// the base already holds here (the queue landed it and its push was skipped or refused) is no landing.
export async function landPushOf(command: string, cwd: string, home: string, own: string): Promise<LandPush | null> {
  const pushes = pushesOf(command, cwd, home);
  if (!pushes.length) return null;
  const mine = repoAt(own);
  if (!mine) return null;
  const facts = new Map<string, { base: { ref: string; name: string } | null; remote: string | null }>();
  for (const p of pushes) {
    const dir = p.dir ?? cwd;
    const r = repoAt(dir) ?? (p.dir === null ? mine : null);
    if (!r || r.common !== mine.common) continue;
    let f = facts.get(r.common);
    if (!f) {
      const base = await baseOf(r.top);
      f = { base, remote: base ? await lands(r.top, r.scope, base.ref) : null };
      facts.set(r.common, f);
    }
    if (!f.base || !f.remote) continue;
    // (Only a push to the remote the queue pushes to, or one that names none, lands: a fork, another remote, a URL or a
    // local path is not the base the queue moves.)
    if (p.remote !== null && p.remote !== f.remote) continue;
    // (A folder the line does not say: its HEAD is not known, only the names every worktree of the repository shares.)
    const known = p.dir !== null && !!repoAt(p.dir);
    const there = known ? p.dir! : r.top;
    const current = known ? (await git(there, ["symbolic-ref", "--quiet", "--short", "HEAD"], { read: true })).out.trim() || null : null;
    const specs = p.all ? [f.base.name] : p.specs.length ? p.specs : current ? [current] : [];
    const hits = specs.filter((s) => movesBase(s, f!.base!.name, current));
    if (!hits.length) continue;
    const baseTip = await commitOf(r.top, f.base.ref);
    const branches: string[] = [], commits: string[] = [];
    let landing = false;
    for (const s of hits) {
      const { src } = specOf(s);
      const at = /[$`]/.test(src) || (!known && /^(HEAD|@)/.test(src)) ? null : await commitOf(there, src);
      // (What the base already is here: publishing the queue's own landing.)
      if (at && at === baseTip) continue;
      landing = true;
      if (!at) continue;
      commits.push(at);
      if (src !== "HEAD" && short(src) !== f.base.name && (await git(there, ["rev-parse", "--verify", "--quiet", `refs/heads/${short(src)}`], { read: true })).code === 0) { branches.push(short(src)); continue; }
      const named = await git(r.top, ["for-each-ref", `--points-at=${at}`, "--format=%(refname:short)", "refs/heads"], { read: true });
      for (const b of named.out.split("\n").map((x) => x.trim()).filter((x) => x && x !== f!.base!.name)) branches.push(b);
    }
    if (landing) return { repo: r.top, base: f.base.name, branches: [...new Set(branches)].slice(0, 6), commits: [...new Set(commits)].slice(0, 6), sure: p.dir !== null };
  }
  return null;
}

const queueCall = (l: LandPush) => `keel__landing_queue with action "queue" and branches ${l.branches.length ? JSON.stringify(l.branches) : '["<the branch>"]'}`;

// What a session's model is told the first time: the queue call to make, and that the same line again is judged as it is.
export function landBack(l: LandPush, agent: boolean): string {
  const what = l.commits.length ? ` (${l.commits.map((c) => c.slice(0, 12)).join(", ")})` : "";
  const queue = agent
    ? `An agent does not land: say the branch in your report, and the session that started you queues it with keel__landing_queue.`
    : `Queue it instead: ${queueCall(l)}. The queue builds it on ${l.base} with the entries ahead of it, runs the checks ${l.base} names on that tree, fast-forwards ${l.base} and pushes it, and trusts the instruction files it lands. The outcome comes as a message.`;
  return `Held before it ran: this pushes to ${l.base}${what} by hand, and this repository lands on ${l.base} through its landing queue (its .keel/checks.json has a land block). Nothing was run. ${queue}`
    + `${l.branches.length || agent ? "" : " A commit with no branch: make one at it first (git branch NAME COMMIT)."}`
    + " If the queue cannot take it (it said so, or it moved the base here and its push was skipped or refused), send the same line again: it is judged as it is.";
}

// What a turn nobody started is told: refused, every time. The queue still takes the branch in such a turn: it lands only
// what the checks the base names passed on.
export function landUnstarted(l: LandPush): string {
  const queue = l.branches.length ? `Queue ${l.branches.join(", ")} with keel__landing_queue (action "queue")` : `Queue the branch with keel__landing_queue (action "queue")`;
  return `Refused: the command pushes to ${l.base} by hand, and this repository lands on ${l.base} through its landing queue. No message of the owner's is in this turn (a loop run, a wake, a monitor's batch, a watch or an agent's report started it), so a hand landing is not made in it, in any form. Nothing was run. ${queue}; an agent says the branch in its report instead. If the queue cannot land it, say so in your reply; the limit lifts when the owner sends a message to this session.`;
}
