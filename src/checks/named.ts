// The checks a repository names, and which command is one of them. Pure.
//
// A repository names its checks in `.keel/checks.json`, read from the work
// tree being checked (so a branch that changes a check is checked by its own
// definition). A Keel setting for the repository (`checks.repos`, by the
// repository's main checkout) replaces the file. A repository with neither
// has no checks: nothing is recorded or answered there.
//
//   {
//     "checks": {
//       "typecheck": "bunx tsc --noEmit -p .",
//       "unit": { "run": "bun test", "args": true },
//       "e2e": { "run": "bunx playwright test", "args": true, "cache": false },
//       "web": { "run": "npm test", "dir": "web" }
//     }
//   }
//
// A check is a name and the command that runs it: a string, or an object with
// `run`, and `args` (more words after the command are allowed; each set of
// words is a check run of its own), `dir` (the folder it runs in, from the
// repository's top; "." by default) and `cache` (false: every run is
// recorded, none is answered from an earlier one, for a check that reads
// more than the files, a server or the network).
//
// A command is that check when, after the parts that only shape its output
// are taken off (`2>&1`, and `| tail ...` or `| head ...` at its end), it is
// the check's command, in the check's folder (a leading `cd DIR &&` moves
// there), with nothing else that runs: no `;`, `&&`, `||`, a pipe or a
// redirection of its own in the words added to it.

export const FILE = ".keel/checks.json";
export const NAMES_MAX = 64;
const NAME = /^[A-Za-z0-9][\w.:-]{0,39}$/;
const RUN_MAX = 400;

export type Check = { name: string; run: string; args: boolean; dir: string; cache: boolean };
export type Named = { checks: Check[]; problems: string[] };

const squash = (s: string) => s.trim().replace(/\s+/g, " ");
// A folder from the top, as one form: "." or "a/b".
export function normDir(d: string): string {
  const parts: string[] = [];
  for (const p of d.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") { if (!parts.length) return ".."; parts.pop(); continue; }
    parts.push(p);
  }
  return parts.join("/") || ".";
}

// The checks of a parsed file or setting (its `checks` object), with what was wrong in it.
export function readChecks(value: unknown): Named {
  const problems: string[] = [];
  const checks: Check[] = [];
  const list = value && typeof value === "object" && !Array.isArray(value) ? (value as any).checks : undefined;
  if (!list || typeof list !== "object" || Array.isArray(list)) return { checks, problems: ["it has no \"checks\" object"] };
  for (const [name, v] of Object.entries(list)) {
    if (checks.length >= NAMES_MAX) { problems.push(`more than ${NAMES_MAX} checks: the rest are left out`); break; }
    if (!NAME.test(name)) { problems.push(`"${name.slice(0, 40)}" is not a check name (letters, digits, . _ : -, up to 40)`); continue; }
    const o = typeof v === "string" ? { run: v } : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    const run = typeof o?.run === "string" ? squash(o.run) : "";
    if (!run || run.length > RUN_MAX) { problems.push(`${name}: "run" is a command of 1 to ${RUN_MAX} characters`); continue; }
    if (o!.args !== undefined && typeof o!.args !== "boolean") { problems.push(`${name}: "args" is true or false`); continue; }
    if (o!.cache !== undefined && typeof o!.cache !== "boolean") { problems.push(`${name}: "cache" is true or false`); continue; }
    if (o!.dir !== undefined && typeof o!.dir !== "string") { problems.push(`${name}: "dir" is a folder from the repository's top`); continue; }
    const dir = normDir(String(o!.dir ?? "."));
    if (dir === ".." || String(o!.dir ?? "").startsWith("/")) { problems.push(`${name}: "dir" is a folder inside the repository`); continue; }
    checks.push({ name, run, args: o!.args === true, dir, cache: o!.cache !== false });
  }
  return { checks, problems };
}

export function parseChecks(text: string): Named {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { checks: [], problems: [`it is not JSON: ${(e as Error).message.slice(0, 120)}`] }; }
  return readChecks(v);
}

// What only shapes a command's output, at its end: the status of the check
// is then the first of the pipe's (`piped`).
const FILTER = /^(?:tail|head)(?:\s+(?:-n\s*\d+|-\d+|-c\s*\d+|-n\s*\+\d+|--lines=\d+))*$/;
const MERGE = /\s+2>&1$/;
// Words that run something else, or send its output elsewhere.
const COMPOUND = /[;&|<>`\n]|\$\(/;

// `cd DIR && ` at the start: the folder, as written (quotes taken off), and the rest.
function leadingCd(c: string): { dir?: string; rest: string } {
  const m = /^cd\s+('([^']*)'|"([^"$`\\]*)"|([^\s'"$`\\;&|<>]+))\s*&&\s*/.exec(c);
  if (!m) return { rest: c };
  return { dir: m[2] ?? m[3] ?? m[4], rest: c.slice(m[0].length) };
}

export type Match = {
  check: Check;
  command: string;   // what the check run is known by: the check's command and the words added to it
  dir: string;       // the folder it ran in, from the top
  piped: boolean;    // its output went through a filter: its status is the pipe's first
};

// Which check `command` is, run in `cwd` (a folder from the repository's top),
// or nothing. `resolveDir`: the folder a leading cd names, from the top (the
// caller knows where the shell is; undefined: outside the repository).
export function matchCommand(command: string, checks: readonly Check[], cwd: string, resolveDir: (dir: string) => string | undefined = (d) => normDir(`${cwd}/${d}`)): Match | undefined {
  // (A second line is a second command.)
  if (!checks.length || /[\n\r]/.test(command.trim())) return;
  let c = squash(command);
  let dir = normDir(cwd);
  const cd = leadingCd(c);
  if (cd.dir !== undefined) {
    const to = resolveDir(cd.dir);
    if (to === undefined || to === "..") return;
    dir = to;
    c = cd.rest;
  }
  // The output filters at its end, then a merge of stderr before them.
  let piped = false;
  for (;;) {
    const bar = c.lastIndexOf("|");
    if (bar <= 0 || c[bar - 1] === "|") break;
    const tail = c.slice(bar + 1).trim();
    if (!FILTER.test(tail)) break;
    c = c.slice(0, bar).trim();
    piped = true;
  }
  c = c.replace(MERGE, "").trim();
  for (const check of checks) {
    if (check.dir !== dir) continue;
    if (c === check.run) return { check, command: c, dir, piped };
    if (check.args && c.startsWith(`${check.run} `) && !COMPOUND.test(c.slice(check.run.length))) return { check, command: c, dir, piped };
  }
  return undefined;
}
