// Conventions that kept breaking across lanes, checked over the source tree.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name);
    return entry.isDirectory() ? (entry.name === "node_modules" ? [] : files(p, ext)) : ext.test(entry.name) ? [p] : [];
  });
}
const source = files(join(ROOT, "src"), /\.ts$/);
const product = source.filter((f) => !f.endsWith(".test.ts"));
const tests = [...source.filter((f) => f.endsWith(".test.ts")), ...files(join(ROOT, "scripts"), /\.test\.ts$/)].filter((f) => !f.endsWith("conventions.test.ts"));
const cache = new Map<string, string>();
function textOf(file: string): string {
  const got = cache.get(file);
  if (got !== undefined) return got;
  const text = readFileSync(file, "utf8");
  cache.set(file, text);
  return text;
}
const offenders = (list: string[], bad: RegExp) => list.filter((f) => bad.test(textOf(f))).map((f) => relative(ROOT, f));

test("specs take test from isolate.ts, which restores daemon-wide settings", () => {
  expect(offenders(files(join(ROOT, "test/e2e"), /\.spec\.ts$/), /from "@playwright\/test"/)).toEqual([]);
});

test("byte streams (child pipes, HTTP bodies) are read through src/core/proc.ts", () => {
  const src = product.filter((f) => !f.endsWith("core/proc.ts"));
  expect(offenders(src, /new Response\([\w.!]*\.std(out|err)\b/)).toEqual([]);
  // A reader of its own, or `for await` over a stream, releases the reader when
  // the read stops early, which Bun rejects unhandled ("Reader released");
  // chunks() cancels instead.
  expect(offenders(src, /\.getReader\(\)|\.releaseLock\(|for await \(const \w+ of [\w.!]+\.(std(out|err)|body|stream\(\))/)).toEqual([]);
});

test("path containment is contains(root, p) from src/core/paths.ts", () => {
  const src = source.filter((f) => !f.endsWith("core/paths.ts"));
  expect(offenders(src, /(const|function) inside\b/)).toEqual([]);
});

// git runs programs a repository's config names. The daemon runs it through
// src/core/git.ts only, which does not read that config (see the file's head).
test("git is run through src/core/git.ts", () => {
  const src = product.filter((f) => !f.endsWith("core/git.ts"));
  // A spawn whose program is git: spawn("git", ...) or spawn(["git", ...]), an
  // argv built apart (["git", ...args], ["git", "-C", ...]), git by its whole
  // path, git in a shell template (Bun's $), and git at the head of a command
  // line handed to a shell.
  expect(offenders(src, /(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*\[?\s*["'`]git[\s"'`]|\[\s*["'`]git["'`]\s*,\s*(\.\.\.|["'`]-)/)).toEqual([]);
  expect(offenders(src, /["'`]\/[\w./-]*\/git["'`]\s*[,\]]|\$`\s*git\s|["'`](ba)?sh["'`]\s*,\s*["'`]-l?c["'`]\s*,\s*["'`]\s*git\s/)).toEqual([]);
  // Shell text of the daemon's own that runs git (a script sent to a machine):
  // the file takes the helper's keys or its view for it.
  const scripts = src.filter((f) => /\$\(git |\$\{GIT\} |^git [a-z-]+ /m.test(textOf(f)));
  expect(scripts.map((f) => relative(ROOT, f)).sort()).toEqual(["src/fleet/agents.ts", "src/fleet/handoff.ts"]);
  for (const f of scripts) expect([relative(ROOT, f), /\bGIT_SHELL_ENV\b/.test(textOf(f))]).toEqual([relative(ROOT, f), true]);
  // gh runs git by itself: every spawn of it gets the helper's environment.
  const gh = src.filter((f) => /["'`]gh["'`]\s*,\s*["'`](pr|repo|auth|api|issue|run|release|workflow)["'`]|KEEL_GH_BIN[^\n]*,\s*["'`](pr|repo|auth|api)["'`]|\[gh,\s*["'`]/.test(textOf(f)));
  expect(gh.map((f) => relative(ROOT, f)).sort()).toEqual(["src/automation/waits.ts", "src/mcp/connectors.ts", "src/prreview/github.ts", "src/safety/public-send.ts", "src/worktree/manager.ts"]);
  for (const f of gh) expect([relative(ROOT, f), /\bgitEnv\(/.test(textOf(f))]).toEqual([relative(ROOT, f), true]);
});

// SQLite's locks on the store belong to the process: closing any descriptor
// of keel.db or of its log's index gives every one of them up, and another
// process can then take the log from under the daemon (src/core/store-files.ts).
// So the store's files are opened by SQLite and by storeFd only, and who
// names them is a short list: a file that joins it reads this first.
test("the store's files are named in few places and opened outside SQLite only through storeFd", () => {
  const src = product;
  const names = /["'`]keel\.db|keel\.db-(wal|shm)|\}-(wal|shm)[`"']/;
  expect(offenders(src, names).sort()).toEqual([
    "src/admin/backup.ts",          // a backup's own files (keel.db.zst, a copy made for it), the restored copy, the log's size by stat
    "src/admin/stall-cause.ts",     // the words a stall row uses for them
    "src/admin/storage.ts",         // their sizes by stat, and a restore that moves them aside with no daemon on the folder
    "src/core/checkpoint-worker.ts", // the kept descriptors of the log (to sync it) and of its index (to read how far the copy is)
    "src/core/checkpoint.ts",       // the index's kept descriptor, to see how long the log is while the thread is in a step
    "src/core/log-pages.ts",        // the kept descriptors of the log and its index, to read which pages the frames name
    "src/core/store-files.ts",
    "src/server/routes/search-fill-worker.ts", // the index's kept descriptor (storeFd), to see how long the log is before a step
  ]);
  // The file of owed writes is an instruction to the next start (src/core/owed.ts): the daemon alone
  // reads and writes it, and who names it is shorter still.
  expect(offenders(src, /owed-writes|\bOWED_FILE\b/).sort()).toEqual(["src/core/owed.ts", "src/core/store-files.ts", "src/core/store.ts"]);
  // No call of node:fs or Bun.file that opens a file is given one of their paths: written in the
  // call, through storePath or the names' constants, or through a variable that was given one.
  const OPENS = "openSync|open|readFileSync|readFile|createReadStream|createWriteStream|copyFileSync|copyFile|writeFileSync|writeFile|appendFileSync|appendFile|truncateSync|truncate|Bun\\.file|Bun\\.write";
  const STORE = String.raw`["'\`]keel\.db["'\`]|keel\.db-(wal|shm)|-(wal|shm)[\`"']|\bstorePath\(|\bSTORE_DB\b|\bSTORE_FILES\b`;
  const others = src.filter((f) => !f.endsWith("core/store-files.ts"));
  const inCall = new RegExp(String.raw`(?<![\w.])(${OPENS})\([^\n]*(${STORE})`);
  expect(offenders(others, inCall)).toEqual([]);
  const throughVariable = others.filter((f) => {
    const text = textOf(f);
    const given = [...text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=[^\n;]*(${STORE})`, "g"))].map((m) => m[1]!);
    return given.some((name) => new RegExp(String.raw`(?<![\w.])(${OPENS})\(\s*${name}\b`).test(text));
  }).map((f) => relative(ROOT, f));
  expect(throughVariable).toEqual([]);
  // The lint's own cases: each of these would be caught.
  const caught = (text: string) => inCall.test(text) || [...text.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=[^\n;]*(${STORE})`, "g"))].some((m) => new RegExp(String.raw`(?<![\w.])(${OPENS})\(\s*${m[1]}\b`).test(text));
  for (const bad of [
    'const fd = openSync(join(dir, "keel.db"), "r");',
    "const p = storePath(d);\nconst fd = openSync(p);",
    "openSync(join(d, STORE_DB))",
    "const shm = `${path}-shm`;\nreadFileSync(shm);",
    "const db: string = join(state, STORE_FILES[0]);\nawait Bun.file(db).arrayBuffer();",
    "await Bun.write(storePath(dir), bytes)",
  ]) expect([bad, caught(bad)]).toEqual([bad, true]);
  for (const fine of ["const p = storePath(d);\nconst st = statSync(p);", "const fd = storeFd(storePath(dir));", 'new Database(storePath(dir), { readonly: true })', 'openSync(join(tmp, "keel.db.raw"), "r")']) expect([fine, caught(fine)]).toEqual([fine, false]);
});

// The daemon's log tells what happened without what was said or run: its own lines (say, sayAt of
// src/admin/daemon-log.ts) are made of names, kinds, states and the harness's words, never of a
// prompt, a reply, a command, its output or a wait's note.
test("the daemon's own log lines carry no prompt, command, output or note", () => {
  const src = product;
  // (A failure's message is the provider's or the runtime's words, not the session's: it may be said, scrubbed.)
  const bad = /\b(stdout|stderr|summary|blocks)\b|\.(text|input|prompt|note|command|output|outcome|tail)\b/;
  const lines = src.flatMap((f) => {
    const text = textOf(f);
    if (!/from "[./]*(admin\/)?daemon-log\.ts"/.test(text)) return [];
    return text.split("\n").flatMap((l, i) => (/\bsay(At)?\(/.test(l) && !/^\s*(\/\/|export function say|private say)/.test(l) && bad.test(l.replace(/\/\/.*$/, "")) ? [`${relative(ROOT, f)}:${i + 1}`] : []));
  });
  expect(lines).toEqual([]);
});

// os.homedir() reads $HOME once, when the process starts, so a scratch HOME set
// later (a test preload, a probe) is not seen by it, and a daemon read the
// owner's folders from it. The home is homeDir() in src/core/paths.ts.
test("the home folder is homeDir() from src/core/paths.ts, never os.homedir() or os.userInfo().homedir", () => {
  const src = source.filter((f) => !/core\/paths(\.test)?\.ts$|conventions\.test\.ts$/.test(f));
  expect(offenders(src, /\bhomedir\b|userInfo\(\)\.homedir/)).toEqual([]);
});

// A test that runs git in the checkout it was started from works on the repository the lanes share: a
// `git worktree add`, `repair` or `prune` there rewrote the `gitdir` of another lane's worktree once. A
// test makes a repository of its own (mkdtemp, `git init`) and runs git there. What the checkout is called
// in a test: process.cwd(), import.meta.dir, __dirname, and the ROOT or HERE a file takes from them.
test("no test runs git in the checkout it was started from", () => {
  const here = String.raw`(?:process\.cwd\(\)|import\.meta\.dir(?:name)?|__dirname|import\.meta\.url|\bROOT\b|\bHERE\b|\bREPO_ROOT\b)`;
  // A helper called with the checkout first (git(ROOT, ...), g(HERE, ...)), a cwd or -C naming it, a -C in a shell line.
  const named = new RegExp(String.raw`\b(?:git|g|gitIn|must|raw|sh|run)\(\s*${here}|\bcwd:\s*${here}|["'\`]-C["'\`]\s*,\s*${here}|git -C \$\{${here}`);
  const found = tests.flatMap((f) => textOf(f).split("\n").flatMap((l, i) => (/\bgit\b|["'`]-C["'`]/.test(l) && named.test(l.replace(/\/\/.*$/, "")) ? [`${relative(ROOT, f)}:${i + 1}`] : [])));
  expect(found).toEqual([]);
  // And git spawned with no folder at all runs in the checkout: only for the programs that touch no repository
  // (`--version`, `init <folder>`, `clone` to a folder).
  const bare = tests.flatMap((f) => textOf(f).split("\n").flatMap((l, i) => {
    if (!/(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*\[?\s*["'`]git["'`]/.test(l) || /cwd|"-C"/.test(l)) return [];
    return /["'`](--version|init|clone)["'`]/.test(l) ? [] : [`${relative(ROOT, f)}:${i + 1}`];
  }));
  expect(bare).toEqual([]);
});

// A test that makes a folder with mkdtemp leaves it behind when it forgets it. test/preload.ts points TMPDIR
// at a folder of the run and removes it when the run ends, so a folder made under tmpdir() or $TMPDIR is
// cleaned up. A test file that makes one elsewhere (a named place such as /tmp, or the checkout) removes it
// itself, and so does the preload's own tmp, which this holds in place.
test("a test that calls mkdtemp makes it under the run's TMPDIR or removes it", () => {
  expect(readFileSync(join(ROOT, "test/preload.ts"), "utf8")).toMatch(/TMPDIR: made\("tmp"\)/);
  expect(tmpdir()).toBe(join(dirname(process.env.KEEL_STATE_DIR!), "tmp"));
  const removes = /\b(rmSync|rmdirSync|rm|rmdir|cleanup|tempTree)\(|rm -rf/;
  const found = tests.flatMap((f) => {
    const text = textOf(f);
    if (removes.test(text)) return [];
    // Without a removal, every base is the run's: tmpdir(), $TMPDIR, or a folder the file named from them.
    return text.split("\n").flatMap((l, i) => {
      const call = /\bmkdtemp(?:Sync)?\(\s*(.*)$/.exec(l.replace(/\/\/.*$/, ""));
      if (!call) return [];
      const base = call[1]!.replace(/process\.env\.TMPDIR\s*\?\?\s*(?:"[^"]*"|`[^`]*`|tmpdir\(\))/g, "tmpdir()");
      return /^(?:join\(\s*)?["'`]\//.test(base) || /["'`]\/(?:tmp|var\/tmp|dev\/shm)\b/.test(base) ? [`${relative(ROOT, f)}:${i + 1}`] : [];
    });
  });
  expect(found).toEqual([]);
});

// The run's config and state folders (test/preload.ts) are read by every test file of the run, which shares one
// process. A file that removes one, or leaves the settings tied to a folder it removed, fails the files after it
// (ENOENT on the next settings save), and which files come after depends on the folder's order on the disk.
// A file that needs a folder to remove makes one of its own (tempTree in test/env.ts).
test("a test file removes none of the run's shared folders and puts the settings back", () => {
  // (The sandbox specs remove the TMPDIR they set for one command, which is theirs: they put it back.)
  const removing = /\b(rmSync|rmdirSync|rm|rmdir)\(\s*(join\(\s*)?process\.env\.(KEEL_STATE_DIR|KEEL_CONFIG_DIR|KEEL_IMPORT_\w+|HOME)\b/;
  expect(tests.filter((f) => removing.test(textOf(f))).map((f) => relative(ROOT, f))).toEqual([]);
  expect(tests.filter((f) => leavesSettingsOwn(textOf(f))).map((f) => relative(ROOT, f))).toEqual([]);
});

// The settings file is the last one loaded (src/admin/settings.ts): a file that loads one from a folder of its own
// loads the run's state folder again when it ends, in an afterAll or a finally. A load of the run's folder anywhere
// else (before its own load, in a test) puts nothing back at the end.
const RUN = "process.env.KEEL_STATE_DIR!";
function body(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "(" || text[i] === "{") depth++;
    else if ((text[i] === ")" || text[i] === "}") && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}
function leavesSettingsOwn(text: string): boolean {
  const loads = [...text.matchAll(/\bloadSettings\(([^,)]*)/g)].map((m) => m[1]!.trim());
  if (!loads.some((a) => a !== RUN)) return false;
  const ends = [...text.matchAll(/\bafterAll\(|\bfinally\s*(?=\{)/g)].map((m) => body(text, m.index! + m[0].length - (m[0].endsWith("(") ? 1 : 0)));
  return !ends.some((b) => new RegExp(`\\bloadSettings\\(\\s*${RUN.replace(/[.!]/g, "\\$&")}`).test(b));
}

test("a settings load of the run's folder counts only at the end of the file (afterAll or finally)", () => {
  const own = 'const d = mkdtempSync(x);\nloadSettings(d, () => {});\n';
  // The old skills-peer form: its own folder, nothing put back.
  expect(leavesSettingsOwn(own)).toBe(true);
  // The run's folder loaded first and the file's own after it: the process ends on the file's own.
  expect(leavesSettingsOwn(`loadSettings(${RUN}, () => {});\n${own}`)).toBe(true);
  expect(leavesSettingsOwn(`test("a", () => { loadSettings(${RUN}, () => {}); });\n${own}`)).toBe(true);
  expect(leavesSettingsOwn(`${own}afterAll(() => { loadSettings(${RUN}, () => {}); });\n`)).toBe(false);
  expect(leavesSettingsOwn(`afterAll(async () => { x(); (await import("a")).loadSettings(${RUN}, () => {}); });\n${own}`)).toBe(false);
  expect(leavesSettingsOwn(`try { f(); } finally { loadSettings(${RUN}, () => {}); }\n${own}`)).toBe(false);
  // A file that loads only the run's folder, or none, leaves nothing.
  expect(leavesSettingsOwn(`loadSettings(${RUN}, () => {});`)).toBe(false);
});
