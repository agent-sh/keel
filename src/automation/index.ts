import { awakeHolds, awakeReasons, recheckAwake } from "../admin/awake.ts";
import type { Judged } from "../safety/gate.ts";
import { registerHooks } from "../engine/hooks.ts";
import { toMessages } from "../engine/turn.ts";
import { lineage } from "../core/tree.ts";
import type { Deps, RouteModule } from "../server/app.ts";
import { registerShared } from "../tools/registry.ts";
import * as activity from "./activity.ts";
import * as consult from "./consult.ts";
import * as goals from "./goals.ts";
import * as agents from "./agents.ts";
import * as alerts from "./alerts.ts";
import * as failures from "./failures.ts";
import * as snooze from "./snooze.ts";
import { afterTurn, capture, D, hasPending, setDeps } from "./core.ts";
import * as loops from "./loops.ts";
import { parseLoopCommand } from "./schedule.ts";
import { automationTools, extendTaskStop, waitAckHooks } from "./tools.ts";
import * as waits from "./waits.ts";
import { liveAgents } from "./state.ts";
import { runMode } from "../core/runmode.ts";
import { namesOf } from "../integrations/hooks.ts";
import { forwardedStanding, isLocal } from "../safety/presence.ts";

// Subagents, waits, loops and alerts: tables, tools, turn hooks, the scheduler
// and the HTTP routes, joined to the daemon from this one module.

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (message: string, status = 400) => json({ error: message }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const attempt = async (f: () => Promise<Response> | Response) => {
  try {
    return await f();
  } catch (e: any) {
    return json({ error: e.message, ...(e.current ? { current: e.current } : {}) }, e.status ?? 400);
  }
};

const g = globalThis as any;
let ticks = 0;
const LOOP_HORIZON = 15 * 60_000;
function loopsDue(): string | undefined {
  const n = D().store.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM loops WHERE enabled = 1 AND next_ms IS NOT NULL AND next_ms <= ?").get(Date.now() + LOOP_HORIZON)?.n ?? 0;
  return n ? `${n} loop${n > 1 ? "s" : ""} due within 15 minutes` : undefined;
}
const TURN_WORDS: Record<string, string> = { end_turn: "finished", error: "failed", interrupted: "stopped", max_tokens: "cut off at the output limit" };
const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input", "ask_user"]);

function init(deps: Deps) {
  setDeps(deps);
  agents.migrate();
  waits.migrate();
  loops.migrate();
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  consult.migrate();
  goals.migrate();
  failures.init();
  registerShared(...automationTools, consult.advisorTool);
  extendTaskStop();

  registerHooks(waitAckHooks);
  registerHooks(failures.hooks);
  registerHooks({
    // The owner's task-list edits since the last request, as one note.
    beforeRequest: (s, req) =>
      req.purpose === "turn" && goals.tellModel(s.id) ? { ...req, messages: toMessages(lineage(deps.store.events(s.id), deps.store.session(s.id)?.head ?? null)) } : req,
    system: (s) => {
      const custom = agents.definitions(s.workspace).filter((d) => d.source !== "built-in");
      return custom.length ? `Agent types you can start besides the built-ins:\n${custom.map((d) => `- ${d.name}: ${d.description}`).join("\n")}` : "";
    },
    beforeTool: async (s, call) => {
      const target = call.tool.target && agents.byChild(s.id) ? await call.tool.target(call.input) : null;
      const name = target?.name ?? call.tool.name;
      const why = agents.gate(s.id, call.tool.name, call.input, namesOf(name, target ? target.input : call.input, call.tool.name));
      if (why) return { deny: why };
      // A question the model asks the owner is an alert until it is answered.
      if (QUESTION_TOOLS.has(call.tool.name)) {
        const q = (call.input?.questions ?? [])[0];
        const text = String(q?.question ?? call.input?.question ?? call.input?.prompt ?? "The agent asks a question.");
        alerts.raise("question", s.id, `Question: ${deps.store.session(s.id)?.title || "a session"}`, text, { call_id: call.id, open_session: s.id });
      }
      return undefined;
    },
    afterTool: (s, call, result) => {
      // A plan the tool refused is not the plan: the saved list stays as it was.
      if (goals.isPlanTool(call.tool.name) && !result.is_error) goals.fromPlanTool(s.id, call.tool.name, call.input);
      if (QUESTION_TOOLS.has(call.tool.name)) {
        alerts.readWhere("call_id", call.id);
        // The answer to a question is the owner's word: it ends a snooze.
        snooze.end(deps.store.session(s.id)?.parent_id ?? s.id, "the owner answered");
      }
    },
    turnStart: (s) => agents.onTurnStart(s.id),
    cutTurn: (s, cut) => agents.onCutTurn(s.id, cut),
    cutTurnHeld: (s, why) => agents.onCutTurnHeld(s.id, why),
    turnEnd: (s, reason) => {
      afterTurn(s.id, () => {
        const loopRun = loops.runOpenIn(s.id);
        failures.onTurnEnd(s.id, reason);
        loops.onTurnEnd(s.id, reason);
        agents.onTurnEnd(s.id, reason);
        // A session whose agents still work has not finished: its alert waits
        // for their reports (they start its next turn, whose end tells).
        const more = hasPending(s.id) || waits.activeFor(s.id) > 0 || liveAgents(s.id) > 0;
        const child = !!deps.store.session(s.id)?.parent_id;
        if (!child) activity.record("turn", reason, s.id, `${deps.store.session(s.id)?.title || "Session"}: turn ${TURN_WORDS[reason] ?? `ended (${reason})`}`);
        alerts.onTurnEnd(s.id, reason, { subagent: child, loopRun, more });
        if (!child) goals.afterTurn(s.id, reason, { judge: !more }).catch((e) => capture(e, { at: "goal" }));
      });
    },
  });

  // The last agent of a parent whose turn already ended, ending with no report
  // for it (a reviewer's findings go to their own panel): no turn of the
  // parent follows, so the alert its turn held back is raised now.
  const settled = new Set<string>();
  deps.bus.on((f) => {
    if (f.t !== "feature" || f.name !== "automation" || (f.data as { kind: string }).kind !== "agent") return;
    const a = (f.data as { data: agents.AgentRecord }).data;
    if (!agents.isEnded(a)) return void settled.delete(a.id);
    if (settled.has(a.id)) return;
    settled.add(a.id);
    if (a.handback || !agents.isSilent(a.id)) return;
    const p = deps.store.session(a.parent_id);
    if (!p || p.archived || p.parent_id || deps.engine.isRunning(p.id) || hasPending(p.id) || waits.activeFor(p.id) > 0 || liveAgents(p.id) > 0) return;
    alerts.onTurnEnd(p.id, p.settings.last_end ?? "end_turn", { subagent: false, loopRun: loops.runOpenIn(p.id), more: false });
  });

  // Archiving a session cancels its waits and stops its agents at once (not at
  // a later sweep, so a quick restore cannot keep one); restoring it hands it
  // the reports its agents finished meanwhile and resumes nothing else.
  const archived = new Set(deps.store.db.query<{ id: string }, []>("SELECT id FROM sessions WHERE archived = 1").all().map((r) => r.id));
  deps.bus.on((f) => {
    if (f.t !== "session" || f.deleted) return;
    const s = f.session;
    if (s.archived && !archived.has(s.id)) {
      archived.add(s.id);
      waits.cancelForSession(s.id);
      agents.stopChildrenOf(s.id);
    } else if (!s.archived && archived.delete(s.id)) agents.deliverOwed(s.id);
  });

  // Approval cards become alerts (a child's under its parent); an answered
  // card's alert is read.
  deps.bus.on((f) => {
    // A loop made, changed or removed may change whether to stay awake.
    if (f.t === "feature" && f.name === "automation" && (f.data as { kind: string }).kind === "loop") recheckAwake();
    // A message the owner typed ends a snooze.
    if (f.t === "event" && f.event.kind === "user" && !f.event.data.kind && f.event.data.origin !== "queued") {
      const s = deps.store.session(f.event.session_id);
      if (s && !s.parent_id) snooze.end(s.id, "the owner wrote to it");
    }
    // Full auto settled a high-risk call without the owner: each is an
    // activity row; a refusal is a quiet alert (the inbox, never a desktop or
    // phone interruption), except a repeat of one already raised.
    if (f.t === "feature" && f.name === "judged") {
      const j = f.data as Judged;
      const ran = j.outcome === "rule" || j.outcome === "judge" || j.outcome === "retry";
      activity.record("approval", ran ? `allowed by ${j.outcome === "rule" ? "a rule" : j.outcome === "judge" ? "the judge" : "a retry"}` : j.outcome === "repeat" ? "refused again" : "refused", j.session_id, `${j.tool}: ${j.summary}`.slice(0, 300) + ` (${j.reason})`.slice(0, 300), { call_id: j.call_id, blocked_id: j.blocked_id, model: j.model, ms: j.ms });
      if (!ran && j.outcome !== "repeat") {
        const s = deps.store.session(j.session_id);
        alerts.raise("refused", j.session_id, `Refused in ${s?.title || "a session"}`, `${j.tool}: ${j.summary}`.slice(0, 200) + ` (${j.reason})`.slice(0, 300), { blocked_id: j.blocked_id, open_session: j.session_id });
      }
      return;
    }
    if (f.t !== "feature" || f.name !== "approval") return;
    const a = f.data as { id: string; session_id: string; tool: string; summary: string; risk: string; state: string };
    if (a.state === "pending") {
      const s = deps.store.session(a.session_id);
      alerts.raise("approval", a.session_id, `Approval: ${s?.title || "a session"}`, `${a.tool}: ${a.summary}`.slice(0, 500), { approval_id: a.id, open_session: a.session_id, risk: a.risk });
    } else {
      alerts.readWhere("approval_id", a.id);
      activity.record("approval", a.state, a.session_id, `${a.tool}: ${a.summary}`.slice(0, 300) + ` (${a.state})`, { approval_id: a.id });
    }
  });

  // Keep awake (the admin lane's lock): also while a loop's next run is near,
  // so a sleeping machine does not miss it; each hold is an activity row.
  awakeReasons.splice(0, awakeReasons.length, loopsDue);
  awakeHolds.ended = (_since, ms, reason) => {
    const mins = Math.round(ms / 60_000);
    activity.record("awake", "hold", null, `Kept the machine awake for ${mins < 1 ? "under a minute" : `${mins} min`} (${reason || "working"})`, { ms });
  };

  if (!g.__keelAutomationRecovered && !runMode.client) {
    g.__keelAutomationRecovered = true;
    try {
      // Before anything of this start is delivered to a session: the turn the
      // last daemon left open there is closed (after the gate's hooks, which
      // say what became of a cut call, were registered above this module).
      try { deps.engine.closeCut(deps.store.bootWorking); } catch (e) { capture(e, { at: "recover", step: "close" }); }
      waits.recover();
      loops.recover();
      agents.recover();
      failures.recover();
      goals.recover();
    } catch (e) {
      capture(e, { at: "recover" });
    }
    process.on("exit", () => waits.stopAll());
  }

  clearInterval(g.__keelAutomationTick);
  g.__keelAutomationTick = setInterval(() => {
    // Most seconds nothing is active: one indexed query says so and the
    // tick ends there (each step below would find nothing to do).
    if (!busy(deps)) return;
    waits.tick().catch((e) => capture(e, { at: "waits tick" }));
    try {
      if (!runMode.client) loops.tick(); // a command's own daemon claims no Loop
      agents.tick();
      alerts.tickSnoozes();
      if (++ticks % 30 === 0) recheckAwake();
      sweepArchived(deps);
    } catch (e) {
      capture(e, { at: "tick" });
    }
  }, 1000);
}

function busy(deps: Deps): boolean {
  const now = Date.now();
  return !!deps.store.db.query<{ n: number }, [number, number]>(`SELECT
    EXISTS (SELECT 1 FROM waits WHERE status = 'active') OR
    EXISTS (SELECT 1 FROM agents WHERE status IN ('running', 'waiting')) OR
    EXISTS (SELECT 1 FROM loops WHERE enabled = 1 AND next_ms IS NOT NULL AND next_ms <= ?) OR
    EXISTS (SELECT 1 FROM snoozes WHERE until_ms IS NOT NULL AND until_ms <= ?) AS n`).get(now, now)?.n;
}

// An archived session runs neither its agents nor its waits.
function sweepArchived(deps: Deps) {
  const rows = deps.store.db.query<{ id: string }, []>(`
    SELECT DISTINCT s.id FROM sessions s WHERE s.archived = 1 AND (
      EXISTS (SELECT 1 FROM waits w WHERE w.session_id = s.id AND w.status = 'active') OR
      EXISTS (SELECT 1 FROM agents a WHERE a.parent_id = s.id AND a.status IN ('running', 'waiting')))`).all();
  for (const r of rows) {
    waits.cancelForSession(r.id);
    agents.stopChildrenOf(r.id);
  }
}

function background(sessionId: string) {
  return {
    agents: agents.list(sessionId),
    waits: waits.list(sessionId, 20),
    loops: loops.list(sessionId),
  };
}

export const automationRoutes: RouteModule = (deps) => {
  init(deps);
  const { store, providers } = deps;
  const session = (id: string) => store.session(id);

  return {
    "/api/automation": {
      GET: () => {
        const db = store.db;
        const recent = Date.now() - 86400_000;
        const agentRows = db.query<{ id: string }, [number]>("SELECT id FROM agents WHERE status IN ('running','waiting') OR created > ? ORDER BY created").all(recent);
        return json({
          agents: agentRows.map((r) => agents.get(r.id)),
          waits: waits.list(undefined, 30),
          loops: loops.list(),
          unread: alerts.unreadCounts(),
          alerts: alerts.list({ limit: 50, withUnread: true }),
          settings: alerts.settings(),
          channels: alerts.channelList(),
          snoozes: snooze.all(),
          rev: deps.bus.rev(), // the bus frame this read reflects: a page orders it against frames
        });
      },
    },

    // --- subagents
    "/api/agents": {
      GET: (req: Request) => json({ agents: agents.definitions(new URL(req.url).searchParams.get("cwd") || deps.workspace) }),
    },
    "/api/sessions/:id/agents": {
      GET: (req: any) => {
        const s = session(req.params.id);
        return s ? json({ agents: agents.list(s.id), limit: s.parent_id ? 0 : agents.limitOf(s.id) }) : bad("no such session", 404);
      },
      PATCH: async (req: any) => {
        // Fleet forwarding arrives on loopback; it cannot change the host's limit.
        if (!isLocal(req) || forwardedStanding(req)) return bad("change this limit from the daemon's own desk", 403);
        const { limit } = await body(req);
        if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) return bad("limit must be a positive integer or null to use the daemon default");
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.parent_id) return bad("a subagent cannot start agents", 409);
        agents.setLimit(s.id, limit);
        return json({ limit: agents.limitOf(s.id) });
      },
    },
    "/api/sessions/:id/agents/:agent_id/stop": {
      POST: (req: any) => {
        if (!session(req.params.id)) return bad("no such session", 404);
        const a = agents.get(req.params.agent_id);
        if (!a || a.parent_id !== req.params.id) return bad("the session has no such agent");
        const was = a.status;
        agents.stop(a.id, "owner");
        return json({ ok: true, stopped: was === "running" || was === "waiting" });
      },
    },
    // Stop from the agent's own session (its page's Stop this agent): the
    // whole agent, as its parent's card stops it, by the owner, waits cancelled.
    "/api/sessions/:id/as-agent/stop": {
      POST: (req: any) => {
        if (!session(req.params.id)) return bad("no such session", 404);
        const a = agents.byChild(req.params.id);
        if (!a) return bad("this session is not an agent's");
        const was = a.status;
        agents.stop(a.id, "owner");
        return json({ ok: true, stopped: was === "running" || was === "waiting" });
      },
    },
    "/api/sessions/:id/agents/:agent_id/message": {
      POST: (req: any) => attempt(async () => {
        const a = agents.get(req.params.agent_id);
        if (!a || a.parent_id !== req.params.id) return bad("the session has no such agent", 404);
        const b = await body(req);
        if (!String(b.message ?? "").trim()) return bad("message cannot be empty");
        return json({ agent: await agents.send(a.id, String(b.message), !!b.interrupt) });
      }),
    },
    "/api/sessions/:id/background": {
      GET: (req: any) => (session(req.params.id) ? json(background(req.params.id)) : bad("no such session", 404)),
    },

    // --- composer commands: /loop
    "/api/sessions/:id/command": {
      POST: (req: any) => attempt(async () => {
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        const cmd = parseLoopCommand(String(b.text ?? ""));
        if (!cmd) return json({ handled: false });
        const { loop } = loops.create({ session_id: s.id, schedule: cmd.schedule, prompt: cmd.prompt, created_by: "owner" });
        // An interval or self-paced loop runs its first iteration now, as /loop does.
        if (loop.kind !== "cron") loops.start(loop, Date.now(), { note: "First run, started with the loop." });
        return json({ handled: true, loop: loops.get(loop.id) });
      }),
    },

    // --- waits
    "/api/waits": {
      GET: () => json({ waits: waits.list(undefined, 100) }),
      POST: (req: Request) => attempt(async () => {
        const b = await body(req);
        const s = session(String(b.session_id ?? ""));
        if (!s) return bad("no such session", 404);
        if (s.archived) return bad("the session is archived", 409);
        const spec = waits.normalize(b.spec ?? b, s.workspace);
        if (waits.isMonitor(spec.kind)) return bad("a monitor is started by the agent, not here");
        return json(waits.create(s.id, spec, { timeout_seconds: b.timeout_seconds, note: b.note }), 201);
      }),
    },
    "/api/waits/:id": {
      DELETE: (req: any) => {
        const r = waits.cancel(req.params.id);
        return r ? json({ ok: true, result: r, cancelled: r === "cancelled" }) : bad("no such wait", 404);
      },
    },

    // --- loops
    "/api/loops": {
      GET: () => json({ loops: loops.list() }),
      POST: (req: Request) => attempt(async () => {
        const b = await body(req);
        let sid = b.session_id ? String(b.session_id) : "";
        if (sid && !session(sid)) return bad("no such session", 404);
        if (!sid) {
          // A loop of its own: its runs go to a session made for it.
          const model = b.model || (await providers.defaultModel());
          if (!model) return bad("no model is available", 409);
          await providers.resolve(model);
          const s = store.createSession({ model, workspace: b.cwd || deps.workspace, title: `Loop: ${String(b.name || b.prompt || "").slice(0, 60)}` });
          deps.bus.emit({ t: "session", session: s });
          sid = s.id;
        }
        const r = loops.create({ session_id: sid, name: b.name, prompt: b.prompt, schedule: String(b.schedule ?? ""), max_runs: b.max_runs, until_ms: b.until_ms, created_by: "owner", signed: b.signed === undefined ? undefined : !!b.signed, min_interval_seconds: b.min_interval_seconds });
        return json({ ...r.loop, hook_key: r.hook_key, hook_secret: r.hook_secret }, 201);
      }),
    },
    "/api/loops/:id": {
      PATCH: (req: any) => attempt(async () => (loops.get(req.params.id) ? json(loops.update(req.params.id, await body(req))) : bad("no such loop", 404))),
      DELETE: (req: any) => (loops.remove(req.params.id) ? json({ ok: true }) : bad("no such loop", 404)),
    },
    "/api/loops/:id/run": {
      POST: (req: any) => attempt(() => (loops.get(req.params.id) ? json(loops.runNow(req.params.id)) : bad("no such loop", 404))),
    },
    "/api/loops/:id/runs": {
      GET: (req: any) => {
        const l = loops.get(req.params.id);
        return l ? json({ loop: l, runs: loops.runs(l.id) }) : bad("no such loop", 404);
      },
    },
    "/api/loops/:id/expiry": {
      POST: (req: any) => attempt(async () => (loops.get(req.params.id) ? json(loops.update(req.params.id, { until_ms: (await body(req)).until_ms ?? null })) : bad("no such loop", 404))),
    },
    "/api/loops/:id/hook-key": {
      POST: (req: any) => attempt(() => (loops.get(req.params.id) ? json(loops.rotateKey(req.params.id)) : bad("no such loop", 404))),
    },
    "/api/webhooks/:key": {
      POST: async (req: any) => {
        const text = await req.text();
        const r = loops.webhook(req.params.key, text, req.headers);
        return r.status === 200 ? json({ ok: true }) : bad(r.error ?? "refused", r.status);
      },
    },

    // --- alerts
    "/api/alerts": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return bad("limit is a number");
        return attempt(async () => json({
          alerts: alerts.list({ before: q.get("before") ?? undefined, limit, unread: q.has("unread"), withUnread: q.has("with_unread") }),
          unread: alerts.unreadCounts(),
        }));
      },
    },
    "/api/alerts/read": {
      POST: async (req: Request) => {
        const b = await body(req);
        const seen = b.seen === undefined || b.seen === null ? undefined : Number(b.seen);
        if (seen !== undefined && !Number.isFinite(seen)) return bad("seen is the inbox revision the page had");
        if (b.ids !== undefined && !Array.isArray(b.ids)) return bad("ids is a list of alert ids");
        const changed = alerts.markRead({ ids: b.ids, session_id: b.session_id, all: !b.ids && !b.session_id, seen, auto: !!b.auto });
        return json({ ok: true, changed, unread: alerts.unreadCounts() });
      },
    },
    "/api/alerts/:id/unread": {
      POST: (req: any) => {
        if (!alerts.markUnread(req.params.id)) return bad("no such alert", 404);
        return json({ ok: true, unread: alerts.unreadCounts() });
      },
    },
    // Where an alert leads, judged when the owner opens it: the agent session it
    // came from (or its own), the parent when that agent was deleted, and
    // whether its approval still waits.
    "/api/alerts/:id/target": {
      GET: (req: any) => {
        const a = alerts.get(req.params.id);
        return a ? json(alerts.alertTarget(a)) : bad("no such alert", 404);
      },
    },
    "/api/activity/:id/target": {
      GET: (req: any) => {
        const r = activity.get(req.params.id);
        return r ? json(alerts.target(r.session_id, r.data?.child_session)) : bad("no such activity", 404);
      },
    },
    // Sends again to the channels that failed for this alert, and only those.
    "/api/alerts/:id/retry": {
      POST: (req: any) => {
        const a = alerts.retry(req.params.id);
        return a ? json({ alert: a }) : bad("no such alert", 404);
      },
    },
    "/api/alerts/settings": {
      GET: () => json({ settings: alerts.settings(), channels: alerts.channelList(), kinds: alerts.KINDS }),
      PUT: (req: Request) => attempt(async () => json({ settings: alerts.saveSettings(await body(req)), channels: alerts.channelList() })),
    },
    "/api/alerts/test": {
      POST: async (req: Request) => {
        const b = await body(req);
        const a = alerts.raise((b.kind as alerts.AlertKind) ?? "agent", b.session_id ?? null, "Test alert", "This is how Keel reaches you.");
        return json({ alert: a, channels: alerts.channelList() });
      },
    },
    // --- goal and the shared task list
    "/api/sessions/:id/goal": {
      GET: (req: any) => (session(req.params.id) ? json({ goal: goals.get(req.params.id) ?? null, rev: deps.bus.rev() }) : bad("no such session", 404)),
      PUT: (req: any) => attempt(async () => json({ goal: await goals.set(req.params.id, await body(req)) })),
      PATCH: (req: any) => attempt(async () => json({ goal: await goals.patch(req.params.id, await body(req)) })),
      DELETE: (req: any) => (session(req.params.id) ? json({ ok: true, cleared: goals.clear(req.params.id) }) : bad("no such session", 404)),
    },
    "/api/sessions/:id/tasks": {
      GET: (req: any) => (session(req.params.id) ? json({ tasks: goals.tasks(req.params.id), rev: deps.bus.rev() }) : bad("no such session", 404)),
      POST: (req: any) => attempt(async () => {
        if (!session(req.params.id)) return bad("no such session", 404);
        return json({ task: goals.addTask(req.params.id, String((await body(req)).text ?? "")) }, 201);
      }),
    },
    "/api/sessions/:id/tasks/:tid": {
      PATCH: (req: any) => attempt(async () => json({ task: goals.editTask(req.params.id, req.params.tid, await body(req)) })),
      DELETE: (req: any) => (goals.removeTask(req.params.id, req.params.tid) ? json({ ok: true }) : bad("no such task", 404)),
    },
    // A task taken out into a session of its own, on this session's model and
    // folder. Once: a retry answers with the session it already has. A task
    // that was completed or cancelled meanwhile is not started (reopen it first).
    "/api/sessions/:id/tasks/:tid/start": {
      POST: (req: any) => attempt(async () => {
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        const t = goals.tasks(s.id).find((x) => x.id === req.params.tid);
        if (!t) return bad("no such task", 404);
        if (t.dest_session && session(t.dest_session)) return json({ session_id: t.dest_session, existing: true });
        if (t.status === "completed" || t.status === "cancelled") return json({ error: `the task is ${t.status === "completed" ? "done" : "cancelled"}; reopen it to start it`, status: t.status }, 409);
        let n = store.createSession({ model: s.model, workspace: s.workspace, title: t.text.slice(0, 80) });
        // Its folder is a folder of the machine the source's tools run on: the
        // new session's tools run there too, from its first prompt.
        if (s.machine) {
          store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run(s.machine, n.id);
          n = store.session(n.id)!;
        }
        goals.editTask(s.id, t.id, { status: "in_progress", dest_session: n.id });
        deps.bus.emit({ t: "session", session: n });
        deps.engine.send(n.id, `${t.text}\n\n(A task taken from the session "${s.title || "untitled"}".)`, { meta: { kind: "task_start", from_session: s.id, task_id: t.id } });
        return json({ session_id: n.id }, 201);
      }),
    },

    // --- advisor
    "/api/advisor": {
      GET: () => json({ model: consult.defaultAdvisor() }),
      PUT: (req: Request) => attempt(async () => {
        const b = await body(req);
        await consult.setDefault(b.model ? String(b.model) : null);
        return json({ model: consult.defaultAdvisor() });
      }),
    },
    "/api/sessions/:id/advisor": {
      GET: (req: any) => (session(req.params.id) ? json({ model: consult.advisorFor(req.params.id), own: consult.sessionAdvisor(req.params.id), default: consult.defaultAdvisor() }) : bad("no such session", 404)),
      PUT: (req: any) => attempt(async () => {
        if (!session(req.params.id)) return bad("no such session", 404);
        const b = await body(req);
        await consult.setForSession(req.params.id, b.model ? String(b.model) : null);
        return json({ model: consult.advisorFor(req.params.id), own: consult.sessionAdvisor(req.params.id), default: consult.defaultAdvisor() });
      }),
    },

    // --- snooze and activity
    "/api/sessions/:id/snooze": {
      PUT: (req: any) => attempt(async () => {
        const b = await body(req);
        const sn = snooze.set(req.params.id, { until_ms: b.until_ms, until_needed: !!b.until_needed }, alerts.hasOpenCard(req.params.id));
        alerts.markRead({ session_id: req.params.id });
        return json({ snooze: sn });
      }),
      DELETE: (req: any) => (session(req.params.id) ? json({ ok: true, ended: snooze.end(req.params.id, "the owner ended it") }) : bad("no such session", 404)),
    },
    "/api/snooze": {
      GET: () => json({ snooze: snooze.global() ?? null, sessions: snooze.all().filter((x) => x.session_id !== snooze.GLOBAL_ID) }),
      PUT: (req: Request) => attempt(async () => json({ snooze: snooze.setGlobal(Number((await body(req)).until_ms)) })),
      DELETE: () => {
        const g0 = snooze.global();
        const ended = snooze.end(snooze.GLOBAL_ID, "the owner ended it");
        if (g0?.muted) alerts.raise("snooze_over", null, "Alerts are back", `${g0.muted} alert${g0.muted > 1 ? "s" : ""} came while alerts were snoozed.`);
        return json({ ok: true, ended });
      },
    },
    "/api/activity": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return bad("limit is a number");
        const kinds = (q.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        const unknown = kinds.find((k) => !activity.ACTIVITY_KINDS.includes(k as activity.ActivityKind));
        if (unknown) return bad(`unknown kind ${unknown}; kinds: ${activity.ACTIVITY_KINDS.join(", ")}`);
        return attempt(async () => json({ ...activity.list({ before: q.get("before") ?? undefined, limit, kinds, session_id: q.get("session_id") ?? undefined, q: q.get("q") ?? undefined }), kinds: activity.ACTIVITY_KINDS }));
      },
    },
    // The sessions the activity filter offers: those with activity, newest first.
    "/api/activity/sessions": { GET: () => json({ sessions: activity.sessions() }) },
    "/api/presence": {
      POST: async (req: Request) => {
        const b = await body(req);
        alerts.setPresence(b.session_id ?? null, !!b.focused, typeof b.page === "string" ? b.page.slice(0, 64) : undefined);
        return json({ ok: true });
      },
    },
  };
};

export { alerts };
