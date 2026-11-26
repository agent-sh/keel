// The tree review's joins to the daemon (src/board/tree-review.ts): the page reads a session's tree as one
// diff by area, one area's hunks, and records the owner's decision on an area: land it through the landing
// queue in the proposed order, send it back to its agents with a note, or drop it. The owner's hand only.
import * as agents from "../../automation/agents.ts";
import { readsOf } from "../reads.ts";
import { inOrder } from "../../board/tree.ts";
import { wouldConflict } from "../../board/would-conflict.ts";
import { backText, TreeReview, type TreeView } from "../../board/tree-review.ts";
import type { ParsedDiff } from "../../board/tree.ts";
import type { Deps, RouteModule } from "../app.ts";
import { sessionOfCaller } from "../caller.ts";
import { workBoard } from "./board.ts";
import { headsOf, landing } from "./landing.ts";
import { overlaps } from "./overlaps.ts";
import { presence } from "./permissions.ts";

export let treeReview: TreeReview | undefined;
// The area key that names the whole tree in a landing decision.
const TREE = "*";
const MOVED_MS = 400; // head moves within this are one frame (an agent's commit and its rebase often come together)


export const treeReviewRoutes: RouteModule = (deps: Deps) => {
  const { store, errors, bus } = deps;
  const ov = overlaps;
  if (!ov) throw new Error("the tree review needs the overlap forecast's routes first");
  const reads = readsOf(store);
  const tr = new TreeReview(store, {
    board: (root, fresh) => {
      const b = workBoard();
      if (!b) throw new Error("the work board is not running");
      return b.read(root, fresh);
    },
    merge: (repo, a, b) => ov.mergeTips(repo, a, b),
    noAttrs: (repo) => ov.noAttrs(repo),
    baseConflicts: (repo) => new Map(ov.pairsOf(repo).filter((p) => p.base && p.conflict).map((p) => [p.a, tipOfPair(store, repo, p.a)] as const).filter((x): x is [string, string] => !!x[1])),
    parse: (text) => reads.run("tree.parse", { text }) as Promise<ParsedDiff>,
  });
  treeReview = tr;

  // A branch head of a tree moved under one of its sessions' calls (a commit, a rebase, a reset): a review
  // of the tree that is up reads it again. One frame a tree, after the moves of a moment settle, to the
  // tree's review feed only (src/server/scope.ts): a page names it while its review shows.
  const moved = new Map<string, ReturnType<typeof setTimeout>>();
  ov.onMoved((repo, sessionId) => {
    const root = agents.rootSession(sessionId);
    tr.forget(root);
    if (moved.has(root)) return;
    const t = setTimeout(() => { moved.delete(root); bus.emit({ t: "feature", name: "tree_review", session_id: root, data: { repo } }); }, MOVED_MS);
    t.unref?.();
    moved.set(root, t);
  });

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const ownerOnly = (req: Request, srv: Bun.Server<unknown>): Response | null => {
    const by = sessionOfCaller(req, srv);
    if (by) return json({ error: `this is the owner's: a session's command (session ${by}) does not decide the tree review` }, 403);
    if (presence && !presence.allows(req, "landing")) return json({ error: "this needs your passkey from a remote device", presence: { action: "landing" } }, 428);
    return null;
  };

  // What the owner's decision on an area does, and the words it is recorded with.
  async function decide(root: string, v: TreeView, key: string, action: string, note: string, only: string[] | undefined, subset?: string[], confirmed = false, shown?: Record<string, string>): Promise<{ status: number; body: unknown }> {
    // The whole tree at once ("*"): only landing, over every area's branches, recorded on each area that holds one.
    const whole = key === TREE && action === "land";
    const found = v.areas.find((a) => a.key === key);
    if ((!found && !whole) || !v.repo) return { status: 404, body: { error: "no such area in this tree's review (read it again)" } };
    const area = found ?? { key: TREE, branches: [...new Set(v.areas.flatMap((a) => a.branches))], marks: {} as Record<string, string>, files: [] as never[] };
    const all = area.branches.map((b) => ({ branch: b, head: area.marks[b]! }));
    if (action === "undo") { tr.undo(root, v.repo, key); return { status: 200, body: { ok: true } }; }
    if (action === "drop") {
      const outcome = `Dropped: ${area.branches.length === 1 ? "its branch's" : "its branches'"} changes here are not landed from this review.`;
      tr.record(root, v.repo, key, { action: "drop", note, branches: all, outcome });
      return { status: 200, body: { ok: true, outcome } };
    }
    if (action === "back") {
      const targets = v.branches.filter((b) => area.branches.includes(b.branch) && (!only?.length || only.includes(b.agent)));
      if (!targets.length) return { status: 400, body: { error: "no agent of this area was named" } };
      const sent: string[] = [], failed: string[] = [];
      const cleared = tr.cleared(root, v.repo, key);
      for (const b of targets) {
        const files = area.files.filter((f) => f.branches.some((x) => x.branch === b.branch)).map((f) => f.path);
        const text = backText({ area: key, note, branch: b.branch, head: b.head, files, others: area.branches.filter((x) => x !== b.branch) });
        try {
          // Stored once by this key: a send-back sent again (a retry) is one, and one after the owner cleared the
          // area is a new one, even with the same note to the same head.
          const r = await agents.send(b.agent, text, false, `tree-review:${root}:${key}:${b.head}:${Bun.hash(note).toString(36)}:${cleared}`, undefined, undefined, "review");
          sent.push(r.held ? `${b.agent} (held by a stop: it reads it when let go)` : r.waits ? `${b.agent} (queued behind its work)` : b.agent);
        } catch (e) {
          failed.push(`${b.agent}: ${(e as Error).message}`);
        }
      }
      if (!sent.length) return { status: 409, body: { error: `not sent: ${failed.join("; ")}` } };
      const outcome = `Sent back to ${sent.join(", ")}${failed.length ? `; not sent to ${failed.join("; ")}` : ""}.`;
      // The decision holds the branches it was sent to: they land only once they moved (or it is cleared).
      tr.record(root, v.repo, key, { action: "back", note, branches: targets.map((b) => ({ branch: b.branch, head: area.marks[b.branch]! })), outcome });
      return { status: 200, body: { ok: true, outcome } };
    }
    if (action !== "land") return { status: 400, body: { error: "action is land, back, drop or undo" } };
    const q = landing;
    if (!q) return { status: 503, body: { error: "the landing queue is not running" } };
    // Not landed: what the proposed order holds back (its agent works, the owner sent it back or dropped an
    // area it changes, on its head now). An area the owner dropped lands once its decision is cleared.
    const blocked = new Map(area.branches.filter((b) => v.held[b]).map((b) => [b, v.held[b]!]));
    // `subset`: land only these branches of the area (the ones that do not conflict); the rest stay for a later decision.
    const wanted = subset?.length ? new Set(subset) : null;
    const branches = inOrder(v.order, area.branches.filter((b) => !blocked.has(b) && (!wanted || wanted.has(b))));
    if (!branches.length) return { status: 409, body: { error: `nothing to land: ${[...blocked].map(([b, why]) => `${b}: ${why}`).join("; ")}` } };
    // Branches that would conflict when landed are queued only when the owner confirmed it (the page asks in a
    // dialog first): a request that names no branches, or names one of them, is refused until it says so.
    const risky = wouldConflict(v, branches);
    if (risky.length && !confirmed) return { status: 409, body: { error: `${risky.join(", ")} would conflict when landing: confirm landing it, or land the others only`, would_conflict: risky, needs_confirm: true } };
    // (`shown`: the heads the page showed. The queue keeps the owner's landing as theirs for a branch still at that head.)
    const r = await q.add(v.repo, branches, null, root, shown);
    const outcome = [
      r.queued.length ? `Queued in this order: ${r.queued.map((e) => `${e.branch} (${e.id})`).join(", ")}.` : "",
      ...r.refused.map((x) => `Not queued: ${x.branch}: ${x.why}.`),
      ...[...blocked].map(([b, why]) => `Not queued: ${b}: ${why}.`),
      ...r.warnings,
    ].filter(Boolean).join(" ");
    if (!r.queued.length) return { status: 409, body: { error: outcome } };
    const queued = new Set(r.queued.map((e) => e.branch));
    for (const a of whole ? v.areas : [found!]) {
      const here = a.branches.filter((b) => queued.has(b)).map((b) => ({ branch: b, head: a.marks[b]! }));
      if (here.length) tr.record(root, v.repo, a.key, { action: "land", note, branches: here, outcome });
    }
    return { status: 200, body: { ok: true, outcome, queued: r.queued.map((e) => ({ id: e.id, branch: e.branch })) } };
  }

  return {
    "/api/sessions/:id/tree-review": {
      GET: async (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const u = new URL(req.url);
        return json(await tr.view(req.params.id, { fresh: u.searchParams.get("fresh") === "1", repo: u.searchParams.get("repo") ?? undefined }));
      },
    },
    "/api/sessions/:id/tree-review/area": {
      GET: async (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const u = new URL(req.url);
        const a = await tr.area(req.params.id, u.searchParams.get("key") ?? "", u.searchParams.get("repo") ?? undefined);
        return a ? json(a) : json({ error: "no such area in this tree's review" }, 404);
      },
    },
    "/api/sessions/:id/tree-review/decide": {
      POST: async (req: any, srv: Bun.Server<unknown>) => {
        const refused = ownerOnly(req, srv);
        if (refused) return refused;
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const body = await req.json().catch(() => ({}));
        const key = typeof body?.area === "string" ? body.area : "";
        const action = typeof body?.action === "string" ? body.action : "";
        const note = typeof body?.note === "string" ? body.note.slice(0, 4000) : "";
        const only = Array.isArray(body?.agents) ? body.agents.filter((x: unknown) => typeof x === "string") : undefined;
        try {
          const v = await tr.view(req.params.id, { fresh: true, repo: typeof body?.repo === "string" ? body.repo : undefined });
          const subset = Array.isArray(body?.branches) ? body.branches.filter((x: unknown) => typeof x === "string") : undefined;
          const r = await decide(req.params.id, v, key, action, note, only, subset, body?.confirmed === true, headsOf(body?.heads));
          return json({ ...(r.body as object), view: r.status === 200 ? await tr.view(req.params.id, { repo: v.repo ?? undefined }) : undefined }, r.status);
        } catch (e) {
          errors.capture("server", e, { at: "tree review decide", session: req.params.id });
          return json({ error: (e as Error).message }, 500);
        }
      },
    },
  };
};

// The tip the forecast judged a branch at against the base.
function tipOfPair(store: Deps["store"], repo: string, branch: string): string | undefined {
  try {
    return store.db.query<{ a_tip: string }, [string, string]>("SELECT a_tip FROM overlap_pairs WHERE repo = ? AND a = ? AND base = 1").get(repo, branch)?.a_tip;
  } catch { return undefined; }
}
