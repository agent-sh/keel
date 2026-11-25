// Which program reads a terminal's input now. A write to a terminal is typed into the program in the terminal's
// foreground, which is not always the program the job started: a shell started `python3` or `ssh`, and what is typed
// next is its input. The kernel names the foreground process group of a terminal; the processes of that group that
// have no child in it are the ones reading.
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";

export type Reader =
  // A shell reading commands from the terminal: each line typed is a command.
  | { kind: "shell"; name: string; cwd?: string }
  // A program that runs what it is typed as code: a language's prompt, a database client, a debugger, a remote login,
  // a container or cluster exec, an editor or pager with a shell escape.
  | { kind: "interpreter"; name: string }
  // Any other program: what is typed answers its prompt (an installer, a password, a pager's key).
  | { kind: "program"; name: string };

const SHELLS = /^(bash|sh|dash|ash|zsh|fish|ksh|mksh|pdksh|csh|tcsh|nu|xonsh)$/;
const INTERPRETERS = new RegExp("^(" + [
  "python[\\d.]*", "pypy[\\d]*", "ipython[\\d.]*", "bpython", "node(js)?", "bun", "deno", "tsx", "ts-node", "ruby", "irb", "pry", "perl", "php", "lua(jit)?", "R", "julia",
  "ghci", "sbcl", "clisp", "guile", "racket", "ocaml(?:find)?", "utop", "erl", "iex", "elixir", "clj", "scala", "jshell", "groovysh", "gdb", "lldb", "pdb", "expect",
  "psql", "mysql", "mariadb", "sqlite3", "mongosh?", "redis-cli", "cqlsh", "sqlcmd", "duckdb",
  "ssh", "mosh", "telnet", "nc", "ncat", "netcat", "socat", "ftp", "sftp", "adb", "docker", "podman", "kubectl", "nsenter", "chroot", "screen", "tmux", "minicom", "picocom",
  "vim?", "nvim", "emacs", "ed", "ex", "less", "more", "man",
].join("|") + ")$");

// Whether a shell's arguments leave it reading commands from the terminal: no `-c` command and no script file.
function readsTerminal(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return i + 1 >= args.length;
    if (a === "--rcfile" || a === "--init-file") { i++; continue; }
    if (a.startsWith("--")) continue;
    if (a.startsWith("-") || a.startsWith("+")) {
      if (a.startsWith("-") && a.includes("c")) return false;
      if (/[oO]/.test(a)) i++; // `-o name`, `-O shopt`
      continue;
    }
    return false; // a script file
  }
  return true;
}

// One program, by its command line.
export function readerOf(argv: string[], cwd?: string): Reader {
  const name = basename(argv[0] ?? "").replace(/^-/, "");
  if (SHELLS.test(name)) return readsTerminal(argv.slice(1)) ? { kind: "shell", name, ...(cwd ? { cwd } : {}) } : { kind: "program", name };
  if (INTERPRETERS.test(name)) return { kind: "interpreter", name };
  return { kind: "program", name };
}

// The program the terminal's input goes to now, and where it is. What is typed goes to the foreground's program, and
// what it does not read waits in the terminal for the shell below it (typed ahead), so a shell reading the terminal
// anywhere on it is a reader too. An interpreter outranks a shell, which outranks any other program (the strictest
// reading of what is typed). Nothing when the processes cannot be read.
export async function readerOfTerminal(pid: number): Promise<Reader | undefined> {
  const stat = async (p: number) => {
    try {
      const raw = await readFile(`/proc/${p}/stat`, "utf8");
      const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      return { pid: p, ppid: Number(f[1]), group: Number(f[2]), tty: Number(f[4]), fore: Number(f[5]) };
    } catch { return undefined; }
  };
  const lead = await stat(pid);
  if (!lead || !lead.tty || lead.fore <= 0) return undefined;
  let names: string[];
  try { names = await readdir("/proc"); } catch { return undefined; }
  const onTty = (await Promise.all(names.filter((n) => /^\d+$/.test(n)).map((n) => stat(Number(n))))).filter((x): x is NonNullable<typeof x> => !!x && x.tty === lead.tty);
  const fore = onTty.filter((x) => x.group === lead.fore);
  const parents = new Set(fore.map((x) => x.ppid));
  const leaf = new Set(fore.filter((x) => !parents.has(x.pid)).map((x) => x.pid));
  const found: { r: Reader; pid: number }[] = [];
  for (const p of onTty) {
    let argv: string[];
    try { argv = (await readFile(`/proc/${p.pid}/cmdline`, "utf8")).split("\0").filter((x, i, a) => x !== "" || i < a.length - 1); } catch { continue; }
    const cwd = await readlink(`/proc/${p.pid}/cwd`).catch(() => undefined);
    const r = readerOf(argv, cwd);
    if (leaf.has(p.pid) || r.kind === "shell") found.push({ r, pid: p.pid });
  }
  const rank = (r: Reader) => (r.kind === "interpreter" ? 0 : r.kind === "shell" ? 1 : 2);
  // (Among equals the newest, the innermost shell, whose folder is where its commands run.)
  return found.sort((a, b) => rank(a.r) - rank(b.r) || b.pid - a.pid)[0]?.r;
}
