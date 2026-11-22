// Why a command is high risk: what it can destroy or expose that nothing
// brings back. Five classes, each with a word of its own (`rule`), which the
// approval and the transcript carry:
//
//   destroys  deletes or empties files outside the session's folder, or the
//             folder's own work at large (a folder of files git does not
//             ignore, a pattern over the tree, the repository's history)
//   remote    changes another machine or a service where no sandbox or
//             checkpoint holds it: a remote shell that writes, a delete or
//             destroy verb of a cluster, cloud or database client, a publish,
//             a deploy (an ordinary push is not one)
//   exposes   sends a file that holds credentials to another machine
//   hidden    runs code that is not in the command: decoded or fetched text
//             given to a shell, an interpreter one-liner that deletes, a
//             library or a folder anyone can write put in front of the
//             programs, a package the command names
//   machine   reaches past the session on this machine: root, a signal to
//             every process, the user's scheduled jobs, a git setting that
//             names a program git runs
//
// A command is judged by what can be read in it. A wrapper (env, nohup,
// timeout, xargs, find -exec, a nested `sh -c`) is read through, a variable
// the line itself gives a value is read as that value, and a target that
// cannot be read is high for that reason alone: the card says to write it
// out. A part that only reads is never classed.
//
// Research: ~/.cache/keel-work/bun/research/risk-classes.md (Claude Code's
// auto mode rules and Codex's reviewer policy draw the same lines).
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { CRED_PATH, protectedBranch } from "./autonomy.ts";
import { highRisk, isReadOnly, lineRisk, readOnlyCommand, splitCommand, type Made, type Simple } from "./shell.ts";

export type RiskRule = "destroys" | "remote" | "exposes" | "hidden" | "machine";
// Each class in a few words: what the ask carries as its rule, and a folded call is marked with in the transcript.
export const RULE_WORDS: Record<RiskRule, string> = {
  destroys: "destroys work or data", remote: "changes another machine or a service", exposes: "sends credentials out",
  hidden: "runs code that is not in the command", machine: "reaches past the session on this machine",
};
// `git`: one of the git forms the full-auto rules can settle from the repository's state (autonomy.preAllow).
export type Risk = { rule: RiskRule; why: string; git?: true };

// Where the command runs. `kept`: how many files git does not ignore the
// pathspecs cover (0, 1, or 2 for more), or null when that is not known (no
// repository, another machine). The gate asks git before it decides.
// `lost`: the folder the commands run in is not known (a script nested under a cd the rules cannot follow).
// `land`: where a path lands on this machine's disk, its links followed (policy.ts Facts.own): a path counts as inside
// the folder or a temporary one only when every place it lands is.
export type Where = { cwd: string; home: string; workspace: string; scratch?: string[]; kept?: (specs: string[]) => number | null; land?: (p: string) => string[]; lost?: true };

const DEPTH = 8; // nested scripts read through; deeper is not read, and says so
// A nested script longer than this is not read through either: reading one costs as much as reading the line it is
// in, and the line is read once.
const SCRIPT_MAX = 4_000;

// ---- words ----

// The command a part really runs, past its assignments and the programs that
// only start another: `at` is where its first word stands among the part's
// words. `set`: the variables given to it. `fed`: its arguments come from
// somewhere else (xargs, find -exec). `deep`: more wrappers than are read.
type Run = { words: string[]; at: number; set: string[]; fed?: "xargs" | "find"; find?: string[]; deep?: true };
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Each wrapper's options that take a value in the next word.
const VALUED: Record<string, RegExp> = {
  env: /^(-u|--unset|-C|--chdir)$/, nice: /^(-n|--adjustment)$/, ionice: /^-[cnp]$/, timeout: /^(-s|--signal|-k|--kill-after)$/,
  stdbuf: /^-[ioe]$/, exec: /^-a$/, sudo: /^-[ugCDhprTR]$/, doas: /^-[uC]$/, chrt: /^-[p]$/, taskset: /^-[c]$/, watch: /^(-n|--interval|-d|--differences)$/,
  xargs: /^-[nLPsEdaI]$/,
};
const WRAPPERS = new Set(["env", "nohup", "setsid", "nice", "ionice", "timeout", "stdbuf", "command", "builtin", "exec", "sudo", "doas", "time", "chrt", "taskset", "watch", "xargs", "npx", "bunx"]);
function unwrap(words: string[]): Run {
  let at = 0;
  const set: string[] = [];
  let fed: Run["fed"];
  for (let n = 0; ; n++) {
    while (at < words.length && ASSIGN.test(words[at]!)) set.push(words[at++]!);
    const prog = name(words[at]);
    if (!WRAPPERS.has(prog)) break;
    if (n >= DEPTH) return { words: words.slice(at), at, set, fed, deep: true };
    let i = at + 1;
    const valued = VALUED[prog];
    for (; i < words.length; i++) {
      const a = words[i]!;
      if (a === "--") { i++; break; }
      if (prog === "env" && ASSIGN.test(a)) { set.push(a); continue; }
      if (!a.startsWith("-") || a === "-") break;
      if (valued?.test(a)) i++;
    }
    // timeout's first operand is how long; command -v only asks what a name is.
    if (prog === "timeout") i++;
    if (prog === "command" && /^-[pvV]*[vV]/.test(words[at + 1] ?? "")) break;
    if (prog === "xargs") fed = "xargs";
    if (i >= words.length) break;
    at = i;
  }
  const run = words.slice(at);
  // find runs what follows -exec, once for the paths it found.
  if (name(run[0]) === "find") {
    const x = run.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
    if (x > 0 && run[x + 1]) {
      const end = run.findIndex((a, k) => k > x && (a === ";" || a === "+"));
      const inner = unwrap(run.slice(x + 1, end < 0 ? undefined : end));
      return { words: inner.words, at: at + x + 1 + inner.at, set: [...set, ...inner.set], fed: "find", find: run.slice(0, x), deep: inner.deep };
    }
  }
  return { words: run, at, set, fed };
}
const name = (w: string | undefined) => (w === undefined ? "" : w.slice(w.lastIndexOf("/") + 1));

// ---- the folder each part runs in ----

// A `cd` to a written-out path moves the commands after it; one the rules
// cannot read (a variable, `cd -`, popd) leaves the folder unknown from there
// on. A `cd` inside a subshell or a substitution moves nothing outside it,
// and inside it only the commands chained to it (`(cd ui && rm -rf dist)`):
// where the subshell ends is not known from the parts, so after the chain the
// folder of what is nested is unknown until the next command outside.
function dirsOf(parts: Simple[], cwd: string, home: string): (string | null)[] {
  let top: string | null = cwd;
  let inner: string | null | undefined; // undefined: nested parts run where the line is
  const to = (from: string | null, s: Simple): string | null | undefined => {
    const w = unwrap(s.words).words;
    if (!/^(cd|pushd|popd)$/.test(w[0] ?? "")) return undefined;
    const arg = w.slice(1).find((a) => !a.startsWith("-") || a === "-");
    if (w[0] === "popd" || arg === "-" || (arg !== undefined && (/[$`*?[\]{}]/.test(arg) || (arg.startsWith("~") && arg !== "~" && !arg.startsWith("~/"))))) return null;
    const path = arg === undefined || arg === "~" ? home : arg.startsWith("~/") ? home + arg.slice(1) : arg;
    return isAbsolute(path) ? resolve(path) : from === null ? null : resolve(from, path);
  };
  return parts.map((s) => {
    if (s.heredoc) return inner === undefined ? top : inner;
    if (!s.nested) {
      inner = undefined;
      const here = top;
      const next = to(top, s);
      if (next !== undefined) top = next;
      return here;
    }
    const here = inner === undefined ? top : inner;
    const next = to(here, s);
    if (next !== undefined) inner = s.sep === "&&" ? next : null;
    else if (inner !== undefined && s.sep !== "&&" && s.sep !== "||" && s.sep !== "|" && s.sep !== "|&") inner = null;
    return here;
  });
}

// ---- variables the line itself gives a value ----

// A name is read as its value only when the line gives it one value, once, in
// a part of its own that always runs (`x=/srv; rm -rf $x/app`), and names it
// nowhere else as a word (read x, export x, unset x). A line that can give a
// name a value in a way its words do not show (eval, source, a name
// reference, a builtin that takes the name from an expansion) gives none.
// `made`: its value is the path mktemp just made, which holds nothing from before.
type Values = Map<string, { text?: string; made?: true; at: number }>;
const WRITTEN = /^[A-Za-z0-9_.\/@:+,%^~-]*$/;
const BINDS = /^(read|declare|typeset|local|export|readonly|unset|printf|mapfile|readarray|getopts|let|wait|coproc|builtin|command|eval|source|\.)$/;
// After a loop, a conditional or a group, a name may hold something else (for x in ..., a branch that assigns): no
// variable is read as a value there, the ones the environment gives included.
const LOST: Values = new Map();
function valuesOf(parts: Simple[]): Values {
  const out: Values = new Map();
  const count = new Map<string, number>();
  const bare = new Set<string>();
  for (const p of parts) {
    const prog = name(unwrap(p.words).words[0]);
    if (/^(eval|source|\.|declare|typeset|local)$/.test(prog) || (BINDS.test(prog) && p.dyn)) return out;
  }
  for (const p of parts) for (const w of p.words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|\[)/.exec(w);
    if (m) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) bare.add(w);
  }
  parts.forEach((p, at) => {
    if (p.nested || p.flow || p.unknown || p.redirects || !p.words.length || !p.words.every((w) => ASSIGN.test(w))) return;
    if (p.sep && p.sep !== "&&") return; // a pipeline, the background, or a part that may not run
    // Nor one that runs only when the command before it succeeded or failed: a name left unset is an empty path.
    let prev = at - 1;
    while (prev >= 0 && parts[prev]!.nested) prev--;
    if (prev >= 0 && (parts[prev]!.sep === "&&" || parts[prev]!.sep === "||")) return;
    p.words.forEach((w, k) => {
      const eq = w.indexOf("=");
      const n = w.slice(0, eq), v = w.slice(eq + 1);
      if (count.get(n) !== 1 || bare.has(n)) return;
      const how = p.how?.[p.dyn?.indexOf(k) ?? -1];
      if (!how) { if (WRITTEN.test(v)) out.set(n, { text: v, at }); return; }
      const sub = how.subs.length === 1 && !how.vars.length && !how.rest && (v === "$(...)" || v === "`...`") ? how.subs[0]! : null;
      if (sub?.length === 1 && name(unwrap(sub[0]!.words).words[0]) === "mktemp") out.set(n, { made: true, at });
    });
  });
  return out;
}

// ---- where a path lands ----

type Place = "scratch" | "inside" | "outside" | "folder" | "repo";
// A word as a path: where it lands, or why that cannot be read.
type Target = { path: string; glob: boolean; place: Place; shown: string } | { made: true } | { unread: string };

const GLOB = /[*?[]/;
function target(word: string, how: Made | undefined, dir: string | null, w: Where, vals: Values, at: number): Target {
  let text = word;
  if (how) {
    if (how.subs.length || (how.rest && /[$`{]/.test(word)) || (how.vars.length && vals === LOST)) return { unread: word };
    // Each variable in the word, last first, so the places of the ones before it hold.
    for (let k = how.vars.length - 1; k >= 0; k--) {
      const v = how.vars[k]!;
      const known = vals.get(v.name);
      let value: string | undefined;
      if (known && known.at < at) { if (known.made) return k === 0 && v.at === 0 ? { made: true } : { unread: word }; value = known.text; }
      else if (vals.has(v.name)) return { unread: word };
      else if (v.name === "HOME") value = w.home;
      else if (v.name === "PWD" && dir) value = dir;
      else if (v.name === "TMPDIR" && process.env.TMPDIR) value = process.env.TMPDIR;
      if (value === undefined) return { unread: word };
      text = text.slice(0, v.at) + value + text.slice(v.at + v.len);
    }
  }
  if (!text || /[$`]/.test(text)) return { unread: word };
  if (text === "~" || text.startsWith("~/")) text = w.home + text.slice(1);
  else if (text.startsWith("~")) return { unread: word };
  if (!isAbsolute(text)) { if (!dir) return { unread: `${word}, in a folder the rules cannot follow` }; text = resolve(dir, text); }
  const path = resolve(text);
  const glob = GLOB.test(path);
  // A pattern is judged by the folder its fixed part names; one that starts its name with a wildcard takes everything there.
  const fixed = glob ? path.slice(0, path.lastIndexOf("/", path.search(GLOB))) || "/" : path;
  const all = glob && GLOB.test(path.slice(fixed === "/" ? 1 : fixed.length + 1)[0] ?? "");
  // The worst of the places it lands: a link in a temporary folder that leads out of it is out of it.
  const places = (w.land?.(fixed) ?? [fixed]).map((p) => placeOf(p, glob, all, w));
  const place = (["outside", "folder", "repo", "inside", "scratch"] as const).find((x) => places.includes(x))!;
  return { path, glob, place, shown: contains(w.workspace, fixed) ? relative(w.workspace, path) || "." : /[$`]/.test(word) ? path : word };
}

// Folders that hold nothing kept: the system's temporary folders, the
// daemon's own, and the session's scratch. What is inside one is scratch; the
// folder itself, or everything in it at once, is not the session's to clear.
const temps = (w: Where) => ["/tmp", "/var/tmp", "/dev/shm", tmpdir(), ...(w.scratch ?? [])];
function placeOf(p: string, glob: boolean, all: boolean, w: Where): Place {
  const root = resolve(w.workspace);
  // The session's folder first: one that lies in a temporary folder is still its work. A pattern in the folder's
  // own root names things inside it.
  if (p === root && glob) return "inside";
  if (contains(p, root)) return "folder";
  if (contains(root, p)) return /(^|\/)\.git(\/|$)/.test(relative(root, p)) ? "repo" : "inside";
  for (const t of temps(w)) if (contains(t, p)) return p !== t || (glob && !all) ? "scratch" : "outside";
  return "outside";
}

// Names of folders and files that are made, not written: deleting one loses
// nothing. Read only when git cannot say (no repository, another machine).
const MADE_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", ".vite", ".svelte-kit", ".output", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".venv", "venv", ".gradle", ".dart_tool", "tmp", "temp", ".tmp", "logs", ".nyc_output", "storybook-static", "test-results", "playwright-report", ".eggs", "htmlcov", ".terraform", ".angular", ".expo"]);
const MADE_FILE = /\.(o|a|so|pyc|pyo|class|log|tmp|orig|rej|swp|egg-info|tsbuildinfo|lock-wal|out)$|^\.DS_Store$|~$/;
const madeName = (rel: string) => rel.split("/").some((seg) => MADE_DIRS.has(seg)) || MADE_FILE.test(rel.slice(rel.lastIndexOf("/") + 1));
const literal = (p: string) => `:(literal)${p}`;

// ---- class: destroys ----

// What a deleting program's arguments name, past its options and their values.
const TAKES: Record<string, RegExp> = { truncate: /^(-s|--size|-r|--reference|-o)$/, shred: /^(-n|--iterations|-s|--size)$/ };
const DELETES = new Set(["rm", "unlink", "shred", "truncate"]);
const LOGGISH = /\.(log|out|tmp|pid|lock)$/;

function deletes(run: Run, s: Simple, dir: string | null, w: Where, vals: Values, at: number, prev: Simple | null): Risk[] {
  const [prog, ...args] = run.words;
  const p = name(prog);
  const out: Risk[] = [];
  const how = (k: number) => s.how?.[s.dyn?.indexOf(run.at + 1 + k) ?? -1];
  const add = (why: string) => { out.push({ rule: "destroys", why }); };
  const verb = p === "truncate" ? "empties" : p === "shred" ? "overwrites" : "deletes";
  if (DELETES.has(p)) {
    const recursive = p === "rm" && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    // Its paths come from another command: read where that one looks, when it is find.
    if (run.fed) {
      const from = run.fed === "find" ? run.find! : prev && name(unwrap(prev.words).words[0]) === "find" ? unwrap(prev.words).words : null;
      if (from) return swept(from, verb, dir, w, vals, at);
      return [{ rule: "destroys", why: `${verb} the paths another command prints, which are not in the command` }];
    }
    let rest = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!rest && a === "--") { rest = true; continue; }
      if (!rest && a.startsWith("-")) { if (TAKES[p]?.test(a)) k++; continue; }
      const t = target(a, how(k), dir, w, vals, at);
      if ("made" in t) continue;
      if ("unread" in t) { add(`${verb} a path the command does not spell out (${t.unread}): write the path into the command`); continue; }
      if (t.place === "scratch") continue;
      if (t.place === "outside") { add(`${verb} ${t.shown}, outside the session's folder`); continue; }
      if (t.place === "folder") { add(`${verb} the session's folder, or what holds it`); continue; }
      if (t.place === "repo") { add(`${verb} ${t.shown}, the repository's own data`); continue; }
      // Inside the folder: one named file is an edit. A folder or a pattern is judged by what it holds.
      if (p === "truncate" || p === "shred") { if (!LOGGISH.test(t.path)) add(`${verb} ${t.shown} in place`); continue; }
      if (!recursive && !t.glob) continue;
      const n = w.kept?.([t.glob ? t.path : literal(t.path)]) ?? null;
      // Not known: a made name, one file by its extension, and a pattern that is not everything pass.
      const one = !t.glob && /[^/]\.[A-Za-z0-9]+$/.test(t.path);
      if (n === null ? !(madeName(t.shown) || one || (!recursive && !/(^|\/)\*$/.test(t.path))) : n >= 2)
        add(`deletes ${t.shown}${recursive ? " recursively" : ""}, which ${n === null ? "is not known to be build output" : "holds files git does not ignore"}`);
    }
    return out;
  }
  if (p === "find" && args.includes("-delete")) return swept(run.words, "deletes", dir, w, vals, at);
  if (p === "chmod" || p === "chown" || p === "chgrp") {
    if (!args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive")) return out;
    const paths = args.filter((a) => !a.startsWith("-")).slice(1);
    paths.forEach((a) => {
      const t = target(a, how(args.indexOf(a)), dir, w, vals, at);
      if ("unread" in t) add(`changes ${p === "chmod" ? "modes" : "ownership"} of a whole tree the command does not spell out (${t.unread})`);
      else if ("place" in t && (t.place === "outside" || t.place === "folder" || t.path === resolve(w.workspace))) add(`changes ${p === "chmod" ? "modes" : "ownership"} of everything in ${t.place === "outside" ? t.shown : "the session's folder"}`);
    });
    return out;
  }
  if (p === "rsync" && args.some((a) => /^--del(ete)?/.test(a) || a === "--remove-source-files")) {
    const dest = args.filter((a) => !a.startsWith("-")).at(-1);
    if (!dest) return out;
    if (REMOTE_SPEC.test(dest)) return [{ rule: "remote", why: `deletes on another machine (${dest.slice(0, dest.indexOf(":"))}) what the source does not hold` }];
    const t = target(dest, how(args.lastIndexOf(dest)), dir, w, vals, at);
    if ("unread" in t) add(`deletes in a folder the command does not spell out (${t.unread}) what the source does not hold`);
    else if ("place" in t && t.place !== "scratch" && t.place !== "inside") add(`deletes in ${t.shown}, outside the session's folder, what the source does not hold`);
  }
  return out;
}

// A find that deletes what it matches (-delete, -exec rm, | xargs rm): judged
// by where it looks and, when one -name is all it tests, by what git says of
// that name there.
function swept(find: string[], verb: string, dir: string | null, w: Where, vals: Values, at: number): Risk[] {
  let k = 1;
  while (/^-[HLP]$/.test(find[k] ?? "") || /^-[DO]/.test(find[k] ?? "")) k += find[k] === "-D" || find[k] === "-O" ? 2 : 1;
  const roots: string[] = [];
  while (k < find.length && !find[k]!.startsWith("-") && find[k] !== "(" && find[k] !== "!") roots.push(find[k++]!);
  const tests = find.slice(k);
  const names = tests.flatMap((a, k) => (a === "-name" || a === "-iname") && tests[k + 1] !== undefined ? [tests[k + 1]!] : []);
  const plain = names.length === 1 && !tests.some((a) => /^(-o|-or|-not|!|,|-path|-ipath|-wholename|-regex|-iregex|-newer|-samefile)$/.test(a));
  const out: Risk[] = [];
  for (const r of roots.length ? roots : ["."]) {
    const t = target(r, undefined, dir, w, vals, at);
    if ("made" in t) continue;
    if ("unread" in t || /[$`]/.test(r)) { out.push({ rule: "destroys", why: `${verb} what find matches under a folder the command does not spell out (${r})` }); continue; }
    if (t.place === "scratch") continue;
    if (t.place === "outside" || t.place === "repo" || (t.place === "folder" && t.path !== resolve(w.workspace))) { out.push({ rule: "destroys", why: `${verb} what find matches under ${t.shown}, outside the session's work` }); continue; }
    const n = w.kept?.(plain ? [`:(glob)${t.path}/**/${names[0]}`, `:(glob)${t.path}/**/${names[0]}/**`] : [literal(t.path)]) ?? null;
    if (n === null ? !(plain ? madeName(names[0]!) : madeName(t.shown)) : n >= 1)
      out.push({ rule: "destroys", why: `${verb} what find matches under ${t.shown}${plain ? ` (${names[0]})` : ""}, ${n === null ? "which is not known to be build output" : "files git does not ignore among them"}` });
  }
  return out;
}

// A redirect that empties a file outside the session's folder with nothing written to it (`> f`, `: > f`).
// Inside the folder it is how a file is started, and asks as any write does.
function emptied(s: Simple, run: Run, dir: string | null, w: Where, vals: Values, at: number): Risk[] {
  if (!s.redirects || (run.words.length && !/^(:|true)$/.test(run.words[0]!))) return [];
  const out: Risk[] = [];
  for (const m of s.text.matchAll(/(?:^|[^>&\d])>\|?\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) {
    const word = m[1]!.replace(/^(["'])(.*)\1$/s, "$2");
    const t = target(word, /[$`]/.test(word) ? { one: true, lead: "", subs: [[]], vars: [], rest: false } : undefined, dir, w, vals, at);
    if ("unread" in t) out.push({ rule: "destroys", why: `empties a file the command does not spell out (${word})` });
    else if ("place" in t && t.place !== "scratch" && t.place !== "inside" && !t.path.startsWith("/dev/")) out.push({ rule: "destroys", why: `empties ${t.shown}, outside the session's folder` });
  }
  return out;
}

// git's own ways to lose work that the older rules (shell.highRisk) do not name.
const GIT_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/;
function gitParts(words: string[]): { sub: string; args: string[]; set: string[] } | null {
  const set: string[] = [];
  let i = 1;
  for (; i < words.length && words[i]!.startsWith("-"); i++) {
    if (words[i] === "-c" && words[i + 1] !== undefined) set.push(words[i + 1]!);
    if (GIT_VALUED.test(words[i]!)) i++;
  }
  return words[i] === undefined ? null : { sub: words[i]!, args: words.slice(i + 1), set };
}
// The settings whose value names a program git runs, or where it sends what it fetches and pushes.
const CODE_KEYS = new Set(["core.hookspath", "core.fsmonitor", "core.sshcommand", "core.editor", "core.pager", "core.askpass", "core.gitproxy", "core.alternaterefscommand", "credential.helper", "url.insteadof",
  "url.pushinsteadof", "diff.external", "diff.textconv", "diff.command", "merge.driver", "filter.clean", "filter.smudge", "filter.process", "gpg.program", "sequence.editor", "init.templatedir", "include.path",
  "includeif.path", "http.proxy", "remote.uploadpack", "remote.receivepack", "remote.proxy", "submodule.update", "man.cmd", "browser.cmd", "web.browser", "difftool.cmd", "mergetool.cmd", "trailer.command",
  "interactive.difffilter", "sendemail.sendmailcmd", "sendemail.smtpserver", "protocol.allow", "ssh.variant"]);
function codeKey(key: string): boolean {
  const k = key.toLowerCase();
  const first = k.indexOf("."), last = k.lastIndexOf(".");
  if (first < 0) return false;
  const section = k.slice(0, first);
  return section === "alias" || section === "pager" || CODE_KEYS.has(`${section}.${k.slice(last + 1)}`);
}
function gitRisks(words: string[]): Risk[] {
  const g = gitParts(words);
  if (!g) return [];
  const out: Risk[] = [];
  for (const kv of g.set) { const key = kv.slice(0, kv.indexOf("=") < 0 ? kv.length : kv.indexOf("=")); if (codeKey(key)) out.push({ rule: "hidden", why: `runs git with ${key} set for this one call: git runs the program it names` }); }
  const { sub, args } = g;
  const has = (re: RegExp) => args.some((a) => re.test(a));
  if (sub === "filter-branch" || sub === "filter-repo") out.push({ rule: "destroys", why: "rewrites the repository's history" });
  else if (sub === "stash" && (args[0] === "drop" || args[0] === "clear")) out.push({ rule: "destroys", why: "deletes stashed work" });
  else if (sub === "reflog" && (args[0] === "expire" || args[0] === "delete")) out.push({ rule: "destroys", why: "removes what git keeps to bring lost commits back" });
  else if (sub === "worktree" && args[0] === "remove" && has(/^(-f|--force)$/)) out.push({ rule: "destroys", why: "removes a worktree with whatever is uncommitted in it" });
  else if (sub === "branch" && (has(/^-[a-zA-Z]*D/) || (has(/^(-d|--delete)$/) && has(/^(-f|--force)$/)))) {
    // A branch a release or deploy line is named by, or one the command does not spell out.
    const named = args.filter((a) => !a.startsWith("-"));
    const hit = named.find((b) => /[$`*?]/.test(b) || protectedBranch(b, null));
    if (hit) out.push({ rule: "destroys", why: `deletes the branch ${hit} whether or not it is merged` });
  } else if (sub === "config") {
    // A read names no value; a write names the key and its value.
    if (has(/^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all|--remove-section|--rename-section|-e|--edit)$/) || /^(get|list|unset|remove-section|rename-section|edit)$/.test(args[0] ?? "")) return out;
    const named = args.filter((a, k) => !a.startsWith("-") && !/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(args[k - 1] ?? "") && !(k === 0 && a === "set"));
    if (named.length >= 2 && codeKey(named[0]!)) {
      const wide = has(/^--(global|system)$/);
      out.push({ rule: "machine", why: `sets ${named[0]}${wide ? " for every repository of the user" : ""}: git runs the program it names, later and outside any sandbox` });
    }
  }
  return out;
}

// ---- class: remote ----

const REMOTE_SPEC = /^[A-Za-z0-9_.@-]+:(?!\/\/)/;
const SSH_VALUED = /^-[bcDEeFIiJLlmOoPpQRSWw]$/;
// The command ssh runs there: null when it only opens a shell.
function sshCommand(args: string[]): { host: string; command: string[] } | null {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) { if (args[i] === "--") { i++; break; } if (SSH_VALUED.test(args[i]!)) i++; }
  const host = args[i];
  if (host === undefined) return null;
  const command = args.slice(i + 1);
  if (command[0] === "--") command.shift();
  return { host, command };
}

// Verbs that delete in the clients of clusters, clouds and hosted services.
const SERVICE = new Set(["aws", "gcloud", "gsutil", "bq", "az", "doctl", "flyctl", "fly", "heroku", "vercel", "netlify", "wrangler", "supabase", "firebase", "railway", "render", "hcloud", "linode-cli", "oci",
  "ibmcloud", "scw", "gh", "glab", "kubectl", "oc", "helm", "vault", "consul", "etcdctl", "nomad", "argocd", "pulumi", "cdk", "serverless", "sls", "sam", "amplify"]);
const GONE = /^(delete|destroy|terminate|remove|rm|rb|purge|drop|uninstall|deregister|teardown|drain|wipe)$|^(delete|terminate|destroy|remove|purge|deregister)-|:(destroy|delete|reset|remove|drop)$/;
// What puts something where others take it from, by program and the words after it.
const PUBLISH: [RegExp, RegExp][] = [
  [/^(npm|pnpm|yarn|bun|cargo|poetry|flit|hatch|uv|vsce|ovsx|jsr|deno|lerna|changeset|amplify)$/, /^(publish|unpublish|deprecate|yank)$/],
  [/^(twine)$/, /^upload$/], [/^(gem|helm|docker|podman|nuget)$/, /^push$/], [/^(mvn|mvnw)$/, /^(deploy|release:perform)$/], [/^(gradle|gradlew)$/, /^publish/],
  [/^(goreleaser)$/, /^release$/], [/^(semantic-release|release-it|np|surge)$/, /^/], [/^(vercel|netlify|fly|flyctl|wrangler|firebase|serverless|sls|sam|cdk|gcloud|heroku|railway|render|cap|kamal)$/, /^(deploy|publish|promote|container:release)$/],
];
const NAMED_DEPLOY = /(^|[^a-z0-9])(deploy|publish)([^a-z0-9]|$)/i;
const SHELLS = /^(sh|bash|zsh|dash|ksh|fish)$/;
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|bun|deno|perl|ruby|php)$/;
const SQL = /^(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|clickhouse|duckdb|cockroach|snowsql|mongosh|mongo|redis-cli|cqlsh|turso)$/;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

// A statement that drops or empties what a database holds: DDL, and DELETE or UPDATE with no WHERE.
function sqlLoss(text: string): string | null {
  for (const st of text.split(";")) {
    if (/\bDROP\s+(DATABASE|SCHEMA|TABLE|VIEW|INDEX|ROLE|USER|KEYSPACE|COLLECTION|TRIGGER|FUNCTION)\b/i.test(st)) return "drops";
    if (/\bTRUNCATE\b/i.test(st) || /\bFLUSH(ALL|DB)\b/i.test(st)) return "empties";
    if (/\bALTER\s+TABLE\b/i.test(st) && /\bDROP\b/i.test(st)) return "drops";
    if ((/\bDELETE\s+FROM\b/i.test(st) || (/\bUPDATE\b/i.test(st) && /\bSET\b/i.test(st))) && !/\bWHERE\b/i.test(st)) return "changes every row of";
    if (/\.(drop|dropDatabase|deleteMany|remove)\s*\(/.test(st)) return "drops";
  }
  return null;
}

function remote(run: Run, s: Simple, fed: string): Risk[] {
  const [prog, ...args] = run.words;
  const p = name(prog);
  const plain = args.filter((a) => !a.startsWith("-"));
  const add = (why: string): Risk[] => [{ rule: "remote", why }];
  const dynamic = (s.dyn ?? []).some((n) => n > run.at);
  if (p === "ssh") {
    const c = sshCommand(args);
    if (!c) return [];
    // A script handed to it on its input runs there too.
    if (!c.command.length) return fed ? add(`runs a script on another machine (${c.host})`) : [];
    const text = c.command.join(" ");
    if (dynamic && /\$\(\.\.\.\)|`\.\.\.`/.test(text)) return add(`runs on another machine (${c.host}) a command the line builds as it runs`);
    return text.length <= SCRIPT_MAX && readOnlyCommand(text) ? [] : add(`runs a command on another machine (${c.host}) that can change things there, where nothing holds it`);
  }
  if ((p === "kubectl" || p === "oc") && plain[0] === "exec") {
    const dd = args.indexOf("--");
    const text = dd < 0 ? "" : args.slice(dd + 1).join(" ");
    return text && text.length <= SCRIPT_MAX && readOnlyCommand(text) ? [] : add("runs a command in a cluster's container that can change things there");
  }
  if (/^(terraform|tofu|terragrunt)$/.test(p)) {
    if (plain[0] === "destroy" || (plain[0] === "apply" && args.some((a) => /^--?(auto-approve|destroy)$/.test(a))) || (plain[0] === "state" && plain[1] === "rm") || (plain[0] === "workspace" && plain[1] === "delete") || plain[0] === "force-unlock")
      return add(`changes or destroys infrastructure (${p} ${plain[0]}${plain[0] === "apply" ? ", with no plan to read first" : ""})`);
    return [];
  }
  if (p === "pulumi" && plain[0] === "up" && args.some((a) => /^(-y|--yes)$/.test(a))) return add("changes infrastructure (pulumi up, with no plan to read first)");
  if (p === "docker" || p === "podman") {
    if (plain[0] === "system" && plain[1] === "prune") return [{ rule: "destroys", why: `removes every unused container, image and network of ${p}` }];
    if (plain[0] === "volume" && /^(rm|prune|remove)$/.test(plain[1] ?? "")) return [{ rule: "destroys", why: `removes ${p} volumes, and the data in them` }];
    if (plain.includes("down") && /^(compose|docker-compose)$/.test(plain[0] ?? "") && args.some((a) => /^(-v|--volumes)$/.test(a))) return [{ rule: "destroys", why: "removes the volumes of the services, and the data in them" }];
  }
  if (SQL.test(p) || p === "dropdb" || p === "dropuser" || (p === "mysqladmin" && plain.includes("drop"))) {
    const loss = SQL.test(p) ? sqlLoss(`${args.join(" ")};${fed}`) : "drops";
    if (!loss) return [];
    return [{ rule: p === "sqlite3" || p === "duckdb" ? "destroys" : "remote", why: `${loss} a table or a database (${p})` }];
  }
  if (/^(prisma|rails|rake|artisan|manage\.py|supabase|drizzle-kit)$/.test(p) || (INTERPRETERS.test(p) && /(^|\/)(manage\.py|artisan)$/.test(plain[0] ?? ""))) {
    if (plain.some((a) => /^(db:drop|db:reset|db:wipe|migrate:fresh|migrate:reset|flush|sqlflush)$/.test(a)) || (plain.includes("reset") && plain.some((a) => /^(migrate|db)$/.test(a))) || args.includes("--force-reset"))
      return add("resets a database: what it holds is dropped");
  }
  if (SERVICE.has(p)) {
    const verb = plain.slice(0, 4).find((a) => GONE.test(a));
    if (verb) return add(`deletes on a service what nothing here brings back (${[p, ...plain.slice(0, plain.indexOf(verb) + 1)].join(" ")})`);
    if (p === "aws" && args.includes("--delete")) return add("deletes in the bucket what the source does not hold (aws --delete)");
    if (p === "gh" && plain[0] === "api" && args.some((a, k) => /^DELETE$/i.test(a) && /^(-X|--method)$/.test(args[k - 1] ?? "") || /^(-XDELETE|--method=DELETE)$/i.test(a))) return add("deletes on the service (gh api DELETE)");
    if (p === "gh" && plain[0] === "repo" && (plain[1] === "archive" || (plain[1] === "edit" && args.some((a) => a.startsWith("--visibility"))))) return add(`changes who can see or use the repository (gh repo ${plain[1]})`);
    if (p === "gh" && plain[0] === "release" && /^(create|upload|edit)$/.test(plain[1] ?? "")) return add("publishes a release");
  }
  for (const [who, what] of PUBLISH) if (who.test(p) && (what.source === "^" || plain.slice(0, 3).some((a) => what.test(a)))) return add(`publishes or deploys where others take it from, which cannot be taken back (${`${p} ${plain.find((a) => what.test(a)) ?? ""}`.trim()})`);
  if (INTERPRETERS.test(p) && plain[0] === "twine" && plain[1] === "upload") return add("publishes a package (twine upload)");
  // A deploy or publish script of the project: what it does elsewhere is not in the command.
  const script = SHELLS.test(p) ? !args.some((a) => /^-[a-zA-Z]*c$/.test(a)) : INTERPRETERS.test(p) && inline(p, args) === null;
  const step = /^(make|gmake|just|task|rake|invoke)$/.test(p) ? args.find((a, k) => !a.startsWith("-") && !/^-[CfIoWl]$/.test(args[k - 1] ?? "") && !a.includes("=") && NAMED_DEPLOY.test(a))
    : /^(npm|pnpm|yarn|bun)$/.test(p) ? (plain[0] === "run" || plain[0] === "run-script" ? plain[1] : p === "npm" ? undefined : plain[0])
    : script ? plain[0] : prog!.includes("/") ? prog : undefined;
  if (step && NAMED_DEPLOY.test(name(step))) return add(`runs ${name(step)}, a deploy or publish step of the project: what it does on other machines is not in the command`);
  // A request that deletes.
  if (/^(curl|wget|http|https|xh)$/.test(p)) {
    const del = args.some((a, k) => (/^DELETE$/i.test(a) && (/^(-X|--request)$/.test(args[k - 1] ?? "") || k === 0)) || /^(-XDELETE|--request=DELETE|--method=DELETE)$/i.test(a));
    if (del) {
      const url = args.find((a) => /^https?:\/\//i.test(a));
      const host = url?.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
      if (!LOCAL_HOST.test(host)) return add(`sends a DELETE request to ${host || "an address the command does not spell out"}`);
    }
  }
  return [];
}

// ---- class: exposes ----

// A file that holds credentials, by its name: environment files, keys, token and credential stores.
export function secretFile(word: string): boolean {
  const p = named(word);
  const b = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  if (!b || /\.(example|sample|template|dist|defaults?|pub)$/.test(b)) return false;
  return /^\.env(\.|$)/.test(b) || /\.env$/.test(b) || /^\.?(netrc|npmrc|pypirc|git-credentials|htpasswd|vault-token|pgpass)$/.test(b) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(b)
    || /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfstate|tfvars)$/.test(b) || /^(credentials?|secrets?|kubeconfig|tokens?)(\.[a-z0-9]+)?$/.test(b)
    || (/^service[-_]?account/.test(b) && b.endsWith(".json")) || /[-_.](secrets?|credentials?)\.(json|ya?ml|toml|env|txt|ini)$/.test(b) || CRED_PATH.test(word);
}
// The file in a word that hands one over: @file, name=@file;type=x, --option=file.
function named(word: string): string {
  const eq = /^[\w.-]*=/.exec(word);
  const rest = (eq ? word.slice(eq[0].length) : word).replace(/^[@<]/, "");
  const end = rest.indexOf(";");
  return end < 0 ? rest : rest.slice(0, end);
}
const SENDS = /^(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|tftp|rsync|http|https|xh|rclone|mail|mailx|mutt|sendmail|telnet|ssh|websocat|croc|wormhole|gsutil|aws|az)$/;
// Options whose file is what the program proves itself with, not what it sends.
const PROVES = /^(-i|--key|--cert|--cacert|--capath|--netrc-file|--identity)$/;
const PROVES_SSH = /^(-F|-o|-J|-S)$/, PROVES_CURL = /^(-E|-K|--config)$/;
function sends(run: Run): boolean {
  const p = name(run.words[0]);
  if (!SENDS.test(p)) return false;
  const args = run.words.slice(1);
  if (p === "scp" || p === "rsync") return args.some((a) => !a.startsWith("-") && (REMOTE_SPEC.test(a) || a.startsWith("rsync://")));
  if (p === "aws") return args[0] === "s3" && /^(cp|sync|mv)$/.test(args[1] ?? "");
  if (p === "gsutil") return args.some((a) => /^(cp|rsync|mv)$/.test(a));
  if (p === "az") return args.includes("upload") || args.includes("upload-batch");
  return true;
}
// Options whose file is written, not sent.
const WRITES = /^(-o|--output|-O|--output-document|-D|--dump-header|-c|--cookie-jar|-P|--directory-prefix)$/;
function exposes(run: Run, s: Simple, chain: Simple[]): Risk[] {
  if (!sends(run)) return [];
  const p = name(run.words[0]);
  let args = run.words.slice(1);
  // A copy to another machine sends its sources; one from there sends nothing. What follows ssh's host runs there.
  if (p === "scp" || p === "rsync") {
    const named = args.filter((a) => !a.startsWith("-"));
    if (!REMOTE_SPEC.test(named.at(-1) ?? "") && !(named.at(-1) ?? "").startsWith("rsync://")) return [];
    args = args.filter((a) => a !== named.at(-1) && !REMOTE_SPEC.test(a));
  } else if (p === "ssh") args = [];
  const proves = (o: string) => PROVES.test(o) || WRITES.test(o) || (/^(ssh|scp|sftp|rsync)$/.test(p) ? PROVES_SSH.test(o) : p === "curl" && PROVES_CURL.test(o));
  const mine = args.find((a, k) => !proves(args[k - 1] ?? "") && !/^-[a-zA-Z]$/.test(a) && !/^--(output|output-document|cookie-jar|dump-header)=/.test(a) && secretFile(a)) ?? s.inputs?.find(secretFile);
  // What an earlier stage of the pipeline reads, this one sends.
  const piped = mine ? undefined : chain.flatMap((c) => [...c.words.slice(1), ...(c.inputs ?? [])]).find(secretFile);
  const file = mine ?? piped;
  return file ? [{ rule: "exposes", why: `sends ${named(file)}, a file that holds credentials, to another machine` }] : [];
}

// ---- class: hidden ----

const LOADS = new Set(["LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "PROMPT_COMMAND", "PERL5OPT", "RUBYOPT", "PYTHONSTARTUP"]);
const FOUND_IN = new Set(["PATH", "LD_LIBRARY_PATH", "PYTHONPATH", "NODE_PATH", "PERL5LIB", "RUBYLIB"]);
const ANYONE = /^\/(tmp|var\/tmp|dev\/shm)(\/|$)/;
function loaded(set: string[]): Risk[] {
  const out: Risk[] = [];
  for (const kv of set) {
    const eq = kv.indexOf("=");
    const n = kv.slice(0, eq), v = kv.slice(eq + 1);
    if (!v) continue;
    if (LOADS.has(n) || (n === "NODE_OPTIONS" && /(^|\s)(-r|--require|--import|--loader|--experimental-loader)\b/.test(v))) out.push({ rule: "hidden", why: `sets ${n}, which loads code into the programs the command starts` });
    else if (FOUND_IN.has(n)) { const dir = v.split(":").find((d) => ANYONE.test(d)); if (dir) out.push({ rule: "hidden", why: `puts ${dir}, a folder anyone can write, on ${n}: what the command runs is found there first` }); }
  }
  return out;
}

// Programs whose output is text someone else wrote or encoded: evaluating it runs what is not in the command.
const CARRIES = /^(echo|printf|cat|base64|base32|xxd|openssl|curl|wget|gunzip|zcat|gzip|tr|rev|sed|awk|cut|head|tail|tee|jq|python[0-9.]*|node|perl|ruby)$/;
const FETCHES = /^(curl|wget|aria2c|http|xh)$/;
const CODE_DELETES = /\b(shutil\.rmtree|rmtree|os\.(remove|unlink|rmdir|removedirs|truncate)|rmSync|rmdirSync|unlinkSync|fs\.(rm|unlink|rmdir|truncate)|Deno\.remove|FileUtils\.rm|File\.(delete|unlink)|rimraf)\b|\bunlink\b|\brm\s+-[a-zA-Z]*[rRf]/;
const CODE_EVALS = /\b(exec|eval|Function|compile)\s*\(|\bnew\s+Function\b/;
const CODE_SOURCE = /https?:\/\/|urlopen|urllib|requests\.|\bfetch\s*\(|b64decode|\batob\s*\(|base64|fromhex|unhexlify|marshal|pickle|codecs\.decode/;
const CODE_PIPES = /\|\s*(sh|bash|zsh|python3?)\b/;
// What code given to an interpreter does that the rules can see in its text.
function codeRisks(prog: string, code: string): Risk[] {
  if (CODE_DELETES.test(code)) return [{ rule: "destroys", why: `deletes files from code given to ${prog}, which no rule reads as a command` }];
  if ((CODE_EVALS.test(code) && CODE_SOURCE.test(code)) || CODE_PIPES.test(code)) return [{ rule: "hidden", why: `gives ${prog} code that runs what it fetches or decodes` }];
  return [];
}
// The code an interpreter is given on its command line.
function inline(p: string, args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!a.startsWith("-")) return p === "deno" && a === "eval" ? args[k + 1] ?? null : null;
    if (/^python/.test(p) ? /^-[A-Za-z]*c$/.test(a) : p === "php" ? a === "-r" : /^(node|nodejs|bun)$/.test(p) ? /^(-e|-p|-pe|--eval|--print)$/.test(a) : /^-[A-Za-z0-9]*e$/.test(a)) return args[k + 1] ?? null;
    if ((p === "perl" || p === "ruby") && /^-[A-Za-z0-9]*e./.test(a)) return a.slice(a.indexOf("e") + 1);
  }
  return null;
}

// An install whose source is an address the command names (a URL, a git
// repository), not a name in the registry the project is set up with: what it
// fetches and runs is whatever that address serves. A package named from the
// registry is in the command for the owner to read, and asks as any command.
const INSTALLERS = /^(npm|pnpm|yarn|bun|pip|pip3|pipx|uv|poetry|pdm|cargo|gem)$/;
const ADDRESS = /^(git\+|git:\/\/|https?:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:)/i;
function fetched(words: string[]): Risk[] {
  const [prog, ...args] = words;
  const p = INTERPRETERS.test(name(prog)) && args[0] === "-m" && args[1] === "pip" ? "pip" : name(prog);
  if (!INSTALLERS.test(p) || !args.some((a) => /^(install|i|add|dlx|create|exec|x)$/.test(a))) return [];
  const from = args.find((a, k) => ADDRESS.test(a) && (!(args[k - 1] ?? "").startsWith("-") || args[k - 1] === "--git"));
  return from ? [{ rule: "hidden", why: `installs from ${from.slice(0, 120)}, an address the command names and not the project's registry: what it serves runs unread` }] : [];
}

// ---- class: machine ----

// Names a signal by name reaches far beyond one session: runtimes, shells, the harness, the desktop.
const WIDE_NAMES = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "java", "php", "dotnet", "bash", "sh", "zsh", "fish", "dash", "ksh", "ssh", "sshd", "tmux", "screen", "keel",
  "claude", "codex", "electron", "code", "chrome", "chromium", "firefox", "docker", "dockerd", "containerd", "podman", "systemd", "init", "xorg", "xwayland", "gnome-shell", "dbus-daemon"]);
const PKILL_VALUED = /^(-[gGPstuUcFN]|--signal|--pgroup|--group|--parent|--session|--terminal|--euid|--uid|--pidfile|--ns|--nslist|--runstates)$/;
// Why a pkill, killall or pgrep pattern reaches too far, or null.
function wide(p: string, args: string[]): string | null {
  const named: string[] = [];
  let whose = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (/^(-u|-U|--euid|--uid)$/.test(a)) whose = true;
    if (PKILL_VALUED.test(a)) { k++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    named.push(a);
  }
  if (!named.length) return whose ? "every process of a user" : null;
  for (const n of named) {
    const bare = n.replace(/^\^/, "").replace(/\$$/, "").toLowerCase();
    if (!bare || /^[.*]+$/.test(bare) || WIDE_NAMES.has(bare)) return `every process ${p === "killall" ? "named" : "that matches"} ${n || "anything"} on this machine, other sessions' and the harness's own among them`;
  }
  return null;
}
function machine(run: Run, s: Simple): Risk[] {
  const [prog, ...args] = run.words;
  const p = name(prog);
  const add = (why: string): Risk[] => [{ rule: "machine", why }];
  if (p === "kill") {
    let k = 0;
    if (/^-(s|n)$/.test(args[0] ?? "")) k = 2; else if (/^-[A-Za-z0-9]+$/.test(args[0] ?? "") && args[0] !== "-l" && args[0] !== "-L") k = 1;
    if (args[k] === "--") k++;
    if (args.slice(k).includes("-1")) return add("signals every process the user can reach");
    // The ids another command finds by name.
    for (const m of s.how ?? []) for (const sub of m.subs) for (const inner of sub) {
      const r = unwrap(inner.words).words;
      const why = /^(pgrep|pidof)$/.test(name(r[0])) ? wide(name(r[0]), r.slice(1)) : null;
      if (why) return add(`signals ${why}`);
    }
    return [];
  }
  if (p === "pkill" || p === "killall") { const why = wide(p, args); return why ? add(`signals ${why}`) : []; }
  if (p === "killall5") return add("signals every process on the machine");
  if (p === "tmux" && args.includes("kill-server")) return add("ends every tmux session of the user, and what runs in them");
  if (p === "loginctl" && args.some((a) => /^(terminate-user|kill-user|terminate-session|kill-session)$/.test(a))) return add("ends a login session and everything in it");
  if (p === "systemctl" && args.some((a) => /^(poweroff|reboot|halt|suspend|hibernate|kexec|emergency|rescue)$/.test(a))) return add("stops the machine");
  if (p === "crontab") {
    const plain = args.filter((a, k) => !(a.startsWith("-") && a !== "-") && args[k - 1] !== "-u");
    if (args.some((a) => /^-[a-z]*r/.test(a))) return add("removes every scheduled job of the user");
    if (plain.length) return add("replaces the user's scheduled jobs, which run later outside any sandbox");
  }
  if ((p === "at" || p === "batch") && !args.some((a) => /^-[lqrdc]/.test(a))) return add("schedules a command to run later, outside the session");
  return [];
}

// ---- the whole line ----

const piped = (p: Simple | undefined) => p?.sep === "|" || p?.sep === "|&";
// The stage of the pipeline before part `i`, when there is one.
function before(parts: Simple[], i: number): number {
  let j = i - 1;
  while (j >= 0 && (!!parts[j]!.nested !== !!parts[i]!.nested || parts[j]!.heredoc)) j--;
  return j >= 0 && piped(parts[j]) ? j : -1;
}
function chainOf(parts: Simple[], i: number): Simple[] {
  const out: Simple[] = [];
  for (let j = before(parts, i); j >= 0; j = before(parts, j)) out.push(parts[j]!);
  return out;
}
// Whether a shell or an interpreter reads its program from its input: it is given no script and no code.
const fromInput = (p: string, args: string[]) => inline(p, args) === null && (!args.some((a) => !a.startsWith("-")) || args.includes("-s") || args.includes("-")) && !(SHELLS.test(p) && args.some((a) => /^-[a-zA-Z]*c$/.test(a)));

// What the lines of a here-document are to the command they feed: a shell
// runs them, an interpreter or a database client reads them as its own
// language, anything else takes them as data. The feeder is looked for among
// the commands since the here-document before.
type Fed = { as: "shell" | "code" | "sql" | "data"; by: string };
function feeds(parts: Simple[]): (Fed | undefined)[] {
  const out: (Fed | undefined)[] = [];
  let since = 0;
  let fed: Fed = { as: "data", by: "" };
  parts.forEach((s, i) => {
    if (!s.heredoc) { if (parts[i - 1]?.heredoc) since = i; return; }
    if (!parts[i - 1]?.heredoc) {
      fed = { as: "data", by: "" };
      for (const c of parts.slice(since, i)) {
        const run = unwrap(c.words);
        const p = name(run.words[0]), args = run.words.slice(1);
        if ((SHELLS.test(p) && fromInput(p, args)) || p === "ssh" || p === "su" || ((p === "kubectl" || p === "docker" || p === "podman") && args.includes("exec"))) { fed = { as: "shell", by: p }; break; }
        if (INTERPRETERS.test(p) && fromInput(p, args)) fed = { as: "code", by: p };
        else if (SQL.test(p) && fed.as === "data") fed = { as: "sql", by: p };
      }
    }
    out[i] = fed;
  });
  return out;
}

const OLD = (why: string): RiskRule => (/^runs as root|^stops the machine/.test(why) ? "machine" : /remote/.test(why) ? "remote" : /downloaded/.test(why) ? "hidden" : "destroys");
const lossOf = (by: string, loss: string): Risk => ({ rule: by === "sqlite3" || by === "duckdb" ? "destroys" : "remote", why: `${loss} a table or a database (${by})` });

// Each part's risks, in the order of the parts, and the line's own.
export function analyse(parts: Simple[], w: Where, depth = 0): { per: Risk[][]; line: Risk[] } {
  const known = valuesOf(parts);
  const at = dirsOf(parts, w.cwd, w.home);
  const fed = feeds(parts);
  const per: Risk[][] = parts.map(() => []);
  const line: Risk[] = [];
  const script = (text: string, dir: string | null, out: Risk[]) => {
    if (depth >= DEPTH) { out.push({ rule: "hidden", why: "nests scripts deeper than the rules read" }); return; }
    if (text.length > SCRIPT_MAX) { out.push({ rule: "hidden", why: `runs a nested script of ${text.length} characters, longer than the rules read through: put it in a file` }); return; }
    const inner = splitCommand(text);
    if (!inner) { out.push({ rule: "hidden", why: "runs a script the rules cannot split into its commands" }); return; }
    const r = analyse(inner, { ...w, cwd: dir ?? w.cwd, ...(dir ? {} : { lost: true as const }) }, depth + 1);
    out.push(...r.per.flat(), ...r.line);
  };
  parts.forEach((s, i) => {
    const out = per[i]!;
    const run = unwrap(s.words);
    const p = name(run.words[0]);
    const args = run.words.slice(1);
    const old = highRisk(s);
    if (old) out.push({ rule: OLD(old), why: old, ...(p === "git" ? { git: true as const } : {}) });
    // A line of a here-document that no shell runs: code is read for what it deletes or evaluates, SQL for what it drops.
    if (s.heredoc && fed[i]!.as !== "shell") {
      if (fed[i]!.as === "code") out.push(...codeRisks(fed[i]!.by, s.text));
      else if (fed[i]!.as === "sql") { const loss = sqlLoss(s.text); if (loss) out.push(lossOf(fed[i]!.by, loss)); }
      return;
    }
    if (run.deep) { out.push({ rule: "hidden", why: "starts its command through more wrappers than the rules read" }); return; }
    const dir = w.lost ? null : at[i]!;
    const vals = s.flow ? LOST : known;
    out.push(...loaded([...run.set, ...(/^(export|declare|typeset|readonly)$/.test(p) ? args.filter((a) => ASSIGN.test(a)) : [])]), ...emptied(s, run, dir, w, vals, i));
    // A part that only reads destroys and sends nothing.
    if (!run.words.length || isReadOnly(s.heredoc ? { ...s, heredoc: undefined } : s)) return;
    const chain = chainOf(parts, i);
    // The text handed to it on its input, where the line holds it: the here-document after it, or what echo before it prints.
    let text = "";
    for (let k = i + 1; k < parts.length && (parts[k]!.heredoc || parts[k]!.nested); k++) if (parts[k]!.heredoc) text += `${parts[k]!.text};`;
    if (chain[0] && /^(echo|printf)$/.test(name(chain[0].words[0]))) text += chain[0].words.slice(1).join(" ");
    out.push(...deletes(run, s, dir, w, vals, i, chain[0] ?? null), ...(p === "git" ? gitRisks(run.words) : []), ...remote(run, s, text), ...exposes(run, s, chain), ...fetched(run.words), ...machine(run, s));
    // A script given to a shell, or to eval, is read as the commands it holds.
    const made = (k: number) => s.how?.[s.dyn?.indexOf(run.at + 1 + k) ?? -1];
    if (SHELLS.test(p)) {
      const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
      if (c >= 0 && args[c + 1] !== undefined) script(args[c + 1]!, dir, out);
    } else if (p === "eval") {
      const dynamic = args.map((_, k) => made(k)).filter((m): m is Made => !!m);
      // The output of one program is that program's to answer for (eval "$(ssh-agent -s)"); text a decoder, a fetcher, echo or a variable carries is not in the command.
      const built = dynamic.flatMap((m) => m.subs).find((sub) => sub.length !== 1 || CARRIES.test(name(unwrap(sub[0]!.words).words[0])));
      if (built || dynamic.some((m) => m.vars.length || m.rest)) out.push({ rule: "hidden", why: `evaluates text the line builds as it runs${built ? ` (${built.map((b) => b.text).join(" | ").slice(0, 80)})` : ""}: what runs is not in the command` });
      else if (!dynamic.length && args.length) script(args.join(" "), dir, out);
    } else if ((p === "source" || p === ".") && args.some((a) => a.includes("$(...)"))) {
      // A file a substitution makes (source <(curl ...)): a downloaded script when a fetcher writes it.
      const fetcher = parts.slice(0, i).reverse().find((q) => q.nested && FETCHES.test(name(unwrap(q.words).words[0])));
      if (fetcher) out.push({ rule: "hidden", why: `runs a downloaded script (${fetcher.text.slice(0, 80)})` });
    } else if (INTERPRETERS.test(p)) {
      const code = inline(p, args);
      if (code !== null) out.push(...codeRisks(p, code));
    }
  });
  const whole = lineRisk(parts);
  if (whole) line.push({ rule: "hidden", why: whole });
  parts.forEach((s, i) => {
    if (s.heredoc) return;
    const run = unwrap(s.words);
    const p = name(run.words[0]);
    const args = run.words.slice(1);
    // A shell or an interpreter that reads its program from a pipe: what the stage before prints is what runs.
    const j = before(parts, i);
    if (!whole && j >= 0 && (SHELLS.test(p) || INTERPRETERS.test(p)) && fromInput(p, args)) {
      const from = parts[j]!;
      const src = unwrap(from.words).words;
      // What echo prints is in the command: read it as the script it is.
      if (/^(echo|printf)$/.test(name(src[0])) && !from.dyn && before(parts, j) < 0 && SHELLS.test(p)) script(src.slice(1).join(" "), w.lost ? null : at[i]!, line);
      else line.push({ rule: "hidden", why: `runs in ${p} what \`${from.text.slice(0, 60)}\` prints: its text is not in the command` });
    }
    // A file the line downloads and then runs.
    if (FETCHES.test(p)) {
      const url = args.find((a) => /^https?:\/\//i.test(a))?.split(/[?#]/)[0];
      const o = args.findIndex((a) => /^(-o|--output|-O|--output-document)$/.test(a));
      const to = o < 0 ? (p === "wget" ? url : undefined) : args[o] === "-O" && p === "curl" ? url : args[o + 1];
      const file = name(to);
      const runs = (q: Simple) => { const r = unwrap(q.words).words; const n = name(r[0]); return n === file || ((SHELLS.test(n) || INTERPRETERS.test(n) || n === "source" || n === ".") && !(SHELLS.test(n) && r.includes("-n")) && r.slice(1).some((a) => name(a) === file)); };
      if (file && parts.slice(i + 1).some(runs)) line.push({ rule: "hidden", why: `runs ${file}, a script the same line downloads` });
    }
  });
  return { per, line };
}

// Every reason the line is high risk, each once.
export function risksOf(parts: Simple[], w: Where): Risk[] {
  const { per, line } = analyse(parts, w);
  const seen = new Set<string>();
  return [...per.flat(), ...line].filter((r) => !seen.has(r.why) && !!seen.add(r.why));
}

// The pathspecs the rules would ask git about for this line: the gate reads
// the answers before it decides, so the decision itself waits for nothing.
export function keptAsks(parts: Simple[], w: Omit<Where, "kept">): string[][] {
  const asked: string[][] = [];
  analyse(parts, { ...w, kept: (specs) => { asked.push(specs); return null; } });
  return asked;
}
