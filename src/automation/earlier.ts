// Earlier attempts at a spawn: when an agent is started in a repository, its spawn's result names the
// closest earlier agents of that repository (at most three): how each ended, its branch and head, and the
// first line of its report, so a coordinator does not redo work that landed or repeat an approach a
// review refused, and sees an agent that already works on the same thing.
//
// Closeness is the task's words (and the files it names) against the earlier agents' (src/automation/
// earlier-rank.ts). The agents and their words are read on the read thread, the outcome of the few shown
// from the review, landing and git facts (src/automation/earlier-line.ts says it). No model request. The
// lines ride the spawn's result once: they are never in the system prompt and never repeated.
import { existsSync } from "node:fs";
import { git } from "../core/git.ts";
import { readsOf } from "../server/reads.ts";
import { capture, D } from "./core.ts";
import * as agents from "./agents.ts";
import { closest, rank, type Doc } from "./earlier-rank.ts";
import { findingClass, noteOf, sayClass, type Ended, type Shown } from "./earlier-line.ts";
import type { Candidate, Outcome } from "./earlier-facts.ts";
import { contextsOf, wroteOf } from "./lane.ts";

const TOTAL_MS = 4_000;   // the whole lookup: a spawn never waits longer for it
const FILES_MS = 1_500;   // reading the files of the few that came close
const GIT_MS = 3_000;
const SHORTLIST = 6;      // agents whose files are read, from the words alone
const SHOWN = 3;

const run = (repo: string, args: string[]) => git(repo, args, { read: true, timeout: GIT_MS }).then((r) => (r.code === 0 ? r.out.trim() : ""), () => "");

// The sessions above a spawn's parent: the coordinator itself is no earlier attempt.
function above(sessionId: string): string[] {
  const out = [sessionId];
  for (let i = 0; i < 12; i++) { const a = agents.byChild(out[out.length - 1]!); if (!a) break; out.push(a.parent_id); }
  return out;
}

// The folders a path may be relative to: the repository, and the agent's own worktree.
const relative = (p: string, roots: string[]) => { for (const r of roots) if (r && p.startsWith(`${r}/`)) return p.slice(r.length + 1); return p; };

async function filesOf(c: Candidate, repo: string): Promise<string[]> {
  const a = agents.get(c.id);
  if (!a) return [];
  const roots = [repo, a.worktree ?? ""];
  const folder = a.worktree ?? D().store.session(a.session_id)?.workspace ?? repo;
  const wrote = await wroteOf(contextsOf(a, 0), folder).catch(() => null);
  return (wrote?.names ?? []).map((n) => relative(n, roots));
}

const baseOf = async (repo: string): Promise<string | undefined> => {
  const origin = await run(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (origin) return origin;
  for (const b of ["main", "master"]) if (await run(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  return undefined;
};

// How one shown agent ended, from git and the review and landing rows.
async function endedOf(c: Candidate, repo: string, base: string | undefined, facts: Outcome): Promise<{ ended: Ended; head: string | null }> {
  const remote = !!c.machine;
  const queue = c.branch ? facts.landed.find((l) => l.branch === c.branch) : undefined;
  const rows = c.branch ? [...facts.verdicts.filter((v) => v.branch === c.branch).map((v) => ({ at: v.at, land: v.land === "yes", class: sayClass(v.why) })), ...facts.panel.filter((p) => p.branch === c.branch && p.verdict).map((p) => ({ at: p.at, land: p.verdict === "correct", class: findingClass(p.priority, p.title) }))].sort((x, y) => y.at - x.at) : [];
  const review = rows[0] ? { land: rows[0].land, class: rows[0].class } : null;
  let tip: string | null = null, landed = !!queue, noWork = false, head: string | null = null;
  if (c.branch && !remote && existsSync(repo)) {
    const sha = await run(repo, ["rev-parse", "-q", "--verify", `refs/heads/${c.branch}^{commit}`]);
    if (sha) {
      tip = sha;
      head = sha.slice(0, 7);
      noWork = !!c.base_commit && sha === c.base_commit;
      if (!landed && !noWork && base) landed = (await git(repo, ["merge-base", "--is-ancestor", sha, base], { read: true, timeout: GIT_MS }).catch(() => ({ code: 1 }))).code === 0;
    } else if (!landed && base && c.status === "completed") {
      // Its branch was removed (when it landed, as a rule): a commit its report names that the base holds says it landed.
      const named = [...new Set((facts.reports[c.id] ?? "").match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter((h) => /\d/.test(h) && /[a-f]/.test(h)).slice(0, 6);
      for (const h of named) {
        const full = await run(repo, ["rev-parse", "-q", "--verify", `${h}^{commit}`]);
        if (full && (await git(repo, ["merge-base", "--is-ancestor", full, base], { read: true, timeout: GIT_MS }).catch(() => ({ code: 1 }))).code === 0) { landed = true; head = full.slice(0, 7); break; }
      }
    }
  }
  if (!head && queue) head = queue.tip.slice(0, 7);
  const stopped = c.stopped_by ? agents.STOP_TEXT[c.stopped_by as agents.StopBy] : undefined;
  return { head, ended: { status: c.status, stopped_by: stopped, end_reason: c.status === "failed" ? "it failed" : c.end_reason ? agents.END_TEXT[c.end_reason] ?? c.end_reason : null, branch: c.branch, tip, noWork, landed, remote, review } };
}

// The note for the spawn's result: empty when no earlier agent is close.
export async function earlierNote(o: { repo: string; title: string; prompt: string; parent: string }): Promise<string> {
  const { store } = D();
  const reads = readsOf(store);
  const found = (await reads.run("agents.earlier", { repo: o.repo, skip: above(o.parent) })) as Candidate[];
  if (!found.length) return "";
  const query: Doc = { title: o.title, text: o.prompt };
  const docs: Doc[] = found.map((c) => ({ title: c.title, text: `${c.task}\n${c.head.slice(0, 300)}` }));
  // The words alone name a shortlist; the files its agents touched are read for those, and rank again.
  const first = rank(query, docs).filter((s) => s.score >= 0.1).sort((a, b) => b.score - a.score).slice(0, SHORTLIST);
  if (!first.length) return "";
  let late: ReturnType<typeof setTimeout> | undefined;
  const files = await Promise.race([Promise.all(first.map((s) => filesOf(found[s.index]!, o.repo))), new Promise<string[][]>((r) => { late = setTimeout(() => r([]), FILES_MS); })]).finally(() => clearTimeout(late));
  first.forEach((s, i) => { if (files[i]?.length) docs[s.index] = { ...docs[s.index]!, files: files[i]! }; });
  const picks = closest(query, docs, { max: SHOWN });
  if (!picks.length) return "";
  const chosen = picks.map((p) => found[p.index]!);
  const facts = (await reads.run("agents.earlierOutcomes", { repo: o.repo, branches: chosen.map((c) => c.branch).filter((b): b is string => !!b), agents: chosen.map((c) => c.id) })) as Outcome;
  const base = await baseOf(o.repo);
  const shown: Shown[] = [];
  for (const c of chosen) {
    const { ended, head } = await endedOf(c, o.repo, base, facts);
    shown.push({ id: c.id, title: c.title, branch: c.branch, head, ended, report: c.head });
  }
  return noteOf(shown);
}

// The note, waited for at most TOTAL_MS: a failure or a slow read is no reason to hold or break a spawn.
export async function lookup(o: Parameters<typeof earlierNote>[0]): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([earlierNote(o), new Promise<string>((r) => { timer = setTimeout(() => r(""), TOTAL_MS); })]); }
  catch (e) { capture(e, { at: "earlier attempts", session: o.parent }); return ""; }
  finally { clearTimeout(timer); }
}
