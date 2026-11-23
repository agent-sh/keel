// The web addresses a session has seen, and whether a page fetch may go to
// one without the owner. A fetch sends what its address holds (its path and
// query) to whoever runs the host, so a fetch the model builds can carry out
// what it read. A fetch runs unasked only when its address came from outside
// the model:
//
// - an address the owner wrote in a prompt of their own (an http(s) URL, or a
//   bare name with a dot, `docs.example.com/page`, which is fetched as https);
// - an address in the result of a web search tool;
// - a page a fetch tool fetched, the address it ended at (`Final URL:`), and
//   the address a redirect it did not follow named;
// - a link in a fetched page that stays on that page's origin (scheme, host
//   and port): written out whole, or relative to the page when the call
//   fetched one page. Only the page's own text counts: when a reader model
//   answered for a long page, the links in its answer are a model's words.
//
// The address is matched whole, after the fetch tools' own reading of it:
// http is upgraded to https (the tools fetch it so), the host's case and a
// default port do not count, the fragment is never sent and does not count.
// Every path and query is a new address: `https://known.example/?d=...` is
// not `https://known.example/`. What a session's model wrote, a file, a
// command's or a program's output, and any other tool's result never make an
// address known. A session sees what its parent sessions saw (the owner's
// words reach an agent through them).
//
// A fetch to an address the session has not seen is judged a send, and held
// for the owner, only when the address carries data (`dataIn`); an address
// with none is fetched as before and recorded.
//
// Pure: the gate gives it the stored events and how to read each tool.
import { domainToUnicode } from "node:url";

// What a tool does on the web, declared by the tool. `fetches`: the addresses
// one call fetches, from its input. `links`: its result is the page's text
// (so the page's same-origin links count), not a reader's answer. `public`: the call read public pages
// and nothing else, so its result is the web's text and not the session's (a path that copies it leaks
// nothing the site did not have). Not public when it read a local file, sent a header or a body (the
// reply may be private), or fetched an address the owner wrote (a link that is a capability: an
// unlisted page, a gist, a presigned address). `fromOwner`: whether an address is one the owner wrote.
export type WebUse = { search: true } | { fetches(input: any): string[]; links: boolean; public?(input: any, fromOwner: (address: string) => boolean): boolean };

// An address as the fetch tools read it, or null when no fetch tool would send anything for it.
export function addressOf(raw: string): string | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return null;
  u.hash = "";
  return u.href;
}

// An address as the owner should read it: the one `addressOf` gives, with its fragment kept.
export function wholeOf(raw: string): string {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol === "http:") u.protocol = "https:";
    return u.href;
  } catch { return String(raw).trim(); }
}

// Letters and digits of a text in lower case, nothing between them: the form a
// path's words and a file's words are compared in (`the-notes_from%20a-file` and `The notes from a file`).
export const fold = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
// The shortest run of folded characters in a path that makes it the session's text. An AWS
// key id has twenty; a phrase of four words has about as many and does not recur in a path by chance.
export const WINDOW = 20;
// What of a path is looked at, folded. A path longer than this carries data: it is
// longer than any page's address and room for anything, and scanning it window by window
// against a session's text would cost a pass over that text for each window (a rolling hash
// of the text would scan it once, and cost memory a session's text does not earn).
export const PATH_READ = 512;

// A text percent-decoded until it stops changing, at most three rounds (`%2561` is `%61` is `a`).
export function decoded(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try { next = decodeURIComponent(out); } catch { break; }
    if (next === out) break;
    out = next;
  }
  return out;
}

// The host as written, with its case: the URL parser lowercases it, and a key's case is part of it.
const writtenHost = (raw: string): string => /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]*)/i.exec(raw.trim())?.[1]?.replace(/:\d*$/, "") ?? "";

// Some run of `WINDOW` characters of the folded text is in the session's text.
const windowIn = (f: string, inSession: (folded: string) => boolean): boolean => {
  for (let i = 0; i + WINDOW <= f.length; i++) if (inSession(f.slice(i, i + WINDOW))) return true;
  return false;
};

// Text read from a token as a form of encoding: hex, base64, base64url or base32 that holds
// readable UTF-8 (no control characters). Nothing else is read as text.
const utf8 = new TextDecoder("utf-8", { fatal: true });
const readable = (b: Uint8Array): string | null => {
  try {
    const t = utf8.decode(b);
    return /[\p{C}]/u.test(t.replace(/[\t\n\r]/g, "")) ? null : t;
  } catch { return null; }
};
function base32(t: string): Uint8Array | null {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of t.toLowerCase().replace(/=+$/, "")) {
    const v = a.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  return Uint8Array.from(out);
}
// The shortest token read as encoded text: 16 characters hold 8 bytes in hex, 12 in base64, 13 in base32.
export const ENCODED_MIN = 12;
export function encodedAs(token: string): { form: string; text: string }[] {
  const out: { form: string; text: string }[] = [];
  if (token.length < ENCODED_MIN) return out;
  const add = (form: string, b: Uint8Array | null) => {
    const text = b && b.length >= 8 ? readable(b) : null;
    if (text && text.trim().length >= 8) out.push({ form, text });
  };
  if (/^(?:[0-9a-f]{2})+$/i.test(token)) add("hex", Buffer.from(token, "hex"));
  if (/^[a-z2-7]+=*$/i.test(token) && token.length >= 13) add("base32", base32(token));
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(token) && token.replace(/=+$/, "").length % 4 !== 1) add("base64", Buffer.from(token, "base64"));
  if (/^[A-Za-z0-9_-]+$/.test(token) && token.length % 4 !== 1) add("base64url", Buffer.from(token, "base64url"));
  return out;
}

// A token that has the shape and spread of encoded data: letters and digits only, 16 or more of
// them (12 bytes), the spread of random text, not a commit or file hash. 16 is the length at which
// a chunk holds enough to be worth one request and a model's own words (a slug, a version) are
// not mixed with digits at that spread; a shorter chunk goes out in pieces, which the count of
// addresses on one host (HOST_CAP) holds.
export const SHAPE_MIN = 16;
// A host label is a chunk a request: a label of this length with the shape counts (a name is words, not letters and digits at this spread).
export const SHAPE_MIN_LABEL = 12;
const entropy = (t: string): number => {
  const n = new Map<string, number>();
  for (const c of t) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const v of n.values()) h -= (v / t.length) * Math.log2(v / t.length);
  return h;
};
// The lengths of a digest or an id that is written in hex everywhere: 32 (an md5, a gist id, a UUID without
// dashes), 40 (a git object), 64 (a sha256). A value that long is one of these far more often than a chunk of data.
const DIGESTS = new Set([32, 40, 64]);
export function encodedShape(token: string, min = SHAPE_MIN): string | null {
  if (token.length < min || !/^[A-Za-z0-9]+$/.test(token) || !/\d/.test(token) || !/[A-Za-z]/.test(token)) return null;
  if (/^[0-9a-f]+$/i.test(token)) return DIGESTS.has(token.length) ? null : "hex";
  return entropy(token) >= 3.5 ? "random letters and digits" : null;
}

// Hosts where a hex value in a path is a content hash the host made (a package's file, its place in a
// store), not a chunk anyone chose: the package and file hosts that put a hash in a directory name.
const HASHED_PATHS = ["files.pythonhosted.org", "pypi.org", "registry.npmjs.org", "static.crates.io", "rubygems.org", "repo1.maven.org", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com", "proxy.golang.org"];
// Hosts whose first label the platform picked at random (a distribution, a function url, a public bucket):
// nobody chose it, so it carries nothing.
const ASSIGNED_LABEL = ["cloudfront.net", "on.aws", "r2.dev"];
const under = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));
// A hex part of a file name with an extension (`main.8f3a2b1c9d4e5f60.js`, `app.0123abcd4567.css`): a build's name for the file.
const inFileName = (parts: string[], i: number) => parts.length >= 3 && i > 0 && i < parts.length - 1 && /^[a-z][a-z0-9]{0,7}$/i.test(parts.at(-1)!);

// The most addresses a session fetches on one host that it had not seen before the fetch: the next asks.
// Data in pieces too short to be held one by one (a value cut into chunks, a chunk a request) takes this many
// requests to go out. A session of the owner's ledger made at most 9 on one host.
export const HOST_CAP = 10;

// What an address carries that the owner should see before it is fetched, as a
// few words for the card, or null. Called for an address the session has not
// seen; `unseenOnHost`: how many addresses the session has fetched on this host that it had not
// seen. An address carries data when (the whole test):
// - its query string is not empty; or
// - it has a user name or a password (`https://KEY@host/`), or a port of its own
//   (not the scheme's default); or
// - its fragment holds a secret or session text (below). A fragment is not sent by the
//   fetch tools, and an anchor of a docs page is most of the addresses a model makes
//   with one: it runs. One that holds a secret or the session's text is held all the same,
//   for a tool that does send it; or
// - its path or its host holds a secret (`secret`: the vault's known values, a value shaped
//   like a key, a placeholder), the path percent-decoded until it stops changing (three
//   rounds), the host as written and as an internationalized name reads; or
// - its path holds text the session read or ran: `WINDOW` characters in a row, folded,
//   found in the folded text of what the session was given (`inSession`: tool results
//   and messages that are not the owner's), unless the address stands whole in that text,
//   in which case it was copied and carries nothing the session did not already have (a
//   link in a README). So does a host label of `WINDOW` characters or more; a shorter
//   label (`data.attacker.example`) is not looked at; or
// - a segment of its path (between slashes, or before a dot) or a label of its host is encoded
//   data (`encodedAs`, `encodedShape`): it reads, as hex, base64, base64url or base32, as a
//   secret or as 12 or more folded characters of the session's text, or it has the shape of
//   random letters and digits; or
// - its path is longer than `PATH_READ` folded characters; or
// - it is the address after the `HOST_CAP`th the session fetched on its registered domain unseen.
//
// A path that ends with one whole run of a listing the session was given (`listed`: a path a command
// printed, a tree), on a host the session already knows, is a copy of what it was given: the text of
// that run is not looked for in the session's text (the rest of the path is). Hex that is a digest or an
// id (32, 40 or 64), a hash in a file name with an extension, a hash under a package host, and the
// label a platform assigned (`cloudfront.net`) are not encoded data.
export function dataIn(raw: string, inSession: (folded: string) => boolean, secret: (decoded: string) => boolean, unseenOnHost = 0, listed?: (host: string, path: string) => number): string | null {
  return contents(raw, inSession, secret, listed) ?? (unseenOnHost >= HOST_CAP ? `address number ${unseenOnHost + 1} on one registered domain this session had not seen` : null);
}

function contents(raw: string, inSession: (folded: string) => boolean, secret: (decoded: string) => boolean, listed?: (host: string, path: string) => number): string | null {
  let u: URL;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  // The port is read as the fetch reads the address: http is fetched as https.
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.search.length > 1) return "a query string";
  if (u.username || u.password) return "a user name or password";
  if (u.port) return "a port of its own";
  const fragment = decoded(u.hash.slice(1));
  if (fragment && (secret(fragment) || windowIn(fold(fragment), inSession))) return "a secret or text from this session in its fragment";
  const host = domainToUnicode(u.hostname) || u.hostname;
  const written = writtenHost(String(raw)) || host;
  if (secret(written) || secret(host)) return "a secret in its host";
  const path = decoded(u.pathname);
  if (secret(path)) return "a secret in its path";
  const whole = fold(host + path);
  // The path as it is searched for the session's text: what is left of it when a whole listed run ends it.
  const f = fold(path.slice(0, path.length - (listed?.(u.hostname.toLowerCase(), path) ?? 0)));
  if (whole.length >= WINDOW && inSession(whole)) return null;
  for (const label of host.split(".")) if (fold(label).length >= WINDOW && windowIn(fold(label), inSession)) return "text from this session in its host";
  if (fold(path).length > PATH_READ) return "a very long path";
  // What a segment says read as encoded text: a secret, or text the session was given.
  const said = (text: string) => secret(text) || (fold(text).length >= ENCODED_MIN && (fold(text).length < WINDOW ? inSession(fold(text)) : windowIn(fold(text), inSession)));
  // The tokens of a path: its segments and the parts of a segment between dots, and the segments joined (a value cut
  // into segments is one value); of a host: its labels without the registered name and its suffix, and those joined.
  const segs = path.split("/").filter(Boolean);
  const labels = written.split(".").filter(Boolean).slice(0, -2);
  // Joined, they are read as encoded text, and have the shape only when each piece is a chunk of random
  // letters and digits (`docs/api/v2/reference` is words).
  const chunk = (x: string) => x.length >= 6 && /^[A-Za-z0-9]+$/.test(x) && /\d/.test(x) && /[A-Za-z]/.test(x);
  const where: [string, string[], string[], number][] = [
    ["its path", segs.flatMap((x) => (x.includes(".") ? [x, ...x.split(".").map((part, i, all) => (/^[0-9a-f]+$/i.test(part) && inFileName(all, i) ? "" : part))] : [x])), segs.length > 1 ? [segs.join("")] : [], SHAPE_MIN],
    ["its host", written.split(".").filter(Boolean).map((l, i) => (i === 0 && under(host, ASSIGNED_LABEL) ? "" : l)), labels.length > 1 ? [labels.join("")] : [], SHAPE_MIN_LABEL],
  ];
  const hashed = under(host, HASHED_PATHS);
  for (const [place, tokens, joined, min] of where) {
    const pieces = place === "its path" ? segs : labels;
    for (const t of [...tokens, ...joined]) {
      for (const d of encodedAs(t)) if (said(d.text)) return `${d.form} data in ${place} that reads as this session's text or a secret`;
    }
    for (const t of tokens) {
      const shape = encodedShape(t, min);
      if (shape && !(hashed && place === "its path" && shape === "hex")) return `encoded data (${shape}) in ${place}`;
    }
    if (joined.length && pieces.every(chunk)) {
      const shape = encodedShape(joined[0]!, min);
      if (shape) return `encoded data (${shape}, in pieces) in ${place}`;
    }
  }
  if (f.length < WINDOW) return null;
  if (windowIn(f, inSession)) return "text from this session in its path";
  return null;
}

// The host of an address (with its port), in lower case.
export const hostOf = (address: string): string | null => { try { return new URL(address).host.toLowerCase(); } catch { return null; } };

// The registered domain of an address's host: the two last labels, three under a country's second level
// (`co.uk`); an IP address as it is. The addresses a session fetches are counted by it, so a value cut into
// pieces and sent to `s0.attacker.example` ... `s6.attacker.example` is one count.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go"]);
export function groupOf(address: string): string | null {
  let h: string;
  try { h = new URL(/^[a-z][a-z0-9+.-]*:/i.test(address) ? address : `https://${address}`).hostname.toLowerCase(); } catch { return null; }
  if (/^[\d.]+$/.test(h) || h.startsWith("[")) return h;
  const l = h.split(".");
  if (l.length <= 2) return h;
  return l.slice(-(l.at(-1)!.length === 2 && SECOND_LEVEL.has(l.at(-2)!) ? 3 : 2)).join(".");
}

// The origin a link must share with the page it is on.
const originOf = (address: string): string | null => { try { return new URL(address).origin; } catch { return null; } };

// A URL ends before a space, a quote, an angle or square bracket or a
// backtick (a markdown link's `](` ends its text); a closing bracket or a
// sentence's punctuation at its end is the text's.
const URLS = /https?:\/\/[^\s<>"'`[\]]+/gi;
function trimmed(u: string): string {
  let s = u.replace(/[.,;:!?*_~]+$/, "");
  // A closing bracket with no opening one in the URL belongs to the text around it.
  for (const [open, close] of [["(", ")"], ["{", "}"]] as const) {
    while (s.endsWith(close) && s.split(open).length <= s.split(close).length - 1) s = s.slice(0, -1).replace(/[.,;:!?*_~]+$/, "");
  }
  return s;
}

// Every http(s) URL written out in a text, as addresses.
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(URLS)) {
    const a = addressOf(trimmed(m[0]));
    if (a) out.push(a);
  }
  return out;
}

// A bare name with a dot, as an owner types one: `docs.example.com`, `example.com/a?b=1`.
const BARE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?][^\s]*)?$/i;

// The addresses the owner's own words name.
export function ownerAddresses(text: string): string[] {
  const out = urlsIn(text);
  for (const word of String(text ?? "").split(/\s+/)) {
    const w = trimmed(word.replace(/^[(<\["'`]+/, "").replace(/[>"'`]+$/, ""));
    if (!w || /^https?:/i.test(w) || w.includes("@") || !BARE.test(w)) continue;
    const a = addressOf(`https://${w}`);
    if (a) out.push(a);
  }
  return out;
}

// The links of a page that are relative to it: markdown targets and HTML hrefs.
const RELATIVE = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\bhref\s*=\s*["']([^"']+)["']/gi;
// A long page a reader model read for the request: the answer is the reader's (src/tools/web.ts, fetchFor).
const READER_ANSWER = /\n\n\[[^\n\]]+ read (?:part of )?the page \(\d+ chars\) for this request/;
export const readerAnswered = (text: string) => READER_ANSWER.test(text);

// What a fetch call makes known: the addresses it fetched, where they ended
// and where a redirect pointed, and the same-origin links of its pages.
export function fetchedAddresses(fetched: string[], result: string, links: boolean): string[] {
  const pages = fetched.map(addressOf).filter((a): a is string => !!a);
  const ends = [...result.matchAll(/^Final URL: (\S+)$/gm)].map((m) => addressOf(m[1]!)).filter((a): a is string => !!a);
  const pointed = [...result.matchAll(/ redirects to another host: (\S+)$/gm)].map((m) => addressOf(m[1]!)).filter((a): a is string => !!a);
  const out = [...pages, ...ends, ...pointed];
  if (!links || readerAnswered(result)) return out;
  const origins = new Set([...pages, ...ends].map(originOf).filter(Boolean));
  for (const a of urlsIn(result)) if (origins.has(originOf(a))) out.push(a);
  // Relative links are read against the page only when the call fetched one.
  const base = pages.length === 1 ? ends.at(-1) ?? pages[0]! : null;
  if (base) for (const m of result.matchAll(RELATIVE)) {
    const href = m[1] ?? m[2] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    let a: string | null = null;
    try { a = addressOf(new URL(href, base).href); } catch {}
    if (a && origins.has(originOf(a))) out.push(a);
  }
  return out;
}

// The text of a tool result as stored.
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("\n") : "";

// A stored event as this reads it.
export type BookEvent = { seq: number; kind: string; data: any };

// The runs of words joined by slashes in a text (a path a command printed, a tree's line, a URL's path), the
// parts of a run that are a segment each: `src/a/b.ts`, `home/u/clients/x.md`. One pass over the text, a run
// no longer than `RUN_MAX` characters and at least two segments; a leading `.`, `..` and `~` segment is not a part of the run.
const RUN_MAX = 400;
const segChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 126 || c === 37 || c === 43 || c === 64 || c === 45 || c === 95;
export function runsIn(text: string, into: Set<string>, room: { left: number }) {
  let start = -1, slash = false;
  const n = text.length;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? text.charCodeAt(i) : 0;
    if (i < n && (c === 47 || segChar(c))) {
      if (start < 0) { start = i; slash = false; }
      if (c === 47 && i > start) slash = true;
      continue;
    }
    if (start >= 0 && slash && i - start <= RUN_MAX && room.left > 0) {
      const parts = text.slice(start, i).split("/").filter(Boolean);
      while (parts.length && (parts[0] === "." || parts[0] === ".." || parts[0] === "~")) parts.shift();
      if (parts.length >= 2) { const run = parts.join("/").toLowerCase(); if (!into.has(run)) { into.add(run); room.left -= run.length; } }
    }
    start = -1;
  }
}

// What a session's book keeps of the text it was given. The folded text of what one session was given (the
// results of tools that did not read public pages only, and messages that are not the owner's: a subagent's
// report), the newest kept when it holds more than this many characters (one result is cut to its start).
const CORPUS_MAX = 1 << 20;
// The room for the runs of slash-joined words.
const RUNS_MAX = 1 << 20;

// One session's addresses, read from its events in order, a part at a time:
// `take` reads the events after the last it read. A call is matched to its
// result by id; the calls whose result has not come yet are kept for it.
export class AddressBook {
  private known = new Set<string>();
  // The addresses the owner wrote in their own prompts (a link of theirs may be a capability).
  private owned = new Set<string>();
  // The hosts of the addresses the session knows, lower case.
  private hosts = new Set<string>();
  private corpus: string[] = [];
  private corpusSize = 0;
  // The addresses fetched that were not known when the call was made, by registered domain.
  private unseen = new Map<string, Set<string>>();
  // The addresses written out in what the session was given, as `fold(host + path)`: an address copied from there is the
  // text's own, whole.
  private copied = new Set<string>();
  // The runs of slash-joined words in what the session was given, lower case.
  private runs = new Set<string>();
  private runsRoom = { left: RUNS_MAX };
  private calls = new Map<string, { name: string; input: unknown }>();
  seq = 0;
  constructor(
    // How a stored call is read: its tool's web use and the input that tool takes (a dispatcher's call names its tool).
    private use: (name: string, input: unknown) => { use: WebUse; input: any } | undefined,
    // Whether a stored prompt is the owner's own words (src/core/owner.ts).
    private owner: (data: any) => boolean,
    // Whether an address was written by the owner in a session above this one (the gate gives the parent chain).
    private above?: (address: string) => boolean,
  ) {}

  has(address: string): boolean {
    const a = addressOf(address);
    return a === null || this.known.has(a);
  }
  get size() { return this.known.size; }
  // Whether the owner wrote this address in a prompt of this session or of one above it.
  fromOwner = (address: string): boolean => {
    const a = addressOf(address);
    return !!a && (this.owned.has(a) || !!this.above?.(a));
  };
  ownedHas(address: string): boolean { return this.owned.has(address); }
  // How many addresses this session fetched on a registered domain (given as an address or a host) that it had not seen when it fetched them.
  unseenOn(of: string): number { const g = groupOf(of); return g ? this.unseen.get(g)?.size ?? 0 : 0; }
  // Whether some text the session was given holds this folded text.
  inResults(folded: string): boolean { return this.copied.has(folded) || this.corpus.some((c) => c.includes(folded)); }
  // How many characters of `path` its end shares with a whole run of a listing the session was given, when the
  // session knows `host` (0 when not): the address copies a line of what it was given. A run is two segments at least.
  listed = (host: string, path: string): number => {
    if (!this.hosts.has(host) || !this.runs.size) return 0;
    const trimmed = path.replace(/\/+$/, "");
    const segs = trimmed.split("/").filter(Boolean);
    let best = 0;
    for (let k = 2, tail = ""; k <= Math.min(segs.length, 64); k++) {
      tail = segs.slice(-k).join("/");
      if (tail.length > RUN_MAX) break;
      if (this.runs.has(tail.toLowerCase())) best = tail.length + (path.length - trimmed.length);
    }
    return best;
  }

  private keep(text: string) {
    const cut = text.slice(0, CORPUS_MAX + (CORPUS_MAX >> 1));
    for (const a of urlsIn(cut)) {
      if (this.copied.size >= 4096) break;
      try { const u = new URL(a); this.copied.add(fold(u.host + decoded(u.pathname))); } catch {}
    }
    runsIn(cut, this.runs, this.runsRoom);
    const f = fold(cut).slice(0, CORPUS_MAX);
    if (!f) return;
    this.corpus.push(f);
    this.corpusSize += f.length;
    while (this.corpusSize > CORPUS_MAX && this.corpus.length > 1) this.corpusSize -= this.corpus.shift()!.length;
  }

  private add(list: string[]) {
    for (const a of list) {
      this.known.add(a);
      const h = hostOf(a);
      if (h && this.hosts.size < 4096) this.hosts.add(h);
    }
  }

  take(events: readonly BookEvent[]) {
    for (const e of events) {
      if (e.seq <= this.seq) continue;
      this.seq = e.seq;
      const d = e.data;
      if (!d) continue;
      if (e.kind === "user") {
        if (this.owner(d)) {
          const written = ownerAddresses(String(d.text ?? ""));
          for (const a of written) this.owned.add(a);
          this.add(written);
        }
        // What is not the owner's (a subagent's report, a harness notice) is text the session was given: a path may copy it.
        else if (typeof d.text === "string") this.keep(d.text);
      } else if (e.kind === "assistant") {
        for (const b of d.blocks ?? []) {
          if (b?.type === "tool_use" && typeof b.id === "string" && this.use(String(b.name), b.input)) this.calls.set(b.id, { name: String(b.name), input: b.input });
        }
        // (Bounded: a call cut without a result is not waited for forever.)
        if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value!);
      } else if (e.kind === "tool_result") {
        // A call the gate refused, or one that never ran, fetched nothing.
        const ran = d.verdict === undefined || d.verdict === "failed";
        for (const r of d.results ?? []) {
          const call = this.calls.get(r?.tool_use_id);
          const how = call && ran ? this.use(call.name, call.input) : undefined;
          const text = ran ? textOf(r?.content) : "";
          // What a call returned is the session's text, except what it read of public pages and nothing else (a search,
          // a page fetched by an address the model made or a search gave): that is the web's text, and a path that copies
          // it leaks nothing the site did not have. A file a reader read, a reply to a request with a header or a body, a
          // page at an address the owner wrote (it may be a link that is a key) and every other tool's result are the session's.
          const publicOnly = !!how && ("search" in how.use || how.use.public?.(how.input, this.fromOwner) === true);
          if (text && !publicOnly) this.keep(text);
          if (!call) continue;
          this.calls.delete(r.tool_use_id);
          if (!how) continue;
          if ("search" in how.use) { if (!r.is_error) this.add(urlsIn(text)); }
          else {
            const asked = how.use.fetches(how.input).map(String);
            for (const raw of asked) {
              const a = addressOf(raw);
              if (!a || this.known.has(a)) continue;
              const group = groupOf(a);
              if (!group) continue;
              let set = this.unseen.get(group);
              if (!set) this.unseen.set(group, (set = new Set()));
              if (set.size < 4 * HOST_CAP) set.add(a);
            }
            this.add(fetchedAddresses(asked, text, how.use.links));
          }
        }
      }
    }
  }
}

// What a card and the judge are shown of a fetch to addresses that carry data: each address whole, then each of its query parameters on a line
// of its own, decoded, so what it would send is read at once.
export function sendShown(addresses: string[], extra?: { method?: string; headers?: unknown; body?: string }): string {
  const lines: string[] = [];
  for (const raw of addresses) {
    const a = wholeOf(raw);
    lines.push(extra?.method && extra.method.toUpperCase() !== "GET" ? `${extra.method.toUpperCase()} ${a}` : a);
    let q: URLSearchParams | null = null;
    try { q = new URL(a).searchParams; } catch {}
    if (q) for (const [k, v] of q) lines.push(`  ${k} = ${v}`);
  }
  if (extra?.headers && typeof extra.headers === "object" && Object.keys(extra.headers).length) lines.push(`Headers: ${JSON.stringify(extra.headers)}`);
  if (extra?.body) lines.push(`Body:\n${extra.body}`);
  return lines.join("\n");
}
