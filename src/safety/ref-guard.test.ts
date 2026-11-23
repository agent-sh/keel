// The guard an agent's commands carry, on a real repository: the main checkout (on main), the agent's worktree
// (keel/x, made from main) and another agent's (keel/y). git is started the way any program the agent runs starts
// it, with the environment the gate gives the command.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { checkoutsOf } from "./refwatch.ts";
import { guardEnv, hooksPathIn, refGuardRoot } from "./ref-guard.ts";
import { confine, sandboxStatus, splitScope } from "./sandbox.ts";

const hasGit = !!Bun.which("git");
// git runs the hook for a symbolic ref's update from 2.46 on, the release that made such updates part of a ref
// transaction (Documentation/RelNotes/2.46.0); an older git moves one without it.
const gitVersion = hasGit ? (/(\d+)\.(\d+)/.exec(Bun.spawnSync(["git", "--version"]).stdout.toString()) ?? []).slice(1).map(Number) : [];
const symrefs = gitVersion.length === 2 && (gitVersion[0]! > 2 || (gitVersion[0] === 2 && gitVersion[1]! >= 46));

test("core.hooksPath is read from a config file as git reads it", () => {
  expect(hooksPathIn("[core]\n\tbare = false\n\thooksPath = .husky/_\n")).toBe(".husky/_");
  expect(hooksPathIn('[core]\n  HooksPath = "/a b/c" # note\n[core "x"]\n\thooksPath = no\n')).toBe("/a b/c");
  expect(hooksPathIn("[user]\n\thooksPath = no\n")).toBeUndefined();
  expect(hooksPathIn("[core] hooksPath = one\n[core]\nhooksPath = two\n")).toBe("two");
});

test.skipIf(!hasGit)("a git an agent's command starts moves no branch its worktree shares, and runs the repository's own hooks", () => {
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "guard-")));
  const base = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = (cwd: string, env: Record<string, string>, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd, env: { ...base, ...env } });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const git = (cwd: string, ...a: string[]) => { const r = run(cwd, {}, "git", "-c", "init.defaultBranch=main", ...a); if (r.code !== 0) throw new Error(r.err); return r.out.trim(); };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), other = join(dir, "other"), elsewhere = join(dir, "elsewhere");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    // The repository's own hook, which finds its helper beside itself ($0), as husky's do.
    mkdirSync(join(main, ".hooks"));
    writeFileSync(join(main, ".hooks", "helper"), "echo ran >> \"$(dirname \"$0\")/../hook.log\"\n");
    writeFileSync(join(main, ".hooks", "post-commit"), "#!/bin/sh\n. \"$(dirname \"$0\")/helper\"\n", { mode: 0o755 });
    git(main, "config", "core.hooksPath", join(main, ".hooks"));
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    git(main, "worktree", "add", "-q", "-b", "keel/y", other);
    git(main, "branch", "base-only");
    git(dir, "init", "-q", elsewhere);
    git(elsewhere, "commit", "-q", "--allow-empty", "-m", "e");
    const s = checkoutsOf(agent, "keel/x", "main")!;
    const env = guardEnv(s, base);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    const mainAt = git(main, "rev-parse", "main"), yAt = git(main, "rev-parse", "keel/y");
    const sh = (cwd: string, line: string) => run(cwd, env, "sh", "-c", line);
    writeFileSync(join(agent, "b"), "b\n");
    // Its own work: a commit (the repository's hook runs, from its own folder), a branch of its own, a reset.
    expect(sh(agent, "git add b && git commit -qm b && git branch keel/x-2 && git reset -q --hard HEAD").code).toBe(0);
    expect(readFileSync(join(main, "hook.log"), "utf8")).toBe("ran\n");
    // What the gate cannot read: a script, a program, fast-import, a symbolic ref.
    const refused: [string, string][] = [
      [agent, "git update-ref refs/heads/main HEAD"],
      [agent, "python3 -c 'import subprocess,sys; sys.exit(subprocess.run([\"git\",\"update-ref\",\"refs/heads/keel/y\",\"HEAD\"]).returncode)'"],
      [agent, "printf 'reset refs/heads/main\\nfrom %s\\n\\n' $(git rev-parse HEAD) | git fast-import --quiet"],
      [agent, "git update-ref -d refs/heads/keel/y"],
      ...(symrefs ? [[agent, "git symbolic-ref refs/heads/main refs/heads/keel/x"], [agent, "git symbolic-ref HEAD refs/heads/main"], [agent, `git -C ${main} symbolic-ref HEAD refs/heads/keel/x`]] as [string, string][] : []),
    ];
    for (const [cwd, line] of refused) {
      const r = sh(cwd, line);
      expect([line, r.code !== 0, r.err.includes("Refused by Keel") && r.err.includes("keel__landing_queue")]).toEqual([line, true, true]);
    }
    expect([git(main, "rev-parse", "main"), git(main, "rev-parse", "keel/y"), git(main, "symbolic-ref", "HEAD")]).toEqual([mainAt, yAt, "refs/heads/main"]);
    expect(git(agent, "symbolic-ref", "HEAD")).toBe("refs/heads/keel/x");
    // In the session's sandbox too, where the shared refs are writable: the hook's folder is shown there.
    if (sandboxStatus().available) {
      const line = "git commit -q --allow-empty -m c && git update-ref refs/heads/main HEAD";
      const p = Bun.spawnSync(splitScope(confine(["sh", "-c", line], { sandbox: "workspace-write", network: false }, agent)).argv, { cwd: agent, env: { ...base, ...env } });
      // (The main checkout is in the temporary folder here, which the sandbox replaces: its hook is not found, and
      // a hook that is not there is skipped, as git skips it.)
      expect([p.exitCode, p.stderr.toString().includes("Refused by Keel"), p.stderr.toString().includes("not found")]).toEqual([128, true, false]);
      expect(git(main, "rev-parse", "main")).toBe(mainAt);
    }
    // Another repository the command works in is not touched.
    expect(sh(agent, `git -C ${elsewhere} update-ref refs/heads/main HEAD && git -C ${elsewhere} config --get core.hooksPath`).code).toBe(1);
    // The base is held even when no checkout has it out.
    const s2 = checkoutsOf(agent, "keel/x", "base-only")!;
    const r = run(agent, guardEnv(s2, base), "git", "branch", "-f", "base-only", "HEAD");
    expect([r.code, r.err.includes("the branch base-only")]).toEqual([128, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // (Its folders are shown in every sandbox while they are there: none is left for the files after this one.)
    rmSync(refGuardRoot(), { recursive: true, force: true });
  }
});
