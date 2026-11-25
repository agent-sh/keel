// What landing an agent's branch needs, as the fixed lines under the "Its work is on branch" note of its
// report: the tip landed, how far the base moved past where it started, whether it merges with the base now
// (the overlap forecast's row, src/worktree/overlap-scan.ts), and which of the repository's named checks
// passed on its files as they are (the check ledger, src/checks/ledger.ts). Each fact is a line of its own
// that starts with the same words every time, so a coordinator reads it without parsing prose, and a fact
// that could not be read says so on its line instead of leaving the line out. Pure: facts in, text out.

export type BaseConflict =
  | { state: "clean" }
  | { state: "conflict"; files: string[] }
  | { state: "nothing" } // merged with the base, it changes nothing: its change is already there
  | { state: "unknown"; why: string };

export type ChecksOn =
  | ({ state: "known" } & OnTree)
  | { state: "unknown"; why: string }
  | { state: "none" }; // the repository names no checks

export type Landing = {
  base: string;              // the base it lands on, as named
  tip: string | null;        // the branch's commit
  behind: number | null;     // commits of the base its branch does not have; null: not counted
  dirty: number;             // uncommitted files: neither the merge nor the tip holds them
  conflict: BaseConflict;
  checks: ChecksOn;
};

// The same facts as fields of the agent's record (`landing` on GET /api/sessions/ID/agents and on its report's
// route), written by the harness when the agent ends: a line quoted in the agent's own words is never one of
// them. `ahead`: commits of the branch the base lacks; `landed`: the base holds all of them or its merge changes
// nothing (null: not known). `proof`: the proof line of the report (src/checks/proof.ts). At most FILES_KEPT
// conflicted files are kept.
export type AgentLanding = Landing & { branch: string; ahead: number | null; landed: boolean | null; proof: string };
export const FILES_KEPT = 50;

export const FILES_NAMED = 6; // conflicted files named on the line; the rest is a count

const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function conflictWords(l: Landing): string {
  const c = l.conflict;
  const commitsOnly = l.dirty ? ` (its commits only: ${count(l.dirty, "uncommitted file")} not in it)` : "";
  if (c.state === "clean") return `none, it merges clean${commitsOnly}`;
  if (c.state === "nothing") return `none, the base already has its change${commitsOnly}`;
  if (c.state === "unknown") return `not known (${c.why})`;
  if (!c.files.length) return `yes, in no file git names (a directory renamed on one side)${commitsOnly}`;
  const shown = c.files.slice(0, FILES_NAMED);
  const more = c.files.length - shown.length;
  return `yes, ${count(c.files.length, "file")}: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}${commitsOnly}`;
}

function checksWords(c: ChecksOn): string {
  if (c.state === "none") return "none named (the repository names no checks)";
  if (c.state === "unknown") return `not known (${c.why})`;
  const rest = [c.failed.length ? `failed: ${c.failed.join(", ")}` : "", c.notRun.length ? `not run: ${c.notRun.join(", ")}` : ""].filter(Boolean).join("; ");
  const head = c.passed.length ? c.passed.join(", ") : "none";
  return rest ? `${head} (${rest})` : head;
}

// The lines, each starting with "\n".
export function landingLines(l: Landing): string {
  return [
    `Tip: ${l.tip ?? "not known"}`,
    `Behind ${l.base}: ${l.behind === null ? "not known" : count(l.behind, "commit")}`,
    `Conflicts with ${l.base}: ${conflictWords(l)}`,
    `Checks passed on this tree: ${checksWords(l.checks)}`,
  ].map((x) => `\n${x}`).join("");
}

// The checks of a repository as they stand on one tree. A check is known by its name and the command it ran
// (a run with arguments of its own, such as one test file, checked part of it and is named with its command).
// The newest run that decided of each counts: a pass after a failure passed, a failure after a pass failed.
export const CMD_SHOWN = 60;
// `passed`, `failed`: labels; `notRun`: the named checks with no run that decided on the tree.
export type OnTree = { passed: string[]; failed: string[]; notRun: string[] };
export function checksOnTree(named: readonly { name: string; run: string }[], runs: readonly { name: string; command: string; result: string; ended: number }[]): OnTree {
  const own = new Map(named.map((c) => [c.name, c.run]));
  const last = new Map<string, { label: string; result: string }>();
  for (const r of [...runs].sort((a, b) => b.ended - a.ended)) {
    if ((r.result !== "pass" && r.result !== "fail") || !own.has(r.name)) continue;
    const k = `${r.name}\n${r.command}`;
    if (last.has(k)) continue;
    const cmd = r.command.length > CMD_SHOWN ? `${r.command.slice(0, CMD_SHOWN - 1)}…` : r.command;
    last.set(k, { label: r.command === own.get(r.name) ? r.name : `${r.name} (\`${cmd}\`)`, result: r.result });
  }
  // In the order the repository names its checks.
  const order = [...own.keys()];
  const of = (want: string) => [...last.entries()].filter(([, v]) => v.result === want).sort(([a], [b]) => order.indexOf(a.split("\n")[0]!) - order.indexOf(b.split("\n")[0]!)).map(([, v]) => v.label);
  const ran = new Set([...last.keys()].map((k) => k.split("\n")[0]!));
  return { passed: of("pass"), failed: of("fail"), notRun: order.filter((n) => !ran.has(n)) };
}
