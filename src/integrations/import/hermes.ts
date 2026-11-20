// Hermes Agent: one SQLite database, ~/.hermes/state.db, holds every session
// (`sessions`: source, cwd, title, model, times in seconds) and its messages
// (`messages`: OpenAI-shaped roles user / assistant / tool, `tool_calls` as
// JSON, `active` for the messages the current branch holds, `_compressed_summary`
// for a compression's summary, `display_kind` for what the harness wrote itself).
// Opened read-only; nothing here writes.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Builder, clip, type Found, type Kind, type Read } from "./types.ts";

export const hermesHome = () => process.env.KEEL_IMPORT_HERMES_DIR ?? join(homedir(), ".hermes");
export const hermesDb = () => join(hermesHome(), "state.db");

// Sources nobody sat at: schedules, one-shot runs, the board, helpers, and
// conversations Hermes itself copied in from another harness.
const AUTOMATED = new Set(["cron", "oneshot", "kanban", "llm-wiki-lint", "grok-cli"]);
// User messages the harness wrote (notices, a finished background job), not the person.
const HARNESS_KINDS = new Set(["internal_notification", "async_delegation_complete", "process_complete", "model_switch", "hidden", "failed_turn"]);

const ms = (s: unknown) => (typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 0);
const kindOf = (source: string | null): Kind => (source === "subagent" ? "subagent" : source && AUTOMATED.has(source) ? "headless" : "interactive");

let open: { path: string; ino: number; db: Database } | null = null;
function db(path = hermesDb()): Database | null {
  let ino: number;
  try { ino = statSync(path).ino; } catch { return null; }
  if (open?.path === path && open.ino === ino) return open.db;
  open?.db.close();
  open = { path, ino, db: new Database(path, { readonly: true }) };
  return open.db;
}

const PROMPT_CHARS = 2000;
const PROMPT = "role = 'user' AND active = 1 AND _compressed_summary = 0 AND (display_kind IS NULL OR display_kind = 'steer')";

// Rows already read, by session and the activity time they were read at: a
// listing reads the prompts only of sessions that are new or went on (the
// gateway writes all day, so the whole database is never read again).
const known = new Map<string, { at: number; found: Found | null }>();

// `budgetMs`: how long this call may spend reading prompts; sessions not
// reached are left for the next call (`hermesPending` says how many), so a
// first listing of a large store never holds the daemon.
export let hermesPending = 0;
export function hermesSessions(path = hermesDb(), budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  let pending = 0;
  const d = db(path);
  if (!d) return [];
  const size = statSync(path).size;
  const sessions = d.query<any, []>(
    "SELECT id, source, cwd, title, model, archived, parent_session_id AS parent, COALESCE(last_activity_at, ended_at, started_at) AS at FROM sessions WHERE hidden = 0",
  ).all();
  // Only the start of each prompt: a listing shows a clipped line, and a clip
  // of the whole text would keep the whole text alive (a substring holds its
  // source), a long store's every first and last prompt in memory.
  const first = d.query<{ content: string | null }, [string]>(`SELECT substr(content, 1, ${PROMPT_CHARS}) AS content FROM messages WHERE session_id = ? AND ${PROMPT} ORDER BY id LIMIT 1`);
  const last = d.query<{ content: string | null }, [string]>(`SELECT substr(content, 1, ${PROMPT_CHARS}) AS content FROM messages WHERE session_id = ? AND ${PROMPT} ORDER BY id DESC LIMIT 1`);
  const out: Found[] = [];
  const live = new Set<string>();
  for (const r of sessions) {
    live.add(r.id);
    const at = ms(r.at);
    let k = known.get(`${path}#${r.id}`);
    if ((!k || k.at !== at) && performance.now() > until) { pending++; if (!k) continue; }
    else if (!k || k.at !== at) {
      const f1 = first.get(r.id)?.content ?? undefined;
      const fz = last.get(r.id)?.content ?? undefined;
      k = {
        at,
        found: f1 || fz ? {
          harness: "hermes", id: r.id, path: `${path}#${r.id}`, cwd: r.cwd ?? undefined,
          title: clip(r.title?.trim() || fz || r.id, 120),
          first_prompt: f1 ? clip(f1) : undefined, last_prompt: fz ? clip(fz) : undefined,
          updated_ms: at, size_bytes: size, model: r.model ?? undefined, kind: kindOf(r.source),
          parent_id: r.source === "subagent" ? (r.parent ?? undefined) : undefined,
          archived: !!r.archived || undefined,
        } : null,
      };
      known.set(`${path}#${r.id}`, k);
    }
    if (k.found) out.push({ ...k.found, size_bytes: size });
  }
  hermesPending = pending;
  for (const key of known.keys()) if (key.startsWith(`${path}#`) && !live.has(key.slice(path.length + 1))) known.delete(key);
  return out;
}

const args = (a: unknown) => {
  if (a && typeof a === "object") return a;
  if (typeof a !== "string" || !a.trim()) return {};
  try { return JSON.parse(a); } catch { return { input: a }; }
};

export async function readHermes(f: Found, path = hermesDb()): Promise<Read> {
  const d = db(path);
  if (!d) throw new Error("Hermes's state.db was not found");
  const s = d.query<{ source: string | null; model: string | null }, [string]>("SELECT source, model FROM sessions WHERE id = ?").get(f.id);
  if (!s) throw Object.assign(new Error(`Hermes has no session ${f.id}`), { status: 404 });
  const rows = d.query<any, [string]>(
    `SELECT role, content, tool_call_id, tool_calls, reasoning, reasoning_details, codex_reasoning_items, display_kind, _compressed_summary AS summary, timestamp
     FROM messages WHERE session_id = ? AND (active = 1 OR compacted = 1) ORDER BY id`,
  ).all(f.id);
  const b = new Builder();
  let summaries = 0;
  // Calls still waiting for a result: a later turn closes them as failed, so
  // every call in the history has its result (an interrupted run leaves some).
  const waiting = new Set<string>();
  let lastTs = f.updated_ms;
  const close = (ts: number) => {
    for (const id of waiting) b.result({ tool_use_id: id, content: "No result was recorded for this call.", is_error: true }, ts);
    waiting.clear();
  };
  for (const r of rows) {
    const ts = ms(r.timestamp) || lastTs;
    lastTs = ts;
    if (r.role !== "tool") close(ts);
    const text: string = r.content ?? "";
    if (r.role === "user") {
      if (!text.trim()) continue;
      if (r.summary) { b.note(text, ts, true); summaries++; continue; }
      if (r.display_kind && HARNESS_KINDS.has(r.display_kind)) { b.note(text, ts, true); b.counts.skipped++; continue; }
      b.user(text, ts);
    } else if (r.role === "assistant") {
      if (r.reasoning?.trim() || [r.reasoning_details, r.codex_reasoning_items].some((x) => x && x.trim() && x.trim() !== "[]")) b.counts.thoughts_dropped++;
      if (r.display_kind && HARNESS_KINDS.has(r.display_kind)) { b.counts.skipped++; continue; }
      const blocks: any[] = [];
      if (text.trim()) blocks.push({ type: "text", text });
      let calls: any[] = [];
      try { calls = r.tool_calls ? JSON.parse(r.tool_calls) : []; } catch {}
      for (const c of Array.isArray(calls) ? calls : []) {
        const id = String(c.id ?? c.call_id ?? "");
        if (id) waiting.add(id);
        if (id) blocks.push({ type: "tool_use", id, name: String(c.function?.name ?? c.name ?? "tool"), input: args(c.function?.arguments ?? c.arguments) });
      }
      b.assistant(blocks, ts, s.model ?? undefined, true);
    } else if (r.role === "tool") {
      if (!r.tool_call_id || !waiting.delete(r.tool_call_id)) { b.counts.skipped++; continue; }
      let failed = false;
      try { const v = JSON.parse(text); failed = v?.success === false || (typeof v?.error === "string" && !!v.error); } catch {}
      b.result({ tool_use_id: r.tool_call_id, content: text, is_error: failed }, ts);
    } else b.counts.skipped++;
  }
  close(lastTs);
  const notes: string[] = [];
  if (summaries) notes.push("Hermes's compression summaries are kept as notes where they happened.");
  notes.push("Hermes's tool names are kept as it called them (history, not a re-run).");
  return { found: f, events: b.events, counts: b.counts, notes };
}
