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
// `beside`: the line is judged beside the one its program-word variables written out (resolved-line.ts), which has those
// words to judge: they are not high risk here.
export type Where = { cwd: string; home: string; workspace: string; scratch?: string[]; looked?: Looked; land?: (p: string) => string[]; sandboxed?: boolean; lost?: true; away?: string; firm?: boolean[]; shaky?: true; beside?: true };

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

// (With the restricted and the other Bourne-like shells, and csh: each runs the script it is given with -c.)
export const SHELLS = /^(sh|bash|zsh|dash|ksh|fish|ash|rbash|rzsh|rksh|mksh|ksh93|yash|csh|tcsh)$/;
// A client told to print the credential it holds, as the store under the home it keeps it in, else null: gh auth
// token, gcloud auth print-access-token, aws configure export-credentials, git credential fill, secret-tool lookup.
// Its output is the credential, as a read of the store's file is. Asked for its help it prints none: --help where
// it is no option's value, `aws help` and `gcloud help` as the first word, aws's help as the last (`aws --profile
// help configure export-credentials` names a profile; aws's options that take no value are not counted as words).
const AWS_PLAIN = /^--(debug|no-verify-ssl|no-paginate|no-sign-request|no-cli-pager|no-cli-auto-prompt|cli-auto-prompt)$/;
export function printsHeld(all: string[]): string | null {
  const p = name(all[0]);
  const words = p === "aws" ? all.filter((a) => !AWS_PLAIN.test(a)) : all;
  const free = (k: number) => k > 0 && !words[k - 1]!.startsWith("-");
  if (words.some((a, k) => a === "--help" && free(k))) return null;
  if ((p === "aws" || p === "gcloud") && (words[1] === "help" || (p === "aws" && words.at(-1) === "help" && free(words.length - 1)))) return null;
  if (p === "gh") return words[1] === "auth" && (words[2] === "token" || (words[2] === "status" && words.some((a) => a === "--show-token" || /^-[a-zA-Z]*t/.test(a)))) ? ".config/gh" : null;
  if (p === "gcloud") return words.includes("auth") && words.some((a) => /^print-(access|identity)-token$/.test(a)) ? ".config/gcloud" : null;
  if (p === "aws") return words.includes("export-credentials") ? ".aws" : null;
  if (p === "secret-tool") return words[1] === "lookup" ? ".local/share/keyrings" : null;
  if (p !== "git") return null;
  let k = 1;
  for (; k < words.length && words[k]!.startsWith("-"); k++) if (words[k] === "-C" || words[k] === "-c") k++;
  const sub = words[k] ?? "";
  return (sub === "credential" && words[k + 1] === "fill") || (sub.startsWith("credential-") && words.includes("get")) ? ".git-credentials" : null;
}
// What a shell is started with, from the words after its name, read as the shell reads them: its options first (a
// cluster of letters such as -lc or -xec, with - or + in front; `-o NAME` and `-O NAME`, one value for each o and O
// of a cluster; a long option, `--rcfile FILE`), up to the first word that is none or to `--`. With -c anywhere
// among them that word is the script, whatever stands between (`bash -c -x 'script'`, `sh -euc 'script'`), and the
// words after it are its $0 and arguments.
// A word the line's shell writes (`$X`, a substitution, a pattern) may be nothing, an option or an option with its
// value. In a value's place it is not skipped as the value: with -c read the reading stops at it and it is handed
// on as the script, as in `bash -c $X 'script'` (`bash -oc $X errexit 'script'`: with X empty errexit is the value
// and the script runs). What the reading names when it goes on past such a word may be the script too (`bash -cx
// $X -c 'script'`, `bash -ooc $X $Y 'script'`), and every word up to there: `also`.
// Options that cannot be read so (a variable that may hold some, `bash $OPTS -c`; another shell's option with a
// value, `zsh --emulate sh -c`, `zsh -oerrexit -c`, `fish -d 3 -c`) end the reading with no -c found. Then the
// first word that is a cluster with c names the script, read on from there: a script too many is read (`sh run.sh
// -c x`), never one too few. Behind unread words that cluster may be no option at all but a word of a script they
// hold (`X='-c $1'; bash $X -oc 'script'`: -oc is its $0), so every word between it and the script it names, a
// word in the place of its o's value among them, is in `also`.
// A `--` or `-` ends the options, and what follows is a script file and its words (`bash -- -c x` runs a file
// named -c), only when every word before it was read for sure: a word the line's shell writes, and a long option
// or a letter that takes a value in one of the shells (fish's -d, ksh's -R, mksh's -T) or in only some of them
// (-O: bash's takes one, zsh's none) may take the `--` as its value or leave it to the next (`X='-c $2'; bash $X
// -- -c 'script'`, `bash --rcfile $X -- -c 'script'`, `fish -d -- -c 'script'`, `zsh -O -c -- 'script'`).
// `at`: where the script stands in `args`, -1 with none. `input`: no -c and no script file, -s, or its own input
// named as the file (/dev/stdin): it reads its commands from its input. A script file it names is `rest[0]`, and
// is not read. Every rule that reads the script a shell is given finds it here, and reads each of `scriptsOf` it.
export type Given = { c: boolean; script?: string; at: number; rest: string[]; input: boolean; also?: { script: string; at: number }[] };
const CLUSTER = /^[-+][a-zA-Z0-9]+$/, VALUED_LONG = /^--(rcfile|init-file|emulate)$/, BUILT = /[$`*?[{]/;
// (The long options and the letters that take no value in any of the shells; -o takes one, read as it stands.)
const PLAIN_LONG = /^--(login|norc|noprofile|posix|restricted|verbose|noediting|debugger|interactive|private|no-config|no-execute)$/, PLAIN = /^[-+][aehiklmnorstuvxBEHPc]+$/;
// (A word that is nothing but expansions: `$X`, `${OPTS[@]}`, `$@`, a substitution.)
const EXPANDS = /^(\$(\(\.\.\.\)|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[@*0-9])|`\.\.\.`)+$/;
export const STDIN_FILE = /^\/(dev\/stdin|dev\/fd\/0|proc\/self\/fd\/0)$/;
// The options from word `i` on, `owed` values of the option before them still to come: where they end (`i`: the
// script's place, or the script file's). `sure`: every word was an option whose value, if it takes one, is known in
// every shell. `ended`: by a `--` or `-` read for sure. `held`: at a value's place that holds a word the line's
// shell writes; with -c read `i` is that word, else the option it is the value of. With -c read by then, `loose`:
// the first word in the place of an -O's value (bash's takes one, zsh's none: `zsh -Oc 'script'`), -1 with none;
// `extra`: the options whose value is not known in every shell, each of which may take the word after it.
function options(args: string[], i: number, owed: number, c: boolean, past?: "nothing" | "value") {
  let s = false, sure = true, ended = false, held = false, opt = i, loose = -1, extra = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    // (`past`: the reading goes on past the words the line's shell writes, each as nothing, or as the value where
    // one is due.)
    if (past && BUILT.test(a)) { if (past === "value" && owed > 0) owed--; continue; }
    if (owed > 0) { if (BUILT.test(a)) { held = true; if (!c) i = opt; break; } owed--; continue; }
    if (a === "--" || a === "-") { i++; ended = sure; break; }
    if (BUILT.test(a)) break;
    opt = i;
    // (fish: --command and --init-command take a script as -c does.)
    if (a.startsWith("--")) { if (a === "--command" || a === "--init-command") c = true; else if (VALUED_LONG.test(a)) owed = 1; else if (!PLAIN_LONG.test(a)) { sure = false; if (c) extra++; } }
    else if (!CLUSTER.test(a)) break;
    else {
      c ||= a.includes("c"); s ||= a.includes("s");
      if (!PLAIN.test(a)) sure = false;
      for (let k = 1; k < a.length; k++) if (a[k] === "o" || a[k] === "O") owed++;
      if (c && a.includes("O") && loose < 0) loose = i + 1;
      if (c && !PLAIN.test(a.replace(/O/g, "c"))) extra++;
    }
  }
  return { c, s, i, ended, held, owed, loose, extra };
}
export function shellGiven(args: string[]): Given {
  const { c, s, i, ended, held, owed, loose, extra } = options(args, 0, 0, false);
  const span = (from: number, to: number) => [...args.entries()].slice(from, to + 1).map(([at, script]) => ({ script, at }));
  if (!c && !ended) {
    const k = args.findIndex((a) => CLUSTER.test(a) && a.includes("c"));
    const later = k < 0 ? null : shellGiven(args.slice(k));
    if (later?.c) {
      const all = span(k + 1, later.at < 0 ? args.length - 1 : later.at + k).filter((g) => !later.also?.some((o) => o.at + k === g.at));
      const last = all.pop();
      const also = [...all, ...(later.also ?? []).map((o) => ({ script: o.script, at: o.at + k }))];
      return { c: true, ...(last ? { script: last.script, at: last.at } : { at: -1 }), rest: later.at < 0 ? [] : later.rest, input: false, ...(also.length ? { also } : {}) };
    }
  }
  const rest = args.slice(i);
  if (!c) return { c, at: -1, rest, input: s || !rest.length || STDIN_FILE.test(rest[0]!) };
  // The words that may be the script: from the first in the place of an -O's value to the one the options name,
  // and past it where it may be an option's value or nothing.
  let hi = rest[0] === undefined ? args.length - 1 : i;
  if (rest[0] !== undefined) {
    // (A word the line's shell writes, in a value's place or as the whole of the script's: the reading goes on
    // past it and the ones after it, each as nothing and each as the value where one is due, as far as either
    // goes. A script that only holds a `$` is the script: `sh -c 'echo "$0"' "$f"`.)
    const on = (how: "nothing" | "value") => options(args, i, held ? owed : 0, true, how).i;
    if (held || EXPANDS.test(rest[0])) hi = Math.max(on("nothing"), on("value"));
    hi = Math.min(args.length - 1, hi + extra);
  }
  const all = span(loose >= 0 && loose < i ? loose : rest[0] === undefined ? args.length : i, hi);
  const main = rest[0] !== undefined ? { script: rest[0], at: i } : all.at(-1);
  if (!main) return { c, at: -1, rest: [], input: false };
  const also = all.filter((g) => g.at !== main.at);
  return { c, script: main.script, at: main.at, rest: args.slice(main.at + 1), input: false, ...(also.length ? { also } : {}) };
}
// Every word that may be the script a shell is given: the one its options name, and with options the rules could
// not read the words before it that may be it instead (`Given.also`).
export const scriptsOf = (given: Given): { script: string; at: number }[] => [...(given.also ?? []), ...(given.script !== undefined ? [{ script: given.script, at: given.at }] : [])];
// The words a plain echo or printf prints, as the script they are for a shell that is handed them.
export const PRINTS = /^(echo|printf)$/;
export const printed = (words: string[]) => words.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(" ").replace(/\\n/g, "\n");
// What the substitution right before a shell's part prints, when the shell is handed it as its script file or as
// its input (`bash <(echo 'script')`, `bash < <(echo 'script')`) and a plain echo or printf prints it: the script.
export function substituted(parts: Simple[], runs: Run[], i: number, given: Given): string | undefined {
  const s = parts[i]!, before = i > 0 ? parts[i - 1]! : undefined;
  if (!before?.nested || before.heredoc || before.dyn?.length || !s.text.includes("<(")) return undefined;
  if (!(given.input ? s.inputs?.includes("$(...)") : !given.c && given.rest[0] === "$(...)")) return undefined;
  const w = runs[i - 1]!.words;
  return PRINTS.test(name(w[0])) ? printed(w) : undefined;
}
// The command line a wrapper is handed as one word, else undefined: `watch 'cmd'`, `env -S 'cmd args'` (env splits
// the string into the command's words itself) and `flock LOCK -c 'cmd'`. unwrap leaves such a part as that word,
// or as the word -c and the command.
export function lineHanded(words: string[], run: Run): string | undefined {
  if (!run.wrapped || run.at < 1) return undefined;
  let j = run.at - 1;
  while (j >= 0 && !WRAPPERS.has(name(words[j]))) j--;
  const by = name(words[j]);
  if (by === "flock") return run.words[0] === "-c" || run.words[0] === "--command" ? run.words[1] : undefined;
  if (!/\s/.test(run.words[0] ?? "")) return undefined;
  return by === "watch" || (by === "env" && words.slice(j + 1, run.at).some((a) => a === "--split-string" || /^-[a-zA-Z]*S$/.test(a))) ? run.words.join(" ") : undefined;
}
// What eval evaluates: its words joined, without the `--` that may end its options (`eval -- 'script'`).
export const evalGiven = (args: string[]) => (args[0] === "--" ? args.slice(1) : args).join(" ");
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
      // A lone dash is env's own -i.
      if (prog === "env" && a === "-") continue;
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
// `through`: inside a subshell the commands after a `cd` joined by `;` or a newline run in its folder too
// (where the subshell ends is still not known): for a reader that takes more commands as in a folder, never fewer.
// `home`: null when the line may have given HOME another value (the account rules say when): a `cd` with no folder, to
// `~` or under it then leaves the folder unknown.
const MOVES = /^(cd|pushd|popd)$/;
// Whether a line may give one of the shell's own names another meaning: a function (`function cd`, `cd () ...` before
// any compound command), an alias, or an `enable`, which can take a builtin away so that its name runs a program.
export function redefines(parts: Simple[], runs: Run[], names: RegExp): boolean {
  return parts.some((p, k) => {
    if (p.heredoc) return false;
    if (p.words[0] === "function" && names.test(p.words[1] ?? "")) return true;
    if (p.def && names.test(p.words[0] ?? "")) return true;
    const first = runs[k]!.words[0];
    return first === "enable" || (first === "alias" && p.words.some((x) => x.includes("=") && names.test(x.slice(0, x.indexOf("=")))));
  });
}
export function dirsOf(parts: Simple[], runs: Run[], cwd: string | null, home: string | null, through = false): (string | null)[] {
  // No part changes folder: every one runs where the line does.
  if (!runs.some((r) => r.words[0] === "cd" || r.words[0] === "pushd" || r.words[0] === "popd")) return new Array<string | null>(parts.length).fill(cwd);
  // A line that may give the name another meaning: what `cd` does after it is not known, and no folder is followed.
  if (redefines(parts, runs, MOVES)) return new Array<string | null>(parts.length).fill(null);
  let top: string | null = cwd;
  let inner: string | null | undefined; // undefined: nested parts run where the line is
  // (Only while nothing in the line can have set PWD: an assignment, export, declare, read, unset or eval of it,
  // or any eval, and $PWD is no longer the folder the shell is in.)
  const pwdOwn = !parts.some((s) => s.words[0] === "eval" || s.words.some((w) => !/^\$\{?PWD\b/.test(w) && /\bPWD\b/.test(w)) || /\bPWD\s*=/.test(s.text));
  const to = (from: string | null, w: string[], s?: Simple): string | null | undefined => {
    if (w[0] !== "cd" && w[0] !== "pushd" && w[0] !== "popd") return undefined;
    let arg = w.slice(1).find((a) => !a.startsWith("-") || a === "-");
    // The folder the shell is in: $PWD and $(pwd) change nothing, and what follows them is relative to it.
    const here = arg === undefined || !pwdOwn ? null : /^(?:\$PWD|\$\{PWD\}|\$\(pwd\)|`pwd`)(\/[^$`*?[\]{}]*)?$/.exec(arg);
    if (here) arg = "." + (here[1] ?? "");
    // $(pwd)/x: the one expansion the word has is the command pwd alone.
    const made = s && arg !== undefined && /^\$\(\.\.\.\)(\/[^$`*?[\]{}]*)?$/.test(arg) ? s.how?.[s.dyn?.indexOf(w.indexOf(arg) + (s.words.length - w.length)) ?? -1] : undefined;
    if (pwdOwn && made && !made.vars.length && !made.rest && made.subs.length === 1 && made.subs[0]!.length === 1 && made.subs[0]![0]!.words.join(" ") === "pwd") arg = "." + arg!.slice(6);
    if (w[0] === "popd" || arg === "-" || (arg !== undefined && (/[$`*?[\]{}]/.test(arg) || (arg.startsWith("~") && arg !== "~" && !arg.startsWith("~/"))))) return null;
    // (A `~` the line quotes or escapes is a folder of that name where the shell is, not the home.)
    const tilde = arg !== undefined && arg.startsWith("~") && !(s?.quotes?.includes(w.indexOf(arg) + (s.words.length - w.length)));
    if (home === null && (arg === undefined || tilde)) return null;
    const path = arg === undefined || (tilde && arg === "~") ? home! : tilde && arg.startsWith("~/") ? home! + arg.slice(1) : arg;
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
      const next = to(top, runs[i]!.words, s);
      if (next !== undefined) top = next;
      return here;
    }
    const here = inner === undefined ? top : inner;
    const next = to(here, runs[i]!.words, s);
    if (next !== undefined) inner = s.sep === "&&" || (through && (s.sep === undefined || s.sep === ";")) ? next : null;
    else if (inner !== undefined && s.sep !== "&&" && s.sep !== "||" && s.sep !== "|" && s.sep !== "|&" && !(through && (s.sep === undefined || s.sep === ";"))) inner = null;
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

// The other folders a part may run in, besides the one `dirsOf` follows: where the shell is when a `cd` before it did
// not land where it says. A `cd` joined by `;`, a newline, `||`, `|` or `&` may have failed (a folder that is not
// there, or not there for the shell that runs the line), and what follows runs where the shell was; one joined by
// `&&` gives that folder to what comes after the chain. A relative `cd` from such a folder lands under it. A `cd`
// with more than one operand, a relative one in a line that names CDPATH, one with a `..` in a line that asks for
// real folders (`cd -P`, `set -P`: the `..` then leaves a link's target, where `dirsOf` leaves the link), a `pushd`
// or `popd` that turns the stack, a relative one inside a loop, a condition or a function's body (it may run again)
// and an `eval` of a `cd` may land anywhere: null, a folder the rules cannot name.
// `cd X || exit` leaves nothing to run where it failed, and neither does `cd X || { echo ...; exit 1; }`, a `cd` on a
// line of its own under a `set -e` that opens the script, or the line's first command when it is a `cd` to a folder
// written from the root that the disk says is there. A `cd` that may not run in the shell at all (after `||`, in a
// pipe, negated) leaves what its `&&` joins where the shell was.
// For a reader that must know every folder a write can happen in (the account rules): more folders, never fewer.
// `real`, `cdpath`: the shell that runs these parts was asked for real folders, or given a CDPATH, by what started it
// (`bash -P -c`, `SHELLOPTS=physical`, a `CDPATH=` in front of it), which its own parts do not show.
// `lands(folder)`: whether the disk says a folder is there to change into (asked only of the line's first command, where
// nothing the line runs can have changed it). `evaled`: the parts are an eval's, run by the shell that runs the eval:
// a `set -e` in them holds only where that shell is not told to ignore it, which they do not show.
export type Else = { real?: boolean; cdpath?: boolean; lands?: (folder: string) => boolean; evaled?: boolean };
// `set -e`, `set -eu`, `set -euo pipefail`, `set -o errexit`: the script's own first command, on a line of its own.
function setsErrexit(p: Simple, run: Run): boolean {
  if (p.nested || p.flow || p.unknown || p.dyn || p.redirects || p.sep !== undefined || p.led !== undefined || p.words[0] !== "set" || run.words[0] !== "set") return false;
  let on = false;
  for (let k = 1; k < p.words.length; k++) {
    const a = p.words[k]!;
    if (!/^-[a-zA-Z]+$/.test(a)) return false;
    if (a.endsWith("o")) { if (p.words[++k] === "errexit") on = true; else if (!/^[a-z]+$/.test(p.words[k] ?? "")) return false; }
    if (a.slice(1, a.endsWith("o") ? -1 : undefined).includes("e")) on = true;
  }
  return on;
}
const NO_DIRS: readonly (string | null)[] = [];
// Whether a line names CDPATH, and whether it asks for real folders somewhere (`set -P`, `set -o physical`, `cd -P`, a
// SHELLOPTS it sets): from there the shell's folder is not the one its words spell when a link is on the way, and a `..`
// leaves the link's target, not the link.
export const namesCdpath = (parts: Simple[]) => parts.some((s) => !s.heredoc && /\bCDPATH\b/.test(s.text));
export const asksReal = (parts: Simple[], runs: Run[]) => parts.some((s, i) => {
  const w = runs[i]!.words;
  return !s.heredoc && (/\bSHELLOPTS\b/.test(s.text) || (w[0] === "set" && w.some((x, k) => /^-[a-zA-Z]*P/.test(x) || (x === "physical" && w[k - 1] === "-o"))) || (MOVES.test(w[0] ?? "") && w.some((x) => /^-[A-Za-z@]*P/.test(x))));
});
// The same asked of a shell by the words that start it, before its script: `bash -P -c`, `bash -o physical -c`.
export const startsReal = (words: string[], script: number) => words.slice(1, script + 1).some((x, k, all) => /^-[a-zA-Z]*P/.test(x) || (x === "physical" && all[k - 1] === "-o"));
const NEGATED = /^(?:(?:if|while|until|elif|then|else|do|time|\{)\s+)*!\s/;
export function elseOf(parts: Simple[], runs: Run[], dirs: (string | null)[], o: Else = {}): (readonly (string | null)[])[] {
  const out = new Array<readonly (string | null)[]>(parts.length).fill(NO_DIRS);
  const evals = (w: string[]) => w[0] === "eval" && w.some((x, k) => k > 0 && /(^|[\s;&|({])(cd|pushd|popd)(\s|$)/.test(x));
  if (!runs.some((r) => MOVES.test(r.words[0] ?? "") || evals(r.words))) return out;
  const cdpath = o.cdpath || namesCdpath(parts);
  const real = o.real || asksReal(parts, runs);
  // What a cd is given: its operands, past its options.
  const read = (w: string[]) => {
    let k = 1;
    while (k < w.length && /^-[A-Za-z@]+$/.test(w[k]!)) k++;
    if (w[k] === "--") k++;
    return { ops: w.slice(k) };
  };
  const relative = (w: string[]) => { const arg = read(w).ops[0]; return arg !== undefined && !/^(\/|~(\/|$))/.test(arg) ? arg : undefined; };
  const unsure = (w: string[], s: Simple) => {
    const { ops } = read(w);
    const arg = ops[0];
    if (ops.length > 1 || w[0] === "popd") return true;
    // (In a loop or a function a relative one may run again, from where the last one left the shell.)
    if (s.flow && relative(w) !== undefined) return true;
    // (pushd alone, or with a number, turns its stack: where that leads is not in the line's words.)
    if (w[0] === "pushd" && (arg === undefined || /^[+-]\d+$/.test(arg))) return true;
    if (arg === undefined) return false;
    if (real && /(^|\/)\.\.(\/|$)/.test(arg)) return true;
    return cdpath && !/^(\/|~|\.{1,2}(\/|$))/.test(arg);
  };
  // `lost`: a chain of relative cds led past the longest path there is. From there the shell is somewhere the rules cannot
  // name, and no folder is followed further (each would be resolved again at every cd after it).
  let others = new Set<string | null>(), pending = new Set<string | null>(), nested = false, lost = false;
  // Code the parts do not show, run in the line's own shell: a file it sources, words it evals, a trap's, the callback
  // of a mapfile or readarray. And a command the words do not name: a part the parser does not read, or one whose first
  // word an expansion makes (`$s +e` is `set +e` where s is set). Any of them can change folder, take `set -e` back or
  // give `exit` another meaning.
  const hidden = parts.some((p, k) => !p.heredoc && (!!p.unknown || /^(source|\.|eval|trap|mapfile|readarray)$/.test(runs[k]!.words[0] ?? "") || (runs[k]!.words.length > 0 && !!p.dyn?.includes(runs[k]!.at))));
  // `exit` is the shell's own while the line gives the name to nothing else, and ends the shell where it runs in it: not
  // in the background, not as one side of a pipe.
  const renamed = redefines(parts, runs, /^exit$/);
  const exits = (k: number) => { const p = parts[k]; return !!p && !renamed && !p.nested && !p.heredoc && !p.unknown && runs[k]!.words[0] === "exit" && p.words[0] === "exit" && p.led !== "|" && p.led !== "|&" && (p.sep === undefined || p.sep === "&&" || p.sep === "||"); };
  // `cd X || exit`, and `cd X || { echo ...; exit 1; }`: a group that only says something before it exits. (Where the
  // group closes is not in the parts: only commands that write nothing but their words may stand before the exit, so one
  // read past the group's end changes nothing.)
  // A group or a subshell before part `k` that was sent to the background or into a pipe: the operator after its close
  // stands before the next command, and ends no command of its own.
  const apart = (k: number) => { const p = parts[k]!; if (p.heredoc || (p.led !== "&" && p.led !== "|" && p.led !== "|&")) return false; let j = k - 1; while (j >= 0 && parts[j]!.heredoc) j--; return parts[j]?.sep !== p.led; };
  // Whether a later `&` may send the list part `i` is in to the background. The `&` that does ends the list: one after
  // a later list (past a `;` or a newline) sends only that one. Where the parts do not show where the list ends (the cd
  // inside a function, loop or group, or a group, a subshell or a substitution in the list after it), any later `&` may.
  const sent = (i: number) => {
    // (The `&` after a group or a subshell closes stands before the next command.)
    const any = () => parts.some((p, k) => k > i && !p.heredoc && (p.led === "&" || (!p.nested && p.sep === "&")));
    if (parts[i]!.flow) return any();
    for (let k = i + 1; k < parts.length; k++) {
      const p = parts[k]!;
      if (p.heredoc) continue;
      if (p.nested || p.flow || p.unknown || p.led === "&" || /^[{(]/.test(p.text)) return any();
      if (p.sep === "&") return true;
      if (p.sep === undefined) return false;
    }
    return false;
  };
  const ends = (i: number) => {
    if (parts[i]!.sep !== "||") return false;
    // (A list sent to the background runs in a shell of its own, where its exit ends only that.)
    if (sent(i)) return false;
    // (Inside such a group the exit ends the group's own shell: what follows the group runs where the shell was.)
    if (parts[i]!.flow && parts.some((_, k) => k > i && apart(k))) return false;
    if (exits(i + 1) && !/^\{/.test(parts[i + 1]!.text)) return true;
    // (The group form only where the cd stands before any function, loop, conditional or group of the line: inside one,
    // the body may run in a shell of its own, a pipe's or a subshell's, where the exit ends only that.)
    // (Nor with code on the line the parts do not show, which can give `exit` another meaning.)
    if (hidden || parts[i]!.flow || !/^\{\s+(echo|printf|exit)(\s|$)/.test(parts[i + 1]?.text ?? "")) return false;
    for (let k = i + 1; k < parts.length; k++) {
      const p = parts[k]!, prog = runs[k]!.words[0];
      if (p.nested || p.heredoc || p.unknown || (k > i + 1 && (p.led !== undefined || !p.text.startsWith(p.words[0] ?? " ")))) return false;
      if (prog === "exit") return exits(k) && !parts.some((_, j) => j > k && apart(j));
      if (p.sep !== undefined || p.redirects || p.words[0] !== prog || (prog !== "echo" && prog !== "printf")) return false;
    }
    return false;
  };
  // `set -e` as the script's first command, with nothing after it that can take it back (a set, a shopt, code the parts
  // do not show): a cd on a line of its own that fails ends the shell.
  const first = parts.findIndex((p) => !p.heredoc);
  const strict = !o.evaled && !hidden && first >= 0 && setsErrexit(parts[first]!, runs[first]!) && !parts.some((p, k) => k > first && !p.heredoc && /^(set|shopt|alias|enable)$/.test(runs[k]!.words[0] ?? ""));
  // A cd the shell cannot be left behind by. `before`: the operator that ended the command before it.
  // (On a line of its own: one joined to more by an operator may be part of a list sent to the background or into a
  // pipe, which runs in a shell of its own.)
  const certain = (i: number, s: Simple, w: string[], before: string | undefined) => {
    if (s.flow || s.sep !== undefined || (s.led !== undefined && s.led !== "&") || w[0] !== "cd" || s.words[0] !== "cd" || /[<>]/.test(s.text) || NEGATED.test(s.text)) return false;
    if (strict && (before === undefined || before === "&")) return true;
    const to = w.length === 2 ? w[1]! : "";
    // (After hidden code, what follows a cd the disk says lands is counted where the line started too, as after any other cd.)
    return !!o.lands && !hidden && i === first && /^\/[A-Za-z0-9_.\/@:+,%^=-]*$/.test(to) && !/(^|\/)\.\.?(\/|$)/.test(to) && o.lands(resolve(to));
  };
  let before: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i]!, w = runs[i]!.words;
    if (!s.heredoc && !s.nested) nested = false;
    if (others.size || nested) out[i] = nested && !others.has(null) ? [...others, null] : [...others];
    if (s.heredoc) continue;
    const moves = MOVES.test(w[0] ?? "");
    if (s.nested) {
      // In a subshell or a substitution `dirsOf` follows a cd along its `&&` chain only: what is left is where it starts from.
      if (evals(w) || (moves && (unsure(w, s) || (others.size > 0 && relative(w) !== undefined)))) nested = true;
      continue;
    }
    const prior = before;
    before = s.sep;
    if (!moves) {
      if (evals(w)) others.add(null);
      if (s.sep !== "&&" && pending.size) { for (const x of pending) others.add(x); pending = new Set(); }
      continue;
    }
    const next = new Set<string | null>();
    const from = relative(w);
    if (from !== undefined && !lost) for (const o of others) {
      const at = o === null ? null : resolve(o, from);
      if (at !== null && at.length > PATH_MAX) { lost = true; break; }
      next.add(at);
    }
    if (lost) { next.clear(); next.add(null); pending.clear(); }
    if (unsure(w, s)) next.add(null);
    // Where the shell stays when this one fails: for what follows it, or for what follows its `&&` chain.
    const stay = lost ? [null] : [dirs[i] ?? null, ...others];
    // A cd the shell may pass over, or make in a shell of its own, though what follows is joined to it by `&&`: one after
    // `||` (not run when what stands before it worked), one side of a pipe (the shell itself stays), a negated one (what
    // its `&&` joins runs where it failed). What follows runs where the shell was, too.
    const passed = (s.led !== undefined && s.led !== "&") || NEGATED.test(s.text);
    if (!lost && !passed && certain(i, s, w, prior)) pending = new Set();
    else if (s.sep === "&&") { for (const x of stay) pending.add(x); if (passed) for (const x of stay) next.add(x); }
    else if (ends(i)) pending = new Set();
    else { for (const x of [...stay, ...pending]) next.add(x); pending = new Set(); }
    others = next.size > 8 ? new Set([null]) : next;
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

// With `home` (a written-out folder), a value that starts with `~`, `~/`, `$HOME/` or `${HOME}/` is read as the shell would
// read it: that folder first. Only these; `~user` stays unread, and so does `$HOME` when the line sets `HOME` itself.
const HOME_LEAD = /^(?:\$HOME|\$\{HOME\})(\/[A-Za-z0-9_.\/@:+,%^-]*)?$/;
// `hist`: every place the line sets a name, in order, each with its written-out value when it is one that always runs
// in the shell of the words after it (otherwise `text` is null: the name is not known after it). A name set twice has
// two events; `at` is the part, `k` the word. The map is left empty when the line can give a name a value unseen.
export type SetEvent = { at: number; k: number; text: string | null };
// The builtins that read a value into the names they are handed.
const TAKES = /^(read|mapfile|readarray|getopts|printf)$/;
// `sets`: filled with every name the words of the line show it giving a value, whatever is known of the value: an
// assignment in any command (a subshell's, one after `export` or `declare`), the name of a `for` or a `select`, a
// name handed to a builtin that reads a value into it (read, mapfile, getopts, printf -v), and one a `${NAME:=word}`
// sets where it is read. With it, the values hold no name that a loop, `printf -v` or `${NAME:=word}` sets too.
export function valuesOf(parts: Simple[], runs: Run[], home?: string, hist?: Map<string, SetEvent[]>, sets?: Set<string>): Values {
  // (A home that is not a plain absolute folder is not written out.)
  if (home !== undefined) home = /^\/[A-Za-z0-9_.\/@:+,%^-]*$/.test(home) && home.length > 1 ? home.replace(/\/+$/, "") : undefined;
  const out: Values = new Map();
  // A value is only ever read into a word an expansion makes: a line with none has none to read.
  // (Not when the names it sets are asked for: a script it hands a shell in quotes reads them with no expansion here.)
  if (!hist && !sets && !parts.some((p) => p.dyn || (p.redirects && p.text.includes("$")))) return out;
  const count = new Map<string, number>();
  const bare = new Set<string>();
  let unseen = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!, prog = name(runs[i]!.words[0]);
    if (/^(eval|source|\.|declare|typeset|local)$/.test(prog) || (p.dyn && BINDS.test(prog))) { if (!sets) { hist?.clear(); return out; } unseen = true; }
    // A name the line can set where its words do not show it: a readonly name (a later assignment fails), a trap or the
    // prompt command (code that runs between the words).
    if (hist && (prog === "readonly" || /(^|[\s;&|(])(trap|PROMPT_COMMAND)\b/.test(p.text))) { if (!sets) { hist.clear(); return out; } unseen = true; }
    if (sets) {
      // (A loop's name takes each of its words in turn: it is read as no one value.)
      if (p.loop) { sets.add(p.loop.name); bare.add(p.loop.name); }
      const head = p.flow && !p.words.length ? /^\s*(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(p.text) : null;
      if (head) { sets.add(head[1]!); bare.add(head[1]!); }
      // (`${NAME:=word}` gives the name a value where it is read.)
      if (p.text.includes("=")) for (const m of p.text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) { sets.add(m[1]!); bare.add(m[1]!); }
    }
    const takes = !!sets && TAKES.test(prog);
    for (const [k, w] of p.words.entries()) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=|\[)/.exec(w);
      // `printf -vNAME` sets NAME: a place of its own, with no value known after it.
      const v = hist || sets ? /^-v([A-Za-z_][A-Za-z0-9_]*)$/.exec(w) : null;
      if (v) { if (sets) { sets.add(v[1]!); bare.add(v[1]!); } if (hist) { const l = hist.get(v[1]!); const e = { at: i, k, text: null }; if (l) l.push(e); else hist.set(v[1]!, [e]); } }
      else if (m) {
        sets?.add(m[1]!);
        count.set(m[1]!, (count.get(m[1]!) ?? 0) + 1);
        if (hist) { const l = hist.get(m[1]!); const e = { at: i, k, text: null }; if (l) l.push(e); else hist.set(m[1]!, [e]); }
      }
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w)) { bare.add(w); if (takes && k > 0) sets!.add(w); }
    }
  }
  if (unseen) { hist?.clear(); return out; }
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
      if ((!hist && count.get(n) !== 1) || bare.has(n)) return;
      const how = p.how?.[p.dyn?.indexOf(k) ?? -1];
      const known = (text: string) => { const e = hist?.get(n)?.find((x) => x.at === at && x.k === k); if (e) e.text = text; };
      if (!how) {
        if (!WRITTEN.test(v)) return;
        // A `~` that is quoted or escaped is a plain character; `~` is the home only where nothing set or read HOME before it.
        const tilde = home && !count.has("HOME") && !bare.has("HOME") && !p.quotes?.includes(k) && (v === "~" || v.startsWith("~/"));
        out.set(n, { text: tilde ? home + v.slice(1) : v, at });
        known(tilde ? home + v.slice(1) : v);
        return;
      }
      if (home && !count.has("HOME") && !bare.has("HOME") && !how.subs.length && how.vars.length === 1 && how.vars[0]!.name === "HOME" && !how.rest) {
        const h = HOME_LEAD.exec(v);
        if (h) { out.set(n, { text: home + (h[1] ?? ""), at }); known(home + (h[1] ?? "")); return; }
      }
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
