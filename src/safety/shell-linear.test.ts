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
import { isReadOnly, matchRule, risksOf, shimmedRead, suggestRule, type Simple } from "./shell.ts";
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
    "cat", "ssh -i", "mv", "mkfs.ext4", "git -C"];
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
    for (const lead of ["ls ", "rm -rf -"]) for (const mode of ["ask", "full-auto"] as const) {
      let best = Infinity;
      for (let k = 0; k < 3 && best > 5 * LIMIT; k++) { const t = performance.now(); decide({ kind: "shell", command: lead + body, cwd: "/w" }, facts(mode)); best = Math.min(best, performance.now() - t); }
      if (best > 5 * LIMIT) slow.push(`${mode}: ${lead}${JSON.stringify(u)}: ${best.toFixed(0)} ms`);
    }
  }
  expect(slow).toEqual([]);
}, 120_000);
