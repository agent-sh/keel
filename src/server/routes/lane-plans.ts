// The plans of lanes' joins to the daemon (src/automation/lane-plans.ts): the page reads a session's
// plans and starts them, the coordinator sends and starts one with keel__lane_plan, a lane's tool call
// that moved its branch is compared with the plan, and what it is owed rides its next model request.
import { registerHooks } from "../../engine/hooks.ts";
import { toMessages } from "../../engine/turn.ts";
import { LanePlans, planText, type LaneIn } from "../../automation/lane-plans.ts";
import { registerShared } from "../../tools/registry.ts";
import { fail, ok, type Tool } from "../../tools/types.ts";
import { markOf, sameMark, type Mark } from "../../worktree/overlap-scan.ts";
import type { Deps, RouteModule } from "../app.ts";
import { overlaps } from "./overlaps.ts";

let current: LanePlans | undefined;
export const lanePlans = () => current;

const howOf = (v: unknown): "order" | "all" | number[] | undefined => {
  if (v === undefined || v === "order" || v === "all") return (v ?? "order") as "order" | "all";
  if (Array.isArray(v) && v.length && v.every((x) => Number.isInteger(x) && x >= 1)) return v.map((x) => x - 1);
  return undefined;
};

const LanePlanTool: Tool = {
  name: "keel__lane_plan",
  readOnly: false, kind: "own",
  description:
    "Plan parallel agents before any starts. action \"plan\" with lanes (each a title, a brief that is the agent's task, and the files or folders it will touch) checks the plan against the repository: " +
    "the files each lane will touch (the ones you declare, the ones its brief names, and their importers), the lanes that meet in a file (hub files count), and a proposed order (lanes that meet run one after the other, " +
    "the later started by Keel when the earlier has landed on the base) or lanes to merge into one. Nothing starts. Declare each lane's files, the shared ones too (the agents module, the tool list, AGENTS.md): " +
    "briefs rarely name the files where lanes collide. action \"start\" with plan and start: \"order\" (the proposal), \"all\" (every lane now, each its own agent), or lane numbers. " +
    "The lanes run as your background agents: their reports come to you as messages. The owner sees and can start the plan on the Lane plan panel. action \"show\" reads a plan again, with what each started lane changed against its plan.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["plan", "start", "show"] },
      lanes: {
        type: "array",
        description: "For plan: two lanes or more",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "A short title" },
            brief: { type: "string", description: "The agent's task, everything it needs" },
            files: { type: "array", items: { type: "string" }, description: "Files or folders (ending with /) it will change, relative to the repository's root" },
            type: { type: "string", description: "Optional agent type" },
          },
          required: ["brief"],
        },
      },
      plan: { type: "string", description: "For start and show: the plan's id (default: your newest)" },
      start: { description: "For start: \"order\" (default), \"all\", or a list of lane numbers (from 1)", anyOf: [{ type: "string", enum: ["order", "all"] }, { type: "array", items: { type: "integer", minimum: 1 } }] },
    },
    required: ["action"],
  },
  async run(input, ctx) {
    const lp = current;
    if (!lp) return fail("Plans of lanes are not running.");
    const action = input?.action;
    if (action === "plan") {
      try {
        const v = await lp.make(ctx.sessionId, (input.lanes ?? []) as LaneIn[], "session");
        return ok(`${planText(v)}\nNothing has started. Start it with action "start" (plan ${v.id}, start: "order", "all" or lane numbers).`);
      } catch (e) { return fail((e as Error).message); }
    }
    const id = typeof input?.plan === "string" && input.plan.trim() ? input.plan.trim() : lp.ids(ctx.sessionId, 1)[0];
    if (!id || !lp.owns(ctx.sessionId, id)) return fail(id ? `No plan ${id} of this session.` : "This session has no plan: make one with action \"plan\".");
    if (action === "show") return ok(planText((await lp.view(id))!));
    if (action !== "start") return fail('action: "plan", "start" or "show".');
    const how = howOf(input.start);
    if (!how) return fail('start: "order", "all", or a list of lane numbers from 1.');
    try {
      const r = await lp.start(id, how, "session");
      const n = (xs: number[]) => xs.map((i) => i + 1).join(", ");
      const said = [r.started.length ? `Started lane ${n(r.started)} as background agents.` : "", r.waiting.length ? `Lane ${n(r.waiting)} wait${r.waiting.length === 1 ? "s" : ""}: each starts by itself when the lanes it waits on have landed on the base.` : "", ...r.failed.map((f) => `Lane ${f.idx + 1} did not start: ${f.why}`)].filter(Boolean);
      const text = `${said.join(" ") || "Nothing to start: every lane of it started already."} Their reports come to you as messages; do not poll.\n\n${planText((await lp.view(id))!)}`;
      return r.started.length || r.waiting.length ? ok(text) : fail(text);
    } catch (e) { return fail((e as Error).message); }
  },
};

export const lanePlanRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const lp = new LanePlans(store, {
    error: (e, at) => void errors.capture("server", e, { at }),
    changed: (sessionId, plan) => bus.emit({ t: "feature", name: "lane_plan", session_id: sessionId, data: { plan } }),
  });
  current = lp;
  registerShared(LanePlanTool);
  // An agent changed state, or a landing queue moved: an owed start may be due.
  // (And a lane's agent that changed state changes its plan's view.)
  bus.on((f) => {
    // A hold ended: a plan it kept goes on (and its panel says it is no longer held).
    if (f.t === "queue") {
      if (!f.held) lp.released();
      const plan = lp.heldChanged(f.session_id, !!f.held) ? lp.ids(f.session_id, 1)[0] : undefined;
      if (plan) bus.emit({ t: "feature", name: "lane_plan", session_id: f.session_id, data: { plan } });
      return;
    }
    if (f.t !== "feature") return;
    const agent = f.name === "automation" && f.data?.kind === "agent";
    if (!agent && f.name !== "landing") return;
    lp.nudge();
    const at = agent && typeof f.data.data?.session_id === "string" ? lp.laneOf(f.data.data.session_id) : undefined;
    const owner = at ? lp.sessionOf(at.plan) : undefined;
    if (at && owner) bus.emit({ t: "feature", name: "lane_plan", session_id: owner, data: { plan: at.plan } });
  });

  // A lane's call that moved its branch: what it changed is compared with the plan.
  const last = new Map<string, Mark>();
  const seen = async (s: Parameters<typeof markOf>[0]) => {
    try {
      if (!s.parent_id || !(await lp.laneSoon(s.id))) return;
      const now = markOf(s, (repo) => overlaps?.baseKnown(repo));
      if (!now?.tip || sameMark(last.get(s.id), now)) return;
      last.set(s.id, now);
      if (last.size > 2048) last.delete(last.keys().next().value!);
      await lp.moved(s.id);
    } catch (e) { errors.capture("server", e, { at: "lane plan stray", session: s.id }); }
  };
  registerHooks({
    afterTool: (s) => seen(s),
    toolFailed: (s) => seen(s),
    beforeRequest: (s, req) => {
      if (req.purpose !== "turn") return req;
      try {
        const n = lp.noteFor(s.id);
        if (!n) return req;
        store.atomic(s.id, () => {
          const ev = store.append(s.id, "note", { kind: "lane_plan", model: true, text: n.text, short: `Changed ${n.files.length} file${n.files.length === 1 ? "" : "s"} another lane of the plan owns`, files: n.files });
          n.settle();
          bus.emit({ t: "event", event: ev });
        });
        return { ...req, messages: toMessages(store.lineage(s.id)) };
      } catch (e) {
        errors.capture("server", e, { at: "lane plan note", session: s.id });
        return req;
      }
    },
  });

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const failed = (e: unknown) => json({ error: (e as Error).message }, (e as { status?: number }).status ?? 500);
  return {
    "/api/sessions/:id/lane-plans": {
      GET: async (req: any) => {
        if (!store.session(req.params.id)) return json({ error: "no such session" }, 404);
        const plans = [];
        for (const id of lp.ids(req.params.id)) { const v = await lp.view(id); if (v) plans.push(v); }
        return json({ plans });
      },
      // The owner's plan, from the panel.
      POST: async (req: any) => {
        const body = await req.json().catch(() => ({}));
        try { return json(await lp.make(req.params.id, body?.lanes ?? [], "owner")); } catch (e) { return failed(e); }
      },
    },
    "/api/lane-plans/:plan/start": {
      POST: async (req: any) => {
        const body = await req.json().catch(() => ({}));
        const how = Array.isArray(body?.lanes) ? (body.lanes.every((x: unknown) => Number.isInteger(x) && (x as number) >= 0) ? (body.lanes as number[]) : undefined) : howOf(body?.how);
        if (!how) return json({ error: 'how: "order" or "all", or lanes: indexes from 0' }, 400);
        try { const r = await lp.start(req.params.plan, how, "owner"); return json({ ...r, plan: await lp.view(req.params.plan) }); } catch (e) { return failed(e); }
      },
    },
    "/api/lane-plans/:plan": {
      GET: async (req: any) => { const v = await lp.view(req.params.plan); return v ? json(v) : json({ error: "no such plan" }, 404); },
      DELETE: (req: any) => (lp.remove(req.params.plan) ? json({ ok: true }) : json({ error: "no such plan" }, 404)),
    },
  };
};
