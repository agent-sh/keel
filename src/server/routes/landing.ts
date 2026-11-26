// The landing queue's joins to the daemon (src/landing/queue.ts): the page
// reads and changes a session's repository's queue, a session queues branches
// with keel__landing_queue, a branch that leaves is told to the session that
// holds it as a failure in its scope (src/automation/failures.ts), and the
// session that queued entries gets their outcome as one harness input.
import * as agents from "../../automation/agents.ts";
import { deliver, isPending } from "../../automation/core.ts";
import * as failures from "../../automation/failures.ts";
import { LandingQueue, LIVE_STATES, type Entry } from "../../landing/queue.ts";
import { Together } from "../../landing/together.ts";
import { readOptsFor } from "../../safety/sandbox-config.ts";
import { sandboxScope } from "../../safety/sandbox-scope.ts";
import { confine } from "../../safety/sandbox.ts";
import { toolEnv } from "../../tools/jobs.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import type { Deps, RouteModule } from "../app.ts";
import { sessionOfCaller } from "../caller.ts";
import { overlapPassed, overlaps } from "./overlaps.ts";
import { landedTrust } from "./trust.ts";
import { gate, presence } from "./permissions.ts";

export let landing: LandingQueue | undefined;

// The heads a page says it showed the owner, by branch: full commit ids only.
export function headsOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [b, h] of Object.entries(v as Record<string, unknown>).slice(0, 200)) if (typeof h === "string" && /^[0-9a-f]{40,64}$/.test(h)) out[b] = h;
  return out;
}
// The pair checks of this daemon: the board reads their results (src/server/routes/board.ts).
export let together: Together | undefined;
// The daemon's parts the tool reads when it runs (a tool is registered once a process; the routes may be built again).
let current: { store: Deps["store"]; q: LandingQueue } | undefined;
let offAgents: (() => void) | undefined;

export const landingRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const ov = overlaps;
  if (!ov) throw new Error("the landing queue needs the overlap forecast's routes first");
  const owe = (sessionId: string) => {
    if (isPending(sessionId, (m) => m.kind === "landing")) return; // on its way: read again when sent
    const now = () => {
      const o = q.outcomeFor(sessionId);
      return o ? { text: o.text, meta: { kind: "landing", entries: o.entries, landed: o.landed, left: o.left }, onSent: () => o.settle() } : undefined;
    };
    const first = now();
    if (!first) return;
    deliver(sessionId, first.text, first.meta, { coalesceMs: 300, onSent: first.onSent, refresh: () => now() });
  };
  // A check runs where the session's own commands run: inside its sandbox when it has one.
  // `shown`: folders outside the tree it may read (the base's packages linked into a pair's tree), read-only.
  const confineFor = (argv: string[], sessionId: string | null, folder: string, shown: string[] = []) => {
    const p = sessionId ? gate?.perm(sessionId) : undefined;
    if (!p || p.sandbox === "off") return argv;
    const read = readOptsFor(sandboxScope(folder));
    return confine(argv, p, folder, undefined, shown.length ? { ...read, own: [...(read.own ?? []), ...shown] } : read);
  };
  const q = new LandingQueue(store, ov, {
    changed: (ids) => { for (const id of ids) bus.emit({ t: "feature", name: "landing", session_id: id, data: { changed: true } }); },
    error: (e, at) => void errors.capture("server", e, { at }),
    failed: (root, f) => {
      if (failures.record(root, { kind: "land", cls: f.cls, message: f.message, ...(f.ref ? { ref: f.ref } : {}), tell: "wake" })) failures.wake(root);
    },
    owed: (id) => { try { owe(id); } catch (e) { errors.capture("server", e, { at: "landing outcome", session: id }); } },
    confine: confineFor,
    env: (sessionId) => toolEnv(sessionId ?? "landing-queue"),
    // The push reaches the network: not for a session whose commands may not.
    mayPush: (sessionId) => {
      const p = sessionId ? gate?.perm(sessionId) : undefined;
      return p && p.sandbox !== "off" && !p.network ? "the session that queued it has no network in its sandbox" : undefined;
    },
    // An instruction file a landing changed is trusted with it where the landing is vouched for (src/safety/landed-trust.ts).
    landed: async (l) => { await landedTrust.move?.(l); },
    // A branch that conflicts with the base goes to its own agent with a rebase task (src/landing/resolve.ts).
    agents: {
      who: (e) => {
        const s = e.holder ? store.session(e.holder) : undefined;
        const a = s ? agents.byChild(s.id) : undefined;
        // A top-level session's branch is its own to rebase: it is told, as before.
        if (s && !a) return undefined;
        if (s && a && !s.archived) return agents.isHeld(s.id) ? undefined : { agent: a.id };
        // Its agent is gone (its session deleted or archived): a fresh agent of the session that queued it takes the branch.
        const parent = e.queued_by ? store.session(e.queued_by) : undefined;
        return parent && !parent.archived && !agents.isHeld(parent.id) ? { fresh: parent.id } : undefined;
      },
      send: async (e, to, text) => {
        if ("agent" in to) {
          const r = await agents.send(to.agent, text, false, `landing:${e.id}:${e.tries}`, undefined, undefined, "landing");
          if (r.held) return { why: "a stop holds it" };
          return { agent: r.agent.id, session: r.agent.session_id, task: r.agent.tasks };
        }
        const a = await agents.spawn(to.fresh, { title: `Rebase ${e.branch}`, prompt: text, background: true, branch: e.branch });
        return { agent: a.id, session: a.session_id, task: a.tasks };
      },
      state: (id) => {
        const a = agents.get(id);
        return a ? { ended: agents.isEnded(a), status: a.status, tasks: a.tasks, report: agents.report(id) ?? "" } : undefined;
      },
    },
  });
  // An agent that ended may have settled a branch's conflict: the queue reads it.
  offAgents?.();
  offAgents = bus.on((f) => {
    if (f.t !== "feature" || f.name !== "automation") return;
    const d = f.data as { kind?: string; data?: { id?: string; status?: string } } | undefined;
    if (d?.kind !== "agent" || !d.data?.id || d.data.status === "running" || d.data.status === "waiting") return;
    void q.agentEnded(d.data.id).catch((e) => errors.capture("server", e, { at: "landing agent end" }));
  });
  landing = q;
  current = { store, q };
  // Live branches that merge clean and touch related code, checked together after each forecast pass.
  const tg = new Together(store, ov, {
    error: (e, at) => void errors.capture("server", e, { at }),
    changed: (ids) => { for (const id of ids) bus.emit({ t: "feature", name: "pairs", session_id: id, data: { changed: true } }); },
    tell: (to, f) => {
      if (failures.record(to, { kind: "pair", cls: "red together", message: f.message, ...(f.ref ? { ref: f.ref } : {}), tell: "wake" })) failures.wake(to);
    },
    // (One row of the Errors panel a repository: its cause is the same each time it is told.)
    broken: (message) => void errors.capture("server", new Error(message), { at: "pair checks setup" }),
    agentOf: (sid) => { const a = agents.byChild(sid); return a ? { id: a.id, title: a.title } : undefined; },
    confine: confineFor,
    env: (sessionId) => toolEnv(sessionId ?? "pair-checks"),
  });
  together = tg;
  overlapPassed.tell = (repo) => tg.schedule(repo);
  const boot = setTimeout(() => void q.recover().catch((e) => errors.capture("server", e, { at: "landing recover" })), 3_000);
  boot.unref?.();

  const line = (e: Entry) => `${e.id} · ${e.branch} · ${e.state}${e.step ? ` (${e.step})` : ""}${e.why ? `: ${e.why}` : ""}`;
  const LandingTool: Tool = {
    name: "keel__landing_queue",
    readOnly: false,
    urgent: "landing-rebase-task", // a conflict with the base now goes to the branch's agent, not out of the queue
    description:
      "The landing queue of this session's repository. queue puts branches in it, yours or your agents' (another session's branch is its own to queue, or the owner's): Keel builds each on the base plus the entries ahead of it in a worktree of its own, runs the repository's named checks on that exact tree, and fast-forwards the base only to a commit they passed on. " +
      "An agent's branch that conflicts with the base goes back to that agent with a rebase task (a fresh agent takes the branch when it is gone), then is checked again; a conflict it calls substantive, or two failed tries, leaves the queue and is told to you. " +
      "A branch that fails a check, or conflicts with no agent to rebase it, leaves the queue and is told; the rest are built without it, and those that pass land together. The outcome (what landed, what left and why) arrives later as a message: end your turn or do other work, do not poll. " +
      "show lists the queue; remove takes a queued entry out by its id.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["queue", "show", "remove"] },
        branches: { type: "array", items: { type: "string" }, description: "queue: the branches to land, in order" },
        entry: { type: "string", description: "remove: the entry's id (from queue or show)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, ctx) {
      if (!current) return fail("The landing queue is not running.");
      const { store, q } = current;
      const s = store.session(ctx.sessionId);
      if (!s) return fail("This session was deleted.");
      if (s.parent_id) return fail("An agent does not land its own branch: report it, and the session that started you queues it.");
      const repo = q.repoOf(ctx.sessionId);
      if (!repo) return fail("This session's folder is not in a git repository on this machine.");
      if (input?.action === "show") {
        const v = await q.view(ctx.sessionId);
        const live = v.entries.filter((e) => LIVE_STATES.includes(e.state)).reverse();
        const done = v.entries.filter((e) => !LIVE_STATES.includes(e.state)).slice(0, 8);
        return ok([`Landing on ${v.base ?? "no base"}${v.rules ? `; checks: ${v.rules.checks.join(", ") || "none"}${v.rules.push ? `; pushed to ${v.rules.push}` : ""}${v.rules.problems.length ? `; problems: ${v.rules.problems.join("; ")}` : ""}` : "; the repository names no checks"}.`, live.length ? "In the queue:" : "Nothing is queued.", ...live.map(line), ...(done.length ? ["Lately:", ...done.map(line)] : [])].join("\n"));
      }
      if (input?.action === "remove") {
        const r = q.remove(String(input.entry ?? ""), ctx.sessionId);
        return "error" in r ? fail(r.error) : ok(`Removed ${line(r)}.`);
      }
      if (input?.action !== "queue") return fail("action is queue, show or remove");
      const branches = Array.isArray(input.branches) ? input.branches.filter((b: unknown) => typeof b === "string" && b.trim()).map(String) : [];
      if (!branches.length) return fail("queue takes the branches to land.");
      const r = await q.add(repo, branches, ctx.sessionId);
      const out = [
        ...(r.queued.length ? [`Queued: ${r.queued.map((e) => `${e.branch} (${e.id})`).join(", ")}. The outcome arrives as a message when the batch lands or an entry leaves; do not poll.`] : []),
        ...r.refused.map((x) => `Not queued: ${x.branch}: ${x.why}.`),
        ...r.warnings,
      ];
      return r.queued.length ? ok(out.join("\n")) : fail(out.join("\n"));
    },
  };
  registerShared(LandingTool);

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  // The owner's own hand only: a session's command that reaches the API is refused (it lands
  // through the tool, its own branches and its agents'), and a remote device shows the passkey.
  const ownerOnly = (req: Request, srv: Bun.Server<unknown>): Response | null => {
    const by = sessionOfCaller(req, srv);
    if (by) return json({ error: `this is the owner's: a session's command (session ${by}) does not land branches through the API; a session queues its own branches and its agents' with keel__landing_queue` }, 403);
    if (presence && !presence.allows(req, "landing")) return json({ error: "this needs your passkey from a remote device", presence: { action: "landing" } }, 428);
    return null;
  };
  return {
    "/api/sessions/:id/landing": {
      GET: async (req: any) => (store.session(req.params.id) ? json(await q.view(req.params.id)) : json({ error: "no such session" }, 404)),
      // The owner queues branches of the session's repository: nobody is owed the outcome (the page shows it).
      POST: async (req: any, srv: Bun.Server<unknown>) => {
        const refused = ownerOnly(req, srv);
        if (refused) return refused;
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const body = await req.json().catch(() => ({}));
        const branches = Array.isArray(body?.branches) ? body.branches.filter((b: unknown) => typeof b === "string") : [];
        if (!branches.length) return json({ error: "branches is a list of branch names" }, 400);
        const repo = q.repoOf(req.params.id);
        if (!repo) return json({ error: "the session's folder is not in a git repository" }, 400);
        // (`heads`: each branch's head as the page showed it. A branch that is not there any more was not what they queued.)
        const r = await q.add(repo, branches, null, req.params.id, headsOf(body?.heads));
        return json({ ...r, view: await q.view(req.params.id) }, r.queued.length ? 200 : 409);
      },
    },
    // The repository's after step (land.after) as the owner reads it before trusting it: it runs in the
    // checkout after a landing, so it runs only while his pin holds it (src/landing/land-pin.ts).
    "/api/landing/after": {
      GET: (req: any) => {
        const cwd = new URL(req.url).searchParams.get("cwd") || deps.workspace;
        return json(q.afterPins.show(cwd));
      },
    },
    "/api/landing/after/trust": {
      POST: async (req: any, srv: Bun.Server<unknown>) => {
        const by = sessionOfCaller(req, srv);
        if (by) return json({ error: `this is the owner's: a session's command (session ${by}) does not trust a repository's after step` }, 403);
        if (presence && !presence.allows(req, "land-after-trust")) return json({ error: "this needs your passkey from a remote device", presence: { action: "land-after-trust" } }, 428);
        const b = await req.json().catch(() => ({}));
        if (typeof b?.sha256 !== "string") return json({ error: "give the sha256 of the step you read" }, 400);
        const cwd = typeof b.cwd === "string" ? b.cwd : deps.workspace;
        const err = q.afterPins.pin(cwd, b.sha256);
        return err ? json({ error: err }, 409) : json(q.afterPins.show(cwd));
      },
    },
    "/api/landing/:entry": {
      DELETE: (req: any, srv: Bun.Server<unknown>) => {
        const refused = ownerOnly(req, srv);
        if (refused) return refused;
        const r = q.remove(req.params.entry, null);
        return "error" in r ? json(r, 409) : json(r);
      },
    },
  };
};
