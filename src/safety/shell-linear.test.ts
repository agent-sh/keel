// The rule: every pattern in src/safety that is applied to a word a model
// wrote reads it in step with its length. The permission gate runs on the
// daemon's main thread, and a pattern with two quantified parts that can
// match the same characters (-[cl]*[clt][cl]*) takes the square of a long
// word: 100,000 characters held the loop for 20 seconds.
//
// Here each entry of the classifier judges words of 100,000 characters, one
// for each kind of character its patterns take, alone and after the words
// that lead into its parser; and the whole decision judges such words where
// the risk rules read them. None may take 50 ms.
import { expect, test } from "bun:test";
import { neverAllowed, neverAllowedText } from "./autonomy.ts";
import { decide } from "./policy.ts";
import { risksOf as risksIn } from "./risk.ts";
import { isReadOnly, matchRule, shimmedRead, suggestRule, type Simple } from "./shell.ts";
import { READERS, SHIMMED } from "./shell-reads.ts";

const N = 100_000;
const LIMIT = 50;
// One kind of character, or a short group, repeated: letters every option cluster takes, the ones two parts of
// a pattern could share (c l t, r R, n), digits, and what addresses, paths, scripts and assignments are made of.
const UNITS = ["a", "c", "l", "n", "r", "R", "x", "1", "-", "_", ".", ",", ":", "/", "=", "@", "%", "+", "[", "]", "{", "}", "cl", "rR", "a-", "a.", "a/", "a=", "a:", "1.", "::", "--", ".ssh", "/.ssh/", ".pub", "{a,b}", "p;", "s/a/b/;", "$x"];
const words: string[] = [];
for (const u of UNITS) {
  const body = u.repeat(Math.ceil(N / u.length)).slice(0, N);
  // As it stands, as an option, and with an end no pattern takes (what makes a pattern try again).
  words.push(body, "-" + body, body + "!", "-" + body + "!");
}

// The time of the faster of two tries: a busy machine can stall one.
const timed = (f: () => unknown) => {
  let best = Infinity;
  for (let k = 0; k < 2 && best > LIMIT; k++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); }
  return best;
};
const part = (words: string[]): Simple => ({ words, text: words.join(" "), redirects: false });
const risksOf = (parts: Simple[]) => risksIn(parts, { cwd: "/w", home: "/h", workspace: "/w" });

// The words that lead into each parser: a subcommand, an option that takes a value, a keyword an address follows.
const LEADS: Record<string, string[][]> = {
  ss: [["dst"], ["sport", "="], ["state"], ["-f"]], lsof: [["-i"], ["-n", "-i"]], ip: [["route", "get"], ["addr", "show", "to"], ["-4"]], netstat: [["-n"]], tar: [["tf"], ["-tf"], ["-t", "--file"]],
  xxd: [["-l"], ["-s"], ["--"]], gzip: [["-c"], ["-c", "--"]], gunzip: [["-c"]], journalctl: [["-u"], ["-n"]], systemctl: [["status"], ["--user", "status"]], docker: [["ps"], ["top", "x"], ["image", "ls"]],
  getent: [["passwd"]], dpkg: [["-l"]], apt: [["list"], ["show"]], "apt-cache": [["show"]], sysctl: [["-n"]], unzip: [["-l"]], "nvidia-smi": [["-q"]], find: [["."], [".", "-name"], [".", "-exec"], [".", "-exec", "cat", "{}"]],
  sed: [["-n"], ["-e"], ["-n", "p", "--"]], awk: [["-F"], ["-v"]], sort: [["-t"], ["--"]], date: [["-d"]], uniq: [["-f"]], xargs: [["-I"], ["-n"], ["-n", "1"]], test: [["-f"], ["a", "="]], "[": [["-f"]],
  "[[": [["-f"], ["a", "=="]], printf: [["%s"]], command: [["-v"]], read: [["-r"], ["-d"]], wait: [["-n"]], rg: [["foo"], ["--"]], fd: [["--"]], file: [["--"]], shuf: [["-n"], ["--"]], base64: [["--"]],
  git: ["status", "log", "diff", "show", "branch", "tag", "remote", "stash", "config", "reflog", "symbolic-ref", "worktree", "submodule", "notes", "grep", "rev-parse", "for-each-ref"].flatMap((sub) => [[sub], [sub, "--"]])
    .concat([["-C"], ["log", "--format"], ["branch", "--list"], ["tag", "-l"], ["config", "--get"], ["stash", "list"], ["remote", "get-url"], ["worktree", "list"], ["notes", "show"]]),
};
const PROGRAMS = [...new Set([...READERS.keys(), ...SHIMMED.keys(), ...Object.keys(LEADS), "ls", "cat", "grep", "tree", "gawk", "env", "hostname", "echo", "cd", "nosuchprogram"])];

test("every entry of the classifier reads a word of 100,000 characters in step with its length", () => {
  const slow: string[] = [];
  for (const prog of PROGRAMS) {
    for (const lead of [[], ...(LEADS[prog] ?? [["-n"], ["--"]])]) {
      for (const word of words) {
        const p = part([prog, ...lead, word]);
        const ms = timed(() => { isReadOnly(p); shimmedRead(p); });
        if (ms > LIMIT) slow.push(`${prog} ${lead.join(" ")} ${word.slice(0, 12)}...${word.slice(-3)}: ${ms.toFixed(0)} ms`);
      }
    }
  }
  expect(slow).toEqual([]);
}, 120_000);

test("the risk rules and the grants read such a word in step with its length too", () => {
  const slow: string[] = [];
  const note = (what: string, word: string, ms: number) => { if (ms > LIMIT) slow.push(`${what} ${word.slice(0, 12)}...${word.slice(-3)}: ${ms.toFixed(0)} ms`); };
  // What the never-allowed and high-risk rules read: targets, modes, devices, credentials, pushes, a script's text.
  const RISKY = ["rm -rf", "rm -r --", "chmod -R 777", "chown -R u", "dd", "dd if=a", "shred", "git push", "git push --force origin", "git reset --hard", "git clean -f", "sudo", "sudo rm -rf", "curl", "python3 -c",
    "cat", "ssh -i", "mv", "mkfs.ext4", "git -C",
    // What the risk classes read (risk.ts): targets and patterns, a remote command, SQL, a nested script, code, a setting's key, a pattern of names, a file to send.
    "rm", "truncate -s 0", "find", "find . -name", "find . -delete -name", "xargs rm", "env", "timeout 5 rm -rf", "rsync --delete a", "ssh host", "kubectl delete", "aws s3", "psql -c", "sqlite3 a.db", "bash -c", "sh -c",
    "eval", "node -e", "perl -e", "git config --global", "git -c", "git branch -D", "pkill -f", "kill -9", "crontab", "npm install", "pip install", "curl -d", "curl -X DELETE", "scp", "nc host 80", "make", "npm run", "export",
    // And what the second round of classes reads: git's pathspecs, a container's mounts, an archive, a patch, what gh posts, a runner's address, a registry, a unit, a move, an overwrite, a database, a wrapper's command.
    "git checkout", "git checkout --", "git restore", "git rm -r", "git clean", "git clean -f", "git apply", "docker run -v", "docker run", "docker exec c", "kubectl exec pod --", "tar xzf", "tar xzf a.tgz -C", "unzip", "patch -i",
    "gh gist create", "gh issue comment 1 --body-file", "npx", "bunx", "uvx --from", "uv run --with", "go run", "deno run", "pip install --index-url", "npm install --registry", "systemctl --user stop", "systemctl stop", "cp a",
    "tee", "sed -i s/a/b/", "ln -sfn a", "dd of=a", "sqlite3", "redis-cli", "psql -h", "psql -f", "dropdb", "tmux new -d", "awk", "flock a", "strace -o a", "rsync -a --delete a", "rclone copy", "yq -i .a", "curl -o", "chmod 777",
    "ssh -R", "python3 -m http.server --directory", "rimraf", "busybox rm -rf", "kill", "pkill"];
  for (const word of words) {
    for (const lead of RISKY) {
      const p = part([...lead.split(" "), word]);
      note(lead, word, timed(() => { neverAllowed([p], "/w", "/h"); risksOf([p]); suggestRule(p); }));
    }
    // A grant with several `*`, against a command made of the word.
    const p = part(["git", word, "main", word]);
    note("grant", word, timed(() => matchRule("git * main * x", p)));
    // A line the parser cannot split is read as text by the never-allowed rules.
    for (const lead of ["rm -rf ", "rm -", "dd ", "sudo rm -r ", "mkfs."]) note(`text: ${lead}`, word, timed(() => neverAllowedText(lead + word + " '", "/h")));
  }
  expect(slow).toEqual([]);
}, 120_000);

// The whole decision, parser included, on one line of 100,000 characters. It reads every character several times
// over, so its bound is wider; what it guards against is the square, which takes seconds.
test("a whole line of 100,000 characters is decided in step with its length", () => {
  const facts = (mode: "ask" | "full-auto") => ({ mode, workspace: "/w", sandboxed: false, tool: "Bash", home: "/h",
    rules: [{ id: "1", kind: "shell" as const, pattern: "git * main * x", scope: "", lifetime: "always" as const, created: 0 }] });
  const slow: string[] = [];
  for (const u of ["a", "/", "{", "{a,", "}", "$x", "${x}", "\\\\", "*", "[", "a=b ", "' '", "a;", ">a ", ".ssh/"]) {
    const body = u.repeat(Math.ceil(N / u.length)).slice(0, N);
    // (After `ls` and `rm`, the programs whose words the policy reads for a file that runs later: for the long
    // word each of them is handed. A line of 50,000 parts is the first two's case; it is the parser's time, the
    // same after any program, and every further try at it is one more chance for a busy machine to stall one.)
    const leads = ["ls ", "rm -rf -", ...(u.includes(";") ? [] : ["cp a ", "tar xzf a.tgz -C ", "git checkout -- ", "git apply ", "curl -o ", "yq -i .a ", "python3 -c ", "chmod 777 "])];
    for (const lead of leads) for (const mode of ["ask", "full-auto"] as const) {
      let best = Infinity;
      // (The fastest of up to six tries: on a busy machine most of them are stalled, and the square is slow in every one.)
      for (let k = 0; k < 6 && best > 5 * LIMIT; k++) { const t = performance.now(); decide({ kind: "shell", command: lead + body, cwd: "/w" }, facts(mode)); best = Math.min(best, performance.now() - t); }
      if (best > 5 * LIMIT) slow.push(`${mode}: ${lead}${JSON.stringify(u)}: ${best.toFixed(0)} ms`);
    }
  }
  expect(slow).toEqual([]);
}, 120_000);

// A here-document is one part a line. What a shell, another machine's shell or an interpreter is fed that way is
// read once per command, and one longer than the rules read through is high risk for its length alone: 20,000
// lines fed to bash held the loop for eleven seconds when each line looked back over the others.
test("a here-document of 100,000 lines is decided in step with its length, whoever it feeds", () => {
  const facts = (mode: "ask" | "full-auto") => ({ mode, workspace: "/w", sandboxed: false, tool: "Bash", home: "/h", rules: [] });
  const slow: string[] = [];
  const fed: [string, string][] = [["bash <<'EOF'", "touch a"], ["ssh host <<'EOF'", "touch a"], ["ssh host bash <<'EOF'", "rm -rf /srv/a"], ["python3 - <<'EOF'", "x = 1"], ["cat > f <<'EOF'", "some text"], ["psql <<'EOF'", "select 1;"],
    ["kubectl exec -i pod -- sh <<'EOF'", "touch a"], ["bash -s <<'EOF' | bash <<'EOF2'", "touch a"]];
  for (const [lead, line] of fed) for (const mode of ["ask", "full-auto"] as const) {
    const command = `${lead}\n${`${line}\n`.repeat(N)}EOF`;
    let best = Infinity, d: ReturnType<typeof decide> | undefined;
    // (The parser alone takes 200 to 400 ms on 100,000 lines, and several times that on a busy machine: the
    // bound is two seconds, which a square, minutes long at this size, cannot meet.)
    for (let k = 0; k < 6 && best > 40 * LIMIT; k++) { const t = performance.now(); d = decide({ kind: "shell", command, cwd: "/w" }, facts(mode)); best = Math.min(best, performance.now() - t); }
    if (best > 40 * LIMIT) slow.push(`${mode}: ${lead}: ${best.toFixed(0)} ms`);
    // Fed to a shell, here or there, it is longer than the rules read: high risk. Text for a file is data.
    const high = !!d && "ask" in d && d.ask.risk === "high";
    if (high !== !/^(cat|python3|psql)/.test(lead)) slow.push(`${mode}: ${lead}: ${high ? "high risk" : "not high risk"}`);
  }
  expect(slow).toEqual([]);
}, 120_000);
