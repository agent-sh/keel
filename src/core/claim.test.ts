// The claim on a state folder is a kernel lock another process cannot see
// from a page: whether a second process gets the folder is asked of a child.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "../tools/files.ts";
import { claimState, isClaimFile } from "./claim.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keel-claim-")); dirs.push(d); return d; };

// A second process on the folder: what it prints, and how it ends.
function child(code: string) {
  const p = Bun.spawnSync(["bun", "-e", code], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
const claimIn = (dir: string) => child(`import { claimState } from "./src/core/claim.ts"; console.log(claimState(${JSON.stringify(dir)}) ? "got it" : "held");`);
const startIn = (dir: string) => child(`import { acquireLock } from "./src/admin/daemon.ts"; acquireLock(${JSON.stringify(dir)}); console.log("owns");`);

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
