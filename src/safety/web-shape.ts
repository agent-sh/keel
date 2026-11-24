// What an MCP server's web tool is, from its name and the input of one call. The server is not Keel's, so it
// declares nothing (src/safety/addresses.ts `WebUse` is for Keel's own tools); the call itself shows whether it is a
// search (its result is the web's index) or a plain read of one address (its result is a page). Only the call is
// read, never what the server does: a call that carries a body, a header, a cookie, a credential or a method other
// than GET or HEAD is not a plain read, and a tool whose name is not a search or a page read is neither.
import { serverOf } from "./provenance.ts";

export type WebShape = { search: true } | { fetch: string };

// Names of the parts of a request that carry something besides the address.
const CARRIES = /^(body|data|json|payload|form|multipart|headers?|cookies?|auth\w*|token|api_?key|key|password|credentials?|proxy|content|file|files|upload)$/i;
const SEARCH = /search/i;
const FETCH = /fetch|scrape|crawl|browse|visit|(?:read|get|open|load)[_-]?(?:url|page|link|site)/i;

// The tool's own name, without its server's.
const baseOf = (tool: string): string => { const s = serverOf(tool); return s ? tool.slice(tool.lastIndexOf("__") + 2) : tool; };

export function webShape(tool: string, input: unknown): WebShape | undefined {
  const base = baseOf(tool);
  const i = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined;
  if (SEARCH.test(base) && !FETCH.test(base)) return { search: true };
  if (!FETCH.test(base) || !i) return undefined;
  const keys = Object.keys(i);
  // (A saved output has no input to read: its tool's name says what it was.)
  if (!keys.length) return { fetch: "" };
  const url = i.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return undefined;
  for (const k of keys) {
    const v = i[k];
    if (k === "url") continue;
    if (CARRIES.test(k) && v !== undefined && v !== null && v !== "" && !(typeof v === "object" && !Object.keys(v as object).length)) return undefined;
    if (/^method$/i.test(k) && typeof v === "string" && v.trim() && !/^(GET|HEAD)$/i.test(v.trim())) return undefined;
    // Anything that is not a plain value could be a request's own part.
    if (v !== null && typeof v === "object") return undefined;
  }
  return { fetch: url.trim() };
}
