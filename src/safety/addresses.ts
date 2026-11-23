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
// (so the page's same-origin links count), not a reader's answer.
export type WebUse = { search: true } | { fetches(input: any): string[]; links: boolean };

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

// What an address carries that the owner should see before it is fetched, as a
// few words for the card, or null. Called for an address the session has not
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
// - its path is longer than `PATH_READ` folded characters.
export function dataIn(raw: string, inSession: (folded: string) => boolean, secret: (decoded: string) => boolean): string | null {
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
  if (secret(writtenHost(String(raw))) || secret(host)) return "a secret in its host";
  const path = decoded(u.pathname);
  if (secret(path)) return "a secret in its path";
  const f = fold(path);
  const whole = fold(host + path);
  if (whole.length >= WINDOW && inSession(whole)) return null;
  for (const label of host.split(".")) if (fold(label).length >= WINDOW && windowIn(fold(label), inSession)) return "text from this session in its host";
  if (f.length > PATH_READ) return "a very long path";
  if (f.length < WINDOW) return null;
  if (windowIn(f, inSession)) return "text from this session in its path";
  return null;
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

// One session's addresses, read from its events in order, a part at a time:
// `take` reads the events after the last it read. A call is matched to its
// result by id; the calls whose result has not come yet are kept for it.
// The folded text of what one session was given (tool results, and messages that are not the owner's: a subagent's report), the newest kept
// when it holds more than this many characters (one result is cut to its start).
const CORPUS_MAX = 1 << 20;

export class AddressBook {
  private known = new Set<string>();
  private corpus: string[] = [];
  private corpusSize = 0;
  private calls = new Map<string, { name: string; input: unknown }>();
  seq = 0;
  constructor(
    // How a stored call is read: its tool's web use and the input that tool takes (a dispatcher's call names its tool).
    private use: (name: string, input: unknown) => { use: WebUse; input: any } | undefined,
    // Whether a stored prompt is the owner's own words (src/core/owner.ts).
    private owner: (data: any) => boolean,
  ) {}

  has(address: string): boolean {
    const a = addressOf(address);
    return a === null || this.known.has(a);
  }
  get size() { return this.known.size; }
  // Whether some text the session was given holds this folded text.
  inResults(folded: string): boolean { return this.corpus.some((c) => c.includes(folded)); }

  private keep(text: string) {
    const f = fold(text.slice(0, CORPUS_MAX * 2)).slice(0, CORPUS_MAX);
    if (!f) return;
    this.corpus.push(f);
    this.corpusSize += f.length;
    while (this.corpusSize > CORPUS_MAX && this.corpus.length > 1) this.corpusSize -= this.corpus.shift()!.length;
  }

  private add(list: string[]) { for (const a of list) this.known.add(a); }

  take(events: readonly BookEvent[]) {
    for (const e of events) {
      if (e.seq <= this.seq) continue;
      this.seq = e.seq;
      const d = e.data;
      if (!d) continue;
      if (e.kind === "user") {
        if (this.owner(d)) this.add(ownerAddresses(String(d.text ?? "")));
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
          const text = ran ? textOf(r?.content) : "";
          if (text) this.keep(text);
          const call = this.calls.get(r?.tool_use_id);
          if (!call) continue;
          this.calls.delete(r.tool_use_id);
          if (!ran) continue;
          const how = this.use(call.name, call.input);
          if (!how) continue;
          if ("search" in how.use) { if (!r.is_error) this.add(urlsIn(text)); }
          else this.add(fetchedAddresses(how.use.fetches(how.input).map(String), text, how.use.links));
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
