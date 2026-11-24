// What an MCP server's web tool is, from its name and the input of one call. The server is not Keel's, so it
// declares nothing (src/safety/addresses.ts `WebUse` is for Keel's own tools); the call itself shows whether it is a
// search (its result is the web's index) or a plain read of one address (its result is a page). Only the call is
// read, never what the server does, and both tests are allowlists: a tool whose name is not a known search or page
// read is neither, and a page read is plain only when every key of its input is the address or a known read-only
// option; any other key (a body, a header, a method, a cookie, a credential, an option no one has vouched for) makes
// the call a send.
import { serverOf } from "./provenance.ts";

export type WebShape = { search: true } | { fetch: string };

// Names that do something besides read, whatever else they hold.
const DOES = /(?:^|[_-])(post|put|patch|delete|send|upload|write|submit|navigate|click|type|fill|eval|execute|exec|run|create|update|set|save|download|form|login|auth|command)(?:$|[_-])|(post|send|upload|write|submit|navigate)/i;
// A search of the web: `search`, `web_search`, `brave_web_search`, `web_search_exa`.
const SEARCH = /^(?:[a-z0-9]+[_-])?(?:web[_-]?)?search(?:[_-](?:web|results|exa|internet))?$/i;
// A page read: `fetch`, `webfetch`, `web_fetch`, `fetch_url`, `fetch_webpage`, `firecrawl_scrape`, `read_url`, `get_page`.
const FETCH = /^(?:[a-z0-9]+[_-])?(?:(?:web|http)[_-]?)?(?:fetch|scrape|crawl)(?:[_-]?(?:url|page|webpage|site|content|html|markdown|text))?$|^(?:read|get|open|load|visit)[_-]?(?:url|page|webpage|link|site)$/i;

// The options the known web tools take besides the address that only shape what comes back (how much, in what form,
// which part). Compared with `_` and `-` taken out, in lower case.
const READ_ONLY = new Set(["maxchars", "maxlength", "maxtokens", "maxbytes", "startindex", "grep", "grepcontext", "extract", "format", "formats", "raw", "timeout", "limit", "offset", "onlymaincontent", "markdown", "html", "text"]);

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
  for (const k of keys) {
    if (k === "url") continue;
    const v = i[k];
    if (!READ_ONLY.has(k.replace(/[_-]/g, "").toLowerCase())) return undefined;
    if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return undefined;
  }
  return { fetch: url.trim() };
}
