import { localTime, zonedStamp, zoneLabel } from "../core/clock.ts";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.ts";
import type { TurnHooks } from "../engine/hooks.ts";
import { fail, ok } from "../tools/types.ts";
import * as writeAsks from "./write-asks.ts";
import * as agents from "./agents.ts";
import * as alerts from "./alerts.ts";
import * as loops from "./loops.ts";
import { toolsFor } from "../tools/registry.ts";
import { skillRun } from "../tools/skills.ts";
import { D, familyOf } from "./core.ts";
import { replyOf } from "../core/tree.ts";
import * as waits from "./waits.ts";
import { privateHost } from "../tools/web.ts";
import { heldSays } from "../core/stoppers.ts";
import { statusText } from "./now.ts";
import { existsSync } from "node:fs";
import { jobHasProcesses, jobPidsOf, jobsOf, processesOf, running, type Job } from "../tools/jobs.ts";
import { portsOf } from "../fleet/portal.ts";
import { isOwnPort } from "../safety/net-proxy.ts";
import { basename, dirname, join } from "node:path";

// Each family gets the names and shapes it was trained on: Claude the Claude
// Code tools (Agent, SendMessage, TaskStop, Monitor, ScheduleWakeup, Cron*,
// PushNotification), GPT the Codex multi-agent tools (spawn_agent, send_input,
// wait_agent, close_agent). Waits and schedules have no Codex counterpart, so
// the other families get plain snake_case names for them.

// What each tool is to the permission gate, by what it does:
// - readOnly: it only reads (the lists, wait_agent).
// - kind "own": it acts, but only on what Keel keeps for this session and its
//   tree: an agent it starts or messages never runs in a mode that asks less
//   than this session's (a child's own calls pass the gate in its session), a
//   wait or a wakeup of this session, a notice to the owner. It runs in every
//   mode with no card.
// - neither: it acts beyond the turn (CronCreate leaves a prompt that runs by
//   itself for 30 days, even after the mode changed), so it asks, is judged in
//   Auto and is refused in Read only and Plan. The monitor runs a command and
//   is judged as one.
const CLAUDE = ["claude"];
const OTHERS = ["gpt", "gemini", "other"];

const isChild = (ctx: ToolContext) => !!D().store.session(ctx.sessionId)?.parent_id;
const guard = async (f: () => Promise<ToolOutput> | ToolOutput): Promise<ToolOutput> => {
  try {
    return await f();
  } catch (e) {
    return fail((e as Error).message);
  }
};

function agentLine(a: agents.AgentRecord) {
  return `${a.id} · ${a.status} · ${a.type} · ${a.title}${a.api === "read" && !a.api_off ? " · reads the daemon's lists" : ""}`;
}

function waitResult(w: waits.WaitRecord, extra = "", again = false) {
  const when = w.kind === "timer" ? `at ${localTime((w.spec as any).at_ms)} ${zoneLabel((w.spec as any).at_ms)}` : `deadline in ${Math.round((w.deadline - Date.now()) / 1000)} s`;
  return ok(`${again ? `This ${w.kind} wait was set already: wait ${w.id} (${when}) waits for it, and no second one was set` : `Scheduled ${w.kind} wait ${w.id} (${when})`}. It costs no tokens while it waits; the session is woken when it fires, times out or is cancelled.${waits.carries(w)} End your turn now unless you have other work.${extra}`);
}

// --- subagents ---------------------------------------------------------------

// An agent on another machine of the fleet. Starting work there is the gate's
// call as keel__spawn_on_machine, and a standing answer covers one machine.
const MACHINE_PROPS = {
  machine: { type: "string", description: "Run the agent's tools on this machine of the fleet (a name from keel__machines_list). Omit to run where you run. Send it files with keel__send_files." },
  cwd: { type: "string", description: "With machine: the directory there, inside its granted directory (default: the granted directory)" },
};
// What a review agent reviews: the work board shows its verdict on that branch (src/board/board.ts).
const REVIEWS_PROP = {
  reviews: { type: "string", description: "For a review agent: the branch it reviews (several: separated by spaces). The work board shows its review on that branch: approved or refused only from its keel__verdict call (it is told to make one) or an output_schema answer with land per commit; a LAND line of its report alone shows as its words only. Without it, an agent counts as a branch's reviewer when its task names the branch or its head, or when it calls keel__verdict on a commit of the branch." },
};
// An agent runs at its parent's effort and speed unless the spawn says otherwise.
const PACE_PROP = {
  effort: { type: "string", description: "Reasoning effort for the agent, one the agent's model lists. Omit to use your own." },
  speed: { type: "string", description: "A speed the agent's model lists (its id), or standard. Omit to use your own when the model lists it; a speed it does not list is refused." },
};
// The owner's agent tiers (agents.tiers, src/engine/tiers.ts): a spawn that names no model starts on its tier.
const TIER_PROP = {
  tier: { type: "string", description: "Optional: a tier of the owner's agent tiers (Settings > Models), by its name or a task kind it lists, such as research. With no model named, the agent starts on the tier's model and effort; without tier, on the tier its type uses. The result says which tier and why." },
};
// A budget for the agent's task: when one limit is reached it gets one step with no tool run to
// write its report, and ends incomplete (ended="budget"); a message continues it.
const BUDGET_PROP = {
  budget: {
    type: "object",
    description: "Optional limits for the agent's task: when one is reached it writes its report in one more step, with no tool run, and ends incomplete; a message continues it with the budget counted again.",
    properties: {
      steps: { type: "integer", minimum: 1, description: "Model steps" },
      minutes: { type: "number", exclusiveMinimum: 0, description: "Minutes of wall time" },
      usd: { type: "number", exclusiveMinimum: 0, description: "Dollars of model spend, its own agents' included; refused on a model with no listed price" },
    },
  },
};
// The daemon's read-only lists for the agent's commands (src/automation/api-grant.ts): given only by a
// session whose own commands have them, never more than that.
const API_PROP = {
  api: { type: "string", enum: ["read"], description: "Optional: \"read\" lets the agent's commands GET the daemon's read-only lists through its HTTP API (sessions, their events, timeline and agents, errors, telemetry, resources), as yours can. Only a top-level session, or an agent granted it, can give it; its own agents get it only if it passes it. Writes and secrets stay refused." },
};
const WRITES_PROP = {
  writes: { type: "array", items: { type: "string" }, description: "Optional: the folders, files or globs the agent may write besides its own worktree and scratch (absolute, under ~, or relative to its folder). With it, a write elsewhere is refused and asks you once. An agent of a reviewer type (its type says review, verify or audit), and every agent a session with a scope of its own starts, has a scope even without it: its own folders, plus what this names within your own scope. With the sandbox on, the sandbox holds every write. With the sandbox off, only writes the command shows are held (a redirect, the files of a program that writes, the folder of a git command): what bash -c, python -c, a script, a path in a variable or a link made in the same command writes is not." },
};
const GRANT_PROP = {
  writes: { type: "array", items: { type: "string" }, description: "Optional: paths this agent may write from now on (your yes to its question about a write outside its scope; a folder covers what is under it)." },
};
const RESUME_BUDGET = {
  budget: { ...BUDGET_PROP.budget, description: "Optional new limits for the agent's task (steps, minutes, usd), counted from this message. A finished agent's budget counts again from this message either way." },
};
async function onMachine(input: any, prompt: unknown) {
  const m = typeof input?.machine === "string" ? input.machine.trim() : "";
  if (!m) return null;
  const isolation = input.isolation ?? "worktree";
  return {
    name: "keel__spawn_on_machine",
    readOnly: false,
    input: { machine: m, worktree: isolation === "worktree", cwd: input.cwd, prompt: String(prompt ?? "").slice(0, 400) },
    cls: { kind: "other" as const, grant: `keel__spawn_on_machine:${agents.machineKey(m)}` },
  };
}

const Agent: Tool = {
  name: "Agent",
  inputOptional: ["description"], // the agent is titled from its task without one
  urgent: "lost-agent-successor, agent-tiers", // a lost agent is started again by itself (src/automation/successor.ts): the parent must not start it by hand; a spawn with no model starts on the owner's tier (src/engine/tiers.ts)
  resultCap: agents.RESULT_CAP, // a report is cut to this by the agents' own code, never in its middle by the engine's smaller cap
  families: CLAUDE,
  readOnly: false, kind: "own",
  description:
    "Launch a subagent: a separate session with its own context that works on one task and returns a report. " +
    "Use it for independent work that can run beside yours, or a broad search whose file dumps you do not need. Send several Agent calls in one message to run them in parallel. " +
    "A fresh agent sees none of this conversation: the prompt must say everything it needs. subagent_type \"fork\" instead starts it with this whole conversation on your model (it reads your prompt cache), so the prompt only names its part. By default the call blocks until the agent reports; with run_in_background the call returns at once and the report arrives later as a message (do not poll it). " +
    "Types: general-purpose (all tools, default), Explore (read-only search); more may be listed in the system prompt. An agent may start agents of its own, three levels below the session at most; the session's agent limit counts every agent of the tree. " +
    "In a git repository an agent that can edit works in its own worktree on its own branch and commits there; its report names the branch to merge. isolation: \"none\" makes it edit your checkout instead. " +
    "output_schema (a JSON schema) makes its report one JSON value that matches it." +
    " An agent whose context is lost (the model declines, its context fills, its provider fails) is started again by itself with a fresh context from a capsule of its work, in the same worktree, at most twice: you get one line, then its report. Do not start it again yourself.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short (3-5 word) description of the task" },
      prompt: { type: "string", description: "The task for the agent to perform" },
      subagent_type: { type: "string", description: "The type of agent to use" },
      model: { type: "string", description: "Optional model override: a listed model id or a short name such as haiku or sonnet. Omit to use the owner's tier for the agent, else this session's model." },
      ...TIER_PROP,
      run_in_background: { type: "boolean", description: "Return at once; the report arrives later as a message" },
      isolation: { type: "string", enum: ["worktree", "none"], description: "worktree (the default for agents that edit, in a git repository): its own checkout and branch; none: it edits your checkout" },
      output_schema: { type: "object", description: "A JSON schema the report must match; the report is then that JSON value" },
      ...WRITES_PROP,
      ...REVIEWS_PROP,
      ...API_PROP,
      ...PACE_PROP,
      ...BUDGET_PROP,
      ...MACHINE_PROPS,
    },
    required: ["description", "prompt"],
  },
  target: (input) => onMachine(input, input.prompt),
  run: (input, ctx) => guard(async () => {
    const fork = String(input.subagent_type ?? "").toLowerCase() === "fork";
    const spawn = () => agents.spawn(ctx.sessionId, { title: input.description, prompt: input.prompt, type: fork ? undefined : input.subagent_type, fork, model: input.model, tier: typeof input.tier === "string" ? input.tier : undefined, background: !!input.run_in_background, isolation: input.isolation, output_schema: input.output_schema, budget: input.budget, machine: input.machine, cwd: input.cwd, call_id: ctx.callId, writes: input.writes, reviews: input.reviews, api: input.api, effort: typeof input.effort === "string" ? input.effort : undefined, speed: input.speed }, ctx.signal);
    const a = input.run_in_background ? await spawn() : await blocks(ctx, spawn);
    if (input.run_in_background && agents.queuedForSlot(a)) return ok(agents.queuedLine(a) + agents.spawnNotes(a.id));
    if (input.run_in_background) return ok(`Started agent ${a.id} (${a.title}) in the background. Its report wakes you as a message when it finishes, so set no timer or wait for it: do other work or end your turn.${agents.spawnNotes(a.id)}`);
    if (a.status === "waiting") return ok(`Agent ${a.id} is waiting for ${agents.waitsOn(a) || "a scheduled wait"} and goes on in the background; its report arrives later.${agents.spawnNotes(a.id)}\n\nSo far:\n${a.result ?? ""}`);
    const report = agents.withUnread(agents.reportBlock(a), a.id) + agents.spawnNotes(a.id);
    return a.status === "completed" ? ok(report) : fail(report);
  }),
};

// A call as the session's history holds it: the reply that made it, and what
// it asked for. Undefined for a call no reply holds (one a program made). The
// reply is looked for among the branch's newest (replyOf), never to its start.
function callOf(sessionId: string, callId: string): { event: string; name: string; input: any } | undefined {
  const line = D().engine.lineage(sessionId);
  const e = line[replyOf(line, callId)];
  if (!e) return undefined;
  const u = (e.data.blocks as any[]).find((b) => b.type === "tool_use" && b.id === callId);
  return { event: e.id, name: String(u.name), input: u.input };
}
// The sender's name for a message: the call that sent it, by the reply that
// holds the call and the call's id. A provider may give two calls one id (in
// two turns, after a compaction): the reply tells them apart, so another
// message is never taken for one already sent.
const keyOf = (event: string, callId: string) => `call:${event}:${callId}`;
const callKey = (ctx: ToolContext) => {
  // (A program's call is in no reply: nothing is looked for.)
  const c = ctx.callId && !ctx.nestedIn ? callOf(ctx.sessionId, ctx.callId) : undefined;
  return c ? keyOf(c.event, ctx.callId!) : undefined;
};
const MESSAGE_TOOLS = new Set(["SendMessage", "send_input"]);
// A message call a restart cut after its message was stored and before it was
// answered: its result says the message is with the agent, so the model does
// not send it a second time under a new call.
export const messageHooks: TurnHooks = {
  callOutcome: (sessionId, callId) => {
    const c = callOf(sessionId, callId);
    // Any cut call that started an agent (Agent, spawn_agent, a forked Skill) is answered with that agent, so the
    // parent never starts it twice; the lookup is by the call's id on the parent index.
    if (c) { const cut = agents.agentCallCut(sessionId, callId); if (cut) return cut; }
    if (!c || !MESSAGE_TOOLS.has(c.name)) return undefined;
    let to: agents.AgentRecord;
    try { to = agents.resolveInTree(sessionId, String(c.input?.to ?? c.input?.agent_id ?? c.input?.target)); } catch { return undefined; }
    if (!D().engine.hasInput(to.session_id, keyOf(c.event, callId))) return undefined;
    return { done: `The daemon restarted before this call was answered. Its message was stored for agent ${to.id} before that and the agent reads it: do not send it again.` };
  },
};
// When the agent reads a message that was taken: now, or from its queue.
function whenRead(r: agents.MessageSent): string {
  if (r.duplicate) return "This call's message was already sent; it was not sent again.";
  if (!r.waits) return "It reads it now.";
  const n = r.agent.messages_waiting ?? 1;
  const where = `It is kept in its queue${n > 1 ? ` (${n} of your messages wait there)` : ""}`;
  if (r.held && agents.isOwnerHold(r.held_by)) return `${where}: the owner stopped that agent, and it reads the message when the owner resumes it. Nothing you send starts it before that.`;
  if (r.held) return `${where}: that agent is stopped (${heldSays(r.held_by)}), and it reads the message when the agent that started it sends it on.`;
  if (D().engine.isDraining()) return `${where}: the daemon is restarting, and the agent reads it when it is back.`;
  // An agent of another program takes input only between its turns.
  if (D().engine.isExternal(r.agent.session_id)) return `${where}: the agent is working and reads it after its current turn.`;
  return `${where}: the agent is working and reads it after its current step, which can take as long as the tool it is running.`;
}

const SendMessage: Tool = {
  name: "SendMessage",
  inputAlias: { to: ["agent_id"] },
  urgent: "follow-up-start", // it messages the other agents of its tree; a message to a finished agent may start its work fresh (src/engine/follow-up.ts)
  families: CLAUDE,
  readOnly: false, kind: "own",
  description: "Send a message to one of your subagents, or to another agent of this session's tree, by agent id or description: it steers a running agent (after its current step) or gives a finished one new work. A finished agent starts where it is cheapest: in its context, or fresh from a capsule of its work (its task, its report, the files and commands of its work); the result says which. Its next report goes to the agent that started it.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The agent id or description" },
      message: { type: "string", description: "The message" },
      summary: { type: "string", description: "A 5-10 word preview of the message" },
      ...GRANT_PROP,
      ...RESUME_BUDGET,
    },
    required: ["to", "message"],
  },
  run: (input, ctx) => guard(async () => {
    const to = agents.resolveInTree(ctx.sessionId, String(input.to ?? input.agent_id));
    const granted = input.writes === undefined ? "" : await writeAsks.allow(ctx.sessionId, to.session_id, input.writes);
    const r = await agents.send(to.id, granted ? `${String(input.message)}\n\n(${granted})` : String(input.message), false, callKey(ctx), ctx.sessionId, input.budget);
    const mine = to.parent_id === ctx.sessionId;
    return ok(`${r.held ? "Stored for" : "Sent to"} ${r.agent.id}. ${whenRead(r)}${r.held ? "" : mine ? " Its report arrives as a message." : " Its report goes to the agent that started it, not to you."}${r.start ? ` ${r.start.why}` : ""}`);
  }),
};

// Claude Code has one TaskStop for every background thing. The tools lane owns
// it for background commands; agents, waits and monitors join it here.
export function extendTaskStop() {
  const t = toolsFor("claude").find((x) => x.name === "TaskStop") as (Tool & { __automation?: boolean }) | undefined;
  if (!t || t.__automation) return;
  t.__automation = true;
  t.description += " Also stops a background agent, wait or monitor by its id; a stopped agent's work so far is returned.";
  const orig = t.run.bind(t);
  t.run = (input, ctx) => guard(async () => {
    const id = String(input.task_id ?? input.shell_id ?? "");
    const w = waits.get(id);
    if (w?.session_id === ctx.sessionId) return ok(waits.cancelText(id, waits.cancel(id, ctx.sessionId)));
    const a = agents.list(ctx.sessionId).find((x) => x.id === id || x.session_id === id);
    if (!a) return orig(input, ctx);
    const r = agents.stop(a.id, "parent")!;
    return ok(`Stopping ${a.id}; it was ${a.status}.${r.result ? `\n\nSo far:\n${r.result}` : ""}`);
  });
}

const spawn_agent: Tool = {
  name: "spawn_agent",
  inputAlias: { message: ["prompt"] },
  urgent: "lost-agent-successor, agent-tiers", // a lost agent is started again by itself (src/automation/successor.ts): the parent must not start it by hand; a spawn with no model starts on the owner's tier (src/engine/tiers.ts)
  families: OTHERS,
  readOnly: false, kind: "own",
  description:
    "Spawn a sub-agent for a well-scoped task. Returns the spawned agent id. The agent works in the background in its own session; its final answer arrives as a message when it finishes, or call wait_agent when you are blocked on it. " +
    "Spawn several in one round for independent subtasks with disjoint write scopes. Spawned agents use your current model unless model names another. A sub-agent may spawn agents of its own, three levels below the session at most; the session's agent limit counts every agent of the tree. " +
    "Agent types: default or worker (general-purpose, every tool; the default), explorer (read-only search), and the types listed in the system prompt. In a git repository an agent that can edit gets its own worktree and branch (isolation: \"none\" shares your checkout); its result names the branch to merge. output_schema makes its final answer one JSON value matching that schema." +
    " An agent whose context is lost (the model declines, its context fills, its provider fails) is started again by itself with a fresh context from a capsule of its work, in the same worktree, at most twice: you get one line, then its report. Do not start it again yourself.",
  input_schema: {
    type: "object",
    properties: {
      task_name: { type: "string", description: "Short name of the task in lowercase words joined by underscores (harness_3_cache_study); the agent is listed by it." },
      message: { type: "string", description: "Initial plain-text task for the new agent." },
      agent_type: { type: "string", description: "Agent type for the new agent: default, worker, explorer, or a listed type. Omit for default." },
      fork_context: { type: "boolean", description: "True starts the agent with a copy of this conversation; false or omitted starts it with only the task." },
      model: { type: "string", description: "Model override for the new agent. Omit unless an explicit override is needed: the owner's tier for the agent is used, else your model." },
      ...TIER_PROP,
      isolation: { type: "string", enum: ["worktree", "none"], description: "worktree (default for agents that edit, in a git repository) or none (edit this checkout)." },
      output_schema: { type: "object", description: "JSON schema the agent's final answer must match." },
      ...WRITES_PROP,
      ...REVIEWS_PROP,
      ...API_PROP,
      ...PACE_PROP,
      ...BUDGET_PROP,
      ...MACHINE_PROPS,
    },
    required: ["message"],
  },
  target: (input) => onMachine(input, input.message ?? input.prompt),
  run: (input, ctx) => guard(async () => {
    const a = await agents.spawn(ctx.sessionId, { prompt: input.message ?? input.prompt, task_name: typeof input.task_name === "string" ? input.task_name : undefined, type: input.agent_type, model: input.model, tier: typeof input.tier === "string" ? input.tier : undefined, fork: !!input.fork_context, background: true, isolation: input.isolation, output_schema: input.output_schema, budget: input.budget, machine: input.machine, cwd: input.cwd, call_id: ctx.callId, writes: input.writes, reviews: input.reviews, api: input.api, effort: typeof input.effort === "string" ? input.effort : undefined, speed: input.speed }, ctx.signal);
    const left = agents.notCarried(a.id).trim();
    const earlier = agents.takeEarlier(a.id).trim();
    const forkCost = agents.takeFork(a.id);
    const tier = agents.tierNote(a.id);
    return ok(JSON.stringify({ agent_id: a.id, nickname: a.title, ...(tier ? { tier } : {}), ...(agents.queuedForSlot(a) ? { status: "waits_for_slot", note: agents.queuedLine(a) } : {}), ...(left ? { not_carried: left } : {}), ...(agents.scopeNote(a.id) ? { write_scope: agents.scopeNote(a.id) } : {}), ...(forkCost ? { fork_cost: forkCost } : {}), ...(earlier ? { earlier_attempts: earlier } : {}) }));
  }),
};

const send_input: Tool = {
  name: "send_input",
  urgent: "follow-up-start", // it messages the other agents of its tree; a message to a finished agent may start its work fresh (src/engine/follow-up.ts)
  families: OTHERS,
  readOnly: false, kind: "own",
  description: "Send a message to an existing agent: one you spawned, or another agent of this session's tree. Report progress to your parent in your final answer, not by messaging a session above you. Use interrupt=true to redirect the work of one you spawned immediately; otherwise it is handled after its current step. A finished agent starts its new work where it is cheapest: in its context, or fresh from a capsule of its work (its task, its report, the files and commands of its work); the result says which. Its next result goes to the agent that spawned it.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Agent id to message (from spawn_agent)." },
      message: { type: "string", description: "Message to send to the agent." },
      interrupt: { type: "boolean", description: "True interrupts the current task and handles this message immediately." },
      ...GRANT_PROP,
      ...RESUME_BUDGET,
    },
    required: ["target", "message"],
  },
  run: (input, ctx) => guard(async () => {
    const to = agents.resolveInTree(ctx.sessionId, String(input.target));
    const granted = input.writes === undefined ? "" : await writeAsks.allow(ctx.sessionId, to.session_id, input.writes);
    const r = await agents.send(to.id, granted ? `${String(input.message)}\n\n(${granted})` : String(input.message), !!input.interrupt, callKey(ctx), ctx.sessionId, input.budget);
    return ok(JSON.stringify({ submission_id: `${r.agent.id}-${Date.now()}`, delivery: whenRead(r), ...(r.start ? { start: r.start.way, start_why: r.start.why } : {}) }));
  }),
};

const wait_agent: Tool = {
  name: "wait_agent",
  resultCap: agents.RESULT_CAP, // a report is cut to this by the agents' own code, never in its middle by the engine's smaller cap
  families: OTHERS,
  readOnly: true,
  description: "Wait for agents to reach a final status and return their final messages. Returns as soon as any target is final (with every other one already final); timed_out is true only when none is. Results returned here are not delivered again. Call it sparingly, only when your next step is blocked on the result.",
  input_schema: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "string" }, description: "Agent ids to wait on; omit for every running agent." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 300000, max 3600000." },
    },
  },
  run: (input, ctx) => guard(async () => {
    const t = Math.min(Math.max(Number(input.timeout_ms ?? 300_000), 1000), 3_600_000);
    const res = await blocks(ctx, () => agents.waitAll(ctx.sessionId, input.targets, t, ctx.signal));
    const status: Record<string, unknown> = {};
    // Only a finished answer is completed: a stopped agent is interrupted (with
    // who stopped it), one that ran out of steps or output, or declined, is incomplete.
    // Each report names its instance (report_id): a later task's report with
    // the same words is another report.
    for (const a of res) {
      const id = { report_id: agents.reportId(a) };
      status[a.id] = !agents.isEnded(a) ? a.status
        : a.status === "completed" ? { completed: a.result, ...id }
          : a.status === "failed" ? { errored: a.result, ...id }
            : a.status === "stopped" ? { interrupted: { by: a.stopped_by ?? null, report: a.result }, ...id }
              : { incomplete: { reason: a.end_reason ?? null, report: a.result }, ...id };
    }
    const text = JSON.stringify({ status, timed_out: res.length > 0 && !res.some((a) => agents.isEnded(a)) });
    // Acked when this result is stored as it is (resultStored), not when the turn
    // was stopped and its result says so instead.
    if (ctx.callId) waited.set(waitKey(ctx.sessionId, ctx.callId), { reports: res.filter((a) => agents.isEnded(a)).map((a) => ({ id: a.id, report: agents.reportId(a) })), text });
    return ok(text);
  }),
};

// wait_agent results not yet seen stored, by session and tool call id (a call
// id is unique only within its session: providers and the scripted one reuse them).
const waited = new Map<string, { reports: { id: string; report: string }[]; text: string }>();
const waitKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;
export function ackStoredWaits(sessionId: string, results: { tool_use_id: string; content: unknown }[]) {
  for (const r of results) {
    const key = waitKey(sessionId, r.tool_use_id);
    const w = waited.get(key);
    if (!w) continue;
    waited.delete(key);
    const stored = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
    if (stored.includes(w.text)) agents.ackWaited(sessionId, w.reports);
  }
}

// A wait's reports are delivered with the result that holds them, in the
// same commit: a crash later in the step does not deliver them again.
export const waitAckHooks: TurnHooks = {
  resultStored: (s, results) => ackStoredWaits(s.id, results),
  // A call that blocks on agents waits on the owner when every agent still at
  // work does (a question, a card): a drain does not wait for such a call.
  awaitsOwner: (sessionId, callId) => blocking.has(waitKey(sessionId, callId)) && agents.allWaitOnOwner(sessionId),
  awaitsAgents: (sessionId, callId) => blocking.has(waitKey(sessionId, callId)) ? agents.live(sessionId).map((a) => a.session_id) : undefined,
};

// The calls that block until agents end (wait_agent, an Agent call that is not in the background), while they wait.
const blocking = new Set<string>();
async function blocks<T>(ctx: ToolContext, run: () => Promise<T>): Promise<T> {
  const key = waitKey(ctx.sessionId, ctx.callId ?? "");
  blocking.add(key);
  try { return await run(); } finally { blocking.delete(key); }
}

const close_agent: Tool = {
  name: "close_agent",
  families: OTHERS,
  readOnly: false, kind: "own",
  description: "Stop an agent that is no longer needed and return its previous status.",
  input_schema: { type: "object", properties: { target: { type: "string", description: "Agent id to close (from spawn_agent)." } }, required: ["target"] },
  run: (input, ctx) => guard(() => {
    const a = agents.resolveTarget(ctx.sessionId, String(input.target));
    agents.stop(a.id, "parent");
    return ok(JSON.stringify({ previous_status: a.status }));
  }),
};

// --- waits -------------------------------------------------------------------

const waitSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["timer", "file", "log", "http", "process", "pr_checks"], description: "What to wait on" },
    seconds: { type: "number", description: "timer: seconds from now" },
    path: { type: "string", description: "file: wait until it exists (and holds `contains`); log: watch lines appended to it" },
    contains: { type: "string", description: "file: text the file must contain" },
    match: { type: "string", description: "log: a regular expression a new line must match" },
    writer: { type: "string", description: "file, log: the ID of your background command that writes the file, when its command line does not name it: its end without the condition ends the wait" },
    url: { type: "string", description: "http: the URL to probe" },
    status: { type: "number", description: "http: the status to wait for (default any 2xx or 3xx)" },
    pid: { type: "number", description: "process only (ignored with any other kind): the id of a running process, a number above 1, as `echo $!` prints it, to wait until it ends. A background command's ID is not a pid: its end wakes you by itself (a process wait with no pid waits for the end of your one running background command)" },
    repo: { type: "string", description: "pr_checks: the GitHub repository, owner/name" },
    pr_number: { type: "number", description: "pr_checks: wait until every check of this pull request has finished (or it is merged or closed); the result names the failed checks" },
    timeout_seconds: { type: "number", description: "Give up after this long (default 600, timers use their own time)" },
    note: { type: "string", description: "What you are waiting for, shown back to you when it fires" },
  },
  required: ["kind"],
};

// The session's commands that still have processes (the command itself, or what it left running: a server
// started with `&` or setsid stays in its scope or its group), and the ports those processes listen on.
const ownJobs = (sessionId: string) => jobsOf(sessionId).filter((j) => running(j) || jobHasProcesses(j));
const ownPorts = (sessionId: string) => {
  const pids = new Map(ownJobs(sessionId).map((j) => [j.id, jobPidsOf(j)] as const));
  return [...portsOf(pids).values()].flat().map((p) => p.port).filter((p) => !isOwnPort(p));
};

// A server the session started a moment ago has not bound its port yet (a dev server takes seconds to
// start, a build or a gate such as waitfor --capacity may come first), and the wait asked for next would be
// refused as naming a port nothing listens on. While a command of the session that is still running started
// within `young` ms, the port is looked at every `every` ms, so the wait ends when the last of them is
// `young` old; with no such command it is refused at once. (A test sets them shorter.) What listens is found
// by the pid tree under each command, and by the mark its processes carry (a server started with setsid and
// left by the shell's end is in no tree and no group): the marks are read every `marks` ms, not at each look.
export const bindWait = { young: 60_000, every: 250, marks: 1000 };
async function bound(u: URL, sessionId: string): Promise<boolean> {
  if (!waits.localProbe(u, [Number(u.port || (u.protocol === "https:" ? 443 : 80))])) return false; // not a loopback address: no process of the session can bind it
  const young = () => jobsOf(sessionId).filter((j) => Date.now() - j.started <= bindWait.young);
  let marked = 0, markedOn = false, markedPortsNow: number[] = [];
  // Where no cgroup holds a command, a process that left its group and session (setsid) is known by its mark alone.
  const markedLook = async () => {
    if (Date.now() - marked < bindWait.marks) return;
    marked = Date.now();
    const loose = young().filter((j) => j.contain !== "cgroup");
    markedPortsNow = await markedPorts([...new Set([...ownJobs(sessionId), ...loose])]);
    markedOn = (await processesOf(loose).catch(() => new Map())).size > 0;
  };
  const listening = () => waits.localProbe(u, [...ownPorts(sessionId), ...markedPortsNow]);
  const waiting = () => young().some((j) => running(j) || jobHasProcesses(j)) || markedOn;
  await markedLook();
  while (!listening() && waiting()) {
    await Bun.sleep(bindWait.every);
    await markedLook();
  }
  return listening();
}
// The ports of the processes of these commands, found by what the daemon holds them by and by their mark.
async function markedPorts(list: Job[]): Promise<number[]> {
  const held = await processesOf(list).catch(() => new Map<string, { pid: number }[]>());
  const pids = new Map([...held].map(([id, ps]) => [id, ps.map((p) => p.pid)] as const));
  return [...portsOf(pids).values()].flat().map((p) => p.port).filter((p) => !isOwnPort(p));
}

// The exact next call after a wait on a loopback port nothing of the session listens on: with a background command of
// the session running, its output is waited on for the line that says it is up (or the port it does listen on is named);
// with none, the server is started first. (Pure: the refusal's words, tested by themselves.)
export function portNext(waitName: string, url: string, running: { id: string; log: string }[], listening: number[]): string {
  const port = Number(new URL(url).port);
  if (!running.length) return ` No background command of this session is running. Start the server with the shell tool's run_in_background; the command's own end wakes you. Then call ${waitName} with kind "http" and url ${url}.`;
  const job = running[0]!;
  const others = [...new Set(listening)].filter((p) => p !== port).slice(0, 4);
  return ` Your background command ${job.id} is running` + (others.length ? ` and its processes listen on ${others.join(", ")}: is that the port you meant?` : " and nothing of it listens yet.") +
    ` To wait for it to come up: ${waitName} with kind "log", path ${JSON.stringify(job.log)}, match "listening|ready|started|up"; then ${waitName} with kind "http" and url ${url}.`;
}

// `monitorName`: the family's name for the monitor tool (what a refusal names as the other way).
const waitRun = (monitorName: string) => (input: any, ctx: ToolContext) => guard(async () => {
  if (input.kind === "webhook" || input.spec?.kind === "webhook") return fail("A webhook wait is the owner's to create.");
  // A session whose commands run on another machine: their files are there, not on this disk.
  const elsewhere = !!D().store.session(ctx.sessionId)?.machine;
  // The background command of this session a path is the output of (logDir in src/tools/shell.ts), by its id.
  const job = (path: string) => (dirname(path) === join(ctx.spillDir, "jobs") && existsSync(path) ? basename(path).replace(/\.log$/, "") : undefined);
  // A process wait that names no process, as the wait it meant (a pause, or the end of the session's own command).
  const meant = waits.reframe(input, ctx.cwd, elsewhere ? {} : { job, log: (id) => jobsOf(ctx.sessionId).find((j) => j.id === id)?.log, only: () => { const live = jobsOf(ctx.sessionId).filter((j) => j.background && running(j)); return live.length === 1 ? live[0]!.id : undefined; } });
  const asked = meant?.input ?? input;
  const spec = waits.normalize(asked, ctx.cwd, { elsewhere, job });
  if (waits.isMonitor(spec.kind)) return fail("Use the monitor tool for a command's output or a socket.");
  // The output file of a background command of this session (logDir in src/tools/shell.ts) that does not
  // exist names no command of it: a wait on it only reaches its deadline. Its exit file (`<log>.exit`, src/tools/jobs.ts)
  // is written when the command ends, so it is waited for while its log is there.
  const out = spec.kind === "file" || spec.kind === "log" ? spec.path : "";
  if (out && !elsewhere && dirname(out) === join(ctx.spillDir, "jobs") && !existsSync(out) && !(out.endsWith(".exit") && existsSync(out.slice(0, -".exit".length))))
    return fail(`${basename(out)} is the output file of no background command of this session. A background command you started wakes this session by itself when it ends: it needs no wait. To wait on one all the same, use kind "file" on its log's path plus ".exit", which its end writes.`);
  // The model's http wait follows web fetch's address rules (the wait tool runs unasked, as a read), except a
  // loopback port one of the session's own processes listens on: a server it started is its own.
  if (spec.kind === "http") {
    const u = new URL(spec.url);
    if (privateHost(u.hostname) && !waits.localProbe(u, ownPorts(ctx.sessionId)) && !(await bound(u, ctx.sessionId))) {
      const probe = `until curl -fsS -o /dev/null ${spec.url}; do ${"sle" + "ep"} 1; done; echo up`;
      const loop = /^(localhost|.*\.localhost)\.?$/i.test(u.hostname) || /^(127\.|\[?::1\]?$)/.test(u.hostname);
      return fail(loop && u.port
        ? `no process of this session listens on ${u.port} yet: start the server, then wait, or use ${monitorName} with curl (command: ${JSON.stringify(probe)}, match: "up").` + portNext(monitorName === "Monitor" ? "WaitFor" : "wait_for", spec.url, ownJobs(ctx.sessionId).filter((j) => j.background && running(j)).map((j) => ({ id: j.id, log: j.log })), ownPorts(ctx.sessionId))
        : `${u.hostname} is a local or private address; a wait reaches only a loopback port a process of this session listens on. Start the server with the shell tool's run_in_background, then wait on its URL; or watch it now with ${monitorName} (command: ${JSON.stringify(probe)}, match: "up").`);
    }
  }
  // The same condition again before it fired: the wait already set stands (its deadline the later one).
  const said = meant?.said ?? "";
  const same = waits.twin(ctx.sessionId, spec, { timeout_seconds: asked.timeout_seconds });
  if (same) return waitResult(same, said, true);
  return waitResult(waits.create(ctx.sessionId, spec, { timeout_seconds: asked.timeout_seconds, note: asked.note }), said);
});

const waitDesc =
  "Wait without spending tokens: the daemon checks a condition (a timer, a file appearing or containing text, a new log line matching a pattern, an HTTP status, a process ending, every check of a GitHub pull request finishing) and wakes this session with the result when it holds or the timeout passes. " +
  "A file or log wait's wake carries what the file gained since the wait began (its end, as a tool's output is cut) and what is known of the job that writes it; that job's end without the condition, or a long stretch of it with no output, no processor use and nothing of it waiting, wakes you before the deadline. " +
  "Use it instead of sleep or polling loops. It returns at once; end your turn after it unless you have other work. Not for your own agents, nor for a background command you started: their reports and its end wake you by themselves, so there is no pid to give for one. A pause is kind timer with seconds. A local http address is waited on only at a port a background command of this session listens on, once it listens.";

// A pull request wait runs gh with the owner's login against a repository the
// model names: the gate judges it as its own tool (wait_pr_checks), so it asks
// where other actions ask and the owner can allow it by that name.
// The files and addresses a wait reads are judged as the read they are (as helper__memory_import does): a credential
// path or a path outside the sandbox asks, an address the session has not seen that a model chose is held by the
// unseen-address rule. A timer or a process wait reads nothing, so it is the session's own act.
const waitTarget = (name: string) => async (input: any) => {
  const spec = input?.spec && typeof input.spec === "object" ? input.spec : input;
  const kind = spec?.kind ?? input?.kind;
  if (kind === "pr_checks") return { name: "wait_pr_checks", readOnly: false, input, cls: { kind: "other" as const } };
  if (kind === "http" || (!kind && typeof spec?.url === "string")) return { name, readOnly: true, input, cls: { kind: "read" as const, fetches: [String(spec?.url ?? "")] } };
  if (kind === "file" || kind === "log" || (!kind && typeof spec?.path === "string")) return { name, readOnly: true, input };
  return null;
};
const WaitFor: Tool = { name: "WaitFor", urgent: "wait-process-sole-command", families: CLAUDE, readOnly: false, kind: "own", description: waitDesc, input_schema: waitSchema, run: waitRun("Monitor"), target: waitTarget("WaitFor") };
const wait_for: Tool = { name: "wait_for", urgent: "wait-process-sole-command", families: OTHERS, readOnly: false, kind: "own", description: waitDesc, input_schema: waitSchema, run: waitRun("monitor"), target: waitTarget("wait_for") };

const cancel_wait: Tool = {
  name: "cancel_wait",
  families: OTHERS,
  readOnly: false, kind: "own",
  description: "Cancel a wait or monitor of this session by its id.",
  input_schema: { type: "object", properties: { wait_id: { type: "string" } }, required: ["wait_id"] },
  run: (input, ctx) => guard(() => {
    const id = String(input.wait_id);
    const r = waits.cancel(id, ctx.sessionId);
    return r ? ok(waits.cancelText(id, r)) : fail(`No wait ${id} in this session.`);
  }),
};

const monitorSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command whose output lines are events (a tail -F, a polling script, a build)" },
    ws: {
      type: "object",
      description: "Instead of command: a WebSocket to listen to; each text message is one event. The socket closing ends the monitor.",
      properties: { url: { type: "string", description: "ws:// or wss:// URL" }, protocols: { type: "array", items: { type: "string" }, description: "Subprotocols to offer" } },
      required: ["url"],
    },
    description: { type: "string", description: "What the monitor watches, shown back with each event" },
    match: { type: "string", description: "Optional regular expression: only matching lines are events" },
    timeout_ms: { type: "number", description: "Deadline in milliseconds (default 300000, at most a day)" },
  },
};

const monitorRun = (input: any, ctx: ToolContext) => guard(() => {
  if (!!input.command === !!input.ws) return fail("Give a monitor either command or ws, not both.");
  if (input.command != null && typeof input.command !== "string") return fail("command must be one string.");
  const spec = input.ws
    ? waits.normalize({ kind: "websocket", url: input.ws.url, protocols: input.ws.protocols, match: input.match }, ctx.cwd)
    : waits.normalize({ kind: "monitor", command: input.command, match: input.match }, ctx.cwd);
  const w = waits.create(ctx.sessionId, spec, { timeout_seconds: input.timeout_ms ? Number(input.timeout_ms) / 1000 : undefined, note: input.description });
  return ok(`Monitor ${w.id} started. Matching output lines arrive as messages, batched; it ends when the ${spec.kind === "websocket" ? "socket closes" : "command exits"} or at its deadline (${Math.round((w.deadline - Date.now()) / 1000)} s). Stop it with ${familyOf(D().store.session(ctx.sessionId)?.model ?? "") === "claude" ? "TaskStop" : "cancel_wait"} and its id.`);
});

const monitorDesc = "Run a command in the background and receive its output lines as events while you keep working, without polling. Use it to tail a log, watch a build, or poll a status with a small script that prints when something changes. For a server that pushes events, give ws with its URL instead of a command: each message is an event.";
const Monitor: Tool = { name: "Monitor", families: CLAUDE, readOnly: false, kind: "shell", description: monitorDesc, input_schema: monitorSchema, run: monitorRun };
const monitor: Tool = { name: "monitor", families: OTHERS, readOnly: false, kind: "shell", description: monitorDesc, input_schema: monitorSchema, run: monitorRun };

// --- loops -------------------------------------------------------------------

const wakeupSchema = {
  type: "object",
  properties: {
    delaySeconds: { type: "number", description: "Seconds until the next iteration, 60 to 3600" },
    reason: { type: "string", description: "Why this delay, in a few words" },
    prompt: { type: "string", description: "The prompt each iteration runs (needed only to start a loop)" },
    stop: { type: "boolean", description: "End the loop: the task is complete" },
  },
};
const wakeupRun = (input: any, ctx: ToolContext) => guard(() =>
  ok(loops.scheduleNext(ctx.sessionId, { delay_seconds: input.delaySeconds ?? input.delay_seconds, reason: input.reason, stop: !!input.stop, prompt: input.prompt })));
const wakeupDesc = "Pace a self-paced loop: at the end of each iteration, say when the next one runs (60 s to an hour): short while something is about to change, long when all is quiet. stop: true ends the loop. Called outside a loop with a prompt, it starts one.";

// Pacing the run it is in is the session's own; a call with a prompt outside a run starts a loop, which runs by itself
// until it is stopped: judged as the tool that does that, which asks as CronCreate does.
const wakeupTarget = async (input: any, session?: string) =>
  session && loops.startsLoop(session, { stop: !!input?.stop, prompt: input?.prompt }) ? { name: "schedule_wakeup_start", readOnly: false, input, cls: { kind: "other" as const } } : null;
const ScheduleWakeup: Tool = { name: "ScheduleWakeup", urgent: "schedule-is-an-act", families: CLAUDE, readOnly: false, kind: "own", description: wakeupDesc, input_schema: wakeupSchema, run: wakeupRun, target: wakeupTarget };
const schedule_wakeup: Tool = { name: "schedule_wakeup", urgent: "schedule-is-an-act", families: OTHERS, readOnly: false, kind: "own", description: wakeupDesc, input_schema: wakeupSchema, run: wakeupRun, target: wakeupTarget };

function loopLine(l: loops.LoopRecord) {
  const next = l.next_ms ? zonedStamp(l.next_ms) : "-";
  return `${l.id} · ${l.enabled ? "on" : `off (${l.disabled_reason ?? "paused"})`} · ${l.schedule_text} · next ${next} · ${l.runs} runs${l.gate ? ` of ${l.checks ?? 0} checks (gate: ${l.gate.length > 60 ? `${l.gate.slice(0, 59)}…` : l.gate})` : ""} · last ${l.last_status ?? "-"} · ${l.name}`;
}

const cronSchema = {
  type: "object",
  properties: {
    cron: { type: "string", description: "Five-field cron expression in local time (minute hour day-of-month month day-of-week), or an interval such as 10m or 2h" },
    prompt: { type: "string", description: "The prompt to run at each fire" },
    recurring: { type: "boolean", description: "false fires once, then the task is deleted (default true)" },
  },
  required: ["cron", "prompt"],
};
const cronRun = (input: any, ctx: ToolContext) => guard(() => {
  // The schema offers no gate, but a session whose tools are pinned from before still shows the old definition.
  if (input.gate !== undefined && input.gate !== null && String(input.gate).trim()) return fail("A check command for a loop is set by the owner, in the Loops panel; this loop runs its prompt each time.");
  const { loop } = loops.create({ session_id: ctx.sessionId, schedule: String(input.cron ?? input.schedule), prompt: input.prompt, max_runs: input.recurring === false ? 1 : (input.max_runs ?? null), created_by: "model" });
  return ok(`Scheduled ${loop.id}: ${loop.schedule_text}, next run ${loop.next_ms ? zonedStamp(loop.next_ms) : "-"}. Recurring tasks expire after 30 days.`);
});
const cronDesc = "Schedule a prompt to run in this session on a cron schedule or an interval, between turns (a busy session runs it when its turn ends). Recurring tasks expire after 30 days; recurring: false fires once.";

const CronCreate: Tool = { name: "CronCreate", inputAlias: { cron: ["schedule"] }, urgent: "schedule-is-an-act", families: CLAUDE, readOnly: false, description: cronDesc, input_schema: cronSchema, run: cronRun };
const schedule_create: Tool = { name: "schedule_create", inputAlias: { cron: ["schedule"] }, urgent: "schedule-is-an-act", families: OTHERS, readOnly: false, description: cronDesc, input_schema: cronSchema, run: cronRun };

const listRun = (_: any, ctx: ToolContext) => guard(() => {
  const ls = loops.list(ctx.sessionId);
  const ws = waits.list(ctx.sessionId, 0).filter((w) => w.status === "active");
  const as = agents.live(ctx.sessionId);
  const parts = [
    ls.length ? `Scheduled tasks:\n${ls.map(loopLine).join("\n")}` : "No scheduled tasks.",
    ws.length ? `Active waits:\n${ws.map((w) => `${w.id} · ${w.kind} · ${w.note || JSON.stringify(w.spec)}`).join("\n")}` : "",
    as.length ? `Running agents:\n${as.map(agentLine).join("\n")}` : "",
  ];
  return ok(parts.filter(Boolean).join("\n\n"));
});
const listDesc = "List this session's scheduled tasks (id, schedule, next run, run count, last status), active waits and running agents.";
const CronList: Tool = { name: "CronList", families: CLAUDE, readOnly: true, description: listDesc, input_schema: { type: "object", properties: {} }, run: listRun };
const schedule_list: Tool = { name: "schedule_list", families: OTHERS, readOnly: true, description: listDesc, input_schema: { type: "object", properties: {} }, run: listRun };

const deleteRun = (input: any, ctx: ToolContext) => guard(() => {
  const l = loops.get(String(input.id));
  if (!l || l.session_id !== ctx.sessionId) return fail(`No scheduled task ${input.id} in this session.`);
  if (l.kind === "webhook") return fail("A webhook loop is the owner's; it is changed in the page.");
  if (l.kind === "mcp") return fail("A loop that runs on a server's notification is the owner's; it is changed in the page.");
  if (l.created_by !== "model") return fail(`The owner made ${l.id}; only the owner changes it, in the page.`);
  loops.remove(l.id);
  return ok(`Deleted ${l.id}.`);
});
const CronDelete: Tool = { name: "CronDelete", families: CLAUDE, readOnly: false, kind: "own", description: "Cancel a scheduled task by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, run: deleteRun };
const schedule_delete: Tool = { name: "schedule_delete", families: OTHERS, readOnly: false, kind: "own", description: "Cancel a scheduled task by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, run: deleteRun };

// --- alerts ------------------------------------------------------------------

const notifyRun = (input: any, ctx: ToolContext) => guard(() => {
  if (isChild(ctx)) return fail("A subagent reports to its parent, not to the owner.");
  const text = String(input.message ?? input.text ?? "").trim();
  if (!text) return fail("The notification needs a message.");
  const s = D().store.session(ctx.sessionId)!;
  const a = alerts.raise("agent", ctx.sessionId, s.title || "Keel", text.slice(0, 500));
  return ok(a?.channels?.length ? `Sent (${a.channels.join(", ")}).` : "Noted in the owner's inbox; the owner is watching this session, so nothing was pushed.");
});
const notifyDesc = "Alert the owner when something needs them or a long job is done and they may be away: one short line. It does not wait for an answer. Do not use it for routine progress.";
const PushNotification: Tool = {
  name: "PushNotification", inputAlias: { message: ["text"] }, families: CLAUDE, readOnly: false, kind: "own", description: notifyDesc,
  input_schema: { type: "object", properties: { message: { type: "string", description: "The notification text, one short line" } }, required: ["message"] }, run: notifyRun,
};
const notify: Tool = {
  name: "notify", inputAlias: { text: ["message"] }, families: OTHERS, readOnly: false, kind: "own", description: notifyDesc,
  input_schema: { type: "object", properties: { text: { type: "string", description: "The notification text, one short line" } }, required: ["text"] }, run: notifyRun,
};

// A skill with context: fork (Claude Code's skills frontmatter): its text is
// the task of an agent of the session, of the skill's `agent` type, on its
// `model`. In the background by default, its report waking the session as an
// agent's does; `background: false` waits for it in the call that loaded it.
skillRun.fork = async (ctx, skill, prompt) => {
  const fg = skill.fork?.background === false;
  try {
    const spawn = () => agents.spawn(ctx.sessionId, { title: `/${skill.name}`, prompt, earlier: false, type: skill.fork?.agent, model: skill.model, ...(skill.effort ? { effort: skill.effort } : {}), ...(skill.disallowed ? { disallowed: skill.disallowed } : {}), background: !fg, call_id: ctx.callId }, ctx.signal);
    const a = fg ? await blocks(ctx, spawn) : await spawn();
    if (!fg) return ok(`The skill ${skill.name} runs as agent ${a.id} (its context: fork). Its report wakes you as a message when it finishes, so set no timer or wait for it: do other work or end your turn.`);
    if (a.status === "waiting") return ok(`The skill ${skill.name}'s agent ${a.id} is waiting and goes on in the background; its report arrives later.\n\nSo far:\n${a.result ?? ""}`);
    const report = agents.withUnread(agents.reportBlock(a), a.id);
    return a.status === "completed" ? ok(report) : fail(report);
  } catch (e) {
    return fail(`The skill ${skill.name} runs as an agent (context: fork), and it could not start: ${(e as Error).message}`);
  }
};

// The parent's read of its agents: one line each, made by the daemon from what each is doing (its
// thinking, the call it runs, what it waits on) with no model request. Every family has it.
const keel__agents_now: Tool = {
  name: "keel__agents_now",
  readOnly: true,
  description: "What each live agent of your tree is doing now: one line each, with its steps, minutes and spend, and whether it waits on the owner. Made by the daemon with no model request; use it instead of messaging agents to ask how they are doing. Reports still arrive by themselves.",
  input_schema: { type: "object", properties: {} },
  run: (_input, ctx) => guard(() => ok(statusText(ctx.sessionId))),
};

export const automationTools: Tool[] = [
  Agent, SendMessage, WaitFor, Monitor, ScheduleWakeup, CronCreate, CronList, CronDelete, PushNotification,
  spawn_agent, send_input, wait_agent, close_agent, wait_for, cancel_wait, monitor, schedule_wakeup, schedule_create, schedule_list, schedule_delete, notify,
  keel__agents_now,
];

export const AGENT_TOOL_NAMES = ["Agent", "spawn_agent"];
