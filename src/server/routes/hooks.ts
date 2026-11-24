// The owner's hooks joined to the turn loop and to what happens around it
// (a session ends, a notice is raised, a card is about to open), and the
// routes that list hook files and pin a repository's file. Which event fires
// where, what it carries and what its hooks can answer: README, Hooks.
import type { Deps, RouteModule } from "../app.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { toMessages } from "../../engine/turn.ts";
import type { Session, ToolResultBlock } from "../../core/types.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { contains } from "../../core/paths.ts";
import { Hooks, hookContext, hookFailureText, ifHolds, namesOf, ownerHooksPath, parseHooks, projectRoot, reaches, scriptsOf, SHOWN_MAX, skillHookTrust, stopBackground, type HookEvent, type HookResult } from "../../integrations/hooks.ts";
import { hooksOf, skillFilter, skillRun } from "../../tools/skills.ts";
import { choiceOf, disallowedWhy } from "../../tools/skill-turn.ts";
import type { Gate } from "../../safety/gate.ts";
import { gate as daemonGate, presence } from "./permissions.ts";
import { ownerStop, replaced } from "../../core/stoppers.ts";
import { HOOK_BLOCKED } from "../../core/stops.ts";
import { ranAs } from "../../core/ran-as.ts";
import { hookLine, sayAt } from "../../admin/daemon-log.ts";
import { reportedUsage } from "../../providers/reported.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

// A Stop hook sends the session back to work at most this many times in a row.
const STOP_LIMIT = 5;
export const HOOK_PREFIX = "[hook]";

// The call's input with the part the hook saw replaced. A dispatcher (mcp_call)
// shows its hooks the arguments of the tool it runs: those are replaced where
// they sit in its own input. Undefined: the part cannot be found, so the call
// cannot run changed.
export function changedInput(callInput: any, seen: any, updated: Record<string, unknown>): any {
  if (seen === callInput) return updated;
  if (!callInput || typeof callInput !== "object") return undefined;
  const key = Object.keys(callInput).find((k) => callInput[k] === seen);
  return key === undefined ? undefined : { ...callInput, [key]: updated };
}

// Keel's permission modes under the names hook scripts written for Claude Code
// and Codex read (`keel_permission_mode` carries Keel's own).
const MODE_NAMES: Record<string, string> = { ask: "default", "auto-edits": "acceptEdits", auto: "auto", "full-auto": "bypassPermissions", plan: "plan", "read-only": "plan", reviewer: "auto" };
// An alert's kind as a notification type of Claude Code's, where one fits; else the kind itself.
const NOTICE_TYPES: Record<string, string> = { approval: "permission_prompt", question: "agent_needs_input", finished: "idle_prompt" };
// How a turn's error reads as one of Claude Code's StopFailure error types.
export const ERROR_TYPES: Record<string, string> = { rate: "rate_limit", auth: "authentication_failed", quota: "billing_error", overloaded: "server_error", server: "server_error", network: "server_error", invalid: "invalid_request", context: "invalid_request" };
// The events of a tool call: a call is followed only when one of them has a hook.
const CALL_EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"];

// The owner runs a slash command: its UserPromptExpansion hooks, before the prompt it expands to is stored (set by hookRoutes).
export let promptExpansion: ((s: Session, command: { name: string; args: string; source: string; prompt: string }) => Promise<HookResult>) | undefined;

const textOf = (content: ToolResultBlock["content"]) => (typeof content === "string" ? content : content.map((b: any) => (b.type === "text" ? b.text : "")).join("\n"));

export const hookRoutes: RouteModule = (deps) => joinHooks(deps, daemonGate);

// `gate`: the permission gate the hooks answer to (the daemon's; a test gives its own).
export function joinHooks(deps: Deps, gate: Gate | undefined): ReturnType<RouteModule> {
  const { store, bus, engine, errors } = deps;
  // A hook that failed is one row in Errors, folded with its repeats: what failed, on which event, in which session.
  const hooks = new Hooks(store, (f) => errors.capture("tool", new Error(hookFailureText(f)), { hook: f.hook, event: f.event, session: f.session, ...(f.limit_s !== undefined ? { why: f.why } : {}) }));
  // An asyncRewake hook exited with code 2: the session is woken with its words, as a message stored before
  // anything else happens. A session the owner stopped is not started by it: it waits behind the hold.
  hooks.rewake = (s, text, event) => void (async () => {
    await store.warm(s.id, false).catch(() => {});
    const cur = store.session(s.id);
    if (!cur || cur.archived) return void errors.capture("tool", new Error(`A background ${event} hook exited with code 2 for a session that is ${cur ? "archived" : "gone"}`), { event, session: s.id });
    engine.message(s.id, `${HOOK_PREFIX} A background ${event} hook exited with code 2:\n${text}`, { kind: "hook", event });
  })().catch((e) => errors.capture("server", e, { at: "hook rewake", session: s.id }));
  const answered = new Set<string>(); // user events already given to UserPromptSubmit
  // The calls in flight that a hook follows: what the hooks see of it, and what PreToolUse left for later.
  // Kept by session and call id: a call id is its session's (two sessions can each have a call-1).
  type Followed = { session: string; name: string; input: any; names: string[]; context?: string[]; ask?: string; ms?: number };
  const calls = new Map<string, Followed>();
  const callKey = (sessionId: string, callId: string) => `${sessionId}\u0000${callId}`;
  const events = (id: string) => store.lineage(id); // kept by the store: no copy or walk of the session per request
  const note = (sid: string, event: string, lines: string[]) => {
    const ev = store.append(sid, "note", { text: hookContext(event, lines), model: true, hook: event });
    bus.emit({ t: "event", event: ev });
  };

  // What every event carries besides its own fields. Inside a subagent the
  // session is its parent's, as in Claude Code and Codex, and the agent is named.
  const agentOf = (id: string) => {
    try { return store.db.query<{ id: string; type: string }, [string]>("SELECT id, type FROM agents WHERE session_id = ?").get(id) ?? undefined; } catch { return undefined; }
  };
  const who = (s: Session): Record<string, unknown> => {
    const mode = gate?.perm(s.id).mode;
    // A title the owner or a hook gave (title_by empty, or "hook") is the session's custom title: a hook that names sessions can leave it be.
    const now = store.session(s.id) ?? s;
    const base = { ...(mode ? { permission_mode: MODE_NAMES[mode] ?? "default", keel_permission_mode: mode } : {}), ...((!now.title_by || now.title_by === "hook") && now.title ? { session_title: now.title } : {}) };
    if (!s.parent_id) return base;
    let root = s;
    for (let n = 0; root.parent_id && n < 32; n++) root = store.session(root.parent_id) ?? { ...root, parent_id: null };
    const a = agentOf(s.id);
    return { ...base, session_id: root.id, agent_id: a?.id ?? s.id, agent_type: a?.type ?? "general-purpose", agent_session_id: s.id };
  };
  const agentType = (s: Session) => agentOf(s.id)?.type ?? "general-purpose";
  const fire = (event: HookEvent, s: Session, payload: () => Record<string, unknown>, match?: string[], srcs?: ReturnType<Hooks["sources"]>, opts?: Parameters<Hooks["run"]>[5]) =>
    hooks.run(event, s, () => ({ ...who(s), ...payload() }), match, srcs, opts);
  // An event whose hooks are only told: nothing waits on them.
  const tell = (event: HookEvent, s: Session, payload: () => Record<string, unknown>, match?: string[]) =>
    void (async () => fire(event, s, payload, match))().catch((e) => errors.capture("server", e, { at: `hook ${event}`, session: s.id }));

  const lastReply = (id: string) => {
    const last = [...events(id)].reverse().find((e) => e.kind === "assistant");
    return (last?.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  };
  // Context a hook adds to a call's result, the model's to read.
  const add = (result: ToolResultBlock, event: string, lines: string[]) => {
    if (!lines.length) return;
    const block = hookContext(event, lines);
    if (typeof result.content === "string") result.content = `${result.content}\n\n${block}`;
    else result.content = [...result.content, { type: "text", text: block }];
  };
  // PostToolUse for a call that ran, PostToolUseFailure for one that failed.
  const afterCall = async (s: Session, callId: string, result: ToolResultBlock, error?: string) => {
    const c = calls.get(callKey(s.id, callId));
    if (!c) return;
    calls.delete(callKey(s.id, callId));
    const failed = error !== undefined || !!result.is_error;
    const event = failed ? "PostToolUseFailure" : "PostToolUse";
    const r = await fire(event, s, () => ({
      tool_name: c.name, tool_input: c.input, tool_use_id: callId, ...(c.ms !== undefined ? { duration_ms: c.ms } : {}),
      ...(failed ? { error: error ?? textOf(result.content).slice(0, 10_000), is_interrupt: false } : { tool_response: result.content }),
    }), c.names);
    const lines = [...(c.context ?? []), ...r.context, ...(r.block ? [`A hook says: ${r.block}`] : [])];
    add(result, r.context.length || r.block ? event : "PreToolUse", lines);
  };

  registerHooks({
    async beforeRequest(s, req) {
      // The prompt's hooks run for the turn request that answers it, not for a
      // summary or side request sent first: that one keeps its own messages.
      if (req.purpose !== "turn") return req;
      const evs = events(s.id);
      let i = evs.length - 1;
      // (A compaction at the turn's start is stored after the prompt it leaves whole.)
      while (i >= 0 && (evs[i]!.kind === "turn_start" || evs[i]!.kind === "note" || evs[i]!.kind === "compaction")) i--;
      const last = evs[i];
      if (last?.kind !== "user" || answered.has(last.id)) return req;
      answered.add(last.id);
      const text = String(last.data.text ?? "");
      const before = evs.findLastIndex((e, k) => k < i && e.kind === "user");
      // A session starts with its first prompt, and again after its context
      // was cleared or summarized: what a SessionStart hook told the model is
      // gone with a clear and only summarized by a compaction. A subagent
      // starts once, as SubagentStart.
      const since = before < 0 ? undefined : evs.findLast((e, k) => k > before && e.kind === "compaction");
      const source = before < 0 ? "startup" : since ? (since.data.mode === "clear" ? "clear" : "compact") : undefined;
      const startEvent = s.parent_id ? (before < 0 ? "SubagentStart" : undefined) : source ? "SessionStart" : undefined;
      const titled = s.parent_id ? undefined : store.session(s.id);
      const [start, prompt] = await Promise.all([
        startEvent === "SubagentStart" ? fire("SubagentStart", s, () => ({}), [agentType(s)]) : startEvent ? fire("SessionStart", s, () => ({ source }), [source!]) : null,
        fire("UserPromptSubmit", s, () => ({ prompt: text })),
      ]);
      // A name a hook gave the session is kept against a model's title (title_by "hook"). It replaces no title the owner
      // gave (one whose title_by is empty), and none that changed while the hook ran.
      const name = prompt.title ?? start?.title;
      const now = name && titled ? store.session(s.id) : undefined;
      if (name && now && !prompt.block && (!titled!.title || titled!.title_by) && now.title === titled!.title && now.title_by === titled!.title_by && now.title !== name)
        bus.emit({ t: "session", session: store.updateSession(s.id, { title: name, title_by: "hook" }) });
      if (prompt.block) {
        sayAt({ session: s.id }, hookLine({ event: "UserPromptSubmit", did: "refused the prompt", reason: prompt.block, title: s.title }), "warn");
        throw Object.assign(new Error(`A hook refused this prompt: ${prompt.block}`), { expected: true });
      }
      // What background hooks said since the last turn goes with this one, in the write that stores it.
      const owed = hooks.owed(s.id);
      const lines = [...(start?.context ?? []), ...prompt.context, ...owed.map((o) => `A background ${o.event} hook finished:\n${o.text}`)];
      if (!lines.length) return req;
      const label = [...new Set([...(start?.context.length ? [startEvent!] : []), ...(prompt.context.length ? ["UserPromptSubmit"] : []), ...owed.map((o) => o.event)])].join(", ");
      const ev = store.atomic(s.id, () => {
        const ev = store.append(s.id, "note", { text: hookContext(label, lines), model: true, hook: label });
        hooks.settle(owed.map((o) => o.id));
        return ev;
      });
      bus.emit({ t: "event", event: ev });
      return { ...req, messages: toMessages(events(s.id)) };
    },
    // PreToolUse runs before every gate: a call a hook changed is judged as changed.
    async prepareTool(s, call) {
      // A session with no hook on a call's events pays one look at the hook files' text, and nothing more.
      if (!hooks.namesFor(s, ...CALL_EVENTS)) return;
      const srcs = hooks.sources(s.workspace, true, s.id);
      const live = hooks.events(s.workspace, srcs);
      if (!CALL_EVENTS.some((e) => live.has(e))) return;
      // (With the session: a tool only this session is offered, an editor's own server's, is found for it.)
      const target = call.tool.target ? await call.tool.target(call.input, s.id) : null;
      const name = target?.name ?? call.tool.name;
      const input = target ? target.input : call.input;
      const c: Followed = { session: s.id, name, input, names: namesOf(name, input, call.tool.name) };
      calls.set(callKey(s.id, call.id), c);
      const r = await fire("PreToolUse", s, () => ({ tool_name: name, tool_input: input, tool_use_id: call.id }), c.names, srcs);
      // A hook of the call that failed (ran into its time limit) is said under the call, not only in Errors.
      if (r.failed?.length) call.hook = { ...call.hook, failed: [...(call.hook?.failed ?? []), ...r.failed] };
      if (r.block) {
        sayAt({ session: s.id }, hookLine({ event: "PreToolUse", did: `refused ${name}`, reason: r.block, title: s.title }), "warn");
        return { deny: `${HOOK_BLOCKED}: ${r.block}` };
      }
      if (r.context.length) c.context = r.context;
      if (r.ask) c.ask = r.ask;
      const changed = r.input === undefined ? undefined : changedInput(call.input, input, r.input);
      if (r.input !== undefined && changed === undefined) return { deny: `A hook changed the input of ${name}, which ${call.tool.name} cannot run changed.` };
      // The later events of the call carry the input that ran.
      if (r.input !== undefined) c.input = r.input;
      return changed !== undefined || r.allow !== undefined ? { input: changed, allow: r.allow } : undefined;
    },
    // A hook's ask goes to the owner after the gate let the call through (a call the gate refuses asks nobody).
    async beforeTool(s, call) {
      const c = calls.get(callKey(s.id, call.id));
      if (c?.ask === undefined) return;
      const ask = c.ask;
      c.ask = undefined;
      if (!gate) return { deny: `A hook asks the owner about this call (${ask}), and no one can be asked here.` };
      const d = await gate.askForHook(s, call, c.name, ask);
      if (d) return d;
    },
    toolRan(s, call, _result, ran) {
      const c = calls.get(callKey(s.id, call.id));
      if (c) c.ms = ran.ms;
    },
    afterTool: (s, call, result) => afterCall(s, call.id, result),
    toolFailed: (s, call, result, error) => afterCall(s, call.id, result, error.message),
    // A step's calls have all returned: PostToolBatch, before the next model request.
    async stepDone(s) {
      const r = await fire("PostToolBatch", s, () => {
        const evs = events(s.id);
        const at = evs.findLastIndex((e) => e.kind === "assistant");
        const uses = at < 0 ? [] : (evs[at]!.data.blocks as any[]).filter((b) => b.type === "tool_use");
        const results = new Map<string, any>(evs.slice(at + 1).flatMap((e) => (e.kind === "tool_result" ? e.data.results.map((x: any) => [x.tool_use_id, x] as [string, any]) : [])));
        return { tool_calls: uses.map((u) => ({ tool_name: ranAs(u, results.get(u.id)), tool_input: u.input, tool_use_id: u.id, tool_response: results.get(u.id)?.content ?? null })) };
      });
      if (r.context.length) note(s.id, "PostToolBatch", r.context);
      // A hook that blocks here ends the turn before the next model request, as a stop of the owner's does.
      if (r.block) {
        note(s.id, "PostToolBatch", [`A hook stopped the turn: ${r.block}`]);
        sayAt({ session: s.id }, hookLine({ event: "PostToolBatch", did: "stopped the turn", reason: r.block, title: s.title }), "warn");
        void engine.interrupt(s.id, "hook").catch((e) => errors.capture("server", e, { at: "hook PostToolBatch", session: s.id }));
      }
    },
    async turnEnd(s, reason) {
      for (const [id, c] of calls) if (c.session === s.id) calls.delete(id); // calls a gate refused, or a stop cut
      // The owner stopped a turn of the session itself, with their Stop or with a message of theirs that
      // took its place (not a subagent's turn, and not a stop by anything else: a hook's own, an archive).
      if (reason === "interrupted") {
        const by = events(s.id).findLast((e) => e.kind === "turn_end")?.data.stopped_by;
        if (!s.parent_id && (ownerStop(by) || replaced(by))) tell("Interrupt", s, () => ({}));
        return;
      }
      if (reason === "error" || reason === "max_tokens") {
        // The error is stored once the turn has closed, after these hooks: its event is waited for, briefly.
        const failure = () => { const evs = events(s.id); return evs.slice(evs.findLastIndex((e) => e.kind === "turn_start") + 1).findLast((e) => e.kind === "error"); };
        return void (async () => {
          let err = failure();
          for (let i = 0; reason === "error" && !err && i < 40; i++) { await Bun.sleep(25); err = failure(); }
          const type = reason === "max_tokens" ? "max_output_tokens" : ERROR_TYPES[String(err?.data.kind ?? "")] ?? "unknown";
          await fire("StopFailure", s, () => ({ error: type, error_details: err ? String(err.data.message ?? "") : undefined, last_assistant_message: lastReply(s.id) }), [type]);
        })().catch((e) => errors.capture("server", e, { at: "hook StopFailure", session: s.id }));
      }
      if (reason !== "end_turn") return;
      // A subagent's turn end is told as SubagentStop: its report is already on its way to its parent.
      if (s.parent_id) return tell("SubagentStop", s, () => ({ stop_hook_active: false, agent_transcript_path: null, last_assistant_message: lastReply(s.id) }), [agentType(s)]);
      // How often in a row a Stop hook already sent this session back: read off
      // the branch (the prompts a hook queued since the last one of anyone
      // else's), so a daemon restart in between starts no new five. The
      // harness's own prompts (a continuation after a restart) are nobody's new words.
      let n = 0;
      const evs = events(s.id);
      for (let i = evs.length - 1; i >= 0; i--) {
        const e = evs[i]!;
        if (e.kind !== "user" || e.data.origin === "restart" || e.data.origin === "harness") continue;
        if (e.data.origin !== "hook") break;
        n++;
      }
      const r = await fire("Stop", s, () => ({ stop_hook_active: n > 0, last_assistant_message: lastReply(s.id) }));
      if (!r.continueWith) return;
      if (n >= STOP_LIMIT) return note(s.id, "Stop", [`A Stop hook asked to go on ${n} times in a row; Keel stops here.`]);
      // Queued: the next turn starts when this one has ended.
      try { engine.send(s.id, `${HOOK_PREFIX} ${r.continueWith}`, { mode: "queue", meta: { origin: "hook" } }); } catch (e) { errors.capture("server", e, { at: "stop hook" }); }
    },
    async beforeCompact(s, why) {
      const trigger = why && !why.auto ? "manual" : "auto";
      await fire("PreCompact", s, () => ({ trigger, custom_instructions: why?.focus ?? null }), [trigger]);
    },
    afterCompact(s, ev) {
      const trigger = ev.data.auto ? "auto" : "manual";
      tell("PostCompact", s, () => ({ trigger, compact_summary: String(ev.data.summary ?? "") }), [trigger]);
    },
    // Every request to a model, a retry too, and how it ended: told only (Codex's two events).
    requestSent: (s, req) => tell("PreModelRequest", s, () => ({ model: req.model, purpose: req.purpose ?? "turn" })),
    requestDone: (s, req, res) => tell("PostModelRequest", s, () => ({ model: req.model, purpose: req.purpose ?? "turn", status: "completed", error: null, token_usage: res.usage })),
    requestWaiting: (s, req) => tell("PostModelRequest", s, () => ({ model: req.model, purpose: req.purpose ?? "turn", status: "waiting", error: null, token_usage: null })),
    requestFailed: (s, req, err, aborted) => tell("PostModelRequest", s, () => ({ model: req.model, purpose: req.purpose ?? "turn", status: aborted ? "cancelled" : "failed", error: aborted ? null : String((err as Error)?.message ?? err).slice(0, 2000), token_usage: reportedUsage(err) ?? null })),
  });

  // The scripts the session's hooks run are the owner's alone to change.
  if (gate) gate.hookFiles = (s) => hooks.runsFrom(s.workspace, s.id);

  // A skill's frontmatter hooks (src/integrations/hooks.ts, Skills): registered when a session
  // invokes the skill, run while the owner trusts a repository's skill as it is now, and gone with a clear.
  skillHookTrust.trusted = (dir) => skillFilter.ownerDigest?.(dir) ?? null;
  skillHookTrust.digest = (dir) => skillFilter.digest?.(dir) ?? null;
  skillHookTrust.read = (file) => { try { return hooksOf(readFileSync(file, "utf8")); } catch (e) { return { problem: `its file cannot be read: ${(e as Error).message}` }; } };
  // A skill's disallowed-tools: refused for the rest of the turn that loaded it (src/tools/skill-turn.ts).
  registerHooks({
    beforeTool: async (s, call) => {
      if (!choiceOf(s.id)?.disallowed.length) return undefined;
      // A dispatched call (mcp_call) answers to the tool it runs too.
      const target = call.tool.target ? await call.tool.target(call.input, s.id) : null;
      const input = target ? target.input : call.input;
      const names = namesOf(target?.name ?? call.tool.name, input, call.tool.name);
      const why = disallowedWhy(s.id, names, (rule) => ifHolds(rule, names, input, call.ctx.cwd));
      return why ? { deny: why } : undefined;
    },
  });
  // A server's question to the owner (MCP elicitation): Elicitation before its card opens, ElicitationResult once it is
  // answered. A hook answers by `hookSpecificOutput.action` (and `content`), or declines with exit code 2. What is
  // logged is the server and the names of the fields, never a value the owner or a hook typed.
  registerHooks({
    async elicitation(sessionId, ask, signal) {
      const s = store.session(sessionId);
      if (!s) return;
      const r = await fire("Elicitation", s, () => ({
        mcp_server_name: ask.server, message: ask.message, mode: ask.mode,
        ...(ask.url ? { url: ask.url } : {}), ...(ask.id ? { elicitation_id: ask.id } : {}), ...(ask.schema !== undefined ? { requested_schema: ask.schema } : {}),
      }), [ask.server], undefined, { signal });
      const answer = r.block ? { action: "decline" as const } : r.elicit;
      if (answer) sayAt({ session: s.id }, hookLine({ event: "Elicitation", did: `${{ accept: "answered", decline: "declined", cancel: "cancelled" }[answer.action]} a request of ${ask.server}`, reason: r.block ?? `answered ${answer.action}${answer.content ? ` with the fields ${Object.keys(answer.content).join(", ")}` : ""}`, title: s.title }));
      return answer;
    },
    async elicitationResult(sessionId, ask, now, signal) {
      const s = store.session(sessionId);
      if (!s) return;
      const r = await fire("ElicitationResult", s, () => ({
        mcp_server_name: ask.server, mode: ask.mode, action: now.action, fields: ask.fields, ...(ask.id ? { elicitation_id: ask.id } : {}),
      }), [ask.server], undefined, { signal, ...(now.content && !ask.sensitive ? { ownerOnly: { content: now.content } } : {}) });
      const answer = r.block ? { action: "decline" as const } : r.elicit;
      if (answer) sayAt({ session: s.id }, hookLine({ event: "ElicitationResult", did: `changed an answer to ${ask.server}`, reason: r.block ?? `changed ${now.action} to ${answer.action}${answer.content ? ` with the fields ${Object.keys(answer.content).join(", ")}` : ""}`, title: s.title }));
      return answer;
    },
  });
  skillRun.hooks = (sid, skill, raw) => hooks.addSkill(sid, skill, raw);
  const g0 = globalThis as { __keelSkillHooksOff?: () => void };
  g0.__keelSkillHooksOff?.();
  g0.__keelSkillHooksOff = bus.on((f) => {
    if (f.t === "event" && f.event.kind === "compaction" && f.event.data?.mode === "clear") hooks.dropSkills(f.event.session_id);
  });

  // A card is about to open: PermissionRequest. A deny refuses the call; an
  // allow answers a low-risk card and no other (the gate decides which).
  if (gate) gate.requestHook = async (s, call, _name, ask) => {
    const c = calls.get(callKey(s.id, call.id));
    if (!c) return;
    const r = await fire("PermissionRequest", s, () => ({ tool_name: c.name, tool_input: c.input, keel_risk: ask.risk, keel_reason: ask.why ?? null, keel_rule: ask.rule ?? null }), c.names);
    if (r.block) {
      sayAt({ session: s.id }, hookLine({ event: "PermissionRequest", did: `denied ${c.name}`, reason: r.block, title: s.title }), "warn");
      return { deny: `A hook denied this request: ${r.block}` };
    }
    if (r.allow !== undefined) return { allow: true };
  };

  promptExpansion = (s, command) =>
    fire("UserPromptExpansion", s, () => ({ expansion_type: "slash_command", command_name: command.name, command_args: command.args, command_source: command.source, prompt: command.prompt }), [command.name]);

  // What happens outside a turn: a session ends, a notice is raised, a call is refused without the owner.
  const live = new Set(store.db.query<{ id: string }, []>("SELECT id FROM sessions WHERE archived = 0").all().map((r) => r.id));
  const noticed = new Set<string>();
  const g = globalThis as { __keelHookFrames?: () => void };
  g.__keelHookFrames?.(); // under `bun --hot` this module runs again
  g.__keelHookFrames = bus.on((f) => {
    if (f.t === "session") {
      const s = f.session;
      if (!f.deleted && !s.archived) return void live.add(s.id);
      // Archived or deleted: its background hooks end (a subagent's too), and nothing they would say is owed.
      stopBackground(s.id);
      // The session ended, once. A subagent's end is its SubagentStop.
      if (live.delete(s.id) && !s.parent_id) tell("SessionEnd", s, () => ({ reason: "other", keel_reason: f.deleted ? "deleted" : "archived" }), ["other"]);
      return;
    }
    if (f.t !== "feature") return;
    if (f.name === "automation" && f.data?.kind === "alert") {
      // An alert: raised once, sent again as its delivery settles.
      const a = f.data.data as { id: string; kind: string; session_id: string | null; title: string; body: string };
      const s = a?.session_id ? store.session(a.session_id) : undefined;
      if (!s || noticed.has(a.id)) return;
      noticed.add(a.id);
      if (noticed.size > 1000) noticed.delete(noticed.values().next().value!);
      const type = NOTICE_TYPES[a.kind] ?? a.kind;
      tell("Notification", s, () => ({ message: a.body ? `${a.title}: ${a.body}` : a.title, title: a.title, notification_type: type, keel_kind: a.kind }), [type]);
      return;
    }
    if (f.name === "blocked" && f.session_id && !f.data?.retry) {
      // The judge or the reviewer refused a call without the owner: PermissionDenied.
      const id = (f.data.calls as string[] | undefined)?.at(-1);
      const c = id ? calls.get(callKey(f.session_id, id)) : undefined;
      const s = c && store.session(f.session_id);
      if (s && c) tell("PermissionDenied", s, () => ({ tool_name: c.name, tool_input: c.input, tool_use_id: id, reason: String(f.data.reason ?? "") }), c.names);
    }
  });

  const workspaces = () => [...new Set(store.sessions({}).map((s) => projectRoot(s.workspace)).concat(projectRoot(deps.workspace)))];
  // A file as the page shows it: whole (or said not to be), with what loads and never runs, and where its hooks send things.
  // (`unheld`: the scripts a repository's commands run from outside .keel/ and .claude/, which its pin does not hold.)
  const shown = (cwd: string) => hooks.sources(cwd).map(({ groups, ...rest }) => ({
    ...rest, text: rest.text.slice(0, SHOWN_MAX), whole: rest.text.length <= SHOWN_MAX, notes: [...(rest.text ? parseHooks(rest.text).notes : []), ...hooks.said(rest.path)], reaches: reaches(groups),
    unheld: rest.scope !== "project" ? [] : scriptsOf(rest.root, groups).filter((f) => ![".keel", ".claude"].some((d) => contains(join(rest.root, d), f)) && existsSync(f)).map((f) => (contains(rest.root, f) ? relative(rest.root, f) : f)),
  }));

  return {
    "/api/hooks": {
      GET: (req: Request) => {
        const cwd = new URL(req.url).searchParams.get("cwd");
        if (cwd) return json({ sources: shown(cwd), owner_path: ownerHooksPath() });
        // Every folder Keel has sessions in: the owner's file once, each repository's file.
        const seen = new Set<string>();
        const sources = workspaces().flatMap((w) => shown(w)).filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
        return json({ sources, owner_path: ownerHooksPath() });
      },
    },
    "/api/hooks/trust": {
      POST: async (req: Request) => {
        // From a remote device, pinning a hook file (it will run commands) needs the owner's passkey.
        if (presence && !presence.allows(req, "hooks-trust")) return json({ error: "this needs your passkey from a remote device", presence: { action: "hooks-trust" } }, 428);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as any;
        if (typeof b.sha256 !== "string") return bad("give the sha256 of the file you read");
        const cwd = typeof b.cwd === "string" ? b.cwd : deps.workspace;
        const err = hooks.pin(cwd, b.sha256);
        return err ? bad(err, 409) : json({ sources: shown(cwd) });
      },
    },
  };
}
