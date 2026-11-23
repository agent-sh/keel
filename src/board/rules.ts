// The work board, its pure part: what a coordinator's lane map says of each agent of its tree, decided
// from facts the daemon holds (the agents and worktrees tables, git, the check ledger, the landing queue
// and its after-land step, this daemon's own build), and the few hundred tokens a coordinator reads of it.
// The only words of a model on the board are a reviewer's verdict line, quoted and named as its.
// The part that reads the facts is src/board/board.ts; this file runs on the read thread too, so it
// imports nothing of the daemon.
import type { ChecksOn } from "../automation/landing.ts";

export type Verdict = "approved" | "refused" | "mixed" | "unclear" | "pending";

// A review of a branch: an agent whose spawn named the branch it reviews (`reviews`), one whose task named
// the branch or its head, or a review the owner ran from the Review panel.
export type BoardReview = {
  by: string;                  // the agent's id, or the panel review's id
  title: string;
  how: "named" | "task" | "panel";
  state: string;               // the agent's status, or the panel review's state
  verdict: Verdict;
  line: string;                // the reviewer's own words the verdict was read from
  tip: string | null;          // the head it reviewed, when known
  current: boolean | null;     // it reviewed the branch's head as it is now; null: not known
  at: number;
};

// What the read thread keeps of a review (src/board/facts.ts): its report read into marks, decided for a
// row's head when the board knows the head (pickReview).
export type ReviewFact = {
  by: string; title: string; how: BoardReview["how"]; state: string; branch: string; tip: string | null;
  own: boolean;                // the reviewer has a branch of its own
  read: ReportRead; at: number;
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

export type BoardRow = {
  id: string; session_id: string; parent_id: string; depth: number;
  title: string; type: string; model: string; state: string; created: number; ended: number | null;
  machine: string | null;
  branch: string | null; repo: string | null; base: string | null;
  head: string | null; ahead: number | null; behind: number | null;
  worktree: "here" | "gone" | null;
  checks: ChecksOn | null;      // null: no branch
  review: BoardReview | null;   // the latest review of its branch
  reviews: string[];            // the branches this agent reviews
  landed: Landed | null;        // null: no branch
  queue: QueueFact | null;      // its branch's latest landing queue entry
  live: Live | null;            // null: no branch, or not landed
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
const plain = (l: string) => l.replace(/^[\s>#*_`|-]+/, "").replace(/[*`]+/g, "").trim();

// The words of a labelled verdict line ("Verdict: ...", "Decision: ..."). A refusal is read first: "not approved" refuses.
const REFUSE = /\b(refuse[sd]?|reject(?:s|ed)?|request(?:s|ed)? changes|changes (?:requested|needed|required)|needs? (?:changes|work|fixes|another pass)|not (?:approved?|ready|accepted|landable|mergeable|correct)|do not (?:land|merge|ship)|don'?t (?:land|merge|ship)|blocked|no[- ]go|nack|incorrect|fail(?:s|ed)?|no|wrong|broken)\b/i;
const APPROVE = /\b(approve[sd]?|accept(?:s|ed)?|lgtm|ready to (?:land|merge|ship)|ship it|good to (?:go|land|merge)|land it|merge it|correct|pass(?:es|ed)?|yes|ok(?:ay)?|good|clean|ready)\b/i;
const LABEL = /^(?:(?:final|review|my|overall)\s+)?(verdict|decision|outcome|recommendation)\b\s*[:=–-]/i;

// The verdict a labelled line's first clause says ("Verdict: refused. Line 12 ..." reads "refused").
export function classify(text: string): Verdict {
  const first = text.split(/[.;(—]|,\s/)[0] ?? "";
  if (REFUSE.test(first)) return "refused";
  if (APPROVE.test(first)) return "approved";
  return "unclear";
}

// A reviewer's "LAND: yes" or "LAND: no", with the commits and branches it was said of: the ones on its
// line, else the ones of the heading above it. A line can say two ("LAND: yes for 1a2b3c4, no for 5d6e7f8").
export type LandMark = { verdict: "approved" | "refused"; shas: string[]; branches: string[]; line: string };
export type ReportRead = { marks: LandMark[]; verdict: Verdict; line: string };

const LAND = /(?<![\w-])(?:LAND|Land)\s*:\s*["']?(yes|no|YES|NO|Yes|No)\b/;
const AGAIN = /\b(yes|no)\s+(?:for|on)\b/gi;
const HEX = /(?<![\w/-])[0-9a-f]{7,40}(?![\w/-])/g;
const BRANCH = /(?<![\w./-])[A-Za-z0-9][\w.-]*\/[\w./-]*[\w-](?![\w/-])/g;
const said = (w: string): LandMark["verdict"] => (w.toLowerCase() === "yes" ? "approved" : "refused");
const shasIn = (l: string) => [...new Set((l.match(HEX) ?? []).filter((w) => /[0-9]/.test(w)))];
// (Not a remote's ref or a file's path.)
const branchesIn = (l: string) => [...new Set((l.match(BRANCH) ?? []).filter((w) => !/^(?:origin|upstream|refs|remotes|src|ui|test|tests|docs|scripts|lib)\//.test(w) && !/\.\w{1,5}$/.test(w)))];

// A report read into its LAND marks, and, when it has none, the verdict of a labelled line or of a JSON
// report's verdict-like key. Free prose decides nothing: words like "accepts" or "blocks" in a finding
// are not a verdict, so a report with no labelled line is unclear.
export function readReport(report: string | null | undefined): ReportRead {
  const text = (report ?? "").trim();
  if (!text) return { marks: [], verdict: "unclear", line: "" };
  const json = /^```(?:json)?\s*([\s\S]*?)```$/.exec(text)?.[1] ?? (text.startsWith("{") ? text : undefined);
  if (json) {
    try {
      const v = JSON.parse(json) as Record<string, unknown>;
      for (const k of ["verdict", "decision", "outcome", "result", "status", "recommendation", "land", "approved"]) {
        const got = v[k];
        if (typeof got === "string" || typeof got === "boolean") {
          const line = clip(`${k}: ${String(got)}${typeof v.summary === "string" ? ` · ${v.summary}` : ""}`);
          return { marks: [], verdict: typeof got === "boolean" ? (got ? "approved" : "refused") : classify(String(got)), line };
        }
      }
    } catch {}
  }
  const marks: LandMark[] = [];
  let section: { shas: string[]; branches: string[] } = { shas: [], branches: [] };
  let labelled: { verdict: Verdict; line: string } | undefined;
  for (const raw of text.split("\n").slice(0, 2000)) {
    const l = plain(raw);
    if (!l) continue;
    if (/^\s*#/.test(raw)) section = { shas: shasIn(l), branches: branchesIn(l) };
    const m = LAND.exec(l);
    if (!m) {
      if (!labelled && LABEL.test(l)) labelled = { verdict: classify(l.replace(LABEL, "").trim()), line: clip(l) };
      continue;
    }
    // The verdicts of the line in order, each with the commits after it up to the next; the commits before
    // the label go with the first.
    const at = [{ verdict: said(m[1]!), from: m.index }];
    for (const a of l.slice(m.index + m[0].length).matchAll(AGAIN)) at.push({ verdict: said(a[1]!), from: m.index + m[0].length + a.index! });
    const line = clip(l);
    at.forEach((x, i) => {
      const part = i === 0 ? l.slice(0, at[1]?.from ?? l.length) : l.slice(x.from, at[i + 1]?.from ?? l.length);
      let shas = shasIn(part), branches = branchesIn(part);
      if (at.length === 1 && !shas.length && !branches.length) ({ shas, branches } = section);
      marks.push({ verdict: x.verdict, shas, branches, line });
    });
    if (marks.length >= 200) break;
  }
  if (marks.length) return { marks, verdict: "unclear", line: "" };
  if (labelled) return { marks: [], ...labelled };
  return { marks: [], verdict: "unclear", line: clip(plain(text.split("\n").find((l) => plain(l)) ?? "")) };
}

// The verdict a read report gives this row: the first mark (a report holds its newest final first) that
// names the row's head or the head the reviewer started on, else one that names the branch, else the
// first mark that names no commit nor another branch the reviewer reviews; marks that name only other commits are mixed when they
// disagree, unclear when they agree.
// `others`: the other branches the same reviewer reviews; a mark that names one of them is its, not this
// branch's (a branch named for another reason, "lands after keel/x", leaves a mark bare).
export type VerdictAsk = { heads?: (string | null | undefined)[]; branch?: string | null; others?: ReadonlySet<string> };
export function verdictFor(r: ReportRead, o: VerdictAsk = {}): { verdict: Verdict; line: string } {
  if (!r.marks.length) return { verdict: r.verdict, line: r.line };
  const pick = (m: LandMark | undefined) => m && { verdict: m.verdict, line: m.line };
  for (const h of o.heads ?? []) {
    if (!h) continue;
    const got = r.marks.find((m) => m.shas.some((s) => h.startsWith(s)));
    if (got) return pick(got)!;
  }
  const byName = o.branch ? r.marks.find((m) => m.branches.includes(o.branch!)) : undefined;
  if (byName) return pick(byName)!;
  const bare = r.marks.find((m) => !m.shas.length && !m.branches.some((b) => o.others?.has(b)));
  if (bare) return pick(bare)!;
  const words = new Set(r.marks.map((m) => m.verdict));
  const named = [...new Set(r.marks.flatMap((m) => m.shas.map((s) => s.slice(0, 9))))].slice(0, 4).join(", ");
  return { verdict: words.size > 1 ? "mixed" : "unclear", line: clip(`LAND said of other commits (${named || "other branches"}), not this head`) };
}

export function verdictOf(report: string | null | undefined, o: VerdictAsk = {}) {
  return verdictFor(readReport(report), o);
}

// The review a row shows: the newest of its branch, never one by the row's agent or an agent it started
// (a builder cannot review its own work), and from an agent with a branch of its own (found by its task
// naming the branch) only when it ended and a labelled line decided.
export function pickReview(
  reviews: readonly ReviewFact[],
  row: { id: string; session_id: string; branch: string | null; head: string | null },
  lineage: { parentOf(session: string): string | undefined; sessionOf(agent: string): string | undefined },
): BoardReview | undefined {
  const below = (by: string) => {
    let s = lineage.sessionOf(by);
    for (let i = 0; s && i < 16; i++) { if (s === row.session_id) return true; s = lineage.parentOf(s); }
    return false;
  };
  const out = reviews
    .filter((x) => x.branch === row.branch && x.by !== row.id && (x.how === "panel" || !below(x.by)))
    .map((x) => ({ x, v: x.state === "running" || x.state === "waiting" ? { verdict: "pending" as const, line: "" } : verdictFor(x.read, { heads: [row.head, x.tip], branch: row.branch, others: new Set(reviews.filter((y) => y.by === x.by && y.branch !== row.branch).map((y) => y.branch)) }) }))
    .filter(({ x, v }) => !(x.how === "task" && x.own && (v.verdict === "pending" || v.verdict === "unclear")))
    .sort((a, b) => b.x.at - a.x.at)[0];
  if (!out) return undefined;
  const { x, v } = out;
  return { by: x.by, title: x.title, how: x.how, state: x.state, verdict: v.verdict, line: v.line, tip: x.tip, current: x.tip && row.head ? x.tip === row.head : null, at: x.at };
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
function checksWords(c: ChecksOn | null, full: boolean): string {
  if (!c) return "";
  if (c.state === "none") return full ? "checks: the repository names none" : "";
  if (c.state === "unknown") return full ? `checks: unknown (${c.why})` : "checks unknown";
  const parts = [c.passed.length ? `passed ${c.passed.join(", ")}` : "", c.failed.length ? `failed ${c.failed.join(", ")}` : "", c.notRun.length ? `not run ${c.notRun.join(", ")}` : ""].filter(Boolean);
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

function reviewWords(v: BoardReview | null, full: boolean): string {
  if (!v) return full ? "review: none" : "";
  const head = v.current === false ? `, of an older head ${short(v.tip)}` : "";
  const words = v.verdict === "pending" ? "running" : v.verdict;
  const who = v.how === "panel" ? "the Review panel" : `${v.by} ("${clip(v.title, full ? LINE_MAX : 30)}")`;
  return `review ${words} by ${who}${head}${v.line ? `, reviewer wrote: "${full ? v.line : clip(v.line, 60)}"` : ""}`;
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
    landedWords(r, full),
    queueWords(r.queue, full),
  ].filter(Boolean);
  return parts.join(" · ");
}

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
  const attention = (r: BoardRow) => o.all || live(r.state) || (r.landed && r.landed.state !== "yes" && r.landed.state !== "nothing") || (r.landed?.state === "yes" && r.live?.state === "no");
  const shown = b.rows.filter(attention);
  out.push(...shown.map((r) => rowLine(r)));
  const rest = b.rows.filter((r) => !attention(r));
  const landedIds = rest.filter((r) => r.landed?.state === "yes").map((r) => r.id);
  const reviewers = rest.filter((r) => !r.branch && r.reviews.length).map((r) => `${r.id} (${r.reviews.join(", ")})`);
  const other = rest.filter((r) => r.landed?.state !== "yes" && !(!r.branch && r.reviews.length)).map((r) => r.id);
  if (landedIds.length) out.push(`Landed${rest.some((r) => r.live?.state === "yes") ? " (and live where a deploy is known)" : ""}: ${landedIds.join(", ")}.`);
  if (reviewers.length) out.push(`Reviewers done: ${reviewers.join(", ")}.`);
  if (other.length) out.push(`Done with no branch to land: ${other.join(", ")}.`);
  if (b.total > b.rows.length) out.push(`${b.total - b.rows.length} older agents are not on the board.`);
  if (!o.all && rest.length) out.push("all: true lists every row; agent: <id> shows one row in full.");
  return out.join("\n");
}
