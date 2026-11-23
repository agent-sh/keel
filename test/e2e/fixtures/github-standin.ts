// A stand-in for the part of GitHub's REST API the pull request watcher
// speaks (src/prreview/watch.ts): open pull requests, issue comments, posting
// a review. Answers as GitHub documents it: an ETag on every list, 304 for an
// If-None-Match that still holds, X-Poll-Interval on every answer, 401
// without the token. Each request is logged, so a spec can check the pace.
// The repositories' code is a bare repository on this machine whose
// refs/pull/N/head the spec sets, as GitHub keeps them.
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

export type StandinPull = { number: number; head: string; draft?: boolean; title: string; base?: string; user?: string };
export type StandinComment = { id: number; pr: number; body: string; association: string; user?: string };
export type Logged = { at: number; method: string; path: string; status: number; conditional: boolean };
export type Posted = { repo: string; number: number; body: any };

export const TOKEN = "standin-token";

export class GitHubStandin {
  pulls = new Map<string, StandinPull[]>();
  comments = new Map<string, StandinComment[]>();
  clone = new Map<string, string>();
  posted: Posted[] = [];
  log: Logged[] = [];
  interval = 1;
  // Pull requests a page (GitHub's per_page, unless set): a small page makes a list of several pages, each with its own ETag.
  pageSize?: number;
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
        this.log.push({ at: Date.now(), method: req.method ?? "", path: u.pathname + u.search, status, conditional: !!req.headers["if-none-match"] });
        res.writeHead(status, { "x-poll-interval": String(this.interval), "content-type": "application/json", ...headers });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
      const list = (body: unknown, more: Record<string, string> = {}) => {
        const etag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
        if (req.headers["if-none-match"] === etag) return send(304, undefined, { etag, ...more });
        send(200, body, { etag, ...more });
      };
      const m = /^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues\/comments|pulls\/(\d+)\/reviews)$/.exec(u.pathname);
      if (!m) return send(404, { message: "Not Found" });
      const repo = `${m[1]}/${m[2]}`;
      if (!this.pulls.has(repo)) return send(404, { message: "Not Found" });
      if (m[3] === "pulls" && req.method === "GET") {
        // Newest first, as GitHub's default order; a page at a time with a Link to the next.
        const size = this.pageSize ?? (Number(u.searchParams.get("per_page")) || 30);
        const page = Math.max(1, Number(u.searchParams.get("page")) || 1);
        const all = [...this.pulls.get(repo)!].sort((a, b) => b.number - a.number);
        const next = new URL(`${this.url}${u.pathname}${u.search}`);
        next.searchParams.set("page", String(page + 1));
        return list(all.slice((page - 1) * size, page * size).map((p) => ({
          number: p.number, title: p.title, draft: !!p.draft, html_url: `https://github.example/${repo}/pull/${p.number}`, user: { login: p.user ?? "dev" },
          head: { sha: p.head, ref: `feature-${p.number}` }, base: { ref: p.base ?? "main", repo: { full_name: repo, clone_url: this.clone.get(repo) } },
        })), page * size < all.length ? { link: `<${next}>; rel="next"` } : {});
      }
      if (m[3] === "issues/comments" && req.method === "GET") {
        return list([...this.comments.get(repo)!].sort((a, b) => b.id - a.id).slice(0, Number(u.searchParams.get("per_page")) || 30).map((c) => ({
          id: c.id, body: c.body, author_association: c.association, user: { login: c.user ?? "someone" },
          issue_url: `http://x/repos/${repo}/issues/${c.pr}`, html_url: `https://github.example/${repo}/pull/${c.pr}#issuecomment-${c.id}`,
        })));
      }
      if (m[4] && req.method === "POST") {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", () => {
          const body = JSON.parse(raw || "{}");
          this.posted.push({ repo, number: Number(m[4]), body });
          send(200, { id: this.posted.length, html_url: `https://github.example/${repo}/pull/${m[4]}#pullrequestreview-${this.posted.length}`, state: "COMMENTED", commit_id: body.commit_id });
        });
        return;
      }
      send(404, { message: "Not Found" });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    return this.url;
  }

  stop() {
    return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  repo(name: string, clone: string) {
    this.pulls.set(name, []);
    this.comments.set(name, []);
    this.clone.set(name, clone);
  }

  // GETs of one listing, in order: their times, for the pace.
  gets(prefix: string): Logged[] {
    return this.log.filter((l) => l.method === "GET" && l.path.startsWith(prefix));
  }
}
