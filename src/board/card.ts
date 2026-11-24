// A branch to land, as one card the owner decides from: the work board's facts of one row (src/board/rules.ts)
// with the agent's proof line (src/checks/proof.ts, from its report) and its size by area, what of the
// evidence is missing, and a print of what the card shows. A decision names the print it was taken on, and
// is refused when the facts read again print otherwise. Pure: the daemon reads the facts
// (src/integrations/mobile/landings.ts).
import type { BoardReview, BoardRow, QueueFact } from "./rules.ts";

export type CardChecks =
  | { state: "known"; passed: string[]; failed: string[]; not_run: string[] }
  | { state: "unknown"; why: string }
  | { state: "none" };

export type CardReview = { verdict: BoardReview["verdict"]; by: string; title: string; line: string; current: boolean | null; panel: boolean };

// What the branch changes, by its top folder (a file at the top is its own area): files and lines.
export type Area = { area: string; files: number; added: number; removed: number };

export type LandCard = {
  key: string;                 // `<root session>.<agent id>`: the row, across reads
  chat_id: string;             // the session whose tree it is
  title: string;               // that session's title
  agent_id: string; agent_chat: string; agent_title: string; agent_state: string;
  branch: string; base: string | null; base_tip: string | null; head: string; ahead: number | null; behind: number | null;
  checks: CardChecks;
  review: CardReview | null;
  proof: string;               // what the check ledger saw of the agent's checks; "" when its report has none
  areas: Area[];
  queue: { state: string; why: string | null } | null; // its branch's latest entry, of this head
  ready: boolean;              // nothing is missing
  missing: string[];           // what of the evidence is not there, in words
  fp: string;
};

// The areas a card names, the largest first; the rest are one more area.
export const AREAS_SHOWN = 5;
const LIVE_QUEUE = new Set(["queued", "building", "checking", "resolving"]);
const working = (s: string) => s === "running" || s === "waiting";

// A row is a card while there is a branch with work the base lacks, its agent no longer works on it,
// and the landing queue does not already hold this head.
export function isCard(r: BoardRow): boolean {
  if (!r.branch || !r.head || r.landed?.state !== "no" || working(r.state)) return false;
  return !(r.queue?.current && LIVE_QUEUE.has(r.queue.state));
}

export function cardChecks(c: BoardRow["checks"]): CardChecks {
  if (!c || c.state === "none") return { state: "none" };
  if (c.state === "unknown") return { state: "unknown", why: c.why };
  return { state: "known", passed: c.passed, failed: c.failed, not_run: c.notRun };
}

// The proof line of an agent's report: the line the harness put there from the ledger (it opens "(Checks").
export function proofOf(report: string | null | undefined): string {
  for (const l of (report ?? "").split("\n")) if (/^\(Checks\b/.test(l.trim())) return l.trim();
  return "";
}

// `git diff --numstat` lines grouped by top folder. A binary file counts as a file with no lines.
export function areasOf(numstat: string): Area[] {
  const by = new Map<string, Area>();
  for (const line of numstat.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    // A rename is "old => new" or "dir/{a => b}/f": the new path.
    const path = m[3]!.replace(/\{[^}]*? => ([^}]*)\}/g, "$1").replace(/^.* => /, "").replace(/\/\//g, "/");
    const area = path.includes("/") ? `${path.split("/")[0]}/` : path;
    const a = by.get(area) ?? { area, files: 0, added: 0, removed: 0 };
    a.files++;
    a.added += m[1] === "-" ? 0 : Number(m[1]);
    a.removed += m[2] === "-" ? 0 : Number(m[2]);
    by.set(area, a);
  }
  const all = [...by.values()].sort((x, y) => y.added + y.removed - (x.added + x.removed) || x.area.localeCompare(y.area));
  if (all.length <= AREAS_SHOWN) return all;
  const rest = all.slice(AREAS_SHOWN - 1);
  return [...all.slice(0, AREAS_SHOWN - 1), { area: `${rest.length} more`, files: rest.reduce((n, a) => n + a.files, 0), added: rest.reduce((n, a) => n + a.added, 0), removed: rest.reduce((n, a) => n + a.removed, 0) }];
}

const VERDICT_SAYS: Record<string, string> = {
  refused: "the review refused it",
  disputed: "reviewers disagree on it",
  words: "the reviewer gave words only, no verdict",
  unclear: "the review gave no clear verdict",
  pending: "its review still runs",
  stale: "the review is of an older head",
};

// What of the evidence is missing: checks that failed, did not run or are not known, and a review that
// did not approve this head. The repository naming no checks is said on the card, not missing.
export function missingOf(checks: CardChecks, review: CardReview | null): string[] {
  const out: string[] = [];
  if (checks.state === "unknown") out.push(`the checks are not known (${checks.why})`);
  if (checks.state === "known") {
    if (checks.failed.length) out.push(`failed: ${checks.failed.join(", ")}`);
    if (checks.not_run.length) out.push(`not run on its head: ${checks.not_run.join(", ")}`);
    if (!checks.passed.length && !checks.failed.length && !checks.not_run.length) out.push("no check decided on its head");
  }
  if (!review) out.push("no review");
  else if (review.verdict === "approved" && review.current === false) out.push("the approval is of an older head");
  else if (review.verdict !== "approved") out.push(VERDICT_SAYS[review.verdict] ?? `the review is ${review.verdict}`);
  return out;
}

// The print of what a card shows: a decision is taken on these facts and no others.
export function cardPrint(c: Omit<LandCard, "fp" | "ready" | "missing">): string {
  const facts = [c.key, c.branch, c.head, c.base ?? "", c.base_tip ?? "", String(c.ahead ?? ""), String(c.behind ?? ""), c.agent_state, JSON.stringify(c.checks), JSON.stringify(c.review && { v: c.review.verdict, by: c.review.by, cur: c.review.current, line: c.review.line }), c.proof, JSON.stringify(c.queue)];
  return Bun.hash(facts.join("\u0000")).toString(36);
}

// `baseTip`: the commit the base is at, from the board's repository (the card's behind line is counted against it).
export function landCard(o: { root: string; title: string; row: BoardRow; report: string | null; numstat: string; baseTip?: string | null }): LandCard {
  const r = o.row;
  const review: CardReview | null = r.review ? { verdict: r.review.verdict, by: r.review.by, title: r.review.title, line: r.review.line, current: r.review.current, panel: r.review.how === "panel" } : null;
  const checks = cardChecks(r.checks);
  const q: QueueFact | null = r.queue && r.queue.current ? r.queue : null;
  const body = {
    key: `${o.root}.${r.id}`, chat_id: o.root, title: o.title,
    agent_id: r.id, agent_chat: r.session_id, agent_title: r.title, agent_state: r.state,
    branch: r.branch!, base: r.base, base_tip: o.baseTip ?? null, head: r.head!, ahead: r.ahead, behind: r.behind,
    checks, review, proof: proofOf(o.report), areas: areasOf(o.numstat),
    queue: q ? { state: q.state, why: q.why } : null,
  };
  const missing = missingOf(checks, review);
  return { ...body, ready: !missing.length, missing, fp: cardPrint(body) };
}

// Ready first, then the newest head: what the owner can land now leads.
export const cardOrder = (a: LandCard & { at: number }, b: LandCard & { at: number }) => Number(b.ready) - Number(a.ready) || b.at - a.at;
