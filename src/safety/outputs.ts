// The files a program is told to write by an option of its own: `git log --output=FILE`, `git format-patch -o DIR`,
// `sort -o FILE`. Each is a write by the rules a redirect to the same path gets (policy.ts writesOf, risk.ts overwrites,
// shared-branches.ts), so they are read here once. (tee, cp and mv have theirs where those rules read them.)

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
  if (prog === "curl" || prog === "wget") return fetchOutputs(prog, words);
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

// ---- curl and wget ----

// curl's short options that take a value (the rest of their cluster, else the next word), and the files each writes: -o the page,
// -D the headers, -c the cookies.
const CURL_VALUED = "AbcCdDeEFHKmoPQrtTuUwxXyYz";
const CURL_FILE_SHORT = "oDc";
const CURL_FILE_LONG = ["output", "dump-header", "cookie-jar", "trace", "trace-ascii", "stderr", "libcurl", "etag-save", "alt-svc", "hsts"];
// wget's: -O the page, -o and -a a log, -P the folder its files go into.
const WGET_VALUED = "aABDeIilOoPQRTtUwX";
const WGET_FILE_SHORT = "Ooa";
const WGET_FILE_LONG = ["output-document", "output-file", "append-output", "save-cookies", "rejected-log", "warc-file"];
// What a -e command of wget sets that writes: `-e output_document=FILE`.
const WGET_RC = /^\s*(output_document|logfile|dir_prefix|save_cookies)\s*=\s*(.+?)\s*$/i;

// A long option's name as given, `--out` for `--output`: any start of a name that is long enough to be one.
const longOf = (a: string, names: string[]): string | undefined => {
  const eq = a.indexOf("="), name = a.slice(2, eq < 0 ? undefined : eq);
  if (name.length < 3) return names.find((n) => n === name);
  return names.find((n) => n === name) ?? names.find((n) => n.startsWith(name));
};
// The page's file name a fetch of the address gets when it is told to keep the remote name (curl -O, wget by default).
const remoteName = (w: string): string | undefined => {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return undefined;
  const path = w.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base || undefined;
};

function fetchOutputs(prog: "curl" | "wget", words: string[]): { to: string; at: number }[] {
  const curl = prog === "curl";
  const valued = curl ? CURL_VALUED : WGET_VALUED, fileShort = curl ? CURL_FILE_SHORT : WGET_FILE_SHORT;
  const fileLong = curl ? CURL_FILE_LONG : WGET_FILE_LONG;
  const out: { to: string; at: number }[] = [];
  let dir: { to: string; at: number } | undefined, keep = false, named = false;
  // The server names the file (curl -J, wget --content-disposition), or a recursive download keeps the paths of the pages (wget -r -nd, -r -nH).
  let header = false, recursive = false, flat = false;
  const urls: string[] = [];
  const give = (to: string | undefined, at: number) => { if (to !== undefined && to !== "" && to !== "-") out.push({ to, at }); };
  for (let k = 1; k < words.length; k++) {
    const a = words[k]!;
    if (a === "--") { urls.push(...words.slice(k + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const value = (): { v?: string; at: number } => eq >= 0 ? { v: a.slice(eq + 1), at: k } : { v: words[k + 1], at: k + 1 };
      const w = longOf(a, fileLong);
      if (w) { const x = value(); give(x.v, x.at); if (eq < 0) k++; named = true; continue; }
      if (curl && (longOf(a, ["output-dir"]) || longOf(a, ["remote-name"]) || longOf(a, ["remote-name-all"]))) {
        if (longOf(a, ["output-dir"])) { const x = value(); if (x.v !== undefined) dir = { to: x.v, at: x.at }; if (eq < 0) k++; }
        else keep = true;
        continue;
      }
      if (curl && longOf(a, ["remote-header-name"])) { header = true; continue; }
      if (!curl && longOf(a, ["content-disposition"])) { header = true; continue; }
      if (!curl && longOf(a, ["recursive", "mirror"])) { recursive = true; continue; }
      if (!curl && longOf(a, ["no-directories", "no-host-directories"])) { flat = true; continue; }
      if (!curl && longOf(a, ["directory-prefix"])) { const x = value(); if (x.v !== undefined) dir = { to: x.v, at: x.at }; if (eq < 0) k++; continue; }
      if (!curl && longOf(a, ["execute"])) { const x = value(); const m = x.v ? WGET_RC.exec(x.v) : null; if (m) { if (/^dir_prefix$/i.test(m[1]!)) dir = { to: m[2]!, at: x.at }; else { give(m[2], x.at); named = true; } } if (eq < 0) k++; continue; }
      continue;
    }
    if (!a.startsWith("-") || a === "-") { urls.push(a); continue; }
    // A cluster of short options: the first one that takes a value takes the rest of the word, or the next word.
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (curl && c === "O") { keep = true; continue; }
      if (curl && c === "J") { header = true; continue; }
      if (!curl && !valued.includes(c)) { if (c === "r" || c === "m") recursive = true; else if (c === "n" && /^[dH]/.test(a.slice(j + 1))) flat = true; }
      if (!valued.includes(c)) continue;
      const rest = a.slice(j + 1), at = rest ? k : k + 1, v = rest || words[k + 1];
      if (fileShort.includes(c)) { give(v, at); named = true; }
      else if (!curl && c === "P") { if (v !== undefined) dir = { to: v, at }; }
      else if (!curl && c === "e") { const m = v ? WGET_RC.exec(v) : null; if (m) { if (/^dir_prefix$/i.test(m[1]!)) dir = { to: m[2]!, at }; else { give(m[2], at); named = true; } } }
      if (!rest) k++;
      break;
    }
  }
  // Where the files named by the address go: curl -O and wget without -O keep the remote name, in the folder it is told (-P, --output-dir).
  const joined = (name: string) => (dir ? `${dir.to.replace(/\/+$/, "")}/${name}` : name);
  if (keep || (!curl && !named)) for (const u of urls) { const n = remoteName(u); if (n) out.push({ to: joined(n), at: dir?.at ?? words.indexOf(u) }); }
  // A name the server gives, or a page's own path, is not known: the folder is written into (a name there that runs or lets someone in).
  if ((header && (keep || !curl)) || (!curl && recursive && flat)) { const at = dir?.at ?? Math.max(1, words.findIndex((w) => urls.includes(w))); out.push({ to: joined("*"), at }); }
  // curl puts a name it was given under the folder too (--output-dir).
  if (curl && dir) for (const o of out) if (!o.to.startsWith("/") && !o.to.startsWith("~") && !o.to.startsWith(dir.to)) o.to = `${dir.to.replace(/\/+$/, "")}/${o.to}`;
  return out;
}
