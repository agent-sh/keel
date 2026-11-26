// An instruction file the landing queue itself landed is trusted on sight. The queue fast-forwards a
// checkout that has the base out (src/landing/queue.ts moveBase); right after, each instruction file
// pinned for that checkout that the landing changed has its pin moved with it, when all of this holds:
//   - the pin was at the content the base held before the landing (a file already held stays held);
//   - the file on disk is the text the landed commit holds (an edit in the working tree stays held);
//   - every entry of the batch that changed the file is vouched for at the tip that was built: the
//     owner queued it at that tip with their own hand, having been shown it, or the reviewer the
//     landing session started for that tip gave a structured LAND yes on it; and nobody refused that
//     commit (coverOf).
// The queue requires no review to land, so the last line is this module's own: a session that queues
// its agent's branch with no review lands it, and the changed file asks as before. An agent picks no
// voucher of its own: only a top-level session's own reviewer counts, for a branch that session queued. Nothing else moves
// a pin without the owner: a commit made outside the queue, a pull or a merge from a remote, a
// checkout and an edit never pass here, because only the queue's own pass calls this, with the
// commits it built and checked (a pass a restart cut after the move calls nothing: the file asks).
// Skills, the hooks file, the worktree setup and a repository's MCP file are not covered: they run
// commands or grant tools, and every change of one asks.
import { relative } from "node:path";
import { git } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import type { Trust } from "./trust.ts";
import { createHash } from "node:crypto";

// An entry of the batch that landed: built from `prev` to `at` on the way from the old base to the new.
// `tip`: the branch's own tip that was built. `owner_tip`: the tip the owner queued it at, with their
// own hand (null: a session queued it). `tries`: the rebase tasks its agent was sent for the queue.
export type LandedEntry = { branch: string; tip: string; prev: string; at: string; holder: string | null; queued_by: string | null; owner_tip: string | null; owner_via: string | null; tries: number };
export type Landing = { repo: string; checkout: string; from: string; to: string; entries: LandedEntry[] };
export type Cover = { branch: string; by: "owner" } | { branch: string; by: "review"; reviewer: string };
// A pin that moved: the file, the commit it landed with, who vouched for each entry that changed it,
// and the sessions that are told.
export type Moved = { path: string; rel: string; root: string; commit: string; covers: Cover[]; tell: string[] };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } }; // a table not made yet

// Who vouches for an entry's change, at the tip that was built. Nobody, when any verdict on that commit
// says no, whoever recorded it: a refusal leaves the file to the owner, under their own landing too.
// The owner: they queued the branch at that very tip, having been shown it (the queue keeps `owner_tip`
// only when the head their page showed is the tip it read). A review: a keel__verdict yes on that commit
// by a reviewer the landing session itself started for it. That is, every one of:
//   - a top-level session queued the entry (not an agent: an agent that builds through one child and
//     vouches through another has chosen its own voucher), and it is still there;
//   - the reviewer is that session's own agent (its `parent_id`), so no agent below and no other
//     conversation's agent vouches;
//   - its spawn's `reviews` named the branch at the tip that landed (a commit the reviewer added itself
//     after it started is not what it was started to read; a task that merely mentions the branch is no
//     review);
//   - the branch has a holder that is neither the landing session (its own work reviewed by its own
//     agent) nor the reviewer or an agent below it, and its agent was sent no rebase task: the holder may be a fresh agent by then, and what the rebase
//     made was queued again before anyone could review it.
// Not read here: the words of a report, an output_schema answer, and the Review panel's reviews (its
// route takes a focus in the caller's words and keeps no head).
export function coverOf(store: Store, e: Pick<LandedEntry, "branch" | "tip" | "holder" | "queued_by" | "owner_tip" | "tries">): Cover | undefined {
  const db = store.db;
  if (tried(() => db.query<{ n: number }, [string]>("SELECT 1 AS n FROM review_verdicts WHERE commit_sha = ? AND land != 'yes' LIMIT 1").all(e.tip)).length) return undefined;
  if (e.owner_tip && e.owner_tip === e.tip) return { branch: e.branch, by: "owner" };
  const by = e.queued_by;
  if (!by || !e.holder || e.holder === by || e.tries) return undefined;
  const top = store.session(by);
  if (!top || top.parent_id || tried(() => db.query<{ n: number }, [string]>("SELECT 1 AS n FROM agents WHERE session_id = ? LIMIT 1").all(by)).length) return undefined;
  // The sessions from the holder up: a reviewer among them holds the branch or started the agent that does.
  const above = new Set<string>();
  for (let cur: string | null | undefined = e.holder, i = 0; cur && i < 32; i++) { above.add(cur); cur = store.session(cur)?.parent_id; }
  const rows = tried(() => db.query<{ title: string; session_id: string; reviews: string | null }, [string, string]>(
    "SELECT a.title, a.session_id, a.reviews FROM review_verdicts v JOIN agents a ON a.id = v.agent_id WHERE v.commit_sha = ? AND v.land = 'yes' AND a.parent_id = ? ORDER BY v.at DESC LIMIT 50").all(e.tip, by));
  for (const r of rows) {
    if (above.has(r.session_id)) continue;
    let named: { branch?: string; how?: string; tip?: string | null }[] = [];
    try { named = r.reviews ? JSON.parse(r.reviews) : []; } catch {}
    if (Array.isArray(named) && named.some((x) => x?.branch === e.branch && x.how === "named" && x.tip === e.tip)) return { branch: e.branch, by: "review", reviewer: r.title };
  }
  return undefined;
}

// Moves the pins a landing may move (the rule at the top of this file), and says which moved.
export async function trustLanded(store: Store, trust: Trust, l: Landing): Promise<Moved[]> {
  const moved: Moved[] = [];
  for (const pin of trust.instructionPins(l.checkout)) {
    const rel = relative(pin.root, pin.path);
    if (!rel || rel.startsWith("..")) continue;
    const show = async (at: string) => { const r = await git(l.repo, ["show", `${at}:${rel}`], { read: true, timeout: 30_000 }); return r.code === 0 ? r.out : null; };
    const before = await show(l.from), after = await show(l.to);
    if (before === null || after === null || before === after || !after.trim()) continue;
    if (sha(before) !== pin.sha) continue;
    const covers: Cover[] = [], tell = new Set<string>();
    let open = false;
    for (const e of l.entries) {
      const d = await git(l.repo, ["diff", "--quiet", e.prev, e.at, "--", rel], { read: true, timeout: 30_000 });
      if (d.code === 0) continue;
      const c = d.code === 1 ? coverOf(store, e) : undefined;
      if (!c) { open = true; break; }
      covers.push(c);
      const to = e.queued_by ?? e.owner_via;
      if (to && store.session(to)) tell.add(to);
    }
    if (open || !covers.length) continue;
    if (trust.landed(pin.path, pin.sha, after, l.to)) moved.push({ path: pin.path, rel, root: pin.root, commit: l.to, covers, tell: [...tell] });
  }
  return moved;
}

// The timeline's line for the pins a landing moved, as the session that queued it reads it.
export function landedNote(moved: readonly Moved[]): string {
  const files = moved.map((m) => m.rel).join(", ");
  const by = new Map<string, string>();
  for (const m of moved) for (const c of m.covers) by.set(c.branch, c.by === "owner" ? `${c.branch}, which you queued` : `${c.branch}, reviewed LAND yes by ${c.reviewer}`);
  return `${files} changed with a landing of the queue (${moved[0]!.commit.slice(0, 9)}: ${[...by.values()].join("; ")}) and ${moved.length === 1 ? "is" : "are"} trusted as landed: no card. The Trust panel lists ${moved.length === 1 ? "it" : "them"} with the landing.`;
}
