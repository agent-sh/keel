// The folders a line's own git makes a repository in: `git worktree add` a checkout of the repository it runs in,
// `git clone` a repository whose remote is the address it names, `git init` one with no remote. None of them is on the
// disk when the line is judged, so a rule that reads the disk finds nothing there, or what stood there before. Nothing
// is placed or read by what a line makes: a write in such a folder is not placed (accounts.ts), and what a push from
// it would send is not read (public-send.ts). Pure functions over the parser's parts.
import { resolve } from "node:path";
import { name, type Run } from "./risk-words.ts";
import type { Simple } from "./shell.ts";

// `path`: the folder made, written out; null when the rules cannot read it from the words (an expansion, an option
// they do not know).
export type Maker = { by: "worktree" | "clone" | "init"; path: string | null };
// The places a line makes a repository that a folder is in, and whether it makes one in a place the words do not say.
export type Over = { places: string[]; any: boolean };

const DYNAMIC = /[$`*?[\]{}]|^~/;
// A folder git itself is given (after -C, or as where it makes one) with a `..` in it: git walks it on the disk, where
// a `..` after a link leaves the link's target, so the words do not say where it is. `real(path)` is where a path leads
// on the disk, links followed (null: not there, or not known): the part of the folder up to its last `..` is read
// through it, and with no answer the folder is one the rules do not read.
const WALKED = /(^|\/)\.\.(\/|$)/;
export type Real = (path: string) => string | null;
export function walked(base: string | null, p: string, real?: Real): string | null {
  if (DYNAMIC.test(p) || (base === null && !p.startsWith("/"))) return null;
  if (!WALKED.test(p)) return resolve(base ?? "/", p);
  if (!real) return null;
  const parts = (p.startsWith("/") ? p : `${base}/${p}`).split("/"), last = parts.lastIndexOf("..");
  const head = real(parts.slice(0, last + 1).join("/"));
  return head === null ? null : resolve(head, parts.slice(last + 1).join("/"));
}
const flags = (list: string) => new Set(list.split(" "));
// The options the rules read, spelled in full. Any other (one that puts the repository elsewhere, a shortened
// spelling) makes its folder in a place they do not read.
const ADD_FLAGS = flags("--detach -d -q --quiet --track --no-track");
const ADD_VALUED = flags("-b -B");
const CLONE_FLAGS = flags("-q --quiet -v --verbose --progress -n --no-checkout --single-branch --no-single-branch --tags --no-tags");
const CLONE_VALUED = flags("-o --origin -b --branch --depth");
const INIT_FLAGS = flags("-q --quiet");
const INIT_VALUED = flags("-b --initial-branch");

// The operands of a subcommand, past the options the rules know: null when an option is one they do not (it may
// take the next word, or change where the command makes its folder).
function operands(args: string[], plain: Set<string>, valued: Set<string>): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { out.push(a); continue; }
    if (plain.has(a)) continue;
    if (valued.has(a)) { if (args[++i] === undefined) return null; continue; }
    const eq = a.indexOf("=");
    if (eq > 0 && (valued.has(a.slice(0, eq)) || plain.has(a.slice(0, eq)))) continue;
    return null;
  }
  return out;
}

// git's own options before its command: the folder a -C leaves it in, and whether any other option stands there.
function gitAt(words: string[], dir: string | null, real?: Real): { at: number; dir: string | null; other: boolean } | null {
  if (name(words[0]) !== "git") return null;
  let i = 1, at = dir, other = false;
  while (i < words.length && words[i]!.startsWith("-")) {
    const o = words[i]!;
    if (o === "-C") { const p = words[++i]; at = p === undefined ? null : walked(at, p, real); }
    else if (o === "-c" || o === "--config-env" || o === "--git-dir" || o === "--work-tree" || o === "--namespace" || o === "--exec-path" || o === "--super-prefix" || o === "--attr-source") { i++; other = true; }
    else if (o !== "--no-pager" && o !== "-P" && o !== "--no-optional-locks") other = true;
    i++;
  }
  return { at: i, dir: at, other };
}

// The name git gives the folder of a clone when the command names none: the last part of the address.
// Only for an address whose last part is a plain name: any other (a `.bundle`, a second `.git`, a port, a space) git
// names by rules of its own, and the folder is one the rules do not read.
function humanish(url: string): string | undefined {
  const tail = url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[\/:]/).pop() ?? "";
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(tail) && !/\.(git|bundle)$/i.test(tail) && !/^\d+$/.test(tail) ? tail : undefined;
}

// What a command makes, when it is one of git's that make a folder (or gh's clone): else null.
// `dir`: the folder the command runs in.
export function makerOf(words: string[], dir: string | null, real?: Real): Maker | null {
  const first = name(words[0]);
  if (first === "gh") {
    if (words[1] !== "repo" || !(words[2] === "clone" || (words[2] === "fork" && words.some((w) => /^--clone(=true)?$/.test(w))))) return null;
    // gh repo clone REPO [FOLDER] [-- git's own flags]
    const ops = words[2] === "clone" && !words.includes("--") ? operands(words.slice(3), new Set(), flags("-u --upstream-remote-name")) : null;
    const folder = ops && ops.length >= 1 && ops.length <= 2 ? ops[1] ?? humanish(ops[0]!) : undefined;
    return { by: "clone", path: folder && !DYNAMIC.test(ops![0]!) ? walked(dir, folder, real) : null };
  }
  const g = gitAt(words, dir, real);
  if (!g) return null;
  const sub = words[g.at], rest = words.slice(g.at + 1);
  const placed = (p: string | undefined) => (p === undefined || g.other ? null : walked(g.dir, p, real));
  if (sub === "worktree" && rest[0] === "add") {
    const ops = operands(rest.slice(1), ADD_FLAGS, ADD_VALUED);
    return { by: "worktree", path: !ops || ops.length < 1 || ops.length > 2 ? null : placed(ops[0]) };
  }
  if (sub === "clone") {
    const ops = operands(rest, CLONE_FLAGS, CLONE_VALUED);
    if (!ops || ops.length < 1 || ops.length > 2) return { by: "clone", path: null };
    return { by: "clone", path: placed(ops[1] ?? (DYNAMIC.test(ops[0]!) ? undefined : humanish(ops[0]!))) };
  }
  if (sub === "init") {
    const ops = operands(rest, INIT_FLAGS, INIT_VALUED);
    return { by: "init", path: !ops || ops.length > 1 ? null : placed(ops[0] ?? ".") };
  }
  return null;
}

// Follows a line part by part. `step` is given each part after it was read. `mayHold(dir)` is whether any command so
// far, run or not, makes a repository that folder would be in (the folder it makes, or one above it; any folder when
// the rules cannot read where it makes it). `before`: the same asked of the line a script is part of. `real`: where a
// path leads on the disk (`walked`).
export function follow(before?: (dir: string) => boolean, real?: Real) {
  const places: string[] = [], fresh: string[] = [];
  let anywhere = false, freshAnywhere = false;
  // (A repository made at `x/.git` is the repository of `x`.)
  const top = (p: string) => p.replace(/\/\.git$/, "") || "/";
  const under = (d: string, p: string) => d === p || d.startsWith(p === "/" ? p : `${p}/`);
  const holds = (list: string[], dir: string) => {
    if (!list.length) return false;
    if (WALKED.test(dir)) return true;
    const d = resolve(dir);
    return list.some((p) => under(d, p));
  };
  const mayHold = (dir: string): boolean => anywhere || !!before?.(dir) || holds(places, dir);
  return {
    step(s: Simple, run: Run, dir: string | null) {
      if (s.heredoc) return;
      const m = makerOf(run.words, dir, real);
      if (!m) {
        // (A script a shell is given whose words name one of the makers: where it makes what, this line does not follow.)
        if (/^(sh|bash|zsh|dash|ksh|eval)$/.test(name(run.words[0]) ?? "") && run.words.some((x) => /\b(git|gh)\b/.test(x) && /\b(clone|init|worktree|fork)\b/.test(x))) anywhere = freshAnywhere = true;
        return;
      }
      // (A new repository with no remote says nothing of where a write in a folder with one goes: only a clone, a new
      // checkout, or one made with options the rules do not read puts other remotes there.)
      // (One another command hands its words to, xargs or find -exec, makes its folder from words the line does not show.)
      if (m.path === null || run.fed) anywhere = freshAnywhere = true;
      else { places.push(top(m.path)); if (m.by !== "init") fresh.push(top(m.path)); }
    },
    mayHold,
    // Where: the places the line makes a repository so far that `dir` is in, and whether it makes one in a place the
    // words do not say (or the line a script is part of makes one the folder would be in).
    over: (dir: string): Over => ({ places: WALKED.test(dir) ? [] : places.filter((p) => under(resolve(dir), p)), any: anywhere || !!before?.(dir) || WALKED.test(dir) }),
    // Whether a clone or a new checkout the line makes, run or not, may stand where a folder is: what the disk holds
    // there now is then not what a command in it finds.
    mayReplace: (dir: string): boolean => freshAnywhere || holds(fresh, dir),
  };
}
