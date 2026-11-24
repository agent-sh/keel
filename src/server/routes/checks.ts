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
// GET /api/sessions/:id/fails-before -> { run (the newest, or null), tests (whether its repository names a check that runs test files) }
// POST /api/sessions/:id/fails-before -> { run } (null: no test file added or changed): its new and changed
//   tests run on the base without the change (src/checks/before-run.ts); a frame "fails_before" says each step.
import { isAbsolute } from "node:path";
import { onSettings, registerSettings, settings } from "../../admin/settings.ts";
import { bindLedger, KEEP, list, namedFor, repoOf, setKeep } from "../../checks/ledger.ts";
import { FILE, readChecks } from "../../checks/named.ts";
import { afterCall, beforeCall, dropCall, jobDone, jobStarted } from "../../checks/runs.ts";
import { bindBefore, latest, startFor } from "../../checks/before-run.ts";
import { agentChanged as besideAgent, afterCall as besideCall, afterStep as besideStep, afterTurn as besideTurn, bindBeside, checkSetting as besideSetting, forget as besideForget } from "../../checks/beside-run.ts";
import * as agents from "../../automation/agents.ts";
import * as failures from "../../automation/failures.ts";
import type { AgentState } from "../../checks/beside.ts";
import { gate } from "./permissions.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { readsOf } from "../reads.ts";
import { jobDone as jobDoneTell, jobStarted as jobStartedTell } from "../../tools/jobs.ts";
import type { RouteModule } from "../app.ts";

registerSettings("checks", { repos: {}, keep_runs: KEEP, beside: { window_s: 30, host: null, host_path: [] } }, (v) => {
  if (!v.repos || typeof v.repos !== "object" || Array.isArray(v.repos)) return "repos maps a repository's main checkout to its checks";
  for (const [dir, c] of Object.entries(v.repos)) {
    if (!isAbsolute(dir)) return `repos: ${dir} is not an absolute folder`;
    const got = readChecks(c);
    if (got.problems.length) return `repos: ${dir}: ${got.problems[0]}`;
  }
  if (!(Number.isInteger(v.keep_runs) && v.keep_runs >= 100)) return "keep_runs is a whole number of runs, at least 100";
  return besideSetting(v.beside);
});

export const checkRoutes: RouteModule = ({ store, errors, bus, engine }) => {
  bindLedger(store);
  void bindBefore({ store, bus, perm: (id) => gate?.perm(id), confine: (id, workspace, tool, shown) => gate?.confineFor(id, workspace, tool, shown), capture: (e, ctx) => errors.capture("server", e, ctx) });
  // The checks beside an agent (src/checks/beside-run.ts): a red one is told to a working agent as a message of the
  // harness's, and of a finished one to the session that started it, in its failures notice (it starts no turn).
  const agentOf = (id: string): AgentState | undefined => {
    try {
      const a = agents.byChild(id);
      if (!a) return undefined;
      // The owner's Stop holds every agent below it as the owner's.
      if (agents.ownerHolds(a.session_id)) return "held";
      if (agents.isEnded(a)) return a.status === "stopped" && agents.isOwnerHold(a.stopped_by) ? "held" : "ended";
      return engine.isRunning(a.session_id) ? "working" : "parked";
    } catch { return undefined; } // no agents table: a store the automation never opened
  };
  bindBeside({
    store, capture: (e, ctx) => errors.capture("server", e, ctx), perm: (id) => gate?.perm(id), confine: (id, workspace, tool, shown) => gate?.confineFor(id, workspace, tool, shown), agentOf,
    tellAgent: async (id, text, key) => {
      if (agentOf(id) !== "working") return false;
      await agents.send(agents.byChild(id)!.id, text, false, key, undefined, undefined, "checks_beside");
      return true;
    },
    tellParent: (id, cls, message) => {
      const a = agents.byChild(id);
      if (a) failures.record(a.parent_id, { kind: "check", cls, message, ref: { id: a.id, label: a.title }, tell: "ride" }, a.session_id);
    },
  });
  bus.on((f) => {
    if (f.t === "session" && (f.deleted || f.session.archived)) besideForget(f.session.id);
    // An agent's record changed: where a red kept for it goes (src/automation/core.ts emit).
    if (f.t === "feature" && f.name === "automation" && (f.data as any)?.kind === "agent") { const sid = (f.data as any).data?.session_id; if (typeof sid === "string") besideAgent(sid); }
  });
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
      try { besideCall(s, call); } catch (e) { errors.capture("server", e, { at: "checks beside after a call", session: s.id }); }
      try { await afterCall(s, call, result); } catch (e) { errors.capture("server", e, { at: "check ledger after a call", session: s.id }); }
    },
    stepDone: (s) => { try { besideStep(s); } catch (e) { errors.capture("server", e, { at: "checks beside after a step", session: s.id }); } },
    turnEnd: (s) => { try { besideTurn(s); } catch (e) { errors.capture("server", e, { at: "checks beside after a turn", session: s.id }); } },
    toolFailed: (_s, call) => dropCall(call.id),
    // The repository's checks, named to its sessions: run as written, a check is answered from the ledger.
    sessionSystem: (s) => {
      const repo = repoOf(s.workspace);
      const named = repo ? namedFor(repo) : undefined;
      const checks = named?.checks ?? [];
      const data = JSON.stringify(checks);
      if (!checks.length) return { name: "Checks this repository names", text: "", data };
      const where = named!.source === "file" ? FILE : named!.source === "setting" ? "the owner's Keel setting" : `${FILE} and the owner's Keel setting`;
      const lines = checks.map((c) => `- ${c.name}: \`${c.run}\`${c.args ? " (more arguments allowed)" : ""}${c.dir !== "." ? ` in ${c.dir}` : ""}`);
      // An agent's checks beside it (src/checks/beside-run.ts): what it is told, and what it is not.
      const beside = s.parent_id ? checks.filter((c) => c.beside).map((c) => c.name) : [];
      const besideText = beside.length ? ` After your edits Keel runs ${beside.join(" and ")} by itself on a copy of your files (a check that takes test files gets the tests your change touches) and tells you when one fails. A pass says nothing; it is kept in the record, so the same command on the same files is answered from it.` : "";
      return {
        name: "Checks this repository names", data,
        text: `Checks this repository names (${where}):\n${lines.join("\n")}\nKeel records each run of one by the tree it ran on (the files as they are, uncommitted changes included). Run a check as written here, in a call of its own (to send its output to a file and read its end is fine): one that already passed on the same files is answered from that record instead of run again, and a red one says whether it is red on the base branch too, or flaky.${named!.wait.length ? ` Behind a wait it names (${named!.wait.map((w) => `\`${w}\``).join(", ")}) is fine; an answer skips the wait too.` : ""} To run one in the background, use the tool's own background option, not \`&\`: a check started with \`&\`, after an edit in the same call or inside a command substitution is not recorded.${besideText}`,
      };
    },
  });

  return {
    "/api/checks": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const n = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
        // (Its sums go over the whole table: on the read thread.)
        const reads = readsOf(store);
        return list({ session: q.get("session") ?? undefined, repo: q.get("repo") ?? undefined, tree: q.get("tree") ?? undefined, before: n("before"), limit: n("limit") }, (sql, params) => reads.sql(sql, params)).then((r) => Response.json(r));
      },
    },
    "/api/sessions/:id/fails-before": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return Response.json({ error: "no such session" }, { status: 404 });
        const repo = repoOf(s.workspace);
        return Response.json({ run: latest(s.id) ?? null, tests: !!(repo && namedFor(repo)?.checks.some((c) => c.tests?.length)) });
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return Response.json({ error: "no such session" }, { status: 404 });
        try { return Response.json({ run: (await startFor(s.id, s.workspace, { again: true })) ?? null }); }
        catch (e) { errors.capture("server", e, { at: "fails before", session: s.id }); return Response.json({ error: (e as Error).message }, { status: 500 }); }
      },
    },
    "/api/checks/named": {
      GET: (req: Request) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (!cwd || !isAbsolute(cwd)) return Response.json({ error: "cwd is an absolute folder" }, { status: 400 });
        const repo = repoOf(cwd);
        const named = repo ? namedFor(repo) : undefined;
        return Response.json({ repo: repo?.scope ?? null, top: repo?.top ?? null, source: named?.source ?? null, checks: named?.checks ?? [], wait: named?.wait ?? [], env: named?.env ?? [], problems: named?.problems ?? [] });
      },
    },
  };
};
