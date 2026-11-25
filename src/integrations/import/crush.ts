// Crush (Charm's crush): one SQLite database per project, <data dir>/crush.db (the data dir is
// `.crush` in the project unless its config says otherwise), and a global data folder
// ($CRUSH_GLOBAL_DATA, $XDG_DATA_HOME/crush, else ~/.local/share/crush) whose projects.json lists
// every project Crush has opened: { projects: [{ path, data_dir, last_accessed }] }, a relative
// data_dir being relative to the project's path. `sessions` holds a row per session (id, title,
// parent_session_id for a subagent's task session, whose id is the tool call's id, and for the
// helper session `title-<id>` that names a session; message_count, updated_at and created_at in
// seconds, summary_message_id); `messages` a row per message (id, session_id, role user, assistant,
// tool or system, parts, model, model_name, provider, created_at in seconds, is_summary_message).
// `parts` is a JSON list of { type, data }: text { text, hidden, context }, reasoning { thinking },
// image_url { url }, binary { Path, MIMEType, Data } (Data base64), tool_call { id, name, input as
// JSON text }, tool_result { tool_call_id, content, data, mime_type, is_error }, finish { reason
// end_turn, max_tokens, tool_use, canceled, error or content_filter, message, details },
// shell_command { command, output, exit_code } (a command the owner ran) and sub_agent_report
// { label, output, failed }. When Crush summarizes a session it stores the summary as an assistant
// message with is_summary_message and the model reads from it on.
//
// Source: github.com/charmbracelet/crush (v0.102.0, main 2026-11-25), internal/message/content.go and
// message.go, internal/db/migrations, internal/session/session.go, internal/projects/projects.go and
// internal/config/load.go. Opened read-only; nothing here writes.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SideStore } from "./more.ts";
import { Builder, clip, type Found, type Read } from "./types.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const crushHome = () => {
  if (process.env.KEEL_IMPORT_CRUSH_DIR) return process.env.KEEL_IMPORT_CRUSH_DIR;
  const g = ownerEnv("CRUSH_GLOBAL_DATA");
  if (g) return g;
  const xdg = ownerEnv("XDG_DATA_HOME");
  return join(xdg?.startsWith("/") ? xdg : join(ownerHome(), ".local", "share"), "crush");
};

// The databases of the projects Crush lists, with each project's folder.
function databases(): { db: string; project: string }[] {
  let list: any;
  try { list = JSON.parse(readFileSync(join(crushHome(), "projects.json"), "utf8")); } catch { return []; }
  const out: { db: string; project: string }[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(list?.projects) ? list.projects : []) {
    if (typeof p?.path !== "string" || !isAbsolute(p.path)) continue;
    const dir = typeof p.data_dir === "string" && p.data_dir ? (isAbsolute(p.data_dir) ? p.data_dir : join(p.path, p.data_dir)) : join(p.path, ".crush");
    const db = join(dir, "crush.db");
    if (!seen.has(db) && existsSync(db)) { seen.add(db); out.push({ db, project: p.path }); }
  }
  return out;
}

const open = new Map<string, { ino: number; db: Database }>();
function db(path: string): Database | null {
  let ino: number;
  try { ino = statSync(path).ino; } catch { return null; }
  const had = open.get(path);
  if (had?.ino === ino) return had.db;
  had?.db.close();
  try {
    const d = new Database(path, { readonly: true });
    open.set(path, { ino, db: d });
    return d;
  } catch { open.delete(path); return null; }
}
const has = (d: Database, table: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const parts = (s: unknown): any[] => { try { const v = JSON.parse(String(s)); return Array.isArray(v) ? v : []; } catch { return []; } };
const seconds = (t: unknown) => (Number(t) || 0) * 1000;

// What the owner typed in a message: text parts that are no generated continuation, in a message with no shell command or report.
function prompt(row: { role: string; parts: string }): string | undefined {
  if (row.role !== "user") return undefined;
  const ps = parts(row.parts);
  if (ps.some((p) => p?.type === "shell_command" || p?.type === "sub_agent_report")) return undefined;
  return ps.filter((p) => p?.type === "text" && !p.data?.hidden && typeof p.data?.text === "string").map((p) => p.data.text).join("\n").trim() || undefined;
}

const known = new Map<string, { key: string; found: Found | null }>();
let left = 0;
// Every session of every project, newest first. `budgetMs`: how long this call may spend reading prompts; sessions not reached are left for the next call.
export function crushSessions(budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  let pending = 0;
  const out: Found[] = [];
  const seen = new Set<string>();
  const dbs = databases();
  for (const { db: path, project } of dbs) {
    const d = db(path);
    if (!d || !has(d, "sessions") || !has(d, "messages")) continue;
    const first = d.query<any, [string]>("SELECT role, parts FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at, rowid LIMIT 12");
    const last = d.query<any, [string]>("SELECT role, parts FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 12");
    const model = d.query<any, [string]>("SELECT model, model_name FROM messages WHERE session_id = ? AND role = 'assistant' AND model != '' ORDER BY created_at DESC, rowid DESC LIMIT 1");
    const size = d.query<{ s: number }, [string]>("SELECT COALESCE(SUM(LENGTH(parts)), 0) AS s FROM messages WHERE session_id = ?");
    for (const r of d.query<any, []>("SELECT * FROM sessions").all()) {
      // The helper session that names a session, and a session with no message.
      if (String(r.id).startsWith("title-") || !(Number(r.message_count) > 0)) continue;
      const id = `${path}#${r.id}`;
      seen.add(id);
      const key = `${r.updated_at}|${r.message_count}|${r.title}`;
      let k = known.get(id);
      if (!k || k.key !== key) {
        if (performance.now() > until) { pending++; if (!k) continue; }
        else {
          const f = (first.all(r.id) as any[]).map(prompt).find(Boolean);
          const l = (last.all(r.id) as any[]).map(prompt).find(Boolean);
          const m = model.get(r.id);
          k = {
            key,
            found: {
              harness: "crush", id: r.id, path: id, cwd: project,
              title: clip(typeof r.title === "string" && r.title.trim() ? r.title.trim() : f || r.id, 120),
              first_prompt: f ? clip(f) : undefined, last_prompt: l ? clip(l) : undefined,
              updated_ms: seconds(r.updated_at) || seconds(r.created_at), size_bytes: size.get(r.id)?.s ?? 0,
              ...(m?.model ? { model: m.model } : {}),
              kind: r.parent_session_id ? "subagent" : "interactive",
              ...(r.parent_session_id ? { parent_id: r.parent_session_id } : {}),
            },
          };
          known.set(id, k);
        }
      }
      if (k.found) out.push(k.found);
    }
  }
  left = pending;
  for (const key of known.keys()) if (!seen.has(key)) known.delete(key);
  // A project no longer listed releases its database.
  const live = new Set(dbs.map((x) => x.db));
  for (const [p, o] of open) if (!live.has(p)) { o.db.close(); open.delete(p); }
  return out.sort((a, b) => b.updated_ms - a.updated_ms);
}

const NO_RESULT = "No result was recorded for this call.";

export async function readCrush(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const d = db(f.path.slice(0, f.path.lastIndexOf("#")));
  if (!d) throw new Error("Crush's project database is not there");
  const rows = d.query<any, [string]>("SELECT id, role, parts, model, model_name, created_at, is_summary_message FROM messages WHERE session_id = ? ORDER BY created_at, rowid").all(f.id);
  const calls = new Set<string>();
  let open: string[] = [];
  const flush = (ts: number) => { for (const id of open) b.result({ tool_use_id: id, content: NO_RESULT, is_error: true }, ts); open = []; };
  const unread = new Set<string>();
  const models = new Set<string>();
  let damaged = 0, skipped = 0, context = 0, errors = 0, summaries = 0;
  const skip = () => { b.counts.skipped++; skipped++; };

  const result = (p: any, ts: number) => {
    const rd = p.data ?? {};
    const id = typeof rd.tool_call_id === "string" ? rd.tool_call_id : "";
    if (!calls.has(id)) { b.note(`A tool result Crush recorded (${rd.name ?? "unknown tool"}):\n${String(rd.content ?? "")}`, ts, true); skip(); return; }
    open = open.filter((x) => x !== id);
    const media = typeof rd.data === "string" && rd.data && String(rd.mime_type).startsWith("image/") ? [{ type: "image", media_type: rd.mime_type, data: rd.data }] : [];
    if (typeof rd.data === "string" && rd.data && !media.length) unread.add(`a tool result's ${rd.mime_type || "binary"} data`);
    const text = String(rd.content ?? "");
    b.result({ tool_use_id: id, content: media.length ? [...(text ? [{ type: "text", text }] : []), ...media] : text, is_error: rd.is_error === true }, ts);
  };

  for (const row of rows) {
    const ts = seconds(row.created_at) || f.updated_ms;
    const ps = parts(row.parts);
    if (row.is_summary_message) {
      const summary = ps.filter((p) => p?.type === "text").map((p) => String(p.data?.text ?? "")).join("\n").trim();
      for (const p of ps) if (p?.type === "reasoning") b.counts.thoughts_dropped++;
      if (!summary) { damaged++; continue; }
      flush(ts);
      b.compacted(summary, ts, { trigger: "crush" });
      summaries++;
      continue;
    }
    if (row.role === "assistant") {
      flush(ts);
      const blocks: any[] = [];
      let stop: string | undefined;
      let failure: string | undefined;
      const later: any[] = [];
      for (const p of ps) {
        const pd = p?.data ?? {};
        if (p?.type === "reasoning") b.counts.thoughts_dropped++;
        else if (p?.type === "text") { if (typeof pd.text === "string" && pd.text.trim()) blocks.push({ type: "text", text: pd.text }); }
        else if (p?.type === "tool_call" && typeof pd.name === "string") {
          const id = typeof pd.id === "string" && pd.id ? pd.id : `crush_${row.id}_${blocks.length}`;
          let input: any = {};
          try { const v = JSON.parse(pd.input || "{}"); input = v && typeof v === "object" && !Array.isArray(v) ? v : { input: v }; } catch { input = pd.input ? { input: pd.input } : {}; }
          calls.add(id);
          open.push(id);
          blocks.push({ type: "tool_use", id, name: pd.name, input });
        } else if (p?.type === "tool_result") later.push(p);
        else if (p?.type === "finish") {
          if (pd.reason === "canceled") stop = "interrupted";
          else if (pd.reason === "max_tokens") stop = "max_tokens";
          else if (pd.reason === "error" || pd.reason === "content_filter") failure = `${pd.reason === "content_filter" ? "Crush's model refused this reply" : "Crush's model request failed here"}${[pd.message, pd.details].filter((x) => typeof x === "string" && x).length ? `: ${clip([pd.message, pd.details].filter((x) => typeof x === "string" && x).join(": "), 300)}` : "."}`;
        }
      }
      if (row.model) models.add(row.model);
      b.assistant(blocks, ts, row.model || undefined, true, stop);
      for (const p of later) result(p, ts);
      if (failure) { errors++; b.note(failure, ts); }
    } else if (row.role === "tool") {
      for (const p of ps) if (p?.type === "tool_result") result(p, ts); else skip();
    } else if (row.role === "user") {
      const typed: string[] = [];
      const images: any[] = [];
      for (const p of ps) {
        const pd = p?.data ?? {};
        if (p?.type === "text" && typeof pd.text === "string") {
          if (pd.context) context++;
          if (pd.hidden) { if (pd.text.trim()) { flush(ts); b.note(`Crush added this to the conversation for the model (not typed by the owner):\n${pd.text}`, ts, true); } }
          else typed.push(pd.text);
        } else if (p?.type === "binary") {
          if (String(pd.MIMEType).startsWith("image/") && typeof pd.Data === "string") images.push({ type: "image", media_type: pd.MIMEType, data: pd.Data });
          else { unread.add(`an attachment of type ${pd.MIMEType || "unknown"}${pd.Path ? ` (${pd.Path})` : ""}`); }
        } else if (p?.type === "image_url") unread.add(`an image at ${pd.url ?? "an address"}`);
        else if (p?.type === "shell_command") { flush(ts); b.note([`The owner ran a shell command in Crush: ${pd.command}`, pd.exit_code ? `(exit code ${pd.exit_code})` : "", String(pd.output ?? "").trimEnd()].filter(Boolean).join("\n"), ts, true); }
        else if (p?.type === "sub_agent_report") { flush(ts); b.note(`<subagent-report label=${JSON.stringify(pd.label ?? "")}${pd.failed ? " failed" : ""}>\n${String(pd.output ?? "")}\n</subagent-report>`, ts, true); }
      }
      if (typed.join("").trim() || images.length) { flush(ts); b.user(typed.join("\n"), ts, images); }
    } else skip(); // Crush's own system messages
  }
  flush(f.updated_ms);

  if (damaged) notes.push(`${damaged} summary message${damaged === 1 ? "" : "s"} with no text ${damaged === 1 ? "is" : "are"} left out.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (unread.size) notes.push(`Not carried: ${[...unread].join(", ")}.`);
  if (context) notes.push(`The host context and notes Crush put ahead of ${context === 1 ? "a prompt" : `${context} prompts`} (stored with the prompt) ${context === 1 ? "is" : "are"} not carried.`);
  if (summaries) notes.push(`Crush summarized this session ${summaries === 1 ? "once" : `${summaries} times`}: the model reads from the summary on, and the earlier messages stay in the history.`);
  if (skipped) notes.push(`${skipped} item${skipped === 1 ? "" : "s"} (Crush's system messages, results of calls not in the conversation) ${skipped === 1 ? "is" : "are"} left out or carried as notes.`);
  if (errors) notes.push(`${errors} model request${errors === 1 ? "" : "s"} failed in Crush and ${errors === 1 ? "is" : "are"} noted where ${errors === 1 ? "it" : "they"} happened.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const crushStore: SideStore = {
  harness: "crush",
  label: "Crush",
  store: crushHome,
  list: () => crushSessions(40),
  read: readCrush,
  pending: () => left,
};
