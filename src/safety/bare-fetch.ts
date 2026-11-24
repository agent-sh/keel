// Whether a shell command is a bare read of one address: a fetch program with only options that change nothing about
// the request, one address, and nothing the shell makes from files, variables or other commands. Everything else a
// fetch program can do (a body, a file to send, a header, a cookie, a credential, a proxy, a config file, another
// method, a list of addresses) is a send. The test is an allowlist: an option it does not know is a send, whatever it
// does, so a new flag or an abbreviation of a long one never reads as a page fetch.
import type { Simple } from "./shell.ts";
import { name as baseName, unwrap } from "./risk-words.ts";

// A word that is one address as written: no expansion, no glob, no quote left, no blank, no user name and password.
const ADDRESS = /^(?:https?:\/\/)?[A-Za-z0-9](?:[A-Za-z0-9.-]*)(?::\d{1,5})?(?:[/?#][^\s$`()\[\]{}\\"'<>|;*!~^@]*)?$/i;
const SAFE_WORD = /^[A-Za-z0-9_.\/+=,:%-]+$/;
const NUMBER = /^\d{1,5}(?:\.\d{1,3})?$/;

// curl: -s -S -L -I -f and any bundle of those letters, -o FILE, -m SECONDS and the long forms of the same.
const CURL_LETTERS = /^-[sSLIf]+$/;
const CURL_LONG = new Set(["--silent", "--show-error", "--location", "--head", "--fail", "--fail-with-body", "--no-progress-meter", "--compressed", "--http1.1", "--http2", "--ipv4", "--ipv6"]);
const CURL_FILE = new Set(["-o", "--output"]);
const CURL_NUMBER = new Set(["-m", "--max-time", "--connect-timeout", "--retry"]);
// wget: -q -nv -S --spider and -O FILE (also written -O- and -qO-).
const WGET_LONG = new Set(["-q", "-nv", "-S", "--quiet", "--no-verbose", "--server-response", "--spider"]);
const WGET_FILE = new Set(["-O", "--output-document"]);
const WGET_NUMBER = new Set(["-T", "--timeout", "-t", "--tries"]);

// Words of the one command `p` (a part of a parsed line) when it is a bare read, else undefined.
export function bareFetch(p: Simple, prog: string): { address: string } | undefined {
  if (p.unknown || p.heredoc || p.nested || p.flow || p.splits || p.dyn?.length || p.inputs?.length) return undefined;
  const run = unwrap(p.words);
  if (run.set.length || run.fed || run.deep) return undefined;
  const words = run.words;
  if (!words.length || baseName(words[0]!) !== prog || (prog !== "curl" && prog !== "wget")) return undefined;
  const args = words.slice(1);
  let address: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-") && a !== "-") {
      if (prog === "curl") {
        if (CURL_LETTERS.test(a) || CURL_LONG.has(a)) continue;
        if (CURL_FILE.has(a)) { const v = args[++i]; if (v === undefined || !SAFE_WORD.test(v) || v.startsWith("-")) return undefined; continue; }
        if (CURL_NUMBER.has(a)) { const v = args[++i]; if (v === undefined || !NUMBER.test(v)) return undefined; continue; }
        return undefined;
      }
      if (WGET_LONG.has(a)) continue;
      const out = /^-(?:[qS]*)O(.*)$/.exec(a);
      if (out && !a.startsWith("--")) {
        if (out[1] === "-") continue;
        if (out[1]) { if (!SAFE_WORD.test(out[1]) || out[1].startsWith("-")) return undefined; continue; }
        const v = args[++i];
        if (v === undefined || (v !== "-" && (!SAFE_WORD.test(v) || v.startsWith("-")))) return undefined;
        continue;
      }
      if (WGET_FILE.has(a)) { const v = args[++i]; if (v === undefined || (v !== "-" && !SAFE_WORD.test(v))) return undefined; continue; }
      if (WGET_NUMBER.has(a)) { const v = args[++i]; if (v === undefined || !NUMBER.test(v)) return undefined; continue; }
      return undefined;
    }
    if (address !== undefined || !ADDRESS.test(a) || a.length > 2048) return undefined;
    address = a;
  }
  return address ? { address } : undefined;
}
