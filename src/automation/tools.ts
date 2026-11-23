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
import * as waits from "./waits.ts";
import { privateHost } from "../tools/web.ts";
import { heldSays } from "../core/stoppers.ts";
import { statusText } from "./now.ts";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Each family gets the names and shapes it was trained on: Claude the Claude
// Code tools (Agent, SendMessage, TaskStop, Monitor, ScheduleWakeup, Cron*,
// PushNotification), GPT the Codex multi-agent tools (spawn_agent, send_input,
// wait_agent, close_agent). Waits and schedules have no Codex counterpart, so
// the other families get plain snake_case names for them.

// readOnly: these tools change nothing outside Keel itself (a child's own
// calls pass the gate in its session), so the permission gate reads them as
// reads; only the monitor runs a command and is judged as one.
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
  return `${a.id} · ${a.status} · ${a.type} · ${a.title}`;
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
  urgent: "lost-agent-successor", // a lost agent is started again by itself (src/automation/successor.ts): the parent must not start it by hand
  resultCap: agents.RESULT_CAP, // a report is cut to this by the agents' own code, never in its middle by the engine's smaller cap
  families: CLAUDE,
  readOnly: true,
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
      model: { type: "string", description: "Optional model override: a listed model id or a short name such as haiku or sonnet. Omit to use this session's model." },
      run_in_background: { type: "boolean", description: "Return at once; the report arrives later as a message" },
      isolation: { type: "string", enum: ["worktree", "none"], description: "worktree (the default for agents that edit, in a git repository): its own checkout and branch; none: it edits your checkout" },
      output_schema: { type: "object", description: "A JSON schema the report must match; the report is then that JSON value" },
      ...WRITES_PROP,
      ...REVIEWS_PROP,
      ...BUDGET_PROP,
      ...MACHINE_PROPS,
    },
    required: ["description", "prompt"],
  },
  target: (input) => onMachine(input, input.prompt),
  run: (input, ctx) => guard(async () => {
    const fork = String(input.subagent_type ?? "").toLowerCase() === "fork";
    const spawn = () => agents.spawn(ctx.sessionId, { title: input.description, prompt: input.prompt, type: fork ? undefined : input.subagent_type, fork, model: input.model, background: !!input.run_in_background, isolation: input.isolation, output_schema: input.output_schema, budget: input.budget, machine: input.machine, cwd: input.cwd, call_id: ctx.callId, writes: input.writes, reviews: input.reviews }, ctx.signal);
    const a = input.run_in_background ? await spawn() : await blocks(ctx, spawn);
    if (input.run_in_background && agents.queuedForSlot(a)) return ok(agents.queuedLine(a) + agents.spawnNotes(a.id));
    if (input.run_in_background) return ok(`Started agent ${a.id} (${a.title}) in the background. Its report wakes you as a message when it finishes, so set no timer or wait for it: do other work or end your turn.${agents.spawnNotes(a.id)}`);
    if (a.status === "waiting") return ok(`Agent ${a.id} is waiting for ${agents.waitsOn(a) || "a scheduled wait"} and goes on in the background; its report arrives later.${agents.spawnNotes(a.id)}\n\nSo far:\n${a.result ?? ""}`);
    const report = agents.withUnread(agents.reportBlock(a), a.id) + agents.spawnNotes(a.id);
    return a.status === "completed" ? ok(report) : fail(report);
  }),
};

// A call as the session's history holds it: the reply that made it, and what
// it asked for. Undefined for a call no reply holds (one a program made).
function callOf(sessionId: string, callId: string): { event: string; name: string; input: any } | undefined {
  const line = D().engine.lineage(sessionId);
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind !== "assistant") continue;
    const u = (e.data.blocks as any[]).find((b) => b.type === "tool_use" && b.id === callId);
    if (u) return { event: e.id, name: String(u.name), input: u.input };
  }
  return undefined;
}
// The sender's name for a message: the call that sent it, by the reply that
// holds the call and the call's id. A provider may give two calls one id (in
// two turns, after a compaction): the reply tells them apart, so another
// message is never taken for one already sent.
const keyOf = (event: string, callId: string) => `call:${event}:${callId}`;
const callKey = (ctx: ToolContext) => {
  const c = ctx.callId ? callOf(ctx.sessionId, ctx.callId) : undefined;
  return c ? keyOf(c.event, ctx.callId!) : undefined;
};
const MESSAGE_TOOLS = new Set(["SendMessage", "send_input"]);
// A message call a restart cut after its message was stored and before it was
// answered: its result says the message is with the agent, so the model does
// not send it a second time under a new call.
export const messageHooks: TurnHooks = {
  callOutcome: (sessionId, callId) => {
    const c = callOf(sessionId, callId);
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
  urgent: "follow-up-start", // it messages the other agents of its tree; a message to a finished agent may start its work fresh (src/engine/follow-up.ts)
  families: CLAUDE,
  readOnly: true,
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
  urgent: "lost-agent-successor", // a lost agent is started again by itself (src/automation/successor.ts): the parent must not start it by hand
  families: OTHERS,
  readOnly: true,
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
      model: { type: "string", description: "Model override for the new agent. Omit unless an explicit override is needed." },
      isolation: { type: "string", enum: ["worktree", "none"], description: "worktree (default for agents that edit, in a git repository) or none (edit this checkout)." },
      output_schema: { type: "object", description: "JSON schema the agent's final answer must match." },
      ...WRITES_PROP,
      ...REVIEWS_PROP,
      ...BUDGET_PROP,
      ...MACHINE_PROPS,
    },
    required: ["message"],
  },
  target: (input) => onMachine(input, input.message ?? input.prompt),
  run: (input, ctx) => guard(async () => {
    const a = await agents.spawn(ctx.sessionId, { prompt: input.message ?? input.prompt, task_name: typeof input.task_name === "string" ? input.task_name : undefined, type: input.agent_type, model: input.model, fork: !!input.fork_context, background: true, isolation: input.isolation, output_schema: input.output_schema, budget: input.budget, machine: input.machine, cwd: input.cwd, call_id: ctx.callId, writes: input.writes, reviews: input.reviews }, ctx.signal);
    const left = agents.notCarried(a.id).trim();
    return ok(JSON.stringify({ agent_id: a.id, nickname: a.title, ...(agents.queuedForSlot(a) ? { status: "waits_for_slot", note: agents.queuedLine(a) } : {}), ...(left ? { not_carried: left } : {}), ...(agents.scopeNote(a.id) ? { write_scope: agents.scopeNote(a.id) } : {}) }));
  }),
};

const send_input: Tool = {
  name: "send_input",
  urgent: "follow-up-start", // it messages the other agents of its tree; a message to a finished agent may start its work fresh (src/engine/follow-up.ts)
  families: OTHERS,
  readOnly: true,
  description: "Send a message to an existing agent: one you spawned, or another agent of this session's tree. Use interrupt=true to redirect the work of one you spawned immediately; otherwise it is handled after its current step. A finished agent starts its new work where it is cheapest: in its context, or fresh from a capsule of its work (its task, its report, the files and commands of its work); the result says which. Its next result goes to the agent that spawned it.",
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
  readOnly: true,
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
    pid: { type: "number", description: "process: wait until this process ends" },
    repo: { type: "string", description: "pr_checks: the GitHub repository, owner/name" },
    pr_number: { type: "number", description: "pr_checks: wait until every check of this pull request has finished (or it is merged or closed); the result names the failed checks" },
    timeout_seconds: { type: "number", description: "Give up after this long (default 600, timers use their own time)" },
    note: { type: "string", description: "What you are waiting for, shown back to you when it fires" },
  },
  required: ["kind"],
};

const waitRun = (input: any, ctx: ToolContext) => guard(() => {
  if (input.kind === "webhook" || input.spec?.kind === "webhook") return fail("A webhook wait is the owner's to create.");
  // A session whose commands run on another machine: their files are there, not on this disk.
  const elsewhere = !!D().store.session(ctx.sessionId)?.machine;
  // The background command of this session a path is the output of (logDir in src/tools/shell.ts), by its id.
  const job = (path: string) => (dirname(path) === join(ctx.spillDir, "jobs") && existsSync(path) ? basename(path).replace(/\.log$/, "") : undefined);
  const spec = waits.normalize(input, ctx.cwd, { elsewhere, job });
  if (waits.isMonitor(spec.kind)) return fail("Use the monitor tool for a command's output or a socket.");
  // The output file of a background command of this session (logDir in src/tools/shell.ts) that does not
  // exist names no command of it: a wait on it only reaches its deadline. Its exit file (`<log>.exit`, src/tools/jobs.ts)
  // is written when the command ends, so it is waited for while its log is there.
  const out = spec.kind === "file" || spec.kind === "log" ? spec.path : "";
  if (out && !elsewhere && dirname(out) === join(ctx.spillDir, "jobs") && !existsSync(out) && !(out.endsWith(".exit") && existsSync(out.slice(0, -".exit".length))))
    return fail(`${basename(out)} is the output file of no background command of this session. A background command you started wakes this session by itself when it ends: it needs no wait. To wait on one all the same, use kind "file" on its log's path plus ".exit", which its end writes.`);
  // The model's http wait follows web fetch's address rules (the wait tool runs unasked, as a read).
  if (spec.kind === "http" && privateHost(new URL(spec.url).hostname))
    return fail(`${new URL(spec.url).hostname} is a local or private address; watch a local server with the monitor tool and a command such as curl.`);
  // The same condition again before it fired: the wait already set stands (its deadline the later one).
  const same = waits.twin(ctx.sessionId, spec, { timeout_seconds: input.timeout_seconds });
  if (same) return waitResult(same, "", true);
  return waitResult(waits.create(ctx.sessionId, spec, { timeout_seconds: input.timeout_seconds, note: input.note }));
});

const waitDesc =
  "Wait without spending tokens: the daemon checks a condition (a timer, a file appearing or containing text, a new log line matching a pattern, an HTTP status, a process ending, every check of a GitHub pull request finishing) and wakes this session with the result when it holds or the timeout passes. " +
  "A file or log wait's wake carries what the file gained since the wait began (its end, as a tool's output is cut) and what is known of the job that writes it; that job's end without the condition, or a long stretch of it with no output, no processor use and nothing of it waiting, wakes you before the deadline. " +
  "Use it instead of sleep or polling loops. It returns at once; end your turn after it unless you have other work. Not for your own agents, nor for a background command you started: their reports and its end wake you by themselves.";

// A pull request wait runs gh with the owner's login against a repository the
// model names: the gate judges it as its own tool (wait_pr_checks), so it asks
// where other actions ask and the owner can allow it by that name.
const waitTarget = async (input: any) =>
  input?.kind === "pr_checks" || input?.spec?.kind === "pr_checks" ? { name: "wait_pr_checks", readOnly: false, input, cls: { kind: "other" as const } } : null;
const WaitFor: Tool = { name: "WaitFor", urgent: "wait-writer-ends", families: CLAUDE, readOnly: true, description: waitDesc, input_schema: waitSchema, run: waitRun, target: waitTarget };
const wait_for: Tool = { name: "wait_for", urgent: "wait-writer-ends", families: OTHERS, readOnly: true, description: waitDesc, input_schema: waitSchema, run: waitRun, target: waitTarget };

const cancel_wait: Tool = {
  name: "cancel_wait",
  families: OTHERS,
  readOnly: true,
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

const ScheduleWakeup: Tool = { name: "ScheduleWakeup", families: CLAUDE, readOnly: true, description: wakeupDesc, input_schema: wakeupSchema, run: wakeupRun };
const schedule_wakeup: Tool = { name: "schedule_wakeup", families: OTHERS, readOnly: true, description: wakeupDesc, input_schema: wakeupSchema, run: wakeupRun };

function loopLine(l: loops.LoopRecord) {
  const next = l.next_ms ? zonedStamp(l.next_ms) : "-";
  return `${l.id} · ${l.enabled ? "on" : `off (${l.disabled_reason ?? "paused"})`} · ${l.schedule_text} · next ${next} · ${l.runs} runs · last ${l.last_status ?? "-"} · ${l.name}`;
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
  const { loop } = loops.create({ session_id: ctx.sessionId, schedule: String(input.cron ?? input.schedule), prompt: input.prompt, max_runs: input.recurring === false ? 1 : (input.max_runs ?? null), created_by: "model" });
  return ok(`Scheduled ${loop.id}: ${loop.schedule_text}, next run ${loop.next_ms ? zonedStamp(loop.next_ms) : "-"}. Recurring tasks expire after 7 days.`);
});
const cronDesc = "Schedule a prompt to run in this session on a cron schedule or an interval, between turns (a busy session runs it when its turn ends). Recurring tasks expire after seven days; recurring: false fires once.";

const CronCreate: Tool = { name: "CronCreate", families: CLAUDE, readOnly: true, description: cronDesc, input_schema: cronSchema, run: cronRun };
const schedule_create: Tool = { name: "schedule_create", families: OTHERS, readOnly: true, description: cronDesc, input_schema: cronSchema, run: cronRun };

const listRun = (_: any, ctx: ToolContext) => guard(() => {
  const ls = loops.list(ctx.sessionId);
  const ws = waits.list(ctx.sessionId, 0).filter((w) => w.status === "active");
  const as = agents.list(ctx.sessionId).filter((a) => !agents.isEnded(a));
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
  if (l.created_by !== "model") return fail(`The owner made ${l.id}; only the owner changes it, in the page.`);
  loops.remove(l.id);
  return ok(`Deleted ${l.id}.`);
});
const CronDelete: Tool = { name: "CronDelete", families: CLAUDE, readOnly: true, description: "Cancel a scheduled task by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, run: deleteRun };
const schedule_delete: Tool = { name: "schedule_delete", families: OTHERS, readOnly: true, description: "Cancel a scheduled task by its id.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, run: deleteRun };

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
  name: "PushNotification", families: CLAUDE, readOnly: true, description: notifyDesc,
  input_schema: { type: "object", properties: { message: { type: "string", description: "The notification text, one short line" } }, required: ["message"] }, run: notifyRun,
};
const notify: Tool = {
  name: "notify", families: OTHERS, readOnly: true, description: notifyDesc,
  input_schema: { type: "object", properties: { text: { type: "string", description: "The notification text, one short line" } }, required: ["text"] }, run: notifyRun,
};

// A skill with context: fork (Claude Code's skills frontmatter): its text is
// the task of an agent of the session, of the skill's `agent` type, on its
// `model`. In the background by default, its report waking the session as an
// agent's does; `background: false` waits for it in the call that loaded it.
skillRun.fork = async (ctx, skill, prompt) => {
  const fg = skill.fork?.background === false;
  try {
    const spawn = () => agents.spawn(ctx.sessionId, { title: `/${skill.name}`, prompt, type: skill.fork?.agent, model: skill.model, ...(skill.effort ? { effort: skill.effort } : {}), ...(skill.disallowed ? { disallowed: skill.disallowed } : {}), background: !fg, call_id: ctx.callId }, ctx.signal);
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
