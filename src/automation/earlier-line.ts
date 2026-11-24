// What an earlier agent's line says in a new spawn's result: how its work ended, from facts only (its
// status, its branch against the base, the landing queue, a reviewer's structured verdict or the Review
// panel's), and the first line of its own report, quoted. Pure: src/automation/earlier.ts reads the facts.

export type Ended = {
  status: string;                 // the agent's status
  stopped_by?: string | null;     // who stopped it, in words (the agent record's)
  end_reason?: string | null;     // why its turn ended, in words
  branch: string | null;
  tip: string | null;             // the branch's head now; null: the branch is gone
  noWork: boolean;                // the branch has no commit of its own
  remote?: boolean;               // it worked on another machine: its branch is not read here
  landed: boolean;                // the base holds its head (or the landing queue landed it)
  review?: { land: boolean; class: string } | null; // the newest structured verdict on the branch, or the panel's
};

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// A finding's class, the way the Review panel names it: its priority and its title.
export const findingClass = (priority: number | null | undefined, title: string | null | undefined) =>
  clip(`${priority === null || priority === undefined ? "unrated" : `P${priority}`}${title ? `: ${title.replace(/\s+/g, " ").trim()}` : ""}`, 90);

// A reviewer's refusal in its own words: its first sentence.
export const sayClass = (why: string) => {
  const one = why.replace(/\s+/g, " ").trim();
  const stop = one.search(/[.!?](\s|$)/);
  return clip(stop >= 12 ? one.slice(0, stop) : one, 90);
};

export function outcome(f: Ended): string {
  if (f.status === "running" || f.status === "waiting") return "working now";
  if (f.landed) return "landed";
  if (f.review && !f.review.land) return `refused by review (${f.review.class})`;
  if (f.status === "stopped") return `abandoned (${f.stopped_by ?? "stopped"})`;
  if (f.status === "failed" || f.status === "incomplete") return `abandoned (${f.end_reason ?? f.status})`;
  const approved = f.review?.land ? "approved by review, " : "";
  if (f.remote && f.branch) return `${approved}finished on another machine (its branch is not read here)`;
  if (!f.branch || f.noWork) return "answered, no commits";
  return f.tip ? `${approved}finished, not landed` : `${approved}finished, its branch is gone and its head is not on the base`;
}

// The first line of a report that says something: not a heading's marks, not the harness's own lines.
export function firstLine(report: string | null | undefined, max = 110): string {
  for (const raw of (report ?? "").split("\n").slice(0, 40)) {
    const l = raw.replace(/^[\s#>*_`|-]+/, "").replace(/[*_`]+/g, "").trim();
    if (l.length < 4 || /^earlier reports\b/i.test(l) || /^(?:report|result|summary|done)\s*:?$/i.test(l)) continue;
    return clip(l, max);
  }
  return "";
}

export type Shown = { id: string; title: string; branch: string | null; head: string | null; ended: Ended; report: string };

export const HEADER = "Earlier agents on the same ground in this repository, closest first (the outcomes are Keel's facts; the quoted line is the agent's own words). Do not redo what landed or repeat what a review refused:";

export function lineOf(s: Shown): string {
  const where = s.branch ? `; branch ${s.branch}${s.head ? ` @${s.head}` : ""}` : "";
  const said = firstLine(s.report);
  return `- ${clip(s.title.replace(/\s+/g, " "), 60)} (agent ${s.id}): ${outcome(s.ended)}${where}${said ? `. Report: "${said}"` : ""}`;
}

export const noteOf = (shown: readonly Shown[]): string => (shown.length ? `\n\n${HEADER}\n${shown.map(lineOf).join("\n")}` : "");
