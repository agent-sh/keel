// An agent's commands move no branch its worktree shares, whatever starts git.
//
// The gate reads the command a model sends (src/safety/shared-branches.ts).
// It cannot read a script the agent wrote and runs, a program that runs git by
// itself, or an alias, and an accident through one of those moved the owner's
// main once. So every git started by such a command, at any depth, carries a
// reference-transaction hook (githooks(5): "invoked by any Git command that
// performs reference updates ... also supports symbolic reference updates";
// a non-zero exit in the "prepared" state aborts the whole transaction). The
// hook refuses an update of the worktree's base branch, of a branch another
// checkout has out, and of any branch that exists and that this worktree did not
// make (the branches its own git makes are noted with the line that begins each one's log, and a renamed
// one is known by the rename in its log), a symbolic HEAD put on one of those, and a change of another
// checkout's HEAD.
//
// How git is given it: the command's environment carries, after the pairs it
// already has, two settings at command-line precedence (git-config(1),
// GIT_CONFIG_COUNT) that include a config file of Keel's for this repository
// only (includeIf "gitdir:", which matches the main checkout and every linked
// worktree of it). That file sets core.hooksPath to a folder of Keel's made
// for this agent: the guard, and for each hook the repository has, a line
// that runs it where it is (so `$0`, its folder and its exit stay its own,
// and a hook the repository does not have is not there either). Another
// repository the command works in is not touched.
//
// What it does not cover, and the gate refuses where it can read it: a
// symbolic ref under a git older than 2.46 (it runs the hook for symbolic refs
// from that release on), a push
// into this repository (git starts the receiving side without the command's
// git settings), a plain write of git's files, a command that drops the
// environment (`env -i`, a GIT_CONFIG_COUNT of its own) or sets core.hooksPath.
// What changed anyway is said after a confined command (refwatch.ts).
//
// The repository's hooks folder is found from its config files as files
// (core.hooksPath in the system, global, repository and worktree files),
// never by running git in it (src/core/git.ts says why); a hooks folder set
// through an include is not followed.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitViewsDir } from "../core/git.ts";
import { offerToSandbox } from "./sandbox-view.ts";
import type { Shared } from "./shared-branches.ts";
import { homeDir } from "../core/paths";

// The branches this worktree's git made, in two places (src/safety/made.ts says how they are kept and checked):
// the pad, in its own git directory, which the hook writes while a command runs (a confined command can write there,
// so the gate refuses any other write to it and nothing counts from it after the command), and the ledger, in Keel's own
// folder for the agent, which only the daemon writes (the hook reads it).
export const PAD = "keel-made-pad";
export const refGuardRoot = () => join(dirname(gitViewsDir()), "ref-guard");
export const guardDirOf = (gitDir: string) => join(refGuardRoot(), createHash("sha256").update(gitDir).digest("hex").slice(0, 24));
export const ledgerOf = (gitDir: string) => join(guardDirOf(gitDir), "made");
// A confined command runs the hook too: its folder is shown read-only in every sandbox.
offerToSandbox(() => [refGuardRoot()]);

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };

// core.hooksPath in one config file, as git reads it: the last in a [core] section wins. undefined: not set there.
export function hooksPathIn(text: string): string | undefined {
  let core = false, value: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s+/, "");
    const head = /^\[\s*([A-Za-z0-9.-]+)(\s+"[^"]*")?\s*\]\s*(.*)$/.exec(line);
    const rest = head ? head[3]! : line;
    if (head) core = head[1]!.toLowerCase() === "core" && !head[2];
    if (!core) continue;
    const kv = /^hookspath\s*=\s*(.*)$/i.exec(rest);
    if (!kv) continue;
    let v = kv[1]!.replace(/\s+[#;].*$/, "").trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    value = v;
  }
  return value;
}

// The config files git reads for a checkout, in its order (git-config(1), FILES).
function configFiles(common: string, gitDir: string, env: Record<string, string | undefined>): string[] {
  const home = env.HOME ?? homeDir();
  const files: string[] = [];
  if (!env.GIT_CONFIG_NOSYSTEM) files.push(env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig");
  if (env.GIT_CONFIG_GLOBAL !== undefined) files.push(env.GIT_CONFIG_GLOBAL);
  else files.push(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "git/config"), join(home, ".gitconfig"));
  files.push(join(common, "config"), join(gitDir, "config.worktree"));
  return files.filter(Boolean);
}

// The hooks folder git would use in the agent's worktree without the guard: relative to the checkout's top, as git
// runs hooks there.
function hooksOf(s: Shared, env: Record<string, string | undefined>): string {
  let found: string | undefined;
  const files = configFiles(s.common, s.gitDir, env);
  let worktreeConfig = false;
  try { worktreeConfig = /^\s*worktreeconfig\s*=\s*true\b/im.test(readFileSync(join(s.common, "config"), "utf8")); } catch {}
  for (const f of files) {
    if (f === join(s.gitDir, "config.worktree") && !worktreeConfig) continue;
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const v = hooksPathIn(text);
    if (v !== undefined) found = v;
  }
  if (found === undefined || found === "") return join(s.common, "hooks");
  const home = env.HOME ?? homeDir();
  return found === "~" ? home : found.startsWith("~/") ? join(home, found.slice(2)) : found;
}

// The guard itself: a POSIX shell script with the agent's facts in it.
function guardScript(s: Shared, orig: string): string {
  const base = s.base ? `refs/heads/${s.base}` : "";
  return `#!/bin/sh
# Written by Keel (src/safety/ref-guard.ts) for an agent working in a worktree Keel made:
# a git its commands start moves no branch the worktree shares with the other checkouts.
own=${shq(s.gitDir)}
common=${shq(s.common)}
branch=${shq(`refs/heads/${s.branch}`)}
base=${shq(base)}
others=${shq((s.gitDirs ?? []).join("\n"))}
kids=${shq((s.kids ?? []).map((b) => `refs/heads/${b}`).join("\n"))}
ledger=${shq(ledgerOf(s.gitDir))}
pad="$own/${PAD}"
orig=${shq(join(orig, "reference-transaction"))}
nl='
'
tab=$(printf '\\t')
input=
while IFS= read -r l || [ -n "$l" ]; do input="$input$l$nl"; done
[ "$1" = prepared ] || [ "$1" = committed ] || [ "$1" = aborted ] || [ -x "$orig" ] || exit 0
refuse() {
  b=\${base#refs/heads/}
  printf '%s\\n' "Refused by Keel: this git command $1. This worktree shares the repository's branches with its other checkouts (the owner's and other agents'), so an agent here changes its own branch (\${branch#refs/heads/}) and the branches it makes itself only. A branch reaches \${b:-its base} through Keel's landing queue (keel__landing_queue), which rebases it, runs the repository's checks and lands it. Leave the other branches as they are, even to undo a mistake, and say in your report what you wanted done." >&2
  exit 1
}
real() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s\\n' "$1"; }
# The base, or a branch another checkout has out, as its HEAD file names it now.
shared() {
  [ "$1" = "$branch" ] && return 1
  [ -n "$base" ] && [ "$1" = "$base" ] && return 0
  for h in "$common/HEAD" "$common"/worktrees/*/HEAD; do
    [ "$h" = "$own/HEAD" ] && continue
    [ -f "$h" ] || continue
    line=
    IFS= read -r line < "$h" || :
    [ "$line" = "ref: $1" ] && return 0
  done
  return 1
}
# An entry that moves nothing: packing the refs (pack-refs, and gc and maintenance through it). It writes each
# branch's value into packed-refs (old zero, new the value the branch has now), then deletes each loose copy in
# a transaction of its own (old the value, new zero) with packed-refs already holding that value and not locked;
# a real delete locks packed-refs first.
# (The branch's value is read from its files, loose first, as git reads it.)
unmoved() {
  case "$2" in
    *[!0]*) if [ -f "$common/$3" ]; then v=; IFS= read -r v < "$common/$3" || :; [ "$v" = "$2" ]
            else grep -qxF "$2 $3" "$common/packed-refs" 2>/dev/null; fi ;;
    *) case "$1" in *[!0]*) ;; *) return 1 ;; esac
       [ ! -e "$common/packed-refs.lock" ] && grep -qxF "$1 $3" "$common/packed-refs" 2>/dev/null ;;
  esac
}
# (The old value in a transaction is zero where the command gave none, so a ref's own files say whether it exists.)
exists() { [ -f "$common/$1" ] || grep -q -e " $1\\$" "$common/packed-refs" 2>/dev/null; }
# A branch of this worktree's: its own, the one it is on, one an agent under it made, or one its own git made. A
# made one is known by the line that begins its log (when it was made, from what): the ledger (Keel's, written after
# a command) and the pad (this worktree's git directory, written by this hook while a command runs) hold that line
# with the name it was made under. A branch the owner makes under the name of one deleted begins with another line. A
# renamed one carries its log along, and says each rename in it.
first() { f=; [ -f "$common/logs/$1" ] && { IFS= read -r f < "$common/logs/$1" || :; }; printf '%s' "$f"; }
listed() {
  for lf in "$ledger" "$pad"; do
    [ -f "$lf" ] && grep -qxF -e "$1 $2" "$lf" && return 0
  done
  return 1
}
mine() {
  [ "$1" = "$branch" ] && return 0
  line=
  IFS= read -r line < "$own/HEAD" || :
  [ "$line" = "ref: $1" ] && return 0
  case "$nl$kids$nl" in *"$nl$1$nl"*) return 0 ;; esac
  fl=$(first "$1")
  # (A rename moves the branch's log to a file of its own before it deletes the old name, and puts it on the new one: a
  # branch with no log is known only by the log in that file, which begins with the line the branch was made with. A
  # branch an agent made, the owner deleted and made again with logs off has no log and no such file.)
  if [ -z "$fl" ]; then
    [ -f "$common/logs/$1" ] && return 1
    tl=
    [ -f "$common/logs/refs/.tmp-renamed-log" ] && { IFS= read -r tl < "$common/logs/refs/.tmp-renamed-log" || :; }
    [ -n "$tl" ] && listed "$1" "$tl" && return 0
    return 1
  fi
  listed "$1" "$fl" && return 0
  for from in $(sed -nE "s|^.*$tab"'Branch: renamed (refs/heads/[^ ]*) to refs/heads/[^ ]*$|\\1|p' "$common/logs/$1" 2>/dev/null); do
    listed "$from" "$fl" && return 0
  done
  return 1
}
# A branch that exists and that this worktree did not make.
foreign() { exists "$1" && ! mine "$1" 0; }
# What this worktree's git makes is its own to move: noted in the pad (the gate refuses a write there), once the
# transaction that makes it went through, with the line that begins its log.
pending="$pad.$PPID"
if [ "$1" = committed ]; then
  if [ -f "$pending" ]; then
    while IFS= read -r r || [ -n "$r" ]; do
      fl=$(first "$r")
      [ -n "$fl" ] && { printf '%s %s\\n' "$r" "$fl" >> "$pad" 2>/dev/null || :; }
    done < "$pending"
    rm -f "$pending"
  fi
elif [ "$1" = aborted ]; then rm -f "$pending"
fi
if [ "$1" = prepared ] && [ -n "$input" ]; then
  here=
  while read -r old new ref; do
    case "$ref" in
      HEAD)
        if [ -z "$here" ]; then
          case "\${GIT_DIR:-}" in /*) here=$GIT_DIR ;; *) here=$(real "\${GIT_DIR:-.git}") ;; esac
          case "$nl$own$nl$others$nl" in *"$nl$here$nl"*) ;; *) here=$(real "$here") ;; esac
        fi
        if [ "$here" != "$own" ]; then
          case "$nl$others$nl" in *"$nl$here$nl"*) refuse "changes what another checkout of this repository has out ($here)" ;; esac
        fi
        case "$new" in ref:refs/heads/*)
          shared "\${new#ref:}" && refuse "puts a checkout on the branch \${new#ref:refs/heads/}, which this worktree shares"
          foreign "\${new#ref:}" && refuse "puts a checkout on the branch \${new#ref:refs/heads/}, which this worktree did not make" ;;
        esac
        ;;
      refs/heads/*)
        if shared "$ref" && ! unmoved "$old" "$new" "$ref"; then refuse "moves the branch \${ref#refs/heads/}, which this worktree shares"; fi
        if foreign "$ref" && ! unmoved "$old" "$new" "$ref"; then refuse "moves the branch \${ref#refs/heads/}, which this worktree did not make"; fi
        exists "$ref" || printf '%s\\n' "$ref" >> "$pending" 2>/dev/null || : ;;
    esac
  done <<KEEL_EOF
$input
KEEL_EOF
fi
if [ -x "$orig" ]; then printf '%s' "$input" | "$orig" "$@"; exit $?; fi
exit 0
`;
}

type Made = { mark: string; dir: string };
const made = new Map<string, Made>();
let pruned = false;

// The folder of Keel's for this agent: its config file and its hooks, made again when what they say changed.
// undefined: it could not be made (the command runs without it).
export function guardFor(s: Shared, env: Record<string, string | undefined> = process.env): string | undefined {
  // (A pattern character in the repository's path would be read as one by includeIf: no guard is given there.)
  if (/[*?[\\\n]/.test(s.common)) return undefined;
  if (!pruned) { pruned = true; pruneGuards(); }
  const dir = guardDirOf(s.gitDir);
  const files = configFiles(s.common, s.gitDir, env);
  const orig = hooksOf(s, env);
  const origAbs = isAbsolute(orig) ? orig : resolve(s.root, orig);
  const mark = [orig, mtime(origAbs), ...files.map(mtime), s.base, s.branch, (s.gitDirs ?? []).join(":"), (s.kids ?? []).join(":")].join("|");
  const was = made.get(s.gitDir);
  if (was && was.mark === mark && existsSync(join(dir, "config"))) return dir;
  try {
    const hooks = join(dir, "hooks");
    mkdirSync(hooks, { recursive: true });
    const write = (p: string, text: string, mode = 0o644) => {
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, text, { mode });
      chmodSync(tmp, mode);
      renameSync(tmp, p);
    };
    // Each hook the repository has, run where it is; reference-transaction is the guard's (it runs the repository's after it).
    const names = new Set<string>(["reference-transaction"]);
    let theirs: string[] = [];
    try { theirs = readdirSync(origAbs); } catch {} // no hooks folder
    for (const n of theirs) {
      if (n === "reference-transaction" || n.includes(".") || !/^[a-z0-9-]+$/.test(n)) continue;
      try { const st = statSync(join(origAbs, n)); if (!st.isFile() || !(st.mode & 0o111)) continue; } catch { continue; }
      names.add(n);
      // (One that is not there when it runs, or not where a sandbox shows it, is skipped, as git skips it.)
      write(join(hooks, n), `#!/bin/sh\nh=${shq(join(orig, n))}\n[ -x "$h" ] || exit 0\nexec "$h" "$@"\n`, 0o755);
    }
    write(join(hooks, "reference-transaction"), guardScript(s, orig), 0o755);
    for (const n of readdirSync(hooks)) if (!names.has(n)) rmSync(join(hooks, n), { force: true });
    write(join(dir, "config"), `[core]\n\thooksPath = ${hooks.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\n`);
    write(join(dir, "origin"), `${s.gitDir}\n`);
    made.set(s.gitDir, { mark, dir });
    if (made.size > 256) made.delete(made.keys().next().value!);
    return dir;
  } catch {
    return undefined;
  }
}

// What a command of the agent's gets in its environment for the guard: the pairs after the ones `env` has.
export function guardEnv(s: Shared, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const dir = guardFor(s, env);
  if (!dir) return {};
  const n0 = Number(env.GIT_CONFIG_COUNT ?? 0);
  const n = Number.isInteger(n0) && n0 >= 0 && n0 < 1000 ? n0 : 0;
  const cfg = join(dir, "config");
  return {
    GIT_CONFIG_COUNT: String(n + 2),
    [`GIT_CONFIG_KEY_${n}`]: `includeIf.gitdir:${s.common}.path`, [`GIT_CONFIG_VALUE_${n}`]: cfg,
    [`GIT_CONFIG_KEY_${n + 1}`]: `includeIf.gitdir:${s.common}/.path`, [`GIT_CONFIG_VALUE_${n + 1}`]: cfg,
  };
}

// The folders of agents whose worktree is gone.
export function pruneGuards(): void {
  let names: string[];
  try { names = readdirSync(refGuardRoot()); } catch { return; }
  for (const n of names) {
    const dir = join(refGuardRoot(), n);
    let own: string;
    try { own = readFileSync(join(dir, "origin"), "utf8").trim(); } catch { continue; }
    if (own && !existsSync(own)) rmSync(dir, { recursive: true, force: true });
  }
}
