// The work board's joins to the daemon (src/board/board.ts): the page reads a session's board, and the
// session reads it with keel__work_board in a few hundred tokens, with no model request behind it.
import { WorkBoard } from "../../board/board.ts";
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
    "the latest review of its branch and the reviewer's verdict line, whether the base holds its head (or the same patches), and whether what runs holds it. " +
    "Read it instead of a ledger of your own, after a compaction or a restart, or to answer a status question. By default agents that need you get a line each and the rest are listed by id; " +
    "all: true lists every row; agent: <id> shows one row in full. Start a review agent with reviews: <branch> so the board knows what it reviews.",
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

export const boardRoutes: RouteModule = (deps: Deps) => {
  const { store } = deps;
  const board = new WorkBoard(store, { baseOf, revision });
  current = { store, board };
  registerShared(WorkBoardTool);
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
