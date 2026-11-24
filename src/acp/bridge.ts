// `keel acp`: an editor (Zed, or any Agent Client Protocol client) drives
// keel-bun over ACP v1 on stdio. The bridge is a client of the running daemon:
// sessions it makes are the workbench's sessions (both show the same turns),
// the daemon runs the tools in its own permission gate, and an approval card
// becomes the editor's permission request (answered in either place).
//
// Spec: agentclientprotocol.com/protocol/v1 (initialize, session/new, load,
// resume, close, list, prompt, cancel, set_mode, set_config_option;
// session/update (usage_update and available_commands_update among them),
// session/request_permission and elicitation/create toward the client).
// A client that advertises `subagents` sees the agents of a session it holds
// as child sessions (src/acp/subagents.ts says what is sent for one).
import { INPUT_LABEL, inputKind } from "../core/inputs.ts";
import { contextTokens } from "../engine/compact.ts";
import { questions } from "../../ui/src/lib/tools.ts";
import { lineage } from "../core/tree.ts";
import type { StoredEvent } from "../core/types.ts";
import { cardForm, cardLines, type CardForm } from "../safety/card.ts";
import type { Approval } from "../safety/gate.ts";
import { spelled } from "../safety/chars.ts";
import { RESTARTED, retryNotice, streamStep } from "./stream.ts";
import { childDirs, childInput, isLive, spawnTask, subagentUpdate, taskLine, type AgentSeen } from "./subagents.ts";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export const PROTOCOL_VERSION = 1;

type Json = any;
type Send = (msg: Json) => void;

const MODES = [
  { id: "ask", name: "Ask", description: "Reads run; edits, commands and other tools ask first." },
  { id: "auto-edits", name: "Auto edits", description: "Edits in the folder run; commands ask." },
  { id: "auto", name: "Auto", description: "Safe work runs; uncovered calls go to the judge. Owner-only actions still ask." },
  { id: "full-auto", name: "Full auto", description: "Ordinary calls run without review. Flagged calls are checked without waiting." },
  { id: "read-only", name: "Read only", description: "Nothing changes." },
];

// What kind of work a tool does, for the editor's icon.
export function toolKind(name: string): string {
  const n = name.toLowerCase();
  if (/^(read|read_file|view|notebookread|cat)$/.test(n) || n.endsWith("__read_resource")) return "read";
  if (/^(edit|write|multiedit|notebookedit|apply_patch|replace|write_file|edit_file)$/.test(n)) return "edit";
  if (/^(glob|grep|search|search_files|list_directory|ls|find|search_tools)$/.test(n)) return "search";
  if (/^(bash|shell|exec_command|run_shell_command|local_shell|taskstop)$/.test(n)) return "execute";
  if (/^(webfetch|web_fetch|websearch|web_search)$/.test(n)) return "fetch";
  if (/^(todowrite|update_plan|think)$/.test(n)) return "think";
  return "other";
}

export function toolTitle(name: string, input: Json): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const cmd = s(input?.command) || s(input?.cmd) || (Array.isArray(input?.command) ? input.command.join(" ") : "");
  if (cmd) return input?.description ? `${input.description}` : cmd.length > 120 ? cmd.slice(0, 119) + "…" : cmd;
  const path = s(input?.file_path) || s(input?.path) || s(input?.absolute_path);
  if (path) return `${name} ${path}`;
  if (name === "mcp_call" && input?.tool) return `${input.tool}`;
  const q = s(input?.pattern) || s(input?.query) || s(input?.url);
  return q ? `${name} ${q}` : name;
}

// Where a call reads or writes, and an edit as a diff the editor can show.
export function toolDetail(name: string, input: Json): { locations?: Json[]; content?: Json[] } {
  const path = input?.file_path ?? input?.path ?? input?.absolute_path;
  const out: { locations?: Json[]; content?: Json[] } = {};
  if (typeof path === "string") out.locations = [{ path }];
  const n = name.toLowerCase();
  if (typeof path === "string" && n === "edit" && typeof input?.new_string === "string")
    out.content = [{ type: "diff", path, oldText: input.old_string ?? "", newText: input.new_string }];
  else if (typeof path === "string" && (n === "write" || n === "write_file") && typeof input?.content === "string")
    out.content = [{ type: "diff", path, oldText: null, newText: input.content }];
  return out;
}

// TodoWrite / update_plan as an ACP plan.
// The editor's permission request for a gate card: what the card shows the
// owner, its reason (why only once is offered, why the owner is asked) included.
// `form`: the card as the daemon gives it to every client (src/safety/card.ts).
// With it the request carries the whole text to judge in its content, each
// hidden character written out, with what in it can mislead, where it runs and
// whether only its start is kept: an editor shows a request's content in full,
// and a title only as a line. An allow then says the text was shown (`seen`).
export function permissionRequest(a: Json, name: string, form?: CardForm): Json {
  const options = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    // (The rule it stores, with any character that hides or reorders text written out.)
    ...(a.risk !== "high" && a.suggest?.length ? [{ optionId: "always", name: `Always allow ${a.suggest.map((s: Json) => spelled(String(s.pattern ?? ""), "")).join(", ")}`, kind: "allow_always" }] : []),
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  const l = form ? cardLines(form) : undefined;
  const why = l ? l.notes.join(" ") : [a.risk === "high" ? `High risk${a.why ? `: ${a.why}` : ""}.` : a.why ? `${a.why}.` : "", a.notice ?? ""].filter(Boolean).join(" ");
  const held = !!form?.hold.length;
  // A fence no run of backticks in the text can close.
  const fence = "`".repeat(Math.max(3, ...(l?.text.match(/`+/g) ?? []).map((r) => r.length + 1)));
  const first = (l?.text.split("\n")[0] ?? "").slice(0, 120);
  const title = held && form && l
    ? `${spelled(name, "")}: ${first}${form.lines > 1 || first.length < l.text.length ? " ..." : ""} (${form.lines > 1 ? `${form.lines} lines` : `${form.chars} characters`}: the whole request is below)`
    : (l ? spelled(a.summary ?? "") : a.summary) || toolTitle(name, a.input);
  const content = [
    ...(why ? [{ type: "content", content: { type: "text", text: why } }] : []),
    ...(held && l ? [{ type: "content", content: { type: "text", text: `${fence}\n${l.text}\n${fence}` } }] : []),
  ];
  return {
    sessionId: a.session_id,
    toolCall: {
      toolCallId: a.call_id, title, kind: toolKind(name), status: "pending", rawInput: a.input,
      ...(content.length ? { content } : {}),
    },
    options,
  };
}

// A session's plan is one list that every TodoWrite or update_plan replaces: one id.
const PLAN_ID = "plan";

export function planOf(name: string, input: Json): Json[] | null {
  const n = name.toLowerCase();
  if (n === "todowrite" && Array.isArray(input?.todos))
    return input.todos.map((t: Json) => ({ content: String(t.content ?? t.activeForm ?? ""), priority: "medium", status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" }));
  if (n === "update_plan" && Array.isArray(input?.plan))
    return input.plan.map((t: Json) => ({ content: String(t.step ?? ""), priority: "medium", status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending" }));
  return null;
}

const TEXT_CAP = 20_000;
const capped = (t: string) => (t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + `\n[${t.length - TEXT_CAP} more characters not shown]` : t);

// A stored result's blocks as ACP tool call content, in order: text and images.
export function resultContent(c: Json): Json[] {
  const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
  const out: Json[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) out.push({ type: "content", content: { type: "text", text: capped(b.text) } });
    else if (b.type === "image" && b.data) out.push({ type: "content", content: { type: "image", mimeType: b.media_type, data: b.data } });
    else if (b.type) out.push({ type: "content", content: { type: "text", text: `[${b.type} not shown here]` } });
  }
  return out;
}

// A stored prompt's blocks as ACP content: its text, its images, and its files as links.
export function userContent(d: Json): Json[] {
  const out: Json[] = [];
  for (const b of d.images ?? []) {
    if (b.type === "image" && b.data) out.push({ type: "image", mimeType: b.media_type, data: b.data });
    else if (b.type === "attachment") out.push({ type: "resource_link", uri: `keel-attachment:${b.id}`, name: b.name, mimeType: b.media_type, size: b.size });
  }
  if (d.text) out.push({ type: "text", text: d.text });
  return out;
}

// The editor's prompt blocks as one keel-bun message: text, resource links and
// embedded text resources as text, images and embedded images as images, other
// embedded files as attachments (uploaded through `upload`). A block Keel cannot
// carry is refused before anything is sent.
export async function promptOf(blocks: Json[], upload?: (name: string, type: string, bytes: Uint8Array) => Promise<Json>): Promise<{ text: string; images: Json[] }> {
  const parts: string[] = [];
  const images: Json[] = [];
  for (const b of blocks ?? []) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`@${b.uri?.replace(/^file:\/\//, "") ?? b.name}`);
    else if (b.type === "resource" && b.resource) {
      const r = b.resource;
      const uri = String(r.uri ?? "");
      const path = uri.replace(/^file:\/\//, "");
      if (typeof r.text === "string") parts.push(`<file path="${path}">\n${r.text}\n</file>`);
      else if (typeof r.blob === "string") {
        const type = String(r.mimeType ?? "application/octet-stream");
        if (/^image\/(png|jpeg|gif|webp)$/.test(type)) images.push({ type: "image", media_type: type, data: r.blob });
        else if (upload) images.push(await upload(path.split("/").filter(Boolean).pop() || "file", type, Buffer.from(r.blob, "base64")));
        else throw Object.assign(new Error(`the embedded resource ${uri} (${type}) cannot be attached`), { code: -32602 });
      }
    } else if (b.type === "image" && b.data) images.push({ type: "image", media_type: b.mimeType, data: b.data });
    else if (b.type === "audio") throw Object.assign(new Error("audio prompts are not supported"), { code: -32602 });
  }
  return { text: parts.join("\n\n"), images };
}

// Keel's question tools, answered through an elicitation form when the editor offers one.
const ASK_TOOLS = new Set(["AskUserQuestion", "request_user_input", "ask_user"]);

// A question card as an elicitation form: one field per question, its options
// as an enum (a list of them when several may be picked), "other" as free text.
export function questionForm(name: string, input: Json): { message: string; requestedSchema: Json; ids: string[] } | null {
  const qs = questions(name, input);
  if (!qs.length || qs.some((q) => !q.options.length)) return null;
  const properties: Json = {};
  for (const q of qs) {
    const values = q.options.map((o) => o.label);
    properties[q.id] = q.multi
      ? { type: "array", title: q.header || q.question, description: q.question, items: { type: "string", enum: values } }
      : { type: "string", title: q.header || q.question, description: q.question, enum: values };
  }
  return { message: qs.length === 1 ? qs[0]!.question : "Keel asks:", requestedSchema: { type: "object", properties, required: qs.map((q) => q.id) }, ids: qs.map((q) => q.id) };
}

// What the context holds now and what it can hold, for usage_update.
export function usageOf(events: StoredEvent[], context: number | undefined, cost: number | undefined, model?: string): Json | null {
  if (!context) return null;
  return { sessionUpdate: "usage_update", used: contextTokens(events, model).used, size: context, ...(typeof cost === "number" ? { cost: { amount: Number(cost.toFixed(6)), currency: "USD" } } : {}) };
}

export type DaemonApi = {
  get(path: string): Promise<Json>;
  send(method: string, path: string, body?: Json): Promise<Json>;
  upload?(name: string, type: string, bytes: Uint8Array): Promise<Json>;
  // A socket of this editor's own to the daemon, under a name: what is set
  // with that name as its `holder` ends when the socket closes, however this
  // process went. Resolves to what closes it.
  hold?(holder: string): Promise<() => void>;
  frames(on: (f: Json) => void): Promise<() => void>;
  // The frames socket hears only the sessions named here (as a page names the
  // ones it shows), from the cursor given: the events stored after it, then
  // every frame of the session. A null cursor: from now. Without these the
  // socket hears every session.
  watch?(cursors: Record<string, number | null>): void;
  unwatch?(ids: string[]): void;
};

// One session/prompt call. It is settled once, by the end of the turn that took
// its prompt in: `after` is the seq of the stored prompt (null until the daemon
// says where it went), `queueId` its queue row while it waits behind a running turn.
type Prompt = { resolve: (r: Json) => void; reject: (e: Error) => void; after: number | null; queueId?: string; cancelled: boolean; settled: boolean };
// What this editor waits on in one session: its open prompts, and what passed while a prompt was still on its way to the
// daemon (the queued prompts stored since, the turn ends since).
// `seq`: the last event seen, where a prompt counts from when the daemon's answer names no event.
type Live = { prompts: Prompt[]; error?: string; seq: number; delivered: Map<string, number>; ends: { seq: number; reason: string; error?: string }[] };
// A reply as the editor shows it while it streams: `shown` of its text and its
// thought, `streamed` of the attempt that streams now (src/acp/subagents.ts streamStep).
type Text = { shown: string; streamed: string; thoughtShown: string; thoughtStreamed: string };
// An agent of a session this editor holds, as a child session: its parent's
// session, the record as last told, the label and state last sent, what of its
// own waits on the owner (its approvals by id, its questions as `q:` and the
// call's id). One on another machine is announced once its folder there is
// read (`workspace`): until then it is not shown, rather than shown in its
// parent's folder.
type Child = { parent: string; agent: AgentSeen; description?: string; sent?: string; asks: Set<string>; workspace?: string; placing?: boolean; from?: number | null };
// A place an agent may write as the folder it is in: itself when it is a folder here, else the folder that holds it.
const folderOf = (p: string) => { try { return statSync(p).isDirectory() ? p : dirname(p); } catch { return dirname(p); } };
// The spawn tools whose call names an agent's task.
const SPAWN_TOOLS = new Set(["Agent", "Task", "spawn_agent", "keel__spawn_on_machine"]);

const LIST_PAGE = 200;

// The newest event a session read answered: where its frames go on from.
const lastSeq = (r: Json): number => (typeof r?.seq === "number" ? r.seq : ((r?.events ?? []) as Json[]).reduce((n, e) => (typeof e?.seq === "number" && e.seq > n ? e.seq : n), 0));

// One editor connection.
export class AcpBridge {
  private nextId = 1;
  private pending = new Map<number, (msg: Json) => void>();
  private live = new Map<string, Live>();
  private caps: Json = {};
  private planned = new Set<string>(); // sessions whose plan the editor was given as an identified one
  private tools = new Map<string, string>(); // tool_use id -> tool name
  private asked = new Set<string>();         // approvals sent to the editor
  private stopFrames?: () => void;
  private models: Json[] | null = null;
  private defaultModel = "";
  // Sessions this editor opened (new, load, resume, a prompt) and has not
  // closed: their frames come to it (the socket hears no other session's), and
  // with `subagents` their agents are its child sessions, while it holds them.
  private holds = new Map<string, Promise<void>>();
  private children = new Map<string, Child>(); // child session id -> its agent
  private agentSessions = new Map<string, string>(); // agent id -> the child session it was announced as
  private texts = new Map<string, Text>();
  private spawnTasks = new Map<string, string>(); // a spawn call's id -> its task line
  private retried = new Map<string, string>(); // session -> the retry status last told of its reply
  private elicited = new Set<string>(); // question calls sent to the editor as forms (session and call id)
  // Sessions being loaded: their frames wait here until the history is replayed, so nothing live goes before it.
  private loading = new Map<string, Json[]>();
  private titles = new Map<string, string>(); // session -> the title last told

  private get subagents() { return !!this.caps?.subagents; }
  // Whether the editor is shown what a session does now: a prompt of its own is
  // open there, or (with subagents) it holds the session, or the session is an
  // agent of one it holds that is shown (one on another machine is shown once its folder is known).
  private streams(id: string) { return this.live.has(id) || (this.subagents && (this.holds.has(id) || this.shown(id))); }
  private shown(id: string) {
    const c = this.children.get(id);
    return !!c && !(c.agent.machine && c.workspace === undefined);
  }

  constructor(private daemon: DaemonApi, private out: Send, private log: (m: string) => void = () => {}) {}

  private notify(sessionId: string, update: Json) {
    this.out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  private asking = new Map<string, number>(); // approval id -> our request id

  private request(method: string, params: Json, key?: string): Promise<Json> {
    const id = this.nextId++;
    if (key) this.asking.set(key, id);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.out({ jsonrpc: "2.0", id, method, params });
    });
  }

  async handle(msg: Json) {
    if (msg.id !== undefined && msg.method === undefined) {
      // An answer to one of ours.
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      p?.(msg);
      return;
    }
    const reply = (result: Json) => msg.id !== undefined && this.out({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => msg.id !== undefined && this.out({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    try {
      const r = await this.dispatch(msg.method, msg.params ?? {});
      if (r !== undefined) reply(r);
    } catch (e) {
      const err = e as Error & { code?: number };
      this.log(`${msg.method}: ${err.message}`);
      fail(err.code ?? -32603, err.message);
    }
  }

  private async ensureFrames() {
    if (!this.stopFrames) this.stopFrames = await this.daemon.frames((f) => this.onFrame(f));
  }

  // The MCP servers the editor passed with a session (session/new, load and
  // resume carry the whole list): the daemon starts them for that session
  // alone, and the session's permission mode decides what their tools may do.
  // One Keel cannot take is said to the editor by name; the session opens
  // either way. A session the editor closes lets go of them.
  // The daemon holds them for this editor (`hold`): when this process ends,
  // however it ends, they end too.
  private served = new Set<string>();
  private holder = `acp-${crypto.randomUUID()}`;
  private holding?: Promise<() => void>;
  private async mcpServers(sessionId: string, given: unknown, fresh = false) {
    const list = Array.isArray(given) ? given : [];
    // A new session has none to drop; one opened again may hold an earlier editor's.
    if (!list.length && fresh) return;
    const pairs = (v: unknown) => (Array.isArray(v) ? Object.fromEntries(v.filter((x) => x && typeof x.name === "string").map((x) => [x.name, String(x.value ?? "")])) : undefined);
    // Each entry is one transport the daemon can start, or is named as not connected and starts nothing:
    // a command entry is stdio only with no type or "stdio" (the spec's own), never by guessing from a type it does not know.
    const servers: Json[] = [];
    const refused: string[] = [];
    // (An entry's `_meta.keel` may say how its server lives: `share: false` for no other session's use of it, `keep_running: true`.)
    const lives = (m: Json) => ({ ...(m?._meta?.keel?.share === false ? { share: false } : {}), ...(m?._meta?.keel?.keep_running === true ? { keep_running: true } : {}) });
    for (const m of list as Json[]) {
      const name = typeof m?.name === "string" ? m.name : "";
      const type = m?.type;
      if (type === "http" || type === "sse") {
        if (typeof m.url === "string" && m.url) servers.push({ name, url: m.url, headers: pairs(m.headers), ...(type === "sse" ? { transport: "sse" } : {}), ...lives(m) });
        else refused.push(`${name}: no url for its ${type} transport`);
      } else if (type !== undefined && type !== "stdio") {
        refused.push(`${name}: the transport type ${JSON.stringify(String(type)).slice(0, 40)} is not supported (stdio, http and sse are)`);
      } else if (type === undefined && m?.url && !m?.command) {
        servers.push({ name, url: m.url, headers: pairs(m.headers), ...lives(m) });
      } else if (typeof m?.command === "string" && m.command) {
        servers.push({ name, command: m.command, args: m.args, env: pairs(m.env), ...lives(m) });
      } else refused.push(`${name}: no command to start`);
    }
    // Known as served before the daemon is asked: one that fails at once is told while the answer is on its way.
    if (list.length) this.served.add(sessionId);
    let failed: string[] = [...refused];
    try {
      if (servers.length && this.daemon.hold) await (this.holding ??= this.daemon.hold(this.holder));
      const r = await this.daemon.send("PUT", `/api/sessions/${sessionId}/mcp`, { servers, ...(this.daemon.hold ? { holder: this.holder } : {}) });
      failed.push(...(r.set ?? []).filter((x: Json) => x.error).map((x: Json) => `${x.name}: ${x.error}`));
    } catch (e) {
      this.holding = undefined; // a hold that did not open is tried again with the next list
      failed.push(`${servers.map((m) => m.name).join(", ")}: ${(e as Error).message}`);
    }
    if (!list.length) this.served.delete(sessionId);
    // After the answer, so the editor knows the session first.
    if (failed.length) {
      const what = failed.length === 1 ? "an MCP server" : "MCP servers";
      queueMicrotask(() => this.say(sessionId, "warning", `Keel did not connect ${what} the editor passed`, failed.join("; "), `Keel did not connect ${what} the editor passed (${failed.join("; ")}).\n\n`));
    }
  }

  // The session's frames come to this editor from `cursor` on (null: from now;
  // undefined: from where the session stands, read now). Once a session.
  private hold(id: string, cursor?: number | null): Promise<void> {
    let h = this.holds.get(id);
    if (!h) {
      h = (async () => {
        if (!this.daemon.watch) return;
        const from = cursor !== undefined ? cursor : await this.daemon.get(`/api/sessions/${id}?events=0`).then((r) => (typeof r?.seq === "number" ? r.seq : null), () => null);
        this.daemon.watch({ [id]: from });
      })();
      this.holds.set(id, h);
    }
    return h;
  }

  // The editor closed the session: its frames and its agents' stop coming.
  private unhold(id: string) {
    if (!this.holds.delete(id)) return;
    const gone = this.descendants(id);
    for (const c of gone) {
      const child = this.children.get(c)!;
      this.children.delete(c);
      if (this.agentSessions.get(child.agent.id) === c) this.agentSessions.delete(child.agent.id);
    }
    for (const x of [id, ...gone]) { this.offered.delete(x); this.texts.delete(x); this.retried.delete(x); this.planned.delete(x); }
    this.daemon.unwatch?.([id, ...gone]);
  }

  // The child sessions under a session, at any depth.
  private descendants(id: string): string[] {
    const out: string[] = [];
    const under = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [cid, c] of this.children) if (under.has(c.parent) && !under.has(cid)) { under.add(cid); out.push(cid); grew = true; }
    }
    return out;
  }

  // The agents under a session this editor holds, each after the one that
  // started it, announced as they are now (after a load's answer: what came
  // before it is history), their frames from now on. What waits on the owner
  // in the session and its agents was put up before the editor held them: a
  // child that waits on a card is announced as needing action, and the editor
  // is asked each card and question it was not asked yet.
  private async announceTree(root: string) {
    if (!this.subagents) return;
    const [r, open] = await Promise.all([
      this.daemon.get(`/api/sessions/${root}/agents`).catch(() => null),
      this.daemon.get(`/api/cli/state/${root}`).catch(() => null),
    ]);
    const approvals = ((open?.approvals ?? []) as Json[]).filter((a) => a?.id && a.session_id && a.call_id);
    const questions = ((open?.questions ?? []) as Json[]).filter((q) => q?.session_id && q.call_id);
    const waiting = (sid: string) => [...approvals.filter((a) => a.session_id === sid).map((a) => String(a.id)), ...questions.filter((q) => q.session_id === sid).map((q) => `q:${q.call_id}`)];
    // A load or resume asks again: each child's label and state are sent again, current.
    for (const id of this.descendants(root)) this.children.get(id)!.sent = undefined;
    for (const row of (r?.tree ?? []) as AgentSeen[]) {
      if (!this.holds.has(root)) return; // closed meanwhile
      this.onAgent(row, null, waiting(row.session_id));
    }
    for (const a of approvals) {
      if (!this.streams(a.session_id) || this.asked.has(a.id)) continue;
      this.asked.add(a.id);
      void this.ask(a);
    }
    if (this.caps?.elicitation?.form) for (const q of questions) {
      if (this.streams(q.session_id) && ASK_TOOLS.has(q.tool)) void this.elicit(q.session_id, { id: q.call_id, name: q.tool, input: q.input });
    }
  }

  // An agent's record as the daemon tells it. One under a session this editor
  // holds is announced on its parent before anything of its own is sent, and
  // its session's frames come from its task on (`cursor` undefined) or from now.
  // `waiting`: what of its own waits on the owner now (a load or resume read it).
  private onAgent(a: AgentSeen, cursor?: number | null, waiting?: string[]) {
    if (!this.subagents || !a?.session_id || !a.parent_id) return;
    let c = this.children.get(a.session_id);
    if (!c) {
      if (!this.holds.has(a.parent_id) && !this.children.has(a.parent_id)) return;
      // A fresh context of the same agent (its context was lost: src/automation/successor.ts)
      // is a new child session; the one it took over from ends there.
      const was = this.agentSessions.get(a.id);
      if (was && was !== a.session_id) this.lostContext(was);
      c = { parent: a.parent_id, agent: a, asks: new Set(waiting), description: a.call_id ? this.spawnTasks.get(a.call_id) : undefined };
      this.children.set(a.session_id, c);
      this.agentSessions.set(a.id, a.session_id);
      const from = cursor === undefined ? Math.max(0, a.first_seq ?? 0) : cursor;
      c.from = from;
      if (a.machine) void this.placeRemote(c);
      else this.show(c, from);
      return;
    }
    c.agent = a;
    if (waiting) c.asks = new Set(waiting);
    if (a.machine && c.workspace === undefined) void this.placeRemote(c);
    else this.announce(c);
  }

  // A child is announced, then its frames come.
  private show(c: Child, from: number | null) {
    this.announce(c);
    this.daemon.watch?.({ [c.agent.session_id]: from });
  }

  // An agent on another machine works in its session's folder there: read before it is shown.
  // A read that fails leaves it unshown; its next record tries again.
  private async placeRemote(c: Child) {
    if (c.placing) return;
    c.placing = true;
    const r = await this.daemon.get(`/api/sessions/${c.agent.session_id}?events=0`).catch(() => null);
    c.placing = false;
    if (this.children.get(c.agent.session_id) !== c) return; // let go of meanwhile
    if (typeof r?.session?.workspace !== "string" || !r.session.workspace) return;
    c.workspace = r.session.workspace;
    this.show(c, c.from ?? null);
  }

  private lostContext(old: string) {
    const c = this.children.get(old);
    if (!c) return;
    this.notify(c.parent, { sessionUpdate: "subagent_update", sessionId: old, capabilities: {}, state: { state: "idle", stopReason: "error", error: { code: -32603, message: "This context of the agent was lost. A fresh context of it goes on as another child session." } } });
    c.sent = "lost";
    this.daemon.unwatch?.([old]);
  }

  // The parent's update for a child, sent when what it says changed.
  private announce(c: Child) {
    if (c.sent === "lost" || (c.agent.machine && c.workspace === undefined)) return;
    const u = subagentUpdate(c.agent, { description: c.description, asking: c.asks.size > 0, dirs: childDirs(c.agent, { workspace: c.workspace, dirOf: folderOf }) });
    const key = JSON.stringify(u);
    if (key === c.sent) return;
    c.sent = key;
    this.notify(c.parent, u);
  }

  // A spawn call's task line, for the child it starts.
  private noteSpawns(e: StoredEvent) {
    if (e.kind !== "assistant") return;
    for (const b of e.data?.blocks ?? []) {
      if (b.type !== "tool_use" || !SPAWN_TOOLS.has(b.name)) continue;
      const line = spawnTask(b.input);
      if (line) this.spawnTasks.set(b.id, line);
    }
  }

  private text(id: string): Text {
    return this.texts.get(id) ?? this.texts.set(id, { shown: "", streamed: "", thoughtShown: "", thoughtStreamed: "" }).get(id)!;
  }

  // A delta of a reply: what the editor does not show yet of it goes.
  private delta(id: string, kind: string, chunk: string) {
    const t = this.text(id);
    if (kind === "text") {
      const step = streamStep(t.shown, (t.streamed += chunk));
      t.shown = step.shown;
      if (step.send) this.notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.restarted ? RESTARTED + step.send : step.send } });
    } else if (kind === "thinking") {
      const step = streamStep(t.thoughtShown, (t.thoughtStreamed += chunk));
      t.thoughtShown = step.shown;
      if (step.send) this.notify(id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.send } });
    }
  }

  // The turn's request failed and is sent again: its reply streams from the
  // start, and what the editor shows of it is not sent again (delta). A client
  // that takes notices is told by one; another, when it shows part of the
  // reply, by one short line in it.
  private retry(id: string, s: Json) {
    const t = this.text(id);
    t.streamed = "";
    t.thoughtStreamed = "";
    const key = JSON.stringify([s.attempt, s.max, s.message, !!s.unreachable, s.limit ?? null]);
    if (this.retried.get(id) === key) return; // the same wait told again
    const first = !this.retried.has(id);
    this.retried.set(id, key);
    if (this.caps?.session?.notices) this.notify(id, retryNotice(s));
    else if (first && t.shown) this.notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\n[Keel: the model request failed and is sent again.]\n\n" } });
  }

  // The session's plan, as the editor takes it: an editor that advertised plan
  // operations gets it as the session's one identified plan, and its removal when
  // it is cleared; another gets the legacy checklist, an empty one included.
  private plan(id: string, entries: Json[]) {
    if (!this.caps?.plan) return this.notify(id, { sessionUpdate: "plan", entries });
    if (entries.length) {
      this.planned.add(id);
      this.notify(id, { sessionUpdate: "plan_update", plan: { type: "items", planId: PLAN_ID, entries } });
    } else if (this.planned.delete(id)) this.notify(id, { sessionUpdate: "plan_removed", planId: PLAN_ID });
  }

  // Something the editor's user should know that is not the conversation: a
  // client that takes notices gets one, another the same words as a line of the
  // reply (the protocol's fallback).
  private say(id: string, severity: "info" | "warning" | "error", title: string, description: string, line: string) {
    if (this.caps?.session?.notices) this.notify(id, { sessionUpdate: "notice", severity, title, ...(description ? { description } : {}) });
    else this.notify(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: line } });
  }

  // Resolves when the daemon was told what this editor held is let go.
  close(): Promise<unknown> {
    // The editor is gone: the servers it passed go with it (it passes them
    // again when it loads the session). The daemon is told first, and the
    // sockets close after it answered: the frames socket's end is this process's.
    const held = this.holding;
    const released = Promise.allSettled([...this.served].map((id) => this.daemon.send("PUT", `/api/sessions/${id}/mcp`, { servers: [] })))
      .then(() => held?.then((stop) => stop(), () => {}))
      .finally(() => this.stopFrames?.());
    this.served.clear();
    for (const [id, l] of [...this.live]) for (const p of [...l.prompts]) if (this.take(id, p)) p.resolve({ stopReason: "cancelled" });
    return released;
  }

  // A prompt's call leaves the session's open prompts to be answered; false when it was answered before.
  private take(sessionId: string, p: Prompt): boolean {
    if (p.settled) return false;
    p.settled = true;
    const l = this.live.get(sessionId);
    if (l) {
      l.prompts = l.prompts.filter((x) => x !== p);
      if (!l.prompts.length) this.live.delete(sessionId);
    }
    return true;
  }

  // The turn that took these prompts in has ended: each call gets that end.
  private settle(sessionId: string, prompts: Prompt[], reason: string, error?: string) {
    const open = prompts.filter((p) => this.take(sessionId, p));
    if (!open.length) return;
    const stopReason = reason === "interrupted" || reason === "restart" ? "cancelled"
      : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : reason === "max_steps" ? "max_turn_requests" : "end_turn";
    const answer = () => {
      for (const p of open) {
        if (reason === "error" && !p.cancelled) p.reject(Object.assign(new Error(error ?? "the turn failed"), { code: -32603 }));
        else p.resolve({ stopReason: p.cancelled ? "cancelled" : stopReason });
      }
    };
    // The context and cost as the turn left them, before the turn's answer.
    if (reason === "error" && open.every((p) => !p.cancelled)) answer();
    else void this.usage(sessionId).finally(answer);
  }

  // The daemon said where a prompt went: into the history (its stored event), or
  // into the queue behind a running turn. A turn end that passed meanwhile is its
  // end only when it came after the stored prompt.
  private place(sessionId: string, p: Prompt, r: Json) {
    const l = this.live.get(sessionId);
    if (!l || p.settled) return;
    const sent = r?.event?.event || r?.event?.queued ? r.event : r; // a command's answer wraps the prompt's
    if (sent?.queued?.id) {
      p.queueId = String(sent.queued.id);
      p.after = l.delivered.get(p.queueId) ?? null;
    } else p.after = typeof sent?.event?.seq === "number" ? sent.event.seq : l.seq;
    const end = p.after === null ? undefined : l.ends.find((e) => e.seq > p.after!);
    if (!l.prompts.some((x) => x.after === null && !x.queueId)) l.ends = [];
    if (end) this.settle(sessionId, [p], end.reason, end.error);
    // Cancelled while it was on its way: it is stopped where it landed.
    else if (p.cancelled && p.queueId && p.after === null) void this.unqueue(sessionId, p);
    else if (p.cancelled) void this.daemon.send("POST", `/api/sessions/${sessionId}/interrupt`, {}).catch(() => {});
  }

  // A prompt still waiting in the queue is taken out, so it never starts a turn
  // the editor gave up on; its call ends as cancelled.
  private async unqueue(sessionId: string, p: Prompt) {
    const gone = await this.daemon.send("DELETE", `/api/sessions/${sessionId}/queue/${p.queueId}`).then(() => true, () => false);
    if (gone && p.after === null) this.settle(sessionId, [p], "interrupted");
  }

  // The editor stops what it asked for: its queued prompts leave the queue and the running turn is cut.
  private async stop(sessionId: string) {
    for (const p of [...(this.live.get(sessionId)?.prompts ?? [])]) {
      p.cancelled = true;
      if (p.queueId && p.after === null) await this.unqueue(sessionId, p);
    }
    await this.daemon.send("POST", `/api/sessions/${sessionId}/interrupt`, {});
  }

  // The queue changed. A prompt of ours that is no longer in it and not in the
  // history either was removed in the workbench (the daemon still holds one it is
  // sending now, and says so): its call ends as cancelled instead of waiting forever.
  private async queueChanged(sessionId: string, queue: Json[]) {
    for (const p of [...(this.live.get(sessionId)?.prompts ?? [])]) {
      if (!p.queueId || p.after !== null || queue.some((q) => q.id === p.queueId)) continue;
      const gone = await this.daemon.send("PATCH", `/api/sessions/${sessionId}/queue/${p.queueId}`, {}).then(() => false, (e) => e?.code === -32002);
      if (!gone || p.after !== null) continue;
      const r = await this.daemon.get(`/api/sessions/${sessionId}`).catch(() => null);
      if (!r || p.after !== null || (r.events ?? []).some((e: Json) => e.kind === "user" && e.data?.queue_id === p.queueId)) continue;
      this.settle(sessionId, [p], "interrupted");
    }
  }

  // The daemon's listing, read again when a session is opened (it changes as
  // providers come and go) and kept for the option answers in between.
  private async modelOptions(fresh = false) {
    if (!this.models || fresh) {
      const r = await this.daemon.get("/api/models");
      this.models = r.models ?? [];
      this.defaultModel = r.default ?? "";
    }
    const groups = new Map<string, Json[]>();
    for (const m of this.models!) (groups.get(m.provider) ?? groups.set(m.provider, []).get(m.provider)!).push({ value: m.id, name: m.name, description: m.id });
    return [...groups].map(([name, options]) => ({ group: name, name, options }));
  }

  // What the editor was last offered for a session's model and effort: a change made elsewhere
  // (the workbench, a model switch) is told to it as an update that resends the options.
  private offered = new Map<string, string>();
  private static offer(s: Json) { return `${s.model ?? ""}\0${s.settings?.effort ?? ""}`; }

  // The reasoning levels of the session's model, as its listing gives them; none when it lists none.
  private effortOption(s: Json): Json | undefined {
    const efforts: string[] = this.models?.find((m) => m.id === s.model)?.efforts ?? [];
    if (!efforts.length) return undefined;
    const now: string = s.settings?.effort ?? "";
    const known = !now || efforts.includes(now);
    return {
      id: "effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: now || "default",
      options: [
        { value: "default", name: "Default", description: "The model's own level" },
        ...efforts.map((e) => ({ value: e, name: e })),
        ...(known ? [] : [{ value: now, name: `${now} (not available)`, description: "The model does not list this level now. Pick a listed one to go on." }]),
      ],
    };
  }

  private async sessionSetup(s: Json, mode: string, fresh = false) {
    const models = await this.modelOptions(fresh);
    this.offered.set(s.id, AcpBridge.offer(s));
    // The session's model is its current value also when no provider lists it
    // now (a key removed, a model retired): it is shown as what it is, an option
    // of its own that says so, and stays until the owner picks a listed one.
    const listed = models.some((g) => g.options.some((o: Json) => o.value === s.model));
    if (!listed && s.model) models.unshift({ group: "unavailable", name: "Not available", options: [{ value: s.model, name: `${s.model} (not available)`, description: "No provider lists this model now. Pick a listed model to go on." }] });
    return {
      modes: { currentModeId: mode, availableModes: MODES },
      configOptions: [
        { id: "mode", name: "Permissions", category: "mode", type: "select", currentValue: mode, options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
        { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: models },
        ...(this.effortOption(s) ? [this.effortOption(s)] : []),
      ],
    };
  }

  private async dispatch(method: string, p: Json): Promise<Json> {
    // A child session is watched, not driven: the editor may cancel its work and nothing else.
    const child = typeof p?.sessionId === "string" ? this.children.get(p.sessionId) : undefined;
    if (child && method !== "session/cancel") throw Object.assign(new Error(`${p.sessionId} is a child session (an agent of ${child.parent}): ${method} is not permitted for it`), { code: -32602 });
    switch (method) {
      case "initialize":
        this.caps = p.clientCapabilities ?? {};
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            // Streamable HTTP servers are taken; the older SSE transport is not spoken.
            mcpCapabilities: { http: true, sse: false },
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          agentInfo: { name: "keel", title: "Keel", version: "0.1.0" },
          authMethods: [],
        };
      case "authenticate":
        return {};
      case "session/new": {
        const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
        const { session } = await this.daemon.send("POST", "/api/sessions", { workspace: cwd });
        await this.ensureFrames();
        await this.hold(session.id, 0);
        const perm = await this.daemon.get(`/api/sessions/${session.id}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
        const setup = await this.sessionSetup(session, perm.perm?.mode ?? "ask", true);
        await this.mcpServers(session.id, p.mcpServers, true);
        setTimeout(() => void this.commands(session.id), 0); // after the answer
        return { sessionId: session.id, ...setup };
      }
      case "session/load": {
        const r = await this.daemon.get(`/api/sessions/${p.sessionId}`).catch(() => null);
        if (!r?.session) throw Object.assign(new Error(`no session ${p.sessionId}`), { code: -32002 });
        await this.ensureFrames();
        // What the session does after the history read waits until the history is replayed
        // (a running session's events and its streaming reply would go first otherwise).
        const id = String(p.sessionId);
        const first = !this.loading.has(id);
        if (first) this.loading.set(id, []);
        try {
          await this.hold(id, lastSeq(r));
          const perm = await this.daemon.get(`/api/sessions/${id}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
          const setup = await this.sessionSetup(r.session, perm.perm?.mode ?? "ask", true);
          await this.mcpServers(id, p.mcpServers);
          this.replay(id, lineage(r.events ?? [], r.session.head ?? null), !!r.running);
          setTimeout(() => { void this.commands(id); void this.announceTree(id); }, 0); // after the answer
          return setup;
        } finally {
          if (first) {
            const held = this.loading.get(id) ?? [];
            this.loading.delete(id);
            for (const f of held) this.onFrame(f);
          }
        }
      }
      case "session/resume": {
        // As load, without the history replay.
        const r = await this.daemon.get(`/api/sessions/${p.sessionId}`).catch(() => null);
        if (!r?.session) throw Object.assign(new Error(`no session ${p.sessionId}`), { code: -32002 });
        await this.ensureFrames();
        await this.hold(p.sessionId, lastSeq(r));
        for (const e of r.events ?? []) this.noteSpawns(e);
        const perm = await this.daemon.get(`/api/sessions/${p.sessionId}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
        await this.mcpServers(p.sessionId, p.mcpServers);
        setTimeout(() => { void this.commands(p.sessionId); void this.announceTree(p.sessionId); }, 0); // after the answer
        return this.sessionSetup(r.session, perm.perm?.mode ?? "ask", true);
      }
      case "session/close": {
        // Ends this editor's hold on the session: a running turn is stopped; the session stays in Keel.
        // Its agents go on: the session and its agents are the workbench's too, and close only ends what
        // this editor sees of them (the spec asks a close to stop a parent's children; Keel does not here).
        const id = String(p.sessionId);
        if (this.live.has(id)) await this.stop(id).catch(() => {});
        await this.mcpServers(id, []);
        this.unhold(id);
        return {};
      }
      case "session/list": {
        // Pages of LIST_PAGE; the cursor is the next row's offset in the list it
        // was given for (its cwd filter, by a hash), opaque to the editor. Under
        // another filter the offset would point into another list: refused.
        const filter = Bun.hash(p.cwd ? String(p.cwd) : "").toString(36);
        let from = 0;
        if (p.cursor != null) {
          const m = /^o(\d+)\.([0-9a-z]+)$/.exec(Buffer.from(String(p.cursor), "base64url").toString());
          if (!m) throw Object.assign(new Error("invalid cursor"), { code: -32602 });
          if (m[2] !== filter) throw Object.assign(new Error("invalid cursor: it was given for a list with another cwd"), { code: -32602 });
          from = Number(m[1]);
        }
        const { sessions } = await this.daemon.get("/api/sessions?agents=all");
        // (A client that takes child sessions learns of them from their parents, not from the list.)
        const rows = (sessions as Json[]).filter((s) => (!p.cwd || s.workspace === p.cwd) && !(this.subagents && s.parent_id));
        const page = rows.slice(from, from + LIST_PAGE);
        const more = from + LIST_PAGE < rows.length;
        return {
          sessions: page.map((s) => ({ sessionId: s.id, cwd: s.workspace, title: s.title || undefined, updatedAt: new Date(s.updated).toISOString() })),
          ...(more ? { nextCursor: Buffer.from(`o${from + LIST_PAGE}.${filter}`).toString("base64url") } : {}),
        };
      }
      case "session/prompt": {
        const id = String(p.sessionId);
        const { text, images } = await promptOf(p.prompt, this.daemon.upload?.bind(this.daemon));
        if (!text.trim() && !images.length) throw Object.assign(new Error("the prompt is empty"), { code: -32602 });
        await this.ensureFrames();
        await this.hold(id);
        // Each call is its own entry: a second prompt while the first runs joins
        // the running turn or waits behind it, as the daemon decides, and neither
        // call takes the other's answer.
        const live = this.live.get(id) ?? this.live.set(id, { prompts: [], delivered: new Map(), ends: [], seq: -1 }).get(id)!;
        let mine!: Prompt;
        const done = new Promise<Json>((resolve, reject) => live.prompts.push((mine = { resolve, reject, after: null, cancelled: false, settled: false })));
        // An advertised command (/server:prompt args) runs as the workbench runs it.
        const cmd = /^\/([\w.-]+):(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
        const known = cmd && this.commandsOf.get(id)?.has(`${cmd[1]}:${cmd[2]}`);
        try {
          const sent = known
            ? await this.daemon.send("POST", `/api/sessions/${id}/mcp-prompt`, { server: cmd![1], prompt: cmd![2], args: cmd![3] ?? "" })
            : await this.daemon.send("POST", `/api/sessions/${id}/messages`, { text, images });
          this.place(id, mine, sent);
        } catch (e) {
          // Not sent: this call fails, and the session's other prompts go on.
          if (this.take(id, mine)) throw e;
        }
        return await done;
      }
      case "session/cancel": {
        // A child's: its agent is stopped, as the owner's Stop on its card stops it (its own agents
        // with it). It shows as idle and cancelled once it has stopped. One that offers no cancel is left alone.
        if (child) {
          if (isLive(child.agent)) await this.daemon.send("POST", `/api/sessions/${child.parent}/agents/${child.agent.id}/stop`, {}).catch((e) => this.log(`stop of agent ${child.agent.id}: ${(e as Error).message}`));
          return undefined;
        }
        await this.stop(String(p.sessionId));
        return undefined; // a notification
      }
      case "session/set_mode":
        await this.setMode(p.sessionId, p.modeId);
        return {};
      case "session/set_config_option": {
        if (p.configId === "mode") await this.setMode(p.sessionId, p.value);
        else if (p.configId === "model") await this.daemon.send("PATCH", `/api/sessions/${p.sessionId}`, { model: p.value });
        else if (p.configId === "effort") await this.setEffort(p.sessionId, p.value);
        else throw Object.assign(new Error(`no option ${p.configId}`), { code: -32602 });
        const r = await this.daemon.get(`/api/sessions/${p.sessionId}`);
        const perm = await this.daemon.get(`/api/sessions/${p.sessionId}/permissions`);
        return { configOptions: (await this.sessionSetup(r.session, perm.perm.mode)).configOptions };
      }
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
  }

  private async setEffort(sessionId: string, value: unknown) {
    const r = await this.daemon.get(`/api/sessions/${sessionId}`);
    if (!this.models) await this.modelOptions();
    const offer = this.effortOption(r.session);
    if (!offer) throw Object.assign(new Error("the session's model lists no reasoning effort"), { code: -32602 });
    if (typeof value !== "string" || !offer.options.some((o: Json) => o.value === value)) throw Object.assign(new Error(`unknown reasoning effort ${String(value)}`), { code: -32602 });
    await this.daemon.send("PATCH", `/api/sessions/${sessionId}`, { settings: { effort: value === "default" ? null : value } });
  }

  // The session's model or effort changed where the editor did not ask for it: the options are sent again.
  private async optionsChanged(s: Json) {
    const perm = await this.daemon.get(`/api/sessions/${s.id}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
    if (!this.holds.has(s.id) || this.offered.get(s.id) === AcpBridge.offer(s)) return;
    const setup = await this.sessionSetup(s, perm.perm?.mode ?? "ask");
    this.notify(s.id, { sessionUpdate: "config_option_update", configOptions: setup.configOptions });
  }

  private async setMode(sessionId: string, mode: string) {
    if (!MODES.some((m) => m.id === mode)) throw Object.assign(new Error(`unknown mode ${mode}`), { code: -32602 });
    await this.daemon.send("PUT", `/api/sessions/${sessionId}/permissions`, { mode });
    this.notify(sessionId, { sessionUpdate: "current_mode_update", currentModeId: mode });
  }

  // A loaded session's history: the branch shown (its head's lineage), as the
  // editor shows it live. A call's status is its stored result's; a call with
  // none is still running, or (the turn over) was never finished.
  private replay(sessionId: string, events: StoredEvent[], running: boolean) {
    const results = new Map<string, Json>();
    for (const e of events) if (e.kind === "tool_result") for (const r of e.data.results ?? []) results.set(r.tool_use_id, r);
    for (const e of events) this.event(sessionId, e, { results, running });
  }

  private compaction(sessionId: string, e: StoredEvent) {
    const summary = typeof e.data.summary === "string" && e.data.summary ? e.data.summary : "";
    if (this.caps?.session?.compaction) {
      // One completed entity per checkpoint, its summary as a replacement (a second load never appends).
      this.notify(sessionId, { sessionUpdate: "compaction_update", compactionId: e.id, status: "completed", summary: summary ? [{ type: "text", text: summary }] : null });
    } else {
      const text = summary ? `[Context compacted here. The model continues from this summary:]\n\n${summary}` : "[Context cleared here: the model starts again from the next message.]";
      this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    }
  }

  private event(sessionId: string, e: StoredEvent, replay?: { results: Map<string, Json>; running: boolean }) {
    if (e.kind === "user") {
      const child = replay ? undefined : this.children.get(sessionId);
      if (child) {
        // Its task names it, when its parent's call did not.
        if (!child.description && e.data?.kind === "task") {
          child.description = taskLine(e.data.text);
          this.announce(child);
        }
        for (const u of childInput(e, sessionId, child.parent, (agent) => this.agentSessions.get(agent))) this.notify(sessionId, u);
        return;
      }
      if (!replay) {
        // The editor sent it. A queued prompt is now stored: the turn end after it is its end.
        const l = this.live.get(sessionId);
        const qid = typeof e.data?.queue_id === "string" ? e.data.queue_id : "";
        if (l && qid) {
          l.delivered.set(qid, e.seq);
          for (const p of l.prompts) if (p.queueId === qid && p.after === null) p.after = e.seq;
        }
        return;
      }
      const input = inputKind(e.data);
      if (input) {
        this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[${INPUT_LABEL[input]}]\n\n${e.data.text ?? ""}` }, _meta: { keel: { input } } });
      } else for (const content of userContent(e.data)) this.notify(sessionId, { sessionUpdate: "user_message_chunk", content });
    } else if (e.kind === "assistant") {
      const texts = (e.data.blocks ?? []).filter((b: Json) => b.type === "text" && b.text).map((b: Json) => b.text as string);
      this.noteSpawns(e);
      if (replay) for (const text of texts) this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      else {
        // The streamed deltas carried part (or all) of this reply: send what the editor does not show yet.
        const committed = texts.join("");
        const shown = this.texts.get(sessionId)?.shown ?? "";
        const missing = committed.startsWith(shown) ? committed.slice(shown.length) : `\n\n[Keel: the streamed text differs from the stored reply, which is:]\n\n${committed}`;
        if (missing) this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: missing } });
        this.texts.delete(sessionId);
        this.retried.delete(sessionId);
      }
      for (const b of e.data.blocks ?? []) {
        if (b.type !== "tool_use") continue;
        this.tools.set(b.id, b.name);
        if (!replay && ASK_TOOLS.has(b.name)) {
          // A child's question waits on the owner: it needs action until the call has its result.
          const c = this.children.get(sessionId);
          if (c && !c.asks.has(`q:${b.id}`)) { c.asks.add(`q:${b.id}`); this.announce(c); }
          if (this.caps?.elicitation?.form) void this.elicit(sessionId, b);
        }
        const plan = planOf(b.name, b.input);
        if (plan) this.plan(sessionId, plan);
        const r = replay?.results.get(b.id);
        const status = !replay ? "pending" : r ? (r.is_error ? "failed" : "completed") : replay.running ? "in_progress" : "failed";
        this.notify(sessionId, { sessionUpdate: "tool_call", toolCallId: b.id, title: toolTitle(b.name, b.input), kind: toolKind(b.name), status, rawInput: b.input, ...toolDetail(b.name, b.input) });
        if (replay && !r && !replay.running) this.notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: b.id, status, content: [{ type: "content", content: { type: "text", text: "No result was stored for this call: its turn ended first." } }] });
      }
    } else if (e.kind === "tool_result") {
      const c = replay ? undefined : this.children.get(sessionId);
      if (c && (e.data.results ?? []).some((r: Json) => c.asks.delete(`q:${r.tool_use_id}`))) this.announce(c);
      for (const r of e.data.results ?? []) {
        const detail = toolDetail(this.tools.get(r.tool_use_id) ?? "", {});
        this.notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: r.tool_use_id, status: r.is_error ? "failed" : "completed", content: [...(detail.content ?? []), ...resultContent(r.content)] });
      }
    } else if (e.kind === "compaction") {
      this.compaction(sessionId, e);
    } else if (e.kind === "turn_end" && !replay) {
      this.texts.delete(sessionId);
      this.retried.delete(sessionId);
      const l = this.live.get(sessionId);
      if (!l) return;
      const reason = String(e.data.reason ?? "end_turn");
      const error = l.error;
      l.error = undefined;
      // A prompt still on its way to the daemon may turn out to be this turn's: its end is kept for it.
      if (l.prompts.some((p) => p.after === null && !p.queueId)) l.ends.push({ seq: e.seq, reason, error });
      // The end of a turn that ran before a prompt was stored is not that prompt's.
      this.settle(sessionId, l.prompts.filter((p) => p.after !== null && e.seq > p.after), reason, error);
    } else if (e.kind === "error" && !replay) {
      const t = this.live.get(sessionId);
      if (t) t.error = String(e.data.message ?? "the turn failed");
      this.say(sessionId, "error", "The turn failed", String(e.data.message ?? ""), `\n\nKeel: ${e.data.message}`);
    }
  }

  // The session a frame is about (an agent's record: the session that started it).
  private static about(f: Json): string | undefined {
    if (f.t === "event") return f.event?.session_id;
    if (f.t === "session") return f.session?.id;
    if (f.t === "feature" && f.name === "automation" && f.data?.kind === "agent") return f.data.data?.parent_id;
    return f.session_id ?? f.data?.session_id;
  }

  private onFrame(f: Json) {
    const about = this.loading.size ? AcpBridge.about(f) : undefined;
    if (about && this.loading.has(about)) return void this.loading.get(about)!.push(f);
    if (f.t === "session" && this.offered.has(f.session?.id) && this.holds.has(f.session.id) && this.offered.get(f.session.id) !== AcpBridge.offer(f.session)) void this.optionsChanged(f.session).catch((e) => this.log(`config options of ${f.session.id}: ${(e as Error).message}`));
    if (f.t === "delta" && this.streams(f.session_id)) {
      this.delta(f.session_id, f.kind, String(f.text ?? ""));
    } else if (f.t === "status" && f.status?.kind === "retry" && this.streams(f.session_id)) {
      this.retry(f.session_id, f.status);
    } else if (f.t === "event" && this.streams(f.event.session_id)) {
      const l = this.live.get(f.event.session_id);
      if (l && typeof f.event.seq === "number" && f.event.seq > l.seq) l.seq = f.event.seq;
      this.event(f.event.session_id, f.event);
    } else if (f.t === "feature" && f.name === "automation" && f.data?.kind === "agent") {
      this.onAgent(f.data.data);
    } else if (f.t === "queue" && this.live.has(f.session_id)) {
      void this.queueChanged(f.session_id, f.queue ?? []);
    } else if (f.t === "feature" && f.name === "mcp-session" && f.data?.what === "failed" && this.served.has(f.session_id)) {
      // A server the editor passed that did not connect, or went away later: said by name, as a refusal is.
      this.say(f.session_id, "warning", `Keel could not connect the MCP server ${f.data.name} the editor passed`, String(f.data.error ?? "it failed"), `Keel could not connect the MCP server ${f.data.name} the editor passed: ${f.data.error ?? "it failed"}.\n\n`);
    } else if (f.t === "session" && this.live.has(f.session.id) && f.session.title && this.titles.get(f.session.id) !== f.session.title) {
      // (A row can come twice: by the session's own topic and by the list's.)
      this.titles.set(f.session.id, f.session.title);
      this.notify(f.session.id, { sessionUpdate: "session_info_update", title: f.session.title });
    } else if (f.t === "feature" && f.name === "approval" && f.data?.state === "pending" && this.streams(f.data.session_id) && !this.asked.has(f.data.id)) {
      this.asked.add(f.data.id);
      // A child's call waits on the owner: it shows as needing action until the card is answered.
      const c = this.children.get(f.data.session_id);
      if (c) { c.asks.add(f.data.id); this.announce(c); }
      void this.ask(f.data);
    } else if (f.t === "feature" && f.name === "approval" && f.data?.state !== "pending" && f.data?.id) {
      // A child's card answered (here, in the workbench, or settled): it works again, or has stopped.
      const c = this.children.get(f.data.session_id);
      if (c?.asks.delete(f.data.id)) this.announce(c);
      if (!this.asking.has(f.data.id)) return;
      // Answered in the workbench: the editor's request is withdrawn.
      const requestId = this.asking.get(f.data.id)!;
      this.asking.delete(f.data.id);
      this.out({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId } });
      this.pending.get(requestId)?.({ result: { outcome: { outcome: "cancelled" } }, answered: true });
      this.pending.delete(requestId);
      this.notify(f.data.session_id, { sessionUpdate: "tool_call_update", toolCallId: f.data.call_id, status: f.data.state === "allowed" ? "in_progress" : "failed" });
    }
  }

  // MCP prompts of the daemon's servers, as the editor's slash commands.
  private commandsOf = new Map<string, Set<string>>();
  private async commands(sessionId: string) {
    const r = await this.daemon.get("/api/mcp/prompts").catch(() => ({ prompts: [] }));
    const list: Json[] = r.prompts ?? [];
    this.commandsOf.set(sessionId, new Set(list.map((p) => `${p.server}:${p.name}`)));
    this.notify(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: list.map((p) => ({
        name: `${p.server}:${p.name}`,
        description: p.description || `The ${p.name} prompt of ${p.server}`,
        ...(p.arguments?.length ? { input: { hint: p.arguments.map((a: Json) => `<${a.name}>`).join(" ") } } : {}),
      })),
    });
  }

  private async usage(sessionId: string) {
    try {
      const r = await this.daemon.get(`/api/sessions/${sessionId}`);
      if (!this.models) await this.modelOptions();
      const m = this.models!.find((x) => x.id === r.session.model);
      const u = usageOf(lineage(r.events ?? [], r.session.head ?? null), m?.context, r.session.usage?.cost, r.session.model);
      if (u) this.notify(sessionId, u);
    } catch (e) {
      this.log(`usage of ${sessionId}: ${(e as Error).message}`);
    }
  }

  // A question card as an elicitation form; accepted answers go to the card,
  // a declined or cancelled form leaves the card for the workbench.
  private async elicit(sessionId: string, b: Json) {
    const form = questionForm(b.name, b.input);
    if (!form || this.elicited.has(`${sessionId} ${b.id}`)) return;
    this.elicited.add(`${sessionId} ${b.id}`);
    const msg = await this.request("elicitation/create", { sessionId, toolCallId: b.id, mode: "form", message: form.message, requestedSchema: form.requestedSchema });
    const r = msg.result;
    if (r?.action !== "accept" || !r.content) return;
    const answers: Json = {};
    for (const id of form.ids) {
      const v = r.content[id];
      answers[id] = { picked: Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)] };
    }
    await this.daemon.send("POST", `/api/sessions/${sessionId}/questions/${b.id}`, { answers }).catch((e) => this.log(`answers of ${b.id}: ${(e as Error).message}`));
  }

  // An approval card of the gate as the editor's permission request. The card
  // stays answerable in the workbench too; whichever answers first wins.
  private async ask(a: Json) {
    const name = this.tools.get(a.call_id) ?? a.tool;
    // The card as the daemon gives it to every client. When that read fails
    // (the daemon is busy, or is one from before the form), the form is made
    // here from the card the stream carried: the same function, without the
    // machine's name. The request then still carries the whole text.
    const form: CardForm = await this.daemon.get(`/api/sessions/${a.session_id}/approvals/${a.id}`).then((r) => r?.card as CardForm | undefined, () => undefined) ?? cardForm(a as Approval);
    const msg = await this.request("session/request_permission", permissionRequest(a, name, form), a.id);
    if (msg.answered) return; // the workbench answered first
    this.asking.delete(a.id);
    const outcome = msg.result?.outcome;
    const picked = outcome?.outcome === "selected" ? outcome.optionId : "deny";
    const choice = ["once", "always", "deny"].includes(picked) ? picked : "deny";
    if (choice !== "deny") this.notify(a.session_id, { sessionUpdate: "tool_call_update", toolCallId: a.call_id, status: "in_progress" });
    // (`seen`: the request carried the whole text. What the editor drew of it is not known here.)
    await this.daemon
      .send("POST", `/api/sessions/${a.session_id}/approvals/${a.id}`, { choice, reason: outcome?.outcome === "cancelled" ? "the editor cancelled the request" : undefined, via: "acp", ...(choice !== "deny" ? { seen: "whole" } : {}) })
      .catch((e) => {
        this.log(`approval ${a.id}: ${(e as Error).message}`);
        // Held: the answer was not taken and the card still waits. The editor is told, and where to answer it.
        if ((e as { held?: boolean }).held) {
          this.notify(a.session_id, { sessionUpdate: "tool_call_update", toolCallId: a.call_id, status: "pending" });
          this.say(a.session_id, "warning", "Keel did not take that answer", `${(e as Error).message} The request still waits: answer it in the workbench.`, `Keel did not take that answer: ${(e as Error).message} The request still waits: answer it in the workbench.\n\n`);
        }
        // Any other refusal: it was answered in the workbench first (or before the editor
        // held the session, and the card was read as open): a child does not wait on it.
        else {
          const c = this.children.get(a.session_id);
          if (c?.asks.delete(a.id)) this.announce(c);
        }
      });
  }
}
