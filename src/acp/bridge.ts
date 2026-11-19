// `keel acp`: an editor (Zed, or any Agent Client Protocol client) drives
// keel-bun over ACP v1 on stdio. The bridge is a client of the running daemon:
// sessions it makes are the workbench's sessions (both show the same turns),
// the daemon runs the tools in its own permission gate, and an approval card
// becomes the editor's permission request (answered in either place).
//
// Spec: agentclientprotocol.com/protocol/v1 (initialize, session/new, load,
// list, prompt, cancel, set_mode, set_config_option; session/update and
// session/request_permission toward the client).
import { INPUT_LABEL, inputKind } from "../core/inputs.ts";
import { lineage } from "../core/tree.ts";
import type { StoredEvent } from "../core/types.ts";

export const PROTOCOL_VERSION = 1;

type Json = any;
type Send = (msg: Json) => void;

const MODES = [
  { id: "ask", name: "Ask", description: "Reads run; edits, commands and other tools ask first." },
  { id: "auto-edits", name: "Auto edits", description: "Edits in the folder run; commands ask." },
  { id: "full-auto", name: "Full auto", description: "Everything runs; only high-risk commands ask." },
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
export function permissionRequest(a: Json, name: string): Json {
  const options = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    ...(a.risk !== "high" && a.suggest?.length ? [{ optionId: "always", name: `Always allow ${a.suggest.map((s: Json) => s.pattern).join(", ")}`, kind: "allow_always" }] : []),
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
  const why = [a.risk === "high" ? `High risk${a.why ? `: ${a.why}` : ""}.` : a.why ? `${a.why}.` : "", a.notice ?? ""].filter(Boolean).join(" ");
  return {
    sessionId: a.session_id,
    toolCall: {
      toolCallId: a.call_id, title: a.summary || toolTitle(name, a.input), kind: toolKind(name), status: "pending", rawInput: a.input,
      ...(why ? { content: [{ type: "content", content: { type: "text", text: why } }] } : {}),
    },
    options,
  };
}

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

export type DaemonApi = {
  get(path: string): Promise<Json>;
  send(method: string, path: string, body?: Json): Promise<Json>;
  upload?(name: string, type: string, bytes: Uint8Array): Promise<Json>;
  frames(on: (f: Json) => void): Promise<() => void>;
};

type Waiting = { resolve: (v: Json) => void };

const LIST_PAGE = 200;

// One editor connection.
export class AcpBridge {
  private nextId = 1;
  private pending = new Map<number, (msg: Json) => void>();
  private turns = new Map<string, { resolve: (r: Json) => void; reject: (e: Error) => void; streamed: string; cancelled: boolean; error?: string }>();
  private caps: Json = {};
  private tools = new Map<string, string>(); // tool_use id -> tool name
  private asked = new Set<string>();         // approvals sent to the editor
  private stopFrames?: () => void;
  private models: Json[] | null = null;
  private defaultModel = "";

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

  close() {
    this.stopFrames?.();
    for (const t of this.turns.values()) t.resolve({ stopReason: "cancelled" });
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

  private async sessionSetup(s: Json, mode: string, fresh = false) {
    return {
      modes: { currentModeId: mode, availableModes: MODES },
      configOptions: [
        { id: "mode", name: "Permissions", category: "mode", type: "select", currentValue: mode, options: MODES.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
        { id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: await this.modelOptions(fresh) },
      ],
    };
  }

  private async dispatch(method: string, p: Json): Promise<Json> {
    switch (method) {
      case "initialize":
        this.caps = p.clientCapabilities ?? {};
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { list: {} },
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
        const perm = await this.daemon.get(`/api/sessions/${session.id}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
        const setup = await this.sessionSetup(session, perm.perm?.mode ?? "ask", true);
        if (Array.isArray(p.mcpServers) && p.mcpServers.length) {
          const names = p.mcpServers.map((m: Json) => m.name).join(", ");
          // After the answer, so the editor knows the session first.
          queueMicrotask(() => this.notify(session.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Keel did not connect the editor's MCP servers (${names}): it uses the servers set up in its own MCP panel.\n\n` } }));
        }
        return { sessionId: session.id, ...setup };
      }
      case "session/load": {
        const r = await this.daemon.get(`/api/sessions/${p.sessionId}`).catch(() => null);
        if (!r?.session) throw Object.assign(new Error(`no session ${p.sessionId}`), { code: -32002 });
        await this.ensureFrames();
        const perm = await this.daemon.get(`/api/sessions/${p.sessionId}/permissions`).catch(() => ({ perm: { mode: "ask" } }));
        const setup = await this.sessionSetup(r.session, perm.perm?.mode ?? "ask", true);
        this.replay(p.sessionId, lineage(r.events ?? [], r.session.head ?? null), !!r.running);
        return setup;
      }
      case "session/list": {
        // Pages of LIST_PAGE; the cursor is the next row's offset, opaque to the editor.
        let from = 0;
        if (p.cursor != null) {
          const m = /^o(\d+)$/.exec(Buffer.from(String(p.cursor), "base64url").toString());
          if (!m) throw Object.assign(new Error("invalid cursor"), { code: -32602 });
          from = Number(m[1]);
        }
        const { sessions } = await this.daemon.get("/api/sessions");
        const rows = (sessions as Json[]).filter((s) => !p.cwd || s.workspace === p.cwd);
        const page = rows.slice(from, from + LIST_PAGE);
        const more = from + LIST_PAGE < rows.length;
        return {
          sessions: page.map((s) => ({ sessionId: s.id, cwd: s.workspace, title: s.title || undefined, updatedAt: new Date(s.updated).toISOString() })),
          ...(more ? { nextCursor: Buffer.from(`o${from + LIST_PAGE}`).toString("base64url") } : {}),
        };
      }
      case "session/prompt": {
        const id = String(p.sessionId);
        const { text, images } = await promptOf(p.prompt, this.daemon.upload?.bind(this.daemon));
        if (!text.trim() && !images.length) throw Object.assign(new Error("the prompt is empty"), { code: -32602 });
        await this.ensureFrames();
        const done = new Promise<Json>((resolve, reject) => this.turns.set(id, { resolve, reject, streamed: "", cancelled: false }));
        try {
          await this.daemon.send("POST", `/api/sessions/${id}/messages`, { text: text || "(image)", images });
        } catch (e) {
          this.turns.delete(id);
          throw e;
        }
        return await done;
      }
      case "session/cancel": {
        const t = this.turns.get(String(p.sessionId));
        if (t) t.cancelled = true;
        await this.daemon.send("POST", `/api/sessions/${p.sessionId}/interrupt`, {});
        return undefined; // a notification
      }
      case "session/set_mode":
        await this.setMode(p.sessionId, p.modeId);
        return {};
      case "session/set_config_option": {
        if (p.configId === "mode") await this.setMode(p.sessionId, p.value);
        else if (p.configId === "model") await this.daemon.send("PATCH", `/api/sessions/${p.sessionId}`, { model: p.value });
        else throw Object.assign(new Error(`no option ${p.configId}`), { code: -32602 });
        const r = await this.daemon.get(`/api/sessions/${p.sessionId}`);
        const perm = await this.daemon.get(`/api/sessions/${p.sessionId}/permissions`);
        return { configOptions: (await this.sessionSetup(r.session, perm.perm.mode)).configOptions };
      }
      default:
        throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
    }
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
      if (!replay) return; // the editor sent it
      const input = inputKind(e.data);
      if (input) {
        this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[${INPUT_LABEL[input]}]\n\n${e.data.text ?? ""}` }, _meta: { keel: { input } } });
      } else for (const content of userContent(e.data)) this.notify(sessionId, { sessionUpdate: "user_message_chunk", content });
    } else if (e.kind === "assistant") {
      const t = replay ? undefined : this.turns.get(sessionId);
      const texts = (e.data.blocks ?? []).filter((b: Json) => b.type === "text" && b.text).map((b: Json) => b.text as string);
      if (replay) for (const text of texts) this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      else {
        // The streamed deltas carried part (or all) of this reply: send what they missed.
        const committed = texts.join("");
        const streamed = t?.streamed ?? "";
        const missing = committed.startsWith(streamed) ? committed.slice(streamed.length) : `\n\n[Keel: the streamed text differs from the stored reply, which is:]\n\n${committed}`;
        if (missing) this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: missing } });
        if (t) t.streamed = "";
      }
      for (const b of e.data.blocks ?? []) {
        if (b.type !== "tool_use") continue;
        this.tools.set(b.id, b.name);
        const plan = planOf(b.name, b.input);
        if (plan) this.notify(sessionId, { sessionUpdate: "plan", entries: plan });
        const r = replay?.results.get(b.id);
        const status = !replay ? "pending" : r ? (r.is_error ? "failed" : "completed") : replay.running ? "in_progress" : "failed";
        this.notify(sessionId, { sessionUpdate: "tool_call", toolCallId: b.id, title: toolTitle(b.name, b.input), kind: toolKind(b.name), status, rawInput: b.input, ...toolDetail(b.name, b.input) });
        if (replay && !r && !replay.running) this.notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: b.id, status, content: [{ type: "content", content: { type: "text", text: "No result was stored for this call: its turn ended first." } }] });
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        const detail = toolDetail(this.tools.get(r.tool_use_id) ?? "", {});
        this.notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: r.tool_use_id, status: r.is_error ? "failed" : "completed", content: [...(detail.content ?? []), ...resultContent(r.content)] });
      }
    } else if (e.kind === "compaction") {
      this.compaction(sessionId, e);
    } else if (e.kind === "turn_end" && !replay) {
      const t = this.turns.get(sessionId);
      if (!t) return;
      this.turns.delete(sessionId);
      const reason = String(e.data.reason ?? "end_turn");
      if (reason === "error" && !t.cancelled) return t.reject(Object.assign(new Error(t.error ?? "the turn failed"), { code: -32603 }));
      const stopReason = t.cancelled || reason === "interrupted" || reason === "restart" ? "cancelled"
        : reason === "max_tokens" ? "max_tokens" : reason === "refusal" ? "refusal" : reason === "max_steps" ? "max_turn_requests" : "end_turn";
      t.resolve({ stopReason });
    } else if (e.kind === "error" && !replay) {
      const t = this.turns.get(sessionId);
      if (t) t.error = String(e.data.message ?? "the turn failed");
      this.notify(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\nKeel: ${e.data.message}` } });
    }
  }

  private onFrame(f: Json) {
    if (f.t === "delta" && this.turns.has(f.session_id)) {
      const t = this.turns.get(f.session_id)!;
      if (f.kind === "text") {
        t.streamed += f.text;
        this.notify(f.session_id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: f.text } });
      } else if (f.kind === "thinking") this.notify(f.session_id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: f.text } });
    } else if (f.t === "event" && this.turns.has(f.event.session_id)) {
      this.event(f.event.session_id, f.event);
    } else if (f.t === "session" && this.turns.has(f.session.id) && f.session.title) {
      this.notify(f.session.id, { sessionUpdate: "session_info_update", title: f.session.title });
    } else if (f.t === "feature" && f.name === "approval" && f.data?.state === "pending" && this.turns.has(f.data.session_id) && !this.asked.has(f.data.id)) {
      this.asked.add(f.data.id);
      void this.ask(f.data);
    } else if (f.t === "feature" && f.name === "approval" && f.data?.state !== "pending" && this.asking.has(f.data?.id)) {
      // Answered in the workbench: the editor's request is withdrawn.
      const requestId = this.asking.get(f.data.id)!;
      this.asking.delete(f.data.id);
      this.out({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId } });
      this.pending.get(requestId)?.({ result: { outcome: { outcome: "cancelled" } }, answered: true });
      this.pending.delete(requestId);
      this.notify(f.data.session_id, { sessionUpdate: "tool_call_update", toolCallId: f.data.call_id, status: f.data.state === "allowed" ? "in_progress" : "failed" });
    }
  }

  // An approval card of the gate as the editor's permission request. The card
  // stays answerable in the workbench too; whichever answers first wins.
  private async ask(a: Json) {
    const name = this.tools.get(a.call_id) ?? a.tool;
    const msg = await this.request("session/request_permission", permissionRequest(a, name), a.id);
    if (msg.answered) return; // the workbench answered first
    this.asking.delete(a.id);
    const outcome = msg.result?.outcome;
    const choice = outcome?.outcome === "selected" ? outcome.optionId : "deny";
    if (choice !== "deny") this.notify(a.session_id, { sessionUpdate: "tool_call_update", toolCallId: a.call_id, status: "in_progress" });
    await this.daemon
      .send("POST", `/api/sessions/${a.session_id}/approvals/${a.id}`, { choice: ["once", "always", "deny"].includes(choice) ? choice : "deny", reason: outcome?.outcome === "cancelled" ? "the editor cancelled the request" : undefined })
      .catch((e) => this.log(`approval ${a.id}: ${(e as Error).message}`)); // answered in the workbench first
  }
}
