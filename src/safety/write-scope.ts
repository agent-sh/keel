// An agent's write scope: the places it may write, decided from the same
// list of places the judge reads (own-places.ts), with the one more rule a
// scope adds: the owner's base checkout and its git directory are never an
// agent's place unless the owner's own words name them. Pure: the gate
// gathers the places and the repository's layout, the automation asks the
// parent and keeps its answers (src/automation/write-asks.ts).
//
// An agent has a scope when its spawn named one (`writes`), when its type is
// one that reviews or verifies, or when the session that starts it has a
// scope itself (a scoped agent never starts an unscoped one): its own
// worktree and its scratch, plus what it was given. An agent with none of
// these writes as it always did.
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { atCwd, contains } from "../core/paths.ts";
import { gitCall, located } from "./autonomy.ts";
import { globBase, pathsSaid, placeOf, type OwnPlace } from "./own-places.ts";
export { globBase };
import { writesOf } from "./policy.ts";
import { isReadOnly, splitCommand } from "./shell.ts";

// The owner's base checkout (the main checkout of the repository the agent
// works in) and its git directory, and the branches checked out in a checkout
// that is not the agent's own (their refs are the owner's too).
export type Base = { root: string; git: string; branches: string[] };
export type ScopeFacts = { places: OwnPlace[]; base?: Base };
export type WriteVerdict = { ok: OwnPlace } | { never: string } | { out: true } | { free: true };

// Where the gate learns an agent's scope and asks its parent (set by src/automation/write-asks.ts). `of`: the places
// its parent gave it (none: the agent has no scope, and writes as it always did); `ask`: asks the parent once about
// paths outside it and says what the agent is told.
export type Given = { places: { path: string; glob?: true }[] };
export const scopes: { of?: (sessionId: string) => Given | undefined; ask?: (sessionId: string, paths: string[], tool: string) => string } = {};

// Whether the owner's words in `text` open `path`, a path of the base: they name it or a folder of the base that
// holds it. The git directory opens only by a name inside it: naming the checkout opens its files, not its git.
export function ownerOpens(text: string, path: string, base: Base, home: string): boolean {
  const inGit = contains(base.git, path);
  return pathsSaid(text, home).some((n) => contains(n, path) && (inGit ? contains(base.git, n) : contains(base.root, n)));
}

// Where every command writes as a matter of course: the temporary folders and the null devices.
const FREE = ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/fd", "/proc/self/fd", "/dev/shm"];
const temps = () => ["/tmp", "/var/tmp", tmpdir()];
export const freeWrite = (p: string) => FREE.some((f) => contains(f, p)) || temps().some((t) => p !== t && contains(t, p));

// What a write to `path` (a real path) is to the scope. The owner's word opens what is otherwise never; a place of
// Keel's own records deeper than the base (a worktree made inside the checkout) is the agent's; a place the parent
// gave (writes) is never one inside the base.
export function judgeWrite(path: string, f: ScopeFacts): WriteVerdict {
  if (freeWrite(path)) return { free: true };
  const place = placeOf(path, f.places);
  if (place?.from === "owner") return { ok: place };
  const never = f.base && [f.base.git, f.base.root].find((n) => contains(n, path));
  if (never) {
    const own = place && place.from !== "writes" && place.from !== "parent" && !place.glob && place.path.length > never.length && contains(never, place.path);
    if (!own) return { never: never === f.base!.git ? `${path} is in the git directory of the owner's checkout (${f.base!.git})` : `${path} is in the owner's checkout (${f.base!.root})` };
  }
  return place ? { ok: place } : { out: true };
}

// A spawn's `writes`: folders, files or globs, absolute, under ~ or relative to the agent's folder. Returns the
// places, or why the list is not taken.
export function parseWrites(list: unknown, cwd: string, home: string): { places: { path: string; glob?: true }[] } | { error: string } {
  if (list === undefined || list === null) return { places: [] };
  const items = typeof list === "string" ? [list] : list;
  if (!Array.isArray(items) || items.some((x) => typeof x !== "string")) return { error: "writes is a list of folders, files or globs" };
  if (items.length > 32) return { error: "writes names 32 paths at most" };
  const out: { path: string; glob?: true }[] = [];
  for (const raw of items as string[]) {
    const t = raw.trim();
    if (!t) continue;
    const word = t === "~" ? home : t.startsWith("~/") ? home + t.slice(1) : t;
    if (/[$`]/.test(word) || word.startsWith("~")) return { error: `${t} is not a path: give it in full, under ~, or relative to the agent's folder` };
    const p = isAbsolute(word) ? resolve(word) : atCwd(cwd, word);
    const glob = /[*?[{]/.test(p);
    const fixed = glob ? globBase(p) : p;
    if (fixed === "/" || fixed === home || contains(fixed, home)) return { error: `${t} would open ${fixed === "/" ? "the whole file system" : "all of the home folder"} to the agent: name the folders it writes` };
    out.push(glob ? { path: p, glob: true } : { path: p });
  }
  return { places: out };
}

// Whether an agent is of a kind that reviews or verifies: its type says so. Its title does not: a task titled
// "Verify the build and fix it" may be a builder's, and the scope would stop it writing what its task needs.
const REVIEWS = /(?:^|[^a-z])(review|reviewer|reviewing|reviews|verify|verifier|verifying|verification|audit|auditor)(?:$|[^a-z])/i;
export const isReviewer = (type: string | undefined) => REVIEWS.test(type ?? "");

// The writes of a shell command that can be read from its words: a redirect's target, what a writer program is
// given (policy.ts writesOf), and the folder a git command that changes something runs in. `refs`: the local
// branches a git command moves, deletes or makes by name. Parts whose folder is unknown (a cd to a variable)
// and words that expand are left out: the sandbox holds those, when there is one.
export function shellWrites(command: string, cwd: string, home: string): { paths: string[]; refs: string[] } {
  const parts = splitCommand(command);
  if (!parts) return { paths: [], refs: [] };
  const paths = new Set<string>(), refs = new Set<string>();
  const add = (dir: string | null, w: string) => {
    const word = w.replace(/^(["'])(.*)\1$/, "$2");
    if (!word || /[$`*?[{]/.test(word) || /^&?\d*$/.test(word)) return;
    const named = word === "~" ? home : word.startsWith("~/") ? home + word.slice(1) : word;
    if (named.startsWith("~")) return;
    if (!isAbsolute(named) && dir === null) return;
    paths.add(isAbsolute(named) ? resolve(named) : atCwd(dir!, named));
  };
  for (const { s, dir } of located(parts, cwd, home)) {
    // (A line of a here-document is text the command is given, not a command: what runs it is judged.)
    if (s.heredoc) continue;
    if (s.redirects) for (const w of redirectTargets(s.text)) add(dir, w);
    for (const w of writesOf({ ...s, redirects: false })) add(dir, w);
    // (And what makes a file or a folder by its name, which policy.ts leaves to the folder's rules.)
    const prog = s.words.findIndex((x) => MAKERS.test(x));
    if (prog >= 0 && prog === s.words.findIndex((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x))) for (const a of s.words.slice(prog + 1)) if (!a.startsWith("-")) add(dir, a);
    const g = gitCall(s.words, dir, home);
    if (!g || isReadOnly(s)) continue;
    if (g.dir && !GIT_READS.test(g.sub)) paths.add(g.dir);
    for (const r of refsMoved(g.sub, g.args)) refs.add(r);
  }
  return { paths: [...paths], refs: [...refs] };
}
const MAKERS = /^(?:.*\/)?(?:touch|mkdir|rmdir|mkfifo|unlink)$/;

// The files a command part's redirects write, read from its text outside quotes: `>`, `>>`, `>|`, `&>`, `&>>`,
// `<>` and `>&` to a file (not to a descriptor). A `>` inside a quoted argument is text (printf 'a > b'), and a
// quoted target loses its quotes. A target that expands is kept as written (the caller leaves it out).
export function redirectTargets(text: string): string[] {
  const out: string[] = [];
  let i = 0, q: "'" | '"' | null = null;
  const end = /[\s;|&<>()]/;
  while (i < text.length) {
    const c = text[i]!;
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; i++; continue; }
    if (c === "\\") { i += 2; continue; }
    if (c === "'" || c === '"') { q = c; i++; continue; }
    const amp = c === "&" && text[i + 1] === ">";
    if (!(c === ">" || amp || (c === "<" && text[i + 1] === ">"))) { i++; continue; }
    let j = i + (amp || c === "<" ? 2 : 1);
    let dup = false;
    if (!amp && c === ">") { if (text[j] === ">" || text[j] === "|") j++; else if (text[j] === "&") { j++; dup = true; } }
    else if (amp && text[j] === ">") j++;
    while (text[j] === " " || text[j] === "\t") j++;
    let w = "", wq: "'" | '"' | null = null;
    for (; j < text.length; j++) {
      const d = text[j]!;
      if (wq) { if (d === wq) wq = null; else if (d === "\\" && wq === '"' && j + 1 < text.length) w += text[++j]; else w += d; continue; }
      if (d === "'" || d === '"') { wq = d; continue; }
      if (d === "\\" && j + 1 < text.length) { w += text[++j]; continue; }
      if (end.test(d)) break;
      w += d;
    }
    if (w && !(dup && /^(\d+-?|-)$/.test(w))) out.push(w);
    i = Math.max(j, i + 1);
  }
  return out;
}
// git subcommands that write nothing in the folder they run in (a fetch or a push writes refs, read by refsMoved).
const GIT_READS = /^(status|log|show|diff|blame|grep|rev-parse|rev-list|ls-files|ls-tree|cat-file|describe|for-each-ref|merge-base|shortlog|reflog|config|remote|help|version|fetch|push|worktree|branch|tag|update-ref|symbolic-ref)$/;

// The local branches a git command moves, deletes or makes by name.
export function refsMoved(sub: string, args: string[]): string[] {
  const named = args.filter((a) => !a.startsWith("-"));
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const short = (r: string) => r.replace(/^\+/, "").replace(/^refs\/heads\//, "");
  if (sub === "update-ref") return named.slice(0, 1).filter((r) => r.startsWith("refs/heads/")).map(short);
  if (sub === "branch") {
    if (has(/^(-d|-D|--delete)$/)) return named.map(short);
    if (has(/^(-m|-M|-c|-C|--move|--copy)$/)) return named.map(short);
    if (has(/^(-f|--force)$/)) return named.slice(0, 1).map(short);
    return [];
  }
  if (sub === "checkout" || sub === "switch") {
    const k = args.findIndex((a) => /^(-B|-C|--force-create)$/.test(a));
    return k >= 0 && args[k + 1] ? [short(args[k + 1]!)] : [];
  }
  // A fetch or a push into this repository's own branches: the part of a refspec after its colon.
  if (sub === "fetch" || (sub === "push" && named[0] === ".")) {
    return named.slice(1).filter((r) => r.includes(":")).map((r) => r.slice(r.indexOf(":") + 1)).filter((r) => r && !r.startsWith("refs/remotes/") && !r.startsWith("refs/tags/")).map(short);
  }
  return [];
}

// The paths a confined command's output says the sandbox refused to write: `rofs`, a read-only file system there;
// `missing`, a write into a folder that is not there (what the sandbox hides is not there to a command: the caller
// keeps only the paths its view hides). A missing path counts only where the line says it was a write: a shell's
// redirect, and the words of the programs that make files.
const QUOTED = /['‘"`]([^'’"`\n]+)['’"`]/g;
const WROTE = /cannot create|can't create|cannot touch|for writing|cannot open .* for writing|cannot make directory/i;
const SHELL_SAID = /^(?:ba|z|da)?sh: (?:line \d+: |\d+: )?(\/[^:\n]+): No such file or directory\s*$/;
export function refusedWrites(output: string): { path: string; how: "rofs" | "missing" }[] {
  const out = new Map<string, "rofs" | "missing">();
  for (const line of output.slice(-200_000).split("\n")) {
    const rofs = /Read-only file system|Errno 30\b|EROFS/.test(line);
    const missing = !rofs && /No such file or directory|ENOENT/.test(line) && (WROTE.test(line) || SHELL_SAID.test(line));
    if (!rofs && !missing) continue;
    const how = rofs ? "rofs" : "missing";
    const shell = SHELL_SAID.exec(line);
    if (shell) { out.set(resolve(shell[1]!), how); continue; }
    let found = false;
    for (const m of line.matchAll(QUOTED)) if (isAbsolute(m[1]!)) { out.set(resolve(m[1]!), how); found = true; }
    if (found) continue;
    // `sh: 1: cannot create /x/y: Read-only file system`, `bash: /x/y: Read-only file system`.
    const bare = /(?:^|\s)(\/[^\s:'"]+):\s*(?:Read-only file system|EROFS|No such file)/.exec(line) ?? /cannot create (\/[^\s:'"]+)/.exec(line);
    if (bare) out.set(resolve(bare[1]!), how);
  }
  return [...out].slice(0, 16).map(([path, how]) => ({ path, how }));
}

// The folders a sandbox binds writable for the scope's places outside the session's folder: a glob by the folder it
// starts from, and nothing inside the base (judgeWrite refuses it there anyway).
export function bindable(places: OwnPlace[], base?: Base): string[] {
  const out = new Set<string>();
  for (const p of places) {
    if (p.from !== "writes" && p.from !== "parent" && p.from !== "owner") continue;
    const at = p.glob ? globBase(p.path) : p.path;
    if (p.from !== "owner" && base && (contains(base.root, at) || contains(base.git, at) || contains(at, base.root) || contains(at, base.git))) continue;
    out.add(at);
  }
  return [...out];
}

// What the agent is told of where it may write, in a line.
export function scopeSaid(places: OwnPlace[]): string {
  return places.filter((p) => p.from !== "folder" || !places.some((q) => q.from === "worktree")).map((p) => p.path).join(", ");
}
