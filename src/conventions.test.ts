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
  expect(gh.map((f) => relative(ROOT, f)).sort()).toEqual(["src/automation/waits.ts", "src/mcp/connectors.ts", "src/worktree/manager.ts"]);
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
    "src/core/checkpoint-worker.ts", // the log's kept descriptor, to sync it
    "src/core/checkpoint.ts",       // the index's kept descriptor, to read how many frames wait
    "src/core/store-files.ts",
  ]);
  // No call of node:fs or Bun.file that opens a file is given one of their paths.
  const opens = /\b(openSync|open|readFileSync|readFile|createReadStream|copyFileSync|copyFile|Bun\.file)\([^\n]*(["'`]keel\.db["'`]|keel\.db-(wal|shm)|-(wal|shm)[`"']|storePath\()/;
  expect(offenders(src.filter((f) => !f.endsWith("core/store-files.ts")), opens)).toEqual([]);
});
