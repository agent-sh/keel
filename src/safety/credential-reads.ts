// What a shell command reads of where credentials are kept (credentials.ts), judged from its words: the files and
// stores it names to a program that reads them, straight or through a helper (xargs, find -exec, a substitution), a
// wildcard that can reach one, a copy of one, and a recursive search of a folder that holds the home's stores or
// files named like credentials. A file tool's read of the same paths is the same class (policy.ts decides both).
import { readdirSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { credentialName, storesSaid, storesUnder, STORES, type Credential } from "./credentials.ts";
import { laid, type Laid } from "./risk.ts";
import { name as baseName } from "./risk-words.ts";
import type { Made, Simple } from "./shell.ts";

// Programs whose file operands are read for their content (a command of the shell's allow-list prints them, or
// what they hold). A program that names files only (ls, stat, test, find, wc, a checksum) reads no credential.
const CONTENT_READERS = new Set(["cat", "tac", "head", "tail", "less", "more", "most", "nl", "grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "mawk", "nawk",
  "cut", "sort", "uniq", "strings", "xxd", "od", "hexdump", "hd", "base64", "base32", "basenc", "diff", "diff3", "sdiff", "cmp", "comm", "join", "paste", "fold", "fmt", "column",
  "jq", "yq", "gojq", "bat", "batcat", "iconv", "expand", "unexpand", "rev", "look", "zcat", "zless", "zmore", "bzcat", "xzcat", "zstdcat", "lz4cat", "pr"]);
// Programs that copy, move or link their sources (every operand but the last, or all of them when the target is
// named by an option): the copy is where the file's content goes next, so a credential as a source is a read of it.
const COPIERS = new Set(["cp", "mv", "rsync", "ln", "install", "scp"]);
const COPY_VALUED: Record<string, RegExp> = {
  cp: /^(-t|--target-directory|-S|--suffix)$/, mv: /^(-t|--target-directory|-S|--suffix)$/, ln: /^(-t|--target-directory|-S|--suffix)$/,
  install: /^(-t|--target-directory|-m|--mode|-o|--owner|-g|--group|-S|--suffix|--strip-program)$/,
  scp: /^(-[cFiJloPS]|-D)$/,
  rsync: /^(-e|--rsh|--exclude|--include|--exclude-from|--include-from|--files-from|-f|--filter|--rsync-path|--port|--bwlimit|--log-file|--temp-dir|-T|--compare-dest|--link-dest|--copy-dest|-M|--remote-option|--chmod|--chown|--usermap|--groupmap|--max-size|--min-size|--timeout|--contimeout|-B|--block-size|--modify-window|--out-format|--info|--debug|--partial-dir)$/,
};
const TARGETED = /^(?:-t|--target-directory(?:=.*)?|-[a-zA-Z]*t[a-zA-Z]*)$/;
// The searchers: their first operand is the pattern unless one is given as an option.
const SEARCHERS = new Set(["grep", "egrep", "fgrep", "zgrep", "rg", "ag", "ack"]);
// The options of each searcher whose value is the next word, from its manual: the pattern and pattern files (`-f`
// reads a file), the globs, types, counts and the like. (`-r` is grep's recursion and ripgrep's replacement.)
const SEARCH_VALUED: Record<string, RegExp> = {
  grep: /^(-e|--regexp|-f|--file|-m|--max-count|-A|--after-context|-B|--before-context|-C|--context|-d|--directories|-D|--devices|--include|--exclude|--exclude-dir|--exclude-from|--label|--binary-files|--group-separator)$/,
  rg: /^(-e|--regexp|-f|--file|-m|--max-count|-A|--after-context|-B|--before-context|-C|--context|-d|--max-depth|-g|--glob|--iglob|-t|--type|-T|--type-not|-M|--max-columns|-j|--threads|-E|--encoding|--pre|--pre-glob|--sort|--sortr|--type-add|--type-clear|--colors|--path-separator|-r|--replace|--ignore-file|--max-filesize|--context-separator|--field-match-separator|--field-context-separator|--dfa-size-limit|--regex-size-limit|--engine|--hostname-bin|--hyperlink-format)$/,
  ag: /^(-A|--after|-B|--before|-C|--context|-m|--max-count|-G|--file-search-regex|--ignore|--ignore-dir|-p|--path-to-ignore|--depth|-W|--width)$/,
  ack: /^(-A|--after-context|-B|--before-context|-C|--context|-m|--max-count|--type|--ignore-dir|--ignore-file|--output|--match)$/,
};
const valuedOf = (prog: string) => SEARCH_VALUED[prog === "egrep" || prog === "fgrep" || prog === "zgrep" ? "grep" : prog]!;
const RECURSIVE = new Set(["rg", "ag", "ack"]);
// Programs that walk folders and list what they find: what they print is read next by a reader that takes names.
const WALKERS = new Set(["find", "fd", "fdfind"]);

// ---- wildcards ----

// A glob's one segment as a pattern. As the shell reads it: `*` and `?` do not match a leading dot, `[..]` is a
// class, `{a,b}` an alternative. A segment that is not valid is one nothing matches.
function segment(seg: string): RegExp | null {
  let re = "", depth = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") { const end = seg.indexOf("]", i + 2); if (end < 0) re += "\\["; else { re += `[${seg.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = end; } }
    else if (c === "{") { depth++; re += "(?:"; }
    else if (c === "}" && depth) { depth--; re += ")"; }
    else if (c === "," && depth) re += "|";
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  if (depth) return null;
  try { return new RegExp(`^${re}$`); } catch { return null; }
}
const segMatch = (pattern: string, text: string) => {
  if (text.startsWith(".") && !pattern.startsWith(".") && !pattern.startsWith("[.") && !pattern.startsWith("{.")) return false;
  return segment(pattern)?.test(text) ?? false;
};

// The home's stores a path with wildcards can still name: each of the store's own segments matched by the
// pattern's, and the pattern as long as the store or longer (what is inside a store is the store's).
export function wildStores(pattern: string, home: string): string[] {
  const segs = pattern.split("/").filter(Boolean);
  const out: string[] = [];
  for (const s of STORES) {
    const full = join(home, s).split("/").filter(Boolean);
    if (segs.length >= full.length && full.every((f, k) => segMatch(segs[k]!, f))) out.push(join(home, s));
  }
  return out;
}

// Names a last segment with wildcards can stand for that are credentials by their names (`*.env`, `.env*`, `*key.pem`):
// the segment with each wildcard run as nothing, a letter, or a dot and a letter.
export function wildNames(last: string): string[] {
  if (!/[*?[{]/.test(last)) return credentialName(last) ? [last] : [];
  const out: string[] = [];
  for (const fill of ["", "x", ".x"]) {
    const name = last.replace(/\{([^{},]*)(?:,[^{}]*)*\}/g, "$1").replace(/\[[^\]]*\]|[*?]+/g, fill);
    if (name && credentialName(name)) out.push(name);
  }
  return out;
}

// ---- the command ----

export type Reads = { what: string; by: string; paths: string[]; api?: string };
// What the gate can add from the disk: the names of the files under a folder that hold credentials by their names
// (a bounded look), and the files a pattern names. Without them, a command is judged by its words alone.
const EXPANDED_MAX = 500;
export type DiskLook = { named?: (folder: string) => string[]; expand?: (pattern: string, dir: string) => string[] };

// A literal excluded by an option of a searcher or a find: `--exclude=.env`, `-g '!.env'`, `--ignore .env`.
const globMatches = (glob: string, name: string) => { try { return new Bun.Glob(glob).match(name); } catch { return false; } };

// Each word the expansions of one word run (`$(echo ~/.aws/credentials)`): what it names to the commands inside.
function substituted(how: Made | undefined, depth = 0): string[] {
  const out: string[] = [];
  if (!how || depth > 3) return out;
  for (const sub of how.subs) for (const s of sub) {
    out.push(...s.words);
    const dyn = s.dyn ?? [];
    for (let k = 0; k < dyn.length; k++) out.push(...substituted(s.how?.[k], depth + 1));
  }
  return out;
}

export function shellCredentialReads(parts: Simple[], cwd: string, home: string, credential: (p: string) => Credential | null, pre: Laid = laid(parts, cwd, home), look: DiskLook = {}): Reads | null {
  let first: { what: string; by: string; api?: string } | null = null;
  const paths: string[] = [];
  // A word as a path: where it is, up to its first wildcard when it has one (the folder it lists).
  const at = (w: string, dir: string | null): string | null => {
    if (!w || w.length > 4096) return null;
    let t = w.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");
    t = t === "~" ? home : t.startsWith("~/") ? join(home, t.slice(2)) : t;
    if (/[$`]/.test(t) || t.startsWith("~")) return null;
    const wild = t.search(/[*?[{]/);
    if (wild >= 0) t = dirname(`${t.slice(0, wild)}x`);
    if (isAbsolute(t)) return resolve(t);
    return dir === null ? null : resolve(dir, t);
  };
  const note = (p: string, by: string) => {
    const c = credential(p);
    if (!c) return false;
    paths.push(c.path);
    first ??= { what: c.what, by, ...(c.api ? { api: c.api } : {}) };
    return true;
  };
  // Every path a word can name that is a credential: where it is, the stores and names its wildcards can still
  // reach, and (with the disk's help) the files it matches.
  const reads = (w: string, dir: string | null, by: string): boolean => {
    const p = at(w, dir);
    if (!p) return false;
    if (!/[*?[{]/.test(w)) return note(p, by);
    let abs = w.replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, "~");
    abs = abs === "~" ? home : abs.startsWith("~/") ? join(home, abs.slice(2)) : abs;
    if (!isAbsolute(abs) && dir !== null) abs = join(dir, abs);
    if (!isAbsolute(abs) || /[$`]/.test(abs)) return note(p, by);
    // The disk's own answer when it gives one that is whole (the files the pattern matches); else the folder it
    // lists, the stores and the names it can still stand for.
    const found = look.expand?.(abs, dir ?? dirname(abs));
    let hit = false;
    if (found && found.length < EXPANDED_MAX) { for (const f of found) if (note(f, by)) hit = true; return hit; }
    hit = note(p, by);
    for (const s of wildStores(abs, home)) hit = note(s, by) || hit;
    for (const n of wildNames(abs.slice(abs.lastIndexOf("/") + 1))) hit = note(join(dirname(abs), n), by) || hit;
    for (const f of found ?? []) if (note(f, by)) hit = true;
    return hit;
  };
  // A folder a program walks: a credential, or one that holds the home's stores, or (the disk's look) files named like
  // credentials that the program would read. `except`: whether the command leaves a name out.
  const walks = (folder: string, by: string, except: (name: string) => boolean = () => false, hidden = true): boolean => {
    if (note(folder, by)) return true;
    const stores = storesUnder(folder, home);
    if (stores.length) {
      first ??= { what: `${folder === home ? "the home folder" : contains(home, folder) ? `~/${folder.slice(home.length + 1)}` : folder}, which holds the owner's credential stores (${storesSaid(stores, home)})`, by };
      return true;
    }
    if (look.named) {
      const names = look.named(folder).filter((n) => !except(n) && (hidden || !n.startsWith(".")));
      if (names.length) {
        first ??= { what: `${folder === home ? "the home folder" : contains(home, folder) ? `~/${folder.slice(home.length + 1)}` : folder}, which holds files that hold credentials (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}). Leave them out of the search (grep --exclude=${names[0]}, rg -g '!${names[0]}') or name the files you need`, by };
        return true;
      }
    }
    return false;
  };
  // The folders and patterns a `find` walks: its start words, and the names it is asked for.
  const findWalks = (words: string[], dir: string | null, by: string): boolean => {
    let hit = false;
    let k = 1;
    while (k < words.length && /^-[HLPD]/.test(words[k]!)) k++;
    const starts: string[] = [];
    for (; k < words.length && !/^[-(!]/.test(words[k]!); k++) starts.push(words[k]!);
    if (!starts.length && dir !== null) starts.push(".");
    const patterns: string[] = [];
    for (let j = 1; j < words.length - 1; j++) if (/^-(?:name|iname|path|ipath|wholename|regex)$/.test(words[j]!)) patterns.push(words[j + 1]!);
    const named = patterns.some((pat) => wildNames(pat.slice(pat.lastIndexOf("/") + 1)).length > 0);
    // (A walk that is asked for names that are none of a credential's still lists the home's stores when it starts
    // above them; it finds files named like credentials in a folder only when it is asked for their names or for none.)
    const filtered = patterns.length > 0 && !named;
    for (const s of starts) {
      if (reads(s, dir, by)) { hit = true; continue; }
      const p = at(s, dir);
      if (p && (storesUnder(p, home).length || !filtered) && walks(p, by)) hit = true;
    }
    if (named && !hit && !look.named) {
      first ??= { what: `a search for files named like credentials (${patterns.filter((pat) => wildNames(pat.slice(pat.lastIndexOf("/") + 1)).length).join(", ")})`, by };
      hit = true;
    }
    return hit;
  };

  // The stages of the pipeline before a part: what they name is what a reader that takes names reads.
  const before = (i: number): number[] => {
    const out: number[] = [];
    for (let j = i - 1; j >= 0 && (parts[j]!.sep === "|" || parts[j]!.sep === "|&") && out.length < 8; j--) out.push(j);
    return out;
  };

  // The folders the line's own `cd`s name: a command after one may run in it whatever stands between them (`;` as
  // well as `&&`, in a group or a subshell too), so it is read there as well.
  const entered: string[] = [];
  for (let i = 0; i < parts.length && paths.length < 64; i++) {
    const part = parts[i]!;
    if (part.heredoc) continue;
    const here = pre.dirs[i] ?? null;
    for (const dir of [here, ...entered.filter((e) => e !== here)]) {
    for (const t of part.inputs ?? []) reads(t, dir, "the command reads");
    const run = pre.runs[i]!;
    let prog = baseName(run.words[0]);
    let args = run.words.slice(1);
    let argAt = run.at + 1;
    let folder = dir;
    // git reads two paths with no repository (`git diff --no-index`) and searches a folder as grep does (`git grep --no-index`).
    let gitSearch = false;
    if (prog === "git") {
      let k = 0;
      for (; k < args.length && args[k]!.startsWith("-"); k++) {
        if (args[k] === "-C" && args[k + 1] !== undefined) { const to = args[++k]!; folder = at(to, folder); }
        else if (args[k] === "-c" || args[k] === "--git-dir" || args[k] === "--work-tree" || args[k] === "--namespace") k++;
      }
      const sub = args[k];
      if ((sub === "diff" || sub === "grep") && args.includes("--no-index")) { prog = sub === "diff" ? "diff" : "grep"; gitSearch = sub === "grep"; args = args.slice(k + 1).filter((a) => a !== "--no-index"); argAt += k + 1; }
      else continue;
    }
    const xargs = run.fed === "xargs", exec = run.fed === "find";
    const copier = COPIERS.has(prog), reader = CONTENT_READERS.has(prog);
    // A helper feeds the program its operands: the stages before it name them (xargs), or the walk of a find does.
    if (xargs && (reader || copier)) {
      for (const j of before(i)) {
        const stage = parts[j]!;
        const sd = pre.dirs[j] ?? null;
        const words = pre.runs[j]!.words;
        if (WALKERS.has(baseName(words[0]))) findWalks(words, sd, "the command reads through xargs");
        else for (const w of words.slice(1)) reads(w, sd, "the command reads through xargs");
        for (const t of stage.inputs ?? []) reads(t, sd, "the command reads through xargs");
      }
    }
    if (exec && (reader || copier) && run.find) findWalks(run.find, dir, "the command reads through find");
    if (!reader && !copier) continue;
    // (`sed -i` edits a file in place and prints none of it.)
    if (prog === "sed" && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) continue;
    const searcher = SEARCHERS.has(prog);
    const recursive = gitSearch || RECURSIVE.has(prog) || (searcher && args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive" || a === "--dereference-recursive" || a === "--directories=recurse"));
    let patternGiven = false, ended = false, target = false, hiddenToo = prog !== "rg" && prog !== "ag" && prog !== "ack";
    const excludes: string[] = [];
    const operands: { w: string; idx: number }[] = [];
    const valued = copier ? COPY_VALUED[prog] : undefined;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!ended && a === "--") { ended = true; continue; }
      if (!ended && a.startsWith("-") && a !== "-") {
        if (copier) {
          if (TARGETED.test(a) && prog !== "rsync" && prog !== "scp") target = true;
          if (valued?.test(a)) k++;
          continue;
        }
        if (searcher) {
          if (/^(?:--hidden|-[a-zA-Z]*u+[a-zA-Z]*|--unrestricted|--no-ignore)$/.test(a) && prog === "rg") hiddenToo = true;
          if (/^--exclude(?:-dir)?=/.test(a)) excludes.push(a.slice(a.indexOf("=") + 1));
          else if (/^--(?:glob|iglob)=!/.test(a)) excludes.push(a.slice(a.indexOf("!") + 1));
          else if (/^-g!/.test(a)) excludes.push(a.slice(3));
        }
        if (searcher && valuedOf(prog).test(a)) {
          const v = args[++k];
          if (a === "-e" || a === "--regexp" || (prog === "ack" && a === "--match")) patternGiven = true;
          if (a === "-f" || a === "--file") { patternGiven = true; if (v !== undefined) reads(v, folder, "the command reads"); }
          if (v !== undefined && (a === "--exclude" || a === "--exclude-dir" || (prog === "ag" && a === "--ignore") || (prog === "rg" && /^(?:-g|--glob|--iglob)$/.test(a) && v.startsWith("!")))) excludes.push(v.replace(/^!/, ""));
        } else if (searcher && /^(--regexp|--file)=/.test(a)) {
          patternGiven = true;
          if (a.startsWith("--file=")) reads(a.slice(7), folder, "the command reads");
        } else if (searcher && prog !== "ag" && prog !== "ack" && /^-[a-zA-Z]*[ef]$/.test(a) && a.length > 2) {
          // (`-rf FILE`, `-ie PATTERN`: the last letter takes the next word.)
          const v = args[++k];
          patternGiven = true;
          if (a.endsWith("f") && v !== undefined) reads(v, folder, "the command reads");
        }
        continue;
      }
      operands.push({ w: a, idx: argAt + k });
    }
    if (searcher && !patternGiven) operands.shift();
    // A copy's sources: every operand but the last, or every operand when the target comes by an option.
    // (`host:path` is a file of another machine, not of this one.)
    const sources = (copier && !target ? operands.slice(0, -1) : operands).filter((o) => !(copier && /^(?:[^/\s:@]+@)?[^/\s:]+:/.test(o.w) && !o.w.startsWith("./")));
    // A searcher that walks folders and names none walks the folder it runs in.
    if (recursive && !xargs && !sources.length && folder !== null) sources.push({ w: ".", idx: -1 });
    const leaves = (n: string) => excludes.some((g) => globMatches(g, n));
    for (const { w: o, idx } of sources) {
      // A word an expansion makes: the words of the commands inside it are what it names.
      const how = idx >= 0 ? part.how?.[part.dyn?.indexOf(idx) ?? -1] : undefined;
      let done = false;
      for (const inner of substituted(how)) done = reads(inner, folder, "the command reads") || done;
      if (done || reads(o, folder, "the command reads")) continue;
      const p = at(o, folder);
      if (!p) continue;
      if (copier) { if (storesUnder(p, home).length) walks(p, "the command copies"); continue; }
      if (recursive) walks(p, "the command searches", leaves, hiddenToo);
    }
  }
    const cd = pre.runs[i]!.words;
    if ((cd[0] === "cd" || cd[0] === "pushd") && entered.length < 4) {
      const arg = cd.slice(1).find((a) => !a.startsWith("-"));
      const to = arg === undefined ? home : at(arg, here);
      if (to && !entered.includes(to)) entered.push(to);
    }
  }
  return first ? { ...(first as { what: string; by: string; api?: string }), paths } : null;
}

// ---- what the disk adds ----

// The folders a look for names does not enter: a repository's own store and the installed packages (a search of
// a project reaches them, and holds thousands of files that are nobody's credentials).
const NOT_ENTERED = new Set([".git", "node_modules"]);
const LOOK_ENTRIES = 4000, LOOK_NAMES = 20;

// The names of the files under a folder that hold credentials by their names, as far as a look of a few thousand
// entries goes (a folder is read, then those in it, level by level).
export function namedUnder(folder: string): string[] {
  const names = new Set<string>();
  let seen = 0;
  for (let level = [folder]; level.length && seen < LOOK_ENTRIES && names.size < LOOK_NAMES; ) {
    const next: string[] = [];
    for (const d of level) {
      let entries: Dirent[] = [];
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (seen++ >= LOOK_ENTRIES) break;
        if (e.isDirectory()) { if (!NOT_ENTERED.has(e.name)) next.push(join(d, e.name)); }
        else if (e.isFile() && credentialName(e.name)) names.add(e.name);
      }
    }
    level = next;
  }
  return [...names];
}

// The files a pattern with wildcards matches, at most a few hundred. (A pattern that is not a path the disk has: none.)
export function expanded(pattern: string): string[] {
  const wild = pattern.search(/[*?[{]/);
  if (wild < 0 || !isAbsolute(pattern)) return [];
  const base = dirname(`${pattern.slice(0, wild)}x`);
  const rel = pattern.slice(base === "/" ? 1 : base.length + 1);
  const out: string[] = [];
  try {
    for (const f of new Bun.Glob(rel).scanSync({ cwd: base, dot: /(?:^|\/)\./.test(rel), onlyFiles: false })) { out.push(join(base, f)); if (out.length >= EXPANDED_MAX) break; }
  } catch {}
  return out;
}

export const diskLook = (): DiskLook => ({ named: namedUnder, expand: expanded });
