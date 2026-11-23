// keel-bun as an ACP client: a session whose model is `acp:<agent>` is
// answered by that agent (Claude Agent, Codex, Gemini CLI, OpenCode, any agent
// of the ACP registry). One agent process per session, kept while the session
// lives; the agent keeps its own history, so each turn sends only the owner's
// new words. What it streams becomes ordinary keel events (replies, thinking,
// tool calls with their results, plans, usage), its permission requests are
// judged by keel's gate (the session's mode and grants, else a card the owner
// answers), and it reads and writes files through keel, judged the same way.
//
// It is offered Keel's tools (the owner's MCP servers, src/acp/served.ts) as
// an MCP server of its session, and runs its commands in terminals of Keel's
// (src/acp/terminals.ts), both judged and run as the session's own would be.
//
// Spec: agentclientprotocol.com/protocol/v1 (initialize, session/new, load,
// resume, prompt, cancel, close; session/update, session/request_permission,
// fs/read_text_file, fs/write_text_file, terminal/* toward the client).
import { heldFile, heldWrite } from "../core/store-files.ts";
import type { AgentConfinement, Give } from "./confine.ts";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { atCwd, realOf } from "../core/paths.ts";
import { hold } from "../tools/files.ts";
import type { Store } from "../core/store.ts";
import { emptyUsage, type Session, type StoredEvent, type ToolResultBlock, type Usage } from "../core/types.ts";
import type { ExternalIO } from "../engine/hooks.ts";
import { shellText, type CallClass } from "../safety/policy.ts";
import type { AcpAgent, AcpAgents } from "./agents.ts";
import { AcpConnection } from "./rpc.ts";
import { commandsOf, heldSwitch, mergeChoices, pickable, settle, splitModel, unknownCurrent, withOptions, type AgentChoices, type SlashCommand, type Switch } from "./choices.ts";
import { catalogTools } from "../tools/catalog.ts";
import { clearServed, SERVED_NAME, ServedTools, type ServedTool } from "./served.ts";
import { AcpTerminals } from "./terminals.ts";

// Terminals for the agent, when the gate runs: `answered` is told each command the agent asked about and was allowed.
export type Terminals = { answered(sessionId: string, command: string): void };

type Json = any;
export const ACP_PREFIX = "acp:";
export const isAcpModel = (model: string) => model.startsWith(ACP_PREFIX);
// The agent of an `acp:` model, and the model (or mode) of it the session chose (choices.ts).
export const agentOf = (model: string) => splitModel(model.slice(ACP_PREFIX.length)).agent;

// What judges a request of the agent: the gate's answer for a call of this class.
export type Judge = (s: Session, call: { id: string; name: string; cls: CallClass; input: Json; signal: AbortSignal }) => Promise<{ deny: string } | void>;

// The class of an agent's tool call, from its ACP kind and what it names.
export function classOf(tc: Json, cwd: string): CallClass {
  const raw = tc.rawInput ?? {};
  const paths = [...(tc.locations ?? []).map((l: Json) => l?.path), raw.file_path, raw.path, raw.filePath]
    .filter((p): p is string => typeof p === "string" && !!p).map((p) => atCwd(cwd, p));
  switch (tc.kind) {
    case "read": case "search": case "think":
      // (With what it names: a read is judged by its files.)
      return paths.length ? { kind: "read", paths: [...new Set(paths)] } : { kind: "read" };
    case "edit": case "delete": case "move":
      return paths.length ? { kind: "edit", paths: [...new Set(paths)] } : { kind: "other" };
    case "execute": {
      // An argument list is quoted word by word: joined bare, a word with a quote or a space would read as other words.
      const command = shellText(raw) ?? (typeof tc.title === "string" ? tc.title : "");
      return command ? { kind: "shell", command } : { kind: "other" };
    }
    default:
      return { kind: "other" };
  }
}

// An agent's call as a keel tool call, named as the keel tool of its kind so the
// transcript shows it as such (the agent's own title rides along).
export function asToolUse(tc: Json): { name: string; input: Json } {
  const raw = tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput : {};
  const title = typeof tc.title === "string" ? tc.title : "";
  const path = tc.locations?.[0]?.path ?? raw.file_path ?? raw.path ?? raw.filePath;
  const diff = (tc.content ?? []).find((c: Json) => c?.type === "diff");
  switch (tc.kind) {
    case "execute": {
      const c = raw.command ?? raw.cmd;
      const command = typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : title;
      return { name: "Bash", input: { ...raw, command, ...(title && title !== command && /\s/.test(title) ? { description: title } : {}) } };
    }
    case "read":
      return path ? { name: "Read", input: { ...raw, file_path: path } } : { name: title || "read", input: raw };
    case "edit":
      if (diff) return diff.oldText == null ? { name: "Write", input: { file_path: diff.path, content: diff.newText ?? "" } } : { name: "Edit", input: { file_path: diff.path, old_string: diff.oldText, new_string: diff.newText ?? "" } };
      return path ? { name: "Edit", input: { ...raw, file_path: path } } : { name: title || "edit", input: raw };
    case "search":
      return { name: "Grep", input: { ...raw, pattern: raw.pattern ?? raw.query ?? title } };
    case "fetch":
      return { name: "WebFetch", input: { ...raw, url: raw.url ?? title } };
    default:
      return { name: String(tc.name ?? title ?? tc.kind ?? "tool") || "tool", input: { ...raw, ...(title ? { title } : {}) } };
  }
}

// What a finished call left: its content blocks as a keel result.
// `terminal`: what a terminal it embeds shows now (its command and output).
export function resultOf(tc: Json, terminal: (id: string) => string | undefined = () => undefined): ToolResultBlock {
  const out: ({ type: "text"; text: string } | { type: "image"; media_type: string; data: string })[] = [];
  for (const c of tc.content ?? []) {
    if (c?.type === "content" && c.content?.type === "text" && c.content.text) out.push({ type: "text", text: c.content.text });
    else if (c?.type === "content" && c.content?.type === "image" && c.content.data) out.push({ type: "image", media_type: c.content.mimeType, data: c.content.data });
    else if (c?.type === "diff") out.push({ type: "text", text: `${c.oldText == null ? "Wrote" : "Edited"} ${c.path}` });
    else if (c?.type === "terminal") out.push({ type: "text", text: terminal(String(c.terminalId)) ?? `[terminal ${c.terminalId}]` });
  }
  if (!out.length && tc.rawOutput !== undefined) out.push({ type: "text", text: typeof tc.rawOutput === "string" ? tc.rawOutput : JSON.stringify(tc.rawOutput) });
  const failed = tc.status === "failed";
  return { type: "tool_result", tool_use_id: tc.toolCallId, content: out.length ? out : failed ? "Failed." : "Done.", is_error: failed || undefined };
}

// The owner's words since the agent last answered: the user events after the last turn_end.
export function promptOf(events: readonly StoredEvent[]): Json[] {
  let from = events.length;
  while (from > 0 && events[from - 1]!.kind !== "turn_end") from--;
  const blocks: Json[] = [];
  for (const e of events.slice(from)) {
    if (e.kind !== "user" || e.data.origin === "harness") continue;
    for (const b of e.data.images ?? []) {
      if (b?.type === "image" && b.data) blocks.push({ type: "image", mimeType: b.media_type, data: b.data });
      else if (b?.type === "attachment") blocks.push({ type: "text", text: `[attached file ${b.name}: not sent to this agent]` });
    }
    if (e.data.text) blocks.push({ type: "text", text: String(e.data.text) });
  }
  return blocks;
}

// A call that says what it does: its input or a place. Content while it runs
// can be its input still streaming (seen from Kimi Code), so it does not count.
const described = (tc: Json) => !!((tc.rawInput && Object.keys(tc.rawInput).length) || tc.locations?.length);

// An input some agents stream as the call's text content before it runs (a JSON object).
export function streamedInput(tc: Json): Json | null {
  const text = (tc.content ?? []).map((c: Json) => (c?.type === "content" && c.content?.type === "text" ? c.content.text : "")).join("");
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

// The served tool a call of the agent is, when one field of it names exactly one of `served`: its tool name
// (`mcp__keel__<tool>`, as Claude's agent gives it in `_meta.claudeCode.toolName` and `name`), or its title as
// that name or as `keel: <tool>` with the server named keel. Never a name found inside a field: a title is the
// agent's words, and another tool's title can hold any text (Gemini titles a call with its arguments).
export function servedCall(tc: Json, served: ReadonlySet<string>): string | undefined {
  if (tc?.kind && tc.kind !== "other") return undefined;
  const full = (n: unknown) => (typeof n === "string" && n.startsWith(`mcp__${SERVED_NAME}__`) && served.has(n.slice(SERVED_NAME.length + 7)) ? n.slice(SERVED_NAME.length + 7) : undefined);
  const titled = tc?._meta?.claudeCode?.mcpServer?.name === SERVED_NAME && typeof tc.title === "string" && tc.title.startsWith(`${SERVED_NAME}: `) && served.has(tc.title.slice(SERVED_NAME.length + 2)) ? tc.title.slice(SERVED_NAME.length + 2) : undefined;
  return full(tc?._meta?.claudeCode?.toolName) ?? full(tc?.name) ?? full(tc?.title) ?? titled;
}

const ALLOW = ["allow_once", "allow_always"];
const REJECT = ["reject_once", "reject_always"];
// Keel answers once: a standing answer is a grant in keel, never the agent's "always".
export const optionFor = (options: Json[], allow: boolean): string | undefined =>
  (options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((o) => (allow ? ALLOW : REJECT).includes(o.kind)))?.optionId;

// `choices`: what the agent's session offers now (its setup result, then its updates).
type Live = { agent: AcpAgent; conn: AcpConnection; acpSession: string; caps: Json; choices: AgentChoices; missed?: string; turn?: TurnState;
  served?: ServedTools; offered: Set<string>; terms: AcpTerminals; commands?: SlashCommand[];
  closed: AbortController };  // aborted when the agent's connection ends
type TurnState = {
  io: ExternalIO;
  session: Session;
  text: string; thinking: string;
  calls: Map<string, Json>;   // toolCallId -> merged tool call
  stored: Set<string>;        // calls whose tool_use is stored
  done: Set<string>;          // calls whose result is stored
  cost?: number;              // the agent's cumulative cost when the turn began
  lastCost?: number;
};

export class AcpRunner {
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();

  // `confine`: how the agent's process starts, with what Keel gives it besides its own folders (the served tools' folder
  // and the program that reaches it). `shell`: terminals for the agent; with none it gets no terminal.
  constructor(private store: Store, private agents: AcpAgents, private judge: Judge, private capture: (e: unknown, ctx: Json) => void,
    private confine: (s: Session, agent: AcpAgent, give: Give) => AgentConfinement = (_s, a) => ({ argv: [a.run!.command, ...a.run!.args], confined: false, note: `${a.name} runs unconfined.`, writable: [] }),
    private shell?: Terminals) {
    // (No agent of an earlier daemon runs now: the folders it served tools in go.)
    try { clearServed(store.stateDir); } catch (e) { capture(e, { at: "acp served tools" }); }
    store.migrate("CREATE TABLE IF NOT EXISTS acp_links (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, agent TEXT NOT NULL, acp_session TEXT NOT NULL, ts INTEGER NOT NULL)");
  }

  claims(s: Session) {
    return isAcpModel(s.model);
  }

  // The agent a session talks to; started (and its conversation opened or found again) once.
  private async connect(s: Session, io: ExternalIO): Promise<Live> {
    const id = agentOf(s.model);
    const have = this.live.get(s.id);
    if (have && have.conn.alive && have.agent.id === id) return have;
    if (have) { have.conn.close(); this.live.delete(s.id); }
    const pending = this.starting.get(s.id);
    if (pending) return pending;
    const p = this.open(s, id, io).finally(() => this.starting.delete(s.id));
    this.starting.set(s.id, p);
    return p;
  }

  private async open(s: Session, id: string, io: ExternalIO): Promise<Live> {
    const agent = this.agents.get(id);
    if (!agent?.run) throw Object.assign(new Error(`the ACP agent ${id} is not installed here`), { expected: true });
    // Keel's tools, served on a socket of the session's own: a server that cannot listen leaves the agent without them, said once.
    const live = { agent, acpSession: "", caps: {}, choices: {}, offered: new Set<string>(), terms: new AcpTerminals(this.store.stateDir), closed: new AbortController() } as Live;
    const served = new ServedTools(this.store.stateDir, s.id, {
      list: () => this.offer(s, live),
      call: (name, args, callId) => live.turn
        ? live.turn.io.runTool("mcp_call", { tool: name, arguments: args }, callId)
        : Promise.resolve({ type: "tool_result", tool_use_id: callId, is_error: true, content: "Keel runs its tools for the agent only while a turn of the session runs." }),
    }, (e) => this.capture(e, { session: s.id, agent: id, at: "acp served tools" }));
    try { await served.listen(); live.served = served; } catch (e) {
      served.close();
      this.capture(e, { session: s.id, agent: id, at: "acp served tools" });
      io.append("note", { kind: "acp", text: `${agent.name} is not offered your MCP servers in this session: Keel could not open their channel (${(e as Error).message}).` });
    }
    // Its own process is confined as Keel's commands are; the session is told how.
    const c = this.confine(s, agent, live.served ? { own: [live.served.dir, live.served.relayDir], programs: [[process.execPath]] } : { own: [], programs: [] });
    const conn = new AcpConnection(c.argv, { cwd: s.workspace, env: agent.run.env }, (m) => this.capture(new Error(m), { session: s.id, agent: id }));
    io.append("note", { kind: "acp", sandbox: c.confined ? "on" : "off", text: c.note });
    live.conn = conn;
    conn.onNotification = (method, params) => { if (method === "session/update") this.update(live, params); };
    conn.onRequest = (method, params) => this.request(live, method, params);
    void conn.exited.then(() => { this.closeLive(live); if (this.live.get(s.id) === live) this.live.delete(s.id); });
    try {
      const init = await conn.request("initialize", {
        protocolVersion: 1,
        // (Boolean config options are shown: session-config-options.)
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: !!this.shell, session: { configOptions: { boolean: {} } } },
        clientInfo: { name: "keel", title: "Keel", version: "0.1.0" },
      });
      live.caps = init?.agentCapabilities ?? {};
      const link = this.store.db.query<{ agent: string; acp_session: string }, [string]>("SELECT agent, acp_session FROM acp_links WHERE session_id = ?").get(s.id);
      const base = { cwd: s.workspace, mcpServers: live.served ? [live.served.config()] : [] };
      if (link && link.agent === id) {
        // The same conversation again after a restart: resumed without replay where offered, else loaded (its replay is not stored again).
        try {
          let r: Json;
          if (live.caps.sessionCapabilities?.resume) r = await conn.request("session/resume", { ...base, sessionId: link.acp_session });
          else if (live.caps.loadSession) { live.acpSession = "loading"; r = await conn.request("session/load", { ...base, sessionId: link.acp_session }); }
          else throw new Error("the agent keeps no sessions");
          this.setup(live, r);
          live.acpSession = link.acp_session;
        } catch (e) {
          live.acpSession = "";
          io.append("note", { kind: "acp", text: `${agent.name} could not resume its earlier conversation (${(e as Error).message}): it starts a new one and does not know what was said before.` });
        }
      }
      if (!live.acpSession) {
        let r: Json;
        try { r = await conn.request("session/new", base); } catch (e) {
          if ((e as any).code === -32000) throw Object.assign(new Error(`${agent.name} needs you to sign in with its own login first (${(init?.authMethods ?? []).map((m: Json) => m.name ?? m.id).join(", ") || "see its documentation"})`), { expected: true });
          throw e;
        }
        live.acpSession = String(r.sessionId);
        this.setup(live, r);
        this.store.db.run("INSERT OR REPLACE INTO acp_links (session_id, agent, acp_session, ts) VALUES (?, ?, ?, ?)", [s.id, id, live.acpSession, Date.now()]);
      }
    } catch (e) {
      conn.close();
      this.closeLive(live);
      throw e;
    }
    this.live.set(s.id, live);
    return live;
  }

  // What the agent is offered of Keel's tools: the MCP servers' tools this session reaches, by their full names.
  private async offer(s: Session, live: Live): Promise<ServedTool[]> {
    const tools = (await catalogTools(s.id)).filter((t) => t.mcp && !t.hidden);
    live.offered = new Set(tools.map((t) => t.qualified));
    return tools.map((t) => ({ name: t.qualified, description: t.description, inputSchema: t.input_schema, readOnly: t.readOnly }));
  }

  private closeLive(live: Live) {
    live.closed.abort();
    live.served?.close();
    live.served = undefined;
    void live.terms.closeAll().catch((e) => this.capture(e, { agent: live.agent.id, at: "acp terminals" }));
  }

  // A setup result: what the agent offers in this session, and in its listing.
  // A resume or load that states no options keeps what was known of the agent,
  // with nothing taken as current: the session's own choice is sent to it.
  private setup(live: Live, r: Json) {
    const stated = Array.isArray(r?.configOptions) || Array.isArray(r?.modes?.availableModes);
    live.choices = stated ? mergeChoices(live.choices, r) : unknownCurrent(mergeChoices(this.agents.learned(live.agent.id) ?? {}, {}));
    this.agents.learn(live.agent, r);
  }

  // The agent's session brought to the model (or mode) and effort the Keel
  // session has, before its prompt. A choice it no longer offers is said once.
  private async settleChoices(live: Live, s: Session, io: ExternalIO) {
    const choice = splitModel(s.model.slice(ACP_PREFIX.length)).choice;
    const set = pickable(live.choices);
    if (choice && !set?.options.some((o) => o.value === choice)) {
      if (live.missed !== choice) io.append("note", { kind: "acp", text: `${live.agent.name} does not offer ${choice} in this session now: it goes on with ${set?.options.find((o) => o.value === set.current)?.name ?? "its own choice"}.` });
      live.missed = choice;
      return;
    }
    for (const step of settle(live.choices, { choice, effort: s.settings?.effort, switches: s.settings?.acp_switches })) {
      let r: Json;
      // A switch the agent refuses does not cost the turn: the agent goes on with what it has, and the session is told.
      try { r = await live.conn.request(step.method, { sessionId: live.acpSession, ...step.params }); } catch (e) {
        const what = step.method === "session/set_mode" ? `the mode ${step.params.modeId}` : `${step.params.configId} ${step.params.value}`;
        io.append("note", { kind: "acp", text: `${live.agent.name} refused to switch to ${what} (${(e as Error).message}): this turn runs with what it had.` });
        if (!live.conn.alive) throw e;
        continue;
      }
      if (Array.isArray(r?.configOptions)) live.choices = withOptions(live.choices, r.configOptions);
      else if (step.method === "session/set_mode" && live.choices.modes) live.choices.modes = { ...live.choices.modes, current: step.params.modeId };
      else if (step.method === "session/set_config_option" && step.params.type === "boolean") live.choices.switches = live.choices.switches?.map((x) => (x.id === step.params.configId ? { ...x, current: step.params.value } : x));
      else if (step.method === "session/set_config_option") for (const k of ["models", "modes", "efforts"] as const) { const c = live.choices[k]; if (c?.via === "config" && c.configId === step.params.configId) live.choices[k] = { ...c, current: step.params.value }; }
    }
  }

  // One turn: the owner's new words to the agent, its stream into keel events.
  async turn(s: Session, io: ExternalIO): Promise<{ reason: string; usage?: Usage }> {
    const prompt = promptOf(io.events());
    if (!prompt.length) return { reason: "end_turn" };
    io.status({ kind: "model", since: Date.now(), model: s.model });
    const live = await this.connect(s, io);
    // (A server that connected or changed since the agent listed Keel's tools: it is told to list them again.)
    void live.served?.refresh().catch((e) => this.capture(e, { session: s.id, at: "acp served tools" }));
    await this.settleChoices(live, s, io);
    const t: TurnState = { io, session: s, text: "", thinking: "", calls: new Map(), stored: new Set(), done: new Set(), cost: live.turn?.lastCost };
    live.turn = t;
    // (The owner's Stop also stops what its terminals still run.)
    const cancel = () => {
      live.conn.notify("session/cancel", { sessionId: live.acpSession });
      void live.terms.stopRunning().catch((e) => this.capture(e, { session: s.id, at: "acp terminals" }));
    };
    io.signal.addEventListener("abort", cancel, { once: true });
    try {
      const answer = live.conn.request("session/prompt", { sessionId: live.acpSession, prompt });
      // After a stop the agent answers "cancelled"; one that does not is ended.
      const stopped = new Promise<Json>((res) => io.signal.addEventListener("abort", () => setTimeout(() => res({ stopReason: "cancelled", forced: true }), 10_000), { once: true }));
      const r = await Promise.race([answer, stopped]);
      if (r?.forced) { live.conn.close(); this.live.delete(s.id); }
      this.flush(t);
      // Calls the agent never finished end with the turn.
      for (const [cid, tc] of t.calls) if (!t.done.has(cid)) this.finish(t, { ...tc, status: "failed", content: [{ type: "content", content: { type: "text", text: r?.stopReason === "cancelled" ? "Interrupted by the user while this tool ran." : "The agent ended its turn without finishing this call." } }] });
      const usage = emptyUsage();
      const u = r?.usage;
      if (u) { usage.input = Number(u.inputTokens ?? 0); usage.output = Number(u.outputTokens ?? 0); usage.cache_read = Number(u.cachedReadTokens ?? 0); usage.cache_write = Number(u.cachedWriteTokens ?? 0); }
      if (t.lastCost !== undefined) usage.cost = Math.max(0, t.lastCost - (t.cost ?? 0));
      const stop = String(r?.stopReason ?? "end_turn");
      return { reason: stop === "max_turn_requests" ? "max_steps" : stop === "cancelled" ? "interrupted" : stop, usage };
    } finally {
      io.signal.removeEventListener("abort", cancel);
      live.turn = undefined;
      io.status({ kind: "idle" });
    }
  }

  // Text and thinking so far as one assistant event, with the calls that follow it.
  private flush(t: TurnState, calls: Json[] = []) {
    const blocks: Json[] = [];
    if (t.thinking.trim()) blocks.push({ type: "thinking", thinking: t.thinking, origin: "acp" });
    if (t.text.trim()) blocks.push({ type: "text", text: t.text });
    for (const tc of calls) {
      const { name, input } = asToolUse(tc);
      blocks.push({ type: "tool_use", id: tc.toolCallId, name, input, origin: "acp" });
      t.stored.add(tc.toolCallId);
    }
    t.text = t.thinking = "";
    if (blocks.length) t.io.append("assistant", { blocks, model: t.session.model, usage: emptyUsage(), stop: calls.length ? "tool_use" : "end_turn" });
  }

  private finish(t: TurnState, tc: Json) {
    if (t.done.has(tc.toolCallId)) return;
    if (!t.stored.has(tc.toolCallId)) this.flush(t, [tc]);
    t.done.add(tc.toolCallId);
    t.io.append("tool_result", { results: [resultOf(tc, (id) => this.live.get(t.session.id)?.terms.shown(id))] });
  }

  private update(live: Live, p: Json) {
    const t = live.turn;
    const u = p?.update;
    // (Commands may come before the setup's answer names the conversation, or with a load's replay.)
    if (u?.sessionUpdate === "available_commands_update" && (p.sessionId === live.acpSession || live.acpSession === "" || live.acpSession === "loading")) {
      live.commands = commandsOf(u.availableCommands);
      this.agents.learnCommands(live.agent, live.commands);
      return;
    }
    if (!u || p.sessionId !== live.acpSession) return; // a load's replay, or another conversation
    // The agent changed a choice itself, in a turn or between them: what is current follows it.
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) live.choices = withOptions(live.choices, u.configOptions);
    if (u.sessionUpdate === "current_mode_update" && live.choices.modes?.via === "mode" && typeof u.currentModeId === "string") live.choices.modes = { ...live.choices.modes, current: u.currentModeId };
    if (!t) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") { t.text += u.content.text; t.io.delta("text", 1, u.content.text); t.io.status({ kind: "idle" }); }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") { t.thinking += u.content.text; t.io.delta("thinking", 0, u.content.text); }
        break;
      case "tool_call": {
        const tc = { ...u };
        t.calls.set(tc.toolCallId, tc);
        // A call announced before its input (some agents send it in the next update) is stored once it says what it does.
        if (described(tc)) this.flush(t, [tc]);
        t.io.status({ kind: "tool", since: Date.now(), names: [asToolUse(tc).name] });
        if (tc.status === "completed" || tc.status === "failed") this.finish(t, tc);
        break;
      }
      case "tool_call_update": {
        const prev = t.calls.get(u.toolCallId) ?? { toolCallId: u.toolCallId };
        const tc = { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) };
        t.calls.set(tc.toolCallId, tc);
        if (!t.stored.has(tc.toolCallId) && described(tc)) this.flush(t, [tc]);
        if (tc.status === "completed" || tc.status === "failed") { this.finish(t, tc); t.io.status({ kind: "model", since: Date.now(), model: t.session.model }); }
        break;
      }
      case "plan": {
        // Shown as the plan the dock and the transcript already read.
        this.flush(t);
        const id = `acp-plan-${crypto.randomUUID()}`;
        const plan = (u.entries ?? []).map((e: Json) => ({ step: String(e.content ?? ""), status: e.status === "completed" || e.status === "in_progress" ? e.status : "pending" }));
        t.io.append("assistant", { blocks: [{ type: "tool_use", id, name: "update_plan", input: { plan }, origin: "acp" }], model: t.session.model, usage: emptyUsage(), stop: "tool_use" });
        t.io.append("tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: "Plan updated" }] });
        break;
      }
      case "usage_update":
        if (u.cost && typeof u.cost.amount === "number" && (!u.cost.currency || u.cost.currency === "USD")) {
          if (t.cost === undefined) t.cost = t.lastCost ?? 0;
          t.lastCost = u.cost.amount;
        }
        break;
      case "config_option_update":
      case "current_mode_update":
      case "session_info_update":
        break;
    }
  }

  // The agent's requests: permission and files, all judged by keel's gate.
  private async request(live: Live, method: string, p: Json): Promise<Json> {
    // A terminal's output, end and release are asked for also between turns: they judge nothing.
    if (this.shell && p?.sessionId === live.acpSession) {
      if (method === "terminal/output") return live.terms.output(p);
      if (method === "terminal/kill") return live.terms.kill(p);
      if (method === "terminal/release") return live.terms.release(p);
      if (method === "terminal/wait_for_exit") return live.terms.waitForExit(p, live.turn?.io.signal ?? live.closed.signal);
    }
    const t = live.turn;
    const s = t?.session;
    if (!t || !s || p.sessionId !== live.acpSession) throw Object.assign(new Error("no turn is running in this session"), { code: -32002 });
    const signal = t.io.signal;
    switch (method) {
      case "session/request_permission": {
        const prev = t.calls.get(p.toolCall?.toolCallId) ?? {};
        // The call as announced, with what the request adds; its input as the agent streamed it when the request has none.
        const tc = { ...prev, ...(p.toolCall ?? {}), content: prev.content ?? p.toolCall?.content };
        if (!described(tc)) { const g = streamedInput(prev); if (g) tc.rawInput = g; }
        if (tc.toolCallId) { t.calls.set(tc.toolCallId, tc); if (!t.stored.has(tc.toolCallId)) this.flush(t, [tc]); }
        const options: Json[] = p.options ?? [];
        if (signal.aborted) return { outcome: { outcome: "cancelled" } };
        // A call of Keel's own tools is judged when it reaches Keel (served.ts): asked here too, the owner would answer twice.
        // (The call as announced and as asked about are read apart: one field of either names it whole.)
        if (servedCall(prev, live.offered) ?? servedCall(p.toolCall, live.offered)) {
          const optionId = optionFor(options, true);
          return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
        }
        const cls = classOf(tc, s.workspace);
        const verdict = await this.judge(s, { id: tc.toolCallId ?? crypto.randomUUID(), name: `acp__${live.agent.id}__${tc.kind ?? "other"}`, cls, input: asToolUse(tc).input, signal });
        if (signal.aborted) return { outcome: { outcome: "cancelled" } };
        // (An allowed command the agent then runs in a terminal of Keel's is not asked about again.)
        if (!verdict && cls.kind === "shell") this.shell?.answered(s.id, cls.command);
        const optionId = optionFor(options, !verdict);
        return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        const given = String(p.path ?? "");
        if (!isAbsolute(given)) throw Object.assign(new Error("path must be absolute"), { code: -32602 });
        // (The file the kernel reaches: what is judged is what is opened.)
        const path = realOf(given);
        const v = await this.judge(s, { id: crypto.randomUUID(), name: "Read", cls: { kind: "read", paths: [path] }, input: { file_path: path }, signal });
        if (v) throw Object.assign(new Error(v.deny), { code: -32000 });
        { const held = heldFile(path); if (held) throw Object.assign(new Error(held), { code: -32000 }); }
        // (The file that was judged, held: the one the gate saw under the name at its look, not whatever the name is
        // by now. Read off the loop: an agent names the file.)
        const h = hold(path, { judged: [path] }, "read");
        if ("refused" in h) throw Object.assign(new Error(h.refused), { code: -32000 });
        if (!h.existed) { h.close(); throw Object.assign(new Error(`${path} does not exist`), { code: -32000 }); }
        let text: string;
        try { text = await readFile(h.io, "utf8"); } finally { h.close(); }
        if (p.line || p.limit) {
          const lines = text.split("\n");
          const from = Math.max(0, Number(p.line ?? 1) - 1);
          text = lines.slice(from, p.limit ? from + Number(p.limit) : undefined).join("\n");
        }
        return { content: text };
      }
      case "fs/write_text_file": {
        const given = String(p.path ?? "");
        if (!isAbsolute(given)) throw Object.assign(new Error("path must be absolute"), { code: -32602 });
        const path = realOf(given);
        const v = await this.judge(s, { id: crypto.randomUUID(), name: "Write", cls: { kind: "edit", paths: [path] }, input: { file_path: path, content: String(p.content ?? "") }, signal });
        if (v) throw Object.assign(new Error(v.deny), { code: -32000 });
        { const held = heldWrite(path); if (held) throw Object.assign(new Error(held), { code: -32000 }); }
        const h = hold(path, { judged: [path] }, "write");
        if ("refused" in h) throw Object.assign(new Error(h.refused), { code: -32000 });
        try { await writeFile(h.io, String(p.content ?? "")); } finally { h.close(); }
        return null;
      }
      case "terminal/create":
        if (!this.shell) break;
        return live.terms.create(s, p, (tool, input, id) => t.io.runTool(tool, input, id));
    }
    throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }

  // The session is gone or archived: its agent conversation is closed and the process ends.
  release(sessionId: string) {
    const l = this.live.get(sessionId);
    if (!l) return;
    this.live.delete(sessionId);
    this.closeLive(l);
    if (l.caps.sessionCapabilities?.close) void l.conn.request("session/close", { sessionId: l.acpSession }).catch(() => {}).finally(() => l.conn.close());
    else l.conn.close();
  }

  dispose() {
    for (const id of [...this.live.keys()]) this.release(id);
  }

  // The switches a session's agent offers (its boolean config options), each with what it is now and what the owner set.
  // Held: one about what the agent may do without asking (heldSwitch), which Keel's gate and sandbox decide instead.
  switches(s: Session): { agent: string; started: boolean; switches: (Switch & { set?: boolean; held?: true })[] } {
    const agent = agentOf(s.model);
    const l = this.live.get(s.id);
    const mine = l && l.agent.id === agent ? l.choices.switches : undefined;
    const list = mine ?? (this.agents.learned(agent)?.switches ?? []).map(({ current: _, ...x }) => x);
    const set = s.settings?.acp_switches ?? {};
    return { agent, started: !!mine, switches: list.map((x) => ({ ...x, ...(typeof set[x.id] === "boolean" ? { set: set[x.id] } : {}), ...(heldSwitch(x) ? { held: true as const } : {}) })) };
  }

  // The slash commands a session's agent offers: its own when it has started, else what that agent last advertised
  // (in a session of its, or when it was asked what it offers).
  commands(s: Session): { commands: SlashCommand[]; agent: string; started: boolean } {
    const agent = agentOf(s.model);
    const l = this.live.get(s.id);
    const mine = l && l.agent.id === agent ? l.commands : undefined;
    return { agent, started: !!mine, commands: mine ?? this.agents.learned(agent)?.commands ?? [] };
  }

  running(): { session: string; agent: string; acp_session: string }[] {
    return [...this.live].map(([session, l]) => ({ session, agent: l.agent.id, acp_session: l.acpSession }));
  }
}
