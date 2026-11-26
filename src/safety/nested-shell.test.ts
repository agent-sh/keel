// A script the line hands a shell it starts is judged as the plain line it is: each form of handing one over
// gives the plain line's verdict, in every mode, and the script is found the same way by every rule.
import { expect, test } from "bun:test";
import { innerLines } from "./nested-shell.ts";
import { decide, type Mode } from "./policy.ts";
import { shellReaches } from "./provenance.ts";
import { laid } from "./risk.ts";
import { shellGiven } from "./risk-words.ts";
import { splitCommand } from "./shell.ts";
import { unstartedAct } from "./unstarted.ts";

const home = "/home/u", ws = `${home}/projects/app`, state = `${home}/.local/share/keel-bun/state`;
const facts = (mode: Mode, more: Record<string, unknown> = {}) => ({
  mode, workspace: ws, sandboxed: false, rules: [], tool: "Bash", home, config: [`${home}/.config/keel-bun`],
  keel: (p: string) => (p.startsWith(`${state}/`) ? `it changes ${p}, one of Keel's own files` : null), ...more,
});
const verdict = (command: string, mode: Mode = "ask", more: Record<string, unknown> = {}) => {
  const d = decide({ kind: "shell", command, cwd: ws }, facts(mode, more));
  return "allow" in d ? "runs" : "deny" in d ? "refused" : d.ask.ownerOnly ? "owner" : `asks ${d.ask.risk}`;
};

// Every way a line hands a script to a shell that the rules read.
const FORMS: [string, (script: string) => string][] = [
  ["bash -c", (s) => `bash -c '${s}'`],
  ["sh -c", (s) => `sh -c '${s}'`],
  ["bash -lc", (s) => `bash -lc '${s}'`],
  ["zsh -c", (s) => `zsh -c '${s}'`],
  ["env bash -c", (s) => `env bash -c '${s}'`],
  ["/bin/bash by its path", (s) => `/bin/bash -lc '${s}'`],
  ["options after -c", (s) => `bash -c -x '${s}'`],
  ["-c inside a cluster", (s) => `sh -cx '${s}'`],
  ["an option with a value before -c", (s) => `bash -o pipefail -c '${s}'`],
  ["double quotes with an escape", (s) => `sh -c "${s.replace(/~/g, "\\$HOME")}"`],
  ["behind timeout and a variable", (s) => `FOO=1 timeout 5 bash -c '${s}'`],
  ["a here-string", (s) => `bash <<< '${s}'`],
  ["a here-string in double quotes", (s) => `bash <<< "${s}"`],
  ["a here-document", (s) => `bash <<'EOF'\n${s}\nEOF`],
  ["a here-document, delimiter not quoted", (s) => `sh -s <<EOF\n${s}\nEOF`],
  ["echo piped into a shell", (s) => `echo '${s}' | bash`],
  ["eval", (s) => `eval '${s}'`],
  ["a script inside a script", (s) => `bash -c "sh -c '${s}'"`],
  ["after a cd, with more commands around it", (s) => `cd /tmp && bash -c 'ls; ${s}; echo done' && echo ok`],
];

test("each form of handing a shell a script gives the plain line's verdict: credentials, files that run later, Keel's own, what never runs", () => {
  const SCRIPTS: [string, string][] = [
    ["cat ~/.ssh/id_ed25519", "owner"], ["cp ~/.aws/credentials /tmp/x", "owner"], ["grep -r token ~", "owner"],
    ["echo x >> ~/.bashrc", "owner"], ["cp evil.json ~/.config/keel-bun/hooks.json", "owner"],
    [`echo x > ${state}/keel.db`, "refused"], ["rm -rf ~", "owner"],
  ];
  for (const [script, plain] of SCRIPTS) {
    expect([script, verdict(script)]).toEqual([script, plain]);
    for (const [form, line] of FORMS) expect([script, form, verdict(line(script))]).toEqual([script, form, plain]);
  }
  // Full auto waits for nobody: there it is high risk, as the plain line is. An agent's read of a credential is refused.
  for (const [form, line] of FORMS) {
    expect([form, verdict(line("cat ~/.ssh/id_ed25519"), "full-auto")]).toEqual([form, "asks high"]);
    expect([form, verdict(line("echo x >> ~/.bashrc"), "full-auto")]).toEqual([form, "asks high"]);
    expect([form, verdict(line("cat ~/.ssh/id_ed25519"), "auto", { agent: true })]).toEqual([form, "refused"]);
  }
  // A standing rule that covers the shell does not cover what its script reads or writes.
  const rule = [{ id: "r", kind: "shell", pattern: "bash *", scope: ws, lifetime: "always", created: 0 }];
  expect(verdict("bash -c 'cat ~/.ssh/id_ed25519'", "ask", { rules: rule })).toBe("owner");
  expect(verdict("bash -c 'cat README.md'", "ask", { rules: rule })).toBe("runs");
});

test("a script is read where its shell starts, with the variables it sets written out, and an ordinary one is what it was", () => {
  expect(verdict("cd ~/.aws && bash -c 'cat credentials'")).toBe("owner");
  expect(verdict("bash -c 'cd ~/.aws && cat credentials'")).toBe("owner");
  expect(verdict("bash -c 'f=~/.npmrc; cat $f'")).toBe("owner");
  expect(verdict("bash -c 'cat .env'")).toBe("owner");
  // Nothing new asks for a script that reads or writes nothing of the owner's.
  for (const c of ["bash -c 'ls -la && echo done'", "bash -lc 'cat README.md | head -3'", "sh -c 'echo x >> notes.txt'", "bash <<'EOF'\nnpm test\nEOF", "bash -c 'cat ~/.ssh/known_hosts ~/.ssh/id_ed25519.pub'", "bash -c 'ls ~/.ssh; test -f ~/.ssh/id_rsa'"])
    expect([c, verdict(c)]).toEqual([c, "asks low"]);
  // Read only and Plan refuse a line that starts a shell, as before: the script adds no card to that.
  for (const mode of ["read-only", "plan"] as Mode[]) expect([mode, verdict("bash -c 'cat ~/.ssh/id_ed25519'", mode)]).toEqual([mode, "refused"]);
});

test("what is not read: a script file, the words after a script, a script for another machine", () => {
  for (const c of ["bash run.sh", "bash run.sh -c 'cat ~/.ssh/id_ed25519'", "bash -c 'cat \"$1\"' _ ~/.ssh/id_ed25519", "ssh host 'cat ~/.ssh/id_ed25519'", "docker exec c sh -c 'cat ~/.ssh/id_ed25519'"])
    expect([c, verdict(c)]).toEqual([c, "asks low"]);
});

test("the script a shell is given is found by its options as the shell reads them", () => {
  const given = (line: string) => { const g = shellGiven(line.split(" ").slice(1)); return g.script ?? (g.input ? "<input>" : `<file ${g.rest[0]}>`); };
  expect(given("bash -c S a b")).toBe("S");
  expect(given("bash -lc S")).toBe("S");
  expect(given("bash -c -x S")).toBe("S");
  expect(given("sh -xec S")).toBe("S");
  expect(given("bash -o pipefail -c S")).toBe("S");
  expect(given("bash -eo pipefail -c S")).toBe("S");
  expect(given("bash --norc --rcfile f -c S")).toBe("S");
  expect(given("bash -c -- S")).toBe("S");
  expect(given("bash +x -c S")).toBe("S");
  expect(given("bash")).toBe("<input>");
  expect(given("bash -s a")).toBe("<input>");
  expect(given("bash -x")).toBe("<input>");
  expect(given("bash run.sh -c S")).toBe("<file run.sh>");
  expect(given("bash -x run.sh")).toBe("<file run.sh>");
  expect(shellGiven(["-lc", "S", "zero", "one"])).toEqual({ c: true, script: "S", at: 1, rest: ["zero", "one"], input: false });
});

test("the scripts of a line, as text: quotes taken off, escapes read, one line for each script and each script inside it", () => {
  const scripts = (line: string) => { const parts = splitCommand(line)!; return innerLines(parts, laid(parts, ws, home), home).map((l) => l.parts.map((p) => p.words.join(" ")).join(" ; ")); };
  expect(scripts("sh -c \"cat \\\"$HOME/.npmrc\\\"\"")).toEqual(["cat $HOME/.npmrc"]);
  expect(scripts("bash -c 'a; b' && echo x | sh -c c")).toEqual(["a ; b", "c"]);
  expect(scripts("bash -c \"sh -c 'inner one'\"")).toEqual(["sh -c inner one", "inner one"]);
  expect(scripts("bash <<< 'a b'")).toEqual(["a b"]);
  expect(scripts("cat <<EOF | bash\na b\nc\nEOF")).toEqual(["a b ; c"]);
  expect(scripts("printf 'a\\nb' | sh")).toEqual(["a ; b"]);
  // A here-document that feeds a program which is no shell, or a shell on another machine, is no script here.
  expect(scripts("cat <<EOF > notes.txt\ncat ~/.ssh/id_ed25519\nEOF")).toEqual([]);
  expect(scripts("ssh host bash <<EOF\na\nEOF")).toEqual([]);
  expect(scripts("bash run.sh; ls")).toEqual([]);
  // Where each script starts: the folder of the part that starts its shell.
  const parts = splitCommand("cd /tmp && bash -c 'cd sub && ls'")!;
  const [one] = innerLines(parts, laid(parts, ws, home), home);
  expect([one!.at, one!.pre.dirs]).toEqual([1, ["/tmp", "/tmp/sub"]]);
});

test("the rules that read a script themselves find it the same way: -c in a cluster, options after it", () => {
  // The risk classes.
  for (const c of ["bash -cx 'git push --force origin main'", "bash -c -x 'git push --force origin main'", "sh -xc 'git push --force origin main'", "bash <<< \"git push --force origin main\""])
    expect([c, verdict(c)]).toEqual([c, "asks high"]);
  // A turn nobody started.
  for (const c of ["bash -cx 'gh pr merge 12'", "bash -c -x 'gh pr merge 12'", "bash -lc 'gh pr merge 12'"]) expect([c, unstartedAct(splitCommand(c)) !== null]).toEqual([c, true]);
  expect(unstartedAct(splitCommand("bash run.sh -c 'gh pr merge 12'"))).toBeNull();
  // The targets a line reaches.
  const reach = (c: string) => shellReaches(c, { cwd: "/w", remoteUrl: () => undefined }).map((r) => `${r.how}:${r.target.key}`);
  for (const c of ["bash -c 'curl https://in.example'", "bash -lc 'curl https://in.example'", "sh -c -e 'curl https://in.example'"]) expect([c, reach(c)]).toEqual([c, ["fetch:host:in.example"]]);
});
