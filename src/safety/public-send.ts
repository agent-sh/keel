// Text that leaves under the owner's name for a public place is read for private words first (private-words.ts):
// the commits a `git push` sends (their messages, authors, file names and the lines they add, and what a commit made in
// the same command line will hold), and the text of the `gh` writes that publish (pr, issue, release, gist, repo edit,
// api). Public is asked of the remote itself, never guessed from its name: `gh repo view` says it, else an anonymous
// `git ls-remote` (a repository anyone can read is public), and a repository found private is not read at all. The
// answers are kept for a few minutes. What could not be read (a failed log, a cut read, a missing body file) holds the
// call too, with what was not read.
//
// What is private is learned, not listed here: the owner's own sentences of the session, his machines and ssh hosts,
// the folders he works in, his home folder, the secrets the vault holds, and the words he adds under Settings > private.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { settings } from "../admin/settings.ts";
import { timed } from "../admin/stall.ts";
import { git, gitEach, gitEnv, locate, realDir } from "../core/git.ts";
import { readText } from "../core/proc.ts";
import { homeDir } from "../core/paths.ts";
import type { Store } from "../core/store.ts";
import type { StoredEvent } from "../core/types.ts";
import { sshHosts } from "../fleet/sshconfig.ts";
import { accountNames } from "./account-settings.ts";
import { ghBase, pushRemote, repoOf, type Remotes } from "./accounts.ts";
import { gitCall } from "./autonomy.ts";
import { ownerWords } from "./judge.ts";
import { realAt, remotesIn, rewritesOwn } from "./looked.ts";
import { matcher, say, sentencesOf, type Finding, type Unit, type Words } from "./private-words.ts";
import { registerPrivateSettings } from "./private-settings.ts";
import { reboundBy } from "./policy.ts";
import { laid } from "./risk.ts";
import { follow, makerOf, type Over } from "./line-makes.ts";
import { scriptsOf, shellGiven } from "./risk-words.ts";
import { narrow, untilde } from "./line-vars.ts";
import { resolvedLine } from "./resolved-line.ts";
import { splitCommand, type Simple } from "./shell.ts";
import { vault } from "./secrets.ts";

registerPrivateSettings();

export type Repo = { host: string; path: string[] };
export type Visibility = "public" | "private" | "unknown";
// What a check asks of the world: whether a repository is public, and what is private. Replaced in tests.
export type Deps = {
  visibility(repo: Repo): Promise<Visibility>;
  words(session: string): Promise<Learned>;
};
// `mine`: names that are the owner's own and public by being his (his login, his accounts' owners): never private words.
export type Learned = { words: Words; folders: ReadonlyMap<string, string[]>; mine?: readonly string[] };
// `to`: the repositories it goes to, when every send of it names one. `again`: findings left out because the owner
// allowed the same words to the same place earlier in the session (public-allowed.ts).
export type Held = { found: Finding[]; acts: string[]; unread: string[]; to?: string[]; again?: number };

// Text read per call, in characters: past it the rest of a very large push is not read (and the hold says so).
const READ_MAX = 8_000_000;
const LOG_MS = 20_000;
// One piece of text is read in slices of this size with a turn of the loop between, and no more than UNIT_MAX of it.
const SLICE = 200_000;
const UNIT_MAX = 4_000_000;
const FILE_MAX = 1_000_000;
const TREE_FILES = 2_000;

// ---- what a command sends ----

// A file word as a path: `~` and `$HOME` are the home folder, a relative one is in `dir` ("" when that is not known).
const place = (dir: string | null, f: string): string => { const w = untilde(f, homeDir()); return isAbsolute(w) ? resolve(w) : dir ? resolve(dir, w) : ""; };
type Maybe = string | null; // null: its text cannot be known from the command line
type Msg = { where: string; text: Maybe; why?: string };
type Tree = { dir: string | null; untracked: boolean; loose?: true; over?: Over };
type Same = { messages: Msg[]; trees: Tree[] };
// What an earlier part of the same command line writes to a file: its text, or null when it cannot be known.
type Written = Map<string, Maybe>;
// `loose`: the line makes a repository the folder a push or a commit runs in would be in, before it; `over`: where
// (line-makes.ts). Such a repository is not on the disk when the line is read.
// `added`: the remotes the line gave an address before the push, in the folder the push runs in. `rewired`: the line
// changes where remotes lead in a way that is not followed, so where the push goes is not read.
// What a line gives a remote: `how` it does (`git remote add`, `set-url`, `set-url --push`). `sure`: the push runs only
// when that command worked, with nothing but git's own plain commands between (a remote it added is then new, and one
// it gave another address has it). `again`: the line gave the name an address before this one too.
type Given = { url: string; how: "add" | "url" | "push"; sure?: true; again?: true };
type Act =
  | { is: "push"; dir: string | null; args: string[]; loose?: true; over?: Over; added?: ReadonlyMap<string, Given>; rewired?: true }
  | { is: "gh"; dir: string | null; send: GhSend; part: Simple; doc?: string; feed: () => Promise<Maybe>; written: Written };

type Spec = { valued: string[]; title: string[]; body: string[]; file: string[]; tag?: true; files?: true; repo?: true; open?: string[] };
const BASE = ["-R", "--repo", "--hostname"];
const PR: Spec = {
  valued: [...BASE, "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template"],
  title: ["-t", "--title"], body: ["-b", "--body"], file: ["-F", "--body-file"],
};
const RELEASE: Spec = { valued: [...BASE, "-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "--discussion-category", "--notes-start-tag"], title: ["-t", "--title"], body: ["-n", "--notes"], file: ["-F", "--notes-file"], tag: true };
const GH: Record<string, Record<string, Spec>> = {
  pr: { create: PR, comment: PR, edit: PR, review: PR, merge: { ...PR, valued: [...PR.valued, "--subject", "-A", "--author-email", "--match-head-commit"], title: ["-t", "--subject"] } },
  issue: { create: PR, comment: PR, edit: PR },
  release: { create: RELEASE, edit: RELEASE },
  gist: { create: { valued: [...BASE, "-d", "--description", "-f", "--filename"], title: ["-d", "--description", "-f", "--filename"], body: [], file: [], files: true, open: ["-p", "--public"] } },
  repo: { edit: { valued: [...BASE, "-d", "--description", "-h", "--homepage", "--default-branch", "--add-topic", "--remove-topic", "--visibility", "--template"], title: ["-d", "--description", "-h", "--homepage", "--add-topic"], body: [], file: [], repo: true } },
};
const API_VALUED = [...BASE, "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"];

type Opt = { flag: string; value: string };
type GhSend = { group: string; verb: string; spec: Spec | null; opts: Opt[]; pos: string[] };
const valuesOf = (opts: readonly Opt[], names: readonly string[]) => opts.filter((o) => names.includes(o.flag)).map((o) => o.value);

// A gh command line's words after `gh`: its group and verb, its flags with their values and its plain words.
function ghParse(words: string[]): GhSend | null {
  const plain = (valued: ReadonlySet<string>, opts?: Opt[]) => {
    const pos: string[] = [];
    for (let k = 1; k < words.length; k++) {
      const a = words[k]!;
      if (!a.startsWith("-") || a === "-") { pos.push(a); continue; }
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      if (eq > 0) { opts?.push({ flag: a.slice(0, eq), value: a.slice(eq + 1) }); continue; }
      if (valued.has(a) && k + 1 < words.length) { opts?.push({ flag: a, value: words[++k]! }); continue; }
      opts?.push({ flag: a, value: "" });
    }
    return pos;
  };
  const [group, verb] = plain(new Set(BASE));
  if (!group) return null;
  if (group === "api") {
    const opts: Opt[] = [];
    const pos = plain(new Set(API_VALUED), opts);
    return { group, verb: "", spec: null, opts, pos: pos.slice(1) };
  }
  const spec = verb ? GH[group]?.[verb] : undefined;
  if (!spec || !verb) return null;
  const opts: Opt[] = [];
  const pos = plain(new Set(spec.valued), opts);
  return { group, verb, spec, opts, pos: pos.slice(2) };
}

// What `git commit` or `git tag` is given to say: -m / --message (also in a cluster: -am, -qm, -m"text"), -F / --file,
// --author. A file named with -F is read where it is, or from what the line wrote to it.
function messagesOf(args: readonly string[], what: string): { texts: Msg[]; files: string[] } {
  const texts: Msg[] = [], files: string[] = [];
  const takes = new Set(["m", "F", "c", "C", "u", "S"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(0, eq) : a;
      const val = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      const used = () => { if (eq < 0) i++; };
      if (name === "--message") { used(); if (val !== undefined) texts.push({ where: `${what} message`, text: val }); }
      else if (name === "--file") { used(); if (val !== undefined) files.push(val); }
      else if (name === "--author") { used(); if (val !== undefined) texts.push({ where: `${what} author`, text: val }); }
      continue;
    }
    if (!a.startsWith("-") || a === "-") continue;
    for (let c = 1; c < a.length; c++) {
      const ch = a[c]!;
      if (!takes.has(ch)) continue;
      const rest = a.slice(c + 1);
      const val = rest || args[i + 1];
      if (!rest) i++;
      if (val !== undefined) {
        if (ch === "m") texts.push({ where: `${what} message`, text: val });
        else if (ch === "F") files.push(val);
      }
      break;
    }
  }
  return { texts, files };
}

// What commits and tags a line makes before it pushes: what each will hold is the tree against HEAD.
const TREE_SUBS = new Set(["add", "commit", "tag", "rm", "mv", "apply", "cherry-pick"]);

// The here-documents of a command line, in the order they open, found in the text itself: the splitter drops a
// document it cannot read as a script (prose with an apostrophe in it), and its text is what is sent.
const OPENER = /(?<!<)<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_]\w*))/g;
function heredocs(cmd: string): string[] {
  const out: string[] = [];
  let prevEnd = -1;
  for (const m of cmd.matchAll(OPENER)) {
    const delim = m[2] ?? m[3] ?? m[4]!;
    const nl = cmd.indexOf("\n", m.index);
    if (nl < 0) { out.push(""); continue; }
    let at = Math.max(nl + 1, prevEnd);
    const body: string[] = [];
    let end = cmd.length;
    while (at <= cmd.length) {
      let e = cmd.indexOf("\n", at);
      if (e < 0) e = cmd.length;
      const line = cmd.slice(at, e);
      if ((m[1] ? line.replace(/^\t+/, "") : line) === delim) { end = Math.min(cmd.length, e + 1); break; }
      body.push(line);
      if (e >= cmd.length) { end = cmd.length; break; }
      at = e + 1;
    }
    out.push(body.length ? body.join("\n") + "\n" : "");
    prevEnd = end;
  }
  return out;
}
// What each part of a line is given as a here-document, by the order the documents open.
function docsAt(parts: Simple[], cmd: string): (string | undefined)[] {
  const docs = heredocs(cmd);
  let n = 0;
  return parts.map((p) => {
    if (p.heredoc) return undefined;
    const opens = (p.text.match(OPENER) ?? []).length;
    const mine = opens ? docs[n] : undefined;
    n += opens;
    return mine;
  });
}

// The text a part of a command line prints or feeds to what follows it: `echo`, `printf`, `cat <<EOF`, `cat FILE`.
async function produced(parts: Simple[], k: number, dir: string | null, docAt: (string | undefined)[]): Promise<Maybe> {
  const p = parts[k];
  if (!p || p.heredoc) return null;
  const prog = basename(p.words[0] ?? "");
  const rest = p.words.slice(1);
  const doc = docAt[k] ?? (parts[k + 1]?.heredoc ? parts[k + 1]!.doc ?? null : undefined);
  if (prog === "echo") return rest.filter((w, n) => !(n === 0 && /^-[neE]+$/.test(w))).join(" ") + "\n";
  if (prog === "printf") return rest.join(" ");
  if (prog === "cat" || prog === "tee") {
    if (doc !== undefined) return doc;
    if (prog === "tee") return await fedBy(parts, k, dir, docAt);
    const files = rest.filter((w) => !w.startsWith("-"));
    if (files.length !== 1) return null;
    return await textOf(place(dir, files[0]!));
  }
  return null;
}
// What is piped into part k, when its stage before it is known.
async function fedBy(parts: Simple[], k: number, dir: string | null, docAt: (string | undefined)[]): Promise<Maybe> {
  let b = k - 1;
  while (b >= 0 && parts[b]!.heredoc) b--;
  if (b < 0 || (parts[b]!.sep !== "|" && parts[b]!.sep !== "|&")) return null;
  return await produced(parts, b, dir, docAt);
}

// The files the line writes before it sends: `> f`, `>> f` and `tee f`, with their text where it can be known.
async function writtenIn(parts: Simple[], dirs: (string | null)[], cwd: string, docAt: (string | undefined)[]): Promise<Written> {
  const out: Written = new Map();
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]!;
    if (p.heredoc) continue;
    const dir = dirs[k] ?? cwd;
    const at = (f: string) => resolve(dir, untilde(f.replace(/^["']|["']$/g, ""), homeDir()));
    const targets: { path: string; append: boolean }[] = [];
    if (p.redirects) for (const m of p.text.matchAll(/(?:^|[\s;&|])\d?(>>?)\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) if (!/^\/dev\//.test(m[2]!.replace(/^["']|["']$/g, ""))) targets.push({ path: at(m[2]!), append: m[1] === ">>" });
    if (basename(p.words[0] ?? "") === "tee") for (const w of p.words.slice(1)) if (!w.startsWith("-")) targets.push({ path: at(w), append: p.words.includes("-a") });
    if (!targets.length) continue;
    const text = await produced(parts, k, dir, docAt);
    for (const t of targets) {
      const old = t.append ? (out.has(t.path) ? out.get(t.path)! : await textOf(t.path)) : "";
      out.set(t.path, text === null || old === null ? null : old + text);
    }
  }
  return out;
}

// The sends of a command line: each `git push` and `gh` write, what a commit made on the same line will hold, found
// through `sh -c` and in the folder each runs in.
// A line that sets HOME: `~` and `$HOME` in it are not the folder Keel knows, so a file word that uses them is not read.
const HOME_SET = /(?:^|[\s;&|(])(?:(?:export|declare|typeset|readonly)\s+(?:-\w+\s+)?)?HOME\+?=/;
const NOT_HOME = "/HOME-is-set-on-this-line";
const homeKnown = (command: string) => (HOME_SET.test(command) ? command.replace(/(^|[\s='"(;&|])(?:~|\$\{HOME\}|\$HOME)(?=\/|[\s'";&|)]|$)/g, `$1${NOT_HOME}`) : command);

// The git commands between a `git remote add` and a push that leave the remote as it was added and the repository in place.
const CALM_GIT = new Set(["add", "commit", "status", "branch", "checkout", "switch", "tag", "log", "diff", "show"]);
// `from`: what the line a script is part of did before it: `rewired`, and `makes`, whether it makes a repository a
// folder would be in.
async function actsOf(command: string, cwd: string, home: string, depth = 0, from?: { rewired: boolean; makes: (dir: string) => boolean }): Promise<{ acts: Act[]; same: Same; rewired: boolean }> {
  const same: Same = { messages: [], trees: [] };
  const line = homeKnown(command);
  const written0 = resolvedLine(line, home) ?? line;
  const parts = splitCommand(narrow(written0, home) ?? written0);
  if (!parts) return { acts: [], same, rewired: !!from?.rewired };
  const pre = laid(parts, cwd, home);
  const docAt = docsAt(parts, command);
  const written = await writtenIn(parts, pre.dirs, cwd, docAt);
  const out: Act[] = [];
  // The folders the line's own git makes as it goes: one of them is not on the disk yet.
  // (A folder git is given with a `..` in it is where the disk walks it: each is asked first, off the loop and within
  // a time limit, and one the disk did not answer for is a folder that is not read.)
  const walks = new Map<string, string | null>();
  for (let i = 0; i < parts.length; i++) if (!parts[i]!.heredoc) makerOf(pre.runs[i]!.words, pre.dirs[i] ?? null, (p) => { walks.set(p, null); return null; });
  await Promise.all([...walks.keys()].map(async (p) => { const r = await realAt(p); walks.set(p, r === "late" ? null : r); }));
  const makes = follow(from?.makes, (p) => walks.get(p) ?? null);
  // The remotes the line gives an address before a push (`git remote add NAME URL`, `set-url NAME URL`), by the folder
  // each is given in; `rewired`: the line changes where remotes lead some other way (a rename, a removal, a second
  // address, a setting, a config of its own: what the account rules do not place a push by, policy.ts), so where a
  // remote's name leads is not known. (Anywhere on the line: a setting given for the push itself is one.)
  const added = new Map<string, Map<string, Given & { at: number }>>();
  let rewired = !!from?.rewired || !!reboundBy(parts);
  // `cut`: the last part that is not one of git's own plain commands joined to the next by `&&`.
  let last = -1, cut = -1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.heredoc) continue;
    if (last >= 0) makes.step(parts[last]!, pre.runs[last]!, pre.dirs[last] ?? null);
    last = i;
    const words = pre.runs[i]!.words;
    const dir = pre.dirs[i] ?? null;
    const prog = basename(words[0] ?? "");
    const madeAt = (d: string | null) => ({ ...(d && makes.mayHold(d) ? { loose: true as const, over: makes.over(d) } : {}) });
    // (Until the part shows as one of git's own plain commands, run where the line is, that the next runs only after.)
    const was = cut;
    cut = i;
    const joined = !part.nested && !part.flow && !part.unknown && !part.redirects && part.led === undefined && part.sep === "&&" && !pre.runs[i]!.set.length && part.words[0] === "git";
    if (/^(sh|bash|zsh|dash|ksh)$/.test(prog) && depth < 2) {
      for (const { script } of scriptsOf(shellGiven(words.slice(1)))) {
        const inner = await actsOf(script, dir ?? cwd, home, depth + 1, { rewired: rewired || added.size > 0, makes: makes.mayHold });
        // (What a script does to the remotes is not carried out of it: after one that changes them, they are not read.)
        if (inner.rewired) rewired = true;
        out.push(...inner.acts);
        same.messages.push(...inner.same.messages);
        same.trees.push(...inner.same.trees);
      }
    } else if (prog === "git") {
      const g = gitCall(words, dir, home);
      const at = g?.sub ?? (["push", "commit", "tag", "add"].find((w) => words.includes(w)) ?? "");
      const args = g?.args ?? words.slice(words.indexOf(at) + 1);
      const where = g ? g.dir : dir;
      const here = added.get(where ?? "");
      if (joined && !!g && where === dir && CALM_GIT.has(at)) cut = was;
      if (at === "push") {
        // (A remote given an address in another folder may be this repository's too: not followed.)
        const given = here ? new Map([...here].map(([n, v]) => [n, { url: v.url, how: v.how, ...(v.at > was ? { sure: true as const } : {}), ...(v.again ? { again: true as const } : {}) }] as [string, Given])) : undefined;
        out.push({ is: "push", dir: where, args, ...madeAt(where), ...(given ? { added: given } : {}), ...(rewired || added.size > (here ? 1 : 0) ? { rewired: true as const } : {}) });
      }
      else if (at === "remote" || (!g && words.includes("remote"))) {
        const rest = g?.sub === "remote" ? args : words.slice(words.indexOf("remote") + 1);
        const verb = rest.find((x) => !x.startsWith("-"));
        const ops: string[] = [], opts: string[] = [];
        for (let n = 0; n < rest.length; n++) { const x = rest[n]!; if (x === "-t" || x === "-m") n++; else if (x.startsWith("-")) opts.push(x); else if (n > rest.indexOf(verb ?? "")) ops.push(x); }
        // (git remote add NAME URL, set-url [--push] NAME URL, with no option that says more of where it leads:
        // --mirror=push sends every ref, --add and --delete keep or drop other addresses. A second add of a name fails.)
        const how = verb === "add" ? "add" as const : verb === "set-url" ? (opts.includes("--push") ? "push" as const : "url" as const) : undefined;
        const plain = how !== undefined && !!g && !/[$`*?{}]/.test(ops.join("")) && ops.length === 2 && opts.every((x) => (how === "push" ? x === "--push" : how === "add" && /^(-f|--fetch|--tags|--no-tags)$/.test(x))) && !(how === "add" && here?.has(ops[0]!));
        if (plain) {
          if (!here) added.set(where ?? "", new Map());
          added.get(where ?? "")!.set(ops[0]!, { url: ops[1]!, how, at: i, ...(here?.has(ops[0]!) ? { again: true as const } : {}) });
          if (joined && where === dir) cut = was;
        }
        else if (verb !== undefined && !/^(show|get-url|prune|update)$/.test(verb)) rewired = true;
      }
      else if (at === "commit" || at === "tag") {
        const m = messagesOf(args, `git ${at}`);
        same.messages.push(...m.texts);
        for (const f of m.files) {
          if (f === "-") { same.messages.push({ where: `git ${at} message`, text: docAt[i] ?? (parts[i + 1]?.heredoc ? parts[i + 1]!.doc ?? null : await fedBy(parts, i, dir ?? cwd, docAt)), why: "its message is read from the standard input" }); continue; }
          const path = place(where ?? cwd, f) || resolve(cwd, f);
          same.messages.push({ where: f, text: written.has(path) ? written.get(path)! : await textOf(path), why: `${f} could not be read` });
        }
        for (const v of words.filter((w) => /^user\.(name|email)=|^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)=/.test(w))) same.messages.push({ where: `git ${at} author`, text: v.slice(v.indexOf("=") + 1) });
      }
      if (TREE_SUBS.has(at)) {
        const has = same.trees.find((t) => t.dir === where);
        if (has) has.untracked ||= at === "add"; else same.trees.push({ dir: where, untracked: at === "add", ...madeAt(where) });
      }
    } else if (prog === "gh") {
      const send = ghParse(words);
      if (!send) continue;
      const next = parts[i + 1];
      out.push({ is: "gh", dir, send, part, doc: docAt[i] ?? (next?.heredoc ? next.doc : undefined), feed: () => fedBy(parts, i, dir ?? cwd, docAt), written });
    }
  }
  return { acts: out, same, rewired: rewired || added.size > 0 };
}

// ---- where it goes ----

// `[HOST/]OWNER/REPO` or an address, as gh's -R says it.
function slug(s: string): Repo | null {
  const r = repoOf(s);
  if (r && r.path.length >= 2 && /^[a-z][a-z0-9+.-]*:\/\/|@/.test(s)) return { host: r.host, path: r.path };
  const p = s.replace(/^https?:\/\//i, "").replace(/\.git$/, "").split("/").filter(Boolean).map((x) => x.toLowerCase());
  if (p.length === 2) return { host: "github.com", path: p };
  if (p.length >= 3 && p[0]!.includes(".")) return { host: p[0]!, path: p.slice(1) };
  return null;
}

type Target = { repo: Repo | null; remote?: string; remotes: Remotes | null };
async function remotesAt(dir: string | null): Promise<Remotes | null> {
  if (!dir) return null;
  const r = await remotesIn(dir);
  // (A config that includes another file may send a push elsewhere than its remotes say: not read as known.)
  return r === "late" || r?.includes ? null : r;
}

// The words of a push past its options: the remote or address and the revisions, how wide it sends, whether it deletes.
function pushWords(args: string[]): { pos: string[]; wide: string[]; del: boolean } {
  const pos: string[] = [], wide: string[] = [];
  let del = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a === "--repo") { pos.unshift(args[++i] ?? ""); continue; }
    if (a.startsWith("--repo=")) { pos.unshift(a.slice(7)); continue; }
    if (a === "-o" || a === "--push-option" || a === "--receive-pack" || a === "--exec") { i++; continue; }
    if (a === "--delete" || a === "-d") del = true;
    else if (a === "--all" || a === "--branches") wide.push("--branches");
    else if (a === "--tags") wide.push("--tags");
    else if (a === "--mirror") wide.push("--all");
    else if (!a.startsWith("-") || a === "-") pos.push(a);
  }
  return { pos, wide, del };
}
// A word that names a folder of this machine, as a push reads it.
const LOCAL_PLACE = /^(\.{1,2}|~.*|\/.*|file:.*|\.{1,2}\/.*)$/;
// What a repository's settings pick for a push, written as a folder of this machine.
const PICKED_FOLDER = /^(\.{1,2}|\/.*|\.{1,2}\/.*)$/;
// Where a `git push` sends: the remote it names (or the one git picks) and the repository that remote is.
// `added`: the remotes the same line gave an address before the push, in the folder it runs in. `rewired`: the line
// changes where remotes lead in a way that is not followed: the place is not read (no repository, and not a folder).
// `fresh`: the place is not the one the clone's remote-tracking refs are of (an address the line gave, or one not
// read): what it already has is not known, and every commit of the revisions counts.
// `also`: or the place the disk has for the remote (null: one that is not read): a command of the line that gives it
// another address may not have run before the push.
// An address written on the line (one it gave a remote, or one the push names) is where the push goes only while no
// url rewrite is in force there: with one (url.<base>.insteadOf or .pushInsteadOf in the repository's config or the
// owner's, or a config that includes a file, which may hold one) git may send it elsewhere, and the place is not read.
// (The remotes the disk holds are listed as git rewrites them.)
type Sent = Target & { also?: Repo | null; refs: string[]; wide: string[]; local?: true; del?: true; fresh?: true };
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/|@/i;
const sameRepo = (a: Repo | null, b: Repo | null) => !!a && !!b && a.host === b.host && a.path.join("/") === b.path.join("/");
async function pushTarget(dir: string, args: string[], added?: ReadonlyMap<string, Given>, rewired = false): Promise<Sent> {
  const { pos, wide, del } = pushWords(args);
  const listed = await remotesIn(dir);
  const remotes = listed === "late" || listed?.includes ? null : listed;
  const rewrites = listed === "late" || !!listed?.includes || !!listed?.rewrites;
  const named = pos[0];
  const there: Sent = { repo: null, remotes, refs: [], wide: [], local: true };
  // A push to a folder of this machine (`git push . x:y`, a path, file://) goes to no public place.
  const known = (n: string) => !!added?.has(n) || (!!remotes && (n in remotes.push || n in remotes.fetch));
  if (!rewired && named !== undefined && !known(named) && LOCAL_PLACE.test(named)) return there;
  let remote: string | undefined, url: string | undefined, refs = pos.slice(1), fresh = rewired;
  if (named !== undefined && known(named)) remote = named;
  else if (named !== undefined && slug(named)) { url = named; }
  else if (named !== undefined) { refs = pos; remote = remotes ? pushRemote(remotes) : undefined; }
  else remote = remotes ? pushRemote(remotes) : undefined;
  // A remote the line gave an address. Where its name leads by then depends on what the repository holds for it:
  // `git remote add` fails for a name that is there (the push goes where the disk says), `set-url` leaves a push address
  // of its own in place, `set-url --push` leaves the others of several. Where the disk does not settle it (no
  // repository read here among them), the place is not read.
  // A `set-url` the push may run without (not joined to it by `&&`) may not have run: the remote then leads where the
  // disk says, which counts too (`also`); where the line gave the name an address before as well, the place is not read.
  const given = remote !== undefined ? added?.get(remote) : undefined;
  let lost = rewired, also: string | undefined, folder = false;
  if (url !== undefined && rewrites) lost = true;
  if (given && !lost) {
    const push = remotes?.push[remote!] ?? [], fetch = remotes?.fetch[remote!];
    const has = push.length > 0 || fetch !== undefined;
    const leads = !remotes ? null
      : given.how === "add" ? (has ? undefined : given.url)
      : given.how === "url" ? (!has || (push.length === 1 && push[0] === fetch) ? given.url : null)
      : push.length <= 1 ? given.url : null;
    const unsure = given.how !== "add" && !given.sure, was = push[0] ?? fetch;
    if (leads === null || (unsure && given.again) || (leads !== undefined && rewrites)) lost = true;
    else if (leads !== undefined) {
      if (unsure && was !== undefined && was !== leads && !LOCAL_PLACE.test(was)) also = was;
      if (LOCAL_PLACE.test(leads)) { if (also === undefined) return there; folder = true; }
      url = leads;
      // (The remote-tracking refs under the name are of the address it had: of the same repository, or of another.)
      if (folder || !sameRepo(slug(leads), slug(was ?? ""))) fresh = true;
    }
  }
  const or = also === undefined ? {} : { also: ADDRESS.test(also) ? slug(also) : null };
  // (A remote the repository's settings picked that is no remote's name is an address to git.)
  if (url === undefined && remote && remotes) url = remotes.push[remote]?.[0] ?? remotes.fetch[remote] ?? (ADDRESS.test(remote) ? remote : undefined);
  // (One they picked that is neither is a folder of this machine only when it is written as one: `.`, as a branch that
  // follows a local one has it, `..`, or a path that starts with `/`, `./` or `../`. Any other is a place the rules do
  // not read: a name a url rewrite makes an address of, or one of a file under .git/remotes or .git/branches, which
  // holds an address. It is taken as public.)
  if (!lost && remote && remotes && url === undefined && named === undefined && PICKED_FOLDER.test(remote) && remote === (remotes.branchPushRemote || remotes.pushDefault || remotes.branchRemote)) return there;
  if (lost) return { repo: null, remotes, refs, wide, fresh: true, ...(del ? { del: true as const } : {}) };
  return { repo: url && !folder ? slug(url) : null, ...(folder ? { local: true as const } : {}), ...or, ...(fresh ? {} : { remote }), remotes, refs, wide, ...(del ? { del: true as const } : {}), ...(fresh ? { fresh: true as const } : {}) };
}
// ---- what is in it ----

type Budget = { left: number; cut: boolean };
type Read = { units: Unit[]; unread: string[] };

// The added lines of a diff, each run with the line it starts at, and the names of the files it touches.
function diffUnits(d: string, label: string, units: Unit[], base?: Base) {
  let file = "", at = 0, buf: string[] = [], first = 0;
  const names: string[] = [];
  const flush = () => { if (buf.length && file) units.push({ where: `${label}:${file}`, first, text: buf.join("\n") }); buf = []; };
  for (const line of d.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); file = ""; at = 0; continue; }
    if (at === 0 && line.startsWith("--- ")) { const f = line.slice(4).replace(/^"|"$/g, ""); if (f !== "/dev/null") names.push(f.replace(/^a\//, "")); continue; }
    if (at === 0 && line.startsWith("+++ ")) { const f = line.slice(4).replace(/^"|"$/g, ""); file = f === "/dev/null" ? "" : f.replace(/^b\//, ""); if (file && !names.includes(file)) names.push(file); continue; }
    if (line.startsWith("@@")) { flush(); const m = /^@@ -\S+ \+(\d+)/.exec(line); at = m ? Number(m[1]) : 1; first = at; continue; }
    if (at > 0 && line.startsWith("+")) buf.push(line.slice(1));
  }
  flush();
  if (names.length) units.push({ where: `${label} file names`, first: 1, text: [...new Set(names)].join("\n"), known: base?.file });
}

// A folder that is no repository sends nothing (the push itself fails there): no read of it is missing.
const notRepo = (r: { err: string }) => /not a git repository/i.test(r.err);
// What a failed or cut read of git says.
const why = (what: string, r: { code: number; err: string }) => (r.code === -1 ? `${what} was cut off (timed out)` : `${what} failed${r.err.trim() ? `: ${r.err.trim().split("\n")[0]!.slice(0, 160)}` : ""}`);

// The commits a push would send: those the remote's tracking refs lack, from the revisions it names.
async function pushUnits(dir: string, t: Sent, budget: Budget, base: Base): Promise<Read> {
  // A delete sends no commit and no text: the name goes away.
  if (t.del) return { units: [], unread: [] };
  const revs: string[] = [...t.wide];
  const names: string[] = [];
  let deletes = 0;
  for (const r of t.refs) {
    const [from, to] = r.replace(/^\+/, "").split(":") as [string, string | undefined];
    if (!from && to) { deletes++; continue; }
    // A name the line cannot know (a variable or a substitution as the source) is every branch.
    const unknown = (n: string | undefined) => !!n && /[$`{}*\s(]/.test(n);
    // (A name goes out as the destination's: `HEAD:x` sends x, not the branch HEAD is.)
    for (const n of [to || from]) if (n && !n.startsWith("-") && !unknown(n)) names.push(n.replace(/^refs\/(heads|tags)\//, ""));
    if (unknown(from)) { if (!revs.includes("--branches")) revs.push("--branches"); }
    else if (from && !from.startsWith("-")) revs.push(from);
  }
  if (!revs.length && deletes && deletes === t.refs.length) return { units: [], unread: [] };
  if (!revs.length) revs.push("HEAD");
  const units: Unit[] = [], unread: string[] = [];
  // The branch and tag names it sends (HEAD is the branch it is on).
  if (!names.length || names.includes("HEAD")) {
    const b = await git(dir, ["branch", "--show-current"], { mode: "plain", read: true, timeout: 10_000 });
    if (b.code === 0 && b.out.trim()) names.push(b.out.trim());
  }
  const shown = [...new Set(names.filter((n) => n !== "HEAD"))];
  if (shown.length) units.push({ where: "git push branch names", first: 1, text: shown.join("\n"), known: base.branch });
  const args = ["log", "--no-color", "--no-textconv", "--no-ext-diff", "--no-renames", "-p", "-U0", "--format=%x00H%h%x00%B%x00P%an <%ae>%n%cn <%ce>%x00D",
    ...revs, ...(t.fresh ? [] : ["--not", t.remote ? `--remotes=${t.remote}` : "--remotes"]), "--"];
  let hash = "", stage: "head" | "message" | "people" | "diff" = "head";
  const r = await gitEach(dir, args, { read: true, timeout: LOG_MS }, (entries) => {
    for (const e of entries) {
      if (stage === "head") { if (e.startsWith("H")) { hash = e.slice(1); stage = "message"; } continue; }
      if (stage === "message") { units.push({ where: `commit ${hash} message`, first: 1, text: e }); budget.left -= e.length; stage = "people"; continue; }
      if (stage === "people") { units.push({ where: `commit ${hash} author and committer`, first: 1, text: e.slice(1) }); stage = "diff"; continue; }
      // (The diff of a commit runs to the next commit's header.)
      if (e.startsWith("D")) { diffUnits(e.slice(1), `commit ${hash}`, units, base); budget.left -= e.length; stage = "head"; }
      if (budget.left <= 0) { budget.cut = true; return false; }
    }
    return true;
  });
  if (r.code !== 0 && !r.stopped && !notRepo(r)) unread.push(`git push: ${why("reading the commits", r)}`);
  if (budget.cut) unread.push(`git push: the commits past the first ${Math.round(READ_MAX / 1_000_000)} MB of text were not read`);
  // An annotated tag says something of its own.
  const tags = t.wide.includes("--tags") ? ["refs/tags"] : shown.map((n) => `refs/tags/${n}`);
  if (tags.length) {
    const g = await git(dir, ["for-each-ref", "--count=200", "--format=%(refname:short)%00%(contents)%00", ...tags], { mode: "plain", read: true, timeout: 10_000 });
    if (g.code === 0) { const l = g.out.split("\0"); for (let i = 0; i + 1 < l.length; i += 2) if (l[i + 1]!.trim()) units.push({ where: `tag ${l[i]!.trim()} message`, first: 1, text: l[i + 1]! }); }
    else if (!notRepo(g)) unread.push(`git push: ${why("reading the tags", g)}`);
  }
  return { units, unread };
}

// What the repository a push goes to already has, by the remote-tracking refs the clone holds: its branch names and the
// files of the branches this push goes to (or the remote's default). A name it has says nothing new.
type Base = { branch(name: string): Promise<boolean>; file(path: string): Promise<boolean> };
function baseOf(dir: string, t: Sent): Base {
  const remote = t.remote;
  let heads: Promise<Set<string>> | undefined, tree: Promise<Set<string>> | undefined;
  const branches = () => (heads ??= (async () => {
    if (!remote) return new Set<string>();
    const r = await git(dir, ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`], { mode: "plain", read: true, timeout: 10_000 });
    return new Set(r.code === 0 ? r.out.split("\n").filter(Boolean).map((x) => x.slice(`refs/remotes/${remote}/`.length)) : []);
  })());
  const files = () => (tree ??= (async () => {
    const all = new Set<string>();
    const have = await branches();
    const pushed = t.refs.flatMap((r) => { const [from, to] = r.replace(/^\+/, "").split(":"); return [to ?? from ?? ""].map((x) => x.replace(/^refs\/heads\//, "")); });
    const base = [...new Set([...pushed, "HEAD", "main", "master"])].filter((n) => n && have.has(n)).slice(0, 3);
    for (const n of base) {
      const r = await git(dir, ["ls-tree", "-r", "--name-only", "--full-tree", `refs/remotes/${remote}/${n}`], { mode: "plain", read: true, timeout: 20_000 });
      if (r.code === 0) for (const f of r.out.split("\n")) if (f) all.add(f);
    }
    return all;
  })());
  return { branch: async (n) => (await branches()).has(n.trim()), file: async (n) => (await files()).has(n.trim()) };
}

// What the commit a line makes will hold: the index and the working tree against HEAD (and the files not yet tracked
// when the line adds).
async function treeUnits(dir: string, untracked: boolean, budget: Budget, there?: Base): Promise<Read> {
  const units: Unit[] = [], unread: string[] = [];
  const base = ["diff", "--no-color", "--no-textconv", "--no-ext-diff", "--no-renames", "-U0"];
  let text = "";
  const take = (e: string[]) => { text += e.join("\0"); return text.length < budget.left; };
  let r = await gitEach(dir, [...base, "HEAD", "--"], { read: true, timeout: LOG_MS }, take);
  if (r.code === 128) { text = ""; r = await gitEach(dir, [...base, "--cached", "--"], { read: true, timeout: LOG_MS }, take); }
  if (r.code !== 0 && !r.stopped && !notRepo(r)) unread.push(`the commit made on this line: ${why("reading its changes", r)}`);
  if (r.stopped) { budget.cut = true; unread.push("the commit made on this line: its changes past the limit were not read"); }
  budget.left -= text.length;
  diffUnits(text, "working tree", units, there);
  if (untracked) {
    const l = await git(dir, ["ls-files", "--others", "--exclude-standard", "-z"], { mode: "plain", read: true, timeout: 10_000 });
    if (l.code !== 0) { if (!notRepo(l)) unread.push(`the commit made on this line: ${why("listing the new files", l)}`); }
    else {
      const files = l.out.split("\0").filter(Boolean);
      if (files.length > TREE_FILES) unread.push(`the commit made on this line: ${files.length - TREE_FILES} new files past the first ${TREE_FILES} were not read`);
      const names: string[] = [];
      for (const f of files.slice(0, TREE_FILES)) {
        names.push(f);
        const body = await textOf(resolve(dir, f));
        if (body === null) { unread.push(`new file ${f} could not be read`); continue; }
        if (body.includes("\0")) continue;
        units.push({ where: `working tree:${f}`, first: 1, text: body });
        budget.left -= body.length;
      }
      if (names.length) units.push({ where: "working tree new file names", first: 1, text: names.join("\n"), known: there?.file });
    }
  }
  return { units, unread };
}

async function textOf(path: string): Promise<Maybe> {
  if (!path) return null;
  try { const t = await readFile(path, "utf8"); return t.length <= FILE_MAX ? t : null; } catch { return null; }
}

// What a gh write publishes, as text with its place.
async function ghUnits(a: Extract<Act, { is: "gh" }>): Promise<Read> {
  const { send } = a;
  const where = `gh ${send.group}${send.verb ? ` ${send.verb}` : ""}`;
  const units: Unit[] = [], unread: string[] = [];
  const add = (w: string, text: string) => units.push({ where: w, first: 1, text });
  const file = async (f: string, w: string) => {
    const path = place(a.dir, f);
    const made = a.written.get(path);
    const text = f === "-" ? (a.doc ?? await a.feed()) : made !== undefined ? made : await textOf(path);
    if (text !== null) add(f === "-" ? `${w} body` : f, text);
    else unread.push(`${w}: ${f === "-" ? "the text it is given on the standard input" : f} could not be read${made === null ? " (an earlier command of the line writes it)" : ""}`);
  };
  if (a.part.dyn?.length) add(where, a.part.text);
  if (send.group === "api") {
    const method = valuesOf(send.opts, ["-X", "--method"])[0]?.toUpperCase();
    const fields = send.opts.filter((o) => ["-f", "--raw-field", "-F", "--field"].includes(o.flag));
    const input = valuesOf(send.opts, ["--input"])[0];
    if ((method ?? (fields.length || input ? "POST" : "GET")) === "GET") return { units: [], unread: [] };
    for (const f of fields) {
      const eq = f.value.indexOf("=");
      const key = eq > 0 ? f.value.slice(0, eq) : f.value, val = eq > 0 ? f.value.slice(eq + 1) : "";
      if (["-F", "--field"].includes(f.flag) && val.startsWith("@")) await file(val.slice(1), `${where} ${key}`);
      else add(`${where} ${key}`, val);
    }
    if (input) await file(input, `${where} input`);
    return { units, unread };
  }
  const spec = send.spec!;
  for (const [k, names] of [["title", spec.title], ["body", spec.body]] as const) for (const v of valuesOf(send.opts, names)) if (v !== "$(...)") add(`${where} ${k}`, v);
  for (const f of valuesOf(send.opts, spec.file)) await file(f, where);
  if (spec.tag && send.pos[0]) add(`${where} tag`, send.pos[0]);
  if (spec.files) for (const f of send.pos) { await file(f, `${where} file`); if (f !== "-") add(`${where} file name`, basename(f)); }
  return { units, unread };
}

// ---- reading, on the loop without holding it ----

// A text in slices (at line ends where it has them), so that no one regular expression runs over a whole commit.
const CARRY = 256;
function* slices(text: string, first: number): Generator<{ first: number; text: string }> {
  let at = 0, line = first, tail = "";
  while (at < text.length) {
    let end = Math.min(text.length, at + SLICE);
    if (end < text.length) { const nl = text.lastIndexOf("\n", end - 1); if (nl > at) end = nl + 1; }
    const part = text.slice(at, end);
    // A line cut by the slice goes on in the next one: its last characters come with it, so a word the cut fell in is whole.
    yield { first: line, text: tail + part };
    tail = part.endsWith("\n") ? "" : part.slice(-CARRY);
    for (let i = part.indexOf("\n"); i >= 0; i = part.indexOf("\n", i + 1)) line++;
    at = end;
  }
}

async function scan(find: (u: readonly Unit[]) => Finding[], units: Unit[], unread: string[]): Promise<Finding[]> {
  const out: Finding[] = [], seen = new Set<string>();
  let t = performance.now();
  for (const u of units) {
    let text = u.text;
    if (text.length > UNIT_MAX) { unread.push(`${u.where}: ${text.length - UNIT_MAX} characters past the first ${UNIT_MAX / 1_000_000} MB were not read`); text = text.slice(0, UNIT_MAX); }
    for (const s of slices(text, u.first)) {
      for (const f of timed(() => `reading ${u.where} for private words`, () => find([{ where: u.where, first: s.first, text: s.text }]))) {
        if (u.known) f.known = u.known;
        const key = `${f.kind}\0${f.word}\0${f.where}\0${f.line}`;
        if (!seen.has(key)) { seen.add(key); out.push(f); }
      }
      if (performance.now() - t > 8) { await new Promise<void>((done) => setImmediate(done)); t = performance.now(); }
    }
  }
  return out;
}

// ---- what the world says ----

type Kept = { at: number; v: Visibility };
const seen = new Map<string, Kept>();
const PUBLIC_MS = 600_000, UNSURE_MS = 30_000;
type Ran = { out: string; err: string; code: number };
// A program run with an end: at `ms` its whole process group is killed and nothing waits for its pipes (a helper that
// the program started would hold them open long after it).
export const bounded = async (argv: string[], env: Record<string, string | undefined>, ms: number): Promise<Ran> => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { cwd: "/", env: env as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return { out: "", err: (e as Error).message, code: -2 };
  }
  const done = Promise.all([readText(p.stdout as ReadableStream<Uint8Array>), readText(p.stderr as ReadableStream<Uint8Array>), p.exited]).then(([out, err, code]): Ran => ({ out, err, code: p.signalCode ? -1 : code }));
  const settled = done.catch((e): Ran => ({ out: "", err: String(e), code: -2 }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<Ran>((res) => {
    timer = setTimeout(() => {
      try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } }
      res({ out: "", err: "timed out", code: -1 });
    }, ms);
  });
  try { return await Promise.race([settled, cut]); } finally { clearTimeout(timer); }
};

// Asked of the remote: `gh repo view` for what it says (a repository gh cannot see is asked of git, anonymously).
export async function askVisibility(repo: Repo): Promise<Visibility> {
  const name = `${repo.host}/${repo.path.join("/")}`;
  const hit = seen.get(name);
  if (hit && Date.now() - hit.at < (hit.v === "unknown" ? UNSURE_MS : PUBLIC_MS)) return hit.v;
  const v = await ask(repo, name);
  seen.set(name, { at: Date.now(), v });
  return v;
}
export const forgetVisibility = () => seen.clear();

const PROBE_MS = 10_000;
async function ask(repo: Repo, name: string): Promise<Visibility> {
  const g = await bounded([process.env.KEEL_GH_BIN || "gh", "repo", "view", name, "--json", "visibility", "-q", ".visibility"], gitEnv("/"), PROBE_MS);
  if (g.code === 0) { const v = g.out.trim().toUpperCase(); if (v === "PUBLIC") return "public"; if (v === "PRIVATE" || v === "INTERNAL") return "private"; }
  // Anonymous, with no config of the owner's (a rewrite of the address to ssh would let his key in): what answers is public.
  // (git's own helper holds the connection: the wait on it ends at PROBE_MS whatever the helper does.)
  const url = `https://${repo.host}/${repo.path.join("/")}`;
  const env = { HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ASKPASS: "true", SSH_ASKPASS: "true", GCM_INTERACTIVE: "never", GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "5" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    git("/", ["ls-remote", "--exit-code", "-q", url, "HEAD"], { mode: "plain", env, timeout: PROBE_MS }),
    new Promise<{ code: number; err: string }>((res) => { timer = setTimeout(() => res({ code: -1, err: "timed out" }), PROBE_MS + 500); }),
  ]);
  clearTimeout(timer);
  if (r.code === 0 || r.code === 2) return "public";
  return r.code === -1 || r.code === -2 || /resolve host|timed out|timeout|connection (?:refused|reset)|network is unreachable|could not connect|ssl/i.test(r.err) ? "unknown" : "private";
}

// ---- what is private ----

const SHAPED = /[-_.\d]/;
// A name that is no word of ordinary text: it has a mark in it, or a digit, or a capital after its first letter.
const distinct = (n: string) => n.length >= 4 && (SHAPED.test(n) || /[a-z][A-Z]/.test(n));
const NEWEST = 300, MESSAGE_MAX = 20_000;
type Known = { at: number; terms: string[]; folders: Map<string, string[]> };
const machines = new WeakMap<Store, Known>();

// The dictionary's words, where the machine has one: a word of ordinary text is not found inside a longer name.
let dictionary: Promise<Set<string>> | undefined;
const dictionaryWords = () => (dictionary ??= (async () => {
  for (const f of ["/usr/share/dict/words", "/usr/share/dict/american-english"]) {
    try { return new Set((await readFile(f, "utf8")).split("\n").filter((w) => /^[a-z]{5,}$/.test(w))); } catch { /* none here */ }
  }
  return new Set<string>();
})());

// What the owner typed, as against what a session's notices say in a user message: a wait that fired, an agent's report,
// a task notification, a restart note. A message the harness made has its origin; an imported history carries the same
// notices with none, so their shapes are read there: a block is cut out of the message (what follows it, if the owner wrote
// on, is his), and a notice the harness writes whole is dropped whole, only when it has the full shape the harness gives it.
const NOT_SAID = new Set(["harness", "restart", "wait", "subagent", "loop", "goal", "task", "parent", "peer", "channel", "hook", "momentum"]);
const BLOCK = /^\s*<(wait_fired|task-notification|external_input|system-reminder|subagent_result)\b[^>]*>[\s\S]*?<\/\1>/;
const WHOLE = [
  /^\s*Message from the session that started you:\n/,
  /^\s*\[from session "[^"\n]*"[^\]\n]*\]/,
  /^\s*\[(?:harness|momentum)\]/,
  /^\s*Something failed in Keel(?: \(session "[^"\n]*"\))?: [^\n]*\n\nThe debug bundle is /,
  /^\s*You are taking over a session\b[^\n]*\n/,
];
const HEADER = /^\s*An agent you started has reported\.[^\n]*\n+/;
const OPENS = /^\s*<(?:wait_fired|task-notification|external_input|system-reminder|subagent_result)\b/;
// The owner's words in a user message, or null when it holds none.
export function typedText(e: StoredEvent): string | null {
  if (!ownerWords(e) || NOT_SAID.has(e.data.origin)) return null;
  let text = String(e.data.text ?? "");
  if (e.data.origin !== undefined && e.data.origin !== null) return text;
  if (WHOLE.some((r) => r.test(text))) return null;
  text = text.replace(HEADER, "");
  for (let m = BLOCK.exec(text); m; m = BLOCK.exec(text)) text = text.slice(m[0].length);
  // A block that never closes cannot be told from the words after it.
  if (OPENS.test(text)) return null;
  return text.trim() ? text : null;
}

// How many times the owner's sentences were made (a session's are kept until it says something new).
export const learned = { sentences: 0 };
const sayings = new WeakMap<Store, Map<string, { seq: number; sentences: string[] }>>();

// The owner's sentences of the session: his own typed messages, the newest first, read from the root session.
async function ownerSays(store: Store, sessionId: string): Promise<string[]> {
  try {
    let root = store.session(sessionId);
    for (let i = 0; root?.parent_id && i < 32; i++) root = store.session(root.parent_id) ?? undefined;
    if (!root) return [];
    const seq = store.lastSeq(root.id);
    let kept = sayings.get(store);
    if (!kept) sayings.set(store, (kept = new Map()));
    const hit = kept.get(root.id);
    if (hit && hit.seq === seq) return hit.sentences;
    await store.warm(root.id, false);
    const line = store.lineage(root.id);
    const said: string[] = [];
    for (let i = line.length - 1; i >= 0 && said.length < NEWEST; i--) {
      const e = line[i]!;
      if (e.kind !== "user") continue;
      await store.warmBodies(root.id, e.seq, e.seq);
      const t = typedText(e);
      if (t) said.push(t.slice(0, MESSAGE_MAX));
    }
    learned.sentences++;
    const sentences = sentencesOf(said);
    kept.set(root.id, { seq, sentences });
    return sentences;
  } catch {
    return [];
  }
}

// A folder of scratch work (task folders under the cache, the temporary folders): its name is no project's.
const scratch = (w: string) => { const h = homeDir(); return w.startsWith(`${h}/.cache/`) || /^\/(?:tmp|var\/tmp|dev\/shm)\//.test(w); };

// What the owner's machines and folders say, kept a few minutes: the machines of the fleet, the aliases of his ssh
// config, this machine's name, and the folders his sessions work in.
function known(store: Store, now = Date.now()) {
  const kept = machines.get(store);
  if (kept && now - kept.at < 300_000) return kept;
  const terms = new Set<string>();
  const add = (n: string | null | undefined, explicit = true) => { const v = n?.trim(); if (v && !/\s/.test(v) && (explicit ? v.length >= 3 : distinct(v) || v.length >= 5)) terms.add(v); };
  try {
    for (const r of store.db.query<{ name: string; ssh_host: string | null; daemon_url: string | null }, []>("SELECT name, ssh_host, daemon_url FROM fleet_machines").all()) {
      add(r.name); add(r.ssh_host);
      try { const h = r.daemon_url ? new URL(r.daemon_url).hostname : ""; if (h && !/^(localhost|127\.|\[?::1)/.test(h)) add(h); } catch { /* not an address */ }
    }
  } catch { /* no fleet table here */ }
  try { for (const a of sshHosts()) if (!a.includes(".")) add(a, false); } catch { /* no ssh config */ }
  try { add(hostname().split(".")[0], false); } catch { /* none */ }
  const folders = new Map<string, string[]>();
  try {
    for (const r of store.db.query<{ workspace: string }, []>("SELECT DISTINCT workspace FROM sessions WHERE workspace IS NOT NULL AND outside IS NULL").all()) {
      const w = r.workspace;
      if (!w || /\/worktrees\//.test(w) || /\.worktrees\//.test(w) || scratch(w)) continue;
      const n = basename(w);
      if (!distinct(n)) continue;
      const l = folders.get(n.toLowerCase());
      if (l) l.push(w); else folders.set(n.toLowerCase(), [w]);
    }
  } catch { /* no sessions table */ }
  const made = { at: now, terms: [...terms], folders };
  machines.set(store, made);
  return made;
}

// What counts as private for a session, from what Keel knows of the owner.
export function learner(store: Store): Deps["words"] {
  return async (sessionId) => {
    const k = known(store);
    const dict = await dictionaryWords();
    const listed = ((settings().private?.terms as string[] | undefined) ?? []).filter((t) => typeof t === "string" && t.trim());
    const home = homeDir();
    let login = "";
    try { login = userInfo().username; } catch { /* none */ }
    const homes = [home, ...(login ? [`/home/${login}`, `/Users/${login}`] : [])];
    // The owner's own names are public by being his: his login and the owners of his accounts.
    const mine = [...(login ? [login.toLowerCase()] : []), ...accountNames().flatMap((n) => (n.kind === "forge" ? [n.path[0]!] : []))];
    // A folder that is gone is no project of his: its name is nothing to keep.
    const live = new Map<string, string[]>();
    for (const [n, l] of k.folders) { const here = l.filter((w) => existsSync(w)); if (here.length) live.set(n, here); }
    return {
      words: { terms: [...listed, ...k.terms], projects: [...live.keys()], homes, sentences: await ownerSays(store, sessionId), holds: (t) => vault.holdsValue(t), common: (w) => dict.has(w.toLowerCase()) },
      folders: live,
      mine,
    };
  };
}

// ---- the check ----

// Whether the repository the disk shows for a folder is the one a command there finds, though the same line makes one
// the folder would be in (`over`, line-makes.ts). It is when it stands at or under each place the line makes one: an
// init of a repository that is there changes nothing, and a clone or a new checkout into a folder that holds one
// fails. Where the line makes one in a place the words do not say, only a folder that is the top of its repository.
function standing(dir: string, over: Over | undefined): boolean {
  try {
    const w = locate(dir), top = w?.top ?? w?.gitDir;
    if (!top) return false;
    if (over?.any && realDir(dir) !== top) return false;
    return (over?.places ?? []).every((p) => { const r = realDir(p); return top === r || top.startsWith(`${r}/`); });
  } catch { return false; } // (a place that is not there, or not ours to read)
}

// A word of a line that names a .git folder or a file under one (not an address that ends in `.git`).
const GIT_FILES = /(^|[\s"'=\/:])\.git($|[\s"'\/;&|)])/;
// What a call sends to a public place that holds a private word (or could not be read), or null. `deps.visibility`
// says whether a repository is public.
export async function held(command: string, cwd: string, deps: Deps, session: string): Promise<Held | null> {
  if (!/\b(push|gh)\b/.test(command)) return null;
  const { acts, same } = await actsOf(command, cwd, homeDir());
  if (!acts.length) return null;
  const budget: Budget = { left: READ_MAX, cut: false };
  const units: Unit[] = [];
  const said: string[] = [], unread: string[] = [];
  const targets: Repo[] = [];
  let sends = false, pushes = false, firstBase: Base | undefined, rewritten: boolean | "late" | undefined;
  // (Whether every send names the repository it goes to.)
  let placed = true;
  // The repository each send goes to, and whether it is public (once for each).
  const vis = new Map<string, Promise<Visibility>>();
  const publicly = async (repo: Repo | null): Promise<boolean> => {
    if (!repo) return true;
    const key = `${repo.host}/${repo.path.join("/")}`;
    if (!vis.has(key)) vis.set(key, deps.visibility(repo));
    return (await vis.get(key)!) !== "private";
  };
  // Whether a push from a repository the line makes says itself that it goes to no public place: it names a folder of
  // this machine, an address, or a remote the line added there (the push runs only when that worked, so the remote
  // is new and leads where the line says), and the place is a folder or a private repository. Not when the line
  // changes where remotes lead some other way, or the owner's own git config can (a url rewrite, a template).
  const aside = async (a: Extract<Act, { is: "push" }>): Promise<boolean> => {
    // (Nor where the line makes a repository with options the rules do not read, a template among them, or names a
    // file under a .git folder: either can give the new repository a url rewrite, which sends the address elsewhere.)
    if (a.rewired || a.over?.any || GIT_FILES.test(command)) return false;
    const named = pushWords(a.args).pos[0];
    const given = named === undefined ? undefined : a.added?.get(named);
    const to = given ? (given.sure ? given.url : undefined) : named !== undefined && (LOCAL_PLACE.test(named) || ADDRESS.test(named)) ? named : undefined;
    if (to === undefined) return false;
    if (LOCAL_PLACE.test(to)) return true;
    const repo = ADDRESS.test(to) ? slug(to) : null;
    if (!repo || (rewritten ??= await rewritesOwn()) !== false) return false;
    return !(await publicly(repo));
  };
  for (const a of acts) {
    if (a.is === "push") {
      if (!a.dir) { unread.push("git push: the folder it runs in is not known"); continue; }
      // A folder that is not there: one the same line may make is not read. Any other is gone: the push fails there,
      // and sends nothing.
      // (A repository the line makes is not on the disk to read. A push from one that says itself it goes to a folder
      // of this machine or to a private repository sends nothing to a public place.)
      if (!existsSync(a.dir)) {
        if (a.loose && !(await aside(a))) unread.push(`git push: the folder it runs in (${a.dir}) is not there yet, the same line may make it, and what it would send could not be read`);
        continue;
      }
      // A folder that is there, where the line makes a repository before the push (a git init of a folder with files in
      // it, a clone into an empty one): the disk shows none of its own there, or one around it, and not what the push sends.
      else if (a.loose && !standing(a.dir, a.over)) {
        if (!(await aside(a))) unread.push(`git push: the same line makes a repository where it runs (${a.dir}), which is not on the disk yet: what it would send could not be read`);
        continue;
      }
      const t = await pushTarget(a.dir, a.args, a.added, !!a.rewired);
      // (To a folder of this machine, or to a private repository: and so is the other place it may go, when there is one.)
      const goes = t.local ? false : await publicly(t.repo), other = t.also === undefined ? false : await publicly(t.also);
      if (!goes && !other) continue;
      sends = true;
      if (!t.del && !(t.refs.length && !t.wide.length && t.refs.every((x) => x.startsWith(":")))) pushes = true;
      for (const x of [goes ? t.repo : null, other ? t.also : null]) if (x) targets.push(x);
      const to = goes ? t.repo : t.also;
      if (!to) placed = false;
      said.push(`git push${to ? ` to ${to.host}/${to.path.join("/")}` : ""}`);
      const base = baseOf(a.dir, t);
      firstBase ??= base;
      const r = await pushUnits(a.dir, t, budget, base);
      units.push(...r.units); unread.push(...r.unread);
      continue;
    }
    // A gh write that publishes: pr, issue, release, gist (when public), repo edit, api.
    const { send } = a;
    let repo: Repo | null = null;
    const named = valuesOf(send.opts, ["-R", "--repo"])[0];
    if (send.group === "gist") {
      if (!send.opts.some((o) => send.spec!.open!.includes(o.flag))) continue; // (a gist is secret unless it is made public)
    } else if (named) repo = slug(named);
    else if (send.spec?.repo && send.pos[0] && slug(send.pos[0])) repo = slug(send.pos[0]);
    else if (send.group === "api") {
      const m = /^\/?repos\/([^/{]+)\/([^/{]+)/.exec(send.pos[0] ?? "");
      if (m) repo = { host: "github.com", path: [m[1]!.toLowerCase(), m[2]!.toLowerCase()] };
      else if (/^\/?repos\/\{owner\}/.test(send.pos[0] ?? "")) { const r = await remotesAt(a.dir); repo = r ? ghBase(r) : null; }
    } else { const r = await remotesAt(a.dir); repo = r ? ghBase(r) : null; }
    if (!(await publicly(repo))) continue;
    const r = await ghUnits(a);
    if (send.group === "api" && !r.units.length && !r.unread.length) continue; // (a read)
    sends = true;
    if (repo) targets.push(repo); else placed = false;
    said.push(`gh ${send.group}${send.verb ? ` ${send.verb}` : ""}${repo ? ` on ${repo.host}/${repo.path.join("/")}` : ""}`);
    units.push(...r.units); unread.push(...r.unread);
  }
  // What the commits made on the same line will hold.
  if (pushes) {
    for (const m of same.messages) {
      if (m.text === null) unread.push(`${m.where}: ${m.why ?? "its text could not be read"}`);
      else units.push({ where: m.where, first: 1, text: m.text });
    }
    for (const t of same.trees) {
      if (!t.dir) { unread.push("a commit made on this line: the folder it runs in is not known"); continue; }
      if (!existsSync(t.dir)) { if (t.loose) unread.push(`a commit made on this line: the folder it runs in (${t.dir}) is not there yet, the same line may make it, and what it holds could not be read`); continue; }
      if (t.loose && !standing(t.dir, t.over)) { unread.push(`a commit made on this line: the same line makes a repository where it runs (${t.dir}), which is not on the disk yet: what it holds could not be read`); continue; }
      const r = await treeUnits(t.dir, t.untracked, budget, firstBase);
      units.push(...r.units); unread.push(...r.unread);
    }
  }
  if (!sends && !unread.length) return null;
  if (!units.length && !unread.length) return null;
  const learned = await deps.words(session);
  // What is his own, and the repository the text goes to, is no private word.
  const drop = new Set<string>([...(learned.mine ?? []), ...targets.flatMap((t) => [t.path[0]!, t.path[t.path.length - 1]!])].map((x) => x.toLowerCase()));
  const kept = (l: readonly string[]) => l.filter((x) => !drop.has(x.toLowerCase()));
  const find = matcher({ ...learned.words, terms: kept(learned.words.terms), projects: kept(learned.words.projects) });
  const found = await scan(find, units, unread);
  // A project's name is private when a live folder of it has a repository that is not public.
  const keep: Finding[] = [];
  const settled = new Map<string, boolean>();
  for (const f of found) {
    const { known: _known, ...plain } = f;
    if (f.kind !== "project") { keep.push(plain); continue; }
    // A name of a branch or a file the repository already has says nothing new; a new one is public once pushed.
    if (f.known && (await f.known(f.text).catch(() => false))) continue;
    const name = f.word.toLowerCase();
    if (!settled.has(name)) {
      const live = (learned.folders.get(name) ?? []).filter((w) => existsSync(w));
      let open = !live.length;
      for (const ws of live) {
        const r = await remotesAt(ws);
        const urls = r ? [...new Set(Object.values(r.fetch))] : [];
        const repos = urls.map(slug).filter((x): x is Repo => !!x);
        if (repos.length && (await Promise.all(repos.map((x) => deps.visibility(x)))).every((v) => v === "public")) open = true;
      }
      settled.set(name, open);
    }
    if (!settled.get(name)) keep.push(plain);
  }
  return keep.length || unread.length ? { found: keep, acts: said, unread, ...(placed && targets.length ? { to: [...new Set(targets.map((t) => `${t.host}/${t.path.join("/")}`))] } : {}) } : null;
}

// The words of a hold, for the card and for an agent: what was found, quoted with its place, and what was not read.
export function heldWhy(h: Held): string {
  const head = `This goes to a public place under your name (${h.acts.join("; ") || "a public send"})`;
  const out = [h.found.length ? `${head} and holds private words:\n${say(h.found)}` : `${head}.`];
  if (h.unread.length) out.push(`Part of it could not be read for private words:\n${h.unread.slice(0, 6).join("\n")}${h.unread.length > 6 ? `\nand ${h.unread.length - 6} more` : ""}`);
  if (h.again) out.push(`Not listed again: ${h.again} more that you allowed to go there earlier in this session.`);
  return out.join("\n");
}
// What an agent is told: the same words, and what to do.
export function heldRefusal(h: Held): string {
  return `Refused: ${heldWhy(h)}\nTake ${h.found.length ? "the private words out" : "what could not be read out of the send, or send it so it can be read,"} and send it again. If it should go as it is, report to your parent what you wanted to send: the owner can allow it once.`;
}
