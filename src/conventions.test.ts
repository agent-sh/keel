// Conventions that kept breaking across lanes, checked over the source tree.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === "node_modules" ? [] : files(p, ext)) : ext.test(n) ? [p] : [];
  });
}
const offenders = (list: string[], bad: RegExp) => list.filter((f) => bad.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));

test("specs take test from isolate.ts, which restores daemon-wide settings", () => {
  expect(offenders(files(join(ROOT, "test/e2e"), /\.spec\.ts$/), /from "@playwright\/test"/)).toEqual([]);
});

test("byte streams (child pipes, HTTP bodies) are read through src/core/proc.ts", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(".test.ts") && !f.endsWith("core/proc.ts"));
  expect(offenders(src, /new Response\([\w.!]*\.std(out|err)\b/)).toEqual([]);
  // A reader of its own, or `for await` over a stream, releases the reader when
  // the read stops early, which Bun rejects unhandled ("Reader released");
  // chunks() cancels instead.
  expect(offenders(src, /\.getReader\(\)|\.releaseLock\(|for await \(const \w+ of [\w.!]+\.(std(out|err)|body|stream\(\))/)).toEqual([]);
});

test("path containment is contains(root, p) from src/core/paths.ts", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith("core/paths.ts"));
  expect(offenders(src, /(const|function) inside\b/)).toEqual([]);
});

// git runs programs a repository's config names. The daemon runs it through
// src/core/git.ts only, which does not read that config (see the file's head).
test("git is run through src/core/git.ts", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(".test.ts") && !f.endsWith("core/git.ts"));
  // A spawn whose program is git: spawn("git", ...) or spawn(["git", ...]), an
  // argv built apart (["git", ...args], ["git", "-C", ...]), git by its whole
  // path, git in a shell template (Bun's $), and git at the head of a command
  // line handed to a shell.
  expect(offenders(src, /(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*\[?\s*["'`]git[\s"'`]|\[\s*["'`]git["'`]\s*,\s*(\.\.\.|["'`]-)/)).toEqual([]);
  expect(offenders(src, /["'`]\/[\w./-]*\/git["'`]\s*[,\]]|\$`\s*git\s|["'`](ba)?sh["'`]\s*,\s*["'`]-l?c["'`]\s*,\s*["'`]\s*git\s/)).toEqual([]);
  // Shell text of the daemon's own that runs git (a script sent to a machine):
  // the file takes the helper's keys or its view for it.
  const scripts = src.filter((f) => /\$\(git |\$\{GIT\} |^git [a-z-]+ /m.test(readFileSync(f, "utf8")));
  expect(scripts.map((f) => relative(ROOT, f)).sort()).toEqual(["src/fleet/agents.ts", "src/fleet/handoff.ts"]);
  for (const f of scripts) expect([relative(ROOT, f), /\bGIT_SHELL_ENV\b/.test(readFileSync(f, "utf8"))]).toEqual([relative(ROOT, f), true]);
  // gh runs git by itself: every spawn of it gets the helper's environment.
  const gh = src.filter((f) => /["'`]gh["'`]\s*,\s*["'`](pr|repo|auth|api|issue|run|release|workflow)["'`]|KEEL_GH_BIN[^\n]*,\s*["'`](pr|repo|auth|api)["'`]|\[gh,\s*["'`]/.test(readFileSync(f, "utf8")));
  expect(gh.map((f) => relative(ROOT, f)).sort()).toEqual(["src/automation/waits.ts", "src/mcp/connectors.ts", "src/prreview/github.ts", "src/worktree/manager.ts"]);
  for (const f of gh) expect([relative(ROOT, f), /\bgitEnv\(/.test(readFileSync(f, "utf8"))]).toEqual([relative(ROOT, f), true]);
});

// SQLite's locks on the store belong to the process: closing any descriptor
// of keel.db or of its log's index gives every one of them up, and another
// process can then take the log from under the daemon (src/core/store-files.ts).
// So the store's files are opened by SQLite and by storeFd only, and who
// names them is a short list: a file that joins it reads this first.
test("the store's files are named in few places and opened outside SQLite only through storeFd", () => {
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(".test.ts"));
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
    const text = readFileSync(f, "utf8");
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
  const src = files(join(ROOT, "src"), /\.ts$/).filter((f) => !f.endsWith(".test.ts"));
  // (A failure's message is the provider's or the runtime's words, not the session's: it may be said, scrubbed.)
  const bad = /\b(stdout|stderr|summary|blocks)\b|\.(text|input|prompt|note|command|output|outcome|tail)\b/;
  const lines = src.flatMap((f) => {
    const text = readFileSync(f, "utf8");
    if (!/from "[./]*(admin\/)?daemon-log\.ts"/.test(text)) return [];
    return text.split("\n").flatMap((l, i) => (/\bsay(At)?\(/.test(l) && !/^\s*(\/\/|export function say|private say)/.test(l) && bad.test(l.replace(/\/\/.*$/, "")) ? [`${relative(ROOT, f)}:${i + 1}`] : []));
  });
  expect(lines).toEqual([]);
});
