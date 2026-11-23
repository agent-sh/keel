// The claim on a state folder is a kernel lock another process cannot see
// from a page: whether a second process gets the folder is asked of a child.
import { afterAll, expect, test } from "bun:test";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../tools/files.ts";
import { claimState, isClaimFile } from "./claim.ts";
import { pidBorn, pidState, readStat } from "./pid.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keel-claim-")); dirs.push(d); return d; };

// A second process on the folder: what it prints, and how it ends.
function child(code: string, env: Record<string, string> = {}) {
  const t0 = Date.now();
  const p = Bun.spawnSync(["bun", "-e", code], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim(), ms: Date.now() - t0 };
}
const claimIn = (dir: string) => child(`import { claimState } from "./src/core/claim.ts"; console.log(claimState(${JSON.stringify(dir)}) ? "got it" : "held");`);
const startIn = (dir: string, env?: Record<string, string>, goingMs?: number) => child(`import { acquireLock } from "./src/admin/daemon.ts"; acquireLock(${JSON.stringify(dir)}${goingMs ? `, ${goingMs}` : ""}); console.log("owns");`, env);

test("the daemon's own Read does not open its claim file, so the claim holds", async () => {
  const dir = scratch();
  const claim = claimState(dir)!;
  try {
    expect(claimIn(dir).out).toBe("held");
    // By its name, through a link to it, and as the same file under another name (a hard link).
    const link = join(scratch(), "notes.txt");
    symlinkSync(join(dir, "daemon.claim"), link);
    const hard = join(dir, "..", `hard-${Date.now()}.txt`);
    linkSync(join(dir, "daemon.claim"), hard);
    for (const p of [join(dir, "daemon.claim"), link, hard]) {
      expect(isClaimFile(p)).toBe(true);
      const r = await readFile(p, { cwd: dir, seen: new Map() } as any);
      expect(r).toMatchObject({ error: true });
      expect(String(r.content)).toContain("is not opened from inside the daemon");
    }
    expect(claimIn(dir).out).toBe("held");
    // Another folder's file of that name is a file like any other.
    expect(isClaimFile(join(scratch(), "daemon.claim"))).toBe(false);
  } finally {
    claim.release();
  }
  expect(claimIn(dir).out).toBe("got it");
});

test("a live daemon named in the lock file is not replaced, with or without its claim", () => {
  const dir = scratch();
  // This process stands for a daemon whose claim was lost: alive, named in the lock file, no kernel lock.
  writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: process.pid, url: "http://127.0.0.1:1", claim: true }));
  const second = startIn(dir);
  expect(second).toMatchObject({ code: 1, out: "" });
  expect(second.err).toContain(`another daemon (pid ${process.pid}, http://127.0.0.1:1) uses ${dir}`);
  // One that died is replaced.
  const dead = Bun.spawnSync(["true"]).pid;
  writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: dead }));
  expect(startIn(dir)).toMatchObject({ code: 0, out: "owns" });
});

test.skipIf(process.platform !== "linux")("a pid that went to another process since the lock was written is not the daemon the lock names", () => {
  const dir = scratch();
  // The lock says when its daemon was born. This process is that daemon: refused.
  writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: process.pid, born: pidBorn(process.pid), url: "http://127.0.0.1:1" }));
  expect(startIn(dir)).toMatchObject({ code: 1, err: expect.stringContaining(`another daemon (pid ${process.pid}, http://127.0.0.1:1) uses ${dir}`) });
  // The same pid, born at another time or in another boot: the daemon crashed and its pid names something else now.
  for (const born of [pidBorn(process.pid)!.replace(/\d+$/, (t) => String(Number(t) + 1)), `another-boot:${pidBorn(process.pid)!.split(":")[1]}`]) {
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: process.pid, born, url: "http://127.0.0.1:1" }));
    const second = startIn(dir);
    expect(second).toMatchObject({ code: 0, out: "owns" });
  }
  // A start writes when it was born itself.
  const own = child(`import { acquireLock } from "./src/admin/daemon.ts"; import { pidBorn } from "./src/core/pid.ts"; import { readFileSync } from "node:fs"; acquireLock(${JSON.stringify(dir)}); const l = JSON.parse(readFileSync(${JSON.stringify(join(dir, "daemon.lock"))}, "utf8")); console.log(l.pid === process.pid && l.born === pidBorn(process.pid) ? "named" : JSON.stringify(l));`);
  expect(own).toMatchObject({ code: 0, out: "named" });
});

test("the daemon a restart handed the folder to gets its claim when a start by hand took it a moment before", async () => {
  const dir = scratch();
  // This process stands for the start by hand: it has the claim, and gives it up when it has read the lock.
  const hand = claimState(dir)!;
  const lock = JSON.stringify(join(dir, "daemon.lock"));
  const successor = Bun.spawn(["bun", "-e", `import { acquireLock } from "./src/admin/daemon.ts"; import { writeFileSync } from "node:fs"; writeFileSync(${lock}, JSON.stringify({ pid: process.pid })); console.log("named"); acquireLock(${JSON.stringify(dir)}); console.log("owns");`],
    { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  const reader = successor.stdout.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    while (!out.includes("named")) { const r = await reader.read(); if (r.done) break; out += dec.decode(r.value); }
    await Bun.sleep(300);
  } finally {
    hand.release();
  }
  for (;;) { const r = await reader.read(); if (r.done) break; out += dec.decode(r.value); }
  expect([await successor.exited, out.trim().split("\n"), await new Response(successor.stderr).text()]).toEqual([0, ["named", "owns"], ""]);
}, 30_000);

const linux = process.platform === "linux";
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25); return ok(); };

// A process that has ended and stays as a zombie: its parent (a sleep) never reads its end.
// The shell prints the child's pid before the child has run, and a loaded machine may not run it for
// seconds: the zombie is handed over once it is one, however long that takes. A shell that read the
// child's end itself before it became the sleep leaves no zombie (the pid is gone): it is made again.
async function zombie(withinMs = 60_000) {
  const end = Date.now() + withinMs;
  for (;;) {
    const parent = Bun.spawn(["sh", "-c", "true & echo $!; exec sleep 60"], { stdout: "pipe", stderr: "ignore" });
    const pid = Number(new TextDecoder().decode((await parent.stdout.getReader().read()).value).trim());
    let state = pidState(pid);
    while (state !== "ended" && state !== "gone" && Date.now() < end) { await Bun.sleep(25); state = pidState(pid); }
    if (state === "ended") return { pid, parent };
    parent.kill("SIGKILL");
    if (Date.now() >= end) throw new Error(`no zombie within ${withinMs} ms: the child was ${state}`);
  }
}

test.skipIf(!linux)("a daemon that has ended is replaced while its pid is still there, and a restart does not wait for it", async () => {
  const dir = scratch();
  const z = await zombie();
  try {
    expect(pidState(z.pid)).toBe("ended");
    // Signal 0 still finds it: it is there, and it is no daemon.
    expect(() => process.kill(z.pid, 0)).not.toThrow();
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: z.pid, url: "http://127.0.0.1:1" }));
    expect(startIn(dir)).toMatchObject({ code: 0, out: "owns" });
    // A restart names the daemon before it: one that has ended is not waited for (a minute, before).
    const after = startIn(scratch(), { KEEL_WAIT_FOR_PID: String(z.pid) });
    expect(after).toMatchObject({ code: 0, out: "owns" });
    expect(after.ms).toBeLessThan(15_000);
  } finally {
    z.parent.kill("SIGKILL");
  }
}, 90_000);

// A process whose first thread has ended while another still runs: what a killed daemon is while its
// last threads leave the kernel, held here for as long as the test says. The worker writes a beat while it runs.
const leaving = (seconds: number, beat: string) => `
import ctypes, os, sys, threading, time
def rest():
    until = time.time() + ${seconds}
    while time.time() < until:
        open(${JSON.stringify(beat)}, "a").write("beat\\n")
        time.sleep(0.1)
    os._exit(0)
threading.Thread(target=rest).start()
print(os.getpid(), flush=True)
ctypes.CDLL(None).pthread_exit(None)
`;
const python = linux && !!Bun.which("python3");
const beats = (file: string) => { try { return readFileSync(file, "utf8").split("\n").length - 1; } catch { return 0; } };

test.skipIf(!python)("a start waits for a daemon that is leaving, says so, and then has its folder", async () => {
  const dir = scratch();
  const p = Bun.spawn(["python3", "-c", leaving(1.5, join(dir, "beat"))], { stdout: "pipe", stderr: "ignore" });
  try {
    const pid = Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());
    expect(await until(() => pidState(pid) === "leaving")).toBe(true);
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid, url: "http://127.0.0.1:1" }));
    // Refused at once, before: the pid is there. Now the start is there when the process has left.
    const second = startIn(dir);
    expect(second).toMatchObject({ code: 0, out: "owns" });
    expect(second.err).toMatch(new RegExp(`^keel: waiting for the daemon before this one \\(pid ${pid}\\) to go, up to \\d+ s more$`));
    await p.exited;
    expect(pidState(pid)).toBe("gone");
  } finally {
    p.kill("SIGKILL");
  }
}, 60_000);

test.skipIf(!python)("a process that is still leaving when the wait is over keeps the folder: its worker still runs", async () => {
  const dir = scratch();
  const beat = join(dir, "beat");
  const p = Bun.spawn(["python3", "-c", leaving(40, beat)], { stdout: "pipe", stderr: "ignore" });
  try {
    const pid = Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());
    expect(await until(() => pidState(pid) === "leaving" && beats(beat) > 0)).toBe(true);
    // It holds no claim (lost, or never taken): the lock is all that names it.
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid, url: "http://127.0.0.1:1" }));
    // One time for the whole start, however many of its steps wait: a restart's daemon before it, then the lock's.
    const second = startIn(dir, { KEEL_WAIT_FOR_PID: String(pid) }, 2500);
    expect(second).toMatchObject({ code: 1, out: "" });
    expect(second.err.split("\n")).toEqual([
      expect.stringMatching(new RegExp(`^keel: waiting for the daemon before this one \\(pid ${pid}\\) to go, up to \\d+ s more$`)),
      `keel: another daemon (pid ${pid}, http://127.0.0.1:1) uses ${dir}`,
    ]);
    expect(second.ms).toBeLessThan(4500);
    expect(JSON.parse(readFileSync(join(dir, "daemon.lock"), "utf8")).pid).toBe(pid);
    const then = beats(beat);
    expect(await until(() => beats(beat) > then)).toBe(true);
  } finally {
    p.kill("SIGKILL");
  }
}, 60_000);

test("a pid's state is read from its stat line: a zombie has ended, one with threads left or on its way out is leaving", () => {
  const line = (state: string, flags: number, threads: number) => `4242 (a (odd) name) ${state} 1 4242 4242 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 ${threads} 0 100 0 0`;
  expect([line("S", 0x400000, 12), line("R", 0x400004, 12), line("Z", 0x40004c, 3), line("Z", 0x40004c, 1), line("X", 0, 0)].map(readStat)).toEqual(["live", "leaving", "leaving", "ended", "ended"]);
  expect([pidState(process.pid), pidState(Bun.spawnSync(["true"]).pid), pidState(0)]).toEqual(["live", "gone", "gone"]);
});
