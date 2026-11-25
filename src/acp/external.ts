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
// It advertises `clientCapabilities.subagents`: each child the agent announces (`subagent_update`) is an agent row
// under the session, with a session of its own for its transcript, its permission requests judged as the session's
// own are, and a Stop that cancels it (src/acp/children.ts; the row is made by `ChildHost`, src/automation/agents.ts).
// An agent that announces none changes nothing.
//
// Spec: agentclientprotocol.com/protocol/v1 (initialize, session/new, load,
// resume, prompt, cancel, close; session/update, session/request_permission,
// fs/read_text_file, fs/write_text_file, terminal/* toward the client;
// docs/protocol/v1/subagents.mdx).
//
// ACP v2 is a Preview and may still change. When the owner turns it on (settings `acp.protocol` "auto"), the agent is
// asked for v2 first and spoken to in v1 when it answers 1 (src/acp/v2.ts: the turn ends at its idle state, the
// prompt carries an idempotency key, its background work is among the session's commands and one item is stopped
// alone). A v2 connection has no client file or terminal methods: the agent runs those itself.
import { heldFile, heldWrite } from "../core/store-files.ts";
import type { AgentConfinement, Give } from "./confine.ts";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { atCwd, realOf } from "../core/paths.ts";
import { hold, writeHeld } from "../tools/files.ts";
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
import { fitted, noted, unrename } from "../providers/wires/schema-fit.ts";
import { clip, messageText, MESSAGE_MAX, patchChild, readState, turnReason, type ChildState, type Reading } from "./children.ts";
import { ownerStop } from "../core/stoppers.ts";
import { acpJobs } from "./jobs-hook.ts";
import { addedText, Book, foreground, legacyPermission, negotiated, PromptKeys, protocolSetting, RECOGNIZED_MS, turnStop, v2Init, v2Server, Watch, type Foreground, type Version } from "./v2.ts";
import type { AgentStatus, ExternalInfo, StopBy } from "../automation/agents.ts";
import type { TurnStatus } from "../core/types.ts";

// Terminals for the agent, when the gate runs: `answered` is told each command the agent asked about and was allowed.
export type Terminals = { answered(sessionId: string, command: string): void };

type Json = any;
export const ACP_PREFIX = "acp:";
export const isAcpModel = (model: string) => model.startsWith(ACP_PREFIX);
// The agent of an `acp:` model, and the model (or mode) of it the session chose (choices.ts).
export const agentOf = (model: string) => splitModel(model.slice(ACP_PREFIX.length)).agent;

// What makes and moves the agent rows of the children an agent announces, and writes into their sessions
// (src/server/routes/acp.ts wires it to src/automation/agents.ts and the engine).
export type Passive = { append(kind: StoredEvent["kind"], data: unknown): StoredEvent; delta(kind: "text" | "thinking", index: number, text: string): void; status(s: TurnStatus): void };
export type ChildPatch = { title?: string; status?: AgentStatus; end_reason?: string | null; result?: string; stopped_by?: StopBy | null; external?: Partial<ExternalInfo> };
export type ChildHost = {
  io(sessionId: string): Passive;
  // The row of a child announced earlier under this session (the agent's conversation resumed): its id and session.
  find(parent: string, child: string, conv: string): { id: string; session: Session; callId: string } | undefined;
  create(parent: Session, o: { title: string; agent: string; child: string; conv: string; callId: string; reading: Reading; cancel: boolean }): { id: string; session: Session; callId: string };
  patch(id: string, p: ChildPatch): void;
  disconnect(id: string): void;
  isChild(sessionId: string): boolean;
  // How many agents the session's tree may run at once (src/core/agent-tree.ts).
  limit(parent: string): number;
};

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
  const failed = tc.status === "failed" || tc.status === "cancelled";
  return { type: "tool_result", tool_use_id: tc.toolCallId, content: out.length ? out : tc.status === "cancelled" ? "Cancelled." : failed ? "Failed." : "Done.", is_error: failed || undefined };
}

// The owner's words since the agent last answered: the user events after the last turn_end.
export function promptOf(events: readonly StoredEvent[]): Json[] {
  return promptParts(events).blocks;
}

// The same with the events it was made of (their seqs). `only`: those events alone, wherever they stand (a prompt
// sent again after a restart is made of the events it was first made of, and no restart note).
export function promptParts(events: readonly StoredEvent[], only?: ReadonlySet<number>): { blocks: Json[]; seqs: number[] } {
  let from = events.length;
  if (!only) while (from > 0 && events[from - 1]!.kind !== "turn_end") from--;
  else from = 0;
  const blocks: Json[] = [];
  const seqs: number[] = [];
  for (const e of events.slice(from)) {
    if (e.kind !== "user" || e.data.origin === "harness") continue;
    if (only ? !only.has(e.seq) : false) continue;
    seqs.push(e.seq);
    for (const b of e.data.images ?? []) {
      if (b?.type === "image" && b.data) blocks.push({ type: "image", mimeType: b.media_type, data: b.data });
      else if (b?.type === "attachment") blocks.push({ type: "text", text: `[attached file ${b.name}: not sent to this agent]` });
    }
    if (e.data.text) blocks.push({ type: "text", text: String(e.data.text) });
  }
  return { blocks, seqs };
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
type Live = { agent: AcpAgent; conn: AcpConnection; acpSession: string; sid: string; caps: Json; choices: AgentChoices; missed?: string; turn?: TurnState;
  // The children the agent announced on this connection, by their ids in its conversation; and the session messages
  // it sent in chunks that are not whole yet.
  children: Map<string, Child>;
  chunks: Map<string, { to: string; from?: string; text: string }>;
  capped?: boolean;  // the owner was told that announced children past the limit are not shown
  odd?: boolean;     // the owner was told that something the agent sent was left out for its size (an id, a line)
  served?: ServedTools; offered: Set<string>; terms: AcpTerminals; commands?: SlashCommand[];
  // The offered tools whose parameters were renamed to fit (by the name the agent calls), with the server's names.
  renamed?: Map<string, Record<string, string>>;
  plans?: Map<string, Json[]>;  // the agent's plans by id ("" is the legacy checklist), each as the steps it shows
  // The protocol this connection speaks (src/acp/v2.ts: 2 is a Preview), what the agent last said of its foreground
  // state, its background work, and the words of each message it sent whole (a whole message replaces its chunks).
  v: Version; fg?: Foreground; book: Book; texts: Map<string, string>;
  pending: Map<number | string, AbortController>;  // the agent's permission requests that wait, by their ids ($/cancel_request)
  closed: AbortController };  // aborted when the agent's connection ends
// How many finished children one connection may show for each one that may be at work (see `room`), and how many
// messages it may send in pieces at once (they are put together and shown when the next update comes).
const TOTAL_PER_LIVE = 16;
const CHUNKS_MAX = 64;
// The longest id of a child or a message that Keel keeps: the agent's own are short; a longer one is not an id.
const ID_MAX = 256;
// A child the agent announced: its row (`agent`) and session, the transcript's state, and what it was last said to be.
type Child = { id: string; agent: string; session: string; outer: string; state: ChildState; turn: TurnState; abort: AbortController;
  sig: string; tasks: number; stopBy?: StopBy; ran?: number; over?: boolean; plans?: Map<string, Json[]> };
type TurnState = {
  io: ExternalIO;
  session: Session;
  text: string; thinking: string;
  calls: Map<string, Json>;   // toolCallId -> merged tool call
  stored: Set<string>;        // calls whose tool_use is stored
  done: Set<string>;          // calls whose result is stored
  cost?: number;              // the agent's cumulative cost when the turn began
  lastCost?: number;
  last?: string;              // the newest reply text stored
  watch?: Watch;              // v2: what ends this turn (an idle state), told by the agent's state updates
  ended?: (r: { stop: string; error?: { code?: number; message?: string } }) => void;
  seen?: Set<string>;         // v2: the user messages the agent reported for this prompt (a recognized retry reports none)
};

const STEP = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;
// The steps of a Markdown plan: its checklist, bullet and numbered lines (a
// `[x]` is done); a plan with none is one pending step, its first line.
export function markdownSteps(md: string): Json[] {
  const steps: Json[] = [];
  for (const line of md.split("\n")) {
    const m = STEP.exec(line);
    if (m) steps.push({ step: m[2], status: m[1] && m[1] !== " " ? "completed" : "pending" });
  }
  const head = md.split("\n").map((l) => l.replace(/^\s*#+\s*/, "").trim()).find(Boolean);
  return steps.length ? steps : head ? [{ step: head, status: "pending" }] : [];
}

// A plan update of the agent (`plan`, `plan_update`, `plan_removed`) applied to
// the plans it holds: the steps of all of them after it, or null when it
// changes nothing. One plan, the usual case, is its steps as it sent them.
export function applyPlan(plans: Map<string, Json[]>, u: Json): Json[] | null {
  const status = (s: unknown) => (s === "completed" || s === "in_progress" ? s : "pending");
  if (u.sessionUpdate === "plan") plans.set("", (u.entries ?? []).map((e: Json) => ({ step: String(e.content ?? ""), status: status(e.status) })));
  else if (u.sessionUpdate === "plan_update" && u.plan && typeof u.plan.planId === "string") {
    if (u.plan.type === "markdown") plans.set(u.plan.planId, markdownSteps(String(u.plan.content ?? "")));
    else plans.set(u.plan.planId, (u.plan.entries ?? []).map((e: Json) => ({ step: String(e.content ?? ""), status: status(e.status) })));
  } else if (u.sessionUpdate === "plan_removed") {
    if (typeof u.planId !== "string" || !plans.delete(u.planId)) return null; // (an id it does not know is ignored)
  } else return null;
  return [...plans.values()].flat();
}

export class AcpRunner {
  private live = new Map<string, Live>();
  private keys: PromptKeys;
  private starting = new Map<string, Promise<Live>>();

  // `confine`: how the agent's process starts, with what Keel gives it besides its own folders (the served tools' folder
  // and the program that reaches it). `shell`: terminals for the agent; with none it gets no terminal.
  constructor(private store: Store, private agents: AcpAgents, private judge: Judge, private capture: (e: unknown, ctx: Json) => void,
    private confine: (s: Session, agent: AcpAgent, give: Give) => AgentConfinement = (_s, a) => ({ argv: [a.run!.command, ...a.run!.args], confined: false, note: `${a.name} runs unconfined.`, writable: [] }),
    private shell?: Terminals, private kids?: ChildHost) {
    // (No agent of an earlier daemon runs now: the folders it served tools in go.)
    try { clearServed(store.stateDir); } catch (e) { capture(e, { at: "acp served tools" }); }
    this.keys = new PromptKeys(store.db);
    store.migrate("CREATE TABLE IF NOT EXISTS acp_links (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, agent TEXT NOT NULL, acp_session TEXT NOT NULL, ts INTEGER NOT NULL)");
  }

  // (A child the agent announced is shown from its session: the agent runs it, not a turn of Keel's.)
  claims(s: Session) {
    return isAcpModel(s.model) && !this.kids?.isChild(s.id);
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
    const live = { agent, acpSession: "", sid: s.id, caps: {}, choices: {}, offered: new Set<string>(), terms: new AcpTerminals(this.store.stateDir), closed: new AbortController(), children: new Map(), chunks: new Map(), v: 1, book: new Book(), texts: new Map(), pending: new Map() } as Live;
    const served = new ServedTools(this.store.stateDir, s.id, {
      list: () => this.offer(s, live),
      call: (name, args, callId) => live.turn
        ? live.turn.io.runTool("mcp_call", { tool: name, arguments: unrename(args, live.renamed?.get(name)) }, callId)
        : Promise.resolve({ type: "tool_result", tool_use_id: callId, is_error: true, content: "Keel runs its tools for the agent only while a turn of the session runs." }),
    }, (e) => this.capture(e, { session: s.id, agent: id, at: "acp served tools" }));
    try { await served.listen(); live.served = served; } catch (e) {
      served.close();
      this.capture(e, { session: s.id, agent: id, at: "acp served tools" });
      io.append("note", { kind: "acp", text: `${agent.name} is not offered your MCP servers in this session: Keel could not open their channel (${(e as Error).message}).` });
    }
    // Its own process is confined as Keel's commands are; the session is told how.
    const c = this.confine(s, agent, live.served ? { own: [live.served.dir, live.served.relayDir], programs: [[process.execPath]] } : { own: [], programs: [] });
    io.append("note", { kind: "acp", sandbox: c.confined ? "on" : "off", text: c.note });
    const spawn = () => {
      const conn = new AcpConnection(c.argv, { cwd: s.workspace, env: agent.run!.env, pass: agent.run!.env_vars }, (m) => this.capture(new Error(m), { session: s.id, agent: id }));
      live.conn = conn;
      conn.onNotification = (method, params) => { if (conn !== live.conn) return; if (method === "session/update") this.update(live, params); else if (method === "$/cancel_request") live.pending.get(params?.requestId)?.abort(); };
      conn.onRequest = (method, params, rid) => this.request(live, method, params, rid);
      conn.onOversize = (n) => this.odd(live, `a message of ${n} characters`);
      void conn.exited.then(() => { if (conn !== live.conn) return; this.closeLive(live); if (this.live.get(s.id) === live) this.live.delete(s.id); });
      return conn;
    };
    let conn = spawn();
    try {
      // Version 2 (a Preview) is asked for first only when the owner turned it on (settings: acp.protocol "auto"); an agent
      // that answers 1 is spoken to in v1, on the same connection when it takes a second initialize, else started again.
      let init: Json;
      if (protocolSetting() === "auto") {
        try { init = await conn.request("initialize", v2Init()); } catch (e) { if (!conn.alive) throw e; init = undefined; }
        const got = negotiated(init);
        if (got === 2) live.v = 2;
        else {
          if (got === 1) { try { init = await conn.request("initialize", this.initV1()); } catch { init = undefined; } }
          if (!init || negotiated(init) !== 1) { conn.close(); live.conn = undefined as any; conn = spawn(); init = await conn.request("initialize", this.initV1()); }
        }
      } else init = await conn.request("initialize", this.initV1());
      live.caps = (live.v === 2 ? init?.capabilities : init?.agentCapabilities) ?? {};
      const link = this.store.db.query<{ agent: string; acp_session: string }, [string]>("SELECT agent, acp_session FROM acp_links WHERE session_id = ?").get(s.id);
      const mcp = live.served ? [live.v === 2 ? v2Server(live.served.config()) : live.served.config()] : [];
      const base = { cwd: s.workspace, mcpServers: mcp };
      if (link && link.agent === id) {
        // The same conversation again after a restart: resumed without replay where offered, else loaded (its replay is not stored again).
        try {
          let r: Json;
          if (live.v === 2) { live.acpSession = link.acp_session; r = await conn.request("session/resume", { ...base, sessionId: link.acp_session }); }
          else if (live.caps.sessionCapabilities?.resume) r = await conn.request("session/resume", { ...base, sessionId: link.acp_session });
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
      live.conn?.close();
      this.closeLive(live);
      throw e;
    }
    this.live.set(s.id, live);
    return live;
  }

  private initV1() {
    return {
      protocolVersion: 1,
      // (Boolean config options are shown: session-config-options.)
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: !!this.shell, session: { configOptions: { boolean: {} } }, plan: {}, ...(this.kids ? { subagents: {} } : {}) },
      clientInfo: { name: "keel", title: "Keel", version: "0.1.0" },
    };
  }

  // What the agent is offered of Keel's tools: the MCP servers' tools this session reaches, by their full names.
  private async offer(s: Session, live: Live): Promise<ServedTool[]> {
    // The agent's provider is not known here: each schema fits every wire's rules (src/providers/wires/schema-fit.ts),
    // and a tool that cannot be made to fit is not offered (Customize > MCP servers names it).
    const tools = (await catalogTools(s.id)).filter((t) => t.mcp && !t.hidden).flatMap((t) => {
      const f = fitted(t.input_schema, "portable");
      return "left" in f ? [] : [{ t, f }];
    });
    live.offered = new Set(tools.map(({ t }) => t.qualified));
    live.renamed = new Map(tools.flatMap(({ t, f }) => (f.renames ? [[t.qualified, f.renames] as const] : [])));
    return tools.map(({ t, f }) => ({ name: t.qualified, description: noted(t.description, f.notes), inputSchema: f.schema, readOnly: t.readOnly }));
  }

  private closeLive(live: Live) {
    // The agent is gone: its children's work is not known any more, and what waited on the owner for them is let go.
    for (const c of live.children.values()) {
      c.abort.abort();
      try { this.kidCut(c, "The connection to the agent ended while this ran."); } catch (e) { this.capture(e, { agent: live.agent.id, at: "acp child" }); }
      try { this.kids?.disconnect(c.agent); } catch (e) { this.capture(e, { agent: live.agent.id, at: "acp child" }); }
    }
    live.children.clear();
    live.closed.abort();
    for (const c of live.pending.values()) c.abort();
    live.pending.clear();
    if (live.book.listed?.length) { live.book.snapshot({ state: "unknown", background: null }); this.tellJobs(live); }
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
    // v2: the setup response carries the session's commands.
    if (live.v === 2 && Array.isArray(r?.availableCommands)) { live.commands = commandsOf(r.availableCommands); this.agents.learnCommands(live.agent, live.commands); }
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
  async turn(s: Session, io: ExternalIO): Promise<{ reason: string; usage?: Usage; extra?: Record<string, unknown> }> {
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
      // The children it announced are stopped with it: by the owner when the owner stopped the turn, else with an agent above them.
      const by: StopBy = ownerStop(io.stopper?.()) ? "owner" : "ancestor";
      for (const c of live.children.values()) this.stopChild(live, c, by);
      void live.terms.stopRunning().catch((e) => this.capture(e, { session: s.id, at: "acp terminals" }));
    };
    io.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (live.v === 2) return await this.turnV2(live, s, io, t);
      const answer = live.conn.request("session/prompt", { sessionId: live.acpSession, prompt });
      // After a stop the agent answers "cancelled"; one that does not is ended.
      const stopped = new Promise<Json>((res) => io.signal.addEventListener("abort", () => setTimeout(() => res({ stopReason: "cancelled", forced: true }), 10_000), { once: true }));
      const r = await Promise.race([answer, stopped]);
      if (r?.forced) { live.conn.close(); this.live.delete(s.id); }
      this.flush(t);
      this.kidsOutlive(live);
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

  // One turn on a v2 connection. The prompt is acknowledged with the id of the message the agent inserted; the work it
  // starts ends with an idle state (src/acp/v2.ts Watch). The prompt carries an idempotency key kept with the events it
  // was made of, so one sent again after a restart cut this one is not run twice: it goes with the same key and the same
  // words, and what the agent answers to it is read as the spec says (a message it recognizes is not inserted again).
  private async turnV2(live: Live, s: Session, io: ExternalIO, t: TurnState): Promise<{ reason: string; usage?: Usage; extra?: Record<string, unknown> }> {
    const events = io.events();
    let row = this.keys.get(s.id);
    if (row && row.acp_session !== live.acpSession) { this.keys.clear(s.id); row = undefined; }
    // (A prompt first made of events a branch no longer has is a new submission.)
    const first = row ? promptParts(events, new Set(row.seqs)) : undefined;
    const resent = !!row && !!first && first.blocks.length > 0 && first.seqs.length === row.seqs.length;
    let sub: { key: string; blocks: Json[]; seqs: number[] };
    if (resent) sub = { key: row!.key, blocks: first!.blocks, seqs: first!.seqs };
    else { const { blocks, seqs } = promptParts(events); sub = { key: crypto.randomUUID(), blocks, seqs }; this.keys.put(s.id, live.acpSession, sub.key, seqs); }
    const before = live.fg?.state;
    let r = await this.submit(live, s, io, t, sub, resent, before);
    // What the owner typed after the prompt that was sent again is a prompt of its own.
    if (resent && !r.cut && r.stop !== "cancelled") {
      const have = new Set(sub.seqs);
      const rest = promptParts(events.filter((e) => !have.has(e.seq) && e.data?.origin !== "restart"));
      if (rest.blocks.length) {
        const next = { key: crypto.randomUUID(), blocks: rest.blocks, seqs: rest.seqs };
        this.keys.put(s.id, live.acpSession, next.key, next.seqs);
        r = await this.submit(live, s, io, t, next, false, live.fg?.state);
      }
    }
    // A prompt that was stopped or answered with an end is finished; a try the connection cut stays, to be sent again.
    if (!r.cut) this.keys.clear(s.id);
    this.flush(t);
    for (const [cid, tc] of t.calls) if (!t.done.has(cid) && !live.book.isBackground(cid)) this.finish(t, { ...tc, status: "failed", content: [{ type: "content", content: { type: "text", text: r.stop === "cancelled" ? "Interrupted by the user while this tool ran." : "The agent ended its turn without finishing this call." } }] });
    if (r.stop === "error") throw Object.assign(new Error(r.error?.message ?? `${live.agent.name} reported an error`), r.error?.code === -32000 ? { expected: true } : {});
    const usage = emptyUsage();
    if (t.lastCost !== undefined) usage.cost = Math.max(0, t.lastCost - (t.cost ?? 0));
    return { reason: turnStop(r.stop), usage, ...(r.messageId ? { extra: { acp_message_id: r.messageId } } : {}) };
  }

  // One prompt: sent with its key, answered with its message's id, and over at an idle state of the agent.
  private async submit(live: Live, s: Session, io: ExternalIO, t: TurnState, sub: { key: string; blocks: Json[]; seqs: number[] }, resent: boolean, before?: string):
    Promise<{ stop: string; error?: { code?: number; message?: string }; messageId?: string; cut?: boolean }> {
    const watch = new Watch(resent, before);
    t.watch = watch;
    t.seen = new Set();
    let finish: (r: { stop: string; error?: { code?: number; message?: string }; cut?: boolean }) => void = () => {};
    const ended = new Promise<{ stop: string; error?: { code?: number; message?: string }; cut?: boolean }>((res) => { finish = res; });
    t.ended = finish;
    const conn = live.conn;
    void conn.exited.then((code) => finish({ stop: "error", error: { message: `the agent exited (code ${code})` }, cut: true }));
    // After a stop the agent says it stopped; one that does not is ended.
    let forced: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { forced = setTimeout(() => { finish({ stop: "cancelled", cut: false }); conn.close(); this.live.delete(s.id); }, 10_000); };
    io.signal.addEventListener("abort", onAbort, { once: true });
    let grace: ReturnType<typeof setTimeout> | undefined;
    try {
      let messageId: string | undefined;
      const answer = conn.request("session/prompt", { sessionId: live.acpSession, prompt: sub.blocks, idempotencyKey: sub.key }).then((r: Json) => {
        messageId = typeof r?.messageId === "string" ? r.messageId : undefined;
        if (messageId) this.keys.answered(s.id, messageId);
        watch.answer();
        // A prompt sent again that starts no work, and reports no new message, was taken before: it is not run again.
        if (resent) grace = setTimeout(() => { if (watch.recognized && !t.seen?.size) finish({ stop: "recognized" }); }, RECOGNIZED_MS);
        // (An idle state that came before the answer ended the work already.)
        if (watch.ended) finish(watch.ended);
        return r;
      });
      let end: Awaited<typeof ended>;
      try { [, end] = await Promise.all([answer, ended]); } catch (e) {
        // -32800: the agent cancelled the prompt before it was inserted (a stop, or a close).
        if ((e as any)?.code === -32800) return { stop: "cancelled" };
        // A stop (or a restart that parks the turn) ended the connection: the work was cancelled, nothing is sent again.
        if (io.signal.aborted) return { stop: "cancelled" };
        // A connection that ended before the answer: the prompt may or may not have gone in. It stays with its key.
        throw e;
      }
      if (end.stop === "recognized") {
        t.io.append("note", { kind: "acp", text: `${live.agent.name} had already taken this message before Keel's connection to it was cut, and did not start it again. What it did while Keel was away is not shown here: ask again if the work is not done.` });
        return { stop: "end_turn", messageId };
      }
      // A connection that ended while the work ran: the turn fails and keeps its key, to be sent again.
      if (end.cut) throw new Error(end.error?.message ?? "the agent's connection ended");
      return { ...end, messageId };
    } finally {
      clearTimeout(forced); clearTimeout(grace);
      io.signal.removeEventListener("abort", onAbort);
      t.watch = undefined; t.ended = undefined;
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
    if (t.text.trim()) t.last = t.text;
    t.text = t.thinking = "";
    if (blocks.length) t.io.append("assistant", { blocks, model: t.session.model, usage: emptyUsage(), stop: calls.length ? "tool_use" : "end_turn" });
  }

  private finish(t: TurnState, tc: Json) {
    if (t.done.has(tc.toolCallId)) return;
    if (!t.stored.has(tc.toolCallId)) this.flush(t, [tc]);
    t.done.add(tc.toolCallId);
    const live = this.live.get(t.session.id);
    t.io.append("tool_result", { results: [resultOf(tc, (id) => live?.terms.shown(id) ?? live?.book.shown(id))] });
  }

  private update(live: Live, p: Json) {
    const u = p?.update;
    // (Commands may come before the setup's answer names the conversation, or with a load's replay.)
    if (u?.sessionUpdate === "available_commands_update" && (p.sessionId === live.acpSession || live.acpSession === "" || live.acpSession === "loading")) {
      live.commands = commandsOf(u.availableCommands);
      this.agents.learnCommands(live.agent, live.commands);
      return;
    }
    // What the agent says of its children: their announcements, the messages between sessions, and their own work.
    if (u?.sessionUpdate !== "session_message_chunk") this.endChunks(live);
    if (live.v === 2 && u?.sessionUpdate === "subagent_update" && p.sessionId === live.acpSession) { live.book.kid(u); this.tellJobs(live); }
    if (u?.sessionUpdate === "subagent_update") return this.announce(live, String(p.sessionId), u);
    if (u?.sessionUpdate === "session_message" || u?.sessionUpdate === "session_message_chunk") return this.said(live, String(p.sessionId), u);
    const kid = u && p.sessionId !== live.acpSession ? live.children.get(p.sessionId) : undefined;
    if (kid) return this.kidUpdate(kid, u);
    if (!u || p.sessionId !== live.acpSession) return; // a load's replay, or another conversation
    if (live.v === 2) { const v = this.updateV2(live, u); if (!v) return; return this.updateV1(live, v); }
    this.updateV1(live, u);
  }

  // The updates only v2 has. Background work is kept whether or not a turn runs; the rest reaches the turn as the
  // v1 update it is equivalent to (or none: null).
  private updateV2(live: Live, u: Json): Json | null {
    const id = String(u.messageId ?? "");
    switch (u.sessionUpdate) {
      case "state_update": this.stateUpdate(live, u); return null;
      case "terminal_update": live.book.terminal(u); this.tellJobs(live); return null;
      case "terminal_output_chunk": live.book.output(u); return null;
      case "user_message": case "user_message_chunk": live.turn?.seen?.add(id); return null;
      case "replay_complete": return null;
      case "notice": {
        const text = [u.title, u.description].filter((x) => typeof x === "string" && x).join(": ");
        if (text && live.turn) live.turn.io.append("note", { kind: "acp", text: clip(text, 1000) });
        return null;
      }
      case "agent_message": case "agent_thought": {
        const thought = u.sessionUpdate === "agent_thought";
        const add = addedText(live.texts, `${thought ? "t" : "m"}:${id}`, u.content);
        return add ? { sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk", content: { type: "text", text: add } } : null;
      }
      case "agent_message_chunk": case "agent_thought_chunk": {
        // (What the message showed so far, so that a whole message that follows adds only what is new.)
        if (u.content?.type === "text") {
          const k = `${u.sessionUpdate === "agent_thought_chunk" ? "t" : "m"}:${id}`;
          live.texts.set(k, (live.texts.get(k) ?? "") + u.content.text);
          if (live.texts.size > 256) live.texts.delete(live.texts.keys().next().value!);
        }
        return u;
      }
      case "tool_call_update": live.book.call(u); this.tellJobs(live); return u;
      default: return u;
    }
  }

  // A foreground state of the agent: kept, its background list shown as the session's jobs, and a turn that waits for
  // an idle state is told.
  private stateUpdate(live: Live, u: Json) {
    const f = foreground(u);
    live.fg = f;
    live.book.snapshot(f);
    this.tellJobs(live);
    const t = live.turn;
    if (t?.watch?.state(f)) t.ended?.(t.watch.ended!);
  }

  private tellJobs(live: Live) {
    try { acpJobs.changed?.(live.sid); } catch (e) { this.capture(e, { session: live.sid, agent: live.agent.id, at: "acp background" }); }
  }

  // The protocol a session's agent connection speaks, while it runs.
  protocol(session: string): Version | undefined {
    return this.live.get(session)?.v;
  }

  // The session's background work as the agent last listed it (ACP v2).
  background(session: string) {
    return this.live.get(session)?.book.views() ?? [];
  }

  // Stops one listed item alone, with `tool_call/cancel` or `terminal/cancel` (or the child's own cancel): nothing
  // when the request was sent, else why it was not (the spec lets a client send it only to an item that offered it).
  stopBackground(session: string, id: string, by: StopBy = "owner"): string | void {
    const live = this.live.get(session);
    if (!live || live.v !== 2 || !live.conn.alive) return "its agent is not running now";
    const c = live.book.cancel(id);
    if ("refused" in c) return c.refused;
    if (c.method === "session/cancel") {
      const kid = live.children.get(c.params.sessionId);
      if (!kid) return "its agent has not announced it as a child here";
      this.stopChild(live, kid, by);
      return;
    }
    // The agent answers when it accepted; the item's own update says when it ended (the list is not touched here).
    live.conn.request(c.method, { sessionId: live.acpSession, ...c.params }).catch((e: Error) => {
      // (-32602: it ended or cannot be stopped now; its update says which.)
      if ((e as any).code !== -32602) this.capture(e, { session, agent: live.agent.id, at: "acp background cancel" });
    });
  }

  private updateV1(live: Live, u: Json) {
    const t = live.turn;
    // The agent changed a choice itself, in a turn or between them: what is current follows it.
    if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) live.choices = withOptions(live.choices, u.configOptions);
    if (u.sessionUpdate === "current_mode_update" && live.choices.modes?.via === "mode" && typeof u.currentModeId === "string") live.choices.modes = { ...live.choices.modes, current: u.currentModeId };
    if (!t) return;
    this.apply(t, u, (live.plans ??= new Map()));
  }

  // One update of a session's work as keel events (the turn's own, or a child's).
  private apply(t: TurnState, u: Json, plans: Map<string, Json[]>, child = false) {
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
      case "tool_call_content_chunk": {
        // v2: one content item appended to the call's content.
        const prev = t.calls.get(u.toolCallId) ?? { toolCallId: u.toolCallId };
        if (u.content && typeof u.content === "object") t.calls.set(u.toolCallId, { ...prev, content: [...(prev.content ?? []), u.content] });
        break;
      }
      case "tool_call_update": {
        const prev = t.calls.get(u.toolCallId) ?? { toolCallId: u.toolCallId };
        const tc = { ...prev, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v != null)) };
        t.calls.set(tc.toolCallId, tc);
        if (!t.stored.has(tc.toolCallId) && described(tc)) this.flush(t, [tc]);
        if (tc.status === "completed" || tc.status === "failed" || tc.status === "cancelled") { this.finish(t, tc); t.io.status({ kind: "model", since: Date.now(), model: t.session.model }); }
        break;
      }
      case "plan":
      case "plan_update":
      case "plan_removed": {
        // Shown as the plan the dock and the transcript already read.
        const plan = applyPlan(plans, u);
        if (!plan) break;
        this.flush(t);
        const id = `acp-plan-${crypto.randomUUID()}`;
        t.io.append("assistant", { blocks: [{ type: "tool_use", id, name: "update_plan", input: { plan }, origin: "acp" }], model: t.session.model, usage: emptyUsage(), stop: "tool_use" });
        t.io.append("tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: "Plan updated" }] });
        break;
      }
      case "usage_update":
        // (A session's cost holds its descendants': a child's own is never added to its parent's.)
        if (!child && u.cost && typeof u.cost.amount === "number" && (!u.cost.currency || u.cost.currency === "USD")) {
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

  // --- the agent's children (docs/protocol/v1/subagents.mdx) ---

  // `outer` announced the child `u.sessionId`: the first update makes its row, its session and its card in the
  // parent's transcript; later ones patch it (a field left out keeps its value, null clears it).
  private announce(live: Live, outer: string, u: Json) {
    const kids = this.kids;
    if (!kids) return;
    const holder = outer === live.acpSession ? live.sid : live.children.get(outer)?.session;
    const id = typeof u.sessionId === "string" ? u.sessionId : "";
    if (id.length > ID_MAX) return this.odd(live, "a child with an id of " + id.length + " characters");
    // (A child has one parent, and is never its own parent's parent: nothing moves or loops.)
    if (!holder || !id || id === outer || id === live.acpSession) return;
    let c = live.children.get(id);
    if (c && c.outer !== outer) return;
    try {
      const state = patchChild(c?.state, u);
      const reading = readState(state.state);
      // A child that was not at work and is said to be again takes a place at work like a new one: the agent
      // cannot get past the limit by moving finished children back.
      if (c && Object.prototype.hasOwnProperty.call(u, "state") && !this.working(c) && this.isLive(reading) && !this.vacancy(live, holder)) return;
      if (!c) {
        const parent = this.store.session(holder);
        if (!parent) return;
        // (A child id means one child only inside the conversation it was announced in: a new conversation of the same agent starts its own.)
        const known = kids.find(holder, id, live.acpSession);
        if (!this.room(live, holder, reading)) return;
        const made = known ?? kids.create(parent, { title: state.title ?? "", agent: live.agent.name, child: id, conv: live.acpSession, callId: `acp-child-${crypto.randomUUID()}`, reading, cancel: state.cancel });
        const session = this.store.session(made.session.id) ?? made.session;
        const turn: TurnState = { io: this.kidIO(live, made.session.id, () => c!.abort.signal), session, text: "", thinking: "", calls: new Map(), stored: new Set(), done: new Set() };
        c = { id, agent: made.id, session: made.session.id, outer, state, turn, abort: new AbortController(), sig: "", tasks: 0 };
        live.children.set(id, c);
        // Its card in the parent's transcript: the call that, in a Keel session, would have started it.
        if (!known) {
          const at = outer === live.acpSession ? live.turn : live.children.get(outer)?.turn;
          if (at) this.flush(at);
          const callId = made.callId;
          const io = kids.io(holder);
          io.append("assistant", { blocks: [{ type: "tool_use", id: callId, name: "Agent", input: { description: state.title ?? "Agent", prompt: state.description ?? state.title ?? "" }, origin: "acp" }], model: parent.model, usage: emptyUsage(), stop: "tool_use" });
          io.append("tool_result", { results: [{ type: "tool_result", tool_use_id: callId, content: `${live.agent.name} runs this agent. Its work is in its own session.` }] });
        }
      } else {
        c.state = state;
        if (Object.prototype.hasOwnProperty.call(u, "state")) c.over = false; // the agent said what it is now
      }
      this.kidState(c, reading);
    } catch (e) {
      this.capture(e, { session: live.sid, agent: live.agent.id, at: "acp child" });
    }
  }

  // The row follows what the agent said of the child. Its transcript ends the work it had open when the child goes idle.
  private kidState(c: Child, reading: Reading) {
    const kids = this.kids!;
    const state = c.state;
    // The row was ended by Keel's own reading (its agent ended the prompt, or the connection): until the agent says its state again, only its label moves.
    if (c.over) {
      if (state.title) kids.patch(c.agent, { title: state.title });
      return;
    }
    if (reading.status === "running") c.ran ??= Date.now();
    else this.kidEnd(c, reading);
    const sig = JSON.stringify([state.title, state.state, state.cancel, reading.status, reading.end_reason]);
    if (sig === c.sig) return;
    c.sig = sig;
    const ended = reading.status !== "running" && reading.status !== "waiting";
    // (The folders the agent says the child works in are not taken for its session's: the gate judges what the child asks
    // against the parent's folder, so an agent cannot widen what a card or a mode allows by announcing a wider one.)
    kids.patch(c.agent, {
      ...(state.title ? { title: state.title } : {}),
      status: reading.status,
      end_reason: reading.end_reason ?? null,
      ...(ended ? { result: reading.failure ?? c.turn.last ?? "", stopped_by: reading.status === "stopped" ? (c.stopBy ?? "unknown") : null } : {}),
      external: { cancel: state.cancel, state: reading.state, gone: undefined },
    });
  }

  // Whether the announced child may be shown. One connection's children are counted against the agent limit of the
  // session's tree (src/core/agent-tree.ts: the whole tree runs at most that many at once, and the agent runs these
  // itself, but each is a row, a session and a stream of events here): the live ones are at most the limit, and all
  // of them, the finished included, at most TOTAL_PER_LIVE times it, since a finished row is still a session in the
  // owner's list. The rest are not shown, and the session is told once.
  private room(live: Live, holder: string, reading: Reading): boolean {
    const limit = Math.max(1, this.kids!.limit(live.sid));
    if (this.isLive(reading) && !this.vacancy(live, holder)) return false;
    // The total is of the live and the recent: past it the oldest finished ones are forgotten by this connection
    // (their rows and sessions stay in the store; an update of one later takes its row up again).
    const total = limit * TOTAL_PER_LIVE;
    if (live.children.size >= total) {
      for (const [id, c] of live.children) {
        if (live.children.size < total) break;
        if (!this.working(c)) live.children.delete(id);
      }
      if (live.children.size >= total) return this.capNote(live, holder, limit);
    }
    return true;
  }

  private isLive = (r: Reading) => r.status === "running" || r.status === "waiting";
  // Whether Keel shows the child as at work (a child its parent's end made incomplete is not).
  private working = (c: Child) => !c.over && this.isLive(readState(c.state.state));
  // Whether one more child may be at work: at most the tree's agent limit at once, each connection's own.
  private vacancy(live: Live, holder: string): boolean {
    const limit = Math.max(1, this.kids!.limit(live.sid));
    let n = 0;
    for (const c of live.children.values()) if (this.working(c)) n++;
    return n < limit || this.capNote(live, holder, limit);
  }
  private capNote(live: Live, holder: string, limit: number): boolean {
    if (!live.capped) {
      live.capped = true;
      this.kids!.io(holder).append("note", { kind: "acp", text: `${live.agent.name} announced more agents than Keel shows (at most ${limit} at work, ${limit * TOTAL_PER_LIVE} in all, the agent limit of this session): the others are not shown.` });
    }
    return false;
  }
  // Something the agent sent is left out because of its size: the session is told once.
  private odd(live: Live, what: string) {
    if (live.odd) return;
    live.odd = true;
    try { this.kids?.io(live.sid).append("note", { kind: "acp", text: `${live.agent.name} sent ${what}, which Keel does not read (ids and lines have a size limit): it is left out.` }); }
    catch (e) { this.capture(e, { session: live.sid, agent: live.agent.id, at: "acp child" }); }
  }

  // The child's work is cut off by something that is not its own end: its words are stored and the calls it had open are told so.
  private kidCut(c: Child, why: string) {
    const t = c.turn;
    this.flush(t);
    for (const [cid, tc] of t.calls) if (!t.done.has(cid)) this.finish(t, { ...tc, status: "failed", content: [{ type: "content", content: { type: "text", text: why } }] });
    t.io.status({ kind: "idle" });
    c.ran = undefined;
  }

  // The parent's prompt ended: a child still shown as at work was never said to be done. Its row ends as incomplete
  // (its agent may still say more of it: its next state moves the row again).
  private kidsOutlive(live: Live) {
    for (const c of live.children.values()) {
      if (c.over) continue;
      const reading = readState(c.state.state);
      if (reading.status !== "running" && reading.status !== "waiting") continue;
      try {
        this.kidCut(c, "The agent ended the turn that started this work without saying how it ended.");
        c.over = true;
        c.sig = "";
        c.abort.abort(); // what it waits on the owner for is let go
        c.abort = new AbortController();
        this.kids!.patch(c.agent, { status: "incomplete", end_reason: "parent_ended", result: c.turn.last ?? "", stopped_by: null, external: { state: "unknown" } });
      } catch (e) { this.capture(e, { session: live.sid, agent: live.agent.id, at: "acp child" }); }
    }
  }

  // The work the child had open is over (it went idle, or its connection did): its words are stored, and the calls
  // the agent never finished are told so (a cancelled one as stopped). A state nobody confirmed leaves them as they were.
  private kidEnd(c: Child, reading: Reading) {
    if (reading.state !== "idle") return;
    const t = c.turn;
    this.flush(t);
    for (const [cid, tc] of t.calls) if (!t.done.has(cid)) this.finish(t, { ...tc, status: "failed", content: [{ type: "content", content: { type: "text", text: reading.status === "stopped" ? "Interrupted by the user while this tool ran." : "The agent ended its work without finishing this call." } }] });
    t.io.status({ kind: "idle" });
    // Its work ended: the turn's end in its transcript, so the session reads as done, stopped or failed (and says how long it ran).
    if (c.ran) t.io.append("turn_end", { reason: turnReason(reading), usage: emptyUsage(), ms: Date.now() - c.ran, ...(reading.status === "stopped" && c.stopBy ? { stopped_by: c.stopBy } : {}) });
    c.ran = undefined;
  }

  // The child's own work, as the keel events of its session.
  private kidUpdate(c: Child, u: Json) {
    c.turn.session = this.store.session(c.session) ?? c.turn.session;
    this.apply(c.turn, u, (c.plans ??= new Map()), true);
  }

  // A session message: what its recipient's transcript shows of it. A parent's words to a child are the child's task
  // (then its steers); another session's are a message from another session; a child's to its parent is a note there.
  private said(live: Live, outer: string, u: Json) {
    const kids = this.kids;
    if (!kids) return;
    // (Ids are looked up and kept as keys only: one longer than any id is cut, and then names no child.)
    const to = typeof u.recipientSessionId === "string" ? clip(u.recipientSessionId, ID_MAX) : clip(outer, ID_MAX);
    const from = typeof u.senderSessionId === "string" ? clip(u.senderSessionId, ID_MAX) : undefined;
    if (u.sessionUpdate === "session_message_chunk") {
      const id = clip(String(u.messageId ?? ""), ID_MAX);
      const k = `${to}\0${id}`;
      const had = live.chunks.get(k) ?? (live.chunks.size < CHUNKS_MAX ? { to, from, text: "" } : undefined);
      if (!had) return;
      if (had.text.length < MESSAGE_MAX) had.text = (had.text + messageText(u.content)).slice(0, MESSAGE_MAX);
      live.chunks.set(k, had);
      return;
    }
    this.deliverSaid(live, to, from, messageText(u.content));
  }

  private endChunks(live: Live) {
    if (!live.chunks.size) return;
    const all = [...live.chunks.values()];
    live.chunks.clear();
    for (const m of all) this.deliverSaid(live, m.to, m.from, m.text);
  }

  private deliverSaid(live: Live, to: string, from: string | undefined, text: string) {
    const kids = this.kids;
    if (!kids || !text.trim()) return;
    try {
      const c = live.children.get(to);
      const sender = from ? live.children.get(from) : undefined;
      if (c) {
        // (Its parent's words: the task the first time, a steer after. Any other sender, or none known, is another session's.)
        const parent = from !== undefined && from === c.outer;
        const data = parent
          ? c.tasks++ === 0 ? { text, kind: "task", agent_id: c.agent } : { text, kind: "steer", agent_id: c.agent }
          : { text, kind: "peer", ...(sender ? { from_agent: sender.agent } : {}) };
        kids.io(c.session).append("user", data);
        return;
      }
      // To the parent, from a child it announced: a line in its transcript.
      const holder = to === live.acpSession ? live.sid : undefined;
      const from_ = sender;
      if (holder && from_) {
        if (live.turn) this.flush(live.turn);
        kids.io(holder).append("note", { kind: "acp", text: `Message from agent "${this.store.session(from_.session)?.title ?? "Agent"}": ${text}` });
      }
    } catch (e) {
      this.capture(e, { session: live.sid, agent: live.agent.id, at: "acp child message" });
    }
  }

  // What a child's turn needs of its io: its session's writes, and no tool of Keel's (the agent runs its own).
  private kidIO(live: Live, session: string, signal: () => AbortSignal): ExternalIO {
    const io = this.kids!.io(session);
    return {
      get signal() { return signal(); },
      events: () => this.store.events(session),
      append: (kind, data) => io.append(kind, data),
      delta: (kind, index, text) => io.delta(kind, index, text),
      status: (st) => io.status(st),
      runTool: async (_tool, _input, id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: `A child of ${live.agent.name} runs its tools itself: Keel runs none for it.` }),
    };
  }

  // The owner's Stop on a child's row: the agent is asked to cancel that child's work, if it offered to. Its answer is
  // its state: the row ends when the agent says it is idle and cancelled. What the child waits on the owner for is let go.
  // `row`: the agent row's id (a child's id means one child only inside its agent's conversation).
  cancelChild(row: string, by: StopBy): string | void {
    for (const live of this.live.values()) {
      for (const c of live.children.values()) {
        if (c.agent !== row) continue;
        if (!c.state.cancel) return `${live.agent.name} did not offer to cancel it: stop the session to end its work`;
        this.stopChild(live, c, by);
        return;
      }
    }
    return "its agent is not running now";
  }

  // The agent is asked to cancel the child (where it offered to), and what the child waits on the owner for is let go.
  private stopChild(live: Live, c: Child, by: StopBy) {
    const st = readState(c.state.state).status;
    if (!c.state.cancel || c.over || (st !== "running" && st !== "waiting")) return;
    c.stopBy = by;
    live.conn.notify("session/cancel", { sessionId: c.id });
    c.abort.abort();
    c.abort = new AbortController();
  }

  // The agent's requests: permission and files, all judged by keel's gate.
  private async request(live: Live, method: string, p: Json, rid?: number | string): Promise<Json> {
    // A terminal's output, end and release are asked for also between turns: they judge nothing.
    if (this.shell && live.v === 1 && p?.sessionId === live.acpSession) {
      if (method === "terminal/output") return live.terms.output(p);
      if (method === "terminal/kill") return live.terms.kill(p);
      if (method === "terminal/release") return live.terms.release(p);
      if (method === "terminal/wait_for_exit") return live.terms.waitForExit(p, live.turn?.io.signal ?? live.closed.signal);
    }
    // v2 states the call a permission is for as its subject; background work asks while no turn runs.
    if (live.v === 2 && method === "session/request_permission") p = legacyPermission(p);
    // A child's request is judged in the child's session, as its own parent's would be, and stays its own.
    const kid = p?.sessionId !== live.acpSession ? live.children.get(p?.sessionId) : undefined;
    if (kid) kid.turn.session = this.store.session(kid.session) ?? kid.turn.session;
    const quiet = live.v === 2 && !kid && !live.turn && method === "session/request_permission" && p.sessionId === live.acpSession;
    const t = kid ? kid.turn : live.turn;
    const s = t?.session ?? (quiet ? this.store.session(live.sid) : undefined);
    if (!s || (!t && !quiet) || (!kid && p.sessionId !== live.acpSession)) throw Object.assign(new Error("no turn is running in this session"), { code: -32002 });
    // The agent may cancel the request (`$/cancel_request`, v2): the signal is the turn's, the child's or the agent's own.
    const own = new AbortController();
    if (rid !== undefined) live.pending.set(rid, own);
    const signal = AbortSignal.any([kid ? kid.abort.signal : t ? t.io.signal : live.closed.signal, own.signal]);
    try { return await this.answer(live, method, p, { kid, t, s, signal }); } finally { if (rid !== undefined) live.pending.delete(rid); }
  }

  private async answer(live: Live, method: string, p: Json, c: { kid?: Child; t?: TurnState; s: Session; signal: AbortSignal }): Promise<Json> {
    const { kid, t, s, signal } = c;
    switch (method) {
      case "session/request_permission": {
        const prev = t?.calls.get(p.toolCall?.toolCallId) ?? {};
        // The call as announced, with what the request adds; its input as the agent streamed it when the request has none.
        const tc = { ...prev, ...(p.toolCall ?? {}), content: prev.content ?? p.toolCall?.content };
        if (!described(tc)) { const g = streamedInput(prev); if (g) tc.rawInput = g; }
        if (t && tc.toolCallId) { t.calls.set(tc.toolCallId, tc); if (!t.stored.has(tc.toolCallId)) this.flush(t, [tc]); }
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
        const h = await hold(path, { judged: [path] }, "read");
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
        const h = await hold(path, { judged: [path] }, "write");
        if ("refused" in h) throw Object.assign(new Error(h.refused), { code: -32000 });
        try { const no = await writeHeld(h, String(p.content ?? "")); if (no) throw Object.assign(new Error(no), { code: -32000 }); } finally { h.close(); }
        return null;
      }
      case "terminal/create":
        if (!this.shell) break;
        if (kid) throw Object.assign(new Error("Keel runs no terminal for a child agent"), { code: -32601 });
        if (!t) break;
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
    if (l.v === 2 || l.caps.sessionCapabilities?.close) void l.conn.request("session/close", { sessionId: l.acpSession }).catch(() => {}).finally(() => l.conn.close());
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
