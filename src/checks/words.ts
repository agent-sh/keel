// What the check ledger tells, in words: the answer to a check that already
// passed on the same files, the note on a red run (red on the base too, or
// flaky), and the proof line on an agent's report. Pure: rows in, text out.
import { localDay, localTime } from "../core/clock.ts";

export type Result = "pass" | "fail" | "stopped" | "unknown" | "answered";
export type Run = {
  id: number;
  name: string;
  command: string;
  dir: string;
  tree: string;
  head: string | null;
  session_id: string | null;
  by: "agent" | "owner";
  result: Result;
  exit: number | null;
  pass: number | null;
  fail: number | null;
  started: number;
  ended: number;
  log: string | null;
  from_run: number | null;
};

// A time as the owner reads it: HH:MM today, else with its day.
export function when(ts: number, now = Date.now()): string {
  const t = localTime(ts).slice(0, 5);
  return localDay(ts) === localDay(now) ? t : `${localDay(ts)} ${t}`;
}
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 9) : "?");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The counts a run printed, as "37 pass, 2 fail".
export function countWords(r: Pick<Run, "pass" | "fail">): string {
  const parts = [r.pass !== null ? `${r.pass} pass` : "", r.fail !== null ? `${r.fail} fail` : ""].filter(Boolean);
  return parts.join(", ");
}
const label = (r: Pick<Run, "name" | "command">) => (r.command && r.command !== r.name ? `${r.name} (\`${r.command.length > 80 ? `${r.command.slice(0, 79)}…` : r.command}\`)` : r.name);

// --- the base: how the check fared on the base branch's recent commits.

// `history`: the base's first-parent commits, newest first, each with its tree.
// `runs`: the passes and failures of the same check on any of those trees.
export type BaseState =
  | { state: "red"; since: { commit: string; at: number }; last: { commit: string; at: number } }
  | { state: "green"; commit: string; at: number };
export function baseState(history: readonly { commit: string; tree: string }[], runs: readonly Pick<Run, "tree" | "result" | "ended">[]): BaseState | undefined {
  // The newest run that decided on each tree.
  const latest = new Map<string, Pick<Run, "result" | "ended">>();
  for (const r of runs) {
    if (r.result !== "pass" && r.result !== "fail") continue;
    const had = latest.get(r.tree);
    if (!had || r.ended > had.ended) latest.set(r.tree, r);
  }
  let red: Extract<BaseState, { state: "red" }> | undefined;
  for (const c of history) {
    const r = latest.get(c.tree);
    if (!r) continue;
    if (!red) {
      if (r.result === "pass") return { state: "green", commit: c.commit, at: r.ended };
      red = { state: "red", since: { commit: c.commit, at: r.ended }, last: { commit: c.commit, at: r.ended } };
      continue;
    }
    if (r.result === "pass") break;
    red.since = { commit: c.commit, at: r.ended };
  }
  return red;
}

// Passes and failures on one tree: flaky when both are there.
export function flakyOn(runs: readonly Pick<Run, "result" | "ended">[]): { pass: number; fail: number } | undefined {
  let pass: number | undefined, fail: number | undefined;
  for (const r of runs) {
    if (r.result === "pass") pass = Math.max(pass ?? 0, r.ended);
    if (r.result === "fail") fail = Math.max(fail ?? 0, r.ended);
  }
  return pass !== undefined && fail !== undefined ? { pass, fail } : undefined;
}

// The base's part of a note, a few words: "red on origin/main too since 1a2b3c4d5 (14:00)".
export function baseWords(base: BaseState | undefined, name: string, now = Date.now()): string {
  if (!base) return `not run on ${name}'s recent commits yet`;
  if (base.state === "green") return `it passes on ${name} (${short(base.commit)}, ${when(base.at, now)}): the change here makes it fail`;
  return base.since.commit === base.last.commit
    ? `red on ${name} too (${short(base.last.commit)}, ${when(base.last.at, now)})`
    : `red on ${name} too since ${short(base.since.commit)} (${when(base.since.at, now)})`;
}

// --- the shell result's words

// The answer to a check that passed on this tree: it is not run again.
export function answerText(r: Run, o: { session: string | undefined; now?: number }): string {
  const who = r.by === "owner" ? "run by the owner" : r.session_id && r.session_id === o.session ? "in this session" : "in another session";
  const counts = countWords(r);
  return [
    `Not run: ${label(r)} passed on this tree at ${when(r.ended, o.now)}${counts ? ` (${counts})` : ""}, ${who}, and the files are the same now (uncommitted changes included).`,
    ...(r.log ? [`Its output: ${r.log}`] : []),
    "To run it anyway, send the same command again.",
  ].join("\n");
}

// The note a finished check run gets in its result: a red one says whether it is red on the base too, or flaky.
export function runNote(r: Run, o: { flaky?: { pass: number; fail: number }; base?: string; now?: number }): string {
  const counts = countWords(r);
  if (r.result === "pass") return o.flaky ? `Check ledger: ${r.name} passed, but failed on this same tree at ${when(o.flaky.fail, o.now)}: flaky.` : "";
  if (r.result !== "fail") return "";
  const parts = [`Check ledger: ${r.name} failed on this tree${counts ? ` (${counts})` : ""}.`];
  if (o.flaky) parts.push(`It passed on this same tree at ${when(o.flaky.pass, o.now)}: flaky.`);
  if (o.base) parts.push(`${o.base[0]!.toUpperCase()}${o.base.slice(1)}.`);
  return parts.join(" ");
}

// --- the proof line on an agent's report

export const PROOF_MAX = 420;
export type ProofIn = {
  runs: readonly Run[];        // the agent's check runs since its task began, answered ones too
  edits: readonly number[];    // when each of its edit calls that wrote a file ended
  treeNow?: string;            // the tree of its folder as it reports
  base?: ReadonlyMap<number, string>; // a red run's base words, by run id
  named: boolean;              // its repository names checks
  now?: number;
};

// What Keel saw of the agent's checks, from the ledger alone: the checks run
// after its last edit and how each ended, the edits made after its last green
// run, and whether the files changed after its last check. "" when there is
// nothing to say (no checks named and none run, or no edit and no run).
export function proofLine(p: ProofIn): string {
  const runs = p.runs.filter((r) => r.result !== "stopped");
  const lastEdit = p.edits.length ? Math.max(...p.edits) : undefined;
  if (!runs.length) {
    if (!p.named || !p.edits.length) return "";
    return `(Checks: none ran; it made ${plural(p.edits.length, "edit")}.)`;
  }
  // The newest run of each check, after the last edit and before it.
  const newest = (list: readonly Run[]) => {
    const by = new Map<string, Run>();
    for (const r of list) { const k = `${r.dir}\n${r.command}`; const had = by.get(k); if (!had || r.ended >= had.ended) by.set(k, r); }
    return [...by.values()].sort((a, b) => a.ended - b.ended);
  };
  const after = newest(runs.filter((r) => lastEdit === undefined || r.ended > lastEdit));
  const before = newest(runs.filter((r) => lastEdit !== undefined && r.ended <= lastEdit)).filter((b) => !after.some((a) => a.dir === b.dir && a.command === b.command));
  const green = runs.filter((r) => r.result === "pass" || r.result === "answered").reduce<number | undefined>((t, r) => Math.max(t ?? 0, r.ended), undefined);
  const said = (r: Run, full: boolean) => {
    const how = r.result === "answered" ? "passed (from the ledger)" : r.result === "pass" ? "passed" : r.result === "fail" ? "failed" : "ended, status unknown";
    const extra = full ? [r.result === "fail" ? countWords(r) : "", r.result === "fail" ? p.base?.get(r.id) ?? "" : ""].filter(Boolean).join("; ") : "";
    return `${r.name} ${how} ${when(r.ended, p.now)}${extra ? ` (${extra})` : ""}`;
  };
  const head = lastEdit === undefined ? "Checks" : after.length ? `Checks after its last edit (${when(lastEdit, p.now)})` : `Checks: none ran after its last edit (${when(lastEdit, p.now)})`;
  const editsAfterGreen = green === undefined ? undefined : p.edits.filter((t) => t > green).length;
  const greenWords = green === undefined ? "No check passed." : lastEdit === undefined ? "" : `${editsAfterGreen ? plural(editsAfterGreen, "edit") : "No edit"} after the last green run.`;
  const latest = runs.reduce((a, b) => (b.ended >= a.ended ? b : a));
  const treeWords = p.treeNow === undefined ? "" : latest.tree === p.treeNow ? "Its files are the ones its last check ran on." : "Its files changed after its last check run.";
  for (const full of [true, false]) {
    const list = after.length ? `: ${after.map((r) => said(r, full)).join(", ")}.` : before.length ? `; before it: ${before.map((r) => said(r, full)).join(", ")}.` : ".";
    const text = `(${head}${list} ${[greenWords, treeWords].filter(Boolean).join(" ")})`.replace(/ \)$/, ")");
    if (text.length <= PROOF_MAX) return text;
  }
  const n = after.length || before.length;
  return `(${head}: ${plural(n, "check")}, ${after.filter((r) => r.result === "fail").length} failed. ${[greenWords, treeWords].filter(Boolean).join(" ")})`.slice(0, PROOF_MAX);
}
