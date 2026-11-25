import { expect, test } from "bun:test";
import { launchMayRunShell, readerOf } from "./foreground.ts";
import { EMPTY, step, type Typing } from "./typed-lines.ts";

// The lines a series of writes completes, as `text` or `text?` for a line whose text is not known.
const run = (...writes: string[]) => {
  let at: Typing = EMPTY;
  const out: string[] = [];
  for (const w of writes) {
    const r = step(at, w);
    out.push(...r.lines.map((l) => (l.unsure ? `${l.text}?` : l.text)));
    at = r.next;
  }
  return out;
};

test("a line is complete at its Enter, from what earlier writes typed", () => {
  expect(run("ls\n")).toEqual(["ls"]);
  expect(run("ls -", "la")).toEqual([]);
  expect(run("ls -", "la\r", "pwd\r\n")).toEqual(["ls -la", "pwd"]);
  expect(run("a\nb\n\n")).toEqual(["a", "b"]);
});

test("editing keys change the line that runs", () => {
  expect(run("rm -rf x\x03ls\n")).toEqual(["ls"]);
  expect(run("rm -rf x\x15ls\n")).toEqual(["ls"]);
  expect(run("lsx\x7f\n")).toEqual(["ls"]);
  expect(run("rm -rf x ls\x17\x17\x17\n")).toEqual(["rm "]);
  expect(run("ab\x01X\n")).toEqual(["Xab"]);
  expect(run("ab\x1b[D\x1b[DX\x05Y\n")).toEqual(["XabY"]);
  expect(run("abc\x1b[D\x1b[3~\n")).toEqual(["ab"]);
  expect(run("abc\x02\x0b\n")).toEqual(["ab"]);
});

test("keys that bring text from elsewhere leave the line unknown", () => {
  expect(run("\x1b[A\n")).toEqual(["?"]);
  expect(run("ls ~/pro\t\n")).toEqual(["ls ~/pro?"]);
  expect(run("\x19\n")).toEqual(["?"]);
  expect(run("\x1bd\n")).toEqual(["?"]);
  expect(run("\x1b[1;5D\n")).toEqual(["?"]);
  // Ctrl-C drops the line, the unknown part with it.
  expect(run("\x1b[A\x03ls\n")).toEqual(["ls"]);
});

test("keys that touch no line complete none", () => {
  for (const k of ["\x03", "\x04", "\x1a", "\x1c", "\x0c", "\x1b[A", "\x1b[C", "\x1bOD"]) expect(run(k)).toEqual([]);
});

test("a bracketed paste holds its Enter keys as text", () => {
  expect(run("\x1b[200~a\nb\x1b[201~\n")).toEqual(["a\nb"]);
  expect(run("\x1b[200~a\n", "b\x1b[201~", "\n")).toEqual(["a\nb"]);
});

test("an escape sequence cut between writes is read whole", () => {
  expect(run("ab\x1b", "[D", "X\n")).toEqual(["aXb"]);
});

test("a program is read from its command line", () => {
  expect(readerOf(["bash", "--norc", "-i"], "/w")).toEqual({ kind: "shell", name: "bash", cwd: "/w" });
  expect(readerOf(["-bash"])).toMatchObject({ kind: "shell", name: "bash" });
  expect(readerOf(["/bin/zsh"])).toMatchObject({ kind: "shell", name: "zsh" });
  // A shell that runs a command or a script does not read the terminal's lines as commands.
  expect(readerOf(["bash", "-lc", "make"])).toMatchObject({ kind: "program" });
  expect(readerOf(["sh", "install.sh"])).toMatchObject({ kind: "program" });
  expect(readerOf(["python3", "-i"])).toEqual({ kind: "interpreter", name: "python3" });
  for (const p of ["node", "psql", "ssh", "docker", "vim", "gdb", "sqlite3"]) expect(readerOf([p]).kind).toBe("interpreter");
  expect(readerOf(["./installer", "--yes"])).toEqual({ kind: "program", name: "installer" });
  expect(readerOf(["cat"]).kind).toBe("program");
});

test("a write says whether it holds a paste's start", () => {
  expect(step(EMPTY, "ls\n").opens).toBe(false);
  expect(step(EMPTY, "\x1b[200~ls\n\x1b[201~").opens).toBe(true);
  expect(step(step(EMPTY, "\x1b[200~\n").next, "x\n").opens).toBe(true); // still open
  expect(step(step(step(EMPTY, "\x1b[200~a").next, "\x1b[201~").next, "ls\n").opens).toBe(false);
});

test("a launch that may come to run a shell is known by its command", () => {
  for (const c of ["wait 6; exec bash -i", "make && sh", "cat | less", "exec zsh", "bash install.sh", "sudo python3 setup.py", "echo $(date)"]) expect([c, launchMayRunShell(c)]).toEqual([c, true]);
  for (const c of ["cat", "sudo apt-get install foo", "npm init", "./configure --prefix=/usr 2>&1", "make test"]) expect([c, launchMayRunShell(c)]).toEqual([c, false]);
});
