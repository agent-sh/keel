import type { Tool, ToolContext, ToolOutput } from "../tools/types.ts";
import { fail, ok } from "../tools/types.ts";
import * as agents from "./agents.ts";
import * as alerts from "./alerts.ts";
import * as loops from "./loops.ts";
import { toolsFor } from "../tools/registry.ts";
import { D, familyOf } from "./core.ts";
import * as waits from "./waits.ts";
import { privateHost } from "../tools/web.ts";

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

function waitResult(w: waits.WaitRecord, extra = "") {
  const when = w.kind === "timer" ? `at ${new Date((w.spec as any).at_ms).toLocaleTimeString()}` : `deadline in ${Math.round((w.deadline - Date.now()) / 1000)} s`;
  return ok(`Scheduled ${w.kind} wait ${w.id} (${when}). It costs no tokens while it waits; the session is woken when it fires, times out or is cancelled. End your turn now unless you have other work.${extra}`);
}

// --- subagents ---------------------------------------------------------------

// An agent on another machine of the fleet. Starting work there is the gate's
// call as keel__spawn_on_machine, and a standing answer covers one machine.
const MACHINE_PROPS = {
  machine: { type: "string", description: "Run the agent's tools on this machine of the fleet (a name from keel__machines_list). Omit to run where you run. Send it files with keel__send_files." },
  cwd: { type: "string", description: "With machine: the directory there, inside its granted directory (default: the granted directory)" },
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
  families: CLAUDE,
  readOnly: true,
  description:
    "Launch a subagent: a separate session with its own context that works on one task and returns a report. " +
    "Use it for independent work that can run beside yours, or a broad search whose file dumps you do not need. Send several Agent calls in one message to run them in parallel. " +
    "The agent sees none of this conversation: the prompt must say everything it needs. By default the call blocks until the agent reports; with run_in_background the call returns at once and the report arrives later as a message (do not poll it). " +
    "Types: general-purpose (all tools, default), Explore (read-only search); more may be listed in the system prompt. A subagent cannot start agents. " +
    "In a git repository an agent that can edit works in its own worktree on its own branch and commits there; its report names the branch to merge. isolation: \"none\" makes it edit your checkout instead. " +
    "output_schema (a JSON schema) makes its report one JSON value that matches it.",
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
      ...MACHINE_PROPS,
    },
    required: ["description", "prompt"],
  },
  target: (input) => onMachine(input, input.prompt),
  run: (input, ctx) => guard(async () => {
    const a = await agents.spawn(ctx.sessionId, { title: input.description, prompt: input.prompt, type: input.subagent_type, model: input.model, background: !!input.run_in_background, isolation: input.isolation, output_schema: input.output_schema, machine: input.machine, cwd: input.cwd }, ctx.signal);
    if (input.run_in_background) return ok(`Started agent ${a.id} (${a.title}) in the background. Its report arrives as a message when it finishes; do other work or end your turn.`);
    if (a.status === "waiting") return ok(`Agent ${a.id} is waiting on a scheduled wait and goes on in the background; its report arrives later.\n\nSo far:\n${a.result ?? ""}`);
    return a.status === "completed" ? ok(agents.reportBlock(a)) : fail(agents.reportBlock(a));
  }),
};

const SendMessage: Tool = {
  name: "SendMessage",
  families: CLAUDE,
  readOnly: true,
  description: "Send a message to one of your subagents by agent id or description: it steers a running agent (after its current step) or continues a finished one with its context. Its next report arrives as a message.",
  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The agent id or description" },
      message: { type: "string", description: "The message" },
      summary: { type: "string", description: "A 5-10 word preview of the message" },
    },
    required: ["to", "message"],
  },
  run: (input, ctx) => guard(async () => {
    const a = await agents.send(agents.resolveTarget(ctx.sessionId, String(input.to ?? input.agent_id)).id, String(input.message));
    return ok(`Sent to ${a.id}. Its report arrives as a message.`);
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
    if (w?.session_id === ctx.sessionId) return waits.cancel(id, ctx.sessionId) ? ok(`Cancelled ${id}.`) : fail(`No active wait ${id}.`);
    const a = agents.list(ctx.sessionId).find((x) => x.id === id || x.session_id === id);
    if (!a) return orig(input, ctx);
    const r = agents.stop(a.id)!;
    return ok(`Stopping ${a.id}; it was ${a.status}.${r.result ? `\n\nSo far:\n${r.result}` : ""}`);
  });
}

const spawn_agent: Tool = {
  name: "spawn_agent",
  families: OTHERS,
  readOnly: true,
  description:
    "Spawn a sub-agent for a well-scoped task. Returns the spawned agent id. The agent works in the background in its own session; its final answer arrives as a message when it finishes, or call wait_agent when you are blocked on it. " +
    "Spawn several in one round for independent subtasks with disjoint write scopes. Spawned agents use your current model unless model names another. A sub-agent cannot spawn agents. " +
    "Agent types: general-purpose (default), Explore (read-only). In a git repository an agent that can edit gets its own worktree and branch (isolation: \"none\" shares your checkout); its result names the branch to merge. output_schema makes its final answer one JSON value matching that schema.",
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Initial plain-text task for the new agent." },
      agent_type: { type: "string", description: "Agent type for the new agent. Omit for general-purpose." },
      fork_context: { type: "boolean", description: "True starts the agent with a copy of this conversation; false or omitted starts it with only the task." },
      model: { type: "string", description: "Model override for the new agent. Omit unless an explicit override is needed." },
      isolation: { type: "string", enum: ["worktree", "none"], description: "worktree (default for agents that edit, in a git repository) or none (edit this checkout)." },
      output_schema: { type: "object", description: "JSON schema the agent's final answer must match." },
      ...MACHINE_PROPS,
    },
    required: ["message"],
  },
  target: (input) => onMachine(input, input.message ?? input.prompt),
  run: (input, ctx) => guard(async () => {
    const a = await agents.spawn(ctx.sessionId, { prompt: input.message ?? input.prompt, type: input.agent_type, model: input.model, fork: !!input.fork_context, background: true, isolation: input.isolation, output_schema: input.output_schema, machine: input.machine, cwd: input.cwd }, ctx.signal);
    return ok(JSON.stringify({ agent_id: a.id, nickname: a.title }));
  }),
};

const send_input: Tool = {
  name: "send_input",
  families: OTHERS,
  readOnly: true,
  description: "Send a message to an existing agent. Use interrupt=true to redirect its work immediately; otherwise it is handled after its current step. A finished agent continues with its context.",
  input_schema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Agent id to message (from spawn_agent)." },
      message: { type: "string", description: "Message to send to the agent." },
      interrupt: { type: "boolean", description: "True interrupts the current task and handles this message immediately." },
    },
    required: ["target", "message"],
  },
  run: (input, ctx) => guard(async () => {
    const a = await agents.send(agents.resolveTarget(ctx.sessionId, String(input.target)).id, String(input.message), !!input.interrupt);
    return ok(JSON.stringify({ submission_id: `${a.id}-${Date.now()}` }));
  }),
};

const wait_agent: Tool = {
  name: "wait_agent",
  families: OTHERS,
  readOnly: true,
  description: "Wait for agents to reach a final status and return their final messages. Results returned here are not delivered again. Call it sparingly, only when your next step is blocked on the result.",
  input_schema: {
    type: "object",
    properties: {
      targets: { type: "array", items: { type: "string" }, description: "Agent ids to wait on; omit for every running agent." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 300000, max 3600000." },
    },
  },
  run: (input, ctx) => guard(async () => {
    const t = Math.min(Math.max(Number(input.timeout_ms ?? 300_000), 1000), 3_600_000);
    const res = await agents.waitAll(ctx.sessionId, input.targets, t, ctx.signal);
    const status: Record<string, unknown> = {};
    for (const a of res) status[a.id] = agents.isEnded(a) ? (a.status === "completed" ? { completed: a.result } : a.status === "failed" ? { errored: a.result } : { completed: `[${a.status}] ${a.result ?? ""}` }) : a.status;
    return ok(JSON.stringify({ status, timed_out: res.some((a) => !agents.isEnded(a)) }));
  }),
};

const close_agent: Tool = {
  name: "close_agent",
  families: OTHERS,
  readOnly: true,
  description: "Stop an agent that is no longer needed and return its previous status.",
  input_schema: { type: "object", properties: { target: { type: "string", description: "Agent id to close (from spawn_agent)." } }, required: ["target"] },
  run: (input, ctx) => guard(() => {
    const a = agents.resolveTarget(ctx.sessionId, String(input.target));
    agents.stop(a.id);
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
  const spec = waits.normalize(input, ctx.cwd);
  if (waits.isMonitor(spec.kind)) return fail("Use the monitor tool for a command's output or a socket.");
  // The model's http wait follows web fetch's address rules (the wait tool runs unasked, as a read).
  if (spec.kind === "http" && privateHost(new URL(spec.url).hostname))
    return fail(`${new URL(spec.url).hostname} is a local or private address; watch a local server with the monitor tool and a command such as curl.`);
  return waitResult(waits.create(ctx.sessionId, spec, { timeout_seconds: input.timeout_seconds, note: input.note }));
});

const waitDesc =
  "Wait without spending tokens: the daemon checks a condition (a timer, a file appearing or containing text, a new log line matching a pattern, an HTTP status, a process ending, every check of a GitHub pull request finishing) and wakes this session with the result when it holds or the timeout passes. " +
  "Use it instead of sleep or polling loops. It returns at once; end your turn after it unless you have other work.";

// A pull request wait runs gh with the owner's login against a repository the
// model names: the gate judges it as its own tool (wait_pr_checks), so it asks
// where other actions ask and the owner can allow it by that name.
const waitTarget = async (input: any) =>
  input?.kind === "pr_checks" || input?.spec?.kind === "pr_checks" ? { name: "wait_pr_checks", readOnly: false, input, cls: { kind: "other" as const } } : null;
const WaitFor: Tool = { name: "WaitFor", families: CLAUDE, readOnly: true, description: waitDesc, input_schema: waitSchema, run: waitRun, target: waitTarget };
const wait_for: Tool = { name: "wait_for", families: OTHERS, readOnly: true, description: waitDesc, input_schema: waitSchema, run: waitRun, target: waitTarget };

const cancel_wait: Tool = {
  name: "cancel_wait",
  families: OTHERS,
  readOnly: true,
  description: "Cancel a wait or monitor of this session by its id.",
  input_schema: { type: "object", properties: { wait_id: { type: "string" } }, required: ["wait_id"] },
  run: (input, ctx) => guard(() => (waits.cancel(String(input.wait_id), ctx.sessionId) ? ok("Cancelled.") : fail(`No wait ${input.wait_id} in this session.`))),
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
  const next = l.next_ms ? new Date(l.next_ms).toLocaleString() : "-";
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
  return ok(`Scheduled ${loop.id}: ${loop.schedule_text}, next run ${loop.next_ms ? new Date(loop.next_ms).toLocaleString() : "-"}. Recurring tasks expire after 7 days.`);
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

export const automationTools: Tool[] = [
  Agent, SendMessage, WaitFor, Monitor, ScheduleWakeup, CronCreate, CronList, CronDelete, PushNotification,
  spawn_agent, send_input, wait_agent, close_agent, wait_for, cancel_wait, monitor, schedule_wakeup, schedule_create, schedule_list, schedule_delete, notify,
];

export const AGENT_TOOL_NAMES = ["Agent", "spawn_agent"];
