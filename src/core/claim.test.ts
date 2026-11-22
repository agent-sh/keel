// The claim on a state folder is a kernel lock another process cannot see
// from a page: whether a second process gets the folder is asked of a child.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../tools/files.ts";
import { claimState, isClaimFile } from "./claim.ts";
import { pidState, readStat } from "./pid.ts";

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
const startIn = (dir: string, env?: Record<string, string>) => child(`import { acquireLock } from "./src/admin/daemon.ts"; acquireLock(${JSON.stringify(dir)}); console.log("owns");`, env);

test("the daemon's own Read does not open its claim file, so the claim holds", async () => {
  const dir = scratch();
  const claim = claimState(dir)!;
  try {
    expect(claimIn(dir).out).toBe("held");
    // By its name and through a link to it.
    const link = join(scratch(), "notes.txt");
    symlinkSync(join(dir, "daemon.claim"), link);
    for (const p of [join(dir, "daemon.claim"), link]) {
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

const unix = process.platform === "linux" || process.platform === "darwin";
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25); return ok(); };

// A process that has ended and stays as a zombie: its parent (a sleep) never reads its end.
async function zombie() {
  const parent = Bun.spawn(["sh", "-c", "true & echo $!; exec sleep 60"], { stdout: "pipe", stderr: "ignore" });
  const pid = Number(new TextDecoder().decode((await parent.stdout.getReader().read()).value).trim());
  return { pid, parent };
}

test.skipIf(!unix)("a daemon that has ended is replaced while its pid is still there, and a restart does not wait for it", async () => {
  const dir = scratch();
  const z = await zombie();
  try {
    expect(await until(() => pidState(z.pid) === "ended")).toBe(true);
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
// last threads leave the kernel, held here for a second and a half.
const LEAVING = `
import ctypes, os, sys, threading, time
def rest():
    time.sleep(1.5)
    os._exit(0)
threading.Thread(target=rest).start()
print(os.getpid(), flush=True)
ctypes.CDLL(None).pthread_exit(None)
`;
test.skipIf(process.platform !== "linux" || !Bun.which("python3"))("a start waits for a daemon that is leaving, and then has its folder", async () => {
  const dir = scratch();
  const p = Bun.spawn(["python3", "-c", LEAVING], { stdout: "pipe", stderr: "ignore" });
  try {
    const pid = Number(new TextDecoder().decode((await p.stdout.getReader().read()).value).trim());
    expect(await until(() => pidState(pid) === "leaving")).toBe(true);
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid, url: "http://127.0.0.1:1" }));
    // Refused at once, before: the pid is there. Now the start is there when the process has left.
    const second = startIn(dir);
    expect(second).toMatchObject({ code: 0, out: "owns" });
    await p.exited;
    expect(pidState(pid)).toBe("gone");
  } finally {
    p.kill("SIGKILL");
  }
}, 60_000);

test("a pid's state is read from its stat line: a zombie has ended, one with threads left or on its way out is leaving", () => {
  const line = (state: string, flags: number, threads: number) => `4242 (a (odd) name) ${state} 1 4242 4242 0 -1 ${flags} 0 0 0 0 0 0 0 0 20 0 ${threads} 0 100 0 0`;
  expect([line("S", 0x400000, 12), line("R", 0x400004, 12), line("Z", 0x40004c, 3), line("Z", 0x40004c, 1), line("X", 0, 0)].map(readStat)).toEqual(["live", "leaving", "leaving", "ended", "ended"]);
  expect([pidState(process.pid), pidState(Bun.spawnSync(["true"]).pid), pidState(0)]).toEqual(["live", "gone", "gone"]);
});
