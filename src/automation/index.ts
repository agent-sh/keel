import { zoned } from "../core/clock.ts";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { asksLess, isMode } from "../safety/policy.ts";
import { closedHow } from "../tools/interact.ts";
import * as leftovers from "./leftovers.ts";
import * as scopes from "./scopes.ts";
import { parseSince } from "../admin/timeline.ts";
import { sessionRef } from "../admin/session-ref.ts";
import { readsOf } from "../server/reads.ts";
import { awakeHolds, awakeReasons, recheckAwake } from "../admin/awake.ts";
import type { Judged } from "../safety/gate.ts";
import { registerHooks } from "../engine/hooks.ts";
import { stopKind } from "../core/stops.ts";
import { toMessages } from "../engine/turn.ts";
import type { Deps, RouteModule } from "../server/app.ts";
import { registerShared } from "../tools/registry.ts";
import { ownerSeen } from "../admin/away.ts";
import * as activity from "./activity.ts";
import * as incidents from "./incidents.ts";
import { lineOf, youOf, type Incident } from "./incident-book.ts";
import * as connection from "./connection.ts";
import * as consult from "./consult.ts";
import * as goals from "./goals.ts";
import * as taskOut from "./task-out.ts";
import * as taskRenames from "./task-renames.ts";
import * as writeAsks from "./write-asks.ts";
import * as agents from "./agents.ts";
import { maxDepth } from "../core/agent-tree.ts";
import * as alerts from "./alerts.ts";
import { waitCost } from "./wait-cost.ts";
import * as failures from "./failures.ts";
import * as outage from "./outage.ts";
import * as snooze from "./snooze.ts";
import * as undelivered from "./undelivered.ts";
import * as channels from "./channels.ts";
import { afterCallOff, afterTurn, capture, clip, D, flush, hasPending, setDeps, stopperOf } from "./core.ts";
import * as loops from "./loops.ts";
import { parseLoopCommand } from "./schedule.ts";
import { automationTools, extendTaskStop, messageHooks, waitAckHooks } from "./tools.ts";
import { verifierSession } from "./verify.ts";
import * as waits from "./waits.ts";
import * as silent from "./silent.ts";
import * as now from "./now.ts";
import * as lane from "./lane.ts";
import { liveAgents } from "./state.ts";
import { joinPulse } from "../core/pulse.ts";
import { runMode } from "../core/runmode.ts";
import { namesOf } from "../integrations/hooks.ts";
import { forwardedStanding, isLocal } from "../safety/presence.ts";
import { isWay } from "../engine/follow-up.ts";
import { spelled } from "../safety/chars.ts";
import { fromSaid, type AnsweredBy } from "../safety/card.ts";
import * as perm from "../server/routes/permissions.ts";
import { countedSince, countedSql } from "../core/agent-count.ts";
import { stopSays } from "../core/stoppers.ts";

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
const TURN_WORDS: Record<string, string> = { end_turn: "finished", error: "failed", interrupted: "stopped", max_tokens: "cut off at the output limit", refusal: "declined by the model", restart: "parked for a daemon stop" };
const QUESTION_TOOLS = new Set(["AskUserQuestion", "request_user_input", "ask_user"]);

function init(deps: Deps) {
  setDeps(deps);
  // What a parked session waits on, for its cache plan.
  deps.engine.waitShape = (id) => waits.shapeOf(id);
  // What a wait on the owner costs as it begins, kept with its alert (the next-look queue's key).
  alerts.waitHook.of = (id) => waitCost(id);
  agents.migrate();
  writeAsks.init();
  leftovers.migrate(deps.store);
  // What commands left running in their scopes, this daemon's and the one's before a restart: listed, and
  // stopped once their session ended and they idle (scopes.ts). Not in a command's own daemon.
  if (!runMode.client) scopes.start({
    spillRoot: join(deps.store.stateDir, "spill"),
    endedOf: (sid) => leftovers.endedOf(deps.store, sid),
    keeps: () => leftovers.keeps(deps.store),
    tell: (sid, line, key) => void leftovers.tellLeft(deps.store, sid, line, key, (to, l) => failures.seen(to, "tool", "left running", l)),
    loadIdle: () => leftovers.loadIdle(deps.store),
    saveIdle: (m) => leftovers.saveIdle(deps.store, m),
    refused: (file, why) => deps.errors.capture("tool", new Error(`A job scope was not taken over: ${why}. Nothing was signalled for it. The record: ${file}`), { at: "adopt scopes" }, { group: "a job scope was not taken over" }),
  });
  waits.migrate();
  loops.migrate();
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  consult.migrate();
  goals.migrate();
  silent.migrate();
  channels.migrate();
  failures.init();
  now.init();
  incidents.bind();
  outage.bind();
  // A called-off restart checks the goal turns its drain put off.
  afterCallOff.splice(0, afterCallOff.length, () => goals.recheckOwed());
  registerShared(...automationTools, consult.advisorTool);
  extendTaskStop();

  registerHooks(waitAckHooks);
  registerHooks(messageHooks);
  registerHooks(failures.hooks);
  registerHooks({
    // The owner's task-list edits since the last request, as one note.
    beforeRequest: (s, req) => {
      if (req.purpose !== "turn" || !goals.tellModel(s.id)) return req;
      taskRenames.told(s.id);
      return { ...req, messages: toMessages(deps.store.lineage(s.id)) };
    },
    // The owner's agent types are their side of the block (hooks.ts SystemBlock).
    system: (s) => {
      const lines = agents.definitions(s.workspace).filter((d) => d.source !== "built-in").map((d) => `- ${d.name}: ${d.description}`).join("\n");
      return { name: "Agent types you can start besides the built-ins", data: lines, text: lines ? `Agent types you can start besides the built-ins:\n${lines}` : "" };
    },
    beforeTool: async (s, call) => {
      const target = call.tool.target && agents.byChild(s.id) ? await call.tool.target(call.input, s.id) : null;
      const name = target?.name ?? call.tool.name;
      const why = agents.gate(s.id, call.tool.name, call.input, namesOf(name, target ? target.input : call.input, call.tool.name));
      if (why) return { deny: why };
      // A question the model asks the owner is an alert until it is answered.
      // (Asked again after a daemon restart, it is the same question: no second alert.)
      if (QUESTION_TOOLS.has(call.tool.name) && !alerts.raisedFor("call_id", call.id, s.id)) {
        const q = (call.input?.questions ?? [])[0];
        const text = String(q?.question ?? call.input?.question ?? call.input?.prompt ?? "The agent asks a question.");
        alerts.raise("question", s.id, `Question: ${deps.store.session(s.id)?.title || "a session"}`, text, { call_id: call.id, open_session: s.id });
      }
      return undefined;
    },
    afterTool: (s, call, result) => {
      // A write that leaves the agent's own MEMORY.md past what its next start reads is told with the call's result.
      if (call.tool.kind === "edit" && !result.is_error) {
        const over = agents.memoryWrite(s.id, call.tool, call.input);
        if (over) {
          if (typeof result.content === "string") result.content = result.content ? `${result.content}\n\n${over}` : over;
          else result.content = [...result.content, { type: "text", text: over }];
        }
      }
      // A plan the tool refused is not the plan: the saved list stays as it was.
      if (goals.isPlanTool(call.tool.name) && !result.is_error) taskRenames.fromPlan(s.id, call.tool.name, call.input);
      if (QUESTION_TOOLS.has(call.tool.name)) {
        alerts.keepOutcome("call_id", call.id, s.id, closedHow(s.id, call.id) ?? (result.is_error ? "not answered" : "answered"));
        alerts.readWhere("call_id", call.id, s.id);
        // The answer to a question is the owner's word: it ends a snooze.
        snooze.end(deps.store.session(s.id)?.parent_id ?? s.id, "the owner answered");
      }
    },
    // A question whose turn was stopped while it waited was not answered: said so with its alert, as an
    // answer is (afterTool does not run for a stopped call). Only a call whose question the stop closed
    // (the model's own, or a server's on any tool) is looked up. A call a restart cut is asked again on
    // its card, and one that could not be is an expiry with an alert of its own.
    toolRan: (s, call, result, ran) => {
      if (ran.outcome === "interrupted" && stopKind(result.content) === "stopped" && closedHow(s.id, call.id) === "not answered") alerts.keepOutcome("call_id", call.id, s.id, "not answered", true);
    },
    // A question a server asked on a call's card is an alert like the model's own.
    // (One alert per question: a call's server can ask more than one.)
    ownerAsked: (sessionId, callId, text, askId) => {
      if (!alerts.raisedFor("ask_id", askId, sessionId)) alerts.raise("question", sessionId, `Question: ${deps.store.session(sessionId)?.title || "a session"}`, text, { call_id: callId, open_session: sessionId, ask_id: askId });
    },
    ownerAnswered: (sessionId, _callId, answered, askId) => {
      alerts.keepOutcome("ask_id", askId, sessionId, answered ? "answered" : "declined");
      alerts.readWhere("ask_id", askId, sessionId);
      if (answered) snooze.end(deps.store.session(sessionId)?.parent_id ?? sessionId, "the owner answered");
    },
    inputDropped: (rows, why, session) => undelivered.inputDropped(rows, why, session),
    // It stays: what was kept back goes (flush drops it for one that is gone or archived).
    closingOver: (id) => flush(id),
    turnStart: (s) => agents.onTurnStart(s.id),
    // An agent whose budget is spent writes its report in one more step (src/automation/budget.ts).
    budget: (s) => (s.parent_id ? agents.budgetSpent(s.id) : undefined),
    cutTurn: (s, cut) => agents.onCutTurn(s.id, cut),
    cutTurnHeld: (s, why) => { agents.onCutTurnHeld(s.id, why); loops.onCutTurnHeld(s.id, why); },
    turnEnd: (s, reason) => {
      // Named now: by the time the row is written the turn is over.
      const turn = deps.engine.turnOf(s.id);
      afterTurn(s.id, () => {
        // First: an incident this failure makes or is part of takes the alerts the rest would raise.
        incidents.onTurnEnd(s.id, reason);
        const loopRun = loops.runOpenIn(s.id);
        failures.onTurnEnd(s.id, reason);
        // A notice held back while the owner had stopped the session goes after the owner's next turn.
        failures.wake(s.id);
        // What the end sets off is this turn's: a loop run's outcome, an agent it settles.
        activity.ofTurn(s.id, turn, () => { loops.onTurnEnd(s.id, reason); agents.onTurnEnd(s.id, reason); });
        // A session whose agents still work has not finished: its alert waits
        // for their reports (they start its next turn, whose end tells).
        const more = hasPending(s.id) || waits.activeFor(s.id) > 0 || liveAgents(s.id) > 0;
        const child = !!deps.store.session(s.id)?.parent_id;
        if (!child) activity.record("turn", reason, s.id, `${deps.store.session(s.id)?.title || "Session"}: turn ${reason === "interrupted" ? stopSays(stopperOf(s.id)) : TURN_WORDS[reason] ?? `ended (${reason})`}`, undefined, turn);
        // A question this turn asked whose card went with it (the turn was stopped) waits on nobody. (A turn parked for a restart keeps its card.)
        if (reason !== "restart") alerts.settleAsks(s.id);
        activity.ofTurn(s.id, turn, () => alerts.onTurnEnd(s.id, reason, { subagent: child, loopRun, more }));
        if (!child) goals.afterTurn(s.id, reason, { judge: !more, turn }).catch((e) => capture(e, { at: "goal" }));
      });
    },
  });

  // A deleted session's remembered renames go with it, and what was lined up for it or owed to it.
  deps.bus.on((f) => {
    if (f.t !== "session" || !f.deleted) return;
    taskRenames.told(f.session.id);
    agents.onSessionDeleted(f.session.id);
  });

  // An archived session reads nothing more: what others sent it is told to them as not delivered.
  deps.bus.on((f) => { if (f.t === "session" && !f.deleted && f.session.archived) try { undelivered.onArchived(f.session); } catch (e) { capture(e, { at: "undelivered message", session: f.session.id }); } });

  // A goal's verifier archived or deleted while its verification waits on it: the verification ends there.
  deps.bus.on((f) => { if (f.t === "session") verifierSession(f.session, !!f.deleted); });

  // An agent that made no progress past the stuck limit is told to its parent, once (silent.ts).
  deps.bus.on((f) => { if (f.t === "feature" && f.name === "state" && f.session_id) silent.onState(f.session_id, f.data); });

  // A hold that ended with no turn sends what it held (agents.onQueue).
  deps.bus.on((f) => { if (f.t === "queue") agents.onQueue(f); });

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
    // A failed agent reaches the owner: one alert a cause a parent (alerts.agentsFailed).
    if (a.status === "failed") alerts.agentsFailed(a);
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
    } else if (!s.archived && archived.delete(s.id)) {
      agents.deliverOwed(s.id);
      // A prompt its queue was owed a start for when it was archived starts now, not at some later restart.
      deps.engine.startOwed(s.id);
    }
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
    // A high-risk call settled without the owner (Full auto runs it unreviewed;
    // Auto's judge decides): each is an activity row; a refusal is a quiet alert (the inbox, never a desktop or
    // phone interruption), except a repeat of one already raised.
    if (f.t === "feature" && f.name === "judged") {
      const j = f.data as Judged;
      incidents.onJudged(j);
      const ran = j.outcome === "rule" || j.outcome === "judge" || j.outcome === "retry" || j.outcome === "unreviewed";
      activity.record("approval", ran ? (j.outcome === "unreviewed" ? "ran unreviewed (Full auto)" : `allowed by ${j.outcome === "rule" ? "a rule" : j.outcome === "judge" ? "the judge" : "a retry"}`) : j.outcome === "repeat" ? "refused again" : "refused", j.session_id, `${j.tool}: ${spelled(j.summary)}`.slice(0, 300) + ` (${j.reason})`.slice(0, 300), { call_id: j.call_id, blocked_id: j.blocked_id, model: j.model, ms: j.ms });
      if (!ran && j.outcome !== "repeat") {
        const s = deps.store.session(j.session_id);
        alerts.raise("refused", j.session_id, `Refused in ${s?.title || "a session"}`, `${j.tool}: ${spelled(j.summary)}`.slice(0, 200) + ` (${j.reason})`.slice(0, 300), { blocked_id: j.blocked_id, open_session: j.session_id });
      }
      return;
    }
    // A plan presented for approval waits on the owner like a question: an alert until it is answered.
    if (f.t === "feature" && f.name === "plan") {
      const { card, state } = f.data as { card: { id: string; session_id: string; title?: string; plan: string }; state: "open" | "closed" };
      // (Put back on its card after a daemon restart, it is the same plan: no second alert,
      // and a daemon that stops under the card does not read the alert for the owner.)
      if (state === "open") {
        if (alerts.raisedFor("plan_id", card.id, card.session_id)) return;
        const first = card.plan.split("\n").find((l) => l.trim())?.replace(/^[#\s>*-]+/, "") ?? "";
        alerts.raise("question", card.session_id, `Plan to approve: ${deps.store.session(card.session_id)?.title || "a session"}`, clip(card.title || first || "The model presents its plan.", 300), { plan_id: card.id, open_session: card.session_id });
      } else if (!deps.engine.isDraining?.()) alerts.readWhere("plan_id", card.id, card.session_id);
      return;
    }
    // A secret the model asks the owner to give waits on them like a question: an alert until it is given or let go.
    if (f.t === "feature" && f.name === "secret") {
      const { request: r, state } = f.data as { request?: { id: string; session_id: string; name: string; purpose?: string }; state?: "open" | "closed" };
      if (!r) return;
      if (state === "open") {
        if (!alerts.raisedFor("secret_id", r.id, r.session_id)) alerts.raise("question", r.session_id, `Secret to give: ${deps.store.session(r.session_id)?.title || "a session"}`, clip(r.purpose ? `${r.name}: ${r.purpose}` : r.name, 300), { secret_id: r.id, open_session: r.session_id });
      } else if (!deps.engine.isDraining?.()) alerts.readWhere("secret_id", r.id);
      return;
    }
    if (f.t !== "feature" || f.name !== "approval") return;
    const a = f.data as { id: string; session_id: string; tool: string; summary: string; risk: string; state: string; by?: AnsweredBy };
    if (a.state === "pending") {
      const s = deps.store.session(a.session_id);
      // The line a notification shows: the tool, where it runs when that is not here, then the text
      // with each hidden character written out. `hold`: why the request is opened before it is
      // allowed; `glance`: a collapsed notification shows all of the line, so it may carry Allow once.
      const card = perm.gate?.approval(a.id);
      const form = card ? perm.gate!.form(card) : undefined;
      alerts.raise("approval", a.session_id, `Approval: ${s?.title || "a session"}`, form?.line ?? `${a.tool}: ${spelled(a.summary)}`.slice(0, 500), { approval_id: a.id, open_session: a.session_id, risk: a.risk, ...(form ? { hold: form.hold, glance: form.glance } : {}) });
    } else {
      alerts.readWhere("approval_id", a.id);
      // (Where the owner answered it: "allowed from the phone (Pixel)". A card a grant or a stop closed has no such place.)
      // (The text with each hidden character written out: one that reorders would mix the words after it into the command.)
      activity.record("approval", a.state, a.session_id, `${a.tool}: ${spelled(a.summary)}`.slice(0, 300) + ` (${a.state}${a.by && a.state !== "cancelled" ? ` from ${fromSaid(a.by)}` : ""})`, { approval_id: a.id });
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
      writeAsks.recover();
      failures.recover();
      goals.recover();
    } catch (e) {
      capture(e, { at: "recover" });
    }
    process.on("exit", () => waits.stopAll());
  }

  // One pass a second while the daemon works, on its one tick (src/core/pulse.ts). While it is idle the
  // pass comes when something is due (a wait's next probe, a timer, a loop's next run, the end of a
  // snooze) and every ten seconds at the latest; what is scheduled through a request or a turn wakes the tick.
  g.__keelAutomationLeave?.();
  g.__keelAutomationLeave = joinPulse("automation", () => {
    // A notification held back while the owner attended its session goes out when they no longer do.
    alerts.tickWithheld();
    // Most passes find nothing active: one indexed query says so and the
    // pass ends there (each step below would find nothing to do).
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
  }, { every: 1000, due: (now) => nextDue(deps, now) });
}

// When the next pass has something to do, for the tick's sleep while the daemon is idle: the first of
// the active waits' next times, the loops' next runs, the snoozes' ends and the next look at a notification that was held back. Nothing: nothing is
// scheduled (agents' time limits are minutes, and are looked at with the tick's longest sleep).
export function nextDue(deps: Deps, now: number): number | undefined {
  const r = deps.store.db.query<{ waits: number; loop: number | null; snooze: number | null }, []>(`SELECT
    EXISTS (SELECT 1 FROM waits WHERE status = 'active') AS waits,
    (SELECT MIN(next_ms) FROM loops WHERE enabled = 1 AND next_ms IS NOT NULL) AS loop,
    (SELECT MIN(until_ms) FROM snoozes WHERE until_ms IS NOT NULL) AS snooze`).get();
  const times = [r?.waits ? waits.nextDue(now) : undefined, r?.loop ?? undefined, r?.snooze ?? undefined, alerts.withheldDue()].filter((t): t is number => typeof t === "number");
  return times.length ? Math.min(...times) : undefined;
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
  const leftCtx = () => ({ store, isRunning: (sid: string) => deps.engine.isRunning(sid), workspace: deps.workspace });
  const opt = (v: unknown) => (typeof v === "string" ? v : undefined);
  const treeSeen = (b: any): leftovers.TreeSeen => ({ repo: String(b?.repo ?? ""), path: String(b?.path ?? ""), head: opt(b?.head), ignored: Number(b?.ignored) || 0 });
  const branchSeen = (b: any): leftovers.BranchSeen => ({ repo: String(b?.repo ?? ""), branch: String(b?.branch ?? ""), sha: opt(b?.sha) });

  return {
    "/api/automation": {
      GET: () => {
        const db = store.db;
        // The agents every count names (src/core/agent-count.ts): live, or of the last day; and
        // the agents above a live one, so the page's tree reaches it (it counts only the counted).
        const agentRows = db.query<{ id: string }, [number]>(`WITH RECURSIVE up(sid, n) AS (
          SELECT parent_id, 0 FROM agents WHERE status IN ('running', 'waiting')
          UNION SELECT a.parent_id, up.n + 1 FROM agents a JOIN up ON a.session_id = up.sid WHERE up.n < 32
        ) SELECT id FROM agents WHERE ${countedSql("agents", "?1")} OR session_id IN (SELECT sid FROM up) ORDER BY created`).all(countedSince());
        return json({
          // Without their reports: a card that opens reads its agent's (/api/sessions/:id/agents/:agent_id/report).
          // A live agent's "now" line with it (src/automation/now.ts); frames bring the next ones.
          agents: agentRows.map((r) => agents.get(r.id)).filter((a) => !!a).map((a) => ({ ...agents.brief(a), ...(agents.isEnded(a) ? {} : { now: now.lineOf(a.session_id) }) })),
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

    // What the live agents below a session are doing now (one line each), or, with no session,
    // what making the lines has cost since the daemon started (for the measure of src/automation/now.ts).
    "/api/automation/now": {
      GET: (req: Request) => {
        const sid = new URL(req.url).searchParams.get("session");
        if (!sid) return json({ stats: now.nowStats });
        if (!session(sid)) return bad("no such session", 404);
        return json({ lines: now.linesOf(sid), text: now.statusText(sid) });
      },
    },
    // An agent's lane in five lines (src/automation/lane.ts): doing, waits for, went wrong, changed, next.
    "/api/automation/agents/:id/lane": {
      GET: async (req: any) => {
        const l = await lane.laneOf(req.params.id);
        return l ? json(l) : bad("no such agent", 404);
      },
    },
    // --- subagents
    "/api/agents": {
      GET: (req: Request) => json({ agents: agents.definitions(new URL(req.url).searchParams.get("cwd") || deps.workspace) }),
    },
    "/api/sessions/:id/agents": {
      GET: (req: any) => {
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        // `agents`: its own; `tree`: every agent below it, each after the one that started it, with its
        // depth under this session; `limit`: the live agents its whole tree may have (its root's);
        // `slots`: how many of the tree's agents work (each holds a slot), wait on a wait of their own (none), and wait in line for one.
        const rows = agents.tree(s.id);
        return json({ agents: agents.list(s.id), tree: rows.map((r) => ({ ...r.agent, depth: r.depth, below: r.below })), now: now.linesOf(s.id), limit: agents.limitOf(s.id), root: agents.rootSession(s.id), depth: agents.depthIn(s.id), max_depth: maxDepth(),
          ...(s.parent_id ? {} : { default_limit: agents.DEFAULT_LIMIT, own_limit: agents.ownLimit(s.id), slots: agents.slotsOf(s.id) }) });
      },
      PATCH: async (req: any) => {
        // Fleet forwarding arrives on loopback; it cannot change the host's limit.
        if (!isLocal(req) || forwardedStanding(req)) return bad("change this limit from the daemon's own desk", 403);
        const { limit } = await body(req);
        if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) return bad("limit must be a positive integer or null to use the daemon default");
        const s = session(req.params.id);
        if (!s) return bad("no such session", 404);
        if (s.parent_id) return bad("an agent's limit is its root session's: change it there", 409);
        agents.setLimit(s.id, limit);
        return json({ limit: agents.limitOf(s.id), own_limit: agents.ownLimit(s.id), slots: agents.slotsOf(s.id) });
      },
    },
    // One agent's report, read when its card is opened (the list and the frames leave it out).
    "/api/sessions/:id/agents/:agent_id/report": {
      GET: (req: any) => {
        const a = agents.get(req.params.agent_id);
        if (!a || a.parent_id !== req.params.id) return bad("the session has no such agent", 404);
        return json({ id: a.id, status: a.status, report: a.result ?? null });
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
        // `client_id`: the page's name for this send; the same one again sends nothing.
        const key = typeof b.client_id === "string" && b.client_id.trim() ? `page:${b.client_id.trim().slice(0, 80)}` : undefined;
        const r = await agents.send(a.id, String(b.message), !!b.interrupt, key);
        return json({ agent: r.agent, waits: r.waits, ...(r.held ? { held: true } : {}), ...(r.duplicate ? { replayed: true } : {}), ...(r.start ? { start: r.start } : {}) });
      }),
    },
    // The owner's choice of where this agent's follow-ups start: carry (its
    // context), summary, capsule, or auto (Keel decides by price).
    "/api/sessions/:id/agents/:agent_id/start": {
      PUT: (req: any) => attempt(async () => {
        const a = agents.get(req.params.agent_id);
        if (!a || a.parent_id !== req.params.id) return bad("the session has no such agent", 404);
        const b = await body(req);
        const force = b.force === "auto" || b.force === null ? null : b.force;
        if (force !== null && !isWay(force)) return bad("force is one of auto, carry, summary, capsule");
        const now = agents.setStartForce(a.id, force);
        return json({ agent: now ? agents.brief(now) : null });
      }),
    },
    "/api/sessions/:id/background": {
      GET: (req: any) => (session(req.params.id) ? json(background(req.params.id)) : bad("no such session", 404)),
    },

    // --- what is left behind across sessions (leftovers.ts): commands still running, worktrees and branches no
    // live session holds. Each act is the owner's, one item at a time, checked again before it is made.
    "/api/leftovers": {
      GET: () => attempt(async () => json(await leftovers.survey(leftCtx()))),
    },
    "/api/leftovers/stop": {
      POST: (req: any) => attempt(async () => { const b = await body(req); return json(await leftovers.stopLeft(String(b.session_id ?? ""), String(b.job_id ?? ""), store)); }),
    },
    // The owner's mark on a command left running: `keep` true keeps its scope from being stopped by Keel.
    "/api/leftovers/keep": {
      POST: (req: any) => attempt(async () => { const b = await body(req); return json(leftovers.keepLeft(store, String(b.session_id ?? ""), String(b.job_id ?? ""), b.keep !== false)); }),
    },
    // Each names the item as it was listed (a worktree's HEAD and ignored count, a branch's tip): one that changed since is refused.
    "/api/leftovers/worktree/remove": {
      POST: (req: any) => attempt(async () => { const b = await body(req); await leftovers.removeTree(leftCtx(), treeSeen(b)); return json({ removed: true }); }),
    },
    "/api/leftovers/branch/delete": {
      POST: (req: any) => attempt(async () => { const b = await body(req); await leftovers.deleteBranch(leftCtx(), branchSeen(b)); return json({ deleted: true }); }),
    },
    "/api/leftovers/remove-all": {
      POST: (req: any) => attempt(async () => {
        const b = await body(req);
        const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 500) : []);
        return json(await leftovers.removeAll(leftCtx(), { worktrees: list(b.worktrees).map(treeSeen), branches: list(b.branches).map(branchSeen) }));
      }),
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
        return json(waits.create(s.id, spec, { timeout_seconds: b.timeout_seconds, note: b.note, by: "owner" }), 201);
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
        if (b.mode !== undefined && !isMode(b.mode)) return bad(`unknown mode: ${b.mode}`);
        if (b.mode !== undefined && sid) return bad("mode is for a loop of its own: a session's loop runs in the session's mode");
        if ((b.model !== undefined || b.effort !== undefined) && sid) return bad("model and effort are for a loop of its own: a session's loop runs on the session's");
        if (!sid) {
          // A loop of its own: its runs go to a session made for it, in the folder and the
          // permission mode it is made with (the owner's default mode when none is named).
          const workspace = resolve(String(b.cwd || deps.workspace));
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return bad(`not a directory: ${workspace}`);
          const def = perm.gate?.defaultMode();
          // A mode that asks less than the default is a loosening: from a remote device it needs the owner's passkey.
          if (b.mode && def && asksLess(b.mode, def) && perm.presence && !perm.presence.allows(req, "perm:new-loop")) {
            return json({ error: "this needs your passkey from a remote device", presence: { action: "perm:new-loop" } }, 428);
          }
          const model = b.model || (await providers.defaultModel());
          if (!model) return bad("no model is available", 409);
          const { info } = await providers.resolve(model);
          // An effort is one the model lists; none is the model's default.
          const effort = b.effort ? String(b.effort) : undefined;
          if (effort && !info.efforts.includes(effort)) return bad(`${info.name} does not take effort ${effort}`);
          const s = store.createSession({ model, workspace, title: `Loop: ${String(b.name || b.prompt || "").slice(0, 60)}`, ...(effort ? { settings: { effort } } : {}) });
          if (b.mode && perm.gate) perm.gate.setPerm(s.id, { mode: b.mode });
          deps.bus.emit({ t: "session", session: s });
          sid = s.id;
        }
        const r = loops.create({ session_id: sid, name: b.name, prompt: b.prompt, schedule: String(b.schedule ?? ""), max_runs: b.max_runs, until_ms: b.until_ms, tz: b.tz, created_by: "owner", signed: b.signed === undefined ? undefined : !!b.signed, min_interval_seconds: b.min_interval_seconds, push: b.push === true });
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
        if (r.status !== 200) return bad(r.error ?? "refused", r.status);
        // A push loop's sender is told what became of its event: taken, waiting behind the owner's stop, a duplicate.
        if (r.pushed) {
          const p = await r.pushed;
          const o = p.outcomes[0]!;
          return o.state === "refused" ? json({ ok: false, state: o.state, error: o.reason }, o.reason?.includes("in a minute") ? 429 : 409) : json({ ok: true, state: o.state });
        }
        return json({ ok: true });
      },
    },

    // --- incidents: one row a cause across sessions, open and cleared in the last day (src/automation/incidents.ts).
    //   format=text: a line each, for a terminal or a model.
    "/api/incidents": {
      GET: (req: Request) => attempt(async () => {
        const l = incidents.listed();
        if (new URL(req.url).searchParams.get("format") !== "text") return json(l);
        const z = zoned();
        const line = (i: Incident) => `  ${z.time(i.since)}${i.cleared ? `-${z.time(i.cleared)}` : ""}  ${lineOf(i)}${i.cleared ? "" : ` ${youOf(i)}`}`;
        const text = [`Incidents, newest first. ${z.note}.`, l.open.length ? "Open:" : "Nothing is open.", ...l.open.map(line), ...(l.cleared.length ? ["Cleared in the last day:", ...l.cleared.map(line)] : [])].join("\n");
        return new Response(`${text}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }),
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
        const changed = alerts.markRead({ ids: b.ids, session_id: b.session_id, all: !b.ids && !b.session_id, seen, auto: !!b.auto, touch: !!b.touch });
        return json({ ok: true, changed, unread: alerts.unreadCounts() });
      },
    },
    "/api/alerts/:id/unread": {
      POST: (req: any) => {
        if (!alerts.markUnread(req.params.id)) return bad("no such alert", 404);
        return json({ ok: true, unread: alerts.unreadCounts() });
      },
    },
    // The owner marks a session unread to come back to it; and what a session last said, for a
    // list that shows one it has not opened.
    "/api/sessions/:id/unread": {
      POST: (req: any) => (alerts.markSessionUnread(req.params.id) ? json({ ok: true, unread: alerts.unreadCounts() }) : bad("no such session, or an agent's session (its marks are its parent's)", 404)),
    },
    "/api/sessions/:id/last-line": {
      GET: (req: any) => (session(req.params.id) ? json(alerts.lastLine(req.params.id)) : bad("no such session", 404)),
    },
    // Where an alert leads, judged when the owner opens it: the agent session it
    // came from (or its own), the parent when that agent was deleted, and
    // whether its approval still waits.
    "/api/alerts/:id/target": {
      GET: async (req: any) => {
        const a = alerts.get(req.params.id);
        return a ? json(await alerts.alertTargetNow(a)) : bad("no such alert", 404);
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
      // gone: the destinations of its rows that the daemon no longer has (deleted), so
      // a page offers no dead link and never takes one it merely does not list for deleted.
      GET: (req: any) => {
        if (!session(req.params.id)) return bad("no such session", 404);
        const tasks = goals.tasks(req.params.id);
        return json({ tasks, gone: tasks.flatMap((t) => (t.dest_session && !session(t.dest_session) ? [t.dest_session] : [])), rev: deps.bus.rev() });
      },
      POST: (req: any) => attempt(async () => {
        if (!session(req.params.id)) return bad("no such session", 404);
        return json({ task: goals.addTask(req.params.id, String((await body(req)).text ?? "")) }, 201);
      }),
    },
    "/api/sessions/:id/tasks/:tid": {
      PATCH: (req: any) => attempt(async () => json({ task: taskRenames.edit(req.params.id, req.params.tid, await body(req)) })),
      DELETE: (req: any) => (goals.removeTask(req.params.id, req.params.tid) ? json({ ok: true }) : bad("no such task", 404)),
    },
    // A task taken out into a session of its own (task-out.ts).
    "/api/sessions/:id/tasks/:tid/start": {
      POST: (req: any) => attempt(async () => {
        const r = taskOut.start(req.params.id, req.params.tid);
        return json(r.body, r.status);
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
    // GET /api/activity?kind=&session_id=&q=&since=&until=&only=failures&cap=&before=&limit=&format=text
    //   since, until: a span back from now (90s, 30m, 1h, 2d), epoch milliseconds or an ISO time.
    //   only=failures: what went wrong. cap: at most that many rows a session in a list across sessions
    //   (the last one shown says how many more). One row a turn: the alert a turn's end raised is on the
    //   turn's row (`said`). format=text: a line a row, for a terminal or a model.
    "/api/activity": {
      GET: (req: Request) => {
        const q = new URL(req.url).searchParams;
        const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
        if (limit !== undefined && !Number.isFinite(limit)) return bad("limit is a number");
        const kinds = (q.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
        const unknown = kinds.find((k) => !activity.ACTIVITY_KINDS.includes(k as activity.ActivityKind));
        if (unknown) return bad(`unknown kind ${unknown}; kinds: ${activity.ACTIVITY_KINDS.join(", ")}`);
        const only = q.get("only");
        if (only && only !== "failures") return bad("only is failures");
        const cap = q.get("cap") ? Number(q.get("cap")) : undefined;
        if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) return bad("cap is a whole number of rows a session (0: no cap)");
        return attempt(async () => {
          const now = Date.now();
          const since = q.get("since") ? parseSince(q.get("since")!, now) : undefined;
          const until = q.get("until") ? parseSince(q.get("until")!, now) : undefined;
          const session_id = q.get("session_id") ? sessionRef(deps.store, q.get("session_id")!).id : undefined;
          const opts: activity.ListOpts = { before: q.get("before") ?? undefined, limit, kinds, session_id, q: q.get("q") ?? undefined, since, until, failures: only === "failures", cap };
          // Read off the loop: the cap is a window over every row of the range.
          const sql = activity.listSql(opts, now);
          const page = activity.listRows(await readsOf(deps.store).sql<any>(sql.sql, sql.args), sql.limit, session_id ? 0 : cap);
          if (q.get("format") !== "text") return json({ ...page, kinds: activity.ACTIVITY_KINDS });
          const what = [only ? "failures only" : "", session_id ? `in "${deps.store.session(session_id)?.title || session_id}"` : "", since !== undefined ? `since ${zoned(now).stamp(since)}` : ""].filter(Boolean).join(", ");
          const text = activity.activityText(page.items, { titleOf: (id) => deps.store.session(id)?.title, has_more: page.has_more, now, ids: q.get("ids") !== "0", what });
          return new Response(text + "\n", { headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
        });
      },
    },
    // The sessions the activity filter offers: those with activity, newest first.
    "/api/activity/sessions": { GET: () => json({ sessions: activity.sessions() }) },
    "/api/presence": {
      POST: async (req: Request) => {
        const b = await body(req);
        const shown = Array.isArray(b.shown) ? b.shown.filter((x: unknown): x is string => typeof x === "string").slice(0, 12) : [];
        alerts.setPresence(b.session_id ?? null, !!b.focused, typeof b.page === "string" ? b.page.slice(0, 64) : undefined, shown, typeof b.idle_ms === "number" && b.idle_ms >= 0 ? b.idle_ms : undefined);
        // The owner did something in that page this long ago: the end of an absence, if there was one.
        // A page that only has focus says nothing about where the owner is.
        if (typeof b.idle_ms === "number" && b.idle_ms >= 0) ownerSeen(b.idle_ms);
        return json({ ok: true });
      },
    },
    // A page was cut off and is back: kept where the owner can read it afterwards (connection.ts).
    "/api/connection": {
      POST: async (req: Request) => {
        const b = await body(req);
        return json({ ok: true, listed: connection.pageAbsence(Number(b.from), Number(b.to), String(b.why ?? "")) });
      },
    },
  };
};

export { alerts };
