import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A wait on the runner's output matches its last line: every way the script ends prints it.
const script = join(import.meta.dir, "remote-verify.sh");

function run(args: string[], path = process.env.PATH ?? "") {
  const env: Record<string, string> = { PATH: path, HOME: process.env.HOME ?? tmpdir(), TMPDIR: tmpdir() };
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
