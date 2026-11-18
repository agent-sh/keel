// Web search and fetch for every family. When the harness web CLIs are
// installed (agent-sh tools: harness-websearch-cli, harness-webfetch-cli) they
// do the work: readability extraction, SSRF guard, a keyless engine chain led
// by the hosted AI indexes, spill of long pages. Without them a small built-in
// path fetches the page itself and searches through Exa's keyless MCP index.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerCatalog } from "./catalog.ts";
import { spill } from "./spill.ts";

const HOME = homedir();
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
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
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

export type FetchOpts = { method?: string; body?: string; headers?: Record<string, string>; extract?: string; spillDir: string };

const PRIVATE_HOST = /^(localhost|.*\.localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i;

export async function webFetch(url: string, o: FetchOpts, signal?: AbortSignal): Promise<{ text: string; error?: boolean }> {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { text: `Not a URL: ${url}`, error: true }; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return { text: `Only http(s) URLs can be fetched. Read local files with the file tool.`, error: true };
  if (!u.hostname.includes(".") || PRIVATE_HOST.test(u.hostname)) {
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
    if (r.kind === "error") return { text: String(r.error?.message ?? JSON.stringify(r.error)), error: true };
    // The page itself, without the request echo: the model knows the URL.
    const body = typeof r.body_markdown === "string" && o.extract !== "raw" ? r.body_markdown : String(r.output ?? "");
    const final = r.meta?.final_url && r.meta.final_url !== u.href ? `Final URL: ${r.meta.final_url}\n\n` : "";
    return { text: await spill(final + body, o.spillDir, "webfetch"), error: r.kind !== "ok" };
  }
  const res = await fetch(u.href, {
    method: o.method ?? "GET", body: o.body, redirect: "manual", signal: signal ?? AbortSignal.timeout(60_000),
    headers: { "user-agent": "Keel (coding agent)", accept: "text/markdown, text/html;q=0.9, */*;q=0.5", ...o.headers },
  });
  if (res.status >= 300 && res.status < 400) {
    const to = new URL(res.headers.get("location") ?? "", u).href;
    if (new URL(to).host !== u.host) return { text: `${u.href} redirects to another host: ${to}\nFetch that URL in a call of its own if it is needed.` };
    return webFetch(to, o, signal);
  }
  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = /html/.test(type) && o.extract !== "raw" ? htmlToText(raw) : raw;
  return { text: await spill(`HTTP ${res.status}\n\n${text}`, o.spillDir, "webfetch"), error: !res.ok };
}

async function pdfText(url: string, o: FetchOpts, signal?: AbortSignal) {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(60_000) });
  if (!res.ok) return { text: `HTTP ${res.status} fetching the PDF`, error: true };
  const path = join(o.spillDir, "web", `${Bun.hash(url).toString(36)}.pdf`);
  await Bun.write(path, res);
  const p = Bun.spawn(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(p.stdout).text();
  return { text: await spill(`PDF saved to ${path}\n\n${text}`, o.spillDir, "webfetch-pdf") };
}

// A plain reading of an HTML page for when the extractor is not installed.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, "")
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
registerCatalog({
  name: "web",
  tools: async () => [
    {
      server: "web", name: "websearch", qualified: "web__websearch", readOnly: true,
      description: "Search the public web; returns ranked results with title, url and snippet. Read one with web__webfetch.",
      input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "integer" }, time_range: { type: "string", enum: ["all", "day", "week", "month", "year"] } }, required: ["query"] },
      run: async (i, ctx) => { const r = await webSearch(String(i.query ?? ""), { count: i.count, time_range: i.time_range }, ctx.signal); return { content: r.text, is_error: r.error }; },
    },
    {
      server: "web", name: "webfetch", qualified: "web__webfetch", readOnly: true,
      description: "Fetch an http(s) URL and return it as markdown (PDFs as text); long pages are saved to a file.",
      input_schema: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, body: { type: "string" }, headers: { type: "object" }, extract: { type: "string", enum: ["markdown", "raw", "both"] } }, required: ["url"] },
      run: async (i, ctx) => { const r = await webFetch(String(i.url ?? ""), { method: i.method, body: i.body, headers: i.headers, extract: i.extract, spillDir: ctx.spillDir }, ctx.signal); return { content: r.text, is_error: r.error }; },
    },
  ],
});
