// What a command Keel starts is given for its temporary folder: `bun install` leaves a probe file in it on every
// run, and with none named it is the machine's /tmp.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { runCommand } from "../checks/before-run.ts";
import { toolEnv } from "../tools/jobs.ts";
import { setOwnTemp, tempEnv } from "./temp.ts";

test("an environment that names no temporary folder gets the daemon's; one that names one is left as it is", () => {
  const mine = join(tmpdir(), "own-temp-check");
  ownEnv({ TMPDIR: mine, BUN_TMPDIR: undefined });
  expect(tempEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin", TMPDIR: mine });
  expect(tempEnv({ TMPDIR: "/scratch/t" }).TMPDIR).toBe("/scratch/t");
  expect(tempEnv({ BUN_TMPDIR: "/scratch/b" })).toEqual({ BUN_TMPDIR: "/scratch/b" });
  expect(tempEnv({ TMPDIR: "" }).TMPDIR).toBe(mine);
});

test("a daemon with no TMPDIR of its own uses a folder under its state folder, made when it is first wanted", () => {
  const state = mkdtempSync(join(tmpdir(), "own-temp-state-"));
  ownEnv({ TMPDIR: undefined, BUN_TMPDIR: undefined });
  setOwnTemp(state);
  const env = tempEnv({});
  expect(env.TMPDIR).toBe(join(state, "tmp"));
  expect(existsSync(env.TMPDIR!)).toBe(true);
  expect(toolEnv("s1").TMPDIR).toBe(join(state, "tmp"));
});

test("a command run with an empty environment sees the temporary folder", async () => {
  const tool = mkdtempSync(join(tmpdir(), "own-temp-run-"));
  const mine = join(tmpdir(), "own-temp-run-t");
  ownEnv({ TMPDIR: mine, BUN_TMPDIR: undefined });
  const r = await runCommand({ cwd: tool, tool, env: { PATH: process.env.PATH! }, command: 'echo "tmp=$TMPDIR"', limitMs: 20_000, unit: "keel-temp-test", wrap: (a) => a });
  expect("error" in r ? r.error : r.out).toContain(`tmp=${mine}`);
});
