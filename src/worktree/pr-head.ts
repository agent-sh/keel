// A session that starts at a pull request's head: what the owner names (a number, or the
// request's address) and the ref the code host keeps for the request's latest commit.
// GitHub keeps refs/pull/N/head, GitLab refs/merge-requests/N/head; which one is asked
// comes from the request's address, else from the host of the repository's origin.
export type Host = "github" | "gitlab";
export type PrNamed = { number: number; host?: Host; at?: string };

// The host a remote's address names, or nothing for a folder on this machine.
export function hostOfRemote(url: string): string | undefined {
  const u = url.trim();
  if (u.includes("://")) {
    if (u.startsWith("file://")) return undefined;
    try { return new URL(u).hostname.toLowerCase() || undefined; } catch { return undefined; }
  }
  // The short ssh form: [user@]host:path.
  const m = /^(?:[^@/]*@)?([^:/]+):(?!\/\/)/.exec(u);
  return m && !/^[A-Za-z]:[\\/]/.test(u) ? m[1]!.toLowerCase() : undefined;
}

// A host that says gitlab is GitLab; every other host, and a folder on this machine, is
// GitHub's layout (GitHub Enterprise has it too).
export const hostKind = (host: string | undefined): Host => (host && /(^|[.-])gitlab([.-]|$)/.test(host) ? "gitlab" : "github");

// "7", "#7", a pull request's address (.../pull/7, .../pull/7/files) or a merge request's
// (.../-/merge_requests/7, .../merge_requests/7). Else a sentence that says what is taken.
export function parsePr(input: string | number): PrNamed | { error: string } {
  const raw = String(input).trim();
  const num = /^#?(\d+)$/.exec(raw);
  if (num) return numbered(Number(num[1]));
  let u: URL;
  try { u = new URL(raw); } catch { return { error: `not a pull request: ${raw || "(empty)"} (give its number or its address)` }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: `not a pull request address: ${raw}` };
  const gh = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (gh) return { ...numbered(Number(gh[1])), host: "github", at: u.hostname.toLowerCase() } as PrNamed;
  const gl = /\/merge_requests\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (gl) return { ...numbered(Number(gl[1])), host: "gitlab", at: u.hostname.toLowerCase() } as PrNamed;
  return { error: `not a pull request address: ${raw} (it has no /pull/N or /merge_requests/N)` };
}
function numbered(n: number): PrNamed | { error: string } {
  return Number.isSafeInteger(n) && n > 0 ? { number: n } : { error: "the pull request number is above 0" };
}

// The ref of a request's head on its host.
export const prRef = (host: Host, n: number) => (host === "gitlab" ? `refs/merge-requests/${n}/head` : `refs/pull/${n}/head`);

// What to fetch from `origin` (the address of the remote): the host's layout and the ref, or why not.
// An address names the host it is on: fetching it from an origin elsewhere would start at another
// repository's request of the same number.
export function prTarget(input: string | number, origin: string): { number: number; host: Host; ref: string } | { error: string } {
  const p = parsePr(input);
  if ("error" in p) return p;
  const at = hostOfRemote(origin);
  if (p.at && at && p.at !== at) return { error: `${p.at} is not the host of origin (${at}): the pull request is of another repository` };
  const host = p.host ?? hostKind(at);
  return { number: p.number, host, ref: prRef(host, p.number) };
}
