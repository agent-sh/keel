// Calibration and review yield by model: for each builder model and agent type, how often an agent's
// "done" was later contradicted, and for each reviewer model, how many of its refusals a later fix
// confirmed, what its reviews cost, and the rounds of the lanes it reviewed. Every number is a count of
// records Keel keeps: the agents, the reviewers' structured verdicts (src/board/verdicts.ts), the check
// ledger, the landing queue's rows and the usage rollup. No model decides anything here, and a reviewer's
// words are not read: a verdict is "no" or it is not.
//
// A builder is an agent with a branch that gave no verdict on another's branch and was not started to review one;
// "done" is a builder whose status is completed. Its "done" was contradicted when, on its branch:
//   refused  another agent's structured verdict "no" on a commit of the branch;
//   red      a failed check run on the head it reported (the head of its last check run, or a commit a
//            reviewer gave a verdict on), by another session at any time, or by its own session after it
//            ended, unless the same check passed on the same files (a flaky run is not a contradiction) or
//            another agent approved that commit with a structured verdict after the run (a reviewer who saw
//            the red and landed it anyway; a check that is red on the base too is otherwise still counted:
//            the ledger does not keep that);
//   landing  a landing queue entry of the branch that left the queue or was sent back for a fix (the
//            queue prunes its settled rows, so this one is counted only while the row is kept).
// A reviewer's refusal is confirmed when the branch moved on after it: a later verdict on a different
// commit of the branch, or a later check run of the builder's own session on another head. A refusal the
// branch never moved on from (dismissed, abandoned, or not landed yet) is not counted as confirmed.
// Keel's verdict has two values, so a refusal stands for what a review calls a P1.
//
// Imports nothing of the daemon: the read thread runs it (src/server/read-tasks.ts).
import type { Database } from "bun:sqlite";

export type AgentRow = { id: string; session_id: string; type: string; model: string; status: string; created: number; ended: number | null; branch: string | null; reviews: string | null };
export type VerdictRow = { agent_id: string; commit_sha: string; branches: string; land: string; at: number };
export type RunRow = { session_id: string | null; head: string | null; result: string; ended: number; key?: string; tree?: string };
export type LandingRow = { branch: string; state: string; tries: number };
export type CostRow = { session_id: string; usd: number; unpriced: number };
export type Facts = { agents: AgentRow[]; verdicts: VerdictRow[]; runs: RunRow[]; landings: LandingRow[]; costs: CostRow[] };

export type BuilderLine = {
  model: string; type: string;
  done: number;          // lanes reported done (completed, with a branch)
  reviewed: number;      // of them, those another agent gave a verdict on
  refused: number;       // contradicted by a refusal
  red: number;           // by a red check on the reported head
  landing: number;       // by a landing that had to fix it
  contradicted: number;  // by any of the three
  rate: number | null;   // contradicted / done
};
export type ReviewerLine = {
  model: string;
  reviewers: number;     // review agents started
  verdicts: number;      // structured verdicts given
  refusals: number;      // of them "no"
  confirmed: number;     // refusals a later move of the branch confirmed
  usd: number;           // what the review agents' sessions cost (priced requests)
  unpriced: number;      // requests of theirs with no price (not in usd)
  confirmed_per_usd: number | null;  // null: no priced spend
  usd_per_confirmed: number | null;  // null: none confirmed
  lanes: number;         // branches they gave a verdict on
  rounds_per_lane: number | null;    // distinct commits of those branches the model's reviewers gave a verdict on, per branch
};
export type YieldRead = { builders: BuilderLine[]; reviewers: ReviewerLine[]; since: number; until: number };

const branchesOf = (json: string): string[] => { try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((b): b is string => typeof b === "string") : []; } catch { return []; } };

export function yieldOf(f: Facts, since: number, until: number): YieldRead {
  const costOf = new Map(f.costs.map((c) => [c.session_id, c]));
  // A reviewer: started to review a branch, or gave a verdict on a branch that is not its own.
  const own = new Map(f.agents.map((a) => [a.id, a.branch]));
  const verdictors = new Set(f.verdicts.filter((v) => branchesOf(v.branches).some((b) => b !== own.get(v.agent_id))).map((v) => v.agent_id));
  const isReviewer = (a: AgentRow) => verdictors.has(a.id) || a.reviews !== null;
  const inRange = (a: AgentRow) => a.created >= since && a.created < until;

  // Who built which branch: when two agents share a branch the later started owns the verdicts after it.
  const builders = f.agents.filter((a) => a.branch && !isReviewer(a));
  const byBranch = new Map<string, AgentRow[]>();
  for (const b of builders) byBranch.set(b.branch!, [...(byBranch.get(b.branch!) ?? []), b].sort((x, y) => x.created - y.created));
  const ownerOf = (branch: string, at: number): AgentRow | undefined => (byBranch.get(branch) ?? []).filter((b) => b.created <= at).at(-1);

  // The verdicts on each builder's branch, by another agent.
  const onBuilder = new Map<string, { v: VerdictRow; branch: string }[]>();
  for (const v of f.verdicts) {
    for (const branch of branchesOf(v.branches)) {
      const b = ownerOf(branch, v.at);
      if (!b || b.id === v.agent_id) continue;
      onBuilder.set(b.id, [...(onBuilder.get(b.id) ?? []), { v, branch }]);
    }
  }
  const runsOf = new Map<string, RunRow[]>();
  const failsOn = new Map<string, RunRow[]>();
  const passed = new Set<string>();
  for (const r of f.runs) {
    if (r.session_id) runsOf.set(r.session_id, [...(runsOf.get(r.session_id) ?? []), r]);
    if (r.head && r.result === "fail") failsOn.set(r.head, [...(failsOn.get(r.head) ?? []), r]);
    if (r.result === "pass" && r.key !== undefined && r.tree !== undefined) passed.add(`${r.key}\0${r.tree}`);
  }
  const landed = new Map<string, number>();
  for (const l of f.landings) if (l.state === "left" || l.tries > 0) landed.set(l.branch, (landed.get(l.branch) ?? 0) + 1);

  // A refusal is confirmed when the branch moved on after it.
  const confirmed = (b: AgentRow, v: VerdictRow, branch: string) => {
    if ((onBuilder.get(b.id) ?? []).some((o) => o.branch === branch && o.v.at > v.at && o.v.commit_sha !== v.commit_sha)) return true;
    return (runsOf.get(b.session_id) ?? []).some((r) => r.ended > v.at && r.head !== null && r.head !== v.commit_sha);
  };

  const lines = new Map<string, BuilderLine>();
  for (const b of builders.filter((a) => a.status === "completed" && inRange(a))) {
    const key = `${b.model}\0${b.type}`;
    const line = lines.get(key) ?? { model: b.model, type: b.type, done: 0, reviewed: 0, refused: 0, red: 0, landing: 0, contradicted: 0, rate: null };
    lines.set(key, line);
    line.done++;
    const verdicts = onBuilder.get(b.id) ?? [];
    if (verdicts.length) line.reviewed++;
    const refused = verdicts.some((o) => o.v.land === "no");
    // The head it reported, and the commits reviewers looked at.
    const last = (runsOf.get(b.session_id) ?? []).filter((r) => r.head && (b.ended === null || r.ended <= b.ended)).sort((x, y) => y.ended - x.ended)[0];
    const heads = new Set([...(last?.head ? [last.head] : []), ...verdicts.map((o) => o.v.commit_sha)]);
    const approvedAt = (h: string) => Math.max(0, ...verdicts.filter((o) => o.v.land === "yes" && o.v.commit_sha === h).map((o) => o.v.at));
    const red = [...heads].some((h) => (failsOn.get(h) ?? []).some((r) => !passed.has(`${r.key}\0${r.tree}`) && r.ended > approvedAt(h) && (r.session_id !== b.session_id || (b.ended !== null && r.ended > b.ended))));
    const landing = (landed.get(b.branch!) ?? 0) > 0;
    if (refused) line.refused++;
    if (red) line.red++;
    if (landing) line.landing++;
    if (refused || red || landing) line.contradicted++;
  }
  const builderLines = [...lines.values()].map((l) => ({ ...l, rate: l.done ? l.contradicted / l.done : null }))
    .sort((a, b) => b.done - a.done || a.model.localeCompare(b.model) || a.type.localeCompare(b.type));

  const rev = new Map<string, { line: ReviewerLine; lanes: Map<string, Set<string>> }>();
  for (const a of f.agents.filter((x) => isReviewer(x) && inRange(x))) {
    const slot = rev.get(a.model) ?? { line: { model: a.model, reviewers: 0, verdicts: 0, refusals: 0, confirmed: 0, usd: 0, unpriced: 0, confirmed_per_usd: null, usd_per_confirmed: null, lanes: 0, rounds_per_lane: null }, lanes: new Map() };
    rev.set(a.model, slot);
    slot.line.reviewers++;
    const c = costOf.get(a.session_id);
    if (c) { slot.line.usd += c.usd; slot.line.unpriced += c.unpriced; }
    for (const v of f.verdicts.filter((x) => x.agent_id === a.id)) {
      slot.line.verdicts++;
      for (const branch of branchesOf(v.branches)) {
        const b = ownerOf(branch, v.at);
        if (b && b.id !== a.id) slot.lanes.set(branch, (slot.lanes.get(branch) ?? new Set()).add(v.commit_sha));
        if (v.land === "no" && b && b.id !== a.id) {
          slot.line.refusals++;
          if (confirmed(b, v, branch)) slot.line.confirmed++;
        }
      }
    }
  }
  const reviewerLines = [...rev.values()].map(({ line, lanes }) => ({
    ...line,
    // (A refusal on a verdict naming two branches counts once per branch; the lanes are the branches.)
    lanes: lanes.size,
    rounds_per_lane: lanes.size ? [...lanes.values()].reduce((n, s) => n + s.size, 0) / lanes.size : null,
    confirmed_per_usd: line.usd > 0 ? line.confirmed / line.usd : null,
    usd_per_confirmed: line.confirmed > 0 ? line.usd / line.confirmed : null,
  })).sort((a, b) => b.verdicts - a.verdicts || a.model.localeCompare(b.model));
  return { builders: builderLines, reviewers: reviewerLines, since, until };
}

// The rows the counting reads, for builders and reviewers started in [since, until).
// A table an older store lacks reads as no rows.
export function readYield(db: Database, a: { since: number; until?: number }): YieldRead {
  const until = a.until ?? Date.now() + 1;
  const tried = <T>(f: () => T[]): T[] => { try { return f(); } catch { return []; } };
  const agents = tried(() => db.query<AgentRow, [number, number]>(
    "SELECT id, session_id, type, model, status, created, ended, branch, reviews FROM agents WHERE created >= ?1 AND created < ?2").all(a.since, until));
  const verdicts = tried(() => db.query<VerdictRow, []>("SELECT agent_id, commit_sha, branches, land, at FROM review_verdicts ORDER BY at DESC LIMIT 20000").all());
  // A builder a verdict is about may have started before the range: it and the reviewers' own rows are read too.
  const have = new Set(agents.map((x) => x.id));
  const named = [...new Set(verdicts.flatMap((v) => branchesOf(v.branches)))];
  const more = [...new Set(verdicts.map((v) => v.agent_id))].filter((id) => !have.has(id));
  const extra = [
    ...(more.length ? tried(() => db.query<AgentRow, [string]>("SELECT id, session_id, type, model, status, created, ended, branch, reviews FROM agents WHERE id IN (SELECT value FROM json_each(?1))").all(JSON.stringify(more))) : []),
    ...(named.length ? tried(() => db.query<AgentRow, [string]>("SELECT id, session_id, type, model, status, created, ended, branch, reviews FROM agents WHERE branch IN (SELECT value FROM json_each(?1))").all(JSON.stringify(named))) : []),
  ];
  for (const x of extra) if (!have.has(x.id)) { have.add(x.id); agents.push(x); }
  const branches = [...new Set(agents.map((x) => x.branch).filter((b): b is string => !!b))];
  const sessions = [...new Set(agents.filter((x) => x.branch).map((x) => x.session_id))];
  const runs = tried(() => db.query<RunRow, [string]>(
    "SELECT session_id, head, result, ended FROM check_runs WHERE session_id IN (SELECT value FROM json_each(?1)) AND head IS NOT NULL AND result IN ('pass', 'fail')").all(JSON.stringify(sessions)));
  // The heads the builders reported or reviewers saw: failed runs on them, by any session.
  const heads = new Set<string>(verdicts.map((v) => v.commit_sha));
  const lastHead = new Map<string, { head: string; ended: number }>();
  for (const r of runs) if (r.session_id && r.head && (lastHead.get(r.session_id)?.ended ?? -1) <= r.ended) lastHead.set(r.session_id, { head: r.head, ended: r.ended });
  for (const h of lastHead.values()) heads.add(h.head);
  const fails = tried(() => db.query<RunRow, [string]>(
    "SELECT session_id, head, result, ended, key, tree FROM check_runs INDEXED BY check_runs_head WHERE head IN (SELECT value FROM json_each(?1)) AND result = 'fail'").all(JSON.stringify([...heads])));
  const passes = tried(() => db.query<RunRow, [string]>(
    "SELECT session_id, head, result, ended, key, tree FROM check_runs INDEXED BY check_runs_tree WHERE tree IN (SELECT value FROM json_each(?1)) AND result = 'pass'").all(JSON.stringify([...new Set(fails.map((r) => r.tree).filter((t): t is string => !!t))])));
  const landings = tried(() => db.query<LandingRow, [string]>(
    "SELECT branch, state, tries FROM landing_queue WHERE branch IN (SELECT value FROM json_each(?1))").all(JSON.stringify(branches)));
  const reviewerSessions = agents.filter((x) => x.reviews !== null || verdicts.some((v) => v.agent_id === x.id && branchesOf(v.branches).some((b) => b !== x.branch))).map((x) => x.session_id);
  const costs = tried(() => db.query<CostRow, [string]>(
    "SELECT session_id, SUM(priced_cost_usd) AS usd, SUM(unpriced_calls) AS unpriced FROM usage_rollup WHERE session_id IN (SELECT value FROM json_each(?1)) GROUP BY session_id").all(JSON.stringify(reviewerSessions)));
  return yieldOf({ agents, verdicts, runs: [...runs, ...fails, ...passes], landings, costs }, a.since, until);
}
