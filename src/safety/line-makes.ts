// The folders a line's own git makes, and whether each still stands as it was made when a later command of the line
// runs in it. `git worktree add` makes a checkout of the repository it runs in, `git clone` a repository whose one
// remote is the address it names, `git init` one with no remote. None of them is on the disk when the line is judged,
// so a rule that reads the disk finds nothing there: the account rules place a write in such a folder by what made it
// (accounts.ts), and the public-send check reads what a push from it would send (public-send.ts).
//
// A folder is taken as made only while that is certain from the line's words: the command that makes it is joined by
// `&&` to everything up to the command that runs in it (so that one runs only when the folder was made), and nothing
// between them can put something else in its place: a `cd`, a read, a `mkdir`, and the git commands in `safe`. Any other
// command (an `rm`, an `mv`, a script, a redirect to a file) ends it: the folder is then one the rules do not place.
// Pure functions over the parser's parts.
import { basename, resolve } from "node:path";
import { name, type Run } from "./risk-words.ts";
import { isReadOnly, splitCommand, type Simple } from "./shell.ts";

// `path`: the folder made, written out; null when the rules cannot read it from the words (an expansion, an option
// they do not know). `from`: the folder of the repository a worktree is added to. `branch`: the branch a new worktree
// is on, as the words say it. `start`: the commit it starts from, where the words settle it: the one they name, else
// HEAD for a branch they make (-b, -B) or a detached checkout; with neither git picks one itself (a branch named after
// the folder, one a remote has), and there is none. `url`: the address cloned; null when the rules do not read it.
// `remote`: the name the clone gives its remote.
export type Maker =
  | { by: "worktree"; path: string | null; from: string | null; branch?: string; start?: string }
  | { by: "clone"; path: string | null; url: string | null; remote: string }
  | { by: "init"; path: string | null };

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
// The options the rules read, spelled in full. Any other (one that borrows another repository's objects, puts the
// repository elsewhere, names a template, a shortened spelling) makes something they do not read.
const ADD_FLAGS = flags("--detach -d -q --quiet --track --no-track");
const ADD_VALUED = flags("-b -B");
const CLONE_FLAGS = flags("-q --quiet -v --verbose --progress -n --no-checkout --single-branch --no-single-branch --tags --no-tags");
const CLONE_VALUED = flags("-o --origin -b --branch --depth");
const INIT_FLAGS = flags("-q --quiet");
const INIT_VALUED = flags("-b --initial-branch");

// The operands of a subcommand, past the options the rules know: null when an option is one they do not (it may
// take the next word, or change what the command makes). `seen`: the value of each valued option, by its name.
function operands(args: string[], plain: Set<string>, valued: Set<string>, seen: Map<string, string>): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { out.push(a); continue; }
    if (plain.has(a)) continue;
    if (valued.has(a)) { if (args[i + 1] === undefined) return null; seen.set(a, args[++i]!); continue; }
    const eq = a.indexOf("=");
    if (eq > 0 && (valued.has(a.slice(0, eq)) || plain.has(a.slice(0, eq)))) { seen.set(a.slice(0, eq), a.slice(eq + 1)); continue; }
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

// What a command makes, when it is one of git's that make a folder (or gh's clone, whose folder is not read): else null.
// `dir`: the folder the command runs in.
export function makerOf(words: string[], dir: string | null, real?: Real): Maker | null {
  const first = name(words[0]);
  if (first === "gh") {
    if (words[1] !== "repo" || !(words[2] === "clone" || (words[2] === "fork" && words.some((w) => /^--clone(=true)?$/.test(w))))) return null;
    // gh repo clone REPO [FOLDER] [-- git's own flags]: the folder is read, the address it clones is gh's to say.
    const cut = words.indexOf("--"), seen = new Map<string, string>();
    const ops = words[2] === "clone" && cut < 0 ? operands(words.slice(3), new Set(), flags("-u --upstream-remote-name"), seen) : null;
    const folder = ops && ops.length >= 1 && ops.length <= 2 ? ops[1] ?? humanish(ops[0]!) : undefined;
    return { by: "clone", path: folder && !DYNAMIC.test(ops![0]!) ? walked(dir, folder, real) : null, url: null, remote: "origin" };
  }
  const g = gitAt(words, dir, real);
  if (!g) return null;
  const sub = words[g.at], rest = words.slice(g.at + 1);
  const placed = (p: string | undefined) => (p === undefined || g.other ? null : walked(g.dir, p, real));
  const seen = new Map<string, string>();
  if (sub === "worktree" && rest[0] === "add") {
    const ops = operands(rest.slice(1), ADD_FLAGS, ADD_VALUED, seen);
    if (!ops || ops.length < 1 || ops.length > 2) return { by: "worktree", path: null, from: g.dir };
    const path = placed(ops[0]);
    const named = seen.get("-b") ?? seen.get("-B"), detached = rest.includes("--detach") || rest.includes("-d");
    const branch = named ?? ops[1] ?? basename(ops[0]!);
    // (`-` is the branch the repository was on before: not in the words.)
    const start = ops[1] !== undefined ? (DYNAMIC.test(ops[1]) || ops[1].startsWith("-") ? undefined : ops[1]) : named !== undefined || detached ? "HEAD" : undefined;
    return { by: "worktree", path, from: g.dir, ...(DYNAMIC.test(branch) ? {} : { branch }), ...(start !== undefined ? { start } : {}) };
  }
  if (sub === "clone") {
    const ops = operands(rest, CLONE_FLAGS, CLONE_VALUED, seen);
    const remote = seen.get("-o") ?? seen.get("--origin") ?? "origin";
    if (!ops || ops.length < 1 || ops.length > 2 || DYNAMIC.test(remote)) return { by: "clone", path: null, url: null, remote: "origin" };
    const url = DYNAMIC.test(ops[0]!) ? null : ops[0]!;
    const folder = ops[1] ?? (url === null ? undefined : humanish(url));
    return { by: "clone", path: placed(folder), url, remote };
  }
  if (sub === "init") {
    const ops = operands(rest, INIT_FLAGS, INIT_VALUED, seen);
    return { by: "init", path: !ops || ops.length > 1 ? null : placed(ops[0] ?? ".") };
  }
  return null;
}

// The git commands that leave a folder the line made as it was made: none of them makes, moves or removes a folder, runs
// a program the line names, or writes a file the line names. (What a remote is given, and a setting that moves one, the
// account rules read by themselves: `git remote add`, `git config remote.origin.url`.)
export const SAFE_GIT = flags("add commit status fetch pull push checkout switch branch log diff show rev-parse merge tag restore reset cherry-pick stash symbolic-ref describe ls-files remote config");
// The ones after which a push sends nothing but what the folder held when it was made and what the line itself commits.
// (`git remote` among them only in the forms that fetch nothing: REMOTE_PLAIN.)
export const PLAIN_GIT = flags("add commit status push log diff show rev-parse describe ls-files remote");
// `git remote` as it lists, adds, renames, removes or readdresses a remote, with the options that only say which address:
// any other form (-f, --fetch, update, a shortened option) may bring another repository's commits into the folder.
const REMOTE_VERBS = flags("add set-url get-url rename remove rm");
const REMOTE_FLAGS = flags("-v --verbose --push --add --delete --all");
const fetches = (w: string[], at: number) => {
  const rest = w.slice(at + 1), verb = rest.find((x) => !x.startsWith("-"));
  return (verb !== undefined && !REMOTE_VERBS.has(verb)) || rest.some((x) => x.startsWith("-") && !REMOTE_FLAGS.has(x));
};
// Options that have git run a program or write a file of the line's choosing.
const RUNS = /^(-x|--exec|--output|--ext-diff|--textconv|--upload-pack|--receive-pack|--exec-path|-c|--config|--config-env|--template|--hooks-path)(=|$)/;

// What the line sets that git, or the shell that runs it, reads: another config, template, folder or program.
const READ_BY_GIT = /^(GIT_\w+|HOME|XDG_CONFIG_HOME|PATH|LD_\w+|BASH_ENV|ENV)=/;

// Whether a command can neither make, move nor remove a folder, nor change what one holds beyond its own git's commits.
export function quiet(s: Simple, run: Run, safe: Set<string> = SAFE_GIT): boolean {
  if (s.heredoc) return true;
  if (s.unknown || s.redirects) return false;
  const w = run.words;
  if (w.some((x) => READ_BY_GIT.test(x)) || run.set.some((x) => READ_BY_GIT.test(x))) return false;
  if (!w.length) return true;
  if (w[0] === "cd" || w[0] === "pushd" || w[0] === "popd") return true;
  const g = gitAt(w, null);
  if (g) {
    if (isReadOnly(s)) return true;
    // (Nothing set in front of it: GIT_EDITOR, GIT_SSH_COMMAND and the like name programs.)
    // (git config -f FILE writes a file the line names: a config put where a repository is then made.)
    return !g.other && !run.set.length && w[0] === "git" && safe.has(w[g.at] ?? "") && !w.some((x) => RUNS.test(x)) && !(w[g.at] === "config" && w.some((x) => /^(-f|--file)(=|$)/.test(x)))
      && !(w[g.at] === "remote" && !safe.has("fetch") && fetches(w, g.at))
      // (A setting or a remote spelled with an expansion: which one, the words do not say.)
      && !((w[g.at] === "config" || w[g.at] === "remote") && !!s.dyn?.length);
  }
  if (name(w[0]) === "mkdir" && !run.set.length) return true;
  return isReadOnly(s);
}

// Follows a line part by part. `step` is given each part after it was read; `at(dir)` is what made a folder written out
// the same way, while it still stands; `mayHold(dir)` is whether any command so far, run or not, makes a repository that
// folder would be in (the folder it makes, or one above it; any folder when the rules cannot read where it makes it).
// `before`: the same asked of the line a script is part of. `loud`: that line already ran a command that can fill a
// folder, or made a repository. `real`: where a path leads on the disk (`walked`).
// A command counts as making its folder only when what it leaves there is sure from the words:
// - it always runs before what `&&` joins to it, as `git` or `gh` itself with nothing in front of it;
// - every command of the line before it can put nothing in a folder (`quiet`): after a copy, a move, a link, an archive
//   or a script, the folder may hold what they left, and the repository a checkout is added to may be another;
// - no other command of the line makes a repository in that folder, above it or under it (a clone into `x/.git` makes
//   `x` one), run or not;
// - a checkout is added to a repository no command of the line makes.
// Any other is a folder the rules do not place.
// `parts`: the line's parts, which say which commands are a substitution of the command after them (`$(cat msg)` in a
// commit's message). Those run as part of that command. Any other command in parentheses is a subshell, and the
// operator after its close is not in the parts: what follows a subshell is not joined to the maker by `&&`.
export function follow(safe: Set<string> = SAFE_GIT, before?: (dir: string) => boolean, loud = false, real?: Real, parts?: Simple[]) {
  const made = new Map<string, Maker>();
  let inside: Set<Simple> | undefined;
  const substituted = (s: Simple): boolean => {
    if (!inside) {
      inside = new Set();
      (parts ?? []).forEach((p, i) => {
        if (p.heredoc || !/\$\(|`|[<>=]\(/.test(p.text)) return;
        // (The command read by itself: the parts before its own are the commands inside it.)
        const k = (splitCommand(p.text)?.length ?? 1) - 1, own = parts!.slice(Math.max(0, i - k), i);
        if (k > 0 && own.length === k && own.every((x) => x.nested)) for (const x of own) inside!.add(x);
      });
    }
    return inside.has(s);
  };
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
  const meets = (path: string): boolean => mayHold(path) || places.some((p) => under(p, top(path)));
  return {
    step(s: Simple, run: Run, dir: string | null) {
      if (s.heredoc) return;
      const m = makerOf(run.words, dir, real);
      if (!m) {
        // (A script a shell is given whose words name one of the makers: where it makes what, this line does not follow.)
        if (/^(sh|bash|zsh|dash|ksh|eval)$/.test(name(run.words[0]) ?? "") && run.words.some((x) => /\b(git|gh)\b/.test(x) && /\b(clone|init|worktree|fork)\b/.test(x))) anywhere = freshAnywhere = true;
        if (!quiet(s, run, safe)) { loud = true; made.clear(); }
        else if (made.size && (s.flow || (s.led !== undefined && s.led !== "&") || (s.sep !== "&&" && !(s.nested && substituted(s))))) made.clear();
        return;
      }
      // (git or gh by its own name, with nothing in front: no wrapper, no path, nothing set for it.)
      const plain = !s.flow && (s.led === undefined || s.led === "&") && !s.unknown && !s.redirects && !run.set.length && (run.words[0] === "git" || run.words[0] === "gh") && s.words[0] === run.words[0];
      const sure = m.path !== null && !run.fed && plain && !loud && !s.nested && s.sep === "&&" && !meets(m.path) && (m.by !== "worktree" || (m.from !== null && !mayHold(m.from)));
      // (A new repository with no remote says nothing of where a write in a folder with one goes: only a clone, a new
      // checkout, or one made with options the rules do not read puts other remotes there.)
      // (One another command hands its words to, xargs or find -exec, makes its folder from words the line does not show.)
      if (m.path === null || run.fed) anywhere = freshAnywhere = true;
      else { places.push(top(m.path)); if (m.by !== "init") fresh.push(top(m.path)); }
      if (!plain) loud = true;
      if (sure) made.set(m.path!, m); else made.clear();
    },
    // (A folder with a `..` in it is where the disk walks it. A checkout added to a repository the line makes, or may
    // put another in the place of, is not one the rules place: the disk does not show what it was added to.)
    at: (dir: string): Maker | undefined => {
      const d = made.size ? walked(null, dir, real) : null, m = d === null ? undefined : made.get(d);
      return m?.by === "worktree" && (m.from === null || mayHold(m.from)) ? undefined : m;
    },
    mayHold,
    // Where: the places the line makes a repository so far that `dir` is in, and whether it makes one in a place the
    // words do not say (or the line a script is part of makes one the folder would be in).
    over: (dir: string): Over => ({ places: WALKED.test(dir) ? [] : places.filter((p) => under(resolve(dir), p)), any: anywhere || !!before?.(dir) || WALKED.test(dir) }),
    // Whether a clone or a new checkout the line makes, run or not, may stand where a folder is: what the disk holds
    // there now is then not what a command in it finds.
    mayReplace: (dir: string): boolean => freshAnywhere || holds(fresh, dir),
    // (To a script of the line: a repository the line made counts as a command that can fill a folder.)
    loud: () => loud || anywhere || places.length > 0,
  };
}
