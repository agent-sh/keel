// The work board, its pure part: what a coordinator's lane map says of each agent of its tree, decided
// from facts the daemon holds (the agents and worktrees tables, git, the check ledger, the landing queue
// and its after-land step, this daemon's own build), and the few hundred tokens a coordinator reads of it.
// The only words of a model on the board are a reviewer's: the why of its verdict, or its LAND line, quoted
// and named as its. Approved and refused come only from a structured verdict.
// The part that reads the facts is src/board/board.ts; this file runs on the read thread too, so it
// imports nothing of the daemon.
import type { ChecksOn } from "../automation/landing.ts";

// approved and refused come only from a structured verdict (a reviewer's keel__verdict call, its
// output_schema answer, the Review panel's verdict) on the row's head. words: the reviewer wrote a LAND
// line and gave no structured verdict, quoted and never read as one. stale: a structured verdict of
// another head than the branch's now, whatever it said (`was`).
// disputed: independent reviewers' structured verdicts on the head disagree (the refusal, `against` the approval).
export type Verdict = "approved" | "refused" | "disputed" | "words" | "unclear" | "pending" | "stale";

// A review of a branch: an agent whose spawn named the branch it reviews (`reviews`), one whose task named
// the branch or its head, one that gave a structured verdict on a commit of the branch, or a review the
// owner ran from the Review panel.
export type BoardReview = {
  by: string;                  // the agent's id, or the panel review's id
  title: string;
  how: "named" | "task" | "verdict" | "panel";
  state: string;               // the agent's status, or the panel review's state
  verdict: Verdict;
  was?: Verdict;               // what it said, when the board does not take it as said (stale, or of a head not known)
  source: "verdict" | "output" | "panel" | "words" | null; // what the verdict was read from
  line: string;                // the reviewer's own words: its verdict's why, or its LAND line
  tip: string | null;          // the head it was started on, when known
  of: string | null;           // the commit its verdict was said of, when known
  current: boolean | null;     // its verdict is of the branch's head as it is now; null: not known
  at: number;
  against?: { by: string; title: string; how: BoardReview["how"]; source: BoardReview["source"]; line: string; at: number }; // disputed: the approval
};

// A structured verdict on one commit: a reviewer's keel__verdict call, its answer to an output_schema, or
// the Review panel's verdict on the head it reviewed. `sha`: the full commit, or the digits the answer gave.
// `branches`: the branches of the tree that held the commit when it was given; null: not known.
export type StructuredVerdict = { sha: string; land: "yes" | "no"; why: string; at: number; from: "verdict" | "output" | "panel"; branches: string[] | null };

// A LAND line of a reviewer's report, with the commits and branches it names: what the board quotes as the
// reviewer's words when it gave no structured verdict. `part` 0 is the newest final, 1 the earlier ones
// the harness added after its separator.
export type LandLine = { line: string; shas: string[]; branches: string[]; part: number };

// What the read thread keeps of a review (src/board/facts.ts), decided for a row's head by pickReview.
// `branch` null: a reviewer known only by verdicts on commits no branch of the tree held when it gave
// them; it reviews a row whose head one of them names.
export type ReviewFact = {
  by: string; title: string; how: BoardReview["how"]; state: string; branch: string | null; tip: string | null;
  own: boolean;                // the reviewer has a branch of its own
  chain: string[] | null;      // the reviewer's session and the sessions above it, up to the root; null: not read
  verdicts: StructuredVerdict[];
  lines: LandLine[];
  said?: "approved" | "refused"; // a panel verdict whose head is not known
  panel?: string;              // a panel review's own line (its verdict, findings, summary)
  at: number;
};

export type Landed =
  | { state: "yes"; how: "ancestor" | "patch" | "queue" } // the base holds the head, or a commit of the same patch for each of its commits, or the landing queue landed this head
  | { state: "no"; missing: number }            // commits of the head whose patch the base does not hold
  | { state: "nothing" }                         // the branch has no commit of its own
  | { state: "unknown"; why: string };

export type Live =
  | { state: "yes"; at: string; how: Deploy["how"] }
  | { state: "no"; at: string; how: Deploy["how"] }
  | { state: "unknown"; why: string };

// What runs: the commit the repository's after-land step last ran on and passed, and this daemon's own build.
export type Deploy = { sha: string; how: "after step passed" | "this daemon"; at: number | null };

export type QueueFact = { id: string; state: string; why: string | null; landed: string | null; tip: string; current: boolean; updated: number };

// What a branch changes: files, lines added and removed. `more`: a part was not counted (a bound of the read).
export type Change = { files: number; added: number; removed: number; more?: true };
// The work a card shows: what its worktree holds uncommitted, and what its commits change over the base. Each is
// null when there is none; the whole is null when the worktree is not read (none here, another machine, no time left).
export type Work = { uncommitted: Change | null; branch: Change | null };
// The branch checked together with another live branch it touches related code with
// (src/landing/together.ts), at both heads as they are now. red: a check fails together and passes on
// each alone; own: what fails together fails on a side alone too; flaky: red once, then green; broken:
// red on both sides alone (the base or the setup is red where pairs run; the owner is told).
export type PairFact = {
  with: string; with_agent: string | null; head: string; with_head: string; base_tip: string | null;
  state: "running" | "green" | "red" | "flaky" | "own" | "broken" | "error"; why: string; detail: string | null;
  checks: { name: string; tests?: string[]; branch?: string }[]; error: string | null; at: number;
};

// The before and after pictures of the row's head (src/pictures/run.ts), as the board shows them: the run's state,
// what differs, and up to a few of the pairs that differ (the rest are read by its id).
export type PictureFact = {
  // none: not taken yet (the head's repository names pictures and its branch changes the page); opening them takes them.
  id: number; state: "none" | "queued" | "running" | "done" | "skipped" | "failed"; why: string | null; head: string; merge_base: string | null;
  counts: { changed: number; unstable: number; new: number; gone: number; unread: number; same: number };
  specs: string[];
  sides: { before: { state: string; ms?: number | null; cpu_ms?: number | null; shots?: number; why?: string }; after: { state: string; ms?: number | null; cpu_ms?: number | null; shots?: number; why?: string } };
  differ: { name: string; state: string; w?: number; h?: number; boxes?: { x: number; y: number; w: number; h: number }[] }[];
  kept: boolean;
};

// The named checks on a head's tree, and those that decided only on files not committed (a run with the head
// checked out and changes in the worktree), said apart from "not run" because they ran, just not on a commit.
export type BoardChecks = ChecksOn & { uncommitted?: { passed: string[]; failed: string[] } };

export type BoardRow = {
  id: string; session_id: string; parent_id: string; depth: number;
  title: string; type: string; model: string; state: string; created: number; ended: number | null;
  machine: string | null;
  branch: string | null; repo: string | null; base: string | null;
  head: string | null; ahead: number | null; behind: number | null;
  worktree: "here" | "gone" | null;
  checks: BoardChecks | null;   // null: no branch
  review: BoardReview | null;   // the latest review of its branch
  reviews: string[];            // the branches this agent reviews
  landed: Landed | null;        // null: no branch
  queue: QueueFact | null;      // its branch's latest landing queue entry
  live: Live | null;            // null: no branch, or not landed
  work: Work | null;            // what its worktree changes; null: not read
  together: PairFact[] | null;  // null: no branch; the pairs it was checked in at its head
  pictures?: PictureFact | null; // the before and after pictures of its head, when its repository names them
};

export type Board = {
  session_id: string;
  rows: BoardRow[];
  total: number;                // agents of the tree; rows holds the newest MAX_ROWS of them
  repos: { repo: string; base: string | null; base_tip: string | null; deploys: Deploy[] }[];
  at: number;
  took_ms: number;
};

export const MAX_ROWS = 200;
export const LINE_MAX = 160;

// ---- reviews

const clip = (s: string, n = LINE_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (l: string) => l.replace(/^[\s#*_`|-]+/, "").replace(/[*`]+/g, "").trim();

// Prose is never read as a verdict: three rounds of review found reports a reader of their words took for
// an approval they were not (a correction after a lead-in, "yes for the stack except this head", a P1 left
// open). A LAND line is only quoted, as the reviewer's words.
const LAND_WORD = /(?<![\w-])land\s*:/i;
const TOKEN = /(?<![\w/-])[0-9a-f]{7,40}(?![\w/-])|(?<![\w./-])[A-Za-z0-9][\w.-]*\/[\w./-]*[\w-](?![\w/-])/g;
const isSha = (w: string) => /^[0-9a-f]{7,40}$/.test(w) && /[0-9]/.test(w);
// (Not a remote's ref or a file's path.)
const isBranch = (w: string) => w.includes("/") && !/^(?:origin|upstream|refs|remotes|src|ui|test|tests|docs|scripts|lib)\//.test(w) && !/\.\w{1,5}$/.test(w);
// The harness's own line between an agent's newest final and its earlier ones (src/automation/agents.ts).
const EARLIER = /^Earlier reports, oldest first:$/;

// The LAND lines of a report, outside code blocks and quotes, with the commits and branches each names:
// the newest final's last 40 and the earlier finals' last 20.
export function landLines(report: string | null | undefined): LandLine[] {
  const parts: LandLine[][] = [[], []];
  let fence = false, part = 0;
  for (const raw of (report ?? "").split("\n").slice(0, 4000)) {
    const t = raw.trim();
    if (/^(?:```|~~~)/.test(t)) { fence = !fence; continue; }
    if (fence || t.startsWith(">")) continue;
    if (EARLIER.test(t)) { part = 1; continue; }
    const l = plain(raw);
    if (!LAND_WORD.test(l)) continue;
    const toks = [...l.matchAll(TOKEN)].map((m) => m[0]);
    parts[part]!.push({ line: clip(l), shas: [...new Set(toks.filter(isSha))], branches: [...new Set(toks.filter(isBranch))], part });
  }
  return [...parts[0]!.slice(-40), ...parts[1]!.slice(-20)];
}

// The line to quote for a row: in the newest final first, the last LAND line that names its head, else the
// head the reviewer started on, else its branch, else the last that names no commit and no branch.
export function quoteFor(lines: readonly LandLine[], o: { head?: string | null; tip?: string | null; branch?: string | null }): { line: string; of: "head" | "tip" | "branch" | "bare" } | undefined {
  const names = (l: LandLine, h: string | null | undefined) => !!h && l.shas.some((s) => h.startsWith(s));
  for (const part of [0, 1]) {
    const ls = lines.filter((l) => l.part === part);
    const h = ls.findLast((l) => names(l, o.head));
    if (h) return { line: h.line, of: "head" };
    const t = o.tip && o.tip !== o.head ? ls.findLast((l) => names(l, o.tip)) : undefined;
    if (t) return { line: t.line, of: "tip" };
    const b = o.branch ? ls.findLast((l) => l.branches.includes(o.branch!)) : undefined;
    if (b) return { line: b.line, of: "branch" };
    const bare = ls.findLast((l) => !l.shas.length && !l.branches.length);
    if (bare) return { line: bare.line, of: "bare" };
  }
  return undefined;
}

const HEX = /^[0-9a-f]{7,40}$/i;
// (A closing stop or mark is still the word: "no.", "yes!".)
const landOf = (v: unknown): "yes" | "no" | undefined => {
  if (v === true || v === false) return v ? "yes" : "no";
  const w = typeof v === "string" ? /^\s*(yes|no)\s*[.!]?\s*$/i.exec(v)?.[1]?.toLowerCase() : undefined;
  return w === "yes" || w === "no" ? w : undefined;
};

// The verdicts of an answer to an output_schema: each object (at any of the first levels, entries under
// an entry too) with a commit (`commit`, `sha` or `head`, seven or more hex digits) and `land` (or
// `verdict`) yes or no, or true or false. Entries whose commits are one written short and long are one
// commit: a no among them makes it a no, and a land that is neither word leaves it with no verdict.
export function outputVerdicts(value: unknown, at: number): StructuredVerdict[] {
  const found: { sha: string; land: "yes" | "no" | "doubt"; why: string }[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || found.length >= 200 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 50)) walk(x, depth + 1); return; }
    const o = v as Record<string, unknown>;
    const sha = [o.commit, o.sha, o.head].find((x): x is string => typeof x === "string" && HEX.test(x.trim()))?.trim().toLowerCase();
    const said = o.land ?? o.verdict;
    if (sha && said !== undefined) {
      const why = typeof o.why === "string" ? o.why : typeof o.reason === "string" ? o.reason : "";
      found.push({ sha, land: landOf(said) ?? "doubt", why: clip(why.trim()) });
    }
    for (const x of Object.values(o)) if (x && typeof x === "object") walk(x, depth + 1);
  };
  walk(value, 0);
  // One group per commit as its longest spelling; a short one that begins two is in both.
  const groups: { sha: string; land: "yes" | "no" | "doubt"; why: string }[] = [];
  for (const f of [...found].sort((x, y) => y.sha.length - x.sha.length)) {
    const into = groups.filter((g) => g.sha.startsWith(f.sha));
    if (!into.length) { groups.push({ ...f }); continue; }
    for (const g of into) {
      if (f.land === "no" && g.land !== "no") { g.land = "no"; g.why = f.why || g.why; }
      else if (f.land === "doubt" && g.land === "yes") g.land = "doubt";
    }
  }
  return groups.filter((g) => g.land !== "doubt").slice(0, 50).map((g) => ({ sha: g.sha, land: g.land as "yes" | "no", why: g.why, at, from: "output" as const, branches: null }));
}

// The review a row shows, from the reviews of its branch (and verdicts on its head by a reviewer the tree
// knows by those alone). Never one by the row's agent or an agent below it (a builder cannot review its
// own work: `chain`, the reviewer's sessions up to the root, read from the agents table; a review whose
// chain is not known is not shown). Approved or refused only from a structured verdict on the row's head,
// the newest one; a structured verdict of another head of the branch is stale; a reviewer that gave none
// is quoted by its LAND line ("words"), and one with a branch of its own (found by its task naming the
// branch) only when that line names the head, the branch or what it started on. Structured verdicts of the
// head come first, then words of it, then the rest; the newest first within each.
export function pickReview(reviews: readonly ReviewFact[], row: { id: string; session_id: string; branch: string | null; head: string | null }): BoardReview | undefined {
  if (!row.branch) return undefined;
  const ofHead = (v: StructuredVerdict) => !!row.head && row.head.startsWith(v.sha);
  const judged = reviews
    .filter((x) => x.by !== row.id && (x.how === "panel" || (!!x.chain && !x.chain.includes(row.session_id))))
    .filter((x) => x.branch === row.branch || (x.branch === null && x.verdicts.some(ofHead)))
    .map((x) => judge(x, row, ofHead))
    .filter((j): j is NonNullable<typeof j> => !!j)
    .sort((a, b) => b.rank - a.rank || b.review.at - a.review.at);
  // Reviewers that disagree on the head: disputed, the newest refusal with the newest approval beside it.
  // (Only a reviewer's own later verdict replaces its own.)
  const onHead = judged.filter((j) => j.rank === 3).map((j) => j.review);
  const no = onHead.find((v) => v.verdict === "refused"), yes = onHead.find((v) => v.verdict === "approved" && v.by !== no?.by);
  if (no && yes) return { ...no, verdict: "disputed", against: { by: yes.by, title: yes.title, how: yes.how, source: yes.source, line: yes.line, at: yes.at } };
  return judged[0]?.review;
}

function judge(x: ReviewFact, row: { branch: string | null; head: string | null }, ofHead: (v: StructuredVerdict) => boolean): { rank: number; review: BoardReview } | undefined {
  const base = { by: x.by, title: x.title, how: x.how, state: x.state, tip: x.tip };
  const said = (v: StructuredVerdict): Verdict => (v.land === "yes" ? "approved" : "refused");
  const newest = [...x.verdicts].sort((a, b) => b.at - a.at);
  const mine = newest.find(ofHead);
  if (mine) return { rank: 3, review: { ...base, verdict: said(mine), source: mine.from, line: mine.why, of: row.head, current: true, at: mine.at } };
  // (A verdict on a commit of this branch: its keel__verdict call said which branches held it; an
  // output_schema answer's commit is this branch's when it is the head the reviewer started on.)
  const older = newest.find((v) => (v.branches ? v.branches.includes(row.branch!) : !!x.tip && x.tip.startsWith(v.sha)));
  if (older) return { rank: 1, review: { ...base, verdict: "stale", was: said(older), source: older.from, line: older.why, of: older.sha, current: false, at: older.at } };
  const unknownHead = x.tip && row.head ? x.tip === row.head : null;
  if (x.said) return { rank: 1, review: { ...base, verdict: "unclear", was: x.said, source: "panel", line: x.panel ?? "", of: null, current: null, at: x.at } };
  if (x.state === "running" || x.state === "waiting") return x.how === "task" && x.own ? undefined : { rank: 1, review: { ...base, verdict: "pending", source: null, line: "", of: null, current: unknownHead, at: x.at } };
  const q = quoteFor(x.lines, { head: row.head, tip: x.tip, branch: row.branch });
  if (x.how === "task" && x.own && (!q || q.of === "bare")) return undefined;
  if (q) {
    const current = q.of === "head" ? true : q.of === "tip" ? x.tip === row.head : unknownHead;
    return { rank: current ? 2 : 1, review: { ...base, verdict: "words", source: "words", line: q.line, of: q.of === "head" ? row.head : x.tip, current, at: x.at } };
  }
  return { rank: 1, review: { ...base, verdict: "unclear", source: x.how === "panel" ? "panel" : null, line: x.panel ?? "", of: null, current: unknownHead, at: x.at } };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The branches of `cands` a task names: a branch by its whole name, a head by seven or more of its first
// hex digits (a candidate whose tip is null is named by its name only: see matchableTips). A name inside
// a longer one ("keel/a" in "keel/a-2") is not it.
export function namedIn(text: string, cands: readonly { branch: string; tip: string | null }[]): { branch: string; by: "name" | "head" }[] {
  const out = new Map<string, "name" | "head">();
  const shas = new Set((text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).map((s) => s.toLowerCase()));
  for (const c of cands) {
    if (!c.branch || out.has(c.branch)) continue;
    if (text.includes(c.branch) && new RegExp(`(?<![\\w./-])${escape(c.branch)}(?![\\w/-]|\\.[\\w])`).test(text)) { out.set(c.branch, "name"); continue; }
    if (c.tip && [...shas].some((s) => c.tip!.startsWith(s))) out.set(c.branch, "head");
  }
  return [...out].map(([branch, by]) => ({ branch, by }));
}

// The candidates whose head a task may name by its digits: not one still where its worktree started (a
// brief's "on origin/main 7b94df4ab" is that commit), nor one another ref of the repository points at too
// (`tips`: every ref's commit, the base and remotes included). The rest keep their tip; these get null.
export function matchableTips<T extends { tip: string | null; madeFrom?: string | null }>(cands: readonly T[], tips: readonly string[]): T[] {
  const n = new Map<string, number>();
  for (const t of tips) n.set(t, (n.get(t) ?? 0) + 1);
  return cands.map((c) => (!c.tip || c.tip === c.madeFrom || (n.get(c.tip) ?? 0) > 1 ? { ...c, tip: null } : c));
}

// What a spawn's `reviews` field holds: a branch name, several separated by spaces or commas, or a list.
export function reviewsInput(v: unknown): string[] | undefined {
  const list = typeof v === "string" ? v.split(/[\s,]+/) : Array.isArray(v) ? v : undefined;
  if (!list) return undefined;
  const names = list.filter((x): x is string => typeof x === "string").map((x) => x.trim().replace(/^refs\/heads\//, "")).filter((x) => x && x.length <= 200 && !x.startsWith("-"));
  return names.length ? [...new Set(names)].slice(0, 20) : undefined;
}

// ---- landing

// From git's answers: whether the base holds the head (`ancestor`), else `git cherry <base> <head>`:
// a line a commit of the head not reachable from the base, "-" when the base holds a commit of the
// same patch. `madeFrom`: the commit its worktree was made from (a head still there made nothing). With
// no record of it, a head the base holds that was committed before the agent started (`headTime` and
// `since`, in seconds) is where its branch started, not work of its own.
export function landedFrom(o: { head: string; madeFrom: string | null; ancestor: boolean | null; cherry: string | undefined; headTime?: number | null; since?: number | null }): Landed {
  if (o.madeFrom && o.head === o.madeFrom) return { state: "nothing" };
  if (o.ancestor === true) {
    if (!o.madeFrom && o.headTime != null && o.since != null && o.headTime < o.since) return { state: "nothing" };
    return { state: "yes", how: "ancestor" };
  }
  if (o.cherry === undefined) return { state: "unknown", why: o.ancestor === null ? "git could not compare it with the base" : "git could not compare its patches with the base" };
  const lines = o.cherry.split("\n").map((l) => l.trim()).filter(Boolean);
  const missing = lines.filter((l) => l.startsWith("+")).length;
  if (missing) return { state: "no", missing };
  if (lines.length) return { state: "yes", how: "patch" };
  return { state: "unknown", why: "git named no commit of it, and the base does not hold it" };
}

// A head git does not see in the base (a squash, a patch edited while it landed) that the landing queue
// landed as it is now: the queue's word.
export function queueLanded(l: Landed, q: { state: string; current: boolean } | null | undefined): Landed {
  return l.state === "no" && q?.current && q.state === "landed" ? { state: "yes", how: "queue" } : l;
}

// The commit whose place in a deploy says whether a landed row is live: its head, or for a head the queue
// landed that git does not see on the base, the commit the queue put there.
export function liveSha(r: Pick<BoardRow, "head" | "landed" | "queue">): string | null {
  return r.landed?.state === "yes" && r.landed.how === "queue" && r.queue?.landed ? r.queue.landed : r.head;
}

// Live: whichever of the repository's deploys holds the head (the after step's commit, this daemon's
// build), else not live at the first of them.
export function liveFrom(held: readonly { deploy: Deploy; holds: Landed }[]): Live | null {
  const yes = held.find((h) => h.holds.state === "yes" || h.holds.state === "nothing");
  if (yes) return { state: "yes", at: yes.deploy.sha, how: yes.deploy.how };
  const no = held.find((h) => h.holds.state === "no");
  if (no) return { state: "no", at: no.deploy.sha, how: no.deploy.how };
  const unknown = held.find((h) => h.holds.state === "unknown");
  return unknown && unknown.holds.state === "unknown" ? { state: "unknown", why: unknown.holds.why } : null;
}

// ---- the board as text: what a coordinator reads

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 9) : "?");
const STATE_WORD: Record<string, string> = { running: "working", waiting: "waiting", completed: "done", incomplete: "incomplete", failed: "failed", stopped: "stopped" };
export const stateWord = (s: string) => STATE_WORD[s] ?? s;
const live = (s: string) => s === "running" || s === "waiting";

// A row's words. Terse (the board's own lines): a fact that says nothing is left out ("review: none", no
// checks named); `full` (one agent asked for) says every fact and why one is not known.
function checksWords(c: BoardChecks | null, full: boolean): string {
  if (!c) return "";
  if (c.state === "none") return full ? "checks: the repository names none" : "";
  if (c.state === "unknown") return full ? `checks: unknown (${c.why})` : "checks unknown";
  const u = c.state === "known" ? c.uncommitted : undefined;
  const notRun = c.notRun.filter((n) => !u?.passed.includes(n) && !u?.failed.includes(n));
  const parts = [c.passed.length ? `passed ${c.passed.join(", ")}` : "", c.failed.length ? `failed ${c.failed.join(", ")}` : "", u?.passed.length ? `passed on uncommitted files, none on a commit: ${u.passed.join(", ")}` : "", u?.failed.length ? `failed on uncommitted files, none on a commit: ${u.failed.join(", ")}` : "", notRun.length ? `not run ${notRun.join(", ")}` : ""].filter(Boolean);
  return `checks ${full ? "on its head: " : ""}${parts.join("; ") || "none decided"}`;
}

function landedWords(r: BoardRow, full: boolean): string {
  const l = r.landed;
  if (!l) return "";
  const n = l.state === "no" ? `${l.missing} ${l.missing === 1 ? "commit" : "commits"}` : "";
  const how = l.state === "yes" ? l.how : null;
  const s = l.state === "yes"
    ? how === "queue" ? (full ? `landed by the landing queue (git does not see its patches on ${r.base ?? "the base"}: a squash or edited patches)` : "landed by the queue")
      : full ? `landed on ${r.base ?? "the base"}${how === "patch" ? " (as the same patches)" : ""}` : `landed${how === "patch" ? " as patches" : ""}`
    : l.state === "no" ? (full ? `not landed (${n} the base lacks; a squash or edited patches are not seen)` : `not landed (${n})`)
    : l.state === "nothing" ? "no commits of its own"
    : full ? `landed: unknown (${l.why})` : "landed unknown";
  const lv = r.live;
  const lvs = !lv ? "" : lv.state === "yes" ? (full ? `, live (${lv.how} at ${short(lv.at)})` : ", live") : lv.state === "no" ? `, not live yet${full ? ` (${lv.how} at ${short(lv.at)})` : ""}` : full ? `, live: unknown (${lv.why})` : "";
  return s + lvs;
}

// A part that was not counted leaves every figure a lower bound: each carries the plus.
export const changeWords = (c: Change) => { const m = c.more ? "+" : ""; return `${c.files}${m} ${c.files === 1 ? "file" : "files"} +${c.added}${m} -${c.removed}${m}`; };
const workWords = (w: Work | null) => [w?.uncommitted ? `uncommitted ${changeWords(w.uncommitted)}` : "", w?.branch ? `on branch ${changeWords(w.branch)}` : ""].filter(Boolean).join(", ");

function reviewWords(v: BoardReview | null, full: boolean): string {
  if (!v) return full ? "review: none" : "";
  const head = v.current === false && v.verdict !== "stale" ? `, of an older head ${short(v.tip)}` : "";
  const words = v.verdict === "pending" ? "running"
    : v.verdict === "stale" ? `stale (${v.was ?? "said"} of ${short(v.of ?? v.tip)}, not its head now)`
    : v.verdict === "unclear" && v.was ? `unclear (${v.was} of a head not known)`
    : v.verdict === "words" ? `words only (no structured verdict${full ? ": keel__verdict, an output_schema verdict or the Review panel decides" : ""})`
    : v.verdict === "unclear" ? "unclear (no verdict)"
    : v.verdict === "disputed" ? "disputed (reviewers disagree on its head): refused" : v.verdict;
  const who = v.how === "panel" ? "the Review panel" : `${v.by} ("${clip(v.title, full ? LINE_MAX : 30)}")`;
  const other = v.against ? `; approved by ${v.against.how === "panel" ? "the Review panel" : `${v.against.by} ("${clip(v.against.title, full ? LINE_MAX : 30)}")`}${v.against.line ? `, who wrote: "${full ? v.against.line : clip(v.against.line, 60)}"` : ""}` : "";
  return `review ${words} by ${who}${head}${v.line ? `, reviewer wrote: "${full ? v.line : clip(v.line, 60)}"` : ""}${other}`;
}

const plain2 = (xs: readonly string[], n = 4) => (xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", "));
function togetherWords(t: PairFact[] | null, full: boolean): string {
  if (!t?.length) return "";
  const red = t.filter((p) => p.state === "red");
  const reds = red.map((p) => `red together with ${p.with}${p.with_agent ? ` (${p.with_agent})` : ""} at ${short(p.head)}+${short(p.with_head)}: ${p.checks.map((c) => `${c.name}${c.tests?.length ? ` (${plain2(c.tests, full ? 12 : 3)})` : ""}`).join("; ")}`);
  if (!full) return reds.join(" · ");
  const green = t.filter((p) => p.state === "green").map((p) => p.with), running = t.filter((p) => p.state === "running").map((p) => p.with), broken = t.filter((p) => p.state === "broken").map((p) => p.with);
  return [...reds, green.length ? `green together with ${green.join(", ")}` : "", running.length ? `checking together with ${running.join(", ")}` : "", broken.length ? `not checked together with ${broken.join(", ")}: red on both sides alone, the setup or the base is broken` : ""].filter(Boolean).join(" · ");
}

function picturesWords(p: PictureFact | null | undefined): string {
  if (!p || p.state === "skipped") return "";
  if (p.state === "none") return "pictures not taken (taken when opened)";
  if (p.state === "queued" || p.state === "running") return `pictures ${p.state}`;
  if (p.state === "failed") return `pictures failed (${clip(p.why ?? "", 60)})`;
  const c = p.counts, n = c.changed + c.new + c.gone, all = n + c.unstable + c.same + c.unread;
  const shaky = c.unstable ? `, ${c.unstable} unstable` : "";
  return n ? `pictures: ${n} of ${all} differ${shaky}` : `pictures: none of ${all} differs${shaky}`;
}

function queueWords(q: QueueFact | null, full: boolean): string {
  if (!q || (!q.current && q.state === "landed")) return "";
  return `queue ${q.state}${q.current ? "" : " (an older head)"}${q.why ? ` (${clip(q.why, full ? LINE_MAX : 60)})` : ""}`;
}

export function rowLine(r: BoardRow, full = false): string {
  const head = r.branch ? `${r.branch}@${short(r.head)}${r.behind && r.landed?.state !== "yes" ? ` ${r.behind} behind` : ""}${full && r.worktree === "gone" ? " (worktree removed)" : ""}` : "";
  const parts = [
    `${r.id} ${stateWord(r.state)} "${clip(r.title, full ? LINE_MAX : 40)}"${r.depth > 1 ? ` (depth ${r.depth})` : ""}`,
    head,
    r.reviews.length ? `reviews ${r.reviews.join(", ")}` : "",
    checksWords(r.checks, full),
    r.branch ? reviewWords(r.review, full) : "",
    workWords(r.work),
    landedWords(r, full),
    queueWords(r.queue, full),
    togetherWords(r.together, full),
    picturesWords(r.pictures),
  ].filter(Boolean);
  return parts.join(" · ");
}

// A finished agent whose branch and worktree are gone (removed at its end: it kept no commit, or its
// work was taken): nothing of it is left to land.
export const branchGone = (r: BoardRow) => !!r.branch && !r.head && r.worktree === "gone" && !live(r.state);
// Work a coordinator still owes a landing: a branch not landed, or one git could not read.
export const toLand = (r: BoardRow) => !!r.landed && r.landed.state !== "yes" && r.landed.state !== "nothing" && !branchGone(r);

// A branch with nothing left but the landing: not landed, no agent at work on it, its named checks all passed on its head,
// nothing uncommitted in its worktree, and no reviewer's refusal. (A worktree not read is not known clean.)
export const readyToLand = (r: BoardRow) =>
  toLand(r) && r.landed?.state === "no" && !live(r.state) && r.checks?.state === "known" && r.checks.failed.length === 0 && r.checks.notRun.length === 0 && r.checks.passed.length > 0
  && !!r.work && !r.work.uncommitted && !(r.review && (r.review.verdict === "refused" || r.review.verdict === "disputed"));

// The board in a few hundred tokens: each agent that needs the coordinator in a line of its own (one that
// works, or whose branch is not landed), the rest by their ids on one line. `all`: every row in full;
// `agent`: that row alone, in full.
export function boardText(b: Board, o: { all?: boolean; agent?: string } = {}): string {
  if (o.agent) {
    const r = b.rows.find((x) => x.id === o.agent || x.session_id === o.agent);
    return r ? rowLine(r, true) : `No agent ${o.agent} on this session's board.`;
  }
  if (!b.total) return "No agents in this session's tree.";
  const counts = new Map<string, number>();
  for (const r of b.rows) counts.set(stateWord(r.state), (counts.get(stateWord(r.state)) ?? 0) + 1);
  const repo = b.repos.length === 1 ? b.repos[0]! : undefined;
  const noChecks = b.rows.some((r) => r.checks?.state === "none") && !b.rows.some((r) => r.checks && r.checks.state !== "none");
  const out = [`Work board: ${b.total} ${b.total === 1 ? "agent" : "agents"} (${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")})${repo ? `; base ${repo.base ?? "?"} at ${short(repo.base_tip)}${repo.deploys.length ? `, live at ${repo.deploys.map((d) => `${short(d.sha)} (${d.how})`).join(", ")}` : ""}` : ""}${noChecks ? "; the repository names no checks" : ""}.`];
  const attention = (r: BoardRow) => o.all || live(r.state) || toLand(r) || (r.landed?.state === "yes" && r.live?.state === "no");
  const shown = b.rows.filter(attention);
  out.push(...shown.map((r) => rowLine(r)));
  const rest = b.rows.filter((r) => !attention(r));
  const landedIds = rest.filter((r) => r.landed?.state === "yes").map((r) => r.id);
  const reviewers = rest.filter((r) => !r.branch && r.reviews.length).map((r) => `${r.id} (${r.reviews.join(", ")})`);
  const gone = rest.filter((r) => branchGone(r)).map((r) => r.id);
  const other = rest.filter((r) => r.landed?.state !== "yes" && !branchGone(r) && !(!r.branch && r.reviews.length)).map((r) => r.id);
  if (landedIds.length) out.push(`Landed${rest.some((r) => r.live?.state === "yes") ? " (and live where a deploy is known)" : ""}: ${landedIds.join(", ")}.`);
  if (reviewers.length) out.push(`Reviewers done: ${reviewers.join(", ")}.`);
  if (other.length) out.push(`Done with no branch to land: ${other.join(", ")}.`);
  if (gone.length) out.push(`Done, branch removed: ${gone.join(", ")}.`);
  if (b.total > b.rows.length) out.push(`${b.total - b.rows.length} older agents are not on the board.`);
  if (!o.all && rest.length) out.push("all: true lists every row; agent: <id> shows one row in full.");
  return out.join("\n");
}
