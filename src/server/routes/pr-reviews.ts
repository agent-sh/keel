// Pull request reviews from GitHub events (src/prreview/watch.ts): the
// repositories the owner watches, the reviews made for them, posting a draft.
import { registerHooks } from "../../engine/hooks.ts";
import { runMode } from "../../core/runmode.ts";
import { ownSessionEnd } from "../../automation/alerts.ts";
import { deleteKey, saveKey } from "../../providers/creds.ts";
import { parseRepo } from "../../prreview/decide.ts";
import { forgetToken, TOKEN_CRED, token } from "../../prreview/github.ts";
import { PrWatcher, TAG, type Auto } from "../../prreview/watch.ts";
import type { Deps, RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const guard = async (f: () => Promise<Response> | Response) => {
  try { return await f(); } catch (e) {
    const status = (e as any)?.status;
    if (typeof status === "number") return bad((e as Error).message, status);
    throw e;
  }
};

const g = globalThis as { __keelPrWatcher?: PrWatcher };
export const prWatcher = () => g.__keelPrWatcher;

export const prReviewRoutes: RouteModule = (deps: Deps) => {
  g.__keelPrWatcher?.stop(); // a hot reload: the module's new watcher takes over
  const w = new PrWatcher(deps);
  g.__keelPrWatcher = w;
  registerHooks({ turnEnd(s, reason) { if (g.__keelPrWatcher === w) w.turnEnded(s.id, reason); } });
  // A review session's end is told by its own alert (ready, posted, failed), not as a finished turn.
  ownSessionEnd.set("pr-reviews", (id) => !!w.bySession(id));
  if (!runMode.client) {
    w.recover();
    w.schedule();
  }

  const repoOf = (req: any) => {
    const r = parseRepo(`${req.params.owner}/${req.params.name}`);
    if (!r) throw Object.assign(new Error("a repository is owner/name"), { status: 400 });
    return r;
  };
  const opts = (b: any) => ({
    ...(b.post !== undefined ? { post: !!b.post } : {}),
    ...(b.auto !== undefined ? { auto: String(b.auto) as Auto } : {}),
    ...(b.trigger !== undefined ? { trigger: String(b.trigger) } : {}),
  });

  return {
    "/api/pr-reviews": {
      GET: async (req: any) => {
        const q = new URL(req.url).searchParams;
        const t = await token().catch(() => null);
        return json({ repos: w.list(), reviews: w.reviews({ repo: q.get("repo") ?? undefined, limit: Math.min(500, Number(q.get("limit")) || 100) }), credentials: t?.source ?? null, tag: TAG });
      },
    },
    "/api/pr-reviews/repos": {
      POST: (req: any) => guard(async () => {
        const b = await body(req);
        const repo = parseRepo(String(b.repo ?? ""));
        if (!repo) return bad("a repository is owner/name, as GitHub writes it");
        const had = !!w.get(repo);
        return json({ repo: w.watch(repo, opts(b)) }, had ? 200 : 201);
      }),
    },
    "/api/pr-reviews/repos/:owner/:name": {
      PATCH: (req: any) => guard(async () => json({ repo: w.update(repoOf(req), opts(await body(req))) })),
      DELETE: (req: any) => guard(() => (w.unwatch(repoOf(req)) ? json({ ok: true }) : bad("that repository is not watched", 404))),
    },
    "/api/pr-reviews/session/:id": {
      GET: (req: any) => {
        const r = w.bySession(req.params.id);
        return r ? json({ review: r, repo: w.get(r.repo) ?? null }) : bad("no pull request review in that session", 404);
      },
    },
    "/api/pr-reviews/:id/post": {
      POST: (req: any) => guard(async () => json({ review: await w.post(req.params.id, "owner") })),
    },
    "/api/pr-reviews/:id/retry": {
      POST: (req: any) => guard(async () => json({ review: await w.retry(req.params.id) })),
    },
    // A token for GitHub, kept in the system keyring; without one the owner's gh login is used.
    "/api/pr-reviews/token": {
      PUT: (req: any) => guard(async () => {
        const t = String((await body(req)).token ?? "").trim();
        if (!t || /\s/.test(t)) return bad("the token is one word");
        await saveKey(TOKEN_CRED, t);
        forgetToken();
        w.credentialsChanged();
        return json({ credentials: (await token(true))?.source ?? null });
      }),
      DELETE: async () => {
        await deleteKey(TOKEN_CRED);
        forgetToken();
        return json({ credentials: (await token(true).catch(() => null))?.source ?? null });
      },
    },
  };
};
