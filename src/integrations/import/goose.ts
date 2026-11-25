// Goose (Block's goose agent): one SQLite database, <data folder>/sessions/sessions.db (the data
// folder is $GOOSE_PATH_ROOT/data, else $XDG_DATA_HOME/goose, ~/.local/share/goose). `sessions` holds
// a row per session (id, name with user_set_name, description as the older name, session_type user,
// scheduled, sub_agent, hidden, terminal, gateway or acp, working_dir, created_at and updated_at as
// UTC `YYYY-MM-DD HH:MM:SS`, provider_name, model_config_json { model_name }, parent_session_id for a
// subagent's, archived_at); `messages` a row per message in conversation order (message_id, role user
// or assistant, content_json a list of content blocks, created_timestamp in seconds, metadata_json).
// A block is { type } text, image { data, mimeType }, document, toolRequest { id, toolCall { status
// success, value { name, arguments } | status error, error } }, toolResponse { id, toolResult { status,
// value { content: [text, image, resource blocks], isError } | error } } (a tool response is a user
// message), thinking, redactedThinking, systemNotification, error { kind, message } and the
// confirmation blocks. Metadata says what each message is for: userVisible, agentVisible, turnContext,
// compactionSummary and inference { requestedModel, resolvedModel }. When Goose compacts, every earlier
// message becomes agentVisible false (it stays on the owner's screen), and a summary message, a
// continuation message and the latest prompt again are added for the agent alone.
//
// Source: github.com/block/goose (v1.60.2, main 2026-11-25), crates/goose/src/session/session_manager.rs,
// crates/oi-kit-provider-types/src/conversation/message.rs and tool_result_serde.rs,
// crates/oi-kit-agent/src/compaction/layout.rs and crates/goose/src/config/paths.rs. Opened read-only;
// nothing here writes.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SideStore } from "./more.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const gooseHome = () => {
  if (process.env.KEEL_IMPORT_GOOSE_DIR) return process.env.KEEL_IMPORT_GOOSE_DIR;
  const root = ownerEnv("GOOSE_PATH_ROOT");
  if (root && isAbsolute(root)) return join(root, "data");
  const xdg = ownerEnv("XDG_DATA_HOME");
  return join(xdg?.startsWith("/") ? xdg : join(ownerHome(), ".local", "share"), "goose");
};
export const gooseDb = () => join(gooseHome(), "sessions", "sessions.db");

let open: { path: string; ino: number; db: Database } | null = null;
function db(path = gooseDb()): Database | null {
  let ino: number;
  try { ino = statSync(path).ino; } catch { return null; }
  if (open?.path === path && open.ino === ino) return open.db;
  open?.db.close();
  open = { path, ino, db: new Database(path, { readonly: true }) };
  return open.db;
}
const has = (d: Database, table: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const json = (s: unknown): any => { if (typeof s !== "string") return undefined; try { return JSON.parse(s); } catch { return undefined; } };
// Goose writes UTC `YYYY-MM-DD HH:MM:SS`.
const timeMs = (s: unknown) => (typeof s === "string" ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`) || 0 : 0);
const seconds = (t: unknown) => { const n = Number(t) || 0; return n > 1e11 ? n : n * 1000; };

const textOf = (content: any): string => (Array.isArray(content) ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "");
// What the owner typed: a message the owner sees, that is no tool response, no turn context, no summary.
function prompt(row: { content_json: string; metadata_json: string | null }): string | undefined {
  const m = json(row.metadata_json) ?? {};
  if (m.userVisible === false || m.turnContext || m.compactionSummary) return undefined;
  const c = json(row.content_json);
  if (!Array.isArray(c) || c.some((b) => b?.type === "toolResponse")) return undefined;
  return textOf(c).trim() || undefined;
}

const known = new Map<string, { key: string; found: Found | null }>();
let left = 0;
// Every session, newest first. `budgetMs`: how long this call may spend reading prompts; sessions not reached are left for the next call.
export function gooseSessions(path = gooseDb(), budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  let pending = 0;
  const d = db(path);
  if (!d || !has(d, "sessions") || !has(d, "messages")) return [];
  const counts = new Map<string, { n: number; mx: number }>();
  for (const r of d.query<any, []>("SELECT session_id, COUNT(*) AS n, MAX(id) AS mx FROM messages GROUP BY session_id").all()) counts.set(r.session_id, { n: r.n, mx: r.mx });
  const first = d.query<any, [string]>("SELECT content_json, metadata_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 12");
  const last = d.query<any, [string]>("SELECT content_json, metadata_json FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 12");
  const size = d.query<{ s: number }, [string]>("SELECT COALESCE(SUM(LENGTH(content_json)), 0) AS s FROM messages WHERE session_id = ?");
  const out: Found[] = [];
  const seen = new Set<string>();
  for (const r of d.query<any, []>("SELECT * FROM sessions").all()) {
    const c = counts.get(r.id);
    // A session Goose keeps out of sight (its own naming and helper runs), and one with no message.
    if (r.session_type === "hidden" || !c) continue;
    seen.add(r.id);
    const key = `${r.updated_at}|${c.n}|${c.mx}|${r.name}|${r.archived_at}`;
    let k = known.get(`${path}#${r.id}`);
    if (!k || k.key !== key) {
      if (performance.now() > until) { pending++; if (!k) continue; }
      else {
        const f = (first.all(r.id) as any[]).map(prompt).find(Boolean);
        const l = (last.all(r.id) as any[]).map(prompt).find(Boolean);
        const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : typeof r.description === "string" ? r.description.trim() : "";
        const model = json(r.model_config_json)?.model_name;
        const type = r.session_type;
        k = {
          key,
          found: {
            harness: "goose", id: r.id, path: `${path}#${r.id}`, cwd: r.working_dir || undefined,
            title: clip(name || f || r.id, 120),
            first_prompt: f ? clip(f) : undefined, last_prompt: l ? clip(l) : undefined,
            updated_ms: timeMs(r.updated_at) || timeMs(r.created_at), size_bytes: size.get(r.id)?.s ?? 0,
            ...(typeof model === "string" && model ? { model } : {}),
            kind: type === "sub_agent" || r.parent_session_id ? "subagent" : type === "scheduled" ? "headless" : "interactive",
            ...(r.parent_session_id ? { parent_id: r.parent_session_id } : {}),
            ...(r.archived_at ? { archived: true } : {}),
          },
        };
        known.set(`${path}#${r.id}`, k);
      }
    }
    if (k.found) out.push(k.found);
  }
  left = pending;
  for (const key of known.keys()) if (key.startsWith(`${path}#`) && !seen.has(key.slice(path.length + 1))) known.delete(key);
  return out.sort((a, b) => b.updated_ms - a.updated_ms);
}

// A tool result's content blocks (text, images, embedded resources) as Keel stores them.
function resultContent(blocks: any, notes: Set<string>): string | any[] {
  const out: any[] = [];
  for (const c of Array.isArray(blocks) ? blocks : []) {
    if (c?.type === "text" && typeof c.text === "string") out.push({ type: "text", text: c.text });
    else if (c?.type === "image" && typeof c.data === "string") out.push({ type: "image", media_type: c.mimeType ?? "image/png", data: c.data });
    else if (c?.type === "resource" && typeof c.resource?.text === "string") out.push({ type: "text", text: c.resource.text });
    else if (c?.type) { notes.add(`a tool result's ${c.type} content`); out.push(unavailable(`${c.type} content`)); }
  }
  return out.length === 1 && out[0].type === "text" ? out[0].text : out.length ? out : "";
}

const NO_RESULT = "No result was recorded for this call.";

export async function readGoose(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const d = db(f.path.slice(0, f.path.lastIndexOf("#")));
  if (!d) throw new Error("Goose's session database is not there");
  const rows = d.query<any, [string]>("SELECT message_id, role, content_json, created_timestamp, metadata_json FROM messages WHERE session_id = ? ORDER BY created_timestamp, id").all(f.id);
  const sessionModel = json(d.query<any, [string]>("SELECT model_config_json FROM sessions WHERE id = ?").get(f.id)?.model_config_json)?.model_name;
  const calls = new Set<string>();
  let open: string[] = [];
  const flush = (ts: number) => { for (const id of open) b.result({ tool_use_id: id, content: NO_RESULT, is_error: true }, ts); open = []; };
  const unread = new Set<string>();
  let damaged = 0, hidden = 0, errors = 0, reissue = false, compactions = 0, lastId: string | null = null;

  for (const row of rows) {
    const content = json(row.content_json);
    const meta = json(row.metadata_json) ?? {};
    const ts = seconds(row.created_timestamp) || f.updated_ms;
    if (!Array.isArray(content)) { damaged++; continue; }
    const owner = meta.userVisible !== false;
    if (meta.compactionSummary) {
      const summary = textOf(content).trim();
      if (!summary) { damaged++; continue; }
      flush(ts);
      // The prompt Goose repeats after the summary is the newest event when the turn had no reply yet: it stays beside the summary.
      let at = b.events.findLastIndex((e) => e.kind === "user");
      const after = at < 0 ? [] : b.events.slice(at + 1);
      const kept = at >= 0 && after.every((e) => e.kind === "note");
      b.compacted(summary, ts, { trigger: "goose", tail: kept ? b.events.length - at : 0 });
      reissue = !kept;
      compactions++;
      continue;
    }
    if (!owner || meta.turnContext) {
      // For the agent alone: Goose's turn context, its continuation text after a compaction, the latest prompt again.
      if (reissue && row.role === "user" && !meta.turnContext) {
        const t = textOf(content).trim();
        if (t) { b.note(`Goose repeated the latest request after it compacted the context:\n${t}`, ts, true); }
        reissue = false;
      } else hidden++;
      continue;
    }
    reissue = false;

    if (row.role === "assistant") {
      flush(ts);
      const model = meta.inference?.resolvedModel ?? meta.inference?.requestedModel ?? sessionModel;
      let blocks: any[] = [];
      const send = () => { if (blocks.length) { b.assistant(blocks, ts, typeof model === "string" ? model : undefined, row.message_id !== lastId); lastId = row.message_id; blocks = []; } };
      for (const c of content) {
        if (c?.type === "text" && typeof c.text === "string") { if (c.text.trim()) blocks.push({ type: "text", text: c.text }); }
        else if (c?.type === "thinking" || c?.type === "redactedThinking") b.counts.thoughts_dropped++;
        else if (c?.type === "toolRequest" && typeof c.id === "string") {
          const call = c.toolCall?.status === "success" ? c.toolCall.value : undefined;
          calls.add(c.id);
          open.push(c.id);
          blocks.push({ type: "tool_use", id: c.id, name: typeof call?.name === "string" ? call.name : "invalid_tool_call", input: call?.arguments && typeof call.arguments === "object" ? call.arguments : {} });
          if (!call) unread.add(`a tool call Goose could not parse (${clip(String(c.toolCall?.error ?? "no reason given"), 80)})`);
        } else if (c?.type === "image" && typeof c.data === "string") blocks.push({ type: "text", text: "[an image Goose's model made is not carried]" });
        else if (c?.type === "error") { send(); errors++; b.note(`Goose reported an error here (${c.kind ?? "other"}): ${clip(String(c.message ?? ""), 300)}`, ts); }
        else if (c?.type === "document") unread.add(`a document${c.name ? ` ${c.name}` : ""}`);
      }
      send();
      continue;
    }

    // A user message: tool responses, and what the owner typed.
    let typed: any[] = [];
    const images: any[] = [];
    for (const c of content) {
      if (c?.type === "toolResponse" && typeof c.id === "string") {
        if (!calls.has(c.id)) { hidden++; continue; }
        open = open.filter((x) => x !== c.id);
        const r = c.toolResult;
        if (r?.status === "success") b.result({ tool_use_id: c.id, content: resultContent(r.value?.content, unread), is_error: r.value?.isError === true }, ts);
        else b.result({ tool_use_id: c.id, content: typeof r?.error === "string" ? r.error : "The call failed.", is_error: true }, ts);
      } else if (c?.type === "text" && typeof c.text === "string") typed.push(c.text);
      else if (c?.type === "image" && typeof c.data === "string") images.push({ type: "image", media_type: c.mimeType ?? "image/png", data: c.data });
      else if (c?.type === "document") unread.add(`document${c.name ? ` ${c.name}` : ""}`);
    }
    if (typed.length || images.length) { flush(ts); b.user(typed.join("\n"), ts, images); }
  }
  flush(f.updated_ms);

  if (damaged) notes.push(`${damaged} message${damaged === 1 ? "" : "s"} whose content could not be read ${damaged === 1 ? "is" : "are"} left out.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (hidden) notes.push(`${hidden} message${hidden === 1 ? "" : "s"} Goose wrote for the agent alone (turn context, the continuation text after a compaction, the latest request repeated) or for a call not in the conversation ${hidden === 1 ? "is" : "are"} left out.`);
  if (unread.size) notes.push(`Not carried: ${[...unread].join(", ")}.`);
  if (compactions) notes.push(`Goose compacted this session ${compactions === 1 ? "once" : `${compactions} times`}: the model reads from the summary on, and the earlier messages stay in the history.`);
  if (errors) notes.push(`${errors} error${errors === 1 ? "" : "s"} Goose reported ${errors === 1 ? "is" : "are"} noted where ${errors === 1 ? "it" : "they"} happened.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const gooseStore: SideStore = {
  harness: "goose",
  label: "Goose",
  store: gooseHome,
  list: () => gooseSessions(undefined, 40),
  read: readGoose,
  pending: () => left,
};
