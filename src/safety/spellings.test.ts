import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ifHolds } from "../integrations/hooks.ts";
import { matchRule, splitCommand } from "./shell.ts";

// A home with a folder `decoy` that holds the file a rule names, a link to that folder outside the home,
// and a session folder that is the home.
const made = realpathSync(mkdtempSync(join(tmpdir(), "keel-spell-")));
afterAll(() => rmSync(made, { recursive: true, force: true }));
const home = join(made, "home");
mkdirSync(join(home, "decoy"), { recursive: true });
writeFileSync(join(home, "decoy", "secret.txt"), "x\n");
writeFileSync(join(home, "decoy", "other.txt"), "y\n");
symlinkSync(join(home, "decoy"), join(made, "link"));
const cwd = home;

const deny = (rule: string, command: string) => ifHolds(rule, ["Bash"], { command }, cwd, home);
const rule = `Bash(cat ${home}/decoy/secret.txt)`;

// A deny or ask rule that names a path stops the path's other spellings too.
const SPELLINGS: [string, string][] = [
  ["a home spelling", "cat ~/decoy/secret.txt"],
  ["$HOME", "cat $HOME/decoy/secret.txt"],
  ["${HOME}", "cat ${HOME}/decoy/secret.txt"],
  ["relative with ./", "cat ./decoy/secret.txt"],
  ["relative to the session's folder", "cat decoy/secret.txt"],
  ["dot-dot", `cat ${home}/../${basename(home)}/decoy/secret.txt`],
  ["a doubled slash", `cat ${home}//decoy//secret.txt`],
  ["a link to the folder, by its real path", `cat ${join(made, "link")}/secret.txt`],
  ["a quoted path", `cat "$HOME/decoy/secret.txt"`],
  ["after another command", "ls ~ && cat ~/decoy/secret.txt"],
];
for (const [what, command] of SPELLINGS) test(`a deny rule naming a path also stops ${what}`, () => {
  expect(deny(rule, command)).toBe(true);
});

test("a rule written in another spelling holds for the absolute path, and a glob keeps its star", () => {
  expect(deny("Bash(cat ~/decoy/secret.txt)", `cat ${home}/decoy/secret.txt`)).toBe(true);
  expect(deny("Bash(cat ~/decoy/*)", "cat $HOME/decoy/other.txt")).toBe(true);
  expect(deny("Bash(cat ./decoy/*)", `cat ${home}/decoy/other.txt`)).toBe(true);
  expect(deny(`Bash(cat ${join(made, "link")}/*)`, `cat ${home}/decoy/other.txt`)).toBe(true);
});

test("other paths and other programs are not stopped by it", () => {
  for (const command of ["cat ~/decoy/other.txt", "cat $HOME/decoy/secret.txt.bak", "cat $OTHER/decoy/secret.txt", "cat ~/decoy", "ls ~/decoy/secret.txt", "cat decoy/secret.txt/x", `cat ${made}/decoy/secret.txt`])
    expect({ command, held: deny(rule, command) }).toEqual({ command, held: false });
});

test("a file tool's rule holds for the file's other spellings", () => {
  const file = (path: string) => ifHolds(`Edit(${home}/decoy/secret.txt)`, ["Edit"], { file_path: path }, cwd, home);
  expect(file("decoy/secret.txt")).toBe(true);
  expect(file(`${home}/../${basename(home)}/decoy/secret.txt`)).toBe(true);
  expect(file(`${join(made, "link")}/secret.txt`)).toBe(true);
  expect(file("decoy/other.txt")).toBe(false);
});

// An allow rule keeps its text match: a wider one would let more run.
test("an allow rule is not widened by the spellings", () => {
  const allow = `cat ${home}/decoy/secret.txt`;
  const on = (command: string) => splitCommand(command)!.some((p) => matchRule(allow, p));
  expect(on(`cat ${home}/decoy/secret.txt`)).toBe(true);
  for (const [, command] of SPELLINGS.slice(0, 8)) expect({ command, covered: on(command) }).toEqual({ command, covered: false });
});
