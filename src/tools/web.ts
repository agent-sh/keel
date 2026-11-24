// Web search and fetch for every family. When the harness web CLIs are
// installed (agent-sh tools: harness-websearch-cli, harness-webfetch-cli) they
// do the work: readability extraction, SSRF guard, a keyless engine chain led
// by the hosted AI indexes, spill of long pages. Without them a small built-in
// path fetches the page itself and searches through Exa's keyless MCP index.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCatalog, type CatalogTool } from "./catalog.ts";
import { sendShown } from "../safety/addresses.ts";
import { spill } from "./spill.ts";
import type { ToolContext } from "./types.ts";
import { READ_WHOLE_CHARS } from "../engine/reader.ts";
import { chunks, readText } from "../core/proc.ts";
import { privateHost } from "../core/hosts.ts";
import { noteOutward } from "../safety/egress.ts";
import { endpointOf, requestBytes } from "../safety/egress-count.ts";
import { homeDir } from "../core/paths";

const HOME = homeDir();
const findBin = (name: string, env?: string) =>
  [env && process.env[env], Bun.which(name), join(HOME, ".local/bin", name)].find((p): p is string => !!p && existsSync(p));

// Keys and a local SearXNG for the search chain: the process env first, then
// the harness web server's own .env when it sits in its usual place.
function webEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = process.env.KEEL_WEB_ENV ?? join(HOME, ".claude/mcp-servers/harness-web/.env");
  try {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
      if (m) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {}
  for (const k of ["BRAVE_API_KEY", "TAVILY_API_KEY", "SEARXNG_URL", "WEBSEARCH_ENGINE_ORDER"]) if (process.env[k]) out[k] = process.env[k]!;
  return out;
}

async function rpc(bin: string, method: string, params: unknown, session: unknown, signal?: AbortSignal): Promise<any> {
  const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe", signal, timeout: 90_000 });
  proc.stdin.write(JSON.stringify({ id: 1, method, params: { params, session } }) + "\n");
  proc.stdin.end();
  const [out, err] = await Promise.all([readText(proc.stdout), readText(proc.stderr), proc.exited]);
  const line = out.split("\n").find((l) => l.trim());
  if (!line) throw new Error(`${method}: no answer from ${bin}: ${err.slice(0, 300)}`);
  const d = JSON.parse(line);
  return d.result ?? d;
}

export type SearchOpts = { count?: number; time_range?: string; allowed_domains?: string[]; blocked_domains?: string[] };

export async function webSearch(query: string, o: SearchOpts = {}, signal?: AbortSignal): Promise<{ text: string; error?: boolean }> {
  let q = query;
  // Domain scoping the way search engines take it.
  if (o.allowed_domains?.length) q += " " + o.allowed_domains.map((d) => `site:${d}`).join(" OR ");
  if (o.blocked_domains?.length) q += " " + o.blocked_domains.map((d) => `-site:${d}`).join(" ");
  const bin = findBin("harness-websearch-cli", "KEEL_WEBSEARCH_BIN");
  if (bin) {
    const e = webEnv();
    const session: any = { unsafe_allow_search_without_hook: true, search_timeout_ms: 28_000 };
    if (e.BRAVE_API_KEY) Object.assign(session, { brave_api_key: e.BRAVE_API_KEY, fallback_to_keyless: true });
    if (e.TAVILY_API_KEY) Object.assign(session, { tavily_api_key: e.TAVILY_API_KEY, fallback_to_keyless: true });
    if (e.SEARXNG_URL) {
      Object.assign(session, { searxng_url: e.SEARXNG_URL, fallback_to_keyless: true });
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(e.SEARXNG_URL)) session.allow_loopback = true;
    }
    session.engine_order = e.WEBSEARCH_ENGINE_ORDER
      ? e.WEBSEARCH_ENGINE_ORDER.split(",").map((s) => s.trim()).filter(Boolean)
      : ["exa", "parallel", ...(session.searxng_url ? ["searxng"] : []), ...(session.brave_api_key ? ["brave"] : []),
         ...(session.tavily_api_key ? ["tavily"] : []), "mojeek", "marginalia", "wikipedia"];
    const params: any = { query: q, count: o.count ?? 8 };
    if (o.time_range && o.time_range !== "all") params.time_range = o.time_range;
    const r = await rpc(bin, "websearch", params, session, signal);
    // The helper program connects by itself: the ledger's row is the backend it says it asked, and the query it sent.
    const backend = typeof r.meta?.backend_host === "string" ? r.meta.backend_host : undefined;
    const searx = session.searxng_url ? endpointOf(session.searxng_url) : null;
    noteOutward({ via: `search helper${r.meta?.engine ? ` (${r.meta.engine})` : ""}`, host: backend ?? (r.meta?.engine ? String(r.meta.engine) : "a search engine"), port: searx && backend && searx.host === backend.toLowerCase() ? searx.port : null,
      bytes: requestBytes({ url: `https://${backend ?? "search"}/search?q=${encodeURIComponent(q)}` }), outcome: r.kind === "error" ? "failed" : "sent", ...(r.kind === "error" ? { why: String(r.error?.message ?? "the search failed") } : {}) });
    if (r.kind === "error") return { text: String(r.error?.message ?? JSON.stringify(r.error)), error: true };
    return { text: String(r.output ?? JSON.stringify(r.results ?? r)) };
  }
  return { text: await exaSearch(q, o.count ?? 8, signal) };
}

// Exa's hosted MCP index answers without a key.
async function exaSearch(query: string, count: number, signal?: AbortSignal): Promise<string> {
  const url = "https://mcp.exa.ai/mcp";
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const call = async (body: any) => {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...body }), signal });
    const sid = r.headers.get("mcp-session-id");
    if (sid) headers["mcp-session-id"] = sid;
    const text = await r.text();
    if (!r.ok) throw new Error(`search: HTTP ${r.status} ${text.slice(0, 200)}`);
    const data = text.trim().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).pop() ?? "{}";
    return JSON.parse(data);
  };
  await call({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "keel", version: "1" } } });
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).catch(() => {});
  const r = await call({ id: 2, method: "tools/call", params: { name: "web_search_exa", arguments: { query, numResults: count } } });
  if (r.error) throw new Error(`search: ${r.error.message}`);
  return (r.result?.content ?? []).map((c: any) => c.text ?? "").join("\n").trim() || "No results.";
}

// `whole`: the page uncut (for the reader), else long pages are spilled.
// `budget` (with `whole`): the characters the job this page is fetched for may
// still keep, shared by its fetches. A body that comes back as it is (plain
// text, raw extraction, a PDF's text) is read only while the budget lasts and
// takes from it as it streams: `took` says how much. A page of markup takes
// nothing while it is read (its text is a fraction of it, so it is read
// against a bound of its own), and neither does a page the fetch CLI returns:
// the caller charges the page it gets. `cut`: the body was longer than what
// was read.
export type FetchOpts = { method?: string; body?: string; headers?: Record<string, string>; extract?: string; spillDir: string; whole?: boolean; budget?: { left: number } };
export type Fetched = { text: string; error?: boolean; cut?: boolean; took?: number };

// The most markup read for one page when a budget is given: the fetch CLI's
// own hard cap for a response (10 MB), which the built-in path stands in for.
export const MARKUP_MAX = 10 * 1024 * 1024;

// A body as text. With a budget each chunk takes from it as it comes and the
// reading stops when it is spent, so a long body is never held whole.
async function bodyText(body: ReadableStream<Uint8Array> | null | undefined, pool?: { left: number }): Promise<{ text: string; taken: number; cut: boolean }> {
  if (!body) return { text: "", taken: 0, cut: false };
  if (!pool) return { text: await readText(body), taken: 0, cut: false };
  const dec = new TextDecoder();
  let text = "", taken = 0;
  for await (const c of chunks(body)) {
    const t = dec.decode(c, { stream: true });
    const n = Math.min(t.length, Math.max(0, pool.left));
    pool.left -= n;
    taken += n;
    text += n < t.length ? t.slice(0, n) : t;
    if (n < t.length) return { text, taken, cut: true };
  }
  return { text, taken, cut: false };
}

// (A host the web tools do not reach: src/core/hosts.ts. Web fetch, the http
// wait and the daemon's own git fetches share it.)
export { privateHost };

export async function webFetch(url: string, o: FetchOpts, signal?: AbortSignal): Promise<Fetched> {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { text: `Not a URL: ${url}`, error: true }; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return { text: `Only http(s) URLs can be fetched. Read local files with the file tool.`, error: true };
  if (privateHost(u.hostname)) {
    // (Refused before anything left: a row that says it was asked for.)
    noteOutward({ via: "web fetch", host: u.hostname, port: Number(u.port) || 443, bytes: 0, outcome: "refused", why: "a local or private address" });
    return { text: `${u.hostname} is a local or private address; reach local servers with curl in the shell.`, error: true };
  }
  if (/\.pdf($|\?)/i.test(u.pathname) && Bun.which("pdftotext")) return pdfText(u.href, o, signal);
  const bin = findBin("harness-webfetch-cli", "KEEL_WEBFETCH_BIN");
  if (bin) {
    const params: any = { url: u.href, extract: o.extract ?? "markdown" };
    if (o.method) params.method = o.method;
    if (o.body) params.body = o.body;
    if (o.headers) params.headers = o.headers;
    const r = await rpc(bin, "webfetch", params, { unsafe_allow_fetch_without_hook: true, spill_dir: join(o.spillDir, "web") }, signal);
    // The helper program connects by itself: the ledger's row is the address it was given, and where it ended when that is another host.
    const end = endpointOf(u.href)!;
    noteOutward({ via: "fetch helper", host: end.host, port: end.port, bytes: requestBytes({ method: o.method, url: u.href, headers: o.headers, body: o.body }), outcome: r.kind === "error" && !r.meta?.status ? "failed" : "sent", ...(typeof r.meta?.status === "number" ? { status: r.meta.status } : {}) });
    const last = typeof r.meta?.final_url === "string" ? endpointOf(r.meta.final_url) : null;
    if (last && last.host !== end.host) noteOutward({ via: "fetch helper (redirected)", host: last.host, port: last.port, bytes: null });
    if (r.kind === "error") return { text: String(r.error?.message ?? JSON.stringify(r.error)), error: true };
    // The page itself, without the request echo: the model knows the URL. A
    // page with an error status comes as the echo and the raw markup: it gets
    // its status first and its text, as the built-in fetch gives it.
    const status = r.kind !== "ok" && typeof r.meta?.status === "number" ? r.meta.status : undefined;
    const raw = typeof r.body_raw === "string" ? r.body_raw : undefined;
    const body = typeof r.body_markdown === "string" && o.extract !== "raw" ? r.body_markdown
      : status !== undefined && raw !== undefined ? `HTTP ${status}\n\n${/html/.test(String(r.meta?.content_type ?? "")) && o.extract !== "raw" ? htmlToText(raw) : raw}`
      : String(r.output ?? "");
    const final = r.meta?.final_url && r.meta.final_url !== u.href ? `Final URL: ${r.meta.final_url}\n\n` : "";
    return { text: o.whole ? final + body : await spill(final + body, o.spillDir, "webfetch"), error: r.kind !== "ok" };
  }
  return plainFetch(u, o, signal);
}

// The built-in fetch of a page webFetch has let through.
export async function plainFetch(u: URL, o: FetchOpts, signal?: AbortSignal): Promise<Fetched> {
  const res = await fetch(u.href, {
    method: o.method ?? "GET", body: o.body, redirect: "manual", signal: signal ?? AbortSignal.timeout(60_000),
    headers: { "user-agent": "Keel (coding agent)", accept: "text/markdown, text/html;q=0.9, */*;q=0.5", ...o.headers },
  });
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get("location") ?? "", u).href;
    if (new URL(to).host !== u.host) return { text: `${u.href} redirects to another host: ${to}\nFetch that URL in a call of its own if it is needed.` };
    // Where it ended is said, as the fetch CLI says it: the page there is the page fetched.
    const r = await webFetch(to, o, signal);
    return /^Final URL: /.test(r.text) ? r : { ...r, text: `Final URL: ${to}\n\n${r.text}` };
  }
  const type = res.headers.get("content-type") ?? "";
  const markup = /html/.test(type) && o.extract !== "raw";
  const pool = o.whole ? o.budget : undefined;
  const raw = await bodyText(res.body, pool && markup ? { left: MARKUP_MAX } : pool);
  const page = `HTTP ${res.status}\n\n${markup ? htmlToText(raw.text, raw.cut) : raw.text}`;
  if (!o.whole) return { text: await spill(page, o.spillDir, "webfetch"), error: !res.ok };
  return { text: page, error: !res.ok, ...(raw.cut ? { cut: true } : {}), ...(pool && !markup ? { took: raw.taken } : {}) };
}

async function pdfText(url: string, o: FetchOpts, signal?: AbortSignal): Promise<Fetched> {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60_000) });
  if (!res.ok) return { text: `HTTP ${res.status} fetching the PDF`, error: true };
  const path = join(o.spillDir, "web", `${Bun.hash(url).toString(36)}.pdf`);
  await Bun.write(path, res);
  const p = Bun.spawn(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "ignore" });
  const pool = o.whole ? o.budget : undefined;
  const text = await bodyText(p.stdout, pool);
  if (text.cut) p.kill();
  const page = `PDF saved to ${path}\n\n${text.text}`;
  if (!o.whole) return { text: await spill(page, o.spillDir, "webfetch-pdf") };
  return { text: page, ...(text.cut ? { cut: true } : {}), ...(pool ? { took: text.taken } : {}) };
}

// A page fetched for a request (the prompt of WebFetch and web_fetch): a long
// page goes to the session's reader model, which answers the request from it;
// the page is saved whole for a Read when the answer is not enough. A short
// page, a failed fetch, or readers that give no answer return the page as
// before. An answer from the parts that were read is kept when a part went
// unread: the note under it names that part and where the whole page is.
// `fetch`: what gets the page (a test gives its own).
export async function fetchFor(url: string, prompt: string, ctx: Pick<ToolContext, "spillDir" | "signal" | "read">, fetch: typeof webFetch = webFetch): Promise<{ text: string; error?: boolean }> {
  const ask = prompt.trim();
  if (!ask || !ctx.read) return fetch(url, { spillDir: ctx.spillDir }, ctx.signal);
  const r = await fetch(url, { spillDir: ctx.spillDir, whole: true }, ctx.signal);
  if (r.error || r.text.length <= READ_WHOLE_CHARS) return { ...r, text: await spill(r.text, ctx.spillDir, "webfetch") };
  mkdirSync(join(ctx.spillDir, "web"), { recursive: true });
  const path = join(ctx.spillDir, "web", `${Date.now()}-${Bun.hash(url).toString(36)}.md`);
  await Bun.write(path, r.text);
  try {
    const a = await ctx.read(url, r.text, ask);
    // Findings no reader could compile come back as they are, spilled when long.
    const how = a.compiled === false ? " in parts; their findings could not be compiled into one answer and follow as they are" : "";
    // A compiled answer comes back whole; only uncompiled findings can be long enough to spill.
    const unread = a.unread?.length ? ` Not read, so not covered by this answer:\n- ${a.unread.join("\n- ")}\n` : "";
    return { text: `${a.compiled === false ? await spill(a.text, ctx.spillDir, "webfetch-findings") : a.text}\n\n[${a.model} read ${unread ? "part of " : ""}the page (${r.text.length} chars) for this request${how}.${unread} The whole page is saved to ${path}; Read or Grep it ${unread ? "for what was not read, or " : ""}when this does not answer.]` };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { text: `[No reader could read the page for this request (${String((e as Error).message ?? e).slice(0, 300)}); the page follows as it is.]\n\n${await spill(r.text, ctx.spillDir, "webfetch")}` };
  }
}

// A plain reading of an HTML page for when the extractor is not installed.
// `cut`: the body stopped before its end, so an open script or tag at the tail is not text.
export function htmlToText(html: string, cut = false): string {
  const whole = html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "");
  return (cut ? whole.replace(/<(script|style|noscript|svg)\b[\s\S]*$/i, "").replace(/<[^>]*$/, "") : whole)
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n\n" + "#".repeat(Number(n)) + " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/pre)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The same two tools in the deferred catalog, for families whose own set has
// no web tool (search_tools finds them, mcp_call runs them).
export const webSearchTool: CatalogTool = {
  server: "web", name: "websearch", qualified: "web__websearch", readOnly: true, web: { search: true },
  description: "Search the public web; returns ranked results with title, url and snippet. Read one with web__webfetch.",
  input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" }, time_range: { type: "string", enum: ["all", "day", "week", "month", "year"] } }, required: ["query"] },
  run: async (i, ctx) => { const r = await webSearch(String(i.query ?? ""), { count: i.count, time_range: i.time_range }, ctx.signal); return { content: r.text, is_error: r.error }; },
};
// What a web__webfetch request sends besides its address.
function requestOf(i: any) {
  const method = typeof i?.method === "string" && i.method.trim() ? i.method.trim() : "GET";
  const headers = i?.headers && typeof i.headers === "object" && Object.keys(i.headers).length ? i.headers : undefined;
  const body = typeof i?.body === "string" && i.body ? i.body : undefined;
  return { method, headers, body };
}
// A plain GET or HEAD with no header and no body: it reads a page anyone can read.
const plainGet = (i: any) => { const r = requestOf(i); return /^(GET|HEAD)$/i.test(r.method) && !r.headers && !r.body; };
export const webFetchTool: CatalogTool = {
  server: "web", name: "webfetch", qualified: "web__webfetch", readOnly: true, web: { fetches: (i) => [String(i?.url ?? "")], links: true, public: (i, own) => plainGet(i) && !own(String(i?.url ?? "")) },
  description: "Fetch an http(s) URL and return it as markdown (PDFs as text); long pages are saved to a file.",
  input_schema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "string" }, headers: { type: "object" }, extract: { type: "string", enum: ["markdown", "raw", "both"] } }, required: ["url"] },
  // A request with a body, headers of its own or a method other than GET or HEAD sends what it carries to any
  // address, one the session has seen too; a plain one is a read of its page (src/safety/addresses.ts).
  judge: async (i) => {
    const url = String(i?.url ?? "");
    const { method, headers, body } = requestOf(i);
    if (!plainGet(i)) return { kind: "send", to: [url], shown: sendShown([url], { method, headers, body }), carries: true };
    return { kind: "read", fetches: [url] };
  },
  run: async (i, ctx) => { const r = await webFetch(String(i.url ?? ""), { method: i.method, body: i.body, headers: i.headers, extract: i.extract, spillDir: ctx.spillDir }, ctx.signal); return { content: r.text, is_error: r.error }; },
};
registerCatalog({ name: "web", except: ["claude", "gemini"], tools: async () => [webSearchTool, webFetchTool] });
