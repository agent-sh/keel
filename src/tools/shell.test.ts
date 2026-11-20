import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { startJob } from "./jobs.ts";

// A spawn into a folder that is not there fails as ENOENT of the program
// (`posix_spawn 'systemd-run'`), which reads as a missing sandbox. The shell
// tools name the folder instead, as a result of the call and not a failure.
test("a command whose working directory is gone says so and runs nothing", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "shell-"));
  mkdirSync(join(root, "worktree"));
  const ctx = (id: string): any => ({ sessionId: id, cwd: root, spillDir: join(root, "spill", id), signal: new AbortController().signal, seen: new Map() });
  const gone = join(root, "worktre");

  const exec = gptTools.find((t) => t.name === "exec_command")!;
  const a = await exec.run({ cmd: "echo ran", workdir: gone }, ctx("gpt"));
  expect(a.is_error).toBe(true);
  expect(a.content).toContain(`Directory does not exist: ${gone}`);
  expect(a.content).toContain(join(root, "worktree"));   // the near name
  expect(a.content).toContain("Nothing ran");
  expect(a.content).not.toContain("posix_spawn");

  const shell = geminiTools.find((t) => t.name === "run_shell_command")!;
  const b = await shell.run({ command: "echo ran", dir_path: gone }, ctx("gemini"));
  expect(b.is_error).toBe(true);
  expect(b.content).toContain(`Directory does not exist: ${gone}`);

  // A folder the shell moved into and that was removed since: the call says
  // so and the shell is back in the session's folder for the next one.
  const bash = claudeTools.find((t) => t.name === "Bash")!;
  const c = ctx("claude");
  expect((await bash.run({ command: "cd worktree && pwd" }, c)).content).toContain(join(root, "worktree"));
  rmSync(join(root, "worktree"), { recursive: true });
  const d = await bash.run({ command: "pwd" }, c);
  expect(d.is_error).toBe(true);
  expect(d.content).toContain(`Directory does not exist: ${join(root, "worktree")}`);
  expect(d.content).toContain(`Shell cwd was reset to ${root}`);
  const e = await bash.run({ command: "pwd" }, c);
  expect(e.is_error).toBeFalsy();
  expect(e.content).toContain(root);

  // Any other caller of a job gets the folder named too.
  expect(() => startJob({ sessionId: "owner", command: "true", cwd: gone, logDir: join(root, "spill/owner/jobs") })).toThrow(gone);
});
