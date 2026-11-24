// The files a program is told to write by an option of its own: `git log --output=FILE`, `git format-patch -o DIR`,
// `sort -o FILE`. Each is a write by the rules a redirect to the same path gets (policy.ts writesOf, risk.ts overwrites,
// shared-branches.ts), so they are read here once. (curl, wget, tee, cp and mv have theirs where those rules read them.)

// git's options that take a value before the subcommand.
const GIT_GLOBAL_VALUED = /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/;
// The subcommands whose -o names the folder or the file they write.
const GIT_DASH_O = /^(format-patch|archive|bugreport|diagnose)$/;
const GIT_DIR_OPT = /^(format-patch|bugreport|diagnose)$/;

// `words`: the program and its arguments, the program first. `at` is the index of the word that names the path.
export function outputsOf(words: string[]): { to: string; at: number }[] {
  const prog = (words[0] ?? "").replace(/^.*\//, "");
  const out: { to: string; at: number }[] = [];
  if (prog === "git") {
    let i = 1;
    for (; i < words.length && words[i]!.startsWith("-"); i++) if (GIT_GLOBAL_VALUED.test(words[i]!)) i++;
    const sub = words[i];
    if (sub === undefined) return out;
    // Any subcommand that takes diff options (log, diff, show, blame, shortlog, diff-tree ...) writes to the file --output names.
    for (let k = i + 1; k < words.length; k++) {
      const a = words[k]!;
      if (a === "--") break;
      if (a.startsWith("--output=")) out.push({ to: a.slice(9), at: k });
      else if (a === "--output") { if (words[k + 1] !== undefined) out.push({ to: words[k + 1]!, at: k + 1 }); }
      else if (GIT_DIR_OPT.test(sub) && a.startsWith("--output-directory=")) out.push({ to: a.slice(19), at: k });
      else if (GIT_DIR_OPT.test(sub) && a === "--output-directory") { if (words[k + 1] !== undefined) out.push({ to: words[k + 1]!, at: k + 1 }); }
      else if (GIT_DASH_O.test(sub) && a === "-o") { if (words[k + 1] !== undefined) out.push({ to: words[k + 1]!, at: k + 1 }); }
      else if (GIT_DASH_O.test(sub) && /^-o./.test(a)) out.push({ to: a.slice(2), at: k });
    }
    // The bundle file is the first word after `create`.
    if (sub === "bundle" && words[i + 1] === "create") {
      const k = words.findIndex((a, j) => j > i + 1 && !a.startsWith("-"));
      if (k > 0) out.push({ to: words[k]!, at: k });
    }
    return out;
  }
  if (prog === "sort") {
    for (let k = 1; k < words.length; k++) {
      const a = words[k]!;
      if (a === "--") break;
      // (sort takes any abbreviation of a long option that only one option starts with: `--o`, `--out=`, `--outp`.)
      const long = /^--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(=|$)/.exec(a);
      if (long?.[1] === "=") out.push({ to: a.slice(a.indexOf("=") + 1), at: k });
      else if (long || /^-[a-zA-Z]*o$/.test(a)) { if (words[k + 1] !== undefined) out.push({ to: words[k + 1]!, at: k + 1 }); }
      else if (/^-o./.test(a)) out.push({ to: a.slice(2), at: k });
    }
  }
  return out;
}
