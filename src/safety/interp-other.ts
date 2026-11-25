// The other programs that run code or commands given to them, read as interp-code.ts reads python and node: lua, awk, R,
// PowerShell, Tcl, the sqlite3 shell, vim, emacs and gdb. Pure: the send scan (provenance.ts) turns the answer into reaches.
//
// What a program is given is split by `planOf` (its options: where its code is, what is a file it reads, what stands on its
// input); what the code does is read by `readAny`, to the same answer as readCode: `net` (a library or a call that opens a
// connection), `hosts` (the places it spells a connection to), `lines` (the commands it starts, each read as a command of the
// line) and `opaque` (a command, a name or code the text does not say). A form that only reads a local file or runs a local
// program is none of them.
//
// The cost is bounded by the text, as there: markers are found by one pass of a regular expression with no nested repeats,
// a quoted piece is read at most 8 KiB past its start, and past 256 calls the rest is opaque.
import { CAP, DEPTH, REGION, argsAt, joined, lineOf, quoted, readCode, urlArg, type CodeRead, type Fam, type Family } from "./interp-code.ts";

export type Other = "lua" | "awk" | "r" | "pwsh" | "tcl" | "sqlite" | "vim" | "emacs" | "gdb";
export type Lang = Family | Other;
export type Read = CodeRead & { hosts: string[] };

export function otherOf(prog: string): Other | null {
  if (/^(?:lua[0-9.]*|luajit[0-9.-]*)$/.test(prog)) return "lua";
  if (/^(?:awk|gawk|mawk|nawk|original-awk)$/.test(prog)) return "awk";
  if (prog === "Rscript" || prog === "R") return "r";
  if (/^(?:pwsh|pwsh-preview|powershell)$/.test(prog)) return "pwsh";
  if (/^tclsh[0-9.]*$/.test(prog)) return "tcl";
  if (/^sqlite3?$/.test(prog)) return "sqlite";
  if (/^(?:vim|vi|nvim|ex|view|vimdiff|gvim|rvim|rview)$/.test(prog)) return "vim";
  if (/^emacs(?:client)?(?:-nox|-gtk|-x11)?$/.test(prog)) return "emacs";
  if (/^gdb(?:-multiarch)?$/.test(prog)) return "gdb";
  return null;
}

const fresh = (code: string, view: string[]): Read => ({ text: view.length ? view : [code], net: false, lines: [], opaque: false, hosts: [] });
const viewOf = (code: string): string[] => { const flat = joined(code); return flat === code ? [code] : [code, flat]; };
const BARE_SHELL = /^(?:ba|z|da|k)?sh$/;
// A command line that a shell would run on what comes next (code given to it on its input): not read here.
function addLine(res: Read, line: string | null): void {
  if (line === null) return;
  if (BARE_SHELL.test(line.trim())) res.opaque = true; else res.lines.push(line);
}

// What the language runs and reaches by a name the text does not give: any table of the language mentioned as a value.
export function readAny(fam: Lang, code: string, depth = 0): Read {
  switch (fam) {
    case "lua": return readLua(code, depth);
    case "awk": return readAwk(code);
    case "r": return readR(code, depth);
    case "pwsh": return readPwsh(code, depth);
    case "tcl": return readTcl(code, depth);
    case "sqlite": return readSqlite(code);
    case "vim": return readVim(code, depth);
    case "emacs": return readElisp(code);
    case "gdb": return readGdb(code);
    default: return { ...readCode(code, fam, depth), hosts: [] };
  }
}

const merge = (res: Read, inner: Read): void => {
  res.net ||= inner.net;
  res.opaque ||= inner.opaque;
  res.text.push(...inner.text);
  res.lines.push(...inner.lines);
  res.hosts.push(...inner.hosts);
};

// ---- calls written as name(args) ----

// Each call of a name: its arguments written out give the line (or the argument list) it runs; a name mentioned with no call,
// or arguments built from what the text does not say, are unread. `pick` turns the pieces into the line.
function calls(code: string, fam: Fam, names: RegExp, res: Read, pick: (lits: string[], name: string) => string | null = lineOf): void {
  let n = 0;
  let skip = 0;
  for (const m of code.matchAll(names)) {
    if (m.index! < skip) continue;
    if (++n > CAP) { res.opaque = true; return; }
    let j = m.index! + m[0].length;
    skip = j;
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
    const c = code[j];
    if (!(c === "(" || c === '"' || c === "'" || c === "`" || c === "[")) { res.opaque = true; continue; }
    const a = argsAt(code, j, fam);
    if (!a.ok) { res.opaque = true; continue; }
    addLine(res, pick(a.lits, m[0]));
  }
}

// ---- lua ----

// A long string [[...]] written as a quoted one (a level of up to eight =), in one pass.
function longStrings(code: string): string {
  if (!code.includes("[")) return code;
  const closed = new Set<number>();
  let out = "";
  let i = 0;
  let last = 0;
  while (i < code.length) {
    const k = code.indexOf("[", i);
    if (k < 0) break;
    let e = k + 1;
    while (code[e] === "=" && e - k <= 9) e++;
    if (code[e] !== "[" || e - k > 9) { i = k + 1; continue; }
    const level = e - k - 1;
    if (closed.has(level)) { i = e + 1; continue; }
    const close = `]${"=".repeat(level)}]`;
    const end = code.indexOf(close, e + 1);
    if (end < 0) { closed.add(level); i = e + 1; continue; }
    out += code.slice(last, k) + JSON.stringify(code.slice(e + 1, end));
    last = i = end + close.length;
  }
  return out + code.slice(last);
}

const LUA_NET = /\b(?:socket|copas|lcurl|cURL|luasec|ltn12|nixio)\b|\brequire\s*\(?\s*["'](?:ssl|resty|http|lanes)[\w.]*["']/;
const LUA_NAMES = /\b(?:os\.execute|io\.popen|os\.spawn|posix\.(?:exec|execp|spawn|system|popen|fork)|process\.(?:exec|spawn)|sh\.\w+)\b/g;
const LUA_DYN = /\b(?:_G|_ENV|getfenv|setfenv|debug)\b|\b(?:os|io)\s*\[|[=,(]\s*(?:os|io)\s*(?:[,)\n;]|$)|\brequire\s*\(?\s*["'](?:os|io)["']/;
const LUA_LOAD = /(?<![\w.:])(?:load|loadstring|dofile|loadfile|require)\b/g;

function readLua(code: string, depth: number): Read {
  const src = longStrings(code);
  const view = viewOf(src);
  const res = fresh(src, view);
  res.net = view.some((t) => LUA_NET.test(t)) || urlArg(view);
  if (view.some((t) => LUA_DYN.test(t))) res.opaque = true;
  // (os.execute and io.popen take a command line and then a mode or nothing; the posix calls take a program and its arguments.)
  calls(src, "lua", LUA_NAMES, res, (lits, name) => (/^(?:os\.execute|io\.popen|os\.spawn)$/.test(name) ? lits[0] ?? null : lineOf(lits)));
  let n = 0;
  for (const m of src.matchAll(LUA_LOAD)) {
    if (++n > CAP) { res.opaque = true; break; }
    let j = m.index! + m[0].length;
    while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
    const c = src[j];
    if (!(c === "(" || c === '"' || c === "'")) { if (m[0] !== "require") res.opaque = true; continue; }
    const a = argsAt(src, j, "lua");
    const what = a.lits[0];
    if (!a.ok || a.lits.length < 1) { res.opaque = true; continue; }
    if (m[0] === "load" || m[0] === "loadstring") {
      if (depth + 1 >= DEPTH) res.opaque = true; else merge(res, readLua(what!, depth + 1));
    }
  }
  return res;
}

// ---- awk ----

type Tok = { t: "str" | "id" | "op" | "nl"; v: string };
function awkTokens(code: string): Tok[] | null {
  const out: Tok[] = [];
  const n = code.length;
  let i = 0;
  while (i < n) {
    const c = code[i]!;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") { out.push({ t: "nl", v: c }); i++; continue; }
    if (c === "#") { while (i < n && code[i] !== "\n") i++; continue; }
    if (c === '"') {
      const q = quoted(code, i, Math.min(n, i + REGION), "awk", "");
      if (!q) return null;
      out.push({ t: "str", v: q.text });
      i = q.end;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(c)) { let e = i + 1; while (e < n && /\w/.test(code[e]!)) e++; out.push({ t: "id", v: code.slice(i, e) }); i = e; continue; }
    if (c === "|") {
      if (code[i + 1] === "&") { out.push({ t: "op", v: "|&" }); i += 2; } else if (code[i + 1] === "|") { out.push({ t: "op", v: "||" }); i += 2; } else { out.push({ t: "op", v: "|" }); i++; }
      continue;
    }
    out.push({ t: "op", v: c });
    i++;
  }
  return out;
}

const INET = /\/inet[46]?\//g;
const INET_FULL = /\/inet[46]?\/(?:tcp|udp|raw)\/[^/"\s]*\/([^/"\s]+)\/[^"\s)]+/g;

function readAwk(code: string): Read {
  const view = viewOf(code);
  const res = fresh(code, view);
  // gawk's network files: /inet/tcp/LOCALPORT/HOST/PORT.
  let all = 0;
  for (const _ of code.matchAll(INET)) all++;
  let full = 0;
  for (const m of code.matchAll(INET_FULL)) { full++; res.hosts.push(m[1]!); }
  if (all > full) res.opaque = true;
  const toks = awkTokens(code);
  if (!toks) { res.opaque = true; return res; }
  let printing = false;
  let n = 0;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.t === "nl" || (t.t === "op" && (t.v === ";" || t.v === "{" || t.v === "}"))) { printing = false; continue; }
    if (t.t === "id" && (t.v === "print" || t.v === "printf")) { printing = true; continue; }
    if (t.t === "id" && t.v === "system") {
      if (++n > CAP) { res.opaque = true; return res; }
      const open = toks[k + 1];
      if (!open || open.t !== "op" || open.v !== "(") { res.opaque = true; continue; }
      let j = k + 2;
      let lit = "";
      let ok = true;
      let depth = 0;
      for (; j < toks.length; j++) {
        const u = toks[j]!;
        if (u.t === "op" && u.v === "(") { depth++; continue; }
        if (u.t === "op" && u.v === ")") { if (depth === 0) break; depth--; continue; }
        if (u.t === "str") lit += u.v; else { ok = false; break; }
      }
      if (!ok || j >= toks.length) res.opaque = true; else if (lit) addLine(res, lit);
      continue;
    }
    if (t.t === "op" && (t.v === "|" || t.v === "|&")) {
      if (++n > CAP) { res.opaque = true; return res; }
      const next = toks[k + 1];
      if (next?.t === "id" && next.v === "getline") {
        let j = k - 1;
        if (toks[j]?.t === "op" && toks[j]!.v === ")") j--;
        let lit = "";
        let any = false;
        while (j >= 0 && toks[j]!.t === "str") { lit = toks[j]!.v + lit; any = true; j--; }
        const before = toks[j];
        if (!any || (before && (before.t === "id" || (before.t === "op" && (before.v === ")" || before.v === "]"))))) res.opaque = true;
        else addLine(res, lit);
      } else if (printing) {
        let j = k + 1;
        if (toks[j]?.t === "op" && toks[j]!.v === "(") j++;
        let lit = "";
        let any = false;
        while (j < toks.length && toks[j]!.t === "str") { lit += toks[j]!.v; any = true; j++; }
        const after = toks[j];
        if (!any || (after && (after.t === "id" || (after.t === "op" && after.v === "$")))) res.opaque = true;
        else addLine(res, lit);
      }
    }
  }
  return res;
}

// ---- R ----

const R_NET = /\b(?:download\.file|download\.packages|socketConnection|make\.socket|read\.socket|write\.socket|curl_\w+|RCurl|getURL|postForm|sendmailR|mailR|blastula|gmailr|httr2?)\b|\b(?:curl|ssh|httr2?)::|(?<![\w.$@])url\s*\(/;
const R_NAMES = /(?<![\w.$@])(?:(?:base|utils)::)?(?:system2?|shell|shell\.exec|pipe)\b|(?<![\w.$@])(?:sys|processx)::(?:exec_\w+|run)\b|(?<![\w.$@])exec_(?:wait|background|internal)\b/g;
const R_DYN = /(?<![\w.$@])(?:do\.call|match\.fun|getFromNamespace|get|mget|Reduce)\s*\(\s*["'](?:base::|utils::)?(?:system2?|shell|pipe|download\.file|url|socketConnection)["']|\b(?:callr|processx)::\w+|\.Internal\s*\(/;
const R_CODE = /(?<![\w.$@])(?:parse|py_run_string|py_eval|source_url|devtools::source_url)\s*\(/g;

function readR(code: string, depth: number): Read {
  const src = code.replace(/(?<![\w.$@])(?:c|list)\s*\(/g, "(");
  const view = viewOf(src);
  const res = fresh(src, view);
  res.net = view.some((t) => R_NET.test(t)) || urlArg(view);
  if (view.some((t) => R_DYN.test(t))) res.opaque = true;
  // (system, shell and pipe take a command line and then flags; system2 and the sys and processx calls, a program and its arguments.)
  calls(src, "r", R_NAMES, res, (lits, name) => (/(?:system|shell|shell\.exec|pipe)$/.test(name) ? lits[0] ?? null : lineOf(lits)));
  let n = 0;
  for (const m of src.matchAll(R_CODE)) {
    if (++n > CAP) { res.opaque = true; break; }
    const j = m.index! + m[0].length - 1;
    const a = argsAt(src, j, "r");
    const text = a.lits.find((l) => l.length > 0);
    if (!a.ok || text === undefined) { res.opaque = true; continue; }
    if (m[0].startsWith("source_url") || m[0].startsWith("devtools")) continue;
    if (depth + 1 >= DEPTH) { res.opaque = true; continue; }
    if (m[0].startsWith("py_")) merge(res, { ...readCode(text, "python", depth + 1), hosts: [] }); else merge(res, readR(text, depth + 1));
  }
  return res;
}

// ---- PowerShell ----

const PWSH_NET = /(?<![\w-])(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|Send-MailMessage|Test-NetConnection|New-PSSession|Enter-PSSession|Invoke-Command|icm|Resolve-DnsName|Connect-\w+|Send-\w+)(?![\w-])|Net\.(?:WebClient|Sockets)|System\.Net|TcpClient|UdpClient|HttpClient|WebRequest|Socket\b/i;
const PWSH_PROGS = new Set(["nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp", "lftp", "mosh", "rclone", "socat", "openssl", "git", "gh", "curl", "wget", "xh", "http", "https", "aria2c", "bash", "sh", "zsh", "dash", "python", "python3", "node", "perl", "ruby", "php", "pwsh", "powershell", "lua", "awk", "gawk", "sqlite3", "vim", "nvim", "emacs", "gdb", "tclsh", "Rscript", "R"]);
const PWSH_CMDLETS = /(?<![\w-])(Start-Process|saps|Invoke-Expression|iex)(?![\w-])/gi;
const PWSH_VALUED = /^(?:verb|workingdirectory|redirectstandard\w+|windowstyle|credential|environment|wd|v)$/;

type PW = { v: string; dyn: boolean; quoted: boolean };
// The words of the statement that starts at `i`: it ends at ; a new line, a pipe, a closing brace, or the end.
function pwshWords(s: string, i: number): { words: PW[]; dyn: boolean; end: number } {
  const words: PW[] = [];
  let dyn = false;
  const lim = Math.min(s.length, i + REGION);
  while (i < lim && words.length < 64) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === ",") { i++; continue; }
    if (c === "`" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "}") break;
    if (c === "@" && s[i + 1] === "(") { i += 2; if (s[i] !== "'" && s[i] !== '"' && s[i] !== ")") dyn = true; continue; }
    if (c === "(" || c === "{" || (c === "$" && s[i + 1] === "(")) { i += c === "$" ? 2 : 1; if (c !== "{" && s[i] !== "'" && s[i] !== '"' && s[i] !== ")") dyn = true; if (c === "{") dyn = true; continue; }
    if (c === ")" || c === "]") { i++; continue; }
    if (c === "'" || c === '"') {
      const q = quoted(s, i, lim, "pwsh", "");
      if (!q) { dyn = true; i = lim; break; }
      words.push({ v: q.text, dyn: q.dyn, quoted: true });
      i = q.end;
      continue;
    }
    let e = i;
    while (e < lim && !/[\s,;|(){}"']/.test(s[e]!)) e++;
    if (e === i) { i++; continue; }
    const v = s.slice(i, e);
    words.push({ v, dyn: v.includes("$"), quoted: false });
    i = e;
  }
  return { words, dyn, end: i };
}

const exeless = (w: string): string => w.replace(/\.exe$/i, "");

// The statements of the code, each with its first word: split at ; a new line, a pipe and a brace, outside quotes.
function pwshStatements(code: string, res: Read): void {
  const n = code.length;
  let i = 0;
  let start = 0;
  let count = 0;
  const flush = (end: number) => {
    let text = code.slice(start, end).trim();
    start = end + 1;
    if (!text) return;
    if (++count > CAP) { res.opaque = true; return; }
    let called = false;
    for (let g = 0; g < 3 && (/^[&.]\s/.test(text) || /^&[$("'a-z]/i.test(text)); g++) { text = text.replace(/^[&.]\s*/, ""); called = true; }
    if (/^&/.test(text)) { res.opaque = true; return; }
    if (/^[$(]/.test(text) && called) { res.opaque = true; return; }
    const first = /^(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(text);
    const word = exeless((first?.[1] ?? first?.[2] ?? first?.[3] ?? "").replace(/^.*[\\/]/, ""));
    if (PWSH_PROGS.has(word) || PWSH_PROGS.has(word.toLowerCase())) addLine(res, text);
  };
  while (i < n) {
    const c = code[i]!;
    if (c === "'" || c === '"') {
      const q = quoted(code, i, Math.min(n, i + REGION), "pwsh", "");
      if (!q) { res.opaque = true; return; }
      i = q.end;
      continue;
    }
    if (c === "`") { i += 2; continue; }
    if (c === "\n" || c === ";" || c === "|" || c === "{" || c === "}") { flush(i); i++; continue; }
    i++;
  }
  flush(n);
}

function readPwsh(code: string, depth: number): Read {
  const view = viewOf(code);
  const res = fresh(code, view);
  res.net = view.some((t) => PWSH_NET.test(t)) || urlArg(view);
  pwshStatements(code, res);
  let n = 0;
  for (const m of code.matchAll(PWSH_CMDLETS)) {
    if (++n > CAP) { res.opaque = true; break; }
    const i = m.index! + m[0].length;
    const name = m[1]!.toLowerCase();
    if (name === "invoke-expression" || name === "iex") {
      let j = i;
      while (code[j] === " " || code[j] === "\t") j++;
      const q = code[j] === "'" || code[j] === '"' ? quoted(code, j, Math.min(code.length, j + REGION), "pwsh", "") : null;
      if (!q || q.dyn || depth + 1 >= DEPTH) res.opaque = true; else merge(res, readPwsh(q.text, depth + 1));
      continue;
    }
    // Start-Process FILE ARGS: the program and its arguments are the command it runs.
    const st = pwshWords(code, i);
    if (st.dyn) { res.opaque = true; continue; }
    let file: string | undefined;
    const args: string[] = [];
    let mode = "";
    let bad = false;
    for (const w of st.words) {
      if (!w.quoted && /^-[A-Za-z]/.test(w.v)) {
        const p = w.v.slice(1).toLowerCase();
        mode = "filepath".startsWith(p) ? "file" : "argumentlist".startsWith(p) || p === "args" ? "args" : PWSH_VALUED.test(p) ? "skip" : "";
        continue;
      }
      if (w.dyn) { bad = true; continue; }
      if (mode === "skip") { mode = ""; continue; }
      if (mode === "file" || (mode === "" && file === undefined)) { file = w.v; if (mode === "file") mode = ""; continue; }
      args.push(w.v);
    }
    if (bad || file === undefined) { res.opaque = true; continue; }
    const prog = exeless(file);
    const line = /^cmd$/i.test(prog) && /^\/[ck]$/i.test(args[0] ?? "") ? args.slice(1).join(" ") : [prog, ...args].join(" ");
    addLine(res, line);
  }
  return res;
}

// ---- Tcl ----

const TCL_NET = /\b(?:http|tls|smtp|ftp|pop3|curl|irc|ldap)::\w+|\bpackage\s+require\s+(?:-exact\s+)?(?:http|tls|smtp|ftp|ldap|pop3|nntp|irc|TclCurl|curl)\b/;
const TCL_CALLS = /(?<![\w:$.-])(exec|spawn|socket|open)\s/g;
const TCL_EVAL = /(?<![\w:$.-])(?:eval|uplevel(?:\s+#?\d+)?|subst|interp\s+eval\s+\S+)\s+(?:[$[]|"[^"]*[$[])|(?:^|[;\n])[ \t]*\$\w+[ \t]/;

type TW = { v: string; dyn: boolean };
// The words of a Tcl command from `i`: to a new line, a semicolon, or the close of the bracket or brace it stands in.
function tclWords(s: string, i: number): TW[] {
  const out: TW[] = [];
  const lim = Math.min(s.length, i + REGION);
  while (i < lim && out.length < 128) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\\" && s[i + 1] === "\n") { i += 2; continue; }
    if (c === "\n" || c === ";" || c === "]" || c === "}") break;
    if (c === "{") {
      if (s.startsWith("{*}", i)) { out.push({ v: "", dyn: true }); break; }
      let d = 0;
      let j = i;
      for (; j < lim; j++) {
        if (s[j] === "\\") { j++; continue; }
        if (s[j] === "{") d++; else if (s[j] === "}" && --d === 0) break;
      }
      if (j >= lim) { out.push({ v: "", dyn: true }); break; }
      out.push({ v: s.slice(i + 1, j), dyn: false });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const q = quoted(s, i, lim, "tcl", "");
      if (!q) { out.push({ v: "", dyn: true }); break; }
      out.push({ v: q.text, dyn: q.dyn });
      i = q.end;
      continue;
    }
    let e = i;
    while (e < lim && !/[\s;\]]/.test(s[e]!)) e++;
    const v = s.slice(i, e);
    out.push({ v, dyn: /[$[]/.test(v) });
    i = e;
  }
  return out;
}

const TCL_REDIR = /^(?:\d?>>?&?|>&|<<?|&>|\|&?|&)(?:@\S*)?$/;

function readTcl(code: string, depth: number): Read {
  void depth;
  const view = viewOf(code);
  const res = fresh(code, view);
  res.net = view.some((t) => TCL_NET.test(t)) || urlArg(view);
  if (view.some((t) => TCL_EVAL.test(t))) res.opaque = true;
  let n = 0;
  for (const m of code.matchAll(TCL_CALLS)) {
    if (++n > CAP) { res.opaque = true; break; }
    const words = tclWords(code, m.index! + m[0].length);
    const name = m[1]!;
    if (name === "open") {
      const w = words[0];
      if (!w) continue;
      if (/^\|/.test(w.v) || (w.dyn && /^["{]?\|/.test(code.slice(m.index! + m[0].length).trimStart()))) {
        if (w.dyn) res.opaque = true; else addLine(res, w.v.slice(1));
      }
      continue;
    }
    if (name === "socket") {
      let k = 0;
      let server = false;
      while (words[k] && /^-/.test(words[k]!.v) && !words[k]!.dyn) {
        if (words[k]!.v === "-server") server = true;
        k += /^-(?:myaddr|myport|server)$/.test(words[k]!.v) ? 2 : 1;
      }
      if (server) continue;
      const host = words[k];
      if (!host || host.dyn) res.opaque = true; else res.hosts.push(host.v);
      continue;
    }
    // exec / spawn: the words are the command line (pipes split it, redirections are dropped).
    const cmds: string[][] = [[]];
    let bad = false;
    let skipNext = false;
    for (const w of words) {
      if (w.dyn) { bad = true; break; }
      if (skipNext) { skipNext = false; continue; }
      if (/^-(?:ignorestderr|keepnewline|-|nocomplain)$/.test(w.v) && !cmds[0]!.length) continue;
      if (TCL_REDIR.test(w.v)) {
        if (w.v === "|" || w.v === "|&") cmds.push([]);
        else if (!/@/.test(w.v) && w.v !== "&") skipNext = true;
        continue;
      }
      cmds.at(-1)!.push(w.v);
    }
    if (bad) { res.opaque = true; continue; }
    for (const c of cmds) if (c.length) addLine(res, lineOf(c));
  }
  return res;
}

// ---- the sqlite3 shell ----

// A dot command's words as the shell reads them: bare, 'single' or "double" quoted.
function dotWords(rest: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length && out.length < 64) {
    const c = rest[i]!;
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "'" || c === '"') {
      const e = rest.indexOf(c, i + 1);
      const end = e < 0 ? rest.length : e;
      out.push(rest.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let e = i;
    while (e < rest.length && rest[e] !== " " && rest[e] !== "\t") e++;
    out.push(rest.slice(i, e));
    i = e;
  }
  return out;
}

function readSqlite(code: string): Read {
  const res = fresh(code, [code]);
  let n = 0;
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith(".")) continue;
    if (++n > CAP) { res.opaque = true; break; }
    const sp = /^\.(\w+)\s*(.*)$/.exec(line);
    if (!sp) continue;
    const name = sp[1]!.toLowerCase();
    const rest = sp[2]!;
    if (name === "shell" || name === "system") { if (rest) addLine(res, rest); continue; }
    if (!/^(?:import|once|output|excel|read|log)$/.test(name)) continue;
    const words = dotWords(rest).filter((w, k, all) => !(w.startsWith("-") && !w.startsWith("|")) && !(all[k - 1] === "--skip" || all[k - 1] === "--schema"));
    const k = words.findIndex((w) => w.startsWith("|"));
    if (k < 0) continue;
    const cmd = name === "import" || name === "read" ? [words[k]!.slice(1), ...(words[k]!.length === 1 ? words.slice(k + 1, name === "import" ? -1 : undefined) : [])].join(" ").trim() : [words[k]!.slice(1), ...words.slice(k + 1)].join(" ").trim();
    if (cmd) addLine(res, cmd);
  }
  return res;
}

// ---- vim ----

const VIM_MOD = /^(?:sil(?:ent)?!?|keepj\w*|keepp\w*|noa\w*|lockm\w*|verb\w*|vert\w*|bel\w*|abo\w*|tab|uns\w*|nos\w*)$/;
const VIM_EMBED = new Set(["py", "pyt", "pyth", "pytho", "python", "py3", "python3", "pyx", "pythonx", "pydo", "py3do", "pyxdo", "lua", "luado", "perl", "pe", "perldo", "ruby", "rub", "rubydo", "tcl", "tcldo", "mz", "mzscheme"]);
const VIM_RANGE = /[\w%.$,;'<>+\-/*\\]/;
// Where a command starts in an Ex line: past blanks, colons and the modifiers (silent, keepjumps, ...).
function exHead(s: string): number {
  let i = 0;
  for (let g = 0; g < 16; g++) {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === ":")) i++;
    let e = i;
    while (e < s.length && /[\w!]/.test(s[e]!)) e++;
    if (e > i && VIM_MOD.test(s.slice(i, e)) && (s[e] === " " || s[e] === "\t")) { i = e; continue; }
    break;
  }
  return i;
}
const VIM_CALL = /(?<![\w#:.])(?:system|systemlist|job_start|term_start|jobstart|termopen|libcall|libcallnr)\s*\(/g;
const VIM_NET = /(?<![\w#:.])(?:sockconnect|channel_open|ch_open|ch_sendraw|rpcrequest|netrw#\w+)\s*\(|\b(?:https?|ftps?|scp|sftp|rcp|rsync|dav|davs|ssh):\/\/|\b(?:Nread|Nwrite|Nsource)\b/;
const REMOTE_FILE = /^(?:https?|ftps?|scp|sftp|rcp|rsync|dav|davs|ssh):\/\//i;

function readVim(code: string, depth: number): Read {
  const res = fresh(code, [code]);
  res.net = VIM_NET.test(code) || urlArg([code]);
  calls(code, "php", VIM_CALL, res);
  const segs = code.split(/\n|<CR>|<cr>/);
  let n = 0;
  for (let k = 0; k < segs.length; k++) {
    let rest = segs[k]!;
    if (!rest.trim()) continue;
    if (++n > CAP) { res.opaque = true; break; }
    for (let guard = 0; guard < 64 && rest !== ""; guard++) {
      const h = exHead(rest);
      // A shell: [range]!cmd, :r !cmd, :w !cmd (the rest of the line is the command, a bar included).
      let j = h;
      while (j < rest.length && VIM_RANGE.test(rest[j]!)) j++;
      const word = rest.slice(h, j);
      let b = j;
      while (b < rest.length && (rest[b] === " " || rest[b] === "\t")) b++;
      if (rest[b] === "!") { const cmd = rest.slice(b + 1).trim(); if (cmd) addLine(res, cmd); break; }
      // Code of another language, to the end of the text (a here-document runs over the lines after it).
      if (VIM_EMBED.has(word)) {
        const kind = word;
        const text = [rest.slice(j), ...segs.slice(k + 1)].join("\n").trim();
        const fam: Lang | null = /^py/.test(kind) ? "python" : /^lua/.test(kind) ? "lua" : /^perl|^pe$/.test(kind) ? "perl" : /^rub/.test(kind) ? "ruby" : /^tcl/.test(kind) ? "tcl" : null;
        if (!fam || depth + 1 >= DEPTH) res.opaque = true; else if (text) merge(res, readAny(fam, text, depth + 1));
        k = segs.length;
        break;
      }
      // Keys and commands built as text: read when written out, else unread.
      if (/^norm(?:al)?!?$/.test(word) || word === "normal!" ) { if (rest.slice(j).replace(/^!/, "").includes("!")) res.opaque = true; break; }
      if (/^exe(?:c|cu|cut|cute)?$/.test(word)) {
        const q = rest[b] === '"' || rest[b] === "'" ? quoted(rest, b, rest.length, "lua", "") : null;
        if (!q || q.end < rest.trimEnd().length || depth + 1 >= DEPTH) res.opaque = true; else merge(res, readVim(q.text, depth + 1));
        break;
      }
      if (/^feedkeys\s*\(/.test(rest.slice(h)) && rest.includes("!")) { res.opaque = true; break; }
      const bar = rest.indexOf("|");
      if (bar < 0) break;
      rest = rest.slice(bar + 1);
    }
  }
  return res;
}

// ---- emacs (elisp) ----

type El = { k: "s"; v: string } | { k: "nil" } | { k: "kw"; v: string } | { k: "l"; items: El[] } | { k: "bad" };
const BAD: El = { k: "bad" };
const PURE0 = /^(?:point|point-min|point-max|mark|buffer-string|buffer-name|current-buffer|region-beginning|region-end)$/;

// The elements of a list form from `i` (after its head) to its close; null when it does not close within the text read.
function elItems(s: string, i: number, lim: number, depth: number): { items: El[]; end: number } | null {
  const items: El[] = [];
  while (i < lim && items.length < 256) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if (c === ";") { while (i < lim && s[i] !== "\n") i++; continue; }
    if (c === ")") return { items, end: i + 1 };
    const e = elOne(s, i, lim, depth);
    if (!e) return null;
    items.push(e.el);
    i = e.end;
  }
  return null;
}
function elOne(s: string, i: number, lim: number, depth: number): { el: El; end: number } | null {
  const c = s[i]!;
  if (c === '"') { const q = quoted(s, i, lim, "lua", ""); return q ? { el: { k: "s", v: q.text }, end: q.end } : null; }
  if (c === "'") {
    const e = elOne(s, i + 1, lim, depth);
    if (!e) return null;
    return { el: e.el.k === "l" || e.el.k === "nil" ? e.el : BAD, end: e.end };
  }
  if (c === "(") {
    if (depth > 8) return null;
    let j = i + 1;
    while (s[j] === " " || s[j] === "\n" || s[j] === "\t") j++;
    let h = j;
    while (h < lim && !/[\s()"';]/.test(s[h]!)) h++;
    const head = s.slice(j, h);
    const r = elItems(s, h, lim, depth + 1);
    if (!r) return null;
    if (head === "list" || head === "quote" || head === "vector") return { el: { k: "l", items: r.items }, end: r.end };
    if (head === "concat") return { el: r.items.every((x) => x.k === "s") ? { k: "s", v: r.items.map((x) => (x as { v: string }).v).join("") } : BAD, end: r.end };
    if (PURE0.test(head) && !r.items.length) return { el: { k: "nil" }, end: r.end };
    return { el: BAD, end: r.end };
  }
  let e = i;
  while (e < lim && !/[\s()"';]/.test(s[e]!)) e++;
  if (e === i) return { el: BAD, end: i + 1 };
  const w = s.slice(i, e);
  if (w === "nil" || w === "t" || /^[+-]?\d+(?:\.\d+)?$/.test(w)) return { el: { k: "nil" }, end: e };
  if (w.startsWith(":")) return { el: { k: "kw", v: w }, end: e };
  return { el: BAD, end: e };
}

// The strings of some elements (a list gives its strings, nil none); null when one is built from what the text does not say.
function elStrings(els: (El | undefined)[]): string[] | null {
  const out: string[] = [];
  for (const e of els) {
    if (!e || e.k === "nil") continue;
    if (e.k === "s") out.push(e.v); else if (e.k === "l") { const inner = elStrings(e.items); if (!inner) return null; out.push(...inner); } else return null;
  }
  return out;
}
const needStr = (e: El | undefined): string | null => (e?.k === "s" ? e.v : null);

const EL_EXEC: Record<string, (it: El[]) => string[] | null> = Object.assign(Object.create(null), {
  "shell-command": (it: El[]) => (needStr(it[0]) === null ? null : [it[0]!.k === "s" ? it[0]!.v : ""]),
  "shell-command-to-string": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "async-shell-command": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "call-process-shell-command": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "process-file-shell-command": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "eshell-command": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "compile": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "term": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "ansi-term": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "comint-run": (it: El[]) => (needStr(it[0]) === null ? null : [(it[0] as { v: string }).v]),
  "start-process-shell-command": (it: El[]) => (needStr(it[2]) === null ? null : [(it[2] as { v: string }).v]),
  "shell-command-on-region": (it: El[]) => (needStr(it[2]) === null ? null : [(it[2] as { v: string }).v]),
  "call-process": (it: El[]) => (needStr(it[0]) === null ? null : elStrings([it[0], ...it.slice(4)])),
  "process-file": (it: El[]) => (needStr(it[0]) === null ? null : elStrings([it[0], ...it.slice(4)])),
  "start-process": (it: El[]) => (needStr(it[2]) === null ? null : elStrings(it.slice(2))),
  "call-process-region": (it: El[]) => (needStr(it[2]) === null ? null : elStrings([it[2], ...it.slice(6)])),
  "make-comint": (it: El[]) => (needStr(it[1]) === null ? null : elStrings([it[1], ...it.slice(3)])),
  "make-comint-in-buffer": (it: El[]) => (needStr(it[2]) === null ? null : elStrings([it[2], ...it.slice(4)])),
  "process-lines": (it: El[]) => (needStr(it[0]) === null ? null : elStrings(it)),
  "process-lines-ignore-status": (it: El[]) => (needStr(it[0]) === null ? null : elStrings(it)),
  "make-process": (it: El[]) => { const k = it.findIndex((e) => e.k === "kw" && e.v === ":command"); return k < 0 ? null : elStrings([it[k + 1]]); },
});
const EL_NET = new Set(["url-retrieve", "url-retrieve-synchronously", "url-queue-retrieve", "url-copy-file", "url-insert-file-contents", "url-http", "url-http-post", "open-network-stream", "make-network-process", "network-lookup-address-info", "browse-url", "browse-url-default-browser", "browse-url-xdg-open", "eww", "eww-browse-url", "plz", "request", "smtpmail-send-it", "erc", "rcirc", "package-install-file", "elpher-go"]);
const EL_DYN = new Set(["eval", "funcall", "apply", "read", "read-from-string", "intern", "intern-soft", "symbol-function", "symbol-value", "call-interactively", "execute-kbd-macro", "eval-buffer", "eval-region", "eval-last-sexp", "org-babel-execute-buffer", "org-babel-execute-src-block", "org-babel-eval", "org-babel-execute-subtree", "org-babel-execute-maybe", "byte-compile", "native-compile", "fset", "defalias", "setf", "set"]);
const TRAMP = /\/(?:ssh|scp|sshx|scpx|rsync|sftp|ftp|telnet|rlogin|rcp|plink\w*|pscp|psftp|fcp):(?:[\w.+-]+@)?([\w.[\]-]+?)(?:#\d+)?:/g;

function readElisp(code: string): Read {
  const view = viewOf(code);
  const res = fresh(code, view);
  res.net = urlArg(view);
  for (const t of view) for (const m of t.matchAll(TRAMP)) res.hosts.push(m[1]!);
  let n = 0;
  for (const m of code.matchAll(/\(\s*([^\s()"';]+)/g)) {
    const head = m[1]!;
    const exec = EL_EXEC[head];
    if (!exec && !EL_NET.has(head) && !EL_DYN.has(head)) continue;
    if (++n > CAP) { res.opaque = true; break; }
    if (EL_NET.has(head)) { res.net = true; continue; }
    if (EL_DYN.has(head)) { res.opaque = true; continue; }
    const start = m.index! + m[0].length;
    const r = elItems(code, start, Math.min(code.length, start + REGION), 0);
    const words = r && exec ? exec(r.items) : null;
    if (!words) { res.opaque = true; continue; }
    addLine(res, words.length === 1 ? words[0]! : lineOf(words));
  }
  return res;
}

// ---- gdb ----

const GDB_SHELL = /^(?:!|(?:shell|shel|she|sh)\b)\s*(.*)$/s;
const GDB_PIPE = /^(?:pipe|\|)\s+(.*)$/s;
const GDB_PY = /^(?:python|py|python-interactive|pi)\s+(.*)$/s;
const GDB_CALL = /^(?:call|print|p|inspect|output|expression|expr|print-object|po|set\s+var(?:iable)?|set\s+\$\w+\s*=|compile\s+(?:code|print))\b/;
const GDB_TARGET = /^target\s+(?:extended-)?remote\s+(.*)$/;

function readGdb(code: string): Read {
  const res = fresh(code, [code]);
  let n = 0;
  for (const raw of code.split("\n")) {
    const c = raw.trim();
    if (!c) continue;
    if (++n > CAP) { res.opaque = true; break; }
    let m: RegExpExecArray | null;
    if ((m = GDB_SHELL.exec(c))) { if (m[1]) addLine(res, m[1]); continue; }
    if ((m = GDB_PIPE.exec(c))) {
      const bar = m[1]!.indexOf("|");
      if (/^-d\b/.test(m[1]!) || bar < 0) res.opaque = true; else addLine(res, m[1]!.slice(bar + 1).trim());
      continue;
    }
    if ((m = GDB_PY.exec(c))) { merge(res, { ...readCode(m[1]!, "python"), hosts: [] }); continue; }
    if ((m = GDB_TARGET.exec(c))) {
      const to = m[1]!.trim();
      if (to.startsWith("|")) { addLine(res, to.slice(1).trim()); continue; }
      const h = /^(?:tcp[46]?:|udp:)?\[?([^\]\s:]*)\]?:\d+$/.exec(to);
      if (h) { if (h[1]) res.hosts.push(h[1]); continue; }
      if (!to.startsWith("/")) res.opaque = true;
      continue;
    }
    if (/^eval\b|^guile\b|^gu\b/.test(c)) { res.opaque = true; continue; }
    if (GDB_CALL.test(c)) merge(res, { ...readCode(c.replace(GDB_CALL, ""), "python"), hosts: [] });
  }
  return res;
}

// ---- what a program is given ----

export type Given = { args: string[]; vals: (string | null)[]; leads: string[] };
// `codes`: the code the options carry, each in its language. `blind`: some of it is not in the text (a variable). `remotes`: file
// names that are remote addresses (the program fetches or writes them). `stdin`: the program takes code on its input ("sql": a
// file of queries is no unread code).
export type Plan = { codes: { fam: Lang; text: string }[]; blind: boolean; remotes: string[]; stdin: "none" | "code" | "sql" };

export function planOf(fam: Other, g: Given): Plan {
  const plan: Plan = { codes: [], blind: false, remotes: [], stdin: "none" };
  const take = (j: number, as: Lang, strip = 0) => {
    const v = g.vals[j];
    if (v === null || v === undefined) plan.blind = true; else plan.codes.push({ fam: as, text: v.slice(strip) });
  };
  const a = g.args;
  switch (fam) {
    case "lua": {
      let code = false;
      let script = false;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (w === "-e" && j + 1 < a.length) { take(j + 1, "lua"); code = true; j++; }
        else if (w === "-l" && j + 1 < a.length) { plan.codes.push({ fam: "lua", text: `require("${g.vals[j + 1] ?? ""}")` }); j++; }
        else if (w === "-") { break; }
        else if (w.startsWith("-")) continue;
        else { script = true; break; }
      }
      plan.stdin = code || script ? "none" : "code";
      break;
    }
    case "awk": {
      let file = false;
      let src = false;
      const valued = /^(?:-[vFfeiElW]|--(?:assign|field-separator|file|source|include|load|exec))$/;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (w === "--") { if (!file && !src && j + 1 < a.length) take(j + 1, "awk"); break; }
        if (w === "-f" || w === "--file" || /^-f.+/.test(w) || w.startsWith("--file=")) { file = true; if (w === "-f" || w === "--file") j++; continue; }
        if (w === "-e" || w === "--source") { take(j + 1, "awk"); src = true; j++; continue; }
        if (w.startsWith("--source=")) { take(j, "awk", 9); src = true; continue; }
        if (valued.test(w)) { j++; continue; }
        if (w.startsWith("-") && w !== "-") continue;
        if (!file && !src) take(j, "awk");
        break;
      }
      break;
    }
    case "r": {
      let given = false;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (w === "-e" && j + 1 < a.length) { take(j + 1, "r"); given = true; j++; }
        else if (w === "--args") { given = true; break; }
        else if (w === "-f" || w === "--file" || w.startsWith("--file=")) { given = true; if (w === "-f" || w === "--file") j++; }
        else if (w === "-") break;
        else if (w.startsWith("-")) continue;
        else { given = true; break; }
      }
      plan.stdin = given ? "none" : "code";
      break;
    }
    case "pwsh": {
      let given = false;
      const valued = /^-(?:executionpolicy|ep|workingdirectory|wd|inputformat|outputformat|configurationname|custompipename|settingsfile|windowstyle|version|v|file|f)$/i;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (/^-(?:c|command)$/i.test(w) && j + 1 < a.length) {
          given = true;
          const rest = a.slice(j + 1);
          const vs = rest.map((_, k) => g.vals[j + 1 + k]);
          if (rest.length === 1 && rest[0] === "-") plan.stdin = "code";
          else if (vs.some((v) => v === null || v === undefined)) plan.blind = true; else plan.codes.push({ fam: "pwsh", text: vs.join(" ") });
          break;
        }
        if (/^-(?:e|ec|enc|encodedcommand)$/i.test(w) && j + 1 < a.length) {
          given = true;
          const v = g.vals[j + 1];
          let text: string | null = null;
          if (v) { try { text = Buffer.from(v, "base64").toString("utf16le"); } catch { text = null; } }
          if (text && /^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(text)) plan.codes.push({ fam: "pwsh", text }); else plan.blind = true;
          j++;
          continue;
        }
        if (/^-(?:file|f)$/i.test(w)) { given = true; break; }
        if (valued.test(w)) { j++; continue; }
        if (w.startsWith("-") && w !== "-") continue;
        given = true;
        break;
      }
      if (!given) plan.stdin = "code";
      break;
    }
    case "tcl": {
      const script = a.some((w) => !w.startsWith("-") || w === "-");
      plan.stdin = script && !a.includes("-") ? "none" : "code";
      break;
    }
    case "sqlite": {
      let db = false;
      let sql = false;
      const valued = /^-(?:cmd|init|separator|newline|nullvalue|vfs|nonce|maxsize|lookaside|mmap|pagecache|heap|memtrace|pcachetrace|sorterref)$/;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        const dash = w.startsWith("-") ? w.replace(/^--/, "-") : w;
        if (dash === "-cmd") { take(j + 1, "sqlite"); sql = true; j++; continue; }
        if (valued.test(dash)) { j++; continue; }
        if (w.startsWith("-")) continue;
        if (!db) { db = true; continue; }
        sql = true;
        const v = g.vals[j];
        // A query given in a variable may be a dot command: unread, unless its written part is SQL.
        if (v === null || v === undefined) { const lead = g.leads[j]!.trim(); if (!lead || lead.startsWith(".")) plan.blind = true; } else plan.codes.push({ fam: "sqlite", text: v });
      }
      plan.stdin = sql ? "none" : "sql";
      break;
    }
    case "vim": {
      const valued = new Set(["-c", "--cmd", "-S", "-u", "-i", "-T", "-w", "-W", "-U", "-t", "-q", "--servername", "--startuptime", "--listen", "--remote-expr", "--remote-send"]);
      const silent = a.some((w) => /^-[Ee]s$/.test(w)) || ((a.includes("-e") || a.includes("-E")) && a.includes("-s"));
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (w === "--") { for (let k = j + 1; k < a.length; k++) if (REMOTE_FILE.test(a[k]!)) plan.remotes.push(a[k]!); break; }
        if (w === "-c" || w === "--cmd" || w === "--remote-expr" || w === "--remote-send") { take(j + 1, "vim"); j++; continue; }
        if (w === "-s" && !silent) { j++; continue; }
        if (valued.has(w)) { j++; continue; }
        if (/^\+/.test(w) && w.length > 1 && !/^\+\d*$/.test(w) && !w.startsWith("+/")) { take(j, "vim", 1); continue; }
        if (w.startsWith("-") && w !== "-") continue;
        if (REMOTE_FILE.test(w) || /^\/(?:ssh|scp|rsync|sftp|ftp):/.test(w)) plan.remotes.push(w);
      }
      plan.stdin = silent ? "code" : "none";
      break;
    }
    case "emacs": {
      const valued = /^-{1,2}(?:l|load|L|directory|f|funcall|insert|i|u|user|d|display|chdir|T|title|script|visit|file|find-file|fn|font|bg|fg|cr|ms|bd|bw|g|geometry|name|xrm|s|a|alternate-editor|socket-name|server-file|tramp|w)$/;
      const evalFlag = /^-{1,2}(?:eval|execute)$/;
      const isClient = /^-e$/;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (evalFlag.test(w) || (isClient.test(w) && j + 1 < a.length)) { take(j + 1, "emacs"); j++; continue; }
        if (/^--(?:eval|execute)=/.test(w)) { take(j, "emacs", w.indexOf("=") + 1); continue; }
        if (valued.test(w)) { j++; continue; }
        if (w.startsWith("-") || /^\+\d/.test(w)) continue;
        plan.codes.push({ fam: "emacs", text: `"${w.replace(/["\\]/g, "")}"` });
      }
      break;
    }
    case "gdb": {
      const valued = /^-(?:x|d|cd|s|e|se|c|p|l|b|D|ix|tty|-command|-directory|-symbols|-exec|-core|-pid|-data-directory|-init-command|-tty)$/;
      for (let j = 0; j < a.length; j++) {
        const w = a[j]!;
        if (w === "--args") break;
        if (w === "-ex" || w === "-iex" || w === "--eval-command" || w === "--init-eval-command") { take(j + 1, "gdb"); j++; continue; }
        if (/^--(?:eval|init-eval)-command=/.test(w)) { take(j, "gdb", w.indexOf("=") + 1); continue; }
        if (valued.test(w)) { j++; continue; }
      }
      plan.stdin = "code";
      break;
    }
  }
  return plan;
}
