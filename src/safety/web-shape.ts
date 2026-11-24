// What an MCP server's web tool is, from its name and the input of one call. The server is not Keel's, so it
// declares nothing (src/safety/addresses.ts `WebUse` is for Keel's own tools); the call itself shows whether it is a
// search (its result is the web's index) or a plain read of one address (its result is a page). Only the call is
// read, never what the server does, and both tests are allowlists: a tool whose name is not a known search or page
// read is neither, and a page read is plain only when every key of its input is the address or a known read-only
// option; any other key (a body, a header, a method, a cookie, a credential, an option no one has vouched for) makes
// the call a send.
import { serverOf } from "./provenance.ts";

// `texts`: what the model wrote into the call to look for in the page (`grep`, `extract`): it goes to the server, so the
// gate asks whether it copies the session.
export type WebShape = { search: true } | { fetch: string; texts?: string[] };

// Names that do something besides read, whatever else they hold.
const DOES = /(?:^|[_-])(post|put|patch|delete|send|upload|write|submit|navigate|click|type|fill|eval|execute|exec|run|create|update|set|save|download|form|login|auth|command)(?:$|[_-])|(post|send|upload|write|submit|navigate)/i;
// A search of the web: `search`, `web_search`, `brave_web_search`, `web_search_exa`.
const SEARCH = /^(?:[a-z0-9]+[_-])?(?:web[_-]?)?search(?:[_-](?:web|results|exa|internet))?$/i;
// A page read: `fetch`, `webfetch`, `web_fetch`, `fetch_url`, `fetch_webpage`, `firecrawl_scrape`, `read_url`, `get_page`.
const FETCH = /^(?:[a-z0-9]+[_-])?(?:(?:web|http)[_-]?)?(?:fetch|scrape|crawl)(?:[_-]?(?:url|page|webpage|site|content|html|markdown|text))?$|^(?:read|get|open|load|visit)[_-]?(?:url|page|webpage|link|site)$/i;

// The options the known web tools take besides the address that only shape what comes back (how much, in what form,
// which part), each with what its value may be: a count, a switch, one short word. Keys are compared as written (a
// spelling no known tool uses is not one of them), and a value of another shape makes the call a send.
const NUMBER = (v: unknown) => typeof v === "number" ? Number.isSafeInteger(v) && v >= 0 && v < 1e9 : typeof v === "string" && /^\d{1,9}$/.test(v);
// (A size or a time of zero is no limit in most servers: a bound is above zero.)
const BOUND = (v: unknown) => NUMBER(v) && Number(v) > 0;
const SWITCH = (v: unknown) => typeof v === "boolean" || v === "true" || v === "false";
const WORD = (v: unknown) => typeof v === "string" && /^[a-z0-9_-]{1,20}$/.test(v);
const READ_ONLY: Record<string, (v: unknown) => boolean> = {
  max_chars: BOUND, max_length: BOUND, max_tokens: BOUND, max_bytes: BOUND, start_index: NUMBER, grep_context: NUMBER,
  timeout: BOUND, limit: BOUND, offset: NUMBER,
  raw: SWITCH, only_main_content: SWITCH, markdown: SWITCH, html: SWITCH, text: SWITCH,
  format: WORD, formats: WORD,
};
// What a tool searches a page for, or pulls out of it: the model's own text, short, checked by the gate for the session's data.
const TEXT_MAX = 200;
const TEXT_KEYS = new Set(["grep", "extract"]);
const TEXT = (v: unknown): string[] | undefined => {
  const all = typeof v === "string" ? [v] : Array.isArray(v) && v.length <= 8 ? v : undefined;
  return all && all.every((x) => typeof x === "string" && x.length <= TEXT_MAX) ? (all as string[]) : undefined;
};

// The tool's own name, without its server's.
const baseOf = (tool: string): string => { const s = serverOf(tool); return s ? tool.slice(tool.lastIndexOf("__") + 2) : tool; };

export function webShape(tool: string, input: unknown): WebShape | undefined {
  const base = baseOf(tool);
  if (SEARCH.test(base)) return { search: true };
  if (!FETCH.test(base) || DOES.test(base)) return undefined;
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (!i) return undefined;
  const keys = Object.keys(i);
  // (A saved output has no input to read: its tool's name says what it was.)
  if (!keys.length) return { fetch: "" };
  const url = i.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return undefined;
  const texts: string[] = [];
  for (const k of keys) {
    if (k === "url") continue;
    const v = i[k];
    if (TEXT_KEYS.has(k)) { const t = TEXT(v); if (!t) return undefined; texts.push(...t); continue; }
    const ok = Object.hasOwn(READ_ONLY, k) ? READ_ONLY[k]! : undefined;
    if (!ok || !ok(v)) return undefined;
  }
  return { fetch: url.trim(), ...(texts.length ? { texts } : {}) };
}
