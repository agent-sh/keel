import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A wait on the runner's output matches its last line: every way the script ends prints it.
const script = join(import.meta.dir, "remote-verify.sh");

function run(args: string[], path = process.env.PATH ?? "") {
  // (The clone's own keel.verifyHost is set to nothing: a committed tree would otherwise start a real run there.)
  const env: Record<string, string> = { PATH: path, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir(), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "keel.verifyhost", GIT_CONFIG_VALUE_0: "" };
  const p = Bun.spawnSync(["bash", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trimEnd().split("\n");
  return { code: p.exitCode, last: out.at(-1) ?? "" };
}

test("a refusal ends with the outcome line", () => {
  expect(run([])).toEqual({ code: 2, last: "remote-verify: Summary: not run: refused (the reason is above) (exit 2)" });
  expect(run(["--host", "x", "--wait", "soon"])).toEqual({ code: 2, last: "remote-verify: Summary: not run: refused (the reason is above) (exit 2)" });
});

test("a host that cannot be reached ends with the outcome line", () => {
  const bin = mkdtempSync(join(tmpdir(), "rv-ssh-"));
  try {
    writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 255\n");
    chmodSync(join(bin, "ssh"), 0o755);
    const r = run(["--host", "nowhere", "HEAD"], `${bin}:${process.env.PATH}`);
    expect(r).toEqual({ code: 2, last: "remote-verify: Summary: not run: refused (the reason is above) (exit 2)" });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("help is not a run", () => {
  const h = run(["--help"]);
  expect(h.code).toBe(0);
  expect(h.last.startsWith("remote-verify: Summary:")).toBe(false);
});

// The far side's place, run here with a home of its own: the one place other runs take is held.
test("a landing queue's run takes the place kept for it while every other place is held; another run gives up", async () => {
  const home = mkdtempSync(join(tmpdir(), "rv-place-"));
  const locks = join(home, "v", "locks");
  // Holds place-1 until its standard input closes.
  const held = Bun.spawn(["bash", "-c", `mkdir -p '${locks}' && exec 9> '${locks}/place-1' && flock -n 9 && echo held && read -r _`], { stdin: "pipe", stdout: "pipe" });
  try {
    const reader = held.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
    const far = (land: string) => {
      const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), KEEL_VERIFY_MAX_RUNS: "1", KEEL_VERIFY_MAX_LOAD: "0", KEEL_VERIFY_LAND: land };
      const p = Bun.spawnSync(["bash", script, "__remote", "v", "r1", "0".repeat(40), "0", "", "0"], { env, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stdout.toString() };
    };
    // Another run: no place, not started.
    const other = far("0");
    expect(other.code).toBe(3);
    expect(other.out).toContain("no free place on this host");
    // The landing's run: its own place, and a load over the line does not refuse it (it goes on to the checkout,
    // which fails here: there is no repository).
    const landing = far("1");
    expect(landing.out).toContain("could not check out");
    expect(landing.out).not.toContain("not started");
    expect(existsSync(join(locks, "place-land"))).toBe(true);
  } finally {
    held.stdin.end();
    held.kill();
    rmSync(home, { recursive: true, force: true });
  }
});
