// The GitHub REST API, as the pull request watcher speaks it: conditional
// reads (an ETag per URL, a 304 costs nothing against the hourly limit when
// the request carries credentials) and one write (a review).
//
// Credentials, the first that answers: a token the owner saved in Keel (the
// system keyring, entry `github-token`), GH_TOKEN or GITHUB_TOKEN in the
// daemon's environment, else the owner's gh login (`gh auth token`). A token
// is held in memory only, never logged, never put in an error or a command line.
import { key } from "../providers/creds.ts";
import { gitEnv } from "../core/git.ts";
import { readText } from "../core/proc.ts";

export const TOKEN_CRED = "github-token";
// GitHub Enterprise Server's API is at https://HOST/api/v3; a spec's stand-in names its own.
export const apiBase = () => (process.env.KEEL_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
// The API is a server on this machine (a stand-in): only then is a clone address that is a folder fetched.
export const localApi = () => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(apiBase());

export type Source = "keel" | "env" | "gh" | null;
let held: { token: string; source: Exclude<Source, null>; at: number } | null = null;
const HOLD_MS = 5 * 60_000;

async function ghToken(): Promise<string | null> {
  const host = new URL(apiBase()).hostname.replace(/^api\./, "");
  const gh = process.env.KEEL_GH_BIN || "gh";
  if (gh === "gh" && !Bun.which("gh")) return null;
  try {
    // (gh runs git by itself: outside any repository, with the daemon's keys.)
    const p = Bun.spawn([gh, "auth", "token", "--hostname", host === "127.0.0.1" || host === "localhost" ? "github.com" : host], { cwd: "/", env: { ...gitEnv("/"), GH_PROMPT_DISABLED: "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    const [out, code] = await Promise.all([readText(p.stdout, "gh auth token"), p.exited]);
    return code === 0 ? out.trim().split("\n")[0]!.trim() || null : null;
  } catch {
    return null;
  }
}

export async function token(fresh = false): Promise<{ token: string; source: Exclude<Source, null> } | null> {
  if (!fresh && held && Date.now() - held.at < HOLD_MS) return held;
  const own = await key({ cred: TOKEN_CRED });
  const env = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  const t = own ? { token: own, source: "keel" as const } : env ? { token: env, source: "env" as const } : await ghToken().then((x) => (x ? { token: x, source: "gh" as const } : null));
  held = t ? { ...t, at: Date.now() } : null;
  return t;
}
export const forgetToken = () => { held = null; };

export type Answer = { status: number; headers: Headers; body: any; etag?: string };

// One request. `etag`: the value kept from the last 200 of this URL (sent as
// If-None-Match; "the quotes around the ETag value are important", so it is
// sent as GitHub gave it).
export async function request(method: "GET" | "POST", pathOrUrl: string, o: { etag?: string | null; body?: unknown; signal?: AbortSignal } = {}): Promise<Answer> {
  const t = await token();
  if (!t) throw Object.assign(new Error("no GitHub credentials: sign in with gh (gh auth login), or save a token in Keel's settings"), { status: 401 });
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : apiBase() + pathOrUrl;
  if (!url.startsWith(apiBase())) throw new Error("a link GitHub gave leads outside its API");
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "keel",
    authorization: `Bearer ${t.token}`,
  };
  if (o.etag) headers["if-none-match"] = o.etag;
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal ?? AbortSignal.timeout(30_000) });
  const text = r.status === 304 ? "" : await r.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 300) }; }
  if (r.status === 401) forgetToken();
  return { status: r.status, headers: r.headers, body, etag: r.headers.get("etag") ?? undefined };
}

// A clone address with the token git needs for it: the header goes through
// git's environment (http.<origin>/.extraHeader), scoped to that origin only.
export function fetchKeys(url: string, tok: string | null): [string, string][] {
  if (!tok || !/^https:\/\//.test(url)) return [];
  const origin = new URL(url).origin;
  return [[`http.${origin}/.extraHeader`, `Authorization: Basic ${Buffer.from(`x-access-token:${tok}`).toString("base64")}`]];
}
