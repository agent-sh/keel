// Pull request reviews from GitHub events: the decisions that need no network,
// no database and no clock of their own. The watcher (watch.ts) feeds them
// what GitHub answered and acts on what they say.
import type { Finding, Review } from "../safety/review.ts";

// ---- repositories and triggers ----

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;
// "owner/name", the way GitHub writes it, or null.
export function parseRepo(s: string): string | null {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/.exec(s);
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!) || m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

export const DEFAULT_TRIGGER = "@keel review";

// A comment asks for a review when its first line starts with the trigger, in
// any case, followed by the line's end or a space (the hosted reviewers read
// their commands so: Claude Code Review's "Put the whole command on one line
// at the start of the comment").
export function asksReview(body: string, trigger: string): boolean {
  const t = trigger.trim().toLowerCase();
  if (!t) return false;
  const first = (body ?? "").replace(/^\uFEFF/, "").trimStart().split(/\r?\n/, 1)[0]!.toLowerCase();
  return first.startsWith(t) && (first.length === t.length || /\s/.test(first[t.length]!));
}

// Who may start a review with a comment: people with write access, as
// GitHub's author_association says it. On a public repository anyone can
// comment, and a review costs the owner a model's tokens.
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// ---- pacing ----

// GitHub's polling endpoints state how often they may be asked
// (X-Poll-Interval, seconds; "Please obey the header"); 60 is the value its
// docs show, used when an endpoint states none.
export const DEFAULT_POLL_S = 60;
// A 404 or a 401 on a poll: GitHub asks to "wait much longer before you check again".
export const LONG_WAIT_S = 30 * 60;

export type Paced = { next_ms: number; why?: string; backoff?: number };
// When the next poll of a repository may go, from the answer of this one.
// `backoff` counts secondary-limit refusals in a row (doubles the wait).
export function pace(status: number, h: Headers, now: number, backoff = 0): Paced {
  const stated = Number(h.get("x-poll-interval"));
  const interval = Number.isFinite(stated) && stated > 0 ? stated : DEFAULT_POLL_S;
  const retry = Number(h.get("retry-after"));
  const remaining = h.get("x-ratelimit-remaining");
  const reset = Number(h.get("x-ratelimit-reset"));
  // "If the retry-after response header is present, you should not retry your request until after that many seconds has elapsed."
  if (Number.isFinite(retry) && retry > 0 && (status === 403 || status === 429 || status >= 500))
    return { next_ms: now + Math.max(retry, interval) * 1000, why: `GitHub asked to wait ${Math.round(retry)} s`, backoff: backoff + 1 };
  // "If the x-ratelimit-remaining header is 0, you should not make another request until after ... x-ratelimit-reset."
  if (remaining === "0" && Number.isFinite(reset) && reset * 1000 > now)
    return { next_ms: Math.max(reset * 1000, now + interval * 1000), why: `the hourly request limit is used up until ${new Date(reset * 1000).toISOString().slice(11, 16)} UTC` };
  // "Otherwise, wait for at least one minute before retrying ... an exponentially increasing amount of time."
  if (status === 403 || status === 429) {
    const s = Math.min(3600, 60 * 2 ** backoff);
    return { next_ms: now + Math.max(s, interval) * 1000, why: `GitHub refused the request (${status}): waiting ${Math.round(Math.max(s, interval) / 60)} min`, backoff: backoff + 1 };
  }
  if (status === 401) return { next_ms: now + LONG_WAIT_S * 1000, why: "GitHub did not take the credentials (401)" };
  if (status === 404) return { next_ms: now + LONG_WAIT_S * 1000, why: "GitHub has no such repository for these credentials (404)" };
  if (status >= 500) return { next_ms: now + Math.max(interval, 60) * 1000, why: `GitHub answered ${status}` };
  return { next_ms: now + interval * 1000 };
}

// The next page of a list, from its Link header.
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

// ---- what to review ----

export type Pull = { number: number; head: string; draft: boolean; title: string; base: string; url: string; author: string; clone_url: string };
export function readPull(p: any): Pull | null {
  if (!p || typeof p.number !== "number" || typeof p.head?.sha !== "string" || !/^[0-9a-f]{40}$/.test(p.head.sha)) return null;
  return {
    number: p.number, head: p.head.sha, draft: !!p.draft, title: String(p.title ?? "").slice(0, 200), base: String(p.base?.ref ?? ""),
    url: String(p.html_url ?? ""), author: String(p.user?.login ?? ""), clone_url: String(p.base?.repo?.clone_url ?? ""),
  };
}

// The heads to review in one listing of open pull requests: a pull request
// whose head is not the one seen before. A draft is not reviewed by itself
// (Claude Code Review and Bugbot skip drafts too); a comment asks for one.
// `seen`: number -> the head seen last. `first`: the listing right after the
// repository was added, whose heads are only remembered: what was open before
// the owner asked is not reviewed unless asked for.
export function newHeads(pulls: Pull[], seen: Map<number, string>, first: boolean): Pull[] {
  if (first) return [];
  return pulls.filter((p) => !p.draft && seen.get(p.number) !== p.head);
}

export type Comment = { id: number; pr: number | null; body: string; association: string; author: string; url: string };
export function readComment(c: any): Comment | null {
  if (!c || typeof c.id !== "number") return null;
  const m = /\/issues\/(\d+)$/.exec(String(c.issue_url ?? "")) ?? /\/pull\/(\d+)#/.exec(String(c.html_url ?? ""));
  return { id: c.id, pr: m ? Number(m[1]) : null, body: String(c.body ?? ""), association: String(c.author_association ?? ""), author: String(c.user?.login ?? ""), url: String(c.html_url ?? "") };
}

// The comments of one listing (newest first) that are new since `after` (the
// newest id handled), and whether the listing reached `after` (else the next
// page has more new ones).
export function freshComments(list: Comment[], after: number): { fresh: Comment[]; reached: boolean } {
  const fresh = list.filter((c) => c.id > after);
  return { fresh, reached: fresh.length < list.length || list.length === 0 };
}

// ---- posting ----

// The lines of each file a review comment may be put on: the new side of
// every hunk of the diff (added lines and the context around them). GitHub
// refuses a comment on a line outside them ("could not be resolved").
export type Lines = Record<string, [number, number][]>;
export function commentable(diff: string): Lines {
  const out: Lines = {};
  let file: string | null = null;
  let line = 0;
  let run: [number, number] | null = null;
  const close = () => { if (file && run) (out[file] ??= []).push(run); run = null; };
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) { close(); file = null; continue; }
    if (l.startsWith("+++ ")) { close(); const p = l.slice(4).trim(); file = p === "/dev/null" ? null : p.replace(/^b\//, ""); continue; }
    if (l.startsWith("--- ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { close(); line = Number(h[1]); continue; }
    if (!file || !line) continue;
    if (l.startsWith("-")) continue; // the old side only
    if (l.startsWith("+") || l.startsWith(" ")) {
      if (run && run[1] === line - 1) run[1] = line;
      else { close(); run = [line, line]; }
      line++;
    } else if (l.startsWith("\\")) continue;
  }
  close();
  return out;
}

const onLines = (lines: Lines, file: string, a: number, b = a) => (lines[file] ?? []).some(([s, e]) => a >= s && b <= e);

const PRIORITY = ["P0", "P1", "P2", "P3"];
const label = (f: Finding) => (f.priority === null ? "" : `**${PRIORITY[f.priority]}** `);

// The review GitHub gets: a COMMENT review (never an approval or a request
// for changes: the decision stays with the people, as the hosted reviewers
// do), each finding on its lines when they are in the diff, the others in the
// body with their place.
export function reviewBody(r: Pick<Review, "findings" | "summary" | "verdict">, lines: Lines, head: string): { event: "COMMENT"; commit_id: string; body: string; comments: { path: string; line: number; start_line?: number; side: "RIGHT"; start_side?: "RIGHT"; body: string }[] } {
  const open = r.findings.filter((f) => f.state !== "dismissed");
  const inline = open.filter((f) => onLines(lines, f.file, f.line, f.end_line ?? f.line));
  const rest = open.filter((f) => !inline.includes(f));
  const verdict = r.verdict === "correct" ? "Looks correct." : r.verdict === "incorrect" ? "Has problems." : "";
  const head7 = head.slice(0, 7);
  const body = [
    `Review by Keel of ${head7}. ${open.length ? `${open.length} finding${open.length === 1 ? "" : "s"}${inline.length && rest.length ? `, ${inline.length} on the lines` : ""}.` : "No findings."}${verdict ? ` ${verdict}` : ""}`,
    r.summary ?? "",
    rest.length ? rest.map((f) => `- ${label(f)}\`${f.file}:${f.line}${f.end_line ? `-${f.end_line}` : ""}\` ${f.title}${f.body ? `\n  ${f.body.replace(/\n/g, "\n  ")}` : ""}`).join("\n") : "",
  ].filter(Boolean).join("\n\n");
  return {
    event: "COMMENT",
    commit_id: head,
    body,
    comments: inline.map((f) => ({
      path: f.file,
      line: f.end_line ?? f.line,
      ...(f.end_line && f.end_line > f.line ? { start_line: f.line, start_side: "RIGHT" as const } : {}),
      side: "RIGHT" as const,
      body: `${label(f)}${f.title}${f.body ? `\n\n${f.body}` : ""}`,
    })),
  };
}
