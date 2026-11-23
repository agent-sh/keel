// Independent review of a change: a read-only child session on a model the
// owner picks reads the diff (and the code around it with read-only tools) and
// answers with findings. The daemon reads the answer and stores it with the
// review; nothing is handed to the session's conversation until the owner
// sends findings back to the working model.
import { createHash } from "node:crypto";

export type ReviewKind = "code" | "security";
export type Scope = "uncommitted" | "branch" | "commit";
export type Finding = {
  id: number;
  file: string;
  line: number;
  end_line?: number;
  priority: 0 | 1 | 2 | 3 | null; // P0 blocks a release ... P3 nit; null: the reviewer gave none (unrated)
  confidence?: number;
  title: string;
  body: string;
  state: "open" | "dismissed" | "fix_requested";
  sent_to?: string; // who a fix request went to: the agent's title, or "the session"
};
export type Review = {
  id: string;
  session_id: string;
  child_id: string | null;
  kind: ReviewKind;
  scope: Scope;
  target: string;
  focus?: string;
  model: string;
  diff_sha256: string;
  from?: string;      // the two trees the review compared
  to?: string;
  committed?: string; // a review of uncommitted work: the commit that took that change whole, once one did
  files: number;
  state: "running" | "done" | "failed" | "stopped"; // stopped: the owner's Stop, not a failure
  error?: string;
  verdict?: "correct" | "incorrect";
  summary?: string;
  reading_order?: { section: string; why: string }[];
  findings: Finding[];
  created: number;
  ended?: number;
  agent_id?: string; // a review of one agent's work (its worktree branch)
  agent_title?: string;
  agent_branch?: string;
  cut?: boolean;      // the diff the reviewer got was cut to fit (it read the files for the rest, or not)
  rejected?: number;  // findings in the answer that could not be read
  rejected_why?: string[];
  omitted?: number;   // readable findings past the stored cap (the lowest priorities)
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, child_id TEXT, state TEXT NOT NULL, diff_sha TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_session ON reviews(session_id, created);
CREATE INDEX IF NOT EXISTS reviews_child ON reviews(child_id);
`;

// The same change on the same reviewer: the two trees it compares (the whole
// change, not the preview cut to fit), the kind, the focus and the model.
export const reviewKey = (o: { from: string; to: string; kind: ReviewKind; focus?: string; model: string }) =>
  createHash("sha256").update([o.kind, o.focus ?? "", o.model, o.from, o.to].join("\n")).digest("hex");

export const priorityLabel = (p: Finding["priority"]) => (p === null ? "unrated" : `P${p}`);
const rank = (p: Finding["priority"]) => (p === null ? 4 : p);
const MAX_FINDINGS = 100;

const RUBRIC: Record<ReviewKind, string> = {
  code: [
    "Flag only discrete, actionable problems that this change introduces and that its author would fix once told: bugs, broken edge cases, wrong error handling, races, data loss, security holes, a contract the change breaks.",
    "Do not flag style, naming, formatting, missing tests or docs, or problems that were there before the change, unless the change makes them worse.",
    "Each finding names the exact place (file and the changed line it is about) and says what goes wrong, when, and why. When an instruction file of the repository (AGENTS.md, CLAUDE.md) sets a rule the change breaks, quote the rule.",
    "Priority: 0 breaks something for everyone or loses data; 1 a real bug to fix before merging; 2 a bug in a rare case or a fragile spot; 3 a minor issue.",
    "No findings is a fine answer for a correct change.",
  ].join("\n"),
  security: [
    "Review only for security problems this change introduces: injection (shell, SQL, path traversal, template, deserialization), authentication and authorization gaps, secrets or credentials exposed, unsafe cryptography, code execution, sensitive data written to logs or sent out.",
    "Report a finding only when you are over 80% sure it is exploitable, with a concrete way it is reached. Do not report denial of service, rate limits, resource exhaustion, open redirects, memory safety outside C or C++, or theoretical issues without a path from input.",
    "Priority: 0 remote code execution, data theft or an authorization bypass reachable from outside; 1 exploitable with some conditions; 2 needs unusual conditions; 3 hardening.",
    "No findings is a fine answer.",
  ].join("\n"),
};

// `what`: the change in words when it is not one of the scopes (a pull request).
export function reviewTask(o: { kind: ReviewKind; scope: Scope; target: string; focus?: string; diff: string; cut: boolean; files: { path: string; status: string }[]; what?: string }): string {
  const what = o.what ?? (o.scope === "uncommitted" ? "the uncommitted work (tracked and untracked files) over HEAD"
    : o.scope === "branch" ? `the branch over its merge base with ${o.target}` : `commit ${o.target}`);
  return [
    `You are an independent reviewer. Review ${what} in this repository. You have read-only tools: read files, search, and run commands that change nothing, to check the code around the diff. Do not change anything.`,
    RUBRIC[o.kind],
    o.focus ? `The owner asks you to focus on: ${o.focus}` : "",
    `Changed files (${o.files.length}):\n${o.files.slice(0, 200).map((f) => `${f.status}\t${f.path}`).join("\n")}`,
    `The diff${o.cut ? " (cut to fit; read the files for the rest)" : ""}:\n\`\`\`diff\n${o.diff}\n\`\`\``,
    [
      "When you are done, answer with one JSON object in a ```json fence and nothing after it:",
      '{"findings":[{"file":"path/relative/to/repo","line":12,"end_line":14,"priority":1,"confidence":0.8,"title":"short, under 80 characters","body":"what goes wrong, when, and why; how to fix it"}],',
      ' "verdict":"correct" or "incorrect", "summary":"two sentences on the change and its main risk",',
      ' "reading_order":[{"section":"file or area","why":"one sentence"}]}',
      "reading_order is for a change of more than three files: the order a person should read it in, core changes first; otherwise an empty list.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

// The reviewer's answer: the last JSON object in its reply.
// Findings sorted by priority before any cap (a P0 at position 51 is kept);
// an entry that cannot be read is counted with why, and an answer whose
// findings are all unreadable is not "no findings".
export function parseAnswer(text: string): Pick<Review, "findings" | "verdict" | "summary" | "reading_order" | "rejected" | "rejected_why" | "omitted"> {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fences.length ? fences.reverse() : [text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  let obj: any = null;
  for (const c of candidates) {
    try { obj = JSON.parse(c); break; } catch {}
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.findings)) throw new Error("the reviewer's answer is not the findings asked for");
  const why = new Set<string>();
  const good = obj.findings.filter((f: any) => {
    if (!f || typeof f !== "object") return why.add("not an object"), false;
    if (typeof f.file !== "string" || !f.file) return why.add("no file"), false;
    if (typeof f.title !== "string" && typeof f.body !== "string") return why.add("no title or body"), false;
    return true;
  });
  const rejected = obj.findings.length - good.length;
  if (obj.findings.length && !good.length) throw new Error(`the reviewer reported ${obj.findings.length} finding${obj.findings.length === 1 ? "" : "s"} that could not be read (${[...why].join(", ")})`);
  const all: Finding[] = good
    .map((f: any) => ({
      id: 0,
      file: String(f.file).replace(/^\.\//, ""),
      line: Math.max(1, Math.floor(Number(f.line) || 1)),
      end_line: Number(f.end_line) > Number(f.line) ? Math.floor(Number(f.end_line)) : undefined,
      // Only a number 0 to 3 is a priority: omitted, null or anything else is unrated.
      priority: (typeof f.priority === "number" && [0, 1, 2, 3].includes(f.priority) ? f.priority : null) as Finding["priority"],
      confidence: Number.isFinite(Number(f.confidence)) && f.confidence !== null ? Math.min(1, Math.max(0, Number(f.confidence))) : undefined,
      title: String(f.title ?? f.body).slice(0, 160),
      body: String(f.body ?? "").slice(0, 4000),
      state: "open" as const,
    }))
    .sort((a: Finding, b: Finding) => rank(a.priority) - rank(b.priority));
  const findings = all.slice(0, MAX_FINDINGS).map((f, i) => ({ ...f, id: i + 1 }));
  return {
    findings,
    ...(rejected ? { rejected, rejected_why: [...why] } : {}),
    ...(all.length > MAX_FINDINGS ? { omitted: all.length - MAX_FINDINGS } : {}),
    verdict: obj.verdict === "correct" || obj.verdict === "incorrect" ? obj.verdict : undefined,
    summary: typeof obj.summary === "string" ? obj.summary.slice(0, 1000) : undefined,
    reading_order: Array.isArray(obj.reading_order)
      ? obj.reading_order.filter((r: any) => r && typeof r.section === "string").slice(0, 20).map((r: any) => ({ section: String(r.section).slice(0, 200), why: String(r.why ?? "").slice(0, 300) }))
      : undefined,
  };
}

// The prompt that sends chosen findings to the working model.
export function fixPrompt(r: Review, chosen: Finding[]): string {
  const lines = chosen.map((f) => `- [${priorityLabel(f.priority)}] ${f.file}:${f.line}${f.end_line ? `-${f.end_line}` : ""}: ${f.title}${f.body ? `\n  ${f.body.replace(/\n/g, "\n  ")}` : ""}`);
  return [
    `An independent ${r.kind === "security" ? "security " : ""}review of ${r.scope === "commit" ? `commit ${r.target}` : r.scope === "branch" ? `the branch over ${r.target}` : r.committed ? `the work since committed as ${r.committed}` : "the uncommitted work"} found ${chosen.length === 1 ? "this" : "these"}:`,
    lines.join("\n"),
    "Check each against the code first: fix the ones that hold, and say in one line why for any you leave.",
  ].join("\n\n");
}
