// A queued branch that conflicts with the base is rebased by its own agent,
// the pure part: where the conflict is in the base's own lines, the task the
// agent is sent, and what follows when its turn ends. The queue that finds the
// conflict and sends the task is src/landing/queue.ts; the agent it reaches is
// found by src/server/routes/landing.ts.
//
// The field: Amp, Devin and Copilot's agents resolve a conflict a rebase meets
// and ask only for a substantive one; Cursor's stack commands name the branch,
// the new base, the commit being applied and the files, and never throw away a
// rebase in progress that they did not start. Keel does the same: the task
// names all of that, and Keel runs no `rebase --abort` in an agent's worktree.

// How many rebase tasks an entry gets before it goes to the session that started its agent.
export const TRIES = 2;
// The word an agent ends its report with when the two sides want different things.
export const SUBSTANTIVE = "Conflict: substantive";

// A conflicted file and the base's lines the conflict covers there: [first, last]
// (last < first: the base has no line there; the branch adds after `last`).
export type ConflictAt = { path: string; lines: [number, number][] };
// Where a rebase of the branch onto the base stops.
export type Stop = { commit?: { sha: string; subject: string }; files: ConflictAt[] };

// The base's lines a file's conflicts cover, read from the file as git left it
// in a rebase: between `<<<<<<<` and `|||||||` (diff3) or `=======` is the side
// being rebased onto, which is the base. Lines outside the markers are the base's too.
export function baseLines(text: string): [number, number][] {
  const out: [number, number][] = [];
  let at = 0; // the base's lines seen so far
  let side: "out" | "ours" | "parent" | "theirs" = "out";
  let start = 0;
  const marker = (l: string, m: string) => l === m || l.startsWith(`${m} `);
  for (const l of text.split("\n")) {
    if (side === "out") {
      if (marker(l, "<<<<<<<")) { side = "ours"; start = at + 1; continue; }
      at++;
    } else if (side === "ours") {
      if (marker(l, "|||||||")) { side = "parent"; out.push([start, at]); continue; }
      if (l === "=======") { side = "theirs"; out.push([start, at]); continue; }
      at++;
    } else if (side === "parent") {
      if (l === "=======") side = "theirs";
    } else if (marker(l, ">>>>>>>")) side = "out";
  }
  return out;
}

// Lines as they are said: "5", "5-9", "after 4" for a place the base has no line.
export const linesSay = (ls: [number, number][]) => ls.map(([a, b]) => (b < a ? `after ${b}` : a === b ? `${a}` : `${a}-${b}`)).join(", ");

export type Task = {
  branch: string; tip: string; base: string; baseTip: string; baseSubject: string;
  stop: Stop; try: number; method: "rebase" | "merge"; checks: string[];
  // A rebase or merge is already in progress in the agent's worktree: it is left as it is.
  inProgress?: boolean;
  // The agent that made the branch is gone: a fresh one takes it over.
  fresh?: boolean;
};

const short = (sha: string) => sha.slice(0, 9);
const MAX_FILES = 12;

// The task an agent is sent: what conflicts where, the commands that settle
// it, and what to say when it cannot be settled without a decision.
export function rebaseTask(t: Task): string {
  const op = t.method === "merge" ? "merge" : "rebase";
  const files = t.stop.files.slice(0, MAX_FILES).map((f) => `  - ${f.path}${f.lines.length ? `: ${t.base}'s lines ${linesSay(f.lines)}` : ""}`);
  if (t.stop.files.length > MAX_FILES) files.push(`  - and ${t.stop.files.length - MAX_FILES} more files`);
  const lines = [
    `[harness] Landing queue: your branch ${t.branch} conflicts with ${t.base}, so it cannot land. Settle the conflict on the branch (try ${t.try} of ${TRIES}).`,
    ...(t.fresh ? [`The agent that made ${t.branch} is gone: you take over its branch, checked out in your worktree.`] : []),
    `- Branch: ${t.branch} at ${short(t.tip)}. ${t.base} is now at ${short(t.baseTip)} (${t.baseSubject}).`,
    ...(t.stop.commit ? [`- A ${op} onto ${t.base} stops at ${short(t.stop.commit.sha)} (${t.stop.commit.subject}).`] : []),
    `- Conflicts${t.stop.files.length ? ", with the lines as " + t.base + " has them:" : ": git names no file (a rename or a deleted folder)."}`,
    ...files,
    "Steps, in your worktree:",
    t.inProgress
      ? `1. A rebase or merge is already in progress in your worktree, and Keel did not start it: it is left as it is. Finish it (git status says where it stands), or end it yourself if you started it. Do not run git rebase --abort or git merge --abort on one you did not start.`
      : t.method === "merge" ? `1. git merge ${t.base}` : `1. git rebase ${t.base}`,
    `2. In each conflicted file keep what both sides meant, then git add the file and ${t.method === "merge" ? "git commit --no-edit" : "GIT_EDITOR=true git rebase --continue"}, until git says it is done.`,
    `3. Run ${t.checks.length ? `the repository's checks (${t.checks.join(", ")})` : "the repository's checks"} and fix what fails, in commits on the branch.`,
    "4. End your turn with a short report. Keel then queues the branch again and checks the exact tree that would land.",
    `If the two sides want different things and you cannot keep both, do not pick one: end the ${op} you started (git ${op} --abort), leave the branch as it was, and end your report with the line "${SUBSTANTIVE}" followed by what must be decided. It then goes to the session that started you.`,
  ];
  return lines.join("\n");
}

// Whether a report calls the conflict substantive, and what it says must be decided.
export function substantive(report: string): string | undefined {
  const at = report.toLowerCase().lastIndexOf(SUBSTANTIVE.toLowerCase());
  if (at < 0) return undefined;
  const after = report.slice(at + SUBSTANTIVE.length).replace(/^[\s.:,-]+/, "").replace(/\s+/g, " ").trim();
  return after.slice(0, 400) || "it did not say what must be decided";
}

// What the queue does when the agent's turn ends after a task:
//   queue   the branch moved and merges with the base: it goes back in the queue and is checked there;
//   again   another task, while tries remain;
//   parent  it goes to the session that started the agent, with why.
export type After = { kind: "queue" } | { kind: "again"; why: string } | { kind: "parent"; why: string };
export function afterTask(o: {
  status: string; // the agent's status at its end: completed, failed, stopped, incomplete
  report: string;
  before: string; // the branch's tip when the task was sent
  now: string | null; // its tip now; null: the branch is gone
  merges: boolean | null; // whether the tip merges clean with the base now (null: git could not tell)
  rebasing: boolean; // a rebase or merge is still in progress in its worktree
  tries: number; // tasks sent so far, this one counted
}): After {
  const said = substantive(o.report);
  if (said) return { kind: "parent", why: `its agent found the conflict substantive: ${said}` };
  if (o.now === null) return { kind: "parent", why: "the branch is gone" };
  if (o.status === "stopped") return { kind: "parent", why: "its agent was stopped before it settled the conflict" };
  const failed = o.rebasing ? "its agent left a rebase or merge in progress"
    : o.now === o.before ? `its agent did not move the branch${o.status !== "completed" ? ` (it ${o.status === "failed" ? "failed" : "did not finish"})` : ""}`
    : o.merges === false ? "it still conflicts after its agent's rebase"
    : undefined;
  if (!failed) return { kind: "queue" };
  return o.tries < TRIES ? { kind: "again", why: failed } : { kind: "parent", why: `${failed}, after ${o.tries} tries` };
}
