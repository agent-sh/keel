// The check ledger (src/checks): its table, its hooks on shell calls and
// jobs, the block that names a repository's checks to its sessions, its
// setting, and its routes.
//
// GET /api/checks?session=&repo=&tree=&before=&limit=
//   -> { runs (newest first), answered, saved_ms, kept, bound }
//   answered and saved_ms: the runs the ledger answered instead of running,
//   and the time their earlier runs took (what answering saved).
// GET /api/checks/named?cwd=
//   -> { repo, source: "file" | "setting" | null, checks, problems }
import { isAbsolute } from "node:path";
import { onSettings, registerSettings, settings } from "../../admin/settings.ts";
import { bindLedger, KEEP, list, namedFor, repoOf, setKeep } from "../../checks/ledger.ts";
import { FILE, readChecks } from "../../checks/named.ts";
import { afterCall, beforeCall, dropCall, jobDone, jobStarted } from "../../checks/runs.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { jobDone as jobDoneTell, jobStarted as jobStartedTell } from "../../tools/jobs.ts";
import type { RouteModule } from "../app.ts";

registerSettings("checks", { repos: {}, keep_runs: KEEP }, (v) => {
  if (!v.repos || typeof v.repos !== "object" || Array.isArray(v.repos)) return "repos maps a repository's main checkout to its checks";
  for (const [dir, c] of Object.entries(v.repos)) {
    if (!isAbsolute(dir)) return `repos: ${dir} is not an absolute folder`;
    const got = readChecks(c);
    if (got.problems.length) return `repos: ${dir}: ${got.problems[0]}`;
  }
  if (!(Number.isInteger(v.keep_runs) && v.keep_runs >= 100)) return "keep_runs is a whole number of runs, at least 100";
  return undefined;
});

export const checkRoutes: RouteModule = ({ store, errors }) => {
  bindLedger(store);
  setKeep(settings().checks?.keep_runs ?? KEEP);
  onSettings((s) => setKeep(s.checks?.keep_runs ?? KEEP));
  const quiet = (at: string, f: () => void) => { try { f(); } catch (e) { errors.capture("server", e, { at }); } };
  jobStartedTell.tell = (job) => quiet("check ledger: a job started", () => jobStarted(job));
  jobDoneTell.tell = (job) => quiet("check ledger: a job ended", () => jobDone(job));

  registerHooks({
    beforeTool: async (s, call) => {
      try { return await beforeCall(s, call); } catch (e) { errors.capture("server", e, { at: "check ledger before a call", session: s.id }); }
    },
    afterTool: async (s, call, result) => {
      try { await afterCall(s, call, result); } catch (e) { errors.capture("server", e, { at: "check ledger after a call", session: s.id }); }
    },
    toolFailed: (_s, call) => dropCall(call.id),
    // The repository's checks, named to its sessions: run as written, a check is answered from the ledger.
    sessionSystem: (s) => {
      const repo = repoOf(s.workspace);
      const named = repo ? namedFor(repo) : undefined;
      const checks = named?.checks ?? [];
      const data = JSON.stringify(checks);
      if (!checks.length) return { name: "Checks this repository names", text: "", data };
      const where = named!.source === "file" ? FILE : "the owner's Keel setting";
      const lines = checks.map((c) => `- ${c.name}: \`${c.run}\`${c.args ? " (more arguments allowed)" : ""}${c.dir !== "." ? ` in ${c.dir}` : ""}`);
      return {
        name: "Checks this repository names", data,
        text: `Checks this repository names (${where}):\n${lines.join("\n")}\nKeel records each run of one by the tree it ran on (the files as they are, uncommitted changes included). Run a check as written here: one that already passed on the same files is answered from that record instead of run again, and a red one says whether it is red on the base branch too, or flaky.`,
      };
    },
  });

  return {
    "/api/checks": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const n = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        return Response.json(list({ session: q.get("session") ?? undefined, repo: q.get("repo") ?? undefined, tree: q.get("tree") ?? undefined, before: n("before"), limit: n("limit") }));
      },
    },
    "/api/checks/named": {
      GET: (req: Request) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (!cwd || !isAbsolute(cwd)) return Response.json({ error: "cwd is an absolute folder" }, { status: 400 });
        const repo = repoOf(cwd);
        const named = repo ? namedFor(repo) : undefined;
        return Response.json({ repo: repo?.scope ?? null, top: repo?.top ?? null, source: named?.source ?? null, checks: named?.checks ?? [], problems: named?.problems ?? [] });
      },
    },
  };
};
