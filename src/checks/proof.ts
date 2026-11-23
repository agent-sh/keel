// The proof line on an agent's report: what the check ledger saw of the
// agent's checks, not what the agent says of them. No model call: the
// ledger's rows since the agent's task began, the times of its edits, and
// the tree of its folder as it reports (one look, as a check's run takes).
import { realOf } from "../core/paths.ts";
import type { StoredEvent } from "../core/types.ts";
import { editTimes } from "../automation/report-did.ts";
import { namedFor, ofSession, repoOf, treeOf } from "./ledger.ts";
import { baseFor } from "./runs.ts";
import { proofLine } from "./words.ts";

// `evs`: the agent's events since its task; `folder`: where it worked.
export async function proofFor(sessionId: string, folder: string, evs: readonly StoredEvent[]): Promise<string> {
  const since = evs[0]?.ts ?? 0;
  const runs = ofSession(sessionId, since);
  const repo = repoOf(folder);
  const named = !!(repo && namedFor(repo)?.checks.length);
  if (!runs.length && !named) return "";
  const edits = editTimes(evs);
  if (!runs.length && !edits.length) return "";
  const treeNow = repo && runs.length ? (await treeOf(repo))?.tree ?? undefined : undefined;
  // The base's words for the newest red run of each check.
  const base = new Map<number, string>();
  if (repo) {
    const newest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) newest.set(`${r.dir}\n${r.command}`, r);
    for (const r of newest.values()) if (r.result === "fail") { const w = await baseFor(r, repo); if (w) base.set(r.id, w); }
  }
  return proofLine({ runs, edits, treeNow, base, named, top: repo ? realOf(repo.top) : undefined });
}
