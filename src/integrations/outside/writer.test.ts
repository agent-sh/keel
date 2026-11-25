// Who holds a session, read from scratch records the way each harness keeps them: a Claude Code record of
// a running session (this test's own process stands in for it), a Codex writer lock and an agy presence lock
// held by a scratch process (flock), and the lines of /proc/locks.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyHolder, claudeHolder, claudeKind, codexHolder, codexLock, devParts, lockHolder, parseLocks, statFields } from "./writer.ts";

const top = mkdtempSync(join(tmpdir(), "keel-writer-"));
afterAll(() => rmSync(top, { recursive: true, force: true }));
// What the holder is read from on Linux: /proc (a process's start time) and /proc/locks. Elsewhere those tests
// are skipped by name: every lock reads as free there, and the harness's own refusal is the guard.
const PROC = existsSync("/proc/self/stat");
const LOCKS = existsSync("/proc/locks");

test("lines of /proc/locks: holders, not waiters, with the device and inode", () => {
  const locks = parseLocks([
    "1: FLOCK  ADVISORY  WRITE 1234 fc:00:105142592 0 EOF",
    "1: -> FLOCK  ADVISORY  WRITE 999 fc:00:105142592 0 EOF",
    "2: POSIX  ADVISORY  READ 77 08:01:42 0 EOF",
    "3: OFDLCK ADVISORY  WRITE -1 103:02:9 0 EOF",
    "",
  ].join("\n"));
  expect(locks).toEqual([
    { type: "FLOCK", write: true, pid: 1234, major: 0xfc, minor: 0, inode: 105142592 },
    { type: "POSIX", write: false, pid: 77, major: 8, minor: 1, inode: 42 },
    { type: "OFDLCK", write: true, pid: -1, major: 0x103, minor: 2, inode: 9 },
  ]);
  expect(devParts(64512)).toEqual({ major: 252, minor: 0 });
  expect(devParts(0x10302)).toEqual({ major: 0x103, minor: 2 });
});

test("a process's start time is field 22, counted after a name with spaces and parentheses", () => {
  const line = "4242 (tmux: server (x)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10 18446744073709551615";
  expect(statFields(line)).toEqual({ state: "S", start: "987654" });
  expect(statFields("no name")).toBeUndefined();
});

test.skipIf(!PROC)("Claude Code: the live process whose record names the session, of the kind it says", () => {
  const dir = join(top, "claude-sessions");
  mkdirSync(dir, { recursive: true });
  const me = statFields(readFileSync(`/proc/${process.pid}/stat`, "utf8"))!;
  // A record of this test's own process: alive, started when it says.
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "s-live", procStart: me.start, kind: "interactive", entrypoint: "cli", status: "busy" }));
  // A pid that is not running, and a record whose process start differs (its pid taken again by another program).
  writeFileSync(join(dir, "2147483600.json"), JSON.stringify({ sessionId: "s-gone", kind: "interactive" }));
  writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ sessionId: "s-reused", procStart: "1", kind: "interactive" }));
  writeFileSync(join(dir, "notes.txt"), "not a record");
  expect(claudeHolder(dir, "s-live")).toEqual({ kind: "terminal", pid: process.pid });
  expect(claudeHolder(dir, "s-gone")).toEqual({ kind: "free" });
  expect(claudeHolder(dir, "s-reused")).toEqual({ kind: "free" });
  expect(claudeHolder(dir, "s-none")).toEqual({ kind: "free" });
  expect(claudeHolder(join(top, "no-such-folder"), "s-live")).toEqual({ kind: "free" });
  expect([claudeKind({ kind: "bg" }), claudeKind({ kind: "daemon-worker" }), claudeKind({ kind: "interactive", entrypoint: "claude-desktop" }), claudeKind({ kind: "interactive", entrypoint: "claude-vscode" }), claudeKind({ kind: "interactive", entrypoint: "sdk-cli" }), claudeKind({ kind: "interactive", entrypoint: "cli" })])
    .toEqual(["background", "background", "desktop", "editor", "process", "terminal"]);
});

const flock = Bun.which("flock");
test.skipIf(!flock || !LOCKS)("Codex and agy: the holder of the lock file's write lock, read and never taken", async () => {
  const home = join(top, "codex");
  mkdirSync(join(home, "thread-writer-locks"), { recursive: true });
  const lock = codexLock(home, "t-1");
  writeFileSync(lock, "");
  const agy = join(top, "agy");
  mkdirSync(join(agy, "presence"), { recursive: true });
  writeFileSync(join(agy, "presence", "c-1.lock"), "");
  expect(codexHolder(home, "t-1")).toEqual({ kind: "free" });
  // A process that holds the lock as Codex does (flock -x) and is no terminal's.
  const held = Bun.spawn([flock!, "-x", "-o", lock, "sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const heldAgy = Bun.spawn([flock!, "-x", "-o", join(agy, "presence", "c-1.lock"), "sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const end = Date.now() + 5000;
    while (codexHolder(home, "t-1").kind === "free" && Date.now() < end) await Bun.sleep(20);
    expect(codexHolder(home, "t-1")).toEqual({ kind: "process", pid: held.pid });
    while (agyHolder(agy, "c-1").kind === "free" && Date.now() < end) await Bun.sleep(20);
    expect(agyHolder(agy, "c-1")).toEqual({ kind: "process", pid: heldAgy.pid });
    // The holder is read from /proc/locks: nothing here took the lock (a second holder would have waited).
    expect(lockHolder(lock, parseLocks(readFileSync("/proc/locks", "utf8")))).toBe(held.pid);
    expect(codexHolder(home, "t-other")).toEqual({ kind: "free" });
  } finally {
    held.kill();
    heldAgy.kill();
    await Promise.all([held.exited, heldAgy.exited]);
  }
  expect(codexHolder(home, "t-1")).toEqual({ kind: "free" });
});
