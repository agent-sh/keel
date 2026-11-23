// The work board, its pure part: what a coordinator's lane map says of each agent of its tree, decided
// from facts the daemon holds (the agents and worktrees tables, git, the check ledger, the landing queue
// and its after-land step, this daemon's own build), and the few hundred tokens a coordinator reads of it.
// The only words of a model on the board are a reviewer's verdict line, quoted and named as its.
// The part that reads the facts is src/board/board.ts; this file runs on the read thread too, so it
// imports nothing of the daemon.
import type { ChecksOn } from "../automation/landing.ts";

export type Verdict = "approved" | "refused" | "unclear" | "pending";

// A review of a branch: an agent whose spawn named the branch it reviews (`reviews`), one whose task named
// the branch or its head and that has no branch of its own, or a review the owner ran from the Review panel.
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

export type Landed =
  | { state: "yes"; how: "ancestor" | "patch" } // the base holds the head, or a commit of the same patch for each of its commits
  | { state: "no"; missing: number }            // commits of the head whose patch the base does not hold
  | { state: "nothing" }                         // the branch has no commit of its own
  | { state: "unknown"; why: string };

export type Live =
  | { state: "yes"; at: string; how: Deploy["how"] }
  | { state: "no"; at: string; how: Deploy["how"] }
  | { state: "unknown"; why: string };

// What runs: the commit the repository's after-land step last ran on and passed, or this daemon's own build.
export type Deploy = { sha: string; how: "after step" | "this daemon"; at: number | null };

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
  repos: { repo: string; base: string | null; base_tip: string | null; deploy: Deploy | null }[];
  at: number;
  took_ms: number;
};

export const MAX_ROWS = 200;
export const LINE_MAX = 160;

// ---- reviews

const clip = (s: string, n = LINE_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (l: string) => l.replace(/^[\s>#*_`|-]+/, "").replace(/[*_`]+/g, "").trim();

// The words that decide a verdict. A refusal is read first: "not approved" refuses.
const REFUSE = /\b(refuse[sd]?|reject(?:s|ed)?|request(?:s|ed)? changes|changes (?:requested|needed|required)|needs? (?:changes|work|fixes|another pass)|not (?:approved?|ready|accepted|landable|mergeable)|do not (?:land|merge|ship)|don'?t (?:land|merge|ship)|block(?:s|ed|ing)?|no[- ]go|nack)\b/i;
const APPROVE = /\b(approve[sd]?|accept(?:s|ed)?|lgtm|ready to (?:land|merge|ship)|ship it|good to (?:go|land|merge)|land it|merge it)\b/i;
// On a line that says it is the verdict, the plainer words too.
const REFUSE_LABELED = /\b(incorrect|fail(?:s|ed)?|no|wrong|broken)\b/i;
const APPROVE_LABELED = /\b(correct|pass(?:es|ed)?|yes|ok(?:ay)?|good|clean|ready)\b/i;
const LABEL = /^(?:(?:final|review|my)\s+)?(verdict|decision|outcome|result|recommendation)\b\s*[:=–-]/i;

export function classify(text: string, labeled = false): Verdict {
  if (REFUSE.test(text)) return "refused";
  if (APPROVE.test(text)) return "approved";
  if (labeled && REFUSE_LABELED.test(text)) return "refused";
  if (labeled && APPROVE_LABELED.test(text)) return "approved";
  return "unclear";
}

// The verdict of a reviewer's report and the line it was read from: a line that says it is the verdict
// ("Verdict: ..."), else the first line with a verdict's words, else the report's first line, unclear.
// A report that is one JSON value is read by its verdict-like key.
export function verdictOf(report: string | null | undefined): { verdict: Verdict; line: string } {
  const text = (report ?? "").trim();
  if (!text) return { verdict: "unclear", line: "" };
  const json = /^```(?:json)?\s*([\s\S]*?)```$/.exec(text)?.[1] ?? (text.startsWith("{") ? text : undefined);
  if (json) {
    try {
      const v = JSON.parse(json) as Record<string, unknown>;
      for (const k of ["verdict", "decision", "outcome", "result", "status", "recommendation"]) {
        const got = v[k];
        if (typeof got === "string" || typeof got === "boolean") {
          const said = `${k}: ${String(got)}${typeof v.summary === "string" ? ` · ${v.summary}` : ""}`;
          return { verdict: typeof got === "boolean" ? (got ? "approved" : "refused") : classify(String(got), true), line: clip(said) };
        }
      }
    } catch {}
  }
  const lines = text.split("\n").map(plain).filter(Boolean).slice(0, 400);
  const labeled = lines.find((l) => LABEL.test(l));
  if (labeled) return { verdict: classify(labeled.replace(LABEL, ""), true), line: clip(labeled) };
  const worded = lines.slice(0, 60).find((l) => classify(l) !== "unclear");
  if (worded) return { verdict: classify(worded), line: clip(worded) };
  return { verdict: "unclear", line: clip(lines[0] ?? "") };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The branches of `cands` a task names: a branch by its whole name, a head by seven or more of its first
// hex digits. A name inside a longer one ("keel/a" in "keel/a-2") is not it.
export function namedIn(text: string, cands: readonly { branch: string; tip: string | null }[]): string[] {
  const out = new Set<string>();
  const shas = new Set((text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).map((s) => s.toLowerCase()));
  for (const c of cands) {
    if (!c.branch) continue;
    if (text.includes(c.branch) && new RegExp(`(?<![\\w./-])${escape(c.branch)}(?![\\w/-]|\\.[\\w])`).test(text)) { out.add(c.branch); continue; }
    if (c.tip && [...shas].some((s) => c.tip!.startsWith(s))) out.add(c.branch);
  }
  return [...out];
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
// same patch. `madeFrom`: the commit its worktree was made from (a head still there made nothing).
export function landedFrom(o: { head: string; madeFrom: string | null; ancestor: boolean | null; cherry: string | undefined }): Landed {
  if (o.madeFrom && o.head === o.madeFrom) return { state: "nothing" };
  if (o.ancestor === true) return { state: "yes", how: "ancestor" };
  if (o.cherry === undefined) return { state: "unknown", why: o.ancestor === null ? "git could not compare it with the base" : "git could not compare its patches with the base" };
  const lines = o.cherry.split("\n").map((l) => l.trim()).filter(Boolean);
  const missing = lines.filter((l) => l.startsWith("+")).length;
  if (missing) return { state: "no", missing };
  if (lines.length) return { state: "yes", how: "patch" };
  return { state: "unknown", why: "git named no commit of it, and the base does not hold it" };
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
  const s = l.state === "yes" ? (full ? `landed on ${r.base ?? "the base"}${l.how === "patch" ? " (as the same patches)" : ""}` : `landed${l.how === "patch" ? " as patches" : ""}`)
    : l.state === "no" ? (full ? `not landed (${n} the base lacks)` : `not landed (${n})`)
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
  return `review ${words} by ${v.how === "panel" ? "the Review panel" : v.by}${head}${v.line ? ` "${full ? v.line : clip(v.line, 60)}"` : ""}`;
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
  const out = [`Work board: ${b.total} ${b.total === 1 ? "agent" : "agents"} (${[...counts].map(([k, n]) => `${n} ${k}`).join(", ")})${repo ? `; base ${repo.base ?? "?"} at ${short(repo.base_tip)}${repo.deploy ? `, live at ${short(repo.deploy.sha)} (${repo.deploy.how})` : ""}` : ""}${noChecks ? "; the repository names no checks" : ""}.`];
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
