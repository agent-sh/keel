// keel review watch|unwatch|list|post: pull request reviews from GitHub
// (src/prreview/watch.ts). The daemon polls the repositories named here and
// reviews each new head; a review is a draft until it is posted.
import { ago, command, EXIT, line, printJson, usageError } from "./client.ts";

const USAGE = `keel review watch OWNER/REPO [--post | --draft] [--on push|open|comment] [--trigger TEXT]
keel review unwatch OWNER/REPO
keel review list [--repo OWNER/REPO] [--json]
keel review post ID
  Pull request reviews from GitHub, with no public URL: the daemon polls the
  repositories you watch at the pace GitHub states, and reviews each new head.

  watch       watch a repository (again: change its settings)
      --on    push (default): every new head of a ready pull request;
              open: a new pull request only; comment: only when a comment asks
      --trigger   what a comment starts with to ask for a review (default: @keel review)
      --post      post each review on GitHub by itself
      --draft     keep each review a draft you post from Keel (the default)
  unwatch     stop watching a repository
  list        the watched repositories and the latest reviews
  post ID     post a draft on GitHub (its id, or the end of it that list shows)

  Credentials: a token saved in Keel's settings, GH_TOKEN or GITHUB_TOKEN, else your gh login.`;

const STATE: Record<string, string> = { queued: "queued", running: "reviewing", draft: "draft", posting: "posting", posted: "posted", failed: "failed" };

export const reviewCmd = command("review", USAGE, {
  post: { type: "boolean" }, draft: { type: "boolean" }, on: { type: "string" }, trigger: { type: "string" }, repo: { type: "string" },
}, async (v, pos, c) => {
  const [sub = "list", arg] = pos;
  if (sub === "watch") {
    if (!arg) return usageError("review", "watch needs OWNER/REPO", USAGE);
    if (v.post && v.draft) return usageError("review", "--post and --draft say opposite things", USAGE);
    if (v.on && !["push", "open", "comment"].includes(v.on)) return usageError("review", "--on is push, open or comment", USAGE);
    const { repo } = await c.post<{ repo: any }>("/api/pr-reviews/repos", {
      repo: arg, ...(v.post ? { post: true } : v.draft ? { post: false } : {}), ...(v.on ? { auto: v.on } : {}), ...(v.trigger !== undefined ? { trigger: v.trigger } : {}),
    });
    if (v.json) return (printJson(repo), EXIT.ok);
    console.log(`watching ${repo.repo}: ${repo.auto === "push" ? "every new head" : repo.auto === "open" ? "new pull requests" : "when asked"}, a comment that starts with "${line(repo.trigger)}" asks; reviews are ${repo.post ? "posted on GitHub" : "drafts you post from Keel"}`);
    return EXIT.ok;
  }
  if (sub === "unwatch") {
    if (!arg || !/^[^/\s]+\/[^/\s]+$/.test(arg)) return usageError("review", "unwatch needs OWNER/REPO", USAGE);
    await c.del(`/api/pr-reviews/repos/${arg.split("/").map(encodeURIComponent).join("/")}`);
    console.log(`stopped watching ${arg}`);
    return EXIT.ok;
  }
  if (sub === "post") {
    if (!arg) return usageError("review", "post needs a review id", USAGE);
    const { reviews } = await c.get<{ reviews: any[] }>("/api/pr-reviews?limit=500");
    const hits = reviews.filter((r) => r.id.startsWith(arg) || r.id.endsWith(arg));
    if (hits.length !== 1) return usageError("review", hits.length ? `${arg} names ${hits.length} reviews; give more of the id` : `no review ${arg}`, USAGE);
    const { review } = await c.post<{ review: any }>(`/api/pr-reviews/${hits[0]!.id}/post`);
    console.log(`posted: ${review.posted_url ?? review.url}`);
    return EXIT.ok;
  }
  if (sub === "list") {
    const r = await c.get<{ repos: any[]; reviews: any[]; credentials: string | null }>(`/api/pr-reviews${v.repo ? `?repo=${encodeURIComponent(v.repo)}` : ""}`);
    if (v.json) return (printJson(r), EXIT.ok);
    if (!r.repos.length) console.error("no repository is watched: keel review watch OWNER/REPO");
    for (const w of r.repos) {
      console.log(`${w.repo}  ${w.post ? "posts" : "drafts"}  on ${w.auto}  "${line(w.trigger)}"  ${w.last_poll ? `polled ${ago(w.last_poll)} ago` : "not polled yet"}, ${w.requests} requests (${w.unchanged} unchanged)${w.error ? `  ${line(w.error)}` : ""}`);
    }
    if (r.repos.length && !r.credentials) console.error("no GitHub credentials: run gh auth login, or save a token in Settings > Pull requests");
    for (const x of r.reviews.slice(0, 20)) {
      console.log(`${x.id.slice(-8)}  ${ago(x.created).padStart(4)}  ${(STATE[x.state] ?? x.state).padEnd(9)}  ${x.repo}#${x.number} ${x.head.slice(0, 7)}  ${x.findings?.length ?? 0} findings  ${line(x.title)}${x.error ? `  ${line(x.error)}` : ""}`);
    }
    return EXIT.ok;
  }
  return usageError("review", `unknown subcommand ${sub}`, USAGE);
});
