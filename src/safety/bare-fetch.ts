// Whether a shell command is a bare read of one address: a fetch program with only options that change nothing about
// the request, one address, and nothing the shell makes from files, variables or other commands. Everything else a
// fetch program can do (a body, a file to send, a header, a cookie, a credential, a proxy, a config file, another
// method, a list of addresses) is a send. The test is an allowlist: an option it does not know is a send, whatever it
// does, so a new flag or an abbreviation of a long one never reads as a page fetch.
import type { Simple } from "./shell.ts";
import { name as baseName, unwrap } from "./risk-words.ts";

// A word that is one address as written: no expansion, no glob, no quote left, no blank, no user name and password.
const ADDRESS = /^(?:https?:\/\/)?[A-Za-z0-9](?:[A-Za-z0-9.-]*)(?::\d{1,5})?(?:[/?#][^\s$`()\[\]{}\\"'<>|;*!~^@]*)?$/i;
const NUMBER = /^\d{1,5}(?:\.\d{1,3})?$/;
// What a timeout or a retry count may be: the largest a read has a reason for.
const CAP: Record<string, number> = { "-m": 600, "--max-time": 600, "--connect-timeout": 600, "--retry": 10, "-T": 600, "--timeout": 600, "-t": 10, "--tries": 10 };
// (Zero is no limit in these options, so it is not one.)
const within = (opt: string, v: string): boolean => NUMBER.test(v) && Number(v) > 0 && Number(v) <= (CAP[opt] ?? 600);
// The only places a read may write its page: the shell's standard output (`-`) and the bin.
const SINKS = new Set(["-", "/dev/null"]);

// curl: -s -S -L -I -f and any bundle of those letters, -o FILE, -m SECONDS and the long forms of the same.
const CURL_LETTERS = /^-[sSLIf]+$/;
const CURL_LONG = new Set(["--silent", "--show-error", "--location", "--head", "--fail", "--fail-with-body", "--no-progress-meter", "--compressed", "--http1.1", "--http2", "--ipv4", "--ipv6"]);
const CURL_FILE = new Set(["-o", "--output"]);
const CURL_NUMBER = new Set(["-m", "--max-time", "--connect-timeout", "--retry"]);
// wget: -q -nv -S --spider and -O FILE (also written -O- and -qO-).
const WGET_LONG = new Set(["-q", "-nv", "-S", "--quiet", "--no-verbose", "--server-response", "--spider"]);
const WGET_FILE = new Set(["-O", "--output-document"]);
const WGET_NUMBER = new Set(["-T", "--timeout", "-t", "--tries"]);

// What a page may be piped into: filters that only print part of their input. Nothing that runs it (a shell, an
// interpreter), writes it (`tee`, `sort -o`, `sed w`) or hands it on.
const SED_SCRIPT = /^\d*(?:,(?:\d+|\$))?p$/;
function filter(q: Simple): boolean {
  if (q.unknown || q.redirects || q.heredoc || q.nested || q.flow || q.splits || q.dyn?.length || q.inputs?.length) return false;
  const run = unwrap(q.words);
  if (run.set.length || run.fed || run.deep || !run.words.length) return false;
  // A program named by a path is whatever that file is, not the tool of that name.
  if (run.words[0]!.includes("/")) return false;
  const prog = baseName(run.words[0]!);
  const args = run.words.slice(1);
  if (prog === "sed") return args.length === 2 && args[0] === "-n" && SED_SCRIPT.test(args[1]!);
  return prog === "head" || prog === "tail" || prog === "grep" || prog === "wc" || prog === "jq";
}

// Whether what the part `p` prints goes only to the shell's output or through filters: not a file, not a shell.
function printed(p: Simple, rest: Simple[]): boolean {
  let cur = p;
  for (const q of rest) {
    if (cur.sep !== "|" && cur.sep !== "|&") return true;
    if (!filter(q)) return false;
    cur = q;
  }
  return cur.sep !== "|" && cur.sep !== "|&";
}

// Words of the one command `p` (a part of a parsed line, `rest` the parts after it) when it is a bare read, else undefined.
export function bareFetch(p: Simple, prog: string, rest: Simple[] = []): { address: string } | undefined {
  if (!printed(p, rest)) return undefined;
  if (p.unknown || p.redirects || p.heredoc || p.nested || p.flow || p.splits || p.dyn?.length || p.inputs?.length) return undefined;
  const run = unwrap(p.words);
  if (run.set.length || run.fed || run.deep) return undefined;
  const words = run.words;
  if (!words.length || words[0]!.includes("/") || baseName(words[0]!) !== prog || (prog !== "curl" && prog !== "wget")) return undefined;
  const args = words.slice(1);
  let address: string | undefined;
  // wget saves a page in the folder unless it is told where to put it.
  let sink = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-") && a !== "-") {
      if (prog === "curl") {
        if (CURL_LETTERS.test(a) || CURL_LONG.has(a)) continue;
        if (CURL_FILE.has(a)) { const v = args[++i]; if (v === undefined || !SINKS.has(v)) return undefined; continue; }
        if (CURL_NUMBER.has(a)) { const v = args[++i]; if (v === undefined || !within(a, v)) return undefined; continue; }
        return undefined;
      }
      if (WGET_LONG.has(a)) { if (a === "--spider") sink = true; continue; }
      const out = /^-(?:[qS]*)O(.*)$/.exec(a);
      if (out && !a.startsWith("--")) {
        sink = true;
        if (out[1] === "-") continue;
        if (out[1]) { if (!SINKS.has(out[1])) return undefined; continue; }
        const v = args[++i];
        if (v === undefined || !SINKS.has(v)) return undefined;
        continue;
      }
      if (WGET_FILE.has(a)) { sink = true; const v = args[++i]; if (v === undefined || !SINKS.has(v)) return undefined; continue; }
      if (WGET_NUMBER.has(a)) { const v = args[++i]; if (v === undefined || !within(a, v)) return undefined; continue; }
      return undefined;
    }
    if (address !== undefined || !ADDRESS.test(a) || a.length > 2048) return undefined;
    address = a;
  }
  if (prog === "wget" && !sink) return undefined;
  return address ? { address } : undefined;
}
