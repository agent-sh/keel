import { awakeHolds, awakeReasons, recheckAwake } from "../admin/awake.ts";
import { registerHooks } from "../engine/hooks.ts";
import type { Deps, RouteModule } from "../server/app.ts";
import { registerShared } from "../tools/registry.ts";
import * as activity from "./activity.ts";
import * as consult from "./consult.ts";
import * as goals from "./goals.ts";
import * as agents from "./agents.ts";
import * as alerts from "./alerts.ts";
import * as snooze from "./snooze.ts";
import { afterTurn, capture, D, hasPending, setDeps } from "./core.ts";
import * as loops from "./loops.ts";
import { parseLoopCommand } from "./schedule.ts";
import { automationTools, extendTaskStop } from "./tools.ts";
import * as waits from "./waits.ts";
import { runMode } from "../core/runmode.ts";
import { namesOf } from "../integrations/hooks.ts";

// Subagents, waits, loops and alerts: tables, tools, turn hooks, the scheduler
// and the HTTP routes, joined to the daemon from this one module.

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (message: string, status = 400) => json({ error: message }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
const attempt = async (f: () => Promise<Response> | Response) => {
  try {
    return await f();
  } catch (e: any) {
    return bad(e.message, e.status ?? 400);
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
  registerShared(...automationTools, consult.advisorTool);
  extendTaskStop();

  registerHooks({
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
        alerts.openQuestions.add(s.id);
        alerts.raise("question", s.id, `Question: ${deps.store.session(s.id)?.title || "a session"}`, text, { call_id: call.id, open_session: s.id });
      }
      return undefined;
    },
    afterTool: (s, call) => {
      if (goals.isPlanTool(call.tool.name)) goals.fromPlanTool(s.id, call.tool.name, call.input);
      if (QUESTION_TOOLS.has(call.tool.name)) {
        alerts.openQuestions.delete(s.id);
        alerts.readWhere("call_id", call.id);
        // The answer to a question is the owner's word: it ends a snooze.
        snooze.end(deps.store.session(s.id)?.parent_id ?? s.id, "the owner answered");
      }
    },
    turnEnd: (s, reason) => {
      afterTurn(s.id, () => {
        const loopRun = loops.runOpenIn(s.id);
        loops.onTurnEnd(s.id, reason);
        agents.onTurnEnd(s.id, reason);
        const more = hasPending(s.id) || waits.activeFor(s.id) > 0 || agents.list(s.id).some((a) => !agents.isEnded(a));
        const child = !!deps.store.session(s.id)?.parent_id;
        if (!child) activity.record("turn", reason, s.id, `${deps.store.session(s.id)?.title || "Session"}: turn ${TURN_WORDS[reason] ?? `ended (${reason})`}`);
        alerts.onTurnEnd(s.id, reason, { subagent: child, loopRun, more });
        goals.tellModel(s.id);
        if (!child && !more) goals.afterTurn(s.id, reason).catch((e) => capture(e, { at: "goal" }));
      });
    },
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
      waits.recover();
      loops.recover();
      agents.recover();
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
        });
      },
    },

    // --- subagents
    "/api/agents": {
      GET: (req: Request) => json({ agents: agents.definitions(new URL(req.url).searchParams.get("cwd") || deps.workspace) }),
    },
    "/api/sessions/:id/agents": {
      GET: (req: any) => (session(req.params.id) ? json({ agents: agents.list(req.params.id), limit: agents.MAX_LIVE }) : bad("no such session", 404)),
    },
    "/api/sessions/:id/agents/:agent_id/stop": {
      POST: (req: any) => {
        if (!session(req.params.id)) return bad("no such session", 404);
        const a = agents.get(req.params.agent_id);
        if (!a || a.parent_id !== req.params.id) return bad("the session has no such agent");
        const was = a.status;
        agents.stop(a.id, "stopped by the owner");
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
      DELETE: (req: any) => (waits.cancel(req.params.id) ? json({ ok: true }) : bad("no such wait", 404)),
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
        return a ? json(alerts.target(a.session_id, a.data?.child_session ?? (a.data?.open_session !== a.session_id ? a.data?.open_session : undefined), a.data?.approval_id)) : bad("no such alert", 404);
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
      GET: (req: any) => (session(req.params.id) ? json({ goal: goals.get(req.params.id) ?? null }) : bad("no such session", 404)),
      PUT: (req: any) => attempt(async () => json({ goal: await goals.set(req.params.id, await body(req)) })),
      PATCH: (req: any) => attempt(async () => json({ goal: goals.patch(req.params.id, await body(req)) })),
      DELETE: (req: any) => (session(req.params.id) ? json({ ok: true, cleared: goals.clear(req.params.id) }) : bad("no such session", 404)),
    },
    "/api/sessions/:id/tasks": {
      GET: (req: any) => (session(req.params.id) ? json({ tasks: goals.tasks(req.params.id) }) : bad("no such session", 404)),
      POST: (req: any) => attempt(async () => {
        if (!session(req.params.id)) return bad("no such session", 404);
        return json({ task: goals.addTask(req.params.id, String((await body(req)).text ?? "")) }, 201);
      }),
    },
    "/api/sessions/:id/tasks/:tid": {
      PATCH: (req: any) => attempt(async () => json({ task: goals.editTask(req.params.id, req.params.tid, await body(req)) })),
      DELETE: (req: any) => (goals.removeTask(req.params.id, req.params.tid) ? json({ ok: true }) : bad("no such task", 404)),
    },
    // A task taken out into a session of its own, on this session's model and folder.
    "/api/sessions/:id/tasks/:tid/start": {
      POST: (req: any) => attempt(async () => {
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        const t = goals.tasks(s.id).find((x) => x.id === req.params.tid);
        if (!t) return bad("no such task", 404);
        const n = store.createSession({ model: s.model, workspace: s.workspace, title: t.text.slice(0, 80) });
        deps.bus.emit({ t: "session", session: n });
        deps.engine.send(n.id, `${t.text}\n\n(A task taken from the session "${s.title || "untitled"}".)`, { meta: { kind: "task_start", from_session: s.id } });
        goals.editTask(s.id, t.id, { status: "in_progress", text: `${t.text} (in its own session)` });
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
