// The landing queue, its pure part: how a repository says what landing runs
// (the `land` part of .keel/checks.json), which named checks a queued entry
// must pass, the order entries are built in, and the words its sessions are
// told. The queue that runs git and the checks is src/landing/queue.ts.
//
//   {
//     "checks": { "typecheck": "bunx tsc --noEmit -p .", "unit": { "run": "bun test", "args": true } },
//     "land": {
//       "checks": ["typecheck", "unit"],
//       "setup": "ln -s \"$KEEL_LAND_REPO/node_modules\" node_modules",
//       "after": "scripts/deploy.sh",
//       "push": "origin",
//       "method": "rebase",
//       "timeout_minutes": 60
//     }
//   }
//
//   checks   the named checks an entry passes before it lands, each a name and
//            the words after it ("unit test/x"); default: every named check
//            of the work tree that runs in one folder, with no words added;
//   setup    a command run in the queue's own worktree before its checks
//            (install or link what the checks read and git does not hold);
//   after    the repository's own step after the base moved (a deploy, a
//            restart): run once a batch, in the main checkout, where the
//            queueing session's own commands run (its sandbox, when it has
//            one), like the checks. Keel restarts nothing of its own;
//   push     the remote the base is pushed to as part of landing; none: the
//            base moves here only;
//   method   "rebase" (the default): each entry's commits go on top of the
//            base and the entries ahead, and the base fast-forwards to the
//            tested commit; "merge": a merge commit an entry, for a
//            repository whose rules ask for one;
//   timeout_minutes  how long one check may run before it counts as failed.
//
// The queue reads this from the base's commit, not from a branch: what an
// entry must pass is what the base names, so a branch cannot ease its own way in.
import type { Check } from "../checks/named.ts";

export type Method = "rebase" | "merge";
export type LandRules = {
  checks?: { name: string; args: string[] }[];
  setup?: string;
  after?: string;
  push?: string;
  method: Method;
  timeoutMs: number;
  problems: string[];
};

// A check still running after an hour is held by something (a server it
// waits for, a lock): the queue would stand behind it with every entry.
// A repository with longer checks says so.
export const TIMEOUT_MINUTES = 60;
const CMD_MAX = 400;
const REMOTE = /^[A-Za-z0-9][\w.-]{0,63}$/;

export function readLand(v: unknown): LandRules {
  const out: LandRules = { method: "rebase", timeoutMs: TIMEOUT_MINUTES * 60_000, problems: [] };
  if (v === undefined || v === null) return out;
  if (typeof v !== "object" || Array.isArray(v)) return { ...out, problems: ['"land" is an object'] };
  const o = v as Record<string, unknown>;
  if (o.checks !== undefined) {
    if (!Array.isArray(o.checks) || !o.checks.every((c) => typeof c === "string" && c.trim() && c.length <= CMD_MAX)) out.problems.push('land.checks is a list of check names, each with the words after it');
    else out.checks = (o.checks as string[]).map((c) => { const [name, ...args] = c.trim().split(/\s+/); return { name: name!, args }; });
  }
  for (const k of ["setup", "after"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "string" || !(o[k] as string).trim() || (o[k] as string).length > CMD_MAX) out.problems.push(`land.${k} is a command of 1 to ${CMD_MAX} characters`);
    else out[k] = (o[k] as string).trim();
  }
  if (o.push !== undefined && o.push !== false) {
    if (typeof o.push !== "string" || !REMOTE.test(o.push)) out.problems.push("land.push is the name of a remote (origin), or false");
    else out.push = o.push;
  }
  if (o.method !== undefined) {
    if (o.method !== "rebase" && o.method !== "merge") out.problems.push('land.method is "rebase" or "merge"');
    else out.method = o.method;
  }
  if (o.timeout_minutes !== undefined) {
    const n = o.timeout_minutes;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) out.problems.push("land.timeout_minutes is a number of minutes over 0");
    else out.timeoutMs = Math.round(n * 60_000);
  }
  return out;
}

// One check as the queue runs it: its command line and what the ledger knows the run by.
export type ToRun = { check: Check; command: string; dir: string };
// The checks an entry must pass, from the repository's named checks. A name
// the repository does not name, or words for a check that takes none, is a
// problem: nothing lands until the rules are right.
export function checksToRun(rules: LandRules, named: readonly Check[], home: string): { run: ToRun[] } | { problem: string } {
  const words = (c: Check) => c.run.split(" ").map((r) => (r === "~" || r.startsWith("~/") ? home + r.slice(1) : r.replace(/^\$HOME(?=\/|$)/, home)));
  const one = (c: Check, args: string[]): ToRun => ({ check: c, command: [...words(c), ...args].join(" "), dir: c.dir });
  if (!rules.checks) {
    const all = named.filter((c) => c.tree.kind === "work" && c.dir !== "*");
    if (!all.length) return { problem: "the repository names no check the queue can run (.keel/checks.json), so nothing is known to pass" };
    return { run: all.map((c) => one(c, [])) };
  }
  if (!rules.checks.length) return { problem: "land.checks is empty, so nothing is known to pass" };
  const run: ToRun[] = [];
  for (const { name, args } of rules.checks) {
    const c = named.find((x) => x.name === name);
    if (!c) return { problem: `land.checks names ${name}, which .keel/checks.json does not name` };
    if (args.length && !c.args) return { problem: `land.checks gives ${name} words of its own, and ${name} takes none` };
    if (c.tree.kind !== "work" || c.dir === "*") return { problem: `${name} checks ${c.tree.kind === "commit" ? "a commit its argument names" : c.dir === "*" ? "any folder" : "a folder its argument names"}: the queue runs checks of the work tree in one folder` };
    run.push(one(c, args));
  }
  return { run };
}

// The order entries are built in: the order they were queued, except that an
// entry the overlap forecast finds conflicting with the base goes after the
// rest. It would leave the queue at its rebase; built last, it costs the
// others nothing, and it is still tried on the base as it will be then.
export function buildOrder<T extends { branch: string; pos: number }>(entries: readonly T[], conflictsWithBase: ReadonlySet<string>): T[] {
  return [...entries].sort((a, b) => Number(conflictsWithBase.has(a.branch)) - Number(conflictsWithBase.has(b.branch)) || a.pos - b.pos);
}

// What a queued branch is warned of when it is queued, from the forecast:
// a conflict with the base (it leaves unless rebased), and conflicts with
// entries ahead of it (the second of two to land leaves).
export function queueWarning(branch: string, base: string, forecast: { base: string[] | undefined; ahead: { branch: string; files: string[] }[] }): string | undefined {
  const parts: string[] = [];
  const files = (f: string[]) => (f.length ? f.slice(0, 4).join(", ") + (f.length > 4 ? ` (+${f.length - 4} more)` : "") : "files git names none of");
  if (forecast.base) parts.push(`${branch} would conflict with ${base} in ${files(forecast.base)}: it leaves the queue at its rebase unless it is rebased onto ${base} first`);
  for (const a of forecast.ahead) parts.push(`${branch} would conflict with ${a.branch}, queued ahead of it, in ${files(a.files)}: if ${a.branch} lands, ${branch} leaves and is rebased onto it`);
  return parts.length ? `Overlap forecast: ${parts.join("; ")}.` : undefined;
}

// --- what the sessions are told

const short = (sha: string) => sha.slice(0, 9);
export type Left = { branch: string; why: string; log?: string };
export type Landed = { branch: string; tip: string; at: string; moved?: true };
// `push`: how the push went when the repository asks for one (pushed, refused with git's words, or
// not made and why). `after`: the after-land step's run; `afterCut`: it was owed and a stop came first.
export type Push = { remote: string; ok: true } | { remote: string; ok: false; err: string } | { remote: string; skipped: string };
export type Outcome = { repo: string; base: string; from: string; to: string; landed: Landed[]; left: Left[]; checks: string[]; push?: Push; after?: { exit: number | null; log: string }; afterCut?: true };

// Why an entry left, in one line: what failed, on what, and what to do.
export function leftWhy(k: { kind: "conflict"; base: string; at: string; files: string[]; ahead: string[] } | { kind: "check"; name: string; base: string; at: string; ahead: string[]; note: string; tail: string } | { kind: "gone" } | { kind: "setup"; err: string } | { kind: "wrote"; name: string; files: string[] } | { kind: "unmoved"; base: string; why: string } | { kind: "moving"; base: string; times: number }): string {
  const on = (base: string, at: string, ahead: string[]) => `${base} at ${short(at)}${ahead.length ? ` with ${ahead.join(", ")} ahead of it` : ""}`;
  switch (k.kind) {
    case "conflict": return `it conflicts with ${on(k.base, k.at, k.ahead)} in ${k.files.length ? k.files.slice(0, 6).join(", ") : "a change git names no file for"}: rebase it onto ${k.base} and queue it again`;
    case "check": return `${k.name} failed on it built on ${on(k.base, k.at, k.ahead)}${k.note ? ` (${k.note})` : ""}${k.tail ? `; its last lines: ${k.tail}` : ""}: fix it on the branch and queue it again`;
    case "gone": return "the branch is gone";
    case "wrote": return `${k.name} changed the files it checked (${k.files.length ? k.files.slice(0, 6).join(", ") : "files git does not list"}): what it passed on is not what would land; make it check without writing, or do the writing in land.setup`;
    case "unmoved": return `${k.base} was not moved: ${k.why}`;
    case "moving": return `${k.base} moved while it was checked, ${k.times} times: queue it again when ${k.base} is quiet`;
    case "setup": return `the queue's setup step failed (${k.err}): nothing was checked`;
  }
}

// The note the session that queued entries gets when a batch ends: what
// landed (with the checks that passed on that exact tree), what left and why.
export function outcomeText(o: Outcome, own: (branch: string) => boolean = () => false): string {
  const lines = ["[harness] Landing queue:"];
  if (o.landed.length) {
    const p = o.push;
    lines.push(`- Landed on ${o.base}: ${o.landed.map((l) => `${l.branch} (as ${short(l.at)})`).join(", ")}. ${o.base} moved ${short(o.from)} to ${short(o.to)}, a fast-forward to the commit ${o.checks.join(", ")} passed on${p && "ok" in p && p.ok ? `, and was pushed to ${p.remote}` : ""}.`);
    if (p && "skipped" in p) lines.push(`- It was not pushed to ${p.remote}: ${p.skipped}. ${o.base} moved here only; push it from a session that may reach the network, or by hand.`);
    else if (p && !p.ok) lines.push(`- The push to ${p.remote} was refused (${p.err}): ${o.base} moved here, and ${p.remote} is behind it. Push it again once that is fixed.`);
    const moved = o.landed.filter((l) => l.moved);
    if (moved.length) lines.push(`- ${moved.map((l) => l.branch).join(", ")} moved while ${moved.length === 1 ? "it was" : "they were"} checked: what came after the checked tip is not landed; queue ${moved.length === 1 ? "it" : "them"} again.`);
    if (o.afterCut) lines.push("- The after-land step did not run: the daemon stopped between the move and the step. Run it by hand if it is needed.");
    if (o.after) lines.push(o.after.exit === 0 ? `- The after-land step ran once (exit 0). Its output: ${o.after.log}` : `- The after-land step failed (${o.after.exit === null ? "it was stopped" : `exit ${o.after.exit}`}). Its output: ${o.after.log}`);
  }
  for (const l of o.left) if (!own(l.branch)) lines.push(`- ${l.branch} left the queue: ${l.why}.${l.log ? ` Its output: ${l.log}` : ""}`);
  return lines.join("\n");
}

// The failure a branch's session is told (src/automation/failures.ts), one line.
export const failureText = (l: Left, base: string) => `${l.branch} left the landing queue of ${base}: ${l.why}.${l.log ? ` Its output: ${l.log}` : ""}`;

// The last lines of a check's output, for the line its failure is told in.
export function tailOf(text: string, lines = 6, chars = 600): string {
  const t = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").trimEnd().split("\n").filter((l) => l.trim()).slice(-lines).join(" | ");
  return t.length > chars ? `…${t.slice(t.length - chars + 1)}` : t;
}
