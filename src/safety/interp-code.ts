// What the code given to an interpreter (python -c, node -e, perl, php -r, ruby -e, deno eval, code on its input) does with
// the network, read from its text. Pure: the send scan (provenance.ts) turns the answer into reaches.
//
// The code is not run and not parsed as a language. Three things are read from the text:
//   - `net`: it opens a connection. A word of a library that does (urllib, socket, fetch, LWP, ...) in the text as written
//     or with its quoted pieces joined ('fe'+'tch', '\x68ttp'), or a call whose first argument is a written-out remote
//     address (readfile("http://..."), import("https://...")). The addresses the text spells are the places it sends to.
//   - `lines`: it runs a shell command. A call of a program that starts one (os.system, subprocess.run, execSync, system,
//     backticks, ...) whose arguments are written-out strings is the command line (or the argument list) it runs: the
//     send scan reads each as a command of its own.
//   - `opaque`: what it reaches is not in the text: a command or a name built from parts, code that is built and run (eval,
//     __import__, globalThis[x]), a call through another name. The place is then unread, held as any place the words do not
//     give is held (only where the session could not keep what it read whole).
// The cost is bounded by the text: markers are found by one pass of a regular expression, a call is read at most 8 KiB past its
// start, and past 256 calls the rest is opaque.

export type Family = "python" | "js" | "perl" | "php" | "ruby";
export const familyOf = (prog: string): Family =>
  prog.startsWith("python") ? "python" : prog === "ruby" ? "ruby" : prog === "perl" ? "perl" : prog === "php" ? "php" : "js";

export type CodeRead = { text: string[]; net: boolean; lines: string[]; opaque: boolean };

// The words that open a connection (the same list the scan has always used, with the libraries and forms it missed).
const NET_CODE = /\b(?:urllib\d?|urlopen|requests\.|httpx|http\.client|httplib2?|socket|aiohttp|websockets?|ftplib|smtplib|poplib|imaplib|nntplib|telnetlib|xmlrpc|webbrowser|pycurl|paramiko|asyncio\.open_connection|open_connection|create_connection|fetch\s*\(|XMLHttpRequest|axios|undici|node-fetch|https?\.(?:request|get)|node:(?:https?|net|tls|dgram|dns|http2)|net\.(?:connect|Socket|createConnection)|tls\.connect|dgram|createConnection|Net::\w+|net\/http|open-uri|URI\.open|LWP|HTTP::Tiny|IO::Socket|WWW::|Mojo::UserAgent|curl_\w+|fsockopen|stream_socket_client|get_headers|SoapClient|file_get_contents|Deno\.connect|Bun\.connect|WebSocket)/i;
// An import of a built-in module that opens connections, with no node: in front of it.
const NET_MODULE = /(?:\bfrom\s+|\b(?:require|import)\s*\(?\s*)["'`](?:https?|net|tls|dgram|dns|http2)["'`]/;
// A call whose first argument is a remote address: what it is called is read for what it does with it (not a print).
const URL_ARG = /\b([A-Za-z_]\w*)\s*\(?\s*[rRbBuU]{0,2}["'`]\s*(?:https?|ftps?|sftp|ssh2\.\w+|tcp|udp|ssl|tls|wss?):\/\//g;
const SAYS = /^(?:print|printf|echo|puts|say|log|info|warn|warning|error|debug|trace|write|writeln|format|raise|throw|Error|Exception|input|prompt|sprintf|println|alert|comment|title|help|usage|doc|assert|die|exit|fail|from|href|src|url|uri|link)$/i;
// What builds and runs code, or reaches a name through a string: no place is read from it.
const DYNAMIC = /\b(?:__import__|importlib|__builtins__|execfile|Reflect\.(?:get|apply|construct)|runIn\w+Context|create_function|call_user_func(?:_array)?|instance_eval|class_eval|public_send|const_get|globals\s*\(|getattr\s*\(|setattr\s*\(|new\s+Function|Function\s*\()|\b(?:globalThis|window|self|global|this|Deno|Bun|process)\s*\[|(?:%x|\bqx)\s*[^\s\w]/;
const GENERIC = /^(?:exec|eval|compile)$/;
const GLOBAL_OBJ = /^(?:globalThis|window|self|global|this|vm|builtins|__builtins__)$/;
const LOCAL_PROGS = "ls|cat|head|tail|wc|stat|file|du|df|pwd|echo|mkdir|touch|rm|cp|mv|chmod|diff|sort|uniq|cut|grep|rg|basename|dirname|realpath|readlink|date|whoami|id|uname|true|false";
// `('ls', [`, `(['ls',` and `` `ls `` after the opening of a call: a local program, then arguments written as variables.
const LOCAL_CALL = new RegExp("^(?:\\(\\s*\\[?\\s*['\"](?:" + LOCAL_PROGS + ")['\"]\\s*,|\\[\\s*['\"](?:" + LOCAL_PROGS + ")['\"]\\s*,|`(?:" + LOCAL_PROGS + ")[ \\t][^`]*`)");
// The calls that start a program or a shell line. `exec` and `eval` are told apart below.
const SHELL = /\b(?:system|popen[23]?|execSync|execFileSync|spawnSync|execFile|spawn|exec|exec[lv][ep]{0,2}|spawn[lv][ep]?|check_output|check_call|getoutput|getstatusoutput|subprocess|child_process|passthru|shell_exec|proc_open|pcntl_exec|capture[23]e?|Open3|create_subprocess_\w+|execa\w*|shelljs|eval|compile)\b|\bDeno\.(?:run|Command)\b|\bBun\.(?:spawn\w*|\$)/g;
// Names that are modules, not calls: a mention is no call, the calls of the module are found by their own names.
const MODULE = /^(?:subprocess|child_process|Open3|shelljs)$/;
const LOAD = /\b(?:import|require)\s*\(/g;
const CAP = 256;
const REGION = 8192;
const DEPTH = 3;

// The characters an escape stands for, so that a name written in pieces or with escapes is read as the name.
function unescape(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|([0-7]{3}))/g, (m, a, b, c, d) => {
    const n = a ? parseInt(a, 16) : b ? parseInt(b, 16) : c ? parseInt(c, 16) : parseInt(d, 8);
    return n > 0x10ffff ? m : String.fromCodePoint(n);
  });
}
// The text with each pair of quoted pieces joined ('a'+'b', "a"."b", 'a' 'b').
const joined = (s: string): string => unescape(s).replace(/["'`]\s*(?:[+.]\s*|\s)["'`]/g, "");

// ---- a call's arguments ----

type Args = { ok: boolean; lits: string[] };
const KEYWORDS = /^(?:True|False|None|true|false|null|undefined|nil|NULL|TRUE|FALSE)$/;
const ENDS = /^(?:if|unless|and|or|xor|die|while|until|for)$/;

// Whether a quoted piece holds something the language puts in when it runs.
function interpolates(fam: Family, q: string, prefix: string, body: string): boolean {
  if (fam === "python") return /[fF]/.test(prefix) && body.includes("{");
  if (fam === "js") return q === "`" && body.includes("${");
  if (q === "'") return false;
  if (fam === "ruby") return body.includes("#{") || /#[$@]/.test(body);
  return /[$@][\w{]/.test(body) || body.includes("{$");
}

// The piece quoted at `i` (the quote itself), or null when it does not end within `lim`.
function quoted(s: string, i: number, lim: number, fam: Family, prefix: string): { text: string; end: number; dyn: boolean } | null {
  const q = s[i]!;
  const triple = fam === "python" && q !== "`" && s.startsWith(q.repeat(3), i);
  const open = triple ? 3 : 1;
  const raw = /[rR]/.test(prefix);
  const plain = fam !== "python" && fam !== "js" && q === "'"; // no escape but \\ and \'
  let j = i + open;
  let body = "";
  while (j < lim) {
    const c = s[j]!;
    if (c === "\\") {
      const n = s[j + 1];
      if (n === undefined) return null;
      let used = 2;
      if (raw || plain) body += n === q || (plain && n === "\\") ? n : `\\${n}`;
      else if (n === "n") body += "\n";
      else if (n === "t") body += "\t";
      else if (n === "r") body += "\r";
      else if (n === "x" && /^[0-9a-fA-F]{2}/.test(s.slice(j + 2, j + 4))) { body += String.fromCharCode(parseInt(s.slice(j + 2, j + 4), 16)); used = 4; }
      else if (n === "u" && /^[0-9a-fA-F]{4}/.test(s.slice(j + 2, j + 6))) { body += String.fromCharCode(parseInt(s.slice(j + 2, j + 6), 16)); used = 6; }
      else if (n === "u" && /^\{[0-9a-fA-F]{1,6}\}/.test(s.slice(j + 2, j + 10))) { const e = s.indexOf("}", j + 2); body += String.fromCodePoint(Math.min(0x10ffff, parseInt(s.slice(j + 3, e), 16))); used = e - j + 1; }
      else if (/[0-7]/.test(n) && /^[0-7]{3}/.test(s.slice(j + 1, j + 4))) { body += String.fromCharCode(parseInt(s.slice(j + 1, j + 4), 8)); used = 4; }
      else if (n !== "\n") body += n;
      j += used;
      continue;
    }
    if (c === q && (!triple || s.startsWith(q.repeat(3), j))) return { text: body, end: j + open, dyn: interpolates(fam, q, prefix, s.slice(i + open, j).replace(/\\[\s\S]/g, "")) };
    body += c;
    j++;
  }
  return null;
}

// The pieces of a call's arguments, from `j` (the opening bracket, or the first word of a call written without one).
// `ok`: every word of them is a quoted piece, a bracket, a comma, a name it is given by (key=, key:), a number or a constant;
// anything else (a variable, an operator, a formatted or interpolated piece) builds the arguments from what the text does not say.
function argsAt(s: string, j: number, fam: Family): Args {
  const lim = Math.min(s.length, j + REGION);
  const lits: string[] = [];
  const paren = s[j] === "(";
  let depth = 0;
  let i = j;
  let last = false; // the token before is a quoted piece
  let join = false; // an operator joins the next quoted piece to it
  while (i < lim) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "\n") { if (!paren && depth === 0) return { ok: true, lits }; i++; continue; }
    if (c === ";" || c === "|" || c === "&") { if (!paren && depth === 0) return { ok: true, lits }; return { ok: false, lits }; }
    if (c === "(" || c === "[" || c === "{") { depth++; last = false; i++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return { ok: !paren, lits };
      depth--; last = false; i++;
      if (paren && depth === 0) return { ok: true, lits };
      continue;
    }
    if (c === ",") { last = false; i++; continue; }
    if (c === "+" || (c === "." && (fam === "php" || fam === "perl") && s[i + 1] !== "." && !/[\d]/.test(s[i + 1] ?? ""))) { if (!last) return { ok: false, lits }; join = true; i++; continue; }
    if (c === "=" && s[i + 1] === ">") { last = false; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = quoted(s, i, lim, fam, "");
      if (!q || q.dyn) return { ok: false, lits };
      if (lits.length && ((join && last) || (fam === "python" && last))) lits[lits.length - 1] += q.text; else lits.push(q.text);
      last = true; join = false; i = q.end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let e = i + 1;
      while (e < lim && /\w/.test(s[e]!)) e++;
      const word = s.slice(i, e);
      // A prefix of a piece (r"..", b'..', f"..").
      if (/^[rRbBuUfF]{1,2}$/.test(word) && (s[e] === '"' || s[e] === "'")) {
        const q = quoted(s, e, lim, fam, word);
        if (!q || q.dyn) return { ok: false, lits };
        if (lits.length && ((join && last) || (fam === "python" && last))) lits[lits.length - 1] += q.text; else lits.push(q.text);
        last = true; join = false; i = q.end;
        continue;
      }
      let k = e;
      while (k < lim && (s[k] === " " || s[k] === "\t")) k++;
      const key = (s[k] === "=" && s[k + 1] !== "=") || (s[k] === ":" && s[k + 1] !== ":");
      if (!paren && depth === 0 && ENDS.test(word)) return { ok: true, lits };
      if (!key && !KEYWORDS.test(word)) return { ok: false, lits };
      last = false; i = e;
      continue;
    }
    if (/[0-9]/.test(c)) { while (i < lim && /[\w.]/.test(s[i]!)) i++; last = false; continue; }
    if (c === "=" || c === ":") { last = false; i++; continue; }
    return { ok: false, lits };
  }
  return { ok: false, lits };
}

// The command a call's pieces are: one piece is a shell line; several are the words of an argument list.
const shellWord = (w: string): string => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
const lineOf = (lits: string[]): string | null => (lits.length === 0 ? null : lits.length === 1 ? lits[0]! : lits.map(shellWord).join(" "));

// ---- the reading ----

export function readCode(code: string, fam: Family, depth = 0): CodeRead {
  const flat = joined(code);
  const view = flat === code ? [code] : [code, flat];
  const res: CodeRead = { text: [...view], net: false, lines: [], opaque: false };
  res.net = view.some((t) => NET_CODE.test(t) || NET_MODULE.test(t)) || view.some((t) => { for (const m of t.matchAll(URL_ARG)) if (!SAYS.test(m[1]!)) return true; return false; });
  if (view.some((t) => DYNAMIC.test(t)) || (fam === "perl" && /\bopen\b[^;\n]{0,200}\|/.test(code))) res.opaque = true;
  // Backticks in these languages run a shell line.
  if (fam === "perl" || fam === "php" || fam === "ruby") {
    let n = 0;
    for (const m of code.matchAll(/`([^`]*)`/g)) {
      if (++n > CAP) { res.opaque = true; break; }
      if (interpolates(fam, '"', "", m[1]!)) res.opaque = true; else res.lines.push(m[1]!);
    }
  }
  // The calls: the name of each, then the arguments it is given.
  let calls = 0;
  let mentions = 0;
  let made = 0;
  let skip = 0;
  const tail = /(?:\.[A-Za-z_]\w*)*/y;
  for (const m of code.matchAll(SHELL)) {
    if (m.index! < skip) continue;
    if (++calls > CAP) { res.opaque = true; break; }
    const name = m[0];
    // `compile`, `exec` and `eval` are eval-like only as a bare call or on the global object: a method of some object
    // (re.compile, db.exec, regex.exec) is not code that is built and run. A module that starts programs through such a method
    // is a mention of the module, read below.
    if (GENERIC.test(name) && m.index! > 0 && code[m.index! - 1] === ".") {
      const recv = /([\w$]+)\s*\.$/.exec(code.slice(Math.max(0, m.index! - 40), m.index!));
      if (!recv || !GLOBAL_OBJ.test(recv[1]!)) { skip = m.index! + name.length; continue; }
    }
    tail.lastIndex = m.index! + name.length;
    tail.exec(code);
    skip = tail.lastIndex;
    const dotted = skip > m.index! + name.length;
    let j = skip;
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j++;
    const c = code[j];
    const module = MODULE.test(name);
    const call = module ? dotted && c === "(" : c === "(" || c === '"' || c === "'" || c === "`" || c === "[";
    const evalish = name === "eval" || name === "compile" || (name === "exec" && fam === "python");
    if (!call) {
      if (module) mentions++;
      else if (!evalish || /[\w$]/.test(c ?? "")) res.opaque = true;
      continue;
    }
    const a = argsAt(code, j, fam);
    if (!a.ok) {
      // A local program given by name with its arguments in a list (or a Bun.$ template, whose values are quoted as single
      // arguments): what the arguments hold cannot make it reach an address.
      if (!evalish && LOCAL_CALL.test(code.slice(j, j + 120)) && (name !== "Bun.$" || code[j] === "`")) { made++; continue; }
      res.opaque = true;
      continue;
    }
    if (evalish) {
      // Code the call builds and runs: read as code of its own, when it is written out.
      const src = a.lits[0];
      if (src === undefined || depth + 1 >= DEPTH) { res.opaque = true; continue; }
      const inner = readCode(src, fam, depth + 1);
      res.net ||= inner.net;
      res.opaque ||= inner.opaque;
      res.text.push(...inner.text);
      res.lines.push(...inner.lines);
      continue;
    }
    made++;
    const line = lineOf(a.lits);
    if (line !== null) res.lines.push(line);
  }
  // A module mentioned with no call of its own read: what it starts may be reached through a name the text does not give.
  if (mentions && !made) res.opaque = true;
  // A module loaded by a name that is built, or from a remote address.
  for (const m of code.matchAll(LOAD)) {
    if (++calls > CAP) { res.opaque = true; break; }
    const a = argsAt(code, m.index! + m[0].length - 1, fam);
    if (!a.ok || a.lits.length !== 1) { res.opaque = true; continue; }
    const what = a.lits[0]!;
    if (/^(?:https?|ftps?|wss?):\/\//i.test(what) || /^(?:node:)?(?:https?|net|tls|dgram|dns|http2)$/.test(what)) { res.net = true; res.text.push(what); }
  }
  return res;
}
