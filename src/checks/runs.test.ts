// What a command exports is read from the environment the session's commands get, not the daemon's.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { registerEnvDrop } from "../tools/jobs.ts";
import { checksIn } from "./runs.ts";

ownEnv({ KEEL_T_DROPPED: "daemon" });
const undrop = registerEnvDrop("runs-test", (id) => (id === "s-runs" ? ["KEEL_T_DROPPED"] : []));
afterAll(undrop);

test("an assignment exports a variable only when the session's commands have it", () => {
  const repo = mkdtempSync(join(tmpdir(), "keel-runs-"));
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "bun test", args: true } } }));
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  // (The daemon has it; this session's commands do not: a plain assignment stays the shell's.)
  expect(checksIn(repo, "KEEL_T_DROPPED=1; bun test", "s-runs")?.matches[0]?.command).toBe("bun test");
  expect(checksIn(repo, "KEEL_T_DROPPED=1; bun test", "s-other")?.matches[0]?.command).toBe("KEEL_T_DROPPED=1 bun test");
});
