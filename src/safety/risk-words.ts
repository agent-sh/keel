// How the risk classes (risk.ts) read a command's words: the command a part
// really runs, past the programs that only start another; the folder each
// part runs in; the variables the line itself gives a value; and where a
// path lands. Pure functions over the parser's parts (shell.ts).
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Looked } from "./looked.ts";
import type { Made, Simple } from "./shell.ts";

export type RiskRule = "destroys" | "remote" | "exposes" | "hidden" | "machine";
// `git`: one of the git forms the full-auto rules can settle from the repository's state (autonomy.preAllow).
// `said`: the reason is itself a few words, and is what the ask says for its rule (the older rules of shell.ts).
export type Risk = { rule: RiskRule; why: string; git?: true; said?: true };

// Where the command runs, and what is known of the disk there.
// `looked`: this machine's disk, asked before the decision (looked.ts); without it a delete inside the folder is
// judged by the names of what it deletes. `land`: where a path lands, its links followed (policy.ts Facts.own): a
// path counts as inside the folder or a temporary one only when every place it lands is. `sandboxed`: the
// session's commands are confined to its folder, so a write outside it fails by itself. `lost`: the folder the
// commands run in is not known (a script nested under a cd the rules cannot follow). `away`: they run on another
// machine or in a container (its name): nothing there is the session's own, and no relative path is known.
// `firm`: for each part, whether the folder it runs in is certain (firmOf). `shaky`: the folder this script starts
// in is not.
export type Where = { cwd: string; home: string; workspace: string; scratch?: string[]; looked?: Looked; land?: (p: string) => string[]; sandboxed?: boolean; lost?: true; away?: string; firm?: boolean[]; shaky?: true };

// Each class in a few words: what the ask carries as its rule, and a folded call is marked with in the transcript.
export const RULE_WORDS: Record<RiskRule, string> = {
  destroys: "destroys work or data", remote: "changes another machine or a service", exposes: "sends credentials out",
  hidden: "runs code that is not in the command", machine: "reaches past the session on this machine",
};

// The budgets of one decision. A line past one of them is "longer than the rules read": high risk, said at once.
export const DEPTH = 8; // nested scripts read through; deeper is not read, and says so
export const PARTS_MAX = 4_096; // commands of one line (the lines of a here-document are text, and not counted)
export const PATH_MAX = 4_096; // characters of a folder a chain of cds is followed to
export const WORDS_MAX = 1_024; // paths one command writes or deletes
// A nested script longer than this is not read through either: reading one costs as much as reading the line it is
// in, and the line is read once.
export const SCRIPT_MAX = 4_000;

export const SHELLS = /^(sh|bash|zsh|dash|ksh|fish|ash)$/;
export const INTERPRETERS = /^(python[0-9.]*|node|nodejs|bun|deno|perl|ruby|php)$/;
export const GLOB = /[*?[]/;
// Whether the session's sandbox is what stops a write to this path: the session is confined, the path is surely
// outside its folder (Target.sure), and it is no part of a repository's own data (a linked worktree's sandbox lets git's shared stores
// be written). Such a write fails by itself, so nothing is asked for it. A temporary folder, the session's own
// folder and what holds it are never this.
export function confined(t: { path: string; place: string; sure?: boolean }, w: Where): boolean {
  if (!w.sandboxed || w.away || !t.sure || (t.place !== "outside" && t.place !== "cache") || /(^|\/)\.git(\/|$)/.test(t.path)) return false;
  // (The kernel's own trees lead back in: /proc/self/cwd is the session's folder.)
  if (/^\/(proc|dev|sys)(\/|$)/.test(t.path)) return false;
  // (A temporary folder itself, or everything in it at once, is written in the sandbox too.)
  const at = t.path.search(GLOB);
  const fixed = at < 0 ? t.path : t.path.slice(0, t.path.lastIndexOf("/", at)) || "/";
  return !rootsOf(w).temps.some((r) => under(r, fixed));
}
// Programs that hand their command to a process that is not this one's child: a service manager, another
// terminal, a container's daemon, another account. What they start is not in the session's sandbox. With them
// the programs that give their command another root: a path there is not the path it says.
export const LEAVES = /^(systemd-run|tmux|screen|docker|podman|nerdctl|at|batch|sudo|doas|pkexec|su|runuser|machinectl|nsenter|flatpak-spawn|distrobox|toolbox|osascript|chroot|proot|fakechroot|bwrap|unshare|firejail)$/;
export const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const name = (w: string | undefined) => (w === undefined ? "" : w.slice(w.lastIndexOf("/") + 1));

// ---- the command a part really runs ----

// `at`: where its first word stands among the part's words. `set`: the
// variables given to it. `fed`: its arguments come from somewhere else
// (xargs, parallel, find -exec). `timed`: a wrapper that schedules it for
// later. `deep`: more wrappers than are read. `wrapped`: another program starts it.
export type Run = { words: string[]; at: number; set: string[]; fed?: "xargs" | "find"; find?: string[]; timed?: true; deep?: true; wrapped?: true };

// Each wrapper's options that take a value in the next word.
const VALUED: Record<string, RegExp> = Object.assign(Object.create(null), {
  env: /^(-u|--unset|-C|--chdir)$/, nice: /^(-n|--adjustment)$/, ionice: /^-[cnp]$/, timeout: /^(-s|--signal|-k|--kill-after)$/,
  stdbuf: /^-[ioe]$/, exec: /^-a$/, sudo: /^-[ugCDhprTR]$/, doas: /^-[uC]$/, chrt: /^-p$/, taskset: /^-c$/, watch: /^(-n|--interval|-d|--differences)$/,
  xargs: /^-[nLPsEdaI]$/, parallel: /^(-j|--jobs|-a|--arg-file|-S|--sshlogin|--colsep|-d|--delimiter|-I|-N|--max-args|--results|--joblog|--tmpdir|--timeout)$/,
  strace: /^-[oepsaEuPIbXSU]$/, ltrace: /^-[oepsanulAF]$/, flock: /^(-w|--timeout|-E|--conflict-exit-code)$/,
  "systemd-run": /^(-u|--unit|-p|--property|--description|--slice|-M|--machine|-H|--host|--working-directory|--uid|--gid|--nice|-E|--setenv|--on-active|--on-boot|--on-startup|--on-unit-active|--on-unit-inactive|--on-calendar|--timer-property)$/,
  uv: /^(--with|--with-editable|--with-requirements|--python|-p|--project|--directory|--env-file|--extra|--group|--index|--package|--isolated-from)$/,
  npm: /^(--prefix|-w|--workspace|-c|--call|--package|-p)$/, sshpass: /^-[pfdP]$/, direnv: /^$/, dotenv: /^(-e|-f|--file)$/, runuser: /^(-u|-g|-G|--user|--group)$/, screen: /^(-S|-L|-c|-e|-s|-T|-t|-p)$/,
});
export const WRAPPERS = new Set(["env", "nohup", "setsid", "nice", "ionice", "timeout", "stdbuf", "command", "builtin", "exec", "sudo", "doas", "time", "chrt", "taskset", "watch", "xargs", "parallel", "npx", "bunx",
  "busybox", "toybox", "coproc", "strace", "ltrace", "unshare", "fakeroot", "flock", "chronic", "systemd-run", "dotenv", "valgrind", "firejail", "proot", "runuser", "chroot", "faketime", "screen", "sshpass"]);
// Programs that start another after a word of their own: `bundle exec CMD`, `uv run CMD`.
const STARTS: Record<string, RegExp> = Object.assign(Object.create(null), { bundle: /^exec$/, npm: /^exec$/, pnpm: /^(exec|dlx)$/, yarn: /^(exec|dlx)$/, bun: /^x$/, uv: /^run$/, poetry: /^run$/, pipenv: /^run$/, pdm: /^run$/, direnv: /^exec$/, rye: /^run$/, hatch: /^run$/ });

// A path without the slashes it ends in. (A pattern for them reads a run of slashes in the middle of a word once
// for each of them.)
export function untrailed(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  return end === p.length ? p : p.slice(0, end);
}
// An option cluster (-fd) that holds the letter. (One pattern for it, -[a-z]*f[a-z]*, reads a long word that
// ends in something else once for each of its letters.)
export const cluster = (a: string, letter: string) => a[0] === "-" && a[1] !== "-" && a.includes(letter) && /^-[a-zA-Z]+$/.test(a);
const NONE: string[] = [];
export function unwrap(words: string[]): Run {
  // Most commands: a program that starts no other, with nothing set in front of it.
  const first = words[0];
  if (first !== undefined && !ASSIGN.test(first) && first !== "-p" && first !== "function" && first !== "find" && first !== "gdb" && first !== "lldb" && first !== "yarn" && first !== "pnpm" && !WRAPPERS.has(name(first)) && !(name(first) in STARTS)) return { words, at: 0, set: NONE };
  let at = 0;
  const set: string[] = [];
  let fed: Run["fed"];
  let timed: true | undefined;
  let wrapped: true | undefined;
  for (let n = 0; ; n++) {
    while (at < words.length && ASSIGN.test(words[at]!)) set.push(words[at++]!);
    // `time -p` (the parser takes `time` off), and a function's own first command: `function f { rm -rf x`.
    if (words[at] === "-p" && n === 0) at++;
    if (words[at] === "function" && words[at + 1] !== undefined) {
      at += 2;
      if (words[at] === "()") at++;
      if (words[at] === "{") at++;
      continue;
    }
    const prog = name(words[at]);
    // A debugger runs the program after --args (gdb) or after -- (lldb).
    if (prog === "gdb" || prog === "lldb") {
      const k = words.indexOf(prog === "gdb" ? "--args" : "--", at + 1);
      if (k < 0 || k + 1 >= words.length || n >= DEPTH) break;
      at = k + 1;
      wrapped = true;
      continue;
    }
    // A package manager run with a deleting program of the project as its word (yarn rimraf src): that program.
    if ((prog === "yarn" || prog === "pnpm") && /^(rimraf|del|del-cli|trash)$/.test(words[at + 1] ?? "") && n < DEPTH) { at += 1; wrapped = true; continue; }
    const starts = STARTS[prog]?.test(words[at + 1] ?? "");
    if (!WRAPPERS.has(prog) && !starts) break;
    if (n >= DEPTH) return { words: words.slice(at), at, set, fed, timed, deep: true, wrapped: true };
    let i = at + (starts ? 2 : 1);
    const valued = VALUED[prog];
    for (; i < words.length; i++) {
      const a = words[i]!;
      if (a === "--") { i++; break; }
      if (prog === "env" && ASSIGN.test(a)) { set.push(a); continue; }
      if (!a.startsWith("-") || a === "-") break;
      if (prog === "systemd-run" && /^--on-/.test(a)) timed = true;
      if (valued?.test(a)) i++;
    }
    // timeout's first operand is how long, flock's the lock, direnv's and chroot's the folder, faketime's the time;
    // command -v only asks what a name is.
    if (prog === "timeout" || prog === "flock" || prog === "chroot" || prog === "faketime" || (prog === "chrt" && !words.slice(at + 1, i).some((a) => /^-[a-zA-Z]*p/.test(a))) || (prog === "direnv" && starts)) i++;
    if (prog === "command" && /^-[pvV]*[vV]/.test(words[at + 1] ?? "")) break;
    if (prog === "xargs" || prog === "parallel") fed = "xargs";
    if (i >= words.length) break;
    at = i;
    wrapped = true;
  }
  const run = words.slice(at);
  // find runs what follows -exec, once for the paths it found.
  if (name(run[0]) === "find") {
    const x = run.findIndex((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir");
    if (x > 0 && run[x + 1]) {
      const end = run.findIndex((a, k) => k > x && (a === ";" || a === "+"));
      const inner = unwrap(run.slice(x + 1, end < 0 ? undefined : end));
      return { words: inner.words, at: at + x + 1 + inner.at, set: [...set, ...inner.set], fed: "find", find: run.slice(0, x), timed, deep: inner.deep, wrapped: true };
    }
  }
  return { words: run, at, set, fed, timed, wrapped };
}

// ---- the folder each part runs in ----

// A `cd` to a written-out path moves the commands after it; one the rules
// cannot read (a variable, `cd -`, popd) leaves the folder unknown from there
// on. A `cd` inside a subshell or a substitution moves nothing outside it,
// and inside it only the commands chained to it (`(cd ui && rm -rf dist)`):
// where the subshell ends is not known from the parts, so after the chain the
// folder of what is nested is unknown until the next command outside.
export function dirsOf(parts: Simple[], runs: Run[], cwd: string | null, home: string): (string | null)[] {
  // No part changes folder: every one runs where the line does.
  if (!runs.some((r) => r.words[0] === "cd" || r.words[0] === "pushd" || r.words[0] === "popd")) return new Array<string | null>(parts.length).fill(cwd);
  // A function the line gives the name: what `cd` does after it is not known, and no folder is followed.
  if (parts.some((s, i) => s.words.length === 1 && /^(cd|pushd|popd)$/.test(s.words[0]!) && !!parts[i + 1]?.flow && /^\{/.test(parts[i + 1]!.text))) return new Array<string | null>(parts.length).fill(null);
  let top: string | null = cwd;
  let inner: string | null | undefined; // undefined: nested parts run where the line is
  const to = (from: string | null, w: string[]): string | null | undefined => {
    if (w[0] !== "cd" && w[0] !== "pushd" && w[0] !== "popd") return undefined;
    const arg = w.slice(1).find((a) => !a.startsWith("-") || a === "-");
    if (w[0] === "popd" || arg === "-" || (arg !== undefined && (/[$`*?[\]{}]/.test(arg) || (arg.startsWith("~") && arg !== "~" && !arg.startsWith("~/"))))) return null;
    const path = arg === undefined || arg === "~" ? home : arg.startsWith("~/") ? home + arg.slice(1) : arg;
    const next = isAbsolute(path) ? resolve(path) : from === null ? null : resolve(from, path);
    // (A folder longer than a path can be is none: a chain of relative cds is not followed past it, so no later
    // reader resolves against a longer and longer one.)
    return next !== null && next.length > PATH_MAX ? null : next;
  };
  return parts.map((s, i) => {
    if (s.heredoc) return inner === undefined ? top : inner;
    if (!s.nested) {
      inner = undefined;
      const here = top;
      const next = to(top, runs[i]!.words);
      if (next !== undefined) top = next;
      return here;
    }
    const here = inner === undefined ? top : inner;
    const next = to(here, runs[i]!.words);
    if (next !== undefined) inner = s.sep === "&&" ? next : null;
    else if (inner !== undefined && s.sep !== "&&" && s.sep !== "||" && s.sep !== "|" && s.sep !== "|&") inner = null;
    return here;
  });
}

// For each part, whether the folder it runs in is certain. It is where the line starts until a `cd`; after one it
// is certain only for the commands joined to that `cd` by `&&` (they do not run where it failed), and only when
// the `cd` names its folder from the root or from a folder that was certain. Past any other separator the shell
// may be in the folder before the `cd`.
export function firmOf(parts: Simple[], runs: Run[], start = true): boolean[] {
  const out = new Array<boolean>(parts.length).fill(start);
  if (!runs.some((r) => r.words[0] === "cd" || r.words[0] === "pushd" || r.words[0] === "popd")) return out;
  let firm = start, moved = false;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!;
    out[i] = firm;
    if (s.heredoc || s.nested) continue;
    const w = runs[i]!.words;
    if (w[0] === "cd" || w[0] === "pushd" || w[0] === "popd") {
      const arg = w.slice(1).find((a) => !a.startsWith("-"));
      moved = true;
      firm = s.sep === "&&" && w[0] === "cd" && arg !== undefined && (arg.startsWith("/") || arg.startsWith("~/") || (firm && !/(^|\/)\.\.(\/|$)/.test(arg)));
    } else if (moved && s.sep !== "&&") firm = false;
  }
  return out;
}

// ---- variables the line itself gives a value ----

// A name is read as its value only when the line gives it one value, once, in
// a part of its own that always runs (`x=/srv; rm -rf $x/app`), and names it
// nowhere else as a word (read x, export x, unset x). A line that can give a
// name a value in a way its words do not show (eval, source, a name
// reference, a builtin that takes the name from an expansion) gives none.
// `made`: its value is the path mktemp just made, which holds nothing from
// before. `from`: the commands of the substitution that gave it its value.
export type Values = Map<string, { text?: string; made?: true; from?: Simple[]; at: number }>;
const WRITTEN = /^[A-Za-z0-9_.\/@:+,%^~-]*$/;
const BINDS = /^(read|declare|typeset|local|export|readonly|unset|printf|mapfile|readarray|getopts|let|wait|coproc|builtin|command|eval|source|\.)$/;
// After a loop, a conditional or a group, a name may hold something else (for x in ..., a branch that assigns): no
// variable is read as a value there, the ones the environment gives included.
export const LOST: Values = new Map();

export function valuesOf(parts: Simple[], runs: Run[]): Values {
  const out: Values = new Map();
  // A value is only ever read into a word an expansion makes: a line with none has none to read.
  if (!parts.some((p) => p.dyn || (p.redirects && p.text.includes("$")))) return out;
  const count = new Map<string, number>();
  const bare = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!, prog = name(runs[i]!.words[0]);
    if (/^(eval|source|\.|declare|typeset|local)$/.test(prog) || (p.dyn && BINDS.test(prog))) return out;
    for (const w of p.words) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|\[)/.exec(w);
      if (m) count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1);
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) bare.add(w);
    }
  }
  let prev = -1; // the part outside a substitution before this one
  parts.forEach((p, at) => {
    const before = prev;
    if (!p.nested) prev = at;
    if (p.nested || p.flow || p.unknown || p.redirects || !p.words.length || runs[at]!.words.length) return;
    if (p.sep && p.sep !== "&&") return; // a pipeline, the background, or a part that may not run
    // Nor one that runs only when the command before it succeeded or failed: a name left unset is an empty path.
    if (before >= 0 && (parts[before]!.sep === "&&" || parts[before]!.sep === "||")) return;
    p.words.forEach((w, k) => {
      const eq = w.indexOf("=");
      const n = w.slice(0, eq), v = w.slice(eq + 1);
      if (count.get(n) !== 1 || bare.has(n)) return;
      const how = p.how?.[p.dyn?.indexOf(k) ?? -1];
      if (!how) { if (WRITTEN.test(v)) out.set(n, { text: v, at }); return; }
      const sub = how.subs.length === 1 && !how.vars.length && !how.rest && (v === "$(...)" || v === "`...`") ? how.subs[0]! : null;
      if (!sub) return;
      out.set(n, sub.length === 1 && name(unwrap(sub[0]!.words).words[0]) === "mktemp" ? { made: true, at } : { from: sub, at });
    });
  });
  return out;
}

// ---- where a path lands ----

export type Place = "scratch" | "cache" | "inside" | "outside" | "folder" | "repo";
// A word as a path: where it lands, or why that cannot be read.
// `sure`: the path is what the kernel will reach, and every place it lands is outside the session's folder: it is
// written out from the root or the home with no step back up, or it starts in a folder that is certain.
export type Target = { path: string; glob: boolean; place: Place; shown: string; sure?: boolean } | { made: true } | { unread: string };

// A word with the variables the line gives a value written in: null when one of them is not known.
export function written(word: string, how: Made | undefined, dir: string | null, w: Where, vals: Values, at: number): string | null | { made: true } {
  if (!how) return word;
  if (how.subs.length || (how.rest && /[$`{]/.test(word)) || (how.vars.length && vals === LOST)) return null;
  let text = word;
  // Each variable in the word, last first, so the places of the ones before it hold.
  for (let k = how.vars.length - 1; k >= 0; k--) {
    const v = how.vars[k]!;
    const known = vals.get(v.name);
    let value: string | undefined;
    if (known && known.at < at) { if (known.made) return k === 0 && v.at === 0 ? { made: true } : null; value = known.text; }
    else if (vals.has(v.name)) return null;
    else if (w.away) return null;
    else if (v.name === "HOME") value = w.home;
    else if (v.name === "PWD" && dir) value = dir;
    else if (v.name === "TMPDIR" && process.env.TMPDIR) value = process.env.TMPDIR;
    if (value === undefined) return null;
    text = text.slice(0, v.at) + value + text.slice(v.at + v.len);
  }
  return text;
}

export function target(word: string, how: Made | undefined, dir: string | null, w: Where, vals: Values, at: number): Target {
  const said = written(word, how, dir, w, vals, at);
  if (said === null) return { unread: word };
  if (typeof said !== "string") return said;
  let text = said;
  if (!text || /[$`]/.test(text)) return { unread: word };
  if (text === "~" || text.startsWith("~/")) {
    // Another machine's home is not this one's: nothing under it is the session's own.
    if (w.away) return { path: text, glob: GLOB.test(text), place: "outside", shown: word };
    text = w.home + text.slice(1);
  } else if (text.startsWith("~")) return { unread: word };
  if (!isAbsolute(text)) { if (!dir) return { unread: `${word}, in a folder the rules cannot follow` }; }
  const path = isAbsolute(text) ? resolve(text) : resolve(dir!, text);
  const glob = GLOB.test(path);
  // A pattern is judged by the folder its fixed part names; one that starts its name with a wildcard takes everything there.
  const fixed = glob ? path.slice(0, path.lastIndexOf("/", path.search(GLOB))) || "/" : path;
  const all = glob && GLOB.test(path.slice(fixed === "/" ? 1 : fixed.length + 1)[0] ?? "");
  // The worst of the places it lands: a link in a temporary folder that leads out of it is out of it.
  const places = (w.land?.(fixed) ?? [fixed]).map((p) => placeOf(p, glob, all, w));
  const place = (["outside", "folder", "repo", "inside", "cache", "scratch"] as const).find((x) => places.includes(x))!;
  const root = w.away ? null : rootsOf(w).root;
  // A step back up after a folder's name is taken by the kernel from where that folder really is (a link leads
  // elsewhere), and a relative path starts where the shell really is: after a `cd` that may have failed, that is
  // the folder before it.
  const up = /(^|\/)\.\.(\/|$)/.test(text);
  const fromHere = !isAbsolute(text) || /\$\{?PWD\b/.test(word);
  const sure = !w.lost && (fromHere ? w.firm?.[at] === true && (!up || dir === w.cwd) : !up) && places.every((p) => p === "outside" || p === "cache");
  return { path, glob, place, sure, shown: root !== null && under(root, fixed) ? path.slice(root.length + 1) || "." : /[$`]/.test(word) ? path : word };
}

// Folders that hold nothing kept: the system's temporary folders, the
// daemon's own, and the session's scratch. What is inside one is scratch; the
// folder itself, or everything in it at once, is not the session's to clear.
// The user's cache folder holds what is made again, but also other work in
// progress: a delete there is outside the session, an overwrite is not held.
const AWAY_TEMPS = ["/tmp", "/var/tmp", "/dev/shm"];
// The folders of one place, worked out once for all the paths a line names.
const roots = new WeakMap<Where, { root: string; temps: string[]; cache: string }>();
const rootsOf = (w: Where) => {
  let r = roots.get(w);
  if (!r) roots.set(w, (r = { root: resolve(w.workspace), temps: [...AWAY_TEMPS, resolve(tmpdir()), ...(w.scratch ?? []).map((d) => resolve(d))], cache: resolve(w.home, ".cache") }));
  return r;
};
// `p` is `dir` or under it (both already resolved).
export const under = (dir: string, p: string) => p === dir || (p.length > dir.length && p.startsWith(dir) && (dir.endsWith("/") || p[dir.length] === "/"));
function placeOf(p: string, glob: boolean, all: boolean, w: Where): Place {
  if (w.away) {
    for (const t of AWAY_TEMPS) if (under(t, p)) return p !== t || (glob && !all) ? "scratch" : "outside";
    return "outside";
  }
  const { root, temps, cache } = rootsOf(w);
  // The session's folder first: one that lies in a temporary folder is still its work. A pattern in the
  // folder's own root names things inside it.
  if (p === root && glob) return "inside";
  if (under(p, root)) return "folder";
  if (under(root, p)) return /(^|\/)\.git(\/|$)/.test(p.slice(root.length)) ? "repo" : "inside";
  for (const t of temps) if (under(t, p)) return p !== t || (glob && !all) ? "scratch" : "outside";
  return p !== cache && under(cache, p) ? "cache" : "outside";
}
// The session's own folder, resolved, for a caller that only needs to know a path is plainly in it.
export const rootOf = (w: Where) => rootsOf(w).root;

// Names of folders and files that are made, not written: deleting one loses
// nothing. Read only when git cannot say (no repository, another machine).
const MADE_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", ".vite", ".svelte-kit", ".output", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".venv", "venv", ".gradle", ".dart_tool", "tmp", "temp", ".tmp", "logs", ".nyc_output", "storybook-static", "test-results", "playwright-report", ".eggs", "htmlcov", ".terraform", ".angular", ".expo"]);
const MADE_FILE = /\.(o|a|so|pyc|pyo|class|log|tmp|orig|rej|swp|egg-info|tsbuildinfo|lock-wal|out)$|^\.DS_Store$|~$/;
export const madeName = (rel: string) => rel.split("/").some((seg) => MADE_DIRS.has(seg)) || MADE_FILE.test(rel.slice(rel.lastIndexOf("/") + 1));
export const literal = (p: string) => `:(literal)${p}`;

// The targets of the redirects a part writes through: each with whether it empties the file first (`>`, not `>>`).
export function redirected(s: Simple): { to: string; empties: boolean }[] {
  if (!s.redirects) return [];
  const out: { to: string; empties: boolean }[] = [];
  for (const m of s.text.matchAll(/(&>>?|>>|>\||>)\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g)) out.push({ to: m[2]!.replace(/^(["'])(.*)\1$/s, "$2"), empties: m[1] !== ">>" && m[1] !== "&>>" });
  return out;
}
