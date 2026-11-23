// The work board, its pure part: what a coordinator's lane map says of each agent of its tree, decided
// from facts the daemon holds (the agents and worktrees tables, git, the check ledger, the landing queue
// and its after-land step, this daemon's own build), and the few hundred tokens a coordinator reads of it.
// The only words of a model on the board are a reviewer's verdict line, quoted and named as its.
// The part that reads the facts is src/board/board.ts; this file runs on the read thread too, so it
// imports nothing of the daemon.
import type { ChecksOn } from "../automation/landing.ts";

// stale: a review of another head than the branch's now, whatever it said (`was`).
export type Verdict = "approved" | "refused" | "mixed" | "unclear" | "pending" | "stale";

// A review of a branch: an agent whose spawn named the branch it reviews (`reviews`), one whose task named
// the branch or its head, or a review the owner ran from the Review panel.
export type BoardReview = {
  by: string;                  // the agent's id, or the panel review's id
  title: string;
  how: "named" | "task" | "panel";
  state: string;               // the agent's status, or the panel review's state
  verdict: Verdict;
  was?: Verdict;               // what it said, when the board does not take it as said (stale, or of a head not known)
  line: string;                // the reviewer's own words the verdict was read from
  tip: string | null;          // the head it was started on, when known
  of: string | null;           // the commit its verdict was said of, when known
  current: boolean | null;     // its verdict is of the branch's head as it is now; null: not known
  at: number;
};

// What the read thread keeps of a review (src/board/facts.ts): its report read into marks, decided for a
// row's head when the board knows the head (pickReview).
export type ReviewFact = {
  by: string; title: string; how: BoardReview["how"]; state: string; branch: string; tip: string | null;
  own: boolean;                // the reviewer has a branch of its own
  chain: string[] | null;      // the reviewer's session and the sessions above it, up to the root; null: not read
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
const plain = (l: string) => l.replace(/^[\s#*_`|-]+/, "").replace(/[*`]+/g, "").trim();

// The words of a labelled verdict line ("Verdict: ...", "Decision: ..."). A refusal is read first: "not approved" refuses.
const REFUSE = /\b(refuse[sd]?|reject(?:s|ed)?|request(?:s|ed)? changes|changes (?:requested|needed|required)|needs? (?:changes|work|fixes|another pass)|not (?:approved?|ready|accepted|landable|mergeable|correct)|do not (?:land|merge|ship)|don'?t (?:land|merge|ship)|blocked|no[- ]go|nack|incorrect|fail(?:s|ed)?|no|wrong|broken)\b/gi;
const APPROVE = /\b(approve[sd]?|accept(?:s|ed)?|lgtm|ready to (?:land|merge|ship)|ship it|good to (?:go|land|merge)|land it|merge it|correct|pass(?:es|ed)?|yes|ok(?:ay)?|good|clean|ready)\b/i;
const LABEL = /^(?:(?:final|review|my|overall)\s+)?(verdict|decision|recommendation)\b\s*[:=\u2013\u2014-]/i;
// Whether a clause holds a yes on something not done yet ("once X lands", "only after the rebase", "but
// the P1 first", "needs a rebase"), or asks. A follow-up is not a hold: "fix the P2 right after landing",
// "P3s only".
const HOLD = /\b(?:once|until|unless|if|provided|assuming|pending|but|wait|then|when)\b|\bonly\s+(?:after|if|when|once|with|together|as|on)\b|\b(?:first|before|blocked|not yet|as part of|stacked on|sits on|together|one stack|on top|in order|must not land)\b|\b(?:lands?|must land) with\b|\b(?:with|without)\s+[`*'"]*[0-9a-f]{7,40}\b|\?/i;
const AFTER = /\bafter\s+(?!landing\b|it lands\b|the land\b|that\b|this\b|it\b)[a-z]/i;
const NEEDS = /\b(?:needs?|requires?|depends? on|relies on)\b/i;
const FOLLOW = /\b(?:right after|after landing|after it lands|follow[- ]?up|in the same push|later|(?:is|are|was|were) (?:already )?(?:fixed|landed|on main|in main))\b/i;
const holds = (clause: string) => HOLD.test(clause) || AFTER.test(clause) || (NEEDS.test(clause) && !FOLLOW.test(clause));
const NEGATION = /\b(not|never|cannot|can'?t|won'?t|wouldn'?t|shouldn'?t|isn'?t|aren'?t|doesn'?t|don'?t)\b/i;

// The verdict a labelled line's first clause says ("Verdict: refused. Line 12 ..." reads "refused"). A
// condition ("approve once ..."), a negation of an approval ("not LGTM") or both words is unclear.
export function classify(text: string): Verdict {
  const first = text.split(/[.;(\u2014]|,\s/)[0] ?? "";
  if (holds(first)) return "unclear";
  const no = new RegExp(REFUSE.source, "i").test(first);
  const yes = APPROVE.test(first.replace(REFUSE, " "));
  if (no && yes) return "unclear";
  if (no) return "refused";
  return yes && !NEGATION.test(first) ? "approved" : "unclear";
}

// A reviewer's "LAND: yes" or "LAND: no" (or a labelled verdict line), with the commits and branches it
// was said of: the first on its line and any listed right after it, else the ones of the heading above
// it. `part` 0 is the newest final, 1 the earlier ones the harness added after its separator.
export type LandMark = { verdict: "approved" | "refused" | "unclear"; shas: string[]; branches: string[]; line: string; part: number };
export type ReportRead = { marks: LandMark[]; verdict: Verdict; line: string };

const LAND = /(?<![\w-])(?:LAND|Land)\s*:\s*["']?(yes|no|YES|NO|Yes|No)\b/g;
const AGAIN = /\b(yes|no)\s+(?:for|on)\b/gi;
const TOKEN = /(?<![\w/-])[0-9a-f]{7,40}(?![\w/-])|(?<![\w./-])[A-Za-z0-9][\w.-]*\/[\w./-]*[\w-](?![\w/-])/g;
const isSha = (w: string) => /^[0-9a-f]{7,40}$/.test(w) && /[0-9]/.test(w);
// (Not a remote's ref or a file's path.)
const isBranch = (w: string) => w.includes("/") && !/^(?:origin|upstream|refs|remotes|src|ui|test|tests|docs|scripts|lib)\//.test(w) && !/\.\w{1,5}$/.test(w);
// A commit or branch after one of these is what the work depends on, not what the verdict is of.
const DEPENDS = /\b(?:after|on|onto|with|by|stacked on|builds? on|built on|rel(?:y|ies) on|depends? on|needs?|requires?|fixed in|behind|than|from|like|see|before|over|atop|besides)\s*[`"'(*]*\s*$/i;
// "LAND: yes on 1a2b3c4", "no for 5d6e7f8": what the verdict is of, not a dependency.
const VERDICT_OF = /\b(?:yes|no)\s+(?:for|on)\s*[`"'(*]*\s*$/i;
// Only list marks between two commits of one list ("a1b2c3d, e4f5a6b and c7d8e9f").
const LISTED = /^[\s,`'"*+/&]*(?:and\s+)?[\s`'"*]*$/;
// What may stand before a mark on its line: nothing, or a heading's, a list's or a cell's title (a sha, a
// lane id, a few words) closed by a separator. Never a sentence, a negation, a modal or a condition.
const BEFORE_BAD = /\b(not|no|never|cannot|can'?t|won'?t|would|wouldn'?t|should|shouldn'?t|could|might|may|must|will|say|says|said|write|writes|wrote|until|unless|if|once|after|before|when|whether|wait|or|either|expect(?:s|ed)?|wants?|wanted|previous|earlier|template|format|e\.g)\b|n't\b/i;
function opensVerdict(before: string): boolean {
  const p = before.replace(/[\s*_`"']+$/, "");
  if (!p) return true;
  if (p.length > 120 || /[.!?](?:\s|$)/.test(p) || BEFORE_BAD.test(p)) return false;
  return /[:|\u2013\u2014)\]-]$/.test(p) || /(?:^|\s)(?:[0-9a-f]{7,40}|[A-Z][A-Z0-9]*-[A-Z]*\d+[a-z]?)$/.test(p);
}
const SELF = "";
// The harness's own line between an agent's newest final and its earlier ones (src/automation/agents.ts).
const EARLIER = /^Earlier reports, oldest first:$/;

// The subjects of a part of a line: its first commit not named as a dependency and the commits listed
// right after it; its branches the same way.
function subjectsOf(text: string): { shas: string[]; branches: string[] } {
  const toks = [...text.matchAll(TOKEN)].map((m) => ({ w: m[0], at: m.index!, end: m.index! + m[0].length }));
  const pickOf = (keep: (w: string) => boolean) => {
    const list = toks.filter((t) => keep(t.w));
    const out: string[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!;
      if (!out.length) { const before = text.slice(0, t.at); if (VERDICT_OF.test(before) || !DEPENDS.test(before)) out.push(t.w); continue; }
      if (LISTED.test(text.slice(list[i - 1]!.end, t.at))) out.push(t.w); else break;
    }
    return [...new Set(out)];
  };
  return { shas: pickOf(isSha), branches: pickOf(isBranch) };
}

// A report read into its marks, and, when it is a JSON verdict, that verdict. Free prose decides nothing,
// nor does a mark in a quote, a code block or a sentence about one ("we cannot say LAND: yes until ...").
export function readReport(report: string | null | undefined): ReportRead {
  const text = (report ?? "").trim();
  if (!text) return { marks: [], verdict: "unclear", line: "" };
  const json = /^```(?:json)?\s*([\s\S]*?)```$/.exec(text)?.[1] ?? (text.startsWith("{") ? text : undefined);
  if (json) {
    try {
      const v = JSON.parse(json) as Record<string, unknown>;
      const keys = Object.keys(v);
      for (const k of ["land", "verdict", "approved", "decision", "recommendation", "status", "result"]) {
        const got = v[k];
        if ((k === "status" || k === "result") && keys.length !== 1) continue;
        if (typeof got === "string" || typeof got === "boolean") {
          const line = clip(`${k}: ${String(got)}${typeof v.summary === "string" ? ` · ${v.summary}` : ""}`);
          return { marks: [], verdict: typeof got === "boolean" ? (got ? "approved" : "refused") : classify(String(got)), line };
        }
      }
      return { marks: [], verdict: "unclear", line: "" };
    } catch {}
  }
  const marks: LandMark[] = [];
  let section: { shas: string[]; branches: string[] } = { shas: [], branches: [] };
  let fence = false, part = 0;
  for (const raw of text.split("\n").slice(0, 2000)) {
    const t = raw.trim();
    if (/^(?:```|~~~)/.test(t)) { fence = !fence; continue; }
    if (fence || t.startsWith(">")) continue;
    if (EARLIER.test(t)) { part = 1; section = { shas: [], branches: [] }; continue; }
    const l = plain(raw);
    if (!l) continue;
    if (/^#/.test(t)) section = subjectsOf(l);
    const found = [...l.matchAll(LAND)];
    if (!found.length) {
      const lab = LABEL.exec(l);
      const value = lab ? l.slice(lab[0].length).trim() : "";
      if (lab && value && opensVerdict(l.slice(0, lab.index))) {
        const own = subjectsOf(value);
        const subj = own.shas.length || own.branches.length ? own : section;
        marks.push({ verdict: classify(value) as LandMark["verdict"], ...subj, line: clip(l), part });
      }
      continue;
    }
    const first = found[0]!;
    if (!opensVerdict(l.slice(0, first.index))) continue;
    // The line's verdicts in order: each LAND, and each "yes for" or "no on" after one; each holds the text
    // up to the next, and the first the text before it too.
    const at: { verdict: LandMark["verdict"]; from: number; word: number }[] = [];
    for (const m of found) {
      at.push({ verdict: m[1]!.toLowerCase() === "yes" ? "approved" : "refused", from: m.index!, word: m.index! + m[0].length });
      const next = found.find((x) => x.index! > m.index!)?.index ?? l.length;
      for (const a of l.slice(m.index! + m[0].length, next).matchAll(AGAIN)) {
        const from = m.index! + m[0].length + a.index!;
        at.push({ verdict: a[1]!.toLowerCase() === "yes" ? "approved" : "refused", from, word: from + a[0].length });
      }
    }
    at.sort((x, y) => x.from - y.from);
    const line = clip(l);
    const parts = at.map((x, i) => {
      const end = at[i + 1]?.from ?? l.length;
      const after = l.slice(x.word, end);
      // "LAND: yes/no" is a template; a yes with a condition in its clause ("yes, but only if") is not a yes.
      const template = /^\s*(?:\/|\||or\b)\s*(?:LAND\s*:\s*)?(?:yes|no)\b/i.test(after);
      const clause = after.split(/[.;!](?:\s|$)/)[0] ?? "";
      const verdict: LandMark["verdict"] = template ? "unclear" : x.verdict === "approved" && (holds(clause) || /^\W*(?:not|n't)\b/i.test(clause)) ? "unclear" : x.verdict;
      // A later sentence of the line that holds a commit ("d9483a49 can only land once c121c2af does")
      // leaves that commit's yes unsure (the sentence's subject, not what it waits for).
      const doubted = verdict === "approved" ? after.split(/[.;!](?:\s|$)/).slice(1).flatMap((x) => x.split(/,\s+(?:and|but|while)\s+/)).filter((x) => holds(x) || /\b(?:not|cannot|can'?t)\b/i.test(x)).flatMap((x) => subjectsOf(x).shas.length ? subjectsOf(x).shas : [SELF]) : [];
      return { verdict, doubted, ...subjectsOf(i === 0 ? l.slice(0, end) : after) };
    });
    const bare = (p: { shas: string[]; branches: string[] }) => !p.shas.length && !p.branches.length;
    // Verdicts that disagree on one line with one of them said of nothing ("LAND: yes or LAND: no",
    // "LAND: yes ... wait, LAND: no"): the line says nothing sure.
    if (new Set(parts.map((p) => p.verdict)).size > 1 && parts.some(bare)) {
      const own = parts.find((p) => !bare(p));
      marks.push({ verdict: "unclear", ...(own ?? section), line, part });
    } else {
      for (const p of parts) {
        const subj = bare(p) && parts.length === 1 ? section : p;
        // (A later sentence that holds and names no commit of its own speaks of this mark's: "it lands with that fix on top".)
        const self = p.doubted.includes(SELF);
        const others = [...new Set(p.doubted.filter((x) => x !== SELF))];
        marks.push({ verdict: self ? "unclear" : p.verdict, shas: subj.shas, branches: subj.branches, line, part });
        if (others.length) marks.push({ verdict: "unclear", shas: others, branches: [], line, part });
      }
    }
    if (marks.length >= 200) break;
  }
  return { marks, verdict: "unclear", line: marks.length ? "" : clip(plain(text.split("\n").find((l) => plain(l)) ?? "")) };
}

// The verdict a read report gives a row, and what it was said of: `head`, a mark that names the row's
// head; `other`, one that names another commit (the head the reviewer started on, or one at a branch);
// `unnamed`, a mark said of the branch or of nothing (what the reviewer started on decides then).
// The newest final decides when it says anything of this row, else the earlier ones. In a part, the marks
// that name the head decide, else the ones that name the head the reviewer started on, else the ones that
// name the branch, else the ones that name nothing; marks said of nothing join each of these. Marks that
// disagree are mixed; a refusal with an unsure mark refuses; an approval with one is unclear.
// `others`: the other branches the same reviewer reviews; a mark that names one of them is its.
export type VerdictAsk = { head?: string | null; tip?: string | null; branch?: string | null; others?: ReadonlySet<string> };
export type VerdictRead = { verdict: Verdict; line: string; of: "head" | "other" | "unnamed"; sha?: string };
function settle(ms: LandMark[]): { verdict: Verdict; line: string } {
  const refused = ms.find((m) => m.verdict === "refused"), approved = ms.find((m) => m.verdict === "approved"), unclear = ms.find((m) => m.verdict === "unclear");
  if (refused && approved) return { verdict: "mixed", line: refused.line };
  if (refused) return { verdict: "refused", line: refused.line };
  if (unclear) return { verdict: "unclear", line: unclear.line };
  return { verdict: "approved", line: approved!.line };
}
export function verdictFor(r: ReportRead, o: VerdictAsk = {}): VerdictRead {
  if (!r.marks.length) return { verdict: r.verdict, line: r.line, of: "unnamed" };
  const names = (m: LandMark, h: string) => m.shas.some((s) => h.startsWith(s));
  const bare = (m: LandMark) => !m.shas.length && !m.branches.length;
  for (const part of [0, 1]) {
    const ms = r.marks.filter((m) => m.part === part);
    if (!ms.length) continue;
    const bares = ms.filter(bare);
    if (o.head) {
      const hm = ms.filter((m) => names(m, o.head!));
      if (hm.length) return { ...settle([...hm, ...bares]), of: "head" };
    }
    if (o.tip && o.tip !== o.head) {
      const tm = ms.filter((m) => names(m, o.tip!));
      if (tm.length) return { ...settle([...tm, ...bares]), of: "other", sha: o.tip };
    }
    if (o.branch) {
      const bm = ms.filter((m) => m.branches.includes(o.branch!));
      if (bm.length) {
        const sha = bm.find((m) => m.shas.length)?.shas[0];
        return { ...settle([...bm, ...bares]), of: sha ? "other" : "unnamed", ...(sha ? { sha } : {}) };
      }
    }
    if (bares.length) return { ...settle(bares), of: "unnamed" };
  }
  const words = new Set(r.marks.filter((m) => m.verdict !== "unclear" && !m.branches.some((b) => o.others?.has(b))).map((m) => m.verdict));
  const named = [...new Set(r.marks.flatMap((m) => m.shas.map((s) => s.slice(0, 9))))].slice(0, 4).join(", ");
  return { verdict: words.size > 1 ? "mixed" : "unclear", line: clip(`LAND said of other commits (${named || "other branches"}), not this head`), of: "unnamed" };
}

export function verdictOf(report: string | null | undefined, o: VerdictAsk = {}) {
  return verdictFor(readReport(report), o);
}

// The review a row shows. Never one by the row's agent or an agent below it (a builder cannot review its
// own work: `chain`, the reviewer's sessions up to the root, read from the agents table; a review whose
// chain is not known is not shown), and from an agent with a branch of its own (found by its task naming
// the branch) only when it ended and a mark decided. A review of another head than the row's is stale,
// whatever it said; an approval whose reviewed head is not known is unclear. Reviews of the row's head
// come first, then the newest.
export function pickReview(reviews: readonly ReviewFact[], row: { id: string; session_id: string; branch: string | null; head: string | null }): BoardReview | undefined {
  const out = reviews
    .filter((x) => x.branch === row.branch && x.by !== row.id && (x.how === "panel" || (!!x.chain && !x.chain.includes(row.session_id))))
    .map((x) => {
      const running = x.state === "running" || x.state === "waiting";
      const others = new Set(reviews.filter((y) => y.by === x.by && y.branch !== row.branch).map((y) => y.branch));
      const r: VerdictRead = running ? { verdict: "pending", line: "", of: "unnamed" } : verdictFor(x.read, { head: row.head, tip: x.tip, branch: row.branch, others });
      const current = r.of === "head" ? true : r.of === "other" ? false : x.tip && row.head ? x.tip === row.head : null;
      return { x, r, current };
    })
    .filter(({ x, r }) => !(x.how === "task" && x.own && !["approved", "refused", "mixed"].includes(r.verdict)))
    .sort((a, b) => Number(b.current === true) - Number(a.current === true) || b.x.at - a.x.at)[0];
  if (!out) return undefined;
  const { x, r, current } = out;
  const doubt = r.verdict !== "pending" && (current === false || (current === null && r.verdict === "approved"));
  const verdict: Verdict = !doubt ? r.verdict : current === false ? "stale" : "unclear";
  return {
    by: x.by, title: x.title, how: x.how, state: x.state, verdict, ...(doubt ? { was: r.verdict } : {}), line: r.line,
    tip: x.tip, of: r.of === "other" ? r.sha ?? x.tip : r.of === "head" ? row.head : x.tip, current, at: x.at,
  };
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
  const head = v.current === false && v.verdict !== "stale" ? `, of an older head ${short(v.tip)}` : "";
  const words = v.verdict === "pending" ? "running"
    : v.verdict === "stale" ? `stale (${v.was ?? "said"} of ${short(v.of ?? v.tip)}, not its head now)`
    : v.verdict === "unclear" && v.was ? `unclear (${v.was} of a head not known)` : v.verdict;
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

// A finished agent whose branch and worktree are gone (removed at its end: it kept no commit, or its
// work was taken): nothing of it is left to land.
export const branchGone = (r: BoardRow) => !!r.branch && !r.head && r.worktree === "gone" && !live(r.state);
// Work a coordinator still owes a landing: a branch not landed, or one git could not read.
export const toLand = (r: BoardRow) => !!r.landed && r.landed.state !== "yes" && r.landed.state !== "nothing" && !branchGone(r);

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
