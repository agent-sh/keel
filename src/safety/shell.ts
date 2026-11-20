// Shell command analysis for the permission gate: split a command line into
// the simple commands it runs, decide which are read-only, which are high
// risk, and whether a stored rule covers each one. Pure functions.

// One simple command: its words with quotes removed, and whether it writes
// through a redirection. `nested`: it runs inside a substitution, a subshell
// or a group, so a `cd` in it does not say where the commands after it run.
export type Simple = { words: string[]; text: string; redirects: boolean; nested?: true };

const OPS = ["&&", "||", "|&", ";;", ";", "|", "&", "\n"];

// Split on shell operators outside quotes. Command and process substitutions
// ($(...), `...`, <(...), >(...)) are analysed as commands of their own.
export function splitCommand(cmd: string): Simple[] | null {
  const out: Simple[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let text = "";
  let redirects = false;
  let depth = 0;
  const flushWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const flushCmd = () => {
    flushWord();
    // Leading control words (if, then, do, ...) and subshell parens are syntax, not commands.
    // `for x in ...` and `case ... in` headers run nothing themselves.
    if (/^(for|select|case)$/.test(words[0] ?? "")) words = [];
    while (words.length && /^(if|then|else|elif|fi|do|done|while|until|esac|\{|\}|!|time)$/.test(words[0]!)) words.shift();
    if (words.length) out.push({ words, text: text.trim(), redirects, ...(depth > 0 ? { nested: true as const } : {}) });
    words = [];
    text = "";
    redirects = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "\\" && i + 1 < cmd.length) {
      if (cmd[i + 1] === "\n") { i++; continue; }
      word += cmd[i + 1]; inWord = true; text += c + cmd[i + 1]; i++;
      continue;
    }
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return null;
      word += cmd.slice(i + 1, j); inWord = true; text += cmd.slice(i, j + 1); i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let inner = "";
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) { inner += cmd[j + 1]; j++; continue; }
        if (cmd[j] === "$" && cmd[j + 1] === "(") {
          const end = matchParen(cmd, j + 1);
          if (end < 0) return null;
          const sub = splitCommand(cmd.slice(j + 2, end));
          if (!sub) return null;
          out.push(...nestedIn(sub));
          inner += "$(...)"; j = end; continue;
        }
        if (cmd[j] === "`") {
          const end = cmd.indexOf("`", j + 1);
          if (end < 0) return null;
          const sub = splitCommand(cmd.slice(j + 1, end));
          if (!sub) return null;
          out.push(...nestedIn(sub));
          inner += "`...`"; j = end; continue;
        }
        inner += cmd[j];
      }
      if (j >= cmd.length) return null;
      word += inner; inWord = true; text += cmd.slice(i, j + 1); i = j;
      continue;
    }
    if ((c === "$" || c === "<" || c === ">") && cmd[i + 1] === "(") {
      const end = matchParen(cmd, i + 1);
      if (end < 0) return null;
      const sub = splitCommand(cmd.slice(i + 2, end));
      if (!sub) return null;
      out.push(...nestedIn(sub));
      word += "$(...)"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end < 0) return null;
      const sub = splitCommand(cmd.slice(i + 1, end));
      if (!sub) return null;
      out.push(...nestedIn(sub));
      word += "`...`"; inWord = true; text += cmd.slice(i, end + 1); i = end;
      continue;
    }
    if (c === "#" && !inWord) {
      const nl = cmd.indexOf("\n", i);
      i = nl < 0 ? cmd.length : nl - 1;
      continue;
    }
    const op = OPS.find((o) => cmd.startsWith(o, i));
    if (op && !(op === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">"))) {
      flushCmd();
      i += op.length - 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      if (!inWord) { flushCmd(); depth = Math.max(0, depth + (c === "(" || c === "{" ? 1 : -1)); continue; }
    }
    if (c === ">" || c === "<") {
      // A redirection: `>file`, `>> file`, `2>&1`, `&>file`, `<file`.
      const fd = inWord && /^\d+$/.test(word) ? word : "";
      if (fd) { word = ""; inWord = false; }
      else flushWord();
      let j = i + 1;
      if (cmd[j] === ">" || cmd[j] === "|") j++;
      if (cmd[j] === "&") {
        j++;
        while (j < cmd.length && /[\d-]/.test(cmd[j]!)) j++;
        text += cmd.slice(i, j); i = j - 1;
        continue;
      }
      while (cmd[j] === " ") j++;
      let target = "";
      while (j < cmd.length && !/[\s;&|<>()]/.test(cmd[j]!)) target += cmd[j++];
      if (c === ">" && !/^\/dev\/(null|stdout|stderr)$/.test(target.replace(/^["']|["']$/g, ""))) redirects = true;
      text += cmd.slice(i, j); i = j - 1;
      continue;
    }
    if (c === " " || c === "\t") {
      flushWord();
      text += c;
      continue;
    }
    word += c; inWord = true; text += c;
  }
  flushCmd();
  return out;
}

const nestedIn = (sub: Simple[]): Simple[] => sub.map((s) => ({ ...s, nested: true as const }));

function matchParen(s: string, open: number): number {
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === "\\") i++; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

// Words after leading VAR=value assignments.
const body = (w: string[]) => {
  let i = 0;
  while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!)) i++;
  return { env: i > 0, words: w.slice(i) };
};

const READ_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "fd", "pwd", "echo", "printf", "which", "type",
  "file", "stat", "du", "df", "tree", "uniq", "cut", "tr", "diff", "cmp", "jq", "basename", "dirname", "realpath",
  "readlink", "date", "whoami", "id", "uname", "true", "false", "test", "[", "cd", "nl", "column",
  "sha256sum", "md5sum", "free", "uptime", "nproc", "lsof", "ps", "printenv",
]);
const GIT_READ = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "grep", "describe", "shortlog",
  "cat-file", "merge-base", "rev-list", "reflog", "whatchanged", "name-rev", "for-each-ref", "check-ignore",
]);

// uniq [OPTION]... [INPUT [OUTPUT]]: its operands, past the options that take a value.
function uniqOperands(args: string[]): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return n + args.length - i - 1;
    if (/^-[fsw]$/.test(a)) { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    n++;
  }
  return n;
}

// A command that cannot change anything (files, processes, the network state).
export function isReadOnly(s: Simple): boolean {
  if (s.redirects) return false;
  const { env, words } = body(s.words);
  if (env || !words.length) return !words.length && !env;
  const [prog, ...args] = words;
  if (prog === "env" || prog === "hostname") return args.length === 0; // `env CMD` runs CMD; `hostname X` sets it
  if (prog === "find") return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a));
  if (prog === "sort") return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output") || a.startsWith("--compress-program"));
  // Flags that run another program or write a file.
  if (prog === "rg") return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a));
  if (prog === "fd") return !args.some((a) => /^-[a-zA-Z]*[xX]/.test(a) || /^--exec(-batch)?(=|$)/.test(a));
  if (prog === "tree") return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output"));
  if (prog === "uniq") return uniqOperands(args) <= 1; // a second operand is the file it writes
  if (prog === "file") return !args.some((a) => /^-[a-zA-Z]*C/.test(a) || a === "--compile");
  if (prog === "sed") return !args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a) || /(^|[;}\s\d\/])[wWe](\s|$)/.test(a));
  if (prog === "git") {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
      if (args[i] === "-c" || args[i] === "--exec-path" || args[i]!.startsWith("--config")) return false;
      if (args[i] === "-C") i++;
      i++;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (rest.some((a) => a.startsWith("--output") || a === "--ext-diff")) return false;
    // git grep -O / --open-files-in-pager runs the pager it names on the hits.
    if (sub === "grep" && rest.some((a) => /^-[a-zA-Z]*O/.test(a) || a.startsWith("--open-files-in-pager"))) return false;
    if (sub === "branch") return rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--show-current|--contains|--merged|--no-merged)$/.test(a) || !a.startsWith("-") && rest.includes("--list"));
    if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "get-url";
    if (sub === "tag") return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "config") return rest[0] === "--get" || rest[0] === "--list" || rest[0] === "-l";
    return !!sub && GIT_READ.has(sub);
  }
  return READ_PROGRAMS.has(prog!);
}

// Why a command is dangerous enough that no standing answer may cover it,
// in every mode. null when it is not.
export function highRisk(s: Simple): string | null {
  const { words } = body(s.words);
  const [prog, ...args] = words;
  if (!prog) return null;
  if (prog === "sudo" || prog === "doas" || prog === "pkexec") return "runs as root";
  if (prog === "rm") {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    const targets = args.filter((a) => !a.startsWith("-"));
    const wide = targets.find((t) => /^(\/|~|~\/|\$HOME\/?|\.\.?\/?|\*|\/\*|~\/\*|\$HOME\/\*)$/.test(t) || /^\/(home|etc|usr|var|bin|lib|boot|opt|root)\/?$/.test(t));
    if (recursive && wide) return `deletes ${wide} recursively`;
    if (args.includes("--no-preserve-root")) return "deletes the root directory";
  }
  if (prog === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (sub === "push" && args.some((a) => a === "--force" || a === "-f" || a.startsWith("--force") || a === "--mirror" || /^\+/.test(a) || a === "--delete" || a === "-d" || /^:./.test(a)))
      return "rewrites or deletes history on a remote";
    if (sub === "reset" && args.includes("--hard")) return "discards uncommitted work";
    if (sub === "clean" && args.some((a) => /^-[a-zA-Z]*f/.test(a))) return "deletes untracked files";
    if (sub === "checkout" && args.includes("--") && args.includes(".")) return "discards uncommitted work";
    if (sub === "restore" && args.includes(".") && !args.includes("--staged")) return "discards uncommitted work";
  }
  if (/^mkfs/.test(prog) || prog === "wipefs" || prog === "fdisk" || prog === "parted") return "formats or repartitions a disk";
  if (prog === "dd" && args.some((a) => /^of=\/dev\/(?!(null|stdout|stderr)$)/.test(a))) return "writes a raw device";
  if ((prog === "chmod" || prog === "chown") && args.some((a) => /^-[a-zA-Z]*R/.test(a)) && args.some((a) => /^(\/|~|\$HOME)\/?$/.test(a))) return "changes ownership or modes of a whole tree";
  if (prog === "shutdown" || prog === "reboot" || prog === "poweroff" || prog === "halt") return "stops the machine";
  return null;
}

const FETCHERS = new Set(["curl", "wget", "aria2c", "http", "xh"]);
const RUNNERS = /^(sh|bash|zsh|dash|ksh|fish|python3?|perl|ruby|node|bun|deno)$/;

// What makes the whole line high risk beyond its parts: a script fetched from
// the network and run by a shell or interpreter that reads it from a pipe or
// a substitution (curl URL | sh, bash <(curl URL), sh -c "$(curl URL)").
export function lineRisk(parts: Simple[]): string | null {
  const fetches = parts.some((p) => FETCHERS.has(body(p.words).words[0] ?? ""));
  if (!fetches) return null;
  const runs = parts.some((p) => {
    const [prog, ...args] = body(p.words).words;
    if (!prog || !RUNNERS.test(prog)) return false;
    const operands = args.filter((a) => !a.startsWith("-") || a === "-");
    return !operands.length || operands.includes("-") || args.includes("-s") || args.some((a) => a.includes("$(...)") || a.includes("`...`"));
  });
  return runs ? "runs a downloaded script" : null;
}

// Every reason the line is high risk: each part's, and the line's own.
export const risksOf = (parts: Simple[]): string[] => [...new Set([...parts.map(highRisk), lineRisk(parts)].filter((r): r is string => !!r))];

// A rule pattern in Claude Code's form: `git log *` matches `git log` and
// anything after it; a pattern without `*` matches exactly. `*` elsewhere
// stands for any text.
export function matchRule(pattern: string, s: Simple): boolean {
  const { words } = body(s.words);
  const cmd = words.join(" ");
  const p = pattern.trim().replace(/:\*$/, " *");
  if (!p.includes("*")) return cmd === p;
  if (p.endsWith(" *") && p.indexOf("*") === p.length - 1) {
    const pre = p.slice(0, -2);
    return cmd === pre || cmd.startsWith(pre + " ");
  }
  const re = new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(cmd);
}

const MULTI = new Set(["git", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "cargo", "go", "docker", "podman", "kubectl", "gh", "uv", "pip", "python", "python3", "make", "systemctl", "brew", "apt", "deno", "rustup", "terraform", "aws"]);

// The rule "allow always" suggests for a command: the program and its
// subcommand, then `*`.
export function suggestRule(s: Simple): string {
  const { words } = body(s.words);
  const [prog, second] = words;
  if (!prog) return s.text;
  if (second && MULTI.has(prog) && /^[a-z][\w:.-]*$/i.test(second) && !second.includes("/")) return `${prog} ${second} *`;
  return `${prog} *`;
}
