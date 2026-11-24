// What PR Steward reads of GitHub, through the owner's own gh sign-in: the
// pull request (state, head, conflict, checks, comments, reviews), the lines
// of its diff that people commented on, who the owner is, whether a commenter
// has write access, and the log of a failed check. It writes nothing: the
// session's own turn pushes, with its own commands, through the gate.
import { gitEnv } from "../core/git.ts";
import { readText } from "../core/proc.ts";
import { runOf, tail } from "./rules.ts";

const bin = () => process.env.KEEL_GH_BIN || "gh";

// gh in a process group of its own, so stopping it also stops what it started (a credential helper).
// It runs where `cwd` says: outside any repository for a read that names its repository.
async function run(args: string[], cwd = "/", signal?: AbortSignal): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn([bin(), ...args], { cwd, env: { ...gitEnv(cwd), GH_PROMPT_DISABLED: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true, timeout: 90_000 });
  const stop = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  try {
    const [out, err, code] = await Promise.all([readText(p.stdout, "gh"), readText(p.stderr, "gh"), p.exited]);
    return { out, err, code };
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FIELDS = "state,headRefName,headRefOid,baseRefName,mergeable,statusCheckRollup,comments,reviews";

export type Found = { repo: string; number: number; url: string; state: string; branch: string; base: string };

// The pull request of a branch, read in the worktree. null: there is none.
export async function prOfBranch(dir: string, branch: string): Promise<Found | null> {
  const r = await run(["pr", "view", branch, "--json", "number,url,state,headRefName,baseRefName"], dir);
  if (r.code !== 0) {
    if (/no pull requests found/i.test(r.err)) return null;
    throw new Error(`gh pr view: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
  }
  const v = JSON.parse(r.out);
  const m = String(v.url ?? "").match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/);
  if (!m || !REPO.test(m[1]!) || !Number.isInteger(v.number)) throw new Error("gh did not say which repository the pull request is in");
  return { repo: m[1]!, number: v.number, url: v.url, state: String(v.state), branch: String(v.headRefName), base: String(v.baseRefName) };
}

export async function look(repo: string, n: number, signal?: AbortSignal): Promise<{ view: any; inline: any[] }> {
  const [v, inline] = await Promise.all([
    run(["pr", "view", String(n), "--repo", repo, "--json", FIELDS], "/", signal),
    inlineComments(repo, n, signal),
  ]);
  if (v.code !== 0) throw new Error(`gh pr view: ${v.err.trim().slice(0, 300) || `exit ${v.code}`}`);
  return { view: JSON.parse(v.out), inline };
}

// The lines of the diff people commented on, every page of them (a busy review has more than a hundred). A second
// read: when it fails the rest still counts, and what was read stays.
export const INLINE_PAGES = 10;
async function inlineComments(repo: string, n: number, signal?: AbortSignal): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= INLINE_PAGES; page++) {
    const c = await run(["api", `repos/${repo}/pulls/${n}/comments?per_page=100&page=${page}`], "/", signal);
    if (c.code !== 0) break;
    let x: unknown;
    try { x = JSON.parse(c.out); } catch { break; }
    if (!Array.isArray(x)) break;
    out.push(...x);
    if (x.length < 100) break;
  }
  return out;
}

let who: { login: string; at: number } | undefined;
// The account gh is signed in as: the owner. Kept ten minutes.
export async function viewer(): Promise<string | undefined> {
  if (who && Date.now() - who.at < 600_000) return who.login || undefined;
  const r = await run(["api", "user", "--jq", ".login"]);
  const login = r.code === 0 ? r.out.trim() : "";
  // A failed read is not kept: the owner's own comments would be unknown for ten minutes.
  if (login) who = { login, at: Date.now() };
  return login || undefined;
}
export const forgetViewer = () => { who = undefined; };

const perms = new Map<string, { write: boolean; at: number }>();
// Whether a person has write access to the repository (GitHub's own word for it). Kept ten minutes when GitHub
// answered. undefined: it could not say (offline, a rate limit, a 403 for lack of rights to ask): not known, so not
// kept, and asked again at the next look. Only a 404 (no such person here) is an answer of "no" besides the word.
export async function writes(repo: string, login: string): Promise<boolean | undefined> {
  const key = `${repo}\0${login.toLowerCase()}`;
  const known = perms.get(key);
  if (known && Date.now() - known.at < 600_000) return known.write;
  if (!REPO.test(repo) || !/^[A-Za-z0-9-]+$/.test(login)) return false;
  let r: { out: string; err: string; code: number };
  try { r = await run(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"]); } catch { return undefined; }
  let write: boolean;
  if (r.code === 0) write = ["admin", "maintain", "write"].includes(r.out.trim());
  else if (/HTTP 404\b/.test(r.err)) write = false;
  else return undefined;
  perms.set(key, { write, at: Date.now() });
  return write;
}
export const forgetPerms = () => perms.clear();

// What a failed check printed, cut to its end. Empty when the check has no run to read (an external status).
export async function failedLog(repo: string, url: string | undefined): Promise<string> {
  const id = runOf(url);
  if (!id) return "";
  const r = await run(["run", "view", id, "--repo", repo, "--log-failed"]);
  return r.code === 0 ? tail(r.out) : "";
}
