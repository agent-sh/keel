// A script the line hands a shell it starts is judged as the plain line it is: each form of handing one over
// gives the plain line's verdict, in every mode, and the script is found the same way by every rule.
import { expect, test } from "bun:test";
import { NESTED_MAX, innerLines, onlyScript } from "./nested-shell.ts";
import { decide, type Mode } from "./policy.ts";
import { shellReaches } from "./provenance.ts";
import { laid } from "./risk.ts";
import { shellGiven } from "./risk-words.ts";
import { ansiC, splitCommand } from "./shell.ts";
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
  // Options the reading cannot place stand before -c: the first cluster with c after them names the script.
  ["a variable that may hold options", (s) => `bash $OPTS -c '${s}'`],
  ["an expansion that may add an option", (s) => `bash \${DEBUG:+-x} -c '${s}'`],
  ["the line's own arguments as options", (s) => `bash "$@" -c '${s}'`],
  ["another shell's option with a value", (s) => `zsh --emulate sh -c '${s}'`],
  ["zsh's option name attached to -o", (s) => `zsh -oerrexit -c '${s}'`],
  ["a digit option", (s) => `zsh -0c '${s}'`],
  ["fish's option with a value", (s) => `fish -d 3 -c '${s}'`],
  ["two options with values in one cluster", (s) => `bash -oO pipefail extglob -c '${s}'`],
  ["two values and -c in one cluster", (s) => `bash -ooc pipefail errexit '${s}'`],
  ["+c", (s) => `bash +c '${s}'`],
  ["a restricted shell", (s) => `rbash -c '${s}'`],
  ["eval after --", (s) => `eval -- '${s}'`],
  ["builtin eval after --", (s) => `builtin eval -- '${s}'`],
  ["$'...' with an escaped line break", (s) => `bash -c $'echo hi\\n${s}'`],
  ["a here-string of $'...'", (s) => `bash <<< $'echo hi\\n${s}'`],
  ["its own input named as the script file", (s) => `bash /dev/stdin <<< '${s}'`],
  ["echo piped into a shell that names its input", (s) => `echo '${s}' | sh /dev/fd/0`],
  ["a substitution handed as the script file", (s) => `bash <(echo '${s}')`],
  ["a substitution as the input", (s) => `bash < <(echo '${s}')`],
  ["a here-document after a line that runs a container program", (s) => `docker ps\nbash <<EOF\n${s}\nEOF`],
  ["a here-document after a line for another machine", (s) => `ssh host uptime\necho ok\nbash <<'EOF'\n${s}\nEOF`],
  ["a here-document longer than a nested script may be", (s) => `bash <<'EOF'\n${"# a line of notes\n".repeat(300)}${s}\nEOF`],
  ["a here-document read by the shell a -c script starts", (s) => `bash -c 'sh -s' <<EOF\n${s}\nEOF`],
  ["two here-documents on one shell", (s) => `bash <<A <<B\necho one\nA\n${s}\nB`],
  ["a here-document on a group around the shell", (s) => `(bash) <<EOF\n${s}\nEOF`],
  ["env -S", (s) => `env -S "bash -c '${s}'"`],
  ["flock -c", (s) => `flock /tmp/l -c '${s}'`],
  ["a wait's --until", (s) => `waitfor --until '${s}' --timeout 1m`],
  ["script -c", (s) => `script -qc '${s}' /dev/null`],
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
  // (A here-document that reaches the shell through a longer pipe is high risk by that alone; a write it holds is still the owner's.)
  expect(verdict("cat <<EOF | tee /dev/null | bash\necho x >> ~/.bashrc\nEOF")).toBe("owner");
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

test("what is not read: a script file, what xargs or find hands a script, a script for another machine", () => {
  for (const c of ["bash run.sh", "bash -- -c 'cat ~/.ssh/id_ed25519'", "echo ~/.ssh/id_ed25519 | xargs -I{} sh -c 'cat {}'", "ssh host 'cat ~/.ssh/id_ed25519'", "docker exec c sh -c 'cat ~/.ssh/id_ed25519'",
    "docker exec -i c bash <<'EOF'\ncat /root/.ssh/id_rsa\nEOF", "cat > f.sh <<'EOF'\ncat ~/.ssh/id_ed25519\nEOF", "sh -c 'echo \"$1\"' _ hello"])
    expect([c, verdict(c)]).toEqual([c, "asks low"]);
});

test("the words after a script are written into it where it names them, and a script too many is read, never one too few", () => {
  for (const c of ["bash -c 'cat \"$1\"' _ ~/.ssh/id_ed25519", "sh -c 'cat $0' ~/.ssh/id_ed25519", "bash -c 'cat \"$@\"' _ README.md ~/.ssh/id_ed25519", "bash -c 'echo x >> \"$1\"' _ ~/.bashrc",
    // (A script file's own arguments are read as a script when one of them is -c: what `-c` means there is the file's to say.)
    "bash run.sh -c 'cat ~/.ssh/id_ed25519'",
    // (An unquoted here-document: the line's shell takes the backslash off before the text is the script.)
    "bash <<EOF\nf=~/.ssh/id_ed25519\ncat \\$f\nEOF"])
    expect([c, verdict(c)]).toEqual([c, "owner"]);
});

test("a here-document inside a script that is longer than the rules read through is said, not passed", () => {
  const pad = "# a line of notes\n".repeat(300);
  const inner = `bash <<'IN'\n${pad}cat ~/.ssh/id_ed25519\nIN`;
  expect(verdict(`bash <<'EOF'\n${inner}\nEOF`)).toBe("asks high");
  expect(verdict(`bash <<'EOF'\n${inner}\nEOF`, "full-auto")).toBe("asks high");
  // The line's own here-document is read whatever its length.
  expect(verdict(`bash <<'EOF'\n${pad}cat ~/.ssh/id_ed25519\nEOF`)).toBe("owner");
  expect(verdict(`bash <<'EOF'\n${pad}npm test\nEOF`)).toBe("asks low");
});

test("in Read only a line that is not a read is refused before any card for what it reads", () => {
  for (const c of ["cat ~/.ssh/id_ed25519; touch x", "gh auth token > t.txt; touch x", "for f in ~/.ssh/*; do cat $f; rm -f build/x; done"]) {
    expect([c, verdict(c, "read-only")]).toEqual([c, "refused"]);
    expect([c, verdict(c)]).toEqual([c, "owner"]);
  }
  // A read of a credential that is nothing else is the owner's card there too.
  expect(verdict("cat ~/.ssh/id_ed25519", "read-only")).toBe("owner");
  expect(verdict("cat README.md", "read-only")).toBe("runs");
});

test("$'...' is the text bash hands on", () => {
  expect(ansiC("a\\nb\\tc")).toBe("a\nb\tc");
  expect(ansiC("rm\\x20-rf\\040\\u007e")).toBe("rm -rf ~");
  expect(ansiC("it\\'s \\q \\\\")).toBe("it's \\q \\");
  expect(ansiC("a\\x00b")).toBe("a");
  expect(splitCommand("bash -c $'echo hi\\ncat x'")![0]!.words[2]).toBe("echo hi\ncat x");
  for (const c of ["bash -c $'rm\\x20-rf\\x20~'", "bash -c $'cat \\x7e/.ssh/id_ed25519'", "bash -c $'echo \\'hi\\'; cat ~/.ssh/id_ed25519'"]) expect([c, verdict(c)]).toEqual([c, "owner"]);
  // A word with an escape stays one the line makes: a program named so is still not read as written out.
  expect(verdict("$'\\x63at' README.md")).toBe("asks high");
  // \cX: of two backslashes after it bash takes both as the one character, and what follows is read on (an x00
  // there is three plain characters, no NUL that cuts the script before what runs); \c? is DEL.
  expect(ansiC("true \\c\\\\x00; S")).toBe("true \x1cx00; S");
  expect(ansiC("true \\c\\\\\\x00; S")).toBe("true \x1c");
  expect(ansiC("true \\c\\x00; S")).toBe("true \x1cx00; S");
  expect(ansiC("a\\c\\nb")).toBe("a\x1cnb");
  expect(ansiC("a\\c?b\\cAc")).toBe("a\x7fb\x01c");
  // \x{H...} is one byte, the last of its digits, 0 with none; a brace that never closes still ends at the digits.
  expect(ansiC("\\x{72}m \\x{4172}f")).toBe("rm rf");
  expect(ansiC("a\\x{}b")).toBe("a");
  expect(ansiC("a\\x{41b")).toBe("a\x1b");
  // Of a character that is not ASCII \c takes the first byte: a NUL for U+0800 to U+0FFF, which cuts the text.
  expect(ansiC("a\\c\u0801b")).toBe("a");
  expect(ansiC("a\\c\u00e9b")).toBe("a\x03\ufffdb");
  for (const c of ["bash -c $'true \\c\\\\x00; git push --force origin main'", "bash -c $'true \\c\\\\x00; rm -rf ~'", "eval $'true \\c\\\\x00; git push --force origin main'", "bash -c $'\\x{67}it push --force origin main'"])
    expect([c, verdict(c, "full-auto")]).toEqual([c, "asks high"]);
  for (const c of ["bash -c $'true \\c\\\\x00; cat ~/.ssh/id_ed25519'", "bash <<< $'true \\c\\\\x00; echo x >> ~/.bashrc'", "bash -c $'\\x{63}at ~/.ssh/id_ed25519'"]) expect([c, verdict(c)]).toEqual([c, "owner"]);
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
  expect(given("bash -x run.sh")).toBe("<file run.sh>");
  expect(given("bash -- -c S")).toBe("<file -c>");
  expect(given("bash - run.sh -c S")).toBe("<file run.sh>");
  expect(given("bash /dev/stdin")).toBe("<input>");
  expect(given("sh /dev/fd/0 a")).toBe("<input>");
  expect(given("bash -o pipefail")).toBe("<input>");
  // + clusters, a value for each o and O of a cluster, digits.
  expect(given("bash +c S")).toBe("S");
  expect(given("bash +xc S")).toBe("S");
  expect(given("bash -c -oO pipefail extglob S")).toBe("S");
  expect(given("bash -ooc pipefail errexit S")).toBe("S");
  expect(given("bash -oO pipefail extglob -c S")).toBe("S");
  expect(given("zsh -o errexit -0c S")).toBe("S");
  expect(given("fish --command S")).toBe("S");
  // Options that cannot be read: the first cluster with c after them, read on from there.
  expect(given("bash $OPTS -c S")).toBe("S");
  expect(given("bash $OPTS -c -x S a")).toBe("S");
  expect(given("zsh --emulate sh -c S")).toBe("S");
  expect(given("zsh -oerrexit -c S")).toBe("S");
  expect(given("fish -d 3 -c S")).toBe("S");
  expect(given("bash run.sh -c S")).toBe("S");
  // A `--` ends the options only when every word before it was read for sure: after a word the line's shell writes,
  // or an option that may take the `--` as its value, the cluster with c behind it still names the script.
  expect(given("bash $X -- -c S")).toBe("S");
  expect(given("bash $X - -c S")).toBe("S");
  expect(given("bash --rcfile $X -- -c S")).toBe("S");
  expect(given("bash -o $X -- -c S")).toBe("S");
  expect(given("bash --$X -- -c S")).toBe("S");
  expect(given("bash `opts` -- -c S")).toBe("S");
  expect(given("fish -d -- -c S")).toBe("S");
  expect(given("fish --profile -- -c S")).toBe("S");
  expect(given("ksh -R -- -c S")).toBe("S");
  expect(given("mksh -xT -- -c S")).toBe("S");
  // A word the line's shell writes in a value's place may be nothing, and the next word the value: with -c read it
  // is handed on as the script, as in `bash -c $X S`, and every word up to where the reading ends either way too.
  const all = (line: string) => { const g = shellGiven(line.split(" ").slice(1)); return [...(g.also ?? []).map((o) => o.script), g.script].join(" | "); };
  expect(all("bash -c -o $X S")).toBe("S | $X");
  expect(all("bash -oc $X errexit S")).toBe("errexit | S | $X");
  expect(all("bash -ooc $X pipefail errexit S")).toBe("pipefail | errexit | S | $X");
  expect(all("bash -oc pipefail $X S")).toBe("S | $X");
  expect(all("bash -c $X S a")).toBe("S | $X");
  expect(all("bash -cx $X -c S")).toBe("-c | S | $X");
  expect(all("bash -ooc $X $Y S")).toBe("$Y | S | $X");
  expect(all("bash -oc $X -o errexit S")).toBe("-o | errexit | S | $X");
  expect(all("bash -o $X -c S")).toBe("S");
  // Behind unread options the cluster with c may be a word of a script they hold: the words in the place of its
  // o's values may be the script too.
  expect(all("bash $X -oc S")).toBe("S");
  expect(all("bash $X _ -oc S")).toBe("S");
  expect(all("bash $X -oc errexit S")).toBe("errexit | S");
  expect(all("bash $X -ooc a S")).toBe("a | S");
  expect(all("bash $X -Oc S")).toBe("S");
  // (zsh's -O takes no value: the `--` after it is not surely the end of the options.)
  expect(all("zsh -O -c -- S")).toBe("-- | S");
  expect(all("bash -O extglob -c S")).toBe("S");
  // With -c read, the word in the place of an -O's value may be the script (zsh), and an option whose value is not
  // known in every shell may take the word after it.
  expect(all("zsh -Oc S")).toBe("S");
  expect(all("zsh -c -O S")).toBe("S");
  expect(all("bash -cO extglob S a")).toBe("extglob | S");
  expect(all("fish -pc S a")).toBe("a | S");
  expect(all("ksh -c -R f S")).toBe("S | f");
  // A script that only holds a `$` is the script, and the words after it are its own.
  expect(shellGiven(["-c", "echo \"$0\"", "$f"])).toEqual({ c: true, script: "echo \"$0\"", at: 1, rest: ["$f"], input: false });
  expect(given("bash --rcfile f -- -c S")).toBe("<file -c>");
  expect(given("bash --login -x -- -c S")).toBe("<file -c>");
  expect(given("bash -eu -o pipefail -- run.sh")).toBe("<file run.sh>");
  expect(given("bash -s -- -c S")).toBe("<input>");
  expect(shellGiven(["$OPTS", "-xc", "S", "zero"])).toEqual({ c: true, script: "S", at: 2, rest: ["zero"], input: false });
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

test("a script and its written-out form are each read once however deep they nest, and a line built to be read more is said", () => {
  // Eight here-documents inside each other, each level setting and using a variable: two lines a level, not two to the eighth.
  let x = "f=~/x; echo $f";
  for (let i = 1; i <= 8; i++) x = `v${i}=~/y; echo $v${i}\nbash <<'E${i}'\n${x}\nE${i}`;
  const parts = splitCommand(x)!;
  expect(innerLines(parts, laid(parts, ws, home), home).length).toBeLessThanOrEqual(16);
  expect(verdict(x)).toBe("asks low");
  // Each level setting a variable the innermost uses: a script n deep is read in n + 1 forms, not in two to the n.
  let small = `echo ${Array.from({ length: 8 }, (_, i) => `$v${i + 1}`).join(" ")}`;
  for (let i = 1; i <= 8; i++) small = `v${i}=~/y${i}; true\nbash <<'E${i}'\n${small}\nE${i}`;
  const levels = splitCommand(small)!;
  expect(innerLines(levels, laid(levels, ws, home), home).length).toBeLessThanOrEqual(45);
  expect(verdict(small)).toBe("asks low");
  // (The innermost is still read with every variable written out.)
  expect(verdict(small.replace("~/y8", "~/.ssh/id_ed25519").replace("echo $v1", "cat $v1"))).toBe("owner");
  // A here-document of the line itself past NESTED_MAX is read as it stands and not written out: it asks as a
  // script too long does. One within it is read both ways.
  // (A name set twice: the line's own written-out form leaves it, the document's own gives the last value.)
  const doc = (pad: number) => `bash <<'EOF'\nf=~/x\nf=~/.bashrc\n${"echo a\n".repeat(pad)}echo x >> $f\nEOF`;
  expect(verdict(doc(700))).toBe("owner");
  expect(verdict(doc(3000))).toBe("asks high");
  // Many such chains in one line: more nested text than the bound is not read through, and asks.
  const chain = (tag: number) => { let c = "f=~/x; echo $f\n".repeat(240); for (let i = 1; i <= 8; i++) c = `v${i}=~/y${tag}; echo $v${i}\nbash <<'E${i}'\n${c}\nE${i}`; return c; };
  const many = Array.from({ length: 25 }, (_, i) => chain(i)).join("\n");
  const unread: { at: number; why: string }[] = [];
  const all = splitCommand(many)!;
  innerLines(all, laid(all, ws, home), home, 0, unread);
  expect(unread.map((u) => u.why)).toEqual(["nests more script text than the rules read through: put it in a file"]);
  expect(verdict(many)).toBe("asks high");
  // The bound is the same for a short line: one of a few thousand characters whose levels each set a variable the
  // innermost uses (so each level's text is another text written out) has no more read than a long one, and asks.
  let far = `${"echo a\n".repeat(430)}echo ${Array.from({ length: 8 }, (_, i) => `$v${i + 1}`).join(" ")}`;
  for (let i = 1; i <= 8; i++) far = `v${i}=~/y${i}; true\nbash <<'E${i}'\n${far}\nE${i}`;
  expect(far.length).toBeLessThan(4000);
  const few = splitCommand(far)!, said: { at: number; why: string }[] = [];
  const got = innerLines(few, laid(few, ws, home), home, 0, said);
  // (The line's own here-document is read as it stands and written out beside the bound, which holds the rest.)
  expect(got.reduce((n, l) => n + l.parts.reduce((k, p) => k + p.text.length + 1, 0), 0)).toBeLessThanOrEqual(NESTED_MAX + 2 * far.length);
  expect(said.map((u) => u.why)).toEqual(["nests more script text than the rules read through: put it in a file"]);
  expect(verdict(far)).toBe("asks high");
});

test("the rules that read a script themselves find it the same way: -c in a cluster, options after it", () => {
  const reachOf = (c: string) => shellReaches(c, { cwd: "/w", remoteUrl: () => undefined }).map((r) => `${r.how}:${r.target.key}`);
  // The risk classes.
  for (const c of ["bash -cx 'git push --force origin main'", "bash -c -x 'git push --force origin main'", "sh -xc 'git push --force origin main'", "bash <<< \"git push --force origin main\""])
    expect([c, verdict(c)]).toEqual([c, "asks high"]);
  // A turn nobody started.
  for (const c of ["bash -cx 'gh pr merge 12'", "bash -c -x 'gh pr merge 12'", "bash -lc 'gh pr merge 12'"]) expect([c, unstartedAct(splitCommand(c)) !== null]).toEqual([c, true]);
  for (const c of ["bash $OPTS -c 'gh pr merge 12'", "zsh --emulate sh -c 'gh pr merge 12'", "bash +c 'gh pr merge 12'", "eval -- 'gh pr merge 12'", "bash run.sh -c 'gh pr merge 12'"]) expect([c, unstartedAct(splitCommand(c)) !== null]).toEqual([c, true]);
  expect(unstartedAct(splitCommand("bash run.sh 'gh pr merge 12'"))).toBeNull();
  for (const c of ["bash $OPTS -c 'git push --force origin main'", "bash \"$@\" -c 'git push --force origin main'", "zsh -oerrexit -c 'git push --force origin main'", "bash -oO pipefail extglob -c 'git push --force origin main'", "bash +c 'git push --force origin main'",
    "eval -- 'git push --force origin main'", "rbash -c 'git push --force origin main'", "bash /dev/stdin <<< 'git push --force origin main'", "echo 'git push --force origin main' | bash /dev/stdin", "bash <(echo 'git push --force origin main')",
    "flock /tmp/l -c 'git push --force origin main'", "watch 'git push --force origin main'", "env -S 'bash -c \"git push --force origin main\"'", "bash -c $'echo hi\\ngit push --force origin main'"])
    expect([c, verdict(c)]).toEqual([c, "asks high"]);
  // Behind a word the line's shell writes, a `--` may be an option's value and the script still runs.
  for (const c of ["X='-c $2'; bash $X -- -c 'git push --force origin main'", "bash $OPTS -- -c 'git push --force origin main'", "bash \"$@\" -- -c 'git push --force origin main'", "bash $X - -c 'git push --force origin main'",
    "bash --rcfile $X -- -c 'git push --force origin main'", "env -i bash $X -- -c 'rm -rf ~'", "bash -lc \"bash \\$X -- -c 'rm -rf ~'\""])
    expect([c, verdict(c, "full-auto")]).toEqual([c, "asks high"]);
  for (const c of ["bash $X -- -c 'cat ~/.ssh/id_ed25519'", "bash --init-file $X -- -c 'echo x >> ~/.bashrc'"]) expect([c, verdict(c)]).toEqual([c, "owner"]);
  for (const c of ["bash $X -- -c 'gh pr merge 12'", "bash --rcfile $X -- -c 'gh pr merge 12'"]) expect([c, unstartedAct(splitCommand(c)) !== null]).toEqual([c, true]);
  // A value the line's shell writes may be nothing: the script behind the next word runs.
  for (const c of ["bash -oc $X errexit 'git push --force origin main'", "bash -c -o $X errexit 'rm -rf ~'", "sh -oc \"$@\" errexit 'git push --force origin main'", "/bin/bash -lc 'bash -oc $X errexit \"rm -rf ~\"'",
    "bash -ooc $X pipefail errexit 'git push --force origin main'", "X='-c $1'; bash $X -oc 'git push --force origin main'", "X='-c $2'; bash $X _ -oc 'rm -rf ~'", "X='-c $1'; bash $X -Oc 'rm -rf ~'", "X='-c $2'; bash $X _ -co 'git push --force origin main'",
    "zsh -O -c -- 'git push --force origin main'", "zsh -Oc 'git push --force origin main'", "zsh -o errexit -Oc 'rm -rf ~'", "zsh -c -O 'git push --force origin main'"])
    expect([c, verdict(c, "full-auto")]).toEqual([c, "asks high"]);
  for (const c of ["bash -oc $X errexit 'gh pr merge 12'", "bash -c -o $X 'gh pr merge 12'", "bash -cx $X -c 'gh pr merge 12'", "bash -ooc $X $Y 'gh pr merge 12'", "bash -c $X 'gh pr merge 12'", "X='-c $1'; bash $X -oc 'gh pr merge 12'", "X='-c $2'; bash $X -x -oc 'gh pr merge 12'", "zsh -O -c -- 'gh pr merge 12'", "zsh -Oc 'gh pr merge 12'", "zsh -x -Oc 'gh pr merge 12'"]) expect([c, unstartedAct(splitCommand(c)) !== null]).toEqual([c, true]);
  for (const c of ["X='-c $1'; bash $X -oc 'cat ~/.ssh/id_ed25519'", "zsh -O -c -- 'cat ~/.ssh/id_ed25519'", "bash $X -ooc a 'echo x >> ~/.bashrc'"]) expect([c, verdict(c)]).toEqual([c, "owner"]);
  expect(reachOf("bash $X -oc 'curl https://in.example'")).toEqual(["fetch:host:in.example"]);
  expect(reachOf("bash -oc $X errexit 'curl https://in.example'")).toContain("fetch:host:in.example");
  // An ordinary script with a variable in it and words after it asks nothing more.
  for (const c of ["for e in a b; do sh -c 'echo \"$0\"; ls \"$HOME\"' \"$e\"; done", "sh -c 'ls \"$1\"' sh \"$f\""]) expect([c, verdict(c, "full-auto")]).toEqual([c, "runs"]);
  // A wrapper's own option value with a space in it is no command line, and a wait on a script in a variable asks nothing more.
  for (const c of ["/usr/bin/time -f '%e s' sqlite3 x.db 'select count(*) from t'", "S=~/scratch; waitfor --until \"$S/check.sh done\" --timeout 30s", "timeout -s 'TERM ' 5 make"])
    expect([c, verdict(c)]).toEqual([c, "asks low"]);
  // The targets a line reaches.
  const reach = (c: string) => shellReaches(c, { cwd: "/w", remoteUrl: () => undefined }).map((r) => `${r.how}:${r.target.key}`);
  for (const c of ["bash -c 'curl https://in.example'", "bash -lc 'curl https://in.example'", "sh -c -e 'curl https://in.example'", "bash $OPTS -c 'curl https://in.example'", "bash -oO pipefail extglob -c 'curl https://in.example'"]) expect([c, reach(c)]).toEqual([c, ["fetch:host:in.example"]]);
});

test("a line that is one shell and its script, as another harness sends it, gives up the script; any other line none", () => {
  expect(onlyScript("/bin/bash -lc 'make test'")).toBe("make test");
  expect(onlyScript("bash -o pipefail -c \"V=push; git \\$V --force\"")).toBe("V=push; git $V --force");
  // (More than one word may be the script: the line is judged as it stands.)
  expect(onlyScript("bash $X -oc errexit 'make test'")).toBeUndefined();
  for (const c of ["make test", "bash run.sh", "bash -lc 'make' && ls", "bash -lc 'make' extra", "FOO=1 bash -lc make", "bash -lc \"$SCRIPT\"", "bash -lc 'cat' <<< x", "bash -s <<'EOF'\nmake\nEOF"]) expect([c, onlyScript(c)]).toEqual([c, undefined]);
});
