// Stand-line evidence for a fast-forward or merge made without the landing queue.
// One read of the coordinator's branch records on the read thread, then batched
// git reads by repository. No board build or check scan on a session state read.
import { git } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import type { StandResult } from "../core/watch.ts";
import { readsOf } from "../server/reads.ts";
import { keepGitLanding } from "./results.ts";

type Branch = { repo: string; branch: string; start: string; tip: string | null };
type BaseOf = (repo: string) => Promise<string | null>;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const READ_MS = 3_000; // A stand line is incidental, never a reason to keep a slow git read running.
const read = (repo: string, args: string[], input?: string) => git(repo, args, { read: true, timeout: READ_MS, input });

// The current base actually contains the agent's work. A branch left at its
// starting commit is not work. A deleted branch can still be proved by its
// recorded tip and the base's own reflog, if it has not been reset past it.
export async function gitLanding(branches: Branch[], baseOf: BaseOf): Promise<StandResult | undefined> {
  const repos = Map.groupBy(branches, (b) => b.repo);
  let best: StandResult | undefined;
  for (const [repo, inRepo] of repos) {
    const base = await baseOf(repo);
    if (!base?.startsWith("refs/heads/")) continue;
    const listed = await read(repo, ["for-each-ref", `--merged=${base}`, "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", "refs/heads"]);
    if (listed.code !== 0) continue;
    const refs = new Map(listed.out.split("\n").flatMap((l) => {
      const [branch, head, date] = l.split("\0");
      return branch?.startsWith("refs/heads/") && head && SHA.test(head) ? [[branch.slice("refs/heads/".length), { head, at: Number(date) * 1000 }] as const] : [];
    }));
    const ours = inRepo.filter((b) => `refs/heads/${b.branch}` !== base);
    if (!ours.some((b) => {
      const h = refs.get(b.branch)?.head ?? b.tip;
      return h && h !== b.start;
    })) continue;
    const reflog = await read(repo, ["reflog", "show", "--format=%H%x00%gD", "--date=unix", base]);
    const dates = new Map<string, number>();
    if (reflog.code === 0) for (const line of reflog.out.split("\n")) {
      const [head, mark] = line.split("\0");
      const at = /@\{(\d+)\}$/.exec(mark ?? "")?.[1];
      if (head && at && !dates.has(head)) dates.set(head, Number(at) * 1000);
    }
    // Missing from --merged could mean gone or still unmerged. A live
    // unmerged branch must never be reported from an old tip of that branch.
    const fallback = ours.filter((b) => !refs.has(b.branch) && b.tip && b.tip !== b.start && dates.has(b.tip));
    if (fallback.length) {
      const all = await read(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
      if (all.code === 0) {
        const live = new Set(all.out.trim().split("\n"));
        const gone = fallback.filter((b) => !live.has(`refs/heads/${b.branch}`));
        if (gone.length) {
          const heads = [...new Set(gone.map((b) => b.tip!))];
          const left = await read(repo, ["rev-list", "--no-walk", "--stdin"], `${heads.join("\n")}\n^${base}\n`);
          if (left.code === 0) {
            const notHeld = new Set(left.out.trim().split("\n"));
            for (const b of gone) if (!notHeld.has(b.tip!)) refs.set(b.branch, { head: b.tip!, at: dates.get(b.tip!)! });
          }
        }
      }
    }
    for (const b of ours) {
      const r = refs.get(b.branch);
      if (!r || r.head === b.start) continue;
      // A local fast-forward records the tip in the reflog. For a merge, or
      // when reflogs are unavailable, the commit's date is the known bound.
      const at = dates.get(r.head) ?? r.at;
      if (Number.isFinite(at) && (!best || at > best.at)) best = { kind: "landed", what: b.branch, head: r.head.slice(0, 9), ok: true, at };
    }
  }
  return best;
}

const FRESH_MS = 5_000; // Repeated state snapshots may share a read; an observed ref move asks afresh.

export class ResultLandings {
  private pending = new Set<string>();
  private busy = false;
  private seen = new Map<string, { at: number }>();

  constructor(private store: Store, private baseOf: BaseOf, private changed: (id: string) => void, private failed: (e: unknown, id: string) => void) {}

  refresh(id: string, soon = false) {
    const s = this.store.session(id);
    if (!s || s.archived || s.parent_id || s.outside || s.machine) return;
    if (!soon && Date.now() - (this.seen.get(id)?.at ?? -Infinity) < FRESH_MS) return;
    // The common case is no managed branch, one indexed lookup on the loop.
    if (!this.store.db.query("SELECT 1 FROM agents a JOIN worktrees w ON w.session_id = a.session_id WHERE a.parent_id = ? AND a.branch = w.branch AND a.machine IS NULL LIMIT 1").get(id)) {
      if (this.forget(id)) this.changed(id);
      return;
    }
    const seen = this.seen.get(id);
    if (seen) seen.at = Date.now(); else this.seen.set(id, { at: Date.now() });
    this.pending.add(id);
    if (!this.busy) void this.drain();
  }

  forget(id: string): boolean {
    this.pending.delete(id);
    this.seen.delete(id);
    return keepGitLanding(this.store, id);
  }

  private async drain() {
    this.busy = true;
    try {
      for (const id of this.pending) {
        this.pending.delete(id);
        const current = this.seen.get(id);
        try {
          const branches = await readsOf(this.store).sql<Branch>(`SELECT w.repo_root AS repo, a.branch, w.base_commit AS start, m.tip
            FROM agents a JOIN worktrees w ON w.session_id = a.session_id AND w.branch = a.branch
            LEFT JOIN overlap_marks m ON m.session_id = a.session_id AND m.repo = w.repo_root AND m.branch = w.branch
            WHERE a.parent_id = ? AND a.machine IS NULL`, [id]);
          const result = await gitLanding(branches, this.baseOf);
          if (this.seen.get(id) === current && keepGitLanding(this.store, id, result)) this.changed(id);
        } catch (e) {
          this.failed(e, id);
        }
      }
    } finally { this.busy = false; }
  }
}
