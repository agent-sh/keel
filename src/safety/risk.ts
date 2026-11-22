// Why a command is high risk: what it can destroy or expose that nothing
// brings back. Five classes, each with a word of its own, which the ask
// carries as its rule in a few words (RULE_WORDS):
//
//   destroys  deletes, empties or overwrites what nothing brings back:
//             outside the session's folder; inside it, files git cannot
//             bring back (untracked ones it does not ignore, modified ones),
//             a pattern over them, the repository's own data and history
//   remote    changes another machine or a service where no sandbox or
//             checkpoint holds it: a delete, a deploy or a signal run over
//             ssh, a delete or destroy verb of a cluster, cloud or database
//             client, a publish (an ordinary push is not one)
//   exposes   sends a file that holds credentials to another machine
//   hidden    runs code that is not in the command: decoded or fetched text
//             given to a shell, a program whose name the line builds, an
//             interpreter one-liner that evaluates what it fetches, a
//             library or a folder anyone can write put in front of the
//             programs, an install from an address
//   machine   reaches past the session on this machine: root, a signal to
//             every process, the user's scheduled jobs, a git setting that
//             names a program git runs
//
// A command is judged by what can be read in it. A wrapper (env, nohup,
// timeout, xargs, find -exec, a nested `sh -c`, the command ssh runs) is
// read through, a variable the line itself gives a value is read as that
// value, and a target or a script that cannot be read is high for that
// reason alone: the card says to write it out. A part that only reads is
// never classed.
//
// The line is read once: each part's command, folder, pipeline stage and the
// text handed to it are worked out in one pass each, so a line of a hundred
// thousand parts costs a hundred thousand steps.
//
// Research: ~/.cache/keel-work/bun/research/risk-classes.md (Claude Code's
// auto mode rules and Codex's reviewer policy draw the same lines).
import { resolve } from "node:path";
import { QUESTIONS } from "./looked.ts";
export { RULE_WORDS } from "./risk-words.ts";
import { protectedBranch } from "./autonomy.ts";
import { ENVIRONMENT, LOCAL_HOST, REACHES, REMOTE_SPEC, deployNamed, elsewhere, envIn, exposes, remote, secretFile, sender, sqlClient, type Part } from "./risk-reach.ts";
import { ASSIGN, DEPTH, GLOB, INTERPRETERS, LEAVES, LOST, SCRIPT_MAX, SHELLS, WORDS_MAX, confined, firmOf, cluster, dirsOf, untrailed, literal, madeName, name, redirected, rootOf, target, under, unwrap, valuesOf, written, type Risk, type RiskRule, type Run, type Values, type Where } from "./risk-words.ts";
import { highRisk, isReadOnly, lineRisk, splitCommand, type Made, type Simple } from "./shell.ts";

export { secretFile } from "./risk-reach.ts";
export type { Risk, RiskRule, Where } from "./risk-words.ts";

// ---- class: destroys ----

// What a deleting program's arguments name, past its options and their values.
const TAKES: Record<string, RegExp> = { truncate: /^(-s|--size|-r|--reference|-o)$/, shred: /^(-n|--iterations|-s|--size)$/ };
const DELETES = new Set(["rm", "unlink", "shred", "truncate", "rimraf", "del", "del-cli", "trash"]);
const LOGGISH = /\.(log|out|tmp|pid|lock)$/;
// What is said of a path git was asked about and did not answer for: in time, or at all, where the line names
// more paths than are looked up for one command.
const late = (w: Where) => (w.looked?.over?.() ? `, one of more paths than are looked up for one command (${QUESTIONS})` : ", and git did not say in time what it holds");

// What the line itself moved earlier (`mv src src.bak && rm -rf src.bak`): a path under the new name is asked of
// git under the old one, where its files were.
type Moved = Map<string, string>;
const origin = (path: string, moved: Moved) => {
  for (const [to, from] of moved) if (path === to || path.startsWith(`${to}/`)) return from + path.slice(to.length);
  return path;
};

type Ctx = { w: Where; vals: Values; moved: Moved };

function deletes(x: Part, c: Ctx, prev: Run | null): Risk[] {
  const { p, args, dir, s } = x;
  const { w } = c;
  const vals = s.flow ? LOST : c.vals;
  const out: Risk[] = [];
  const add = (why: string) => { out.push({ rule: "destroys", why }); };
  const verb = p === "truncate" ? "empties" : p === "shred" ? "overwrites" : "deletes";
  if (DELETES.has(p)) {
    // An option the line builds (OPTS=-rf; rm $OPTS src) is read as the widest one: recursive and forced.
    const built = (a: string, k: number) => { const how = x.made(k); const said = how ? written(a, how, dir, w, vals, x.i) : null; return typeof said === "string" && said.startsWith("-"); };
    const recursive = (p === "rm" && args.some((a, k) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive" || built(a, k))) || p === "rimraf" || p === "del" || p === "del-cli" || p === "trash";
    // Its paths come from another command: read where that one looks, when it is find.
    if (x.run.fed) {
      const from = x.run.fed === "find" ? x.run.find! : prev && name(prev.words[0]) === "find" ? prev.words : null;
      if (from) return swept(from, verb, dir, c, x.i, s.flow);
      return [{ rule: "destroys", why: `${verb} the paths another command prints, which are not in the command` }];
    }
    if (args.length > WORDS_MAX) return [{ rule: "destroys", why: `${verb} ${args.length} paths, more than the rules read for one command (${WORDS_MAX})` }];
    let rest = false;
    // (A path named twice is judged once.)
    const seen = args.length > 8 ? new Set<string>() : null;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (!rest && a === "--") { rest = true; continue; }
      if (!rest && a.startsWith("-")) { if (TAKES[p]?.test(a)) k++; continue; }
      if (seen) { if (seen.has(a)) continue; seen.add(a); }
      if (!rest && built(a, k)) continue;
      const t = target(a, x.made(k), dir, w, vals, x.i);
      if ("made" in t) continue;
      if ("unread" in t) { add(`${verb} a path the command does not spell out (${t.unread}): write the path into the command`); continue; }
      if (t.place === "scratch" || confined(t, w)) continue;
      if (t.place === "outside" || t.place === "cache") { add(`${verb} ${t.shown}${w.away ? "" : ", outside the session's folder"}`); continue; }
      if (t.place === "folder") { add(`${verb} the session's folder, or what holds it`); continue; }
      if (t.place === "repo") { add(`${verb} ${t.shown}, the repository's own data`); continue; }
      // Inside the folder: one named file is an edit. A folder or a pattern is judged by what git cannot bring back there.
      if (p === "truncate" || p === "shred") { if (!LOGGISH.test(t.path)) add(`${verb} ${t.shown} in place`); continue; }
      if (!recursive && !t.glob) continue;
      const path = origin(t.path, c.moved);
      const kept = w.looked?.kept(t.glob ? [`:(glob)${path}`, ...(recursive ? [`:(glob)${path}/**`] : [])] : [literal(path)]);
      const said = `deletes ${t.shown}${recursive ? " recursively" : ""}`;
      if (kept === "late") add(said + late(w));
      else if (kept === undefined || kept === null) {
        // Not known: a made name, one file by its extension, and a pattern that is not everything pass.
        const one = !t.glob && /[^/]\.[A-Za-z0-9]+$/.test(t.path);
        if (madeName(t.shown) || one || (!recursive && !/(^|\/)\*$/.test(t.path))) continue;
        // (Asked only where the names do not settle it: a path that is not there holds nothing to lose.)
        if (kept === null && !t.glob && w.looked!.exists(path) === "none") continue;
        add(`${said}, which is not known to be build output`);
      // (A name written with a slash after it is the folder it leads to, when it is a link: not the one entry git lists.)
      } else if (recursive ? kept.n >= 1 && !(kept.self && !a.endsWith("/")) : kept.n >= 2) add(`${said}, which holds files git cannot bring back (new, or changed since they were committed)`);
    }
    return out;
  }
  if (p === "find" && args.includes("-delete")) return swept(x.run.words, "deletes", dir, c, x.i, s.flow);
  // An archiver told to delete what it packs: its sources are gone, outside the folder as inside.
  if ((p === "tar" && args.includes("--remove-files")) || (p === "zip" && args.some((a) => /^-[a-zA-Z]*m/.test(a) || a === "--move"))) {
    for (const a of x.plain.slice(1)) {
      const t = target(a, x.made(args.indexOf(a)), dir, w, vals, x.i);
      if ("unread" in t) add(`deletes a path the command does not spell out (${t.unread}) once it is packed`);
      else if ("place" in t && t.place !== "scratch" && t.place !== "inside" && !(confined(t, w) && !args.some((o) => /^-[a-zA-Z]*h/.test(o) || o === "--dereference"))) add(`deletes ${t.shown} once it is packed, outside the session's folder`);
    }
    return out;
  }
  if (p === "chmod" || p === "chown" || p === "chgrp") {
    if (!args.some((a) => /^-[a-zA-Z]*R/.test(a) || a === "--recursive")) return out;
    const what = p === "chmod" ? "modes" : "ownership";
    args.forEach((a, k) => {
      if (a.startsWith("-") || a === x.plain[0]) return;
      const t = target(a, x.made(k), dir, w, vals, x.i);
      if ("unread" in t) add(`changes ${what} of a whole tree the command does not spell out (${t.unread})`);
      else if ("place" in t && !(confined(t, w) && !args.some((o) => /^-[a-zA-Z]*[HL]/.test(o))) && (t.place === "outside" || t.place === "cache" || t.place === "folder" || t.path === resolve(w.workspace))) add(`changes ${what} of everything in ${t.place === "outside" || t.place === "cache" ? t.shown : "the session's folder"}`);
    });
    return out;
  }
  if (p === "rsync" && args.some((a) => /^--del(ete)?/.test(a) || a === "--remove-source-files")) {
    const dest = x.plain.at(-1);
    if (!dest) return out;
    if (REMOTE_SPEC.test(dest)) return [{ rule: "remote", why: `deletes on another machine (${dest.slice(0, dest.indexOf(":"))}) what the source does not hold` }];
    const t = target(dest, x.made(args.lastIndexOf(dest)), dir, w, vals, x.i);
    if ("unread" in t) add(`deletes in a folder the command does not spell out (${t.unread}) what the source does not hold`);
    else if ("place" in t && t.place !== "scratch" && t.place !== "inside") { if (!confined(t, w) || args.some((o) => /^-[a-zA-Z]*K/.test(o) || o === "--keep-dirlinks")) add(`deletes in ${t.shown}, outside the session's folder, what the source does not hold`); }
    else if ("place" in t && t.place === "inside") {
      const kept = w.looked?.kept([literal(t.path)]);
      if (kept === "late" || (kept && kept.n >= 1 && !kept.self) || ((kept === undefined || kept === null) && !madeName(t.shown))) add(`deletes in ${t.shown} what the source does not hold${kept === "late" ? late(w) : ""}`);
    }
  }
  return out;
}

// A find that deletes what it matches (-delete, -exec rm, | xargs rm): judged
// by where it looks and, when one -name is all it tests, by what git says of
// that name there. One that only takes empty folders loses nothing.
function swept(find: string[], verb: string, dir: string | null, c: Ctx, at: number, flow?: true): Risk[] {
  const { w } = c;
  let k = 1;
  while (/^-[HLP]$/.test(find[k] ?? "") || /^-[DO]/.test(find[k] ?? "")) k += find[k] === "-D" || find[k] === "-O" ? 2 : 1;
  const roots: string[] = [];
  while (k < find.length && !find[k]!.startsWith("-") && find[k] !== "(" && find[k] !== "!") roots.push(find[k++]!);
  const tests = find.slice(k);
  const mixed = tests.some((a) => /^(-o|-or|-not|!|,|-path|-ipath|-wholename|-regex|-iregex|-newer|-samefile)$/.test(a));
  if (!mixed && tests.includes("-empty") && tests.some((a, n) => a === "-type" && tests[n + 1] === "d")) return [];
  const names = tests.flatMap((a, n) => (a === "-name" || a === "-iname") && tests[n + 1] !== undefined ? [tests[n + 1]!] : []);
  const plain = names.length === 1 && !mixed;
  const out: Risk[] = [];
  for (const r of roots.length ? roots : ["."]) {
    const t = target(r, undefined, dir, w, flow ? LOST : c.vals, at);
    if ("made" in t) continue;
    if ("unread" in t || /[$`]/.test(r)) { out.push({ rule: "destroys", why: `${verb} what find matches under a folder the command does not spell out (${r})` }); continue; }
    // (One that follows links can leave the folder it was given.)
    if (t.place === "scratch" || (confined(t, w) && !find.some((a) => a === "-L" || a === "-follow"))) continue;
    if (t.place === "outside" || t.place === "cache" || t.place === "repo" || (t.place === "folder" && t.path !== resolve(w.workspace))) { out.push({ rule: "destroys", why: `${verb} what find matches under ${t.shown}, outside the session's work` }); continue; }
    const kept = w.looked?.kept(plain ? [`:(glob)${t.path}/**/${names[0]}`, `:(glob)${t.path}/**/${names[0]}/**`] : [literal(t.path)]);
    const said = `${verb} what find matches under ${t.shown}${plain ? ` (${names[0]})` : ""}`;
    if (kept === "late") out.push({ rule: "destroys", why: said + late(w) });
    else if (kept === undefined || kept === null) { if (!(plain ? madeName(names[0]!) : madeName(t.shown))) out.push({ rule: "destroys", why: `${said}, which is not known to be build output` }); }
    else if (kept.n >= 1) out.push({ rule: "destroys", why: `${said}, files git cannot bring back among them` });
  }
  return out;
}

// A move of, or an overwrite onto, what is outside the session's folder, in a session nothing confines to it
// (confined, the write fails by itself). Temporary and cache folders hold nothing that is missed.
const OVERWRITES = new Set(["mv", "cp", "install", "ln", "tee", "dd", "sed", "perl", "sort", "sponge"]);
function overwrites(x: Part, c: Ctx): Risk[] {
  const { p, args, dir, s } = x;
  const { w } = c;
  if (w.sandboxed || w.away || (!s.redirects && !OVERWRITES.has(p))) return [];
  const vals = s.flow ? LOST : c.vals;
  const out: Risk[] = [];
  const gone = (t: ReturnType<typeof target>) => "place" in t && (t.place === "outside" || t.place === "folder");
  // Whether the path is there to be lost: not known without the disk, and then nothing is said of it.
  const there = (path: string, kind: "file" | "any") => { const e = w.looked?.exists(path); return e === "late" || e === "file" || (kind === "any" && e === "dir"); };
  // `from`: what is copied or moved there, for a target that is a folder: the file of the same name in it.
  const onto = (a: string, how: Made | undefined, what: string, from: string[] = []) => {
    const t = target(a, how, dir, w, vals, x.i);
    if (!gone(t) || !("path" in t) || t.path.startsWith("/dev/")) return;
    if (t.glob || there(t.path, "file")) out.push({ rule: "destroys", why: `${what} ${t.shown}, outside the session's folder` });
    else if (from.length && from.length <= 8 && w.looked?.exists(t.path) === "dir") {
      const whole = args.some((o) => /^-[a-zA-Z]*[rRa]/.test(o) || o === "--recursive" || o === "--archive");
      const same = from.map((f) => `${t.path}/${name(untrailed(f))}`).find((p) => there(p, whole ? "any" : "file"));
      if (same) out.push({ rule: "destroys", why: `${what} ${same.replace(w.home, "~")}, outside the session's folder` });
    }
  };
  // A variable the line gave one value, in a redirect's target (F=~/other/x; echo y > $F).
  const named1 = (to: string) => to.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (all, v: string) => { const k = vals.get(v); return k && k.text !== undefined && k.at < x.i ? k.text : all; });
  // (A plain name under the folder the part runs in, inside the session's own, is inside it: most redirects.)
  const plain = dir !== null && under(rootOf(w), dir);
  if (s.redirects) for (const r0 of redirected(s)) { const r = r0.to.includes("$") && vals !== LOST ? { ...r0, to: named1(r0.to) } : r0; if (r.empties && !/[$`]/.test(r.to) && !(plain && !/^[\/~]|(^|\/)\.\.(\/|$)/.test(r.to) && !w.land)) onto(r.to, undefined, "overwrites"); }
  if (!OVERWRITES.has(p)) return out;
  const named = args.map((a, k) => ({ a, k })).filter(({ a }) => !a.startsWith("-"));
  if (p === "mv" && named.length >= 2) {
    for (const { a, k } of named.slice(0, -1)) {
      const t = target(a, x.made(k), dir, w, vals, x.i);
      if (gone(t) && "path" in t && (t.glob || w.looked === undefined || there(t.path, "any"))) out.push({ rule: "destroys", why: `moves ${t.shown} away, from outside the session's folder` });
    }
    onto(named.at(-1)!.a, x.made(named.at(-1)!.k), "moves a file onto", named.slice(0, -1).map((f) => f.a));
  } else if ((p === "cp" || p === "install") && named.length >= 2) onto(named.at(-1)!.a, x.made(named.at(-1)!.k), "copies a file onto", named.slice(0, -1).map((f) => f.a));
  else if (p === "sponge") { for (const { a, k } of named) onto(a, x.made(k), "overwrites"); }
  else if (p === "sort") args.forEach((a, k) => { if (/^(-o|--output)$/.test(args[k - 1] ?? "")) onto(a, x.made(k), "overwrites"); else if (a.startsWith("--output=")) onto(a.slice(9), undefined, "overwrites"); });
  else if (p === "ln" && named.length >= 2 && args.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) {
    // A forced link takes the place of what stood there, a folder too.
    const t = target(named.at(-1)!.a, x.made(named.at(-1)!.k), dir, w, vals, x.i);
    if (gone(t) && "path" in t && (w.looked === undefined || there(t.path, "any"))) out.push({ rule: "destroys", why: `puts a link in the place of ${t.shown}, outside the session's folder` });
  }
  else if (p === "tee" && !args.some((a) => /^(-a|--append)$/.test(a))) for (const { a, k } of named) onto(a, x.made(k), "overwrites");
  else if (p === "dd") args.forEach((a, k) => {
    // (The whole word is read first: of=$HOME/x names a file under the home.)
    const said = a.startsWith("of=") ? written(a, x.made(k), dir, w, vals, x.i) : null;
    if (typeof said === "string") onto(said.slice(3), undefined, "overwrites");
  });
  else if ((p === "sed" && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))) || (p === "perl" && args.some((a) => /^-[a-zA-Z0-9]*i/.test(a)))) {
    // The files it changes in place stand after its script.
    for (const { a, k } of named.slice(args.some((o) => /^(-e|-f|--expression|--file)$/.test(o)) ? 0 : 1)) {
      const t = target(a, x.made(k), dir, w, vals, x.i);
      if (gone(t) && "path" in t) out.push({ rule: "destroys", why: `changes ${t.shown} in place, outside the session's folder` });
    }
  }
  return out;
}

// git's own ways to lose work, by what they mean and not by one spelling.
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
// An editor or a pager that is no program worth a card: the no-ops and the plain pagers.
const TAME = /^(true|:|cat|less|more|)$/;
function codeKey(key: string, value?: string): boolean {
  const k = key.toLowerCase();
  const first = k.indexOf("."), last = k.lastIndexOf(".");
  if (first < 0) return false;
  const section = k.slice(0, first);
  if (value !== undefined && TAME.test(value) && (section === "pager" || /^(core\.(editor|pager)|sequence\.editor)$/.test(k))) return false;
  return section === "alias" || section === "pager" || CODE_KEYS.has(`${section}.${k.slice(last + 1)}`);
}
const DISCARDS = "discards uncommitted work";
// One file by its name: a path with an extension, or one of the files a project keeps without one.
const oneFile = (paths: string[]) => paths.length === 1 && !GLOB.test(paths[0]!) && !paths[0]!.endsWith("/") && (/[^/.]\.[A-Za-z0-9]+$/.test(paths[0]!) || /(^|\/)(Makefile|Dockerfile|LICENSE|README|Gemfile|Rakefile|Procfile|Justfile|CODEOWNERS)$/.test(paths[0]!));
const wide = (a: string) => a === "." || a === "./" || a === ":/" || a.endsWith("/") || GLOB.test(a);

function gitRisks(words: string[]): Risk[] {
  const g = gitParts(words);
  if (!g) return [];
  const out: Risk[] = [];
  // (git -C DIR reset --hard is the reset it is without the folder: the older rules read the subcommand first.)
  if (words[1] !== g.sub) { const old = highRisk({ words: ["git", g.sub, ...g.args], text: "", redirects: false }); if (old) out.push({ rule: OLD(old), why: old, said: true }); }
  if (g.sub === "push") {
    const to = g.args.find((a, k) => !a.startsWith("-") && !/^(-o|--push-option|--receive-pack|--exec)$/.test(g.args[k - 1] ?? "")) ?? g.args.find((a) => a.startsWith("--repo="))?.slice(7);
    if (to && (ADDRESS.test(to) || /^[\w.-]+@[\w.-]+:/.test(to))) out.push({ rule: "exposes", why: `pushes the repository to an address the command names (${to.slice(0, 100)})` });
  }
  for (const kv of g.set) {
    const eq = kv.indexOf("=");
    const key = eq < 0 ? kv : kv.slice(0, eq);
    if (codeKey(key, eq < 0 ? "" : kv.slice(eq + 1))) out.push({ rule: "hidden", why: `runs git with ${key} set for this one call: git runs the program it names` });
  }
  const { sub, args } = g;
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const dd = args.indexOf("--");
  if (sub === "filter-branch" || sub === "filter-repo") out.push({ rule: "destroys", why: "rewrites the repository's history" });
  else if (sub === "stash" && (args[0] === "drop" || args[0] === "clear")) out.push({ rule: "destroys", why: "deletes stashed work" });
  else if (sub === "reflog" && (args[0] === "expire" || args[0] === "delete")) out.push({ rule: "destroys", why: "removes what git keeps to bring lost commits back" });
  else if (sub === "worktree" && args[0] === "remove" && has(/^(-f|--force)$/)) out.push({ rule: "destroys", why: "removes a worktree with whatever is uncommitted in it" });
  else if (sub === "update-ref" && has(/^(-d|--delete)$/)) {
    // A branch's ref is the branch, and deleting it is `git branch -D`: high risk for one a release or deploy line
    // is named by. Any other ref (HEAD, the stash, a tag, a remote's), and one the command does not spell out, is.
    const ref = args.find((a) => !a.startsWith("-"));
    const branch = ref?.startsWith("refs/heads/") ? ref.slice(11) : null;
    if (!ref || branch === null || /[$`*?]/.test(ref) || protectedBranch(branch, null)) out.push({ rule: "destroys", why: "deletes a ref, and with it the way to the commits only it reaches" });
  }
  else if (sub === "submodule" && args[0] === "deinit" && has(/^(-f|--force)$/)) out.push({ rule: "destroys", why: "removes the submodules' files with whatever is uncommitted in them" });
  else if (sub === "remote" && args[0] === "set-url") out.push({ rule: "remote", why: "points a remote at another address: what is pushed and fetched next goes there" });
  else if (sub === "checkout" || sub === "switch") {
    // A forced switch, or a checkout of paths that are not one file, puts the committed files over the ones there.
    const named = args.filter((a, k) => (dd < 0 || k < dd) && !a.startsWith("-") && !/^(-b|-B|-c|-C|--orphan|-t|--track|--conflict|--pathspec-from-file)$/.test(args[k - 1] ?? ""));
    const paths = dd >= 0 ? args.slice(dd + 1) : sub === "switch" ? [] : named.length >= 2 ? named.slice(1) : named.filter(wide);
    if (has(/^(-f|--force|--discard-changes)$/) || (paths.length && !oneFile(paths))) out.push({ rule: "destroys", why: DISCARDS });
  } else if (sub === "restore") {
    // --staged alone only takes a change back out of the index.
    const paths = args.filter((a, k) => k !== dd && !a.startsWith("-") && !/^(-s|--source|--pathspec-from-file)$/.test(args[k - 1] ?? ""));
    if ((!has(/^(-S|--staged)$/) || has(/^(-W|--worktree)$/)) && paths.length && !oneFile(paths)) out.push({ rule: "destroys", why: DISCARDS });
  } else if (sub === "clean" && args.some((a) => a === "--force" || cluster(a, "f")) && !args.some((a) => a === "--dry-run" || cluster(a, "n")) && !(args.some((a) => cluster(a, "X")) && !args.some((a) => cluster(a, "x")))) out.push({ rule: "destroys", why: "deletes untracked files" });
  else if (sub === "rm" && has(/^-[a-zA-Z]*r/) && !has(/^--cached$/)) out.push({ rule: "destroys", why: "deletes tracked files recursively" });
  else if (sub === "branch" && (has(/^-[a-zA-Z]*D/) || (has(/^(-d|--delete)$/) && has(/^(-f|--force)$/)))) {
    // A branch a release or deploy line is named by, or one the command does not spell out.
    const hit = args.filter((a) => !a.startsWith("-")).find((b) => /[$`*?]/.test(b) || protectedBranch(b, null));
    if (hit) out.push({ rule: "destroys", why: `deletes the branch ${hit} whether or not it is merged` });
  } else if (sub === "config") {
    // A read names no value; a write names the key and its value.
    if (has(/^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--unset|--unset-all|--remove-section|--rename-section|-e|--edit)$/) || /^(get|list|unset|remove-section|rename-section|edit)$/.test(args[0] ?? "")) return out;
    const named = args.filter((a, k) => !a.startsWith("-") && !/^(-f|--file|--blob|--type|--default|--comment|--value)$/.test(args[k - 1] ?? "") && !(k === 0 && a === "set"));
    if (named.length >= 2 && codeKey(named[0]!, named[1])) {
      const all = has(/^--(global|system)$/);
      out.push({ rule: "machine", why: `sets ${named[0]}${all ? " for every repository of the user" : ""}: git runs the program it names, later and outside any sandbox` });
    }
  }
  return out;
}
// The command a git subcommand is given to run: rebase --exec, bisect run, submodule foreach.
function gitRuns(words: string[]): string | null {
  const g = gitParts(words);
  if (!g) return null;
  if (g.sub === "rebase") { const k = g.args.findIndex((a) => a === "--exec" || a === "-x"); return k >= 0 ? g.args[k + 1] ?? null : g.args.find((a) => a.startsWith("--exec="))?.slice(7) ?? null; }
  if (g.sub === "bisect" && g.args[0] === "run") return g.args.slice(1).join(" ") || null;
  if (g.sub === "submodule" && g.args.includes("foreach")) return g.args.slice(g.args.indexOf("foreach") + 1).filter((a) => !a.startsWith("--")).join(" ") || null;
  return null;
}

// ---- class: hidden ----

const LOADS = new Set(["LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "PROMPT_COMMAND", "PERL5OPT", "RUBYOPT", "PYTHONSTARTUP", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS",
  "GIT_PROXY_COMMAND", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_TEMPLATE_DIR", "GIT_EXEC_PATH"]);
const FOUND_IN = new Set(["PATH", "LD_LIBRARY_PATH", "PYTHONPATH", "NODE_PATH", "PERL5LIB", "RUBYLIB"]);
const ANYONE = /^\/(tmp|var\/tmp|dev\/shm)(\/|$)/;
function loaded(set: string[]): Risk[] {
  const out: Risk[] = [];
  for (const kv of set) {
    const eq = kv.indexOf("=");
    const n = kv.slice(0, eq), v = kv.slice(eq + 1);
    if (!v) continue;
    // git's settings through the environment: the keys `-c` is read for, and the ssh it is told to run (ssh itself is ssh).
    const names = LOADS.has(n) || (n === "NODE_OPTIONS" && /(^|\s)(-r|--require|--import|--loader|--experimental-loader)\b/.test(v))
      || (n === "GIT_SSH_COMMAND" && !/^ssh(\s|$)/.test(v)) || (/^GIT_CONFIG_KEY_\d+$/.test(n) && codeKey(v));
    // An editor or a pager is a program and its plain flags (`code --wait`); anything more is a command of its own.
    const command = /^(GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|EDITOR|VISUAL|PAGER)$/.test(n) && !/^[\w.\/+-]+( --?[\w-]+)*$/.test(v);
    if (names || command) out.push({ rule: "hidden", why: `sets ${n}, which names code the programs the command starts load or run` });
    else if (FOUND_IN.has(n)) { const dir = v.split(":").find((d) => ANYONE.test(d)); if (dir) out.push({ rule: "hidden", why: `puts ${dir}, a folder anyone can write, on ${n}: what the command runs is found there first` }); }
  }
  return out;
}

// Programs whose output is text someone else wrote or encoded: evaluating it runs what is not in the command.
const CARRIES = /^(echo|printf|cat|base64|base32|xxd|openssl|curl|wget|gunzip|zcat|gzip|tr|rev|sed|awk|cut|head|tail|tee|jq|python[0-9.]*|node|perl|ruby)$/;
const FETCHES = /^(curl|wget|aria2c|http|xh)$/;
const CODE_DELETES = /\b(rmtree|os\.(remove|unlink|rmdir|removedirs|truncate)|rmSync|rmdirSync|unlinkSync|removeSync|fs\.(rm|unlink|rmdir|truncate)|promises\.(rm|unlink|rmdir)|Deno\.remove|rm_rf|rm_r|remove_dir|remove_tree|remove_entry|File\.(delete|unlink)|rimraf|unlink)\b|["']rm["']|\brm\s*\(|\brm\s+-[a-zA-Z]*[rRf]/;
// A delete in code whose path is written out in the call: `shutil.rmtree("dist")`, `rmSync("dist", ...)`.
const CODE_DELETE_OF = /\b(?:rmtree|remove|unlink|rmdir|removedirs|rmSync|rmdirSync|unlinkSync|removeSync|rm|rm_rf|rm_r|remove_dir|remove_tree|delete)\s*\(\s*(?:"([^"]*)"|'([^']*)')/g;
const CODE_NETWORK = /https?:\/\/|urlopen|urllib|requests\.|\bfetch\s*\(|socket|http\.client|net\.connect|XMLHttpRequest/;
const CODE_EVALS = /\b(exec|eval|Function|compile)\s*\(|\bnew\s+Function\b/;
const CODE_SOURCE = /https?:\/\/|urlopen|urllib|requests\.|\bfetch\s*\(|b64decode|\batob\s*\(|base64|fromhex|unhexlify|marshal|pickle|codecs\.decode/;
const CODE_PIPES = /\|\s*(sh|bash|zsh|python3?)\b/;
// What code given to an interpreter does that the rules can see in its text.
// `judge`: what a recursive delete of a path written out in the code would be as a command.
function codeRisks(prog: string, code: string, judge?: (path: string) => Risk[]): Risk[] {
  if (CODE_DELETES.test(code)) {
    // Every delete names its path in the call: each is the delete it would be as a command. Else the code is not read.
    const paths = [...code.matchAll(CODE_DELETE_OF)].map((m) => m[1] ?? m[2]!);
    const calls = code.match(new RegExp(CODE_DELETES.source, "g"))?.length ?? 0;
    if (judge && paths.length && paths.length >= calls && !/["']rm["']|\brm\s+-/.test(code)) return paths.flatMap(judge);
    return [{ rule: "destroys", why: `deletes files from code given to ${prog}, which no rule reads as a command` }];
  }
  // Code that reads a credential file and talks to the network.
  if (CODE_NETWORK.test(code)) { const f = [...code.matchAll(/["']([^"'\s]{2,200})["']/g)].map((m) => m[1]!).find(secretFile); if (f) return [{ rule: "exposes", why: `gives ${prog} code that reads ${f}, a file that holds credentials, and talks to the network` }]; }
  if ((CODE_EVALS.test(code) && CODE_SOURCE.test(code)) || CODE_PIPES.test(code)) return [{ rule: "hidden", why: `gives ${prog} code that runs what it fetches or decodes` }];
  return [];
}
// A file opened for writing, or written whole, at a path written out from the root or the home.
const CODE_WRITES = /\bopen\(\s*["']((?:\/|~\/)[^"'\s]{1,300})["']\s*,\s*["'][wx]|\b(?:writeFileSync|writeFile|write_text|File\.write)\(\s*["']((?:\/|~\/)[^"'\s]{1,300})["']/g;
// The code an interpreter is given on its command line.
function inline(p: string, args: string[]): string | null {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (!a.startsWith("-")) return p === "deno" && a === "eval" ? args[k + 1] ?? null : null;
    if (/^python/.test(p) ? /^-[A-Za-z]*c$/.test(a) : p === "php" ? a === "-r" : /^(node|nodejs|bun)$/.test(p) ? /^(-e|-p|-pe|--eval|--print)$/.test(a) : /^-[A-Za-z0-9]*e$/.test(a)) return args[k + 1] ?? null;
    if ((p === "perl" || p === "ruby") && /^-[A-Za-z0-9]*e./.test(a) && !/^-[MmIr]/.test(a)) return a.slice(a.indexOf("e") + 1);
  }
  return null;
}
// The code a command hands to an interpreter on its command line, for what else reads it (the policy's owner-only files).
export function codeGiven(run: Run): string | null {
  const p = name(run.words[0]);
  return INTERPRETERS.test(p) ? inline(p, run.words.slice(1)) : null;
}
// Whether a shell or an interpreter reads its program from its input: it is given no script and no code.
const fromInput = (p: string, args: string[]) => inline(p, args) === null && (!args.some((a) => !a.startsWith("-")) || args.includes("-s") || args.includes("-")) && !(SHELLS.test(p) && args.some((a) => /^-[a-zA-Z]*c$/.test(a)));
const STDIN = /^(\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

// An install or a run whose source is an address the command names (a URL, a
// git repository, a module path with a host), or a registry the command
// names in place of the one the project is set up with: what is fetched and
// run is whatever that address serves. A package named from the project's
// registry is in the command for the owner to read, and asks as any command.
const INSTALLERS = /^(npm|pnpm|yarn|bun|pip|pip3|pipx|uv|uvx|poetry|pdm|cargo|gem|npx|bunx|deno|go|brew|node|nodejs)$/;
const ADDRESS = /^(git\+|git:\/\/|https?:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:)/i;
// A variable named for what it holds: a key, a token, a password.
// The variables a script names its tools by, and the program each stands for.
const STANDS: Record<string, string> = { EDITOR: "vi", VISUAL: "vi", PAGER: "less", SHELL: "sh", CC: "cc", CXX: "c++", MAKE: "make", PYTHON: "python3", NODE: "node", BUN: "bun", GO: "go", CARGO: "cargo" };
const SECRET_VAR = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)/i;
const REGISTRY = /^(--index-url|--extra-index-url|--registry|--index|--default-index|--find-links)(=|$)/;
function fetched(words: string[]): Risk[] {
  const [prog, ...args] = words;
  const p = INTERPRETERS.test(name(prog)) && args[0] === "-m" && args[1] === "pip" ? "pip" : name(prog);
  if (!INSTALLERS.test(p)) return [];
  // node loads a module from an address only when an option names one.
  if (/^node/.test(p)) { const from = args.find((a, k) => /^(--import|--require|-r|--loader|--experimental-loader)$/.test(args[k - 1] ?? "") && ADDRESS.test(a)); return from ? [{ rule: "hidden", why: `loads code from ${from.slice(0, 120)}, an address the command names` }] : []; }
  if (!(p === "npx" || p === "bunx" || p === "uvx" || args.some((a) => /^(install|i|add|dlx|create|exec|x|run|tool)$/.test(a)))) return [];
  const registry = args.find((a, k) => (REGISTRY.test(a) && a.includes("=")) || (REGISTRY.test(args[k - 1] ?? "") && !args[k - 1]!.includes("=")) || (/^pip/.test(p) && args[k - 1] === "-i"));
  const from = args.find((a) => a !== registry && ADDRESS.test(a)) ?? args.find((a) => /^--(from|with|spec)=/.test(a) && ADDRESS.test(a.slice(a.indexOf("=") + 1)))
    // `go run host/path@version` fetches and runs in one step.
    ?? (p === "go" && args[0] === "run" ? args.find((a) => /^[a-z0-9-]+(\.[a-z0-9-]+)+\/[^@\s]+@/i.test(a)) : undefined)
    // To the node package managers `user/repo` after install is a repository on a code host, not a registry name.
    ?? (/^(npm|pnpm|yarn|bun)$/.test(p) && /^(install|i|add)$/.test(args[0] ?? "") ? args.slice(1).find((a) => /^[A-Za-z0-9][\w-]{0,38}\/[\w.-]{1,100}(#[\w.\/-]{0,100})?$/.test(a) && !/\.(tgz|tar\.gz)$/.test(a)) : undefined);
  if (from) return [{ rule: "hidden", why: `fetches from ${from.slice(0, 120)}, an address the command names and not the project's registry, and runs what it serves` }];
  if (registry) return [{ rule: "hidden", why: `installs through a registry the command names (${registry.slice(0, 120)}), not the one the project is set up with` }];
  return [];
}

// ---- class: machine ----

// Names a signal by name reaches far beyond one session: runtimes, shells, the harness, the desktop.
const WIDE_NAMES = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "java", "php", "dotnet", "bash", "sh", "zsh", "fish", "dash", "ksh", "ssh", "sshd", "tmux", "screen", "keel",
  "claude", "codex", "electron", "code", "chrome", "chromium", "firefox", "docker", "dockerd", "containerd", "podman", "systemd", "init", "xorg", "xwayland", "gnome-shell", "dbus-daemon"]);
const PKILL_VALUED = /^(-[gGPstuUcFN]|--signal|--pgroup|--group|--parent|--session|--terminal|--euid|--uid|--pidfile|--ns|--nslist|--runstates)$/;
// Why a pkill, killall, pgrep or grep pattern reaches too far, or null.
function wideNames(p: string, args: string[]): string | null {
  const named: string[] = [];
  let whose = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (/^(-u|-U|--euid|--uid)$/.test(a)) whose = true;
    if (p !== "grep" && PKILL_VALUED.test(a)) { k++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    named.push(a);
  }
  if (!named.length) return whose ? "every process of a user" : null;
  for (const n of named) {
    const bare = n.replace(/^\^/, "").replace(/\$$/, "").replace(/^\[(.)\]/, "$1").toLowerCase();
    if (!bare || /^[.*]+$/.test(bare) || WIDE_NAMES.has(bare)) return `every process ${p === "killall" ? "named" : "that matches"} ${n || "anything"} on this machine, other sessions' and the harness's own among them`;
  }
  return null;
}
// What a container is given when the machine's root, a home, the docker socket or a credential folder is mounted into it.
const MOUNTS = /^(\/|~|\$HOME|\$\{HOME\}|\/home\/[^/:]+|\/Users\/[^/:]+|\/root|\/etc|\/var\/run\/docker\.sock|\/run\/docker\.sock)\/?(:|$)|\/\.(ssh|aws|kube|docker|gnupg)(\/[^:]*)?(:|$)/;

// Programs that change the machine itself: its firewall, its mounts, its kernel, its accounts.
const ADMIN = new Set(["iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "umount", "swapoff", "mount", "sysctl", "modprobe", "rmmod", "insmod", "setenforce", "passwd", "usermod", "userdel", "useradd", "groupdel",
  "visudo", "init", "telinit", "chpasswd"]);
function machine(x: Part, chain: Run[], away: boolean): Risk[] {
  const { p, args, s } = x;
  const add = (why: string): Risk[] => [{ rule: "machine", why }];
  if (x.run.timed) return add("schedules a command to run later, outside the session");
  if (p === "kill") {
    // Fed by xargs: the ids come from the stages before it, and a pattern there says whose.
    if (x.run.fed) {
      for (const r of chain) { const q = name(r.words[0]); const why = /^(pgrep|pidof|grep)$/.test(q) ? wideNames(q, r.words.slice(1)) : null; if (why) return add(`signals ${why}`); }
      return chain.some((r) => /^(ps|pgrep|pidof)$/.test(name(r.words[0]))) && !chain.some((r) => /^(grep|awk|pgrep|pidof)$/.test(name(r.words[0]))) ? add("signals every process another command lists") : [];
    }
    let k = 0;
    if (/^-(s|n)$/.test(args[0] ?? "")) k = 2; else if (/^-[A-Za-z0-9]+$/.test(args[0] ?? "") && args[0] !== "-l" && args[0] !== "-L") k = 1;
    if (args[k] === "--") k++;
    const ids = args.slice(k);
    if (ids.includes("-1")) return add("signals every process the user can reach");
    if (ids.includes("0") || ids.includes("1") || ids.some((a) => /^\$\{?PPID\}?$|^-\$\$$|^-\$\{\$\}$/.test(a))) return add("signals the shell's own process group, its parent or the first process: the harness is among them");
    // The ids another command finds by name.
    for (const m of s.how ?? []) for (const sub of m.subs) for (const inner of sub) {
      const r = unwrap(inner.words).words;
      const why = /^(pgrep|pidof)$/.test(name(r[0])) ? wideNames(name(r[0]), r.slice(1)) : null;
      if (why) return add(`signals ${why}`);
    }
    return [];
  }
  if (p === "pkill" || p === "killall") { const why = wideNames(p, args) ?? (args.some((a) => !a.startsWith("-") && /keel/i.test(a)) ? "the harness's own processes" : null); return why ? add(`signals ${why}`) : []; }
  // (init and telinit only with the level they switch to: a file named init is any program.)
  if (ADMIN.has(p) && !(/^(init|telinit)$/.test(p) && !/^[0-6sSqQuU]$/.test(args[0] ?? "")) && !(p === "sysctl" && !args.some((a) => /^(-w|--write)$/.test(a) || a.includes("="))) && !(p === "mount" && !args.includes("--") && !args.some((a, k) => !a.startsWith("-") && !/^(-t|--types|-O|--test-opts)$/.test(args[k - 1] ?? "")) && !args.some((a) => /^(-a|--all|-o|--options|--bind|--rbind|--move|-[BRM]|--make-[a-z-]+)$/.test(a))) && !(/^(umount|swapoff)$/.test(p) && !args.includes("-a") && !args.includes("--all")))
    return add(`changes how the machine itself is set up (${p})`);
  if (p === "service" && /^(stop|restart|reload)$/.test(x.plain[1] ?? "")) return add("stops or restarts a service of the machine");
  if (p === "tmux" && /^(send-keys|send|paste-buffer)$/.test(x.plain[0] ?? "")) return [{ rule: "hidden", why: "types into another terminal: what runs there is not a command of this session" }];
  if (p === "killall5") return add("signals every process on the machine");
  if (p === "tmux" && args.includes("kill-server")) return add("ends every tmux session of the user, and what runs in them");
  if (p === "loginctl" && args.some((a) => /^(terminate-user|kill-user|terminate-session|kill-session)$/.test(a))) return add("ends a login session and everything in it");
  if (p === "systemctl") {
    if (args.some((a) => /^(poweroff|reboot|halt|suspend|hibernate|kexec|emergency|rescue)$/.test(a))) return add("stops the machine");
    const verb = x.plain[0] ?? "";
    if (verb === "enable" && args.includes("--now")) return add("installs a service that starts now and at every login");
    // (A restart of a unit named for a development daemon is how one is cycled; of the harness's own unit it ends the turn that asked.)
    if ((/^(stop|disable|mask|kill)$/.test(verb) && x.plain.slice(1).some((u) => /keel/i.test(u))) || (/^(restart|try-restart)$/.test(verb) && x.plain.slice(1).some((u) => /^keel(\.service)?$/i.test(u)))) return add("stops the harness's own service");
    // A unit of the machine, or any unit where the command runs on another one: stopping it stops what others use.
    if (/^(stop|disable|mask|kill|isolate)$/.test(verb) && !args.includes("--user")) return add(`stops a service of the machine (systemctl ${verb})`);
    // (A user unit restarted there is what it is here: a development service cycled.)
    if (away && (/^(stop|disable|mask|kill)$/.test(verb) || (/^(restart|reload|start|enable)$/.test(verb) && !args.includes("--user")))) return add(`stops or restarts a service there (systemctl ${verb})`);
  }
  if (p === "launchctl" && /^(load|unload|bootout|bootstrap|remove)$/.test(x.plain[0] ?? "")) return add("changes what the system starts for the user");
  if (p === "crontab") {
    const plain = args.filter((a, k) => !(a.startsWith("-") && a !== "-") && args[k - 1] !== "-u");
    if (args.some((a) => /^-[a-z]*r/.test(a))) return add("removes every scheduled job of the user");
    if (plain.length) return add("replaces the user's scheduled jobs, which run later outside any sandbox");
  }
  if ((p === "at" || p === "batch") && !args.some((a) => /^-[lqrdc]/.test(a))) return add("schedules a command to run later, outside the session");
  if ((p === "docker" || p === "podman") && /^(run|create)$/.test(x.plain[0] ?? "")) {
    if (args.some((a, k) => a === "--privileged" || a === "--pid=host" || (a === "--pid" && args[k + 1] === "host"))) return add("starts a container with this machine's own privileges or processes");
    const source = (a: string) => /(?:source|src)=([^,]+)/.exec(a)?.[1] ?? "";
    const mount = args.find((a, k) => (/^(-v|--volume)$/.test(args[k - 1] ?? "") && MOUNTS.test(a)) || (/^--volume=/.test(a) && MOUNTS.test(a.slice(9)))
      || ((args[k - 1] === "--mount" || a.startsWith("--mount=")) && MOUNTS.test(source(a))));
    if (mount) return add(`gives a container ${mount.replace(/^--\w+=/, "").slice(0, 60)}: the machine's root, a home, the docker socket or a credential folder`);
  }
  return [];
}

// A way in from the network that the command opens: a tunnel to this machine, a server on every interface, or one
// over the home folder. What is behind it is exposed while it runs.
function opens(x: Part, w: Where, vals: Values): Risk[] {
  const { p, args, plain } = x;
  const add = (why: string): Risk[] => [{ rule: "exposes", why }];
  if (p === "tmate") return add("opens this terminal to whoever is given its link (tmate)");
  if (p === "gh" && plain[0] === "repo" && plain[1] === "create" && args.includes("--public") && args.some((a) => /^--(push|source)\b/.test(a))) return add("publishes the repository where anyone can read it (gh repo create --public)");
  // A file server on every interface: php's own, and serve's listen address.
  const every = /^(tcp:\/\/)?(0\.0\.0\.0|\[::\])(:\d+)?$/;
  if ((p === "php" && args.some((a, k) => args[k - 1] === "-S" && every.test(a))) || ((p === "serve" || p === "http-server") && args.some((a, k) => /^(-l|--listen|-a)$/.test(args[k - 1] ?? "") && every.test(a))))
    return add("serves the folder's files to every machine that can reach this one");
  if (p === "ngrok" || p === "localtunnel" || p === "lt" || (p === "cloudflared" && plain[0] === "tunnel")) return add(`opens a tunnel from the network to this machine (${p})`);
  if (p === "ssh" && args.some((a, k) => /^-[a-zA-Z]*R$/.test(a) && args[k + 1] !== undefined) && !args.some((a) => LOCAL_HOST.test(a))) return add("opens a tunnel from another machine to this one (ssh -R)");
  const serves = (INTERPRETERS.test(p) && args.includes("http.server")) || p === "serve" || p === "http-server";
  if (serves) {
    if (args.some((a, k) => /^(0\.0\.0\.0|::)$/.test(a) || /^--bind=(0\.0\.0\.0|::)$/.test(a) || (a === "--bind" && /^(0\.0\.0\.0|::)$/.test(args[k + 1] ?? "")))) return add("serves the folder's files to every machine that can reach this one");
    const dir = INTERPRETERS.test(p) ? args.find((_, k) => args[k - 1] === "--directory" || args[k - 1] === "-d") : plain[0];
    const t = dir ? target(dir, undefined, x.dir, w, vals, x.i) : null;
    if (t && "place" in t && (t.place === "outside" || t.place === "folder")) return add(`serves ${t.shown}, outside the session's folder, over the network`);
  }
  return [];
}

// ---- the whole line ----

// The programs a rule here is written for. A part that runs none of them, sets nothing, redirects nothing, is
// started by no other program and is spelled out is not looked at: that keeps a line of very many small commands cheap.
const KNOWN = new Set([...REACHES, ...DELETES, ...ADMIN, "service", "tar", "zip", "ln", "awk", "gawk", "lua", "brew", "sort", "sponge", "osascript", "vi", "vim", "nvim", "ex", "view", "make", "gmake", "find", "chmod", "chown", "chgrp", "git", "kill", "pkill", "killall", "killall5", "tmux", "loginctl", "systemctl", "launchctl", "crontab", "at", "batch", "eval", "source", ".",
  "alias", "trap", "su", "script", "nix-shell", "mv", "cp", "install", "tee", "dd", "sed", "perl", "sh", "bash", "zsh", "dash", "ksh", "fish", "node", "nodejs", "ruby", "php", "pip", "pip3", "pipx", "uvx", "pdm", "npx",
  "bunx", "go", "ngrok", "cloudflared", "lt", "localtunnel", "serve", "http-server", "parallel", "nc", "ncat", "netcat", "socat", "scp", "sftp", "ftp", "tftp", "rclone", "mail", "mailx", "mutt", "sendmail", "telnet", "websocat", "croc", "wormhole", "kubectl", "oc", "export", "declare", "typeset", "readonly",
  "aria2c"]);
const known = (p: string) => KNOWN.has(p) || p.startsWith("python");

// What the lines of a here-document are to the command they feed: a shell
// runs them here, another machine's shell runs them there, an interpreter
// reads them as its own language, and anything else takes them as data. The
// feeder is looked for among the commands since the here-document before.
// `long`: more text than is read through.
type Fed = { as: "shell" | "away" | "code" | "data"; by: string; host?: string; long?: true };

// A line's parts as commands, and the folder each runs in: worked out once for everything that reads the line.
// `firm`: whether each part's folder is certain (firmOf); `start`: whether the folder the script starts in is.
export type Laid = { runs: Run[]; dirs: (string | null)[]; firm: boolean[] };
export function laid(parts: Simple[], cwd: string | null, home: string, start = true): Laid {
  const runs = parts.map((s) => unwrap(s.words));
  return { runs, dirs: dirsOf(parts, runs, cwd, home), firm: firmOf(parts, runs, start) };
}

// The risks of one script: each part's at its index, and the line's own.
export function analyse(parts: Simple[], w: Where, depth = 0, pre?: Laid): { per: Map<number, Risk[]>; line: Risk[] } {
  const n = parts.length;
  const { runs, dirs, firm } = pre && !w.lost && !w.away ? pre : laid(parts, w.lost || w.away ? null : w.cwd, w.home, !w.shaky);
  // A line that gives HOME or PWD a value of its own names paths the rules do not follow: nothing is taken as
  // outside the session's folder for it, so nothing is left to the sandbox.
  const renamed = !!w.sandboxed && parts.some((s) => !s.heredoc && s.words.some((a) => /^(HOME|PWD|OLDPWD|CDPATH)=/.test(a)));
  w = { ...w, firm, ...(renamed ? { sandboxed: false } : {}) };
  const values = valuesOf(parts, runs);
  // (Most parts have no risk: a part's list is made when it gets its first.)
  const per = new Map<number, Risk[]>();
  const at = (i: number) => { let o = per.get(i); if (!o) per.set(i, (o = [])); return o; };
  const line: Risk[] = [];
  const c: Ctx = { w, vals: values, moved: new Map() };

  // One pass: the stage of the pipeline before each part, and the text and the feeder of each here-document.
  const prev = new Int32Array(n).fill(-1);
  const doc = new Map<number, string>();
  const fed = new Map<number, Fed>();
  let lastTop = -1, lastNested = -1, since = 0, pushes = false;
  for (let i = 0; i < n; i++) {
    const s = parts[i]!;
    if (!s.heredoc) {
      const last = s.nested ? lastNested : lastTop;
      if (last >= 0 && (parts[last]!.sep === "|" || parts[last]!.sep === "|&")) prev[i] = last;
      if (s.nested) lastNested = i; else lastTop = i;
      if (runs[i]!.words[0] === "git" && runs[i]!.words.includes("push")) pushes = true;
      continue;
    }
    // A run of here-document lines: who they feed, and their text for it.
    let end = i, size = 0;
    const text: string[] = [];
    while (end < n && parts[end]!.heredoc) { if (size <= SCRIPT_MAX) text.push(parts[end]!.text); size += parts[end]!.text.length + 1; end++; }
    let f: Fed = { as: "data", by: "" };
    for (let k = since; k < i; k++) {
      const r = runs[k]!;
      const p = name(r.words[0]), args = r.words.slice(1);
      if (p === "ssh" || ((p === "kubectl" || p === "oc" || p === "docker" || p === "podman") && args.includes("exec"))) { f = { as: "away", by: p, host: p === "ssh" ? args.find((a) => !a.startsWith("-")) ?? "another machine" : "a container" }; break; }
      if ((SHELLS.test(p) && fromInput(p, args)) || p === "su") { f = { as: "shell", by: p }; break; }
      if (INTERPRETERS.test(p) && fromInput(p, args)) f = { as: "code", by: p };
    }
    if (size > SCRIPT_MAX) f.long = true;
    const joined = text.join(";");
    for (let k = since; k < i; k++) doc.set(k, doc.has(k) ? `${doc.get(k)};${joined}` : joined);
    for (let k = i; k < end; k++) fed.set(k, f);
    // The feeder answers once for text too long to read, and for what runs somewhere else.
    if (f.long && (f.as === "shell" || f.as === "away")) at(i - 1).push({ rule: "hidden", why: `feeds ${f.by} a script of ${size} characters, longer than the rules read through: put it in a file` });
    else if (f.as === "away") at(i - 1).push(...away(joined, f.host!, w, depth));
    i = end - 1;
    since = end;
  }
  // A credential file a stage above this one in its pipeline reads: looked for only when a sender asks.
  const reads = (k: number) => {
    const q = parts[k]!, r = runs[k]!.words, p = name(r[0]);
    // A client told to print the credential it holds.
    if ((p === "aws" && r.includes("export-credentials")) || (p === "gh" && r[1] === "auth" && r[2] === "token") || (p === "gcloud" && r[1] === "auth" && /^print-(access|identity)-token$/.test(r[2] ?? ""))) return ENVIRONMENT;
    if (sender(p)) return undefined;
    // The environment printed whole, or one variable of it by name, is what holds the tokens.
    if (p === "printenv" || (p === "env" && r.length === 1) || (p === "set" && r.length === 1) || ((p === "export" || p === "declare") && r[1] === "-p")) return ENVIRONMENT;
    // A variable named for a credential, printed for the next stage.
    // (Its other words are text, not files.)
    if (p === "echo" || p === "printf") return q.how?.some((m) => m.vars.some((v) => SECRET_VAR.test(v.name))) ? ENVIRONMENT : undefined;
    // An archive of the folder itself, when an environment file lies in it.
    if (p === "tar" || p === "zip") { const f = r.slice(1).map((a) => envIn(a, dirs[k] ?? null, w)).find((x) => x !== undefined); if (f) return f; }
    return [...q.words.slice(1), ...(q.inputs ?? [])].find(secretFile) ?? (copies.size ? q.words.slice(1).map((a) => copies.get(a)).find((f) => f !== undefined) : undefined);
  };
  const above = (i: number) => { for (let j = prev[i]!, hops = 0; j >= 0 && hops < 32; j = prev[j]!, hops++) { const f = reads(j); if (f) return f; } return undefined; };
  // One named anywhere on the line by a command that does not send, and the variables a substitution filled from one.
  let lineSecret: string | undefined | null = null;
  const anywhere = () => { if (lineSecret === null) { lineSecret = undefined; for (let k = 0; k < n && k < 4_096 && !lineSecret; k++) if (!parts[k]!.heredoc) lineSecret = reads(k); } return lineSecret; };
  let held: Map<string, string> | undefined;
  const holding = () => {
    if (!held) { held = new Map(); for (const [v, k] of values) { const f = k.from?.flatMap((q) => [...q.words.slice(1), ...(q.inputs ?? [])]).find(secretFile); if (f) held.set(v, f); } }
    return held;
  };

  // The functions the line defines, when one of them runs its arguments as its command ("$@", $1): a call of
  // such a function is read as the command it is handed.
  let passes: Set<string> | null = null;
  for (let i = 0; i + 1 < n; i++) {
    const s = parts[i]!, body = parts[i + 1]!;
    if (s.words.length === 1 && !s.dyn && !s.heredoc && body.flow && /^\{(\s|$)/.test(body.text)) (passes ??= new Set()).add(s.words[0]!);
  }
  if (passes && !parts.some((s) => s.flow && s.words.length && /^\$(@|\*|1)$/.test(s.words[0]!) && s.words.slice(1).every((a) => /^\$(@|\*|\d)$/.test(a)))) passes = null;
  const lined: number[] = []; // the parts the line's own rules look at again
  const copies = new Map<string, string>(); // the names the line gave a copy of a credential file
  const script = (text: string, dir: string | null, out: Risk[], w0: Where = w, sure = true) => {
    if (depth >= DEPTH) { out.push({ rule: "hidden", why: "nests scripts deeper than the rules read" }); return; }
    if (text.length > SCRIPT_MAX) { out.push({ rule: "hidden", why: `runs a nested script of ${text.length} characters, longer than the rules read through: put it in a file` }); return; }
    const inner = splitCommand(text);
    if (!inner) { out.push({ rule: "hidden", why: "runs a script the rules cannot split into its commands" }); return; }
    const r = analyse(inner, { ...w0, cwd: dir ?? w0.cwd, ...(dir ? {} : { lost: true as const }), ...(sure && !w0.shaky ? {} : { shaky: true as const }) }, depth + 1);
    for (const one of r.per.values()) out.push(...one);
    out.push(...r.line);
  };
  let free: Ctx | undefined; // the line's context with no sandbox, for what is started outside it

  for (let i = 0; i < n; i++) {
    const s = parts[i]!;
    const run = runs[i]!;
    const old = highRisk(s);
    const first = run.words[0];
    if (old) at(i).push({ rule: OLD(old), why: old, said: true, ...(name(first) === "git" ? { git: true as const } : {}) });
    // A line of a here-document that no shell here runs: code is read for what it deletes or evaluates.
    if (s.heredoc) {
      const f = fed.get(i)!;
      if (f.as === "code") { const found = codeRisks(f.by, s.text); if (found.length) at(i).push(...found); }
      if (f.as !== "shell" || f.long) continue;
    }
    if (run.deep) { at(i).push({ rule: "hidden", why: "starts its command through more wrappers than the rules read" }); continue; }
    const spelled = first === undefined || (!s.dyn?.includes(run.at) && !(GLOB.test(first) && first !== "[" && first !== "[["));
    // A function of the line that runs its arguments as a command: a call of it is the command it is given.
    const passed = spelled && passes !== null && first !== undefined && passes.has(first) && run.words.length > 1;
    // Most parts: a program no rule is written for, spelled out, with nothing set, nothing redirected and nothing in front of it.
    if (spelled && !passed && !run.set.length && !s.redirects && !run.wrapped && !known(name(first)) && !(first?.includes("/") && deployNamed(first, !!w.away))) continue;
    const out = at(i);
    let dir: string | null = dirs[i] ?? null;
    // `env -C DIR CMD` runs the command in that folder.
    const lead = run.wrapped ? s.words.slice(s.words.findIndex((a) => !ASSIGN.test(a))) : null;
    const viaEnv = lead !== null && name(lead[0]) === "env";
    if (viaEnv) { const k = lead!.findIndex((a) => a === "-C" || a === "--chdir"); const to = k > 0 ? lead![k + 1] : lead!.find((a) => a.startsWith("--chdir="))?.slice(8); if (to !== undefined) dir = dir === null || /[$`*?]/.test(to) ? null : resolve(dir, to); }
    const vals = s.flow ? LOST : values;
    const from = run.at + (passed ? 1 : 0);
    const made = (k: number) => s.how?.[s.dyn?.indexOf(from + 1 + k) ?? -1];
    let words = passed ? run.words.slice(1) : run.words;
    if (!spelled) {
      // A program whose name an expansion or a pattern makes is not what the line says it runs: high risk, also
      // when the line itself gave the variable its value (nothing needs a program hidden in a variable). Kept
      // are the names scripts are written with: the owner's editor and pager, the login shell with no script, a
      // build's tool variables (read as the tool they stand for), and the arguments a function or a nested
      // script runs as its command.
      const how = s.dyn?.includes(run.at) ? s.how?.[s.dyn.indexOf(run.at)] : undefined;
      const one = how && !how.rest && !how.subs.length && how.vars.length === 1 && how.vars[0]!.at === 0 && how.vars[0]!.len === first!.length ? how.vars[0]!.name : /^\$\{([A-Z_]+):-[\w.+-]+\}$/.exec(first!)?.[1];
      const stands = one !== undefined && !values.has(one) ? STANDS[one] : undefined;
      const rest = run.words.slice(1);
      if (stands === "sh" && !rest.some((a) => !a.startsWith("-") || /^-[a-zA-Z]*c$/.test(a))) continue;
      // (Only as the whole command: `$1 -rf src` gives its own words to a program nobody named.)
      if (/^\$(@|\*|1)$/.test(first!) && s.flow && (depth > 0 || passes !== null) && rest.every((a) => /^\$(@|\*|\d)$/.test(a))) continue;
      if (!stands || stands === "sh") { out.push({ rule: "hidden", why: `runs a program whose name the line builds as it runs (${first}): write the program out` }); continue; }
      words = [stands, ...rest];
    }
    const args = words.slice(1);
    const x: Part = { s, run: words === run.words ? run : { ...run, words, ...(passed ? { wrapped: true as const } : {}) }, p: name(words[0]), args, plain: args.filter((a) => !a.startsWith("-")), dir, i, made };
    // Started by a program that hands it to a process outside the session's sandbox: nothing confines what it writes.
    const cx = w.sandboxed && (LEAVES.test(x.p) || s.words.slice(0, run.at).some((a) => LEAVES.test(name(a)))) ? (free ??= { ...c, w: { ...w, sandboxed: false } }) : c;
    const sub = (text: string, at: string | null, into: Risk[]) => script(text, at, into, cx.w, firm[i] === true);
    out.push(...loaded(run.set.length || /^(export|declare|typeset|readonly)$/.test(x.p) ? [...run.set, ...args.filter((a) => ASSIGN.test(a))] : run.set), ...overwrites(x, cx));
    // On another machine: a write to a file that runs later there, or lets someone in.
    if (w.away && (s.redirects || x.p === "tee")) {
      const to = [...(s.redirects ? redirected(s).map((r) => r.to) : []), ...(x.p === "tee" ? x.plain : [])].find((t) => AWAY_LATER.test(t));
      if (to) out.push({ rule: "remote", why: `writes ${to}, which runs later or lets someone in` });
      // One of the system's own files, emptied and written over.
      const over = to ? undefined : (s.redirects ? redirected(s).filter((r) => r.empties).map((r) => r.to) : []).find((t) => AWAY_SYSTEM.test(t));
      if (over) out.push({ rule: "remote", why: `overwrites ${over}, a file of the system there` });
    }
    // `env -S 'CMD ARGS'` runs the string as a command.
    if (viaEnv) { const k = lead!.findIndex((a) => a === "-S" || a === "--split-string"); if (k > 0 && lead![k + 1] !== undefined) { sub(lead!.slice(k + 1).join(" "), dir, out); continue; } }
    // A part that only reads destroys and sends nothing.
    if (!words.length || isReadOnly(s.heredoc ? { ...s, heredoc: undefined } : s)) continue;
    // Here for what it sets or redirects alone: a program no rule is written for has nothing more to read, but a
    // redirect into a socket the shell opens.
    if (spelled && !run.wrapped && !known(x.p) && !(first!.includes("/") && deployNamed(first!, !!w.away))) { if (s.redirects) out.push(...exposes(x, above, holding, anywhere, copies, w, vals)); continue; }
    lined.push(i);
    const before = prev[i]! >= 0 ? runs[prev[i]!]! : null;
    // The text handed to it on its input, where the line holds it: the here-document after it, or what echo before it prints.
    const told = before && /^(echo|printf)$/.test(name(before.words[0])) ? before.words.slice(1).join(" ") : "";
    const text = { text: doc.has(i) ? `${doc.get(i)};${told}` : told, piped: !!before && !told };
    const chain: Run[] = [];
    if (x.p === "kill" && run.fed) for (let j = prev[i]!, hops = 0; j >= 0 && hops < 16; j = prev[j]!, hops++) chain.push(runs[j]!);
    const typed = s.words.slice(s.words.findIndex((a) => !ASSIGN.test(a)));
    out.push(...deletes(x, cx, before), ...(x.p === "git" ? gitRisks(words) : []), ...remote(x, text, w, vals), ...exposes(x, above, holding, anywhere, copies, w, vals), ...fetched(run.wrapped ? typed : words), ...(run.wrapped ? fetched(words) : []), ...machine(x, chain, !!w.away), ...opens(x, w, vals));
    if ((x.p === "cp" || x.p === "mv" || x.p === "install" || x.p === "ln") && x.plain.length === 2 && (secretFile(x.plain[0]!) || copies.has(x.plain[0]!))) copies.set(x.plain[1]!, copies.get(x.plain[0]!) ?? x.plain[0]!);
    if (x.p === "mv" && x.plain.length === 2) {
      const [from, to] = x.plain.map((a) => target(a, made(args.indexOf(a)), dir, w, vals, i));
      if (from && to && "place" in from && "place" in to && from.place === "inside" && to.place === "inside" && !from.glob && !to.glob) c.moved.set(to.path, from.path);
    }
    // A command that runs somewhere else is read as the commands it holds, with nothing there the session's own.
    // (A word written in ANSI-C quotes is the text its escapes spell: read as that, or not read at all.)
    let xr = x;
    if (s.text.includes("$'") && /^(ssh|autossh|kubectl|oc|docker|podman|docker-compose)$/.test(x.p)) {
      const spelt = [...s.text.matchAll(/\$'((?:[^'\\]|\\.)*)'/g)].map((m) => ansi(m[1]!));
      const at = args.map((_, k) => k).filter((k) => { const m = made(k); return !!m && m.one && m.rest && !m.vars.length && !m.subs.length; });
      if (spelt.length !== at.length || spelt.some((t) => t === null)) { out.push({ rule: "hidden", why: "spells part of a command for another machine in escapes the rules do not read: write it out" }); continue; }
      const decoded = [...args];
      at.forEach((k, j) => { decoded[k] = spelt[j]!; });
      xr = { ...x, args: decoded, plain: decoded.filter((a) => !a.startsWith("-")) };
    }
    const far = elsewhere(xr);
    if (far) {
      const handed = !!before || !!s.inputs?.length;
      const shell = far.command.length ? SHELLS.test(name(far.command[0])) && fromInput(name(far.command[0]), far.command.slice(1)) : p0(x) === "ssh";
      if (handed && shell) out.push({ rule: "remote", why: `on ${far.host}, runs a script it is handed on its input: its text is not in the command` });
      else if (far.command.length) {
        // A file of statements handed to a database client there is read here, where the file is.
        const fed = s.inputs?.[0] !== undefined ? target(s.inputs[0], undefined, dir, w, vals, i) : null;
        const sql = fed && "path" in fed && !fed.glob ? w.looked?.read(fed.path) : undefined;
        out.push(...away(far.argv ? far.command : far.command.join(" "), far.host, w, depth, typeof sql === "string" ? { sql } : s.inputs?.length ? { file: s.inputs[0]! } : undefined));
      }
      continue;
    }
    // A container that mounts a folder of this machine: what its command deletes under the mount is deleted here.
    if ((x.p === "docker" || x.p === "podman") && x.plain[0] === "run" && dir !== null && !w.away && depth < DEPTH) {
      const mounted = contained(args, dir, w.home);
      if (mounted) {
        const r = analyse([{ words: mounted.command, text: mounted.command.join(" "), redirects: false }], { ...cx.w, cwd: mounted.cwd }, depth + 1);
        for (const one of [...[...r.per.values()].flat(), ...r.line]) if (one.rule === "destroys") out.push({ rule: "destroys", why: `${one.why} (through the folder the container mounts)` });
      }
    }
    // What a write-open of a path outside the folder, written out in code, would be as a command.
    const opened = (path: string): Risk[] => {
      if (cx.w.sandboxed || w.away) return [];
      const t = target(path, undefined, dir, w, vals, i);
      if (!("place" in t) || (t.place !== "outside" && t.place !== "folder") || t.path.startsWith("/dev/")) return [];
      const e = w.looked?.exists(t.path);
      return e === "late" || e === "file" ? [{ rule: "destroys", why: `overwrites ${t.shown}, outside the session's folder` }] : [];
    };
    // What a delete written in code would be as a command, for code whose every delete names its path.
    const judge = (path: string) => deletes({ ...x, run: { words: ["rm", "-r", path], at: 0, set: [] }, p: "rm", args: ["-r", path], plain: [path], made: () => undefined }, cx, null);
    // A script given to a shell, to eval, or to a program that runs one, is read as the commands it holds.
    const here = SHELLS.test(x.p) && fromInput(x.p, args) ? /<<<\s*(?:'([^']*)'|"([^"$`\\]*)")/.exec(s.text) : null;
    if (here) sub(here[1] ?? here[2]!, dir, out);
    // macOS: a script handed to the shell through AppleScript.
    if (x.p === "osascript") { const told = /do shell script\s+"((?:[^"\\]|\\.)*)"/.exec(args.join(" ")); if (told) sub(told[1]!.replace(/\\(.)/g, "$1"), dir, out); }
    // An editor told to run a shell command (vim -c ':!cmd'), and a makefile another command or the line's own text hands it.
    if (/^(vi|vim|nvim|ex|view)$/.test(x.p)) for (const [k, a] of args.entries()) { const told = /^\+?:?!(.+)$/s.exec(/^-[a-zA-Z]*c$/.test(args[k - 1] ?? "") || a.startsWith("+") ? a : ""); if (told) sub(told[1]!, dir, out); }
    if (/^(make|gmake)$/.test(x.p) && (before || s.text.includes("<<<")) && args.some((a, k) => /^(-f|--file|--makefile)$/.test(args[k - 1] ?? "") && (a === "-" || STDIN.test(a)))) out.push({ rule: "hidden", why: "runs a makefile it is handed on its input: its text is not in the command" });
    if (x.p === "parallel" && !x.plain.length) out.push({ rule: "hidden", why: "runs as commands the lines another command prints: their text is not in the command" });
    if (x.p === "tmux" && /^(new|new-session|neww|new-window|splitw|split-window|respawn-pane|run-shell|run)$/.test(x.plain[0] ?? "")) { const given = x.plain.slice(1).at(-1); if (given && /\s/.test(given)) sub(given, dir, out); }
    if ((x.p === "docker" || x.p === "podman") && /^(rm|kill|stop)$/.test(x.plain[0] ?? "") && (s.how ?? []).some((m) => m.subs.some((sub) => sub.some((q) => /^(docker|podman)$/.test(name(q.words[0])) && q.words[1] === "ps"))))
      out.push({ rule: "destroys", why: `stops or removes every container ${x.p} lists` });
    if (SHELLS.test(x.p) || x.p === "su" || x.p === "script" || x.p === "nix-shell") {
      const k = args.findIndex((a) => (x.p === "nix-shell" ? a === "--run" || a === "--command" : /^-[a-zA-Z]*c$/.test(a)));
      const given = k >= 0 ? args[k + 1] : undefined;
      // Fed by xargs or find with no script of its own, or with one that is only what it is fed: what runs comes from there.
      if (run.fed && SHELLS.test(x.p) && k >= 0 && (given === undefined || /^\{\}$|^"?\$[@*1]"?$/.test(given.trim()))) out.push({ rule: "hidden", why: `runs in ${x.p} what another command prints: its text is not in the command` });
      else if (given !== undefined) sub(given, dir, out);
    } else if (x.p === "trap") {
      const action = args.find((a) => !a.startsWith("-"));
      if (action && args.length > 1 && action !== "-") sub(action, dir, out);
    } else if (x.p === "git") {
      const given = gitRuns(words);
      if (given) sub(given, dir, out);
    } else if (x.p === "eval") {
      const dynamic = args.map((_, k) => made(k)).filter((m): m is Made => !!m);
      // The output of one program is that program's to answer for (eval "$(ssh-agent -s)"); text a decoder, a fetcher, echo or a variable carries is not in the command.
      const built = dynamic.flatMap((m) => m.subs).find((sub) => sub.length !== 1 || CARRIES.test(name(unwrap(sub[0]!.words).words[0])));
      if (built || dynamic.some((m) => m.vars.length || m.rest)) out.push({ rule: "hidden", why: `evaluates text the line builds as it runs${built ? ` (${built.map((b) => b.text).join(" | ").slice(0, 80)})` : ""}: what runs is not in the command` });
      else if (!dynamic.length && args.length) sub(args.join(" "), dir, out);
    } else if (x.p === "source" || x.p === ".") {
      // Its input, or a file a substitution makes (source <(curl ...)): not text in the command.
      const fetcher = args.some((a) => a.includes("$(...)")) ? parts.slice(Math.max(0, i - 8), i).reverse().find((q) => q.nested && FETCHES.test(name(unwrap(q.words).words[0]))) : undefined;
      if (fetcher) out.push({ rule: "hidden", why: `runs a downloaded script (${fetcher.text.slice(0, 80)})` });
      else if (args.some((a) => STDIN.test(a))) out.push({ rule: "hidden", why: "runs as a script what it is handed on its input: its text is not in the command" });
    } else if (x.p === "alias" && args.some((a) => /^[^=\s-][^=\s]*=/.test(a))) out.push({ rule: "hidden", why: "gives a word another meaning (alias): what a later command runs is not what it says" });
    else if (INTERPRETERS.test(x.p) || x.p === "lua") {
      const code = x.p === "lua" ? args[args.indexOf("-e") + 1] ?? null : inline(x.p, args);
      if (code !== null) out.push(...codeRisks(x.p, code, judge), ...[...code.matchAll(CODE_WRITES)].slice(0, 16).flatMap((m) => opened(m[1] ?? m[2]!)));
    } else if (x.p === "awk" || x.p === "gawk") {
      // awk runs what its script hands to system() or pipes into a shell.
      const code = x.plain[0] ?? "";
      if (/\bsystem\s*\(|\|\s*"(sh|bash)"/.test(code)) out.push(...(codeRisks(x.p, code).length ? codeRisks(x.p, code) : [{ rule: "hidden" as const, why: "gives awk a script that runs commands it builds" }]));
    }
  }
  const whole = lineRisk(parts);
  if (whole) line.push({ rule: "hidden", why: whole, said: true });
  // A loop with no end that starts something in the background each time round, with nothing to pace it.
  for (let i = 0; i < n; i++) {
    const s = parts[i]!;
    if (!s.flow || !/^(while\s+(true|:|1)|until\s+false)$/.test(s.text.trim())) continue;
    let spawns = false, paced = false;
    for (let k = i + 1; k < n && k < i + 32 && parts[k]!.flow; k++) {
      const q = parts[k]!, r = runs[k]!.words;
      if (/^(sleep|wait|read)$/.test(name(r[0]))) paced = true;
      if (q.sep === "&" || (SHELLS.test(name(r[0])) && r.some((a) => /(^|[^&])&\s*$/.test(a.slice(-8))))) spawns = true;
    }
    if (spawns && !paced) { line.push({ rule: "machine", why: "starts a process in the background on every turn of a loop that does not end, until the machine stops" }); break; }
  }
  // A command piped into itself in the background: each run starts two more.
  for (let i = 0; i + 1 < n; i++) {
    const s = parts[i]!;
    if (s.sep === "|" && parts[i + 1]!.sep === "&" && s.words.length === 1 && parts[i + 1]!.words.length === 1 && parts[i + 1]!.words[0] === s.words[0]) { line.push({ rule: "machine", why: `pipes ${s.words[0]} into itself in the background: every run starts two more, until the machine stops` }); break; }
  }
  const added = new Map<string, string>(); // the remotes the line adds, by name
  for (const i of lined) {
    const s = parts[i]!;
    if (s.heredoc) continue;
    const run = runs[i]!;
    const p = name(run.words[0]);
    if (!(SHELLS.test(p) || INTERPRETERS.test(p) || FETCHES.test(p) || (p === "git" && (pushes || run.words[1] === "clone")))) continue;
    const args = run.words.slice(1);
    if (p === "git" && pushes) {
      const g = gitParts(run.words);
      if (g?.sub === "remote" && g.args[0] === "add") { const named = g.args.slice(1).filter((a) => !a.startsWith("-")); if (named[0] && named[1]) added.set(named[0], named[1]); }
      const to = g?.sub === "push" ? g.args.find((a) => !a.startsWith("-")) : undefined;
      if (to && added.has(to)) line.push({ rule: "exposes", why: `pushes the repository to ${added.get(to)!.slice(0, 100)}, a remote the same line adds` });
    }
    // A shell or an interpreter that reads its program from a pipe: what the stage before prints is what runs.
    const j = prev[i]!;
    if (!whole && j >= 0 && (SHELLS.test(p) || INTERPRETERS.test(p)) && fromInput(p, args)) {
      const from = parts[j]!;
      const src = runs[j]!.words;
      // What echo prints is in the command: read it as the script it is. Not with escapes that spell something else.
      const plain = name(src[0]) === "echo" && !from.dyn && prev[j]! < 0 && SHELLS.test(p) && !src.slice(1).some((a) => /^-[a-zA-Z]*e/.test(a) || a.includes("\\"));
      if (plain) script(src.slice(1).join(" "), dirs[i]!, line, w, firm[i] === true);
      else line.push({ rule: "hidden", why: `runs in ${p} what \`${from.text.slice(0, 60)}\` prints: its text is not in the command` });
    }
    // A file the line downloads and then runs: named by -o or -O (also in a cluster), or by a redirect.
    if (FETCHES.test(p)) {
      const url = args.find((a) => /^https?:\/\//i.test(a))?.split(/[?#]/)[0];
      const o = args.findIndex((a) => /^(--output|--output-document|-[a-zA-Z]*[oO])$/.test(a));
      const to = redirected(s)[0]?.to ?? (o < 0 ? (p === "wget" ? url : undefined) : /O$/.test(args[o]!) && p === "curl" ? url : args[o + 1]);
      const file = name(to);
      if (file && file !== "null") for (let k = i + 1; k < n && k < i + 64; k++) {
        const r = runs[k]!.words;
        const q = name(r[0]);
        if (q === file || ((SHELLS.test(q) || INTERPRETERS.test(q) || q === "source" || q === ".") && !(SHELLS.test(q) && r.includes("-n")) && r.slice(1).some((a) => name(a) === file))) { line.push({ rule: "hidden", why: `runs ${file}, a script the same line downloads` }); break; }
      }
    }
    // A repository the line clones and then builds or runs in: what runs was fetched a moment before.
    if (p === "git" && run.words[1] === "clone") {
      const named = args.slice(1).filter((a, k, all) => !a.startsWith("-") && !/^(-b|--branch|--depth|-o|--origin|-c|--config|--reference|--separate-git-dir|-j|--jobs|--filter|-u|--upload-pack|--template)$/.test(all[k - 1] ?? ""));
      const url = named[0];
      const into = url && ADDRESS.test(url) && dirs[i] ? resolve(dirs[i]!, named[1] ?? name(untrailed(url)).replace(/\.git$/, "")) : null;
      if (into) for (let k = i + 1; k < n && k < i + 64; k++) {
        const at = dirs[k], q = name(runs[k]!.words[0]);
        if (at && under(into, at) && q !== "cd" && q !== "git" && !isReadOnly(parts[k]!)) { line.push({ rule: "hidden", why: `runs ${q} in ${name(into)}, a repository the same line clones from ${url!.slice(0, 80)}` }); break; }
      }
    }
    // A credential file staged in a line that pushes.
    if (p === "git" && pushes && run.words[1] === "add") { const f = args.slice(1).find(secretFile); if (f) line.push({ rule: "exposes", why: `stages ${f}, a file that holds credentials, in a line that pushes` }); }
  }
  return { per, line };
}
const p0 = (x: Part) => name(x.run.words[0]);

// A command that runs on another machine or in a container: read through the same classes, with no folder known
// and nothing there the session's own. What it would be here, it is there, where nothing holds it.
// `text`: a script the shell there reads, or the words of one command run as they are.
// `fed`: what it is handed on its input from this machine: the statements of a file that was read, or the file's name.
function away(text: string | string[], host: string, w: Where, depth: number, fed?: { sql?: string; file?: string }): Risk[] {
  if (depth >= DEPTH) return [{ rule: "hidden", why: "nests scripts deeper than the rules read" }];
  if (typeof text === "string" && text.length > SCRIPT_MAX) return [{ rule: "hidden", why: `runs on ${host} a script of ${text.length} characters, longer than the rules read through: put it in a file there` }];
  const inner = typeof text === "string" ? splitCommand(text) : [{ words: text, text: text.join(" "), redirects: false }];
  if (!inner) return [{ rule: "hidden", why: `runs on ${host} a script the rules cannot split into its commands` }];
  // What a database client there is handed: statements that were read stand with its own words; a file that was not read is its input.
  if (fed && inner.length === 1 && sqlClient(name(unwrap(inner[0]!.words).words[0]))) inner[0] = fed.sql !== undefined ? { ...inner[0]!, words: [...inner[0]!.words, fed.sql] } : { ...inner[0]!, inputs: [fed.file!] };
  const r = analyse(inner, { cwd: "/", home: w.home, workspace: w.workspace, away: host }, depth + 1);
  const seen = new Set<string>();
  const out: Risk[] = [];
  for (const x of [...[...r.per.values()].flat(), ...r.line]) if (!seen.has(x.why)) { seen.add(x.why); out.push({ rule: "remote", why: `on ${host}, ${x.why}` }); }
  return out;
}

// Files of another machine that run later there, or let someone in: its login keys and start files, its cron
// tables, its accounts and services.
const AWAY_SYSTEM = /^\/(etc|usr|boot|bin|sbin|lib|lib64|opt|var\/lib)\//;
const AWAY_LATER = /(^|\/)(\.ssh\/(authorized_keys2?|config|rc|environment)|\.(bashrc|bash_profile|bash_login|profile|zshrc|zshenv|zprofile|zlogin)|\.config\/systemd\/)|^\/etc\/(crontab|cron\.|sudoers|profile|ssh\/|systemd\/|rc\.local|ld\.so\.preload|passwd|shadow|environment)|^\/var\/spool\/cron/;
// The text an ANSI-C quoted word spells ($'\x72\x6d' is rm). null: an escape the rules do not read.
function ansi(body: string): string | null {
  let out = "";
  for (let k = 0; k < body.length; k++) {
    const ch = body[k]!;
    if (ch !== "\\") { out += ch; continue; }
    const rest = body.slice(k + 1, k + 9);
    const m = /^x([0-9a-fA-F]{1,2})/.exec(rest) ?? /^([0-7]{1,3})/.exec(rest);
    if (m) { out += String.fromCharCode(parseInt(m[1]!, rest[0] === "x" ? 16 : 8)); k += m[0].length; continue; }
    const one: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "?": "?" };
    if (rest[0] !== undefined && one[rest[0]] !== undefined) { out += one[rest[0]]; k += 1; continue; }
    return null;
  }
  return out;
}
// The command a `docker run` hands its container, when a folder of this machine is mounted in it: with the
// mount's paths as this machine's, and every other path of the container somewhere that holds nothing (a
// container's own files are not the session's). null: nothing of this machine is mounted.
const RUN_VALUED = /^(-v|--volume|--mount|-e|--env|--env-file|-p|--publish|-w|--workdir|--name|--network|--net|-u|--user|--entrypoint|-l|--label|-m|--memory|--cpus|--platform|-h|--hostname|--add-host|--cap-add|--cap-drop|--device|--dns|--gpus|--ipc|--pid|--restart|--security-opt|--shm-size|--tmpfs|--ulimit|--volumes-from|--cidfile|--log-driver|--log-opt|--pull|--runtime|--stop-signal|--stop-timeout|--userns|--uts|--cgroupns|--link|--expose|--ip|--annotation|-a|--attach|-c|--cpu-shares|--cpuset-cpus)$/;
const NOWHERE = "/tmp/keel-container";
function contained(args: string[], dir: string, home: string): { command: string[]; cwd: string } | null {
  const mounts: { src: string; dst: string }[] = [];
  let workdir: string | undefined;
  let i = args.indexOf("run") + 1;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const a = args[i]!, eq = a.indexOf("=");
    const v = /^(-v|--volume)$/.test(a) ? args[i + 1] : /^(-v|--volume)=/.test(a) ? a.slice(eq + 1) : undefined;
    if (v !== undefined) { const [src, dst] = v.split(":"); if (src && dst?.startsWith("/")) mounts.push({ src, dst }); }
    const m = a === "--mount" ? args[i + 1] : a.startsWith("--mount=") ? a.slice(8) : undefined;
    if (m !== undefined && /(^|,)type=bind(,|$)/.test(m)) { const src = /(?:^|,)(?:source|src)=([^,]+)/.exec(m)?.[1], dst = /(?:^|,)(?:target|destination|dst)=([^,]+)/.exec(m)?.[1]; if (src && dst) mounts.push({ src, dst }); }
    if (/^(-w|--workdir)$/.test(a)) workdir = args[i + 1]; else if (/^--workdir=/.test(a)) workdir = a.slice(10);
    if (RUN_VALUED.test(a)) i++;
  }
  const command = args.slice(i + 1);
  // The folder a mount's source names: the one the command runs in ($PWD, ., a substitution, which is `pwd` when it is anything), one under it, or one written from the root or the home.
  const here = (src: string): string | null => {
    const t = src.replace(/^\$\{?PWD\}?|^\$\(\.\.\.\)/, dir).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    return /[$`*?]/.test(t) ? null : resolve(dir, t);
  };
  const ours = mounts.map((m) => ({ dst: untrailed(m.dst) || "/", src: here(m.src) })).filter((m): m is { dst: string; src: string } => m.src !== null && m.dst !== "/").slice(0, 8);
  if (!ours.length || !command.length || command.length > 256) return null;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mapped = (word: string) => {
    let t = word;
    ours.forEach((m, k) => { t = t.replace(new RegExp(`(^|[\\s'"=;(])${esc(m.dst)}(?=\\/|$|[\\s'";)])`, "g"), `$1\u0001${k}\u0002`); });
    t = t.replace(/(^|[\s'"=;(])\/(?=[A-Za-z0-9._-])/g, `$1${NOWHERE}/`);
    return t.replace(/\u0001(\d+)\u0002/g, (_, k: string) => ours[Number(k)]!.src);
  };
  const cwd = workdir ? mapped(workdir) : NOWHERE;
  return { command: command.map(mapped), cwd: cwd.startsWith("/") ? cwd : NOWHERE };
}
const OLD = (why: string): RiskRule => (/^runs as root|^stops the machine/.test(why) ? "machine" : /remote/.test(why) ? "remote" : /downloaded/.test(why) ? "hidden" : "destroys");

// Every reason the line is high risk, each once.
export function risksOf(parts: Simple[], w: Where, pre?: Laid): Risk[] {
  const { per, line } = analyse(parts, w, 0, pre);
  const seen = new Set<string>();
  const out: Risk[] = [];
  for (const i of [...per.keys()].sort((a, b) => a - b)) for (const r of per.get(i)!) if (!seen.has(r.why)) { seen.add(r.why); out.push(r); }
  for (const r of line) if (!seen.has(r.why)) { seen.add(r.why); out.push(r); }
  return out;
}
