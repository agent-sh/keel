import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTools } from "./claude.ts";
import { geminiTools } from "./gemini.ts";
import { gptTools } from "./gpt.ts";
import { startJob } from "./jobs.ts";

test("a missing workdir names the existing directory with the same path ending", async () => {
  const home = mkdtempSync(join(process.env.TMPDIR ?? ".", "workdir-home-"));
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const cwd = join(home, "projects", "example");
    const oldRoot = join(home, ".local", "share", "engine");
    const tail = "engine-work/build/research";
    const right = join(home, ".cache", tail);
    const notADirectory = join(home, ".config", tail);
    for (const dir of [cwd, oldRoot, right, join(notADirectory, "..")]) mkdirSync(dir, { recursive: true });
    writeFileSync(notADirectory, "");
    const exec = gptTools.find((t) => t.name === "exec_command")!;
    const ctx = { sessionId: "gpt-moved-workdir", cwd, spillDir: join(home, "spill"), signal: new AbortController().signal, seen: new Map() };
    const miss = await exec.run({ cmd: "echo ran", workdir: join(oldRoot, tail) }, ctx);
    expect(miss.is_error).toBe(true);
    expect(String(miss.content).split("Did you mean one of these?\n")[1]?.split("\n")[0]).toBe(right);
    expect(miss.content).not.toContain(notADirectory);
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    rmSync(home, { recursive: true });
  }
});

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

  // A path copied from text where a secret was replaced: the placeholder is the reason.
  const mark = "[secret:" + "0a1b2c3d]";
  const p = await exec.run({ cmd: "echo ran", workdir: join(root, mark, "worktree") }, ctx("gpt"));
  expect(p.is_error).toBe(true);
  expect(p.content).toContain(`${mark} in this path is a secret's placeholder`);

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

// The trap that records where a command ended names a file under the state
// folder, which can hold any character: it is quoted for the trap's own words.
test("the shell's folder is tracked under a state folder of any name", async () => {
  const base = mkdtempSync(join(process.env.TMPDIR ?? ".", "shell-"));
  const root = join(base, `st ate'q"d$HOME`);
  mkdirSync(join(root, "work", "sub"), { recursive: true });
  const ctx: any = { sessionId: "odd", cwd: join(root, "work"), spillDir: join(root, "spill"), signal: new AbortController().signal, seen: new Map() };
  const bash = claudeTools.find((t) => t.name === "Bash")!;
  const a = await bash.run({ command: "cd sub && echo moved" }, ctx);
  expect(a.is_error).toBeFalsy();
  expect(a.content).not.toContain("trap");
  expect(a.content).not.toContain("invalid signal");
  const b = await bash.run({ command: "pwd" }, ctx);
  expect(b.content).toContain(join(root, "work", "sub"));
  rmSync(base, { recursive: true });
});

// A file the session printed whole or made with its own command is one it knows: Write replaces it at once.
test("Write replaces at once a file a Bash command printed whole or made", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "shell-"));
  const ctx: any = { sessionId: "seen", cwd: root, spillDir: join(root, "spill"), signal: new AbortController().signal, seen: new Map() };
  const bash = claudeTools.find((t) => t.name === "Bash")!, write = claudeTools.find((t) => t.name === "Write")!;
  writeFileSync(join(root, "read.txt"), "one\ntwo\n");
  await bash.run({ command: "cat read.txt" }, ctx);
  await bash.run({ command: "printf made > made.txt" }, ctx);
  for (const name of ["read.txt", "made.txt"]) {
    const w = await write.run({ file_path: join(root, name), content: "new\n" }, ctx);
    expect(w.is_error).toBeFalsy();
    expect(readFileSync(join(root, name), "utf8")).toBe("new\n");
  }
  writeFileSync(join(root, "unseen.txt"), "x\n");
  const w = await write.run({ file_path: join(root, "unseen.txt"), content: "new\n" }, ctx);
  expect(JSON.stringify(w.content)).toContain("was not read in this session");
});
