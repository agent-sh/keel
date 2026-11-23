// The work board's joins to the daemon (src/board/board.ts): the page reads a session's board, and the
// session reads it with keel__work_board in a few hundred tokens, with no model request behind it.
import { byChild, rootSession } from "../../automation/agents.ts";
import { WorkBoard } from "../../board/board.ts";
import { ensureVerdicts, recordVerdict } from "../../board/verdicts.ts";
import { boardText } from "../../board/rules.ts";
import { buildInfo } from "../../core/build.ts";
import { git } from "../../core/git.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { Deps, RouteModule } from "../app.ts";
import { landing } from "./landing.ts";
import { overlaps } from "./overlaps.ts";

let current: { store: Deps["store"]; board: WorkBoard } | undefined;
export const workBoard = () => current?.board;

// The commit this daemon was built from, as its build names it (`source`: run from the source tree).
const revision = () => {
  const r = buildInfo().revision.replace(/-dirty$/, "");
  return /^[0-9a-f]{7,40}$/.test(r) ? r : null;
};

// The base the landing queue lands on; where it does not run, the overlap forecast's, as a local branch when there is one.
async function baseOf(repo: string): Promise<string | null> {
  if (landing) return landing.baseOf(repo);
  const b = await overlaps?.baseOf(repo);
  if (!b) return null;
  const local = b.startsWith("refs/remotes/") ? `refs/heads/${b.split("/").slice(3).join("/")}` : b;
  return (await git(repo, ["rev-parse", "-q", "--verify", local], { read: true })).code === 0 ? local : b;
}

const WorkBoardTool: Tool = {
  name: "keel__work_board",
  readOnly: true,
  description:
    "The work board of your tree, kept by the daemon from what it observes, not from what agents wrote: per agent its task, state, branch and head, the named checks that passed on its head's tree, " +
    "the latest review of its branch, whether the base holds its head (or the same patches), and whether what runs holds it. " +
    "A review reads approved or refused only from a structured verdict on the branch's head (the reviewer's keel__verdict call, an output_schema answer with land per commit, or the Review panel); " +
    "a reviewer that only wrote a LAND line shows as \"words only\" with that line quoted, and a verdict on an older head as stale. " +
    "Read it instead of a ledger of your own, after a compaction or a restart, or to answer a status question. By default agents that need you get a line each and the rest are listed by id; " +
    "all: true lists every row; agent: <id> shows one row in full. Start a review agent with reviews: <branch> so the board knows what it reviews, and ask it to call keel__verdict.",
  input_schema: {
    type: "object",
    properties: {
      all: { type: "boolean", description: "Every row in full" },
      agent: { type: "string", description: "One agent's row in full, by its id" },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    if (!current) return fail("The work board is not running.");
    if (!current.store.session(ctx.sessionId)) return fail("This session was deleted.");
    const b = await current.board.read(ctx.sessionId);
    return ok(boardText(b, { all: input?.all === true, agent: typeof input?.agent === "string" && input.agent.trim() ? input.agent.trim() : undefined }));
  },
};

const VerdictTool: Tool = {
  name: "keel__verdict",
  readOnly: true,
  description:
    "Record your review verdict on a commit for the work board. The board reads a review's verdict only from this call (or an output_schema answer, or the owner's Review panel): " +
    "LAND lines in your report are shown as your words only, never as approved or refused. Call it once for each commit you judge, after you have judged it: " +
    "commit (the full hash, or seven or more of its first digits), land yes or no, why in one line. A later call for the same commit replaces the earlier one; " +
    "the board shows it while the branch's head is that commit, and as stale once the branch moves on.",
  input_schema: {
    type: "object",
    properties: {
      commit: { type: "string", description: "The commit you reviewed" },
      land: { type: "string", enum: ["yes", "no"], description: "yes: it may land as it is; no: it may not" },
      why: { type: "string", description: "One line: what decided it" },
    },
    required: ["commit", "land", "why"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    if (!current) return fail("The work board is not running.");
    const a = byChild(ctx.sessionId);
    if (!a) return fail("keel__verdict records the verdict of an agent of a tree; this session is not one. The owner's verdict is the Review panel's.");
    const commit = String(input?.commit ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return fail("commit: the commit you reviewed, as its full hash or seven or more of its first hex digits.");
    const land = input?.land === "yes" || input?.land === true ? "yes" : input?.land === "no" || input?.land === false ? "no" : undefined;
    if (!land) return fail('land: "yes" (it may land as it is) or "no".');
    const why = typeof input?.why === "string" ? input.why.replace(/\s+/g, " ").trim().slice(0, 600) : "";
    if (!why) return fail("why: one line on what decided it.");
    const { store } = current;
    const root = rootSession(ctx.sessionId);
    const tree = treeBranches(store, root);
    const places = [...new Set([...tree.map((t) => t.repo), store.session(ctx.sessionId)?.workspace, store.session(root)?.workspace].filter((r): r is string => !!r))].slice(0, 8);
    let full: string | undefined, repo: string | undefined;
    for (const at of places) {
      const r = await git(at, ["rev-parse", "-q", "--verify", `${commit}^{commit}`], { read: true, timeout: 10_000 });
      if (r.code === 0 && /^[0-9a-f]{40}$/.test(r.out.trim())) { full = r.out.trim(); repo = at; break; }
    }
    if (!full || !repo) return fail(`No repository of this tree holds a commit ${commit}. Name the commit you reviewed: its full hash, or seven or more of its first digits.`);
    // The branches of the tree that hold it: the ones whose head it is, else the ones this agent reviews, else every one (five at most).
    const listed = await git(repo, ["for-each-ref", "--contains", full, "--format=%(refname:short)%00%(objectname)", "refs/heads"], { read: true, timeout: 10_000 });
    const mine = new Set(tree.map((t) => t.branch));
    const holding = (listed.code === 0 ? listed.out : "").split("\n").map((l) => l.split("\0")).filter(([b]) => b && mine.has(b)) as [string, string][];
    const exact = holding.filter(([, sha]) => sha === full).map(([b]) => b);
    const reviewed = holding.map(([b]) => b).filter((b) => a.reviews?.includes(b));
    const branches = exact.length ? exact : reviewed.length ? reviewed : holding.slice(0, 5).map(([b]) => b);
    recordVerdict(store.db, { agent: a.id, commit: full, branches, land, why });
    current.board.forget(root);
    const own = a.branch && branches.includes(a.branch) ? ` It is a commit of your own branch ${a.branch}: the board never takes an agent's verdict on its own work, or on work of an agent above it.` : "";
    return ok(`Recorded: LAND ${land} for ${full.slice(0, 9)}${branches.length ? ` on ${branches.join(", ")}` : ""}. ` +
      (branches.length ? `The work board shows it as ${land === "yes" ? "approved" : "refused"} while that branch's head is this commit, and as stale after the branch moves.` : "No branch of this tree holds it now: the board shows it on a row only while that row's head is this commit.") +
      ` A later call for this commit replaces this one.${own}`);
  },
};

// The branches of a tree's agents and the repositories of their worktrees.
function treeBranches(store: Deps["store"], root: string): { branch: string; repo: string | null }[] {
  const wt = store.columnExists("worktrees", "repo_root");
  return store.db.query<{ branch: string; repo: string | null }, [string]>(
    `WITH RECURSIVE t(s, d) AS (SELECT ?1, 0 UNION SELECT a.session_id, t.d + 1 FROM agents a JOIN t ON a.parent_id = t.s WHERE t.d < 12)
     SELECT a.branch AS branch, ${wt ? "w.repo_root" : "NULL"} AS repo FROM agents a JOIN t ON a.parent_id = t.s ${wt ? "LEFT JOIN worktrees w ON w.session_id = a.session_id" : ""}
     WHERE a.branch IS NOT NULL ORDER BY a.created DESC LIMIT 400`,
  ).all(root);
}

export const boardRoutes: RouteModule = (deps: Deps) => {
  const { store } = deps;
  const board = new WorkBoard(store, { baseOf, revision });
  current = { store, board };
  ensureVerdicts(store.db);
  registerShared(WorkBoardTool, VerdictTool);
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  return {
    "/api/sessions/:id/board": {
      GET: async (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const fresh = new URL(req.url).searchParams.get("fresh") === "1";
        return json(await board.read(req.params.id, fresh));
      },
    },
  };
};
