// The Rust Keel's own sessions, from its state database, opened read-only (the
// live daemon keeps writing it; nothing here writes). Events form a tree by
// parent_id; the branch shown runs from the session's head back to its root.
// After a summary compaction, what the model saw is the summary and the events
// after the point it covers.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Builder, clip, resultText, type Found, type Read } from "./types.ts";

export const keelDb = () => process.env.KEEL_IMPORT_KEEL_DB ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "keel-stable/state/keel.db");

let open: { path: string; ino: number; db: Database } | null = null;
function db(path = keelDb()): Database | null {
  let ino: number;
  try { ino = statSync(path).ino; } catch { return null; }
  if (open?.path === path && open.ino === ino) return open.db;
  open?.db.close();
  open = { path, ino, db: new Database(path, { readonly: true }) };
  return open.db;
}

const unquote = (s: string) => {
  try { const v = JSON.parse(s); return typeof v === "string" ? v : s; } catch { return s; }
};

export function keelSessions(path = keelDb()): Found[] {
  const d = db(path);
  if (!d) return [];
  const size = statSync(path).size;
  const rows = d.query<any, []>(
    `SELECT s.id, s.title, s.cwd, s.model, s.provider, s.parent_session_id, s.updated_ms, s.archived, s.scratch,
       (SELECT json_extract(e.event_json, '$.text') FROM events e WHERE e.session_id = s.id AND json_extract(e.event_json, '$.type') = 'user_turn' ORDER BY e.seq LIMIT 1) AS first,
       (SELECT json_extract(e.event_json, '$.text') FROM events e WHERE e.session_id = s.id AND json_extract(e.event_json, '$.type') = 'user_turn' ORDER BY e.seq DESC LIMIT 1) AS last,
       (SELECT json_extract(e.event_json, '$.input_kind') FROM events e WHERE e.session_id = s.id AND json_extract(e.event_json, '$.type') = 'user_turn' ORDER BY e.seq LIMIT 1) AS input_kind
     FROM sessions s`,
  ).all();
  return rows
    .filter((r) => r.first || r.last)
    .map((r) => ({
      harness: "keel" as const,
      id: r.id,
      path: `${path}#${r.id}`,
      cwd: r.cwd,
      title: clip(r.title || r.first || "", 120),
      first_prompt: r.first ? clip(r.first) : undefined,
      last_prompt: r.last ? clip(r.last) : undefined,
      updated_ms: r.updated_ms,
      size_bytes: size,
      model: r.model ? `${unquote(r.provider)}:${r.model}` : undefined,
      kind: r.parent_session_id ? ("subagent" as const) : r.input_kind === "loop" || r.scratch ? ("headless" as const) : ("interactive" as const),
      parent_id: r.parent_session_id ?? undefined,
    }));
}

export async function readKeel(id: string, path = keelDb()): Promise<Read> {
  const d = db(path);
  if (!d) throw new Error("the Rust Keel's state was not found");
  const found = keelSessions(path).find((s) => s.id === id);
  if (!found) throw new Error(`the Rust Keel has no session ${id}`);
  const head = d.query<{ head_event_id: string | null }, [string]>("SELECT head_event_id FROM sessions WHERE id = ?").get(id)?.head_event_id;
  const rows = d.query<{ id: string; parent_id: string | null; ts_ms: number; event_json: string }, [string]>("SELECT id, parent_id, ts_ms, event_json FROM events WHERE session_id = ? ORDER BY seq").all(id);
  let chain = rows;
  if (head) {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const path: typeof rows = [];
    const seen = new Set<string>();
    for (let r = byId.get(head); r && !seen.has(r.id); r = r.parent_id ? byId.get(r.parent_id) : undefined) {
      seen.add(r.id);
      path.push(r);
    }
    if (path.length) chain = path.reverse();
  }
  // From the last summary compaction on.
  const notes: string[] = [];
  let start = 0;
  let summary: { text: string; ts: number } | null = null;
  chain.forEach((r, i) => {
    const e = JSON.parse(r.event_json);
    if (e.type === "compaction_checkpoint" && e.mode !== "snip" && e.summary) {
      const at = chain.findIndex((x) => x.id === e.covered_up_to_event_id);
      start = (at >= 0 ? at : i) + 1;
      summary = { text: e.summary, ts: r.ts_ms };
    }
  });
  const b = new Builder();
  if (summary) {
    b.note(`Summary of the earlier conversation:\n${(summary as any).text}`, (summary as any).ts, true);
    notes.push("Starts at the Rust Keel's last compaction: its summary is the first message.");
  }
  for (const r of chain.slice(start)) {
    const e = JSON.parse(r.event_json);
    switch (e.type) {
      case "user_turn":
        b.user(String(e.text ?? ""), r.ts_ms);
        break;
      case "assistant_text":
        if (e.text) b.assistant([{ type: "text", text: e.text }], r.ts_ms, e.model);
        break;
      case "tool_call":
        b.assistant([{ type: "tool_use", id: e.call_id, name: e.tool_name, input: e.arguments ?? {} }], r.ts_ms, e.model);
        break;
      case "tool_result":
        b.result({ tool_use_id: e.call_id, content: resultText(e.output), is_error: e.is_error }, r.ts_ms);
        break;
      case "thought":
        b.counts.thoughts_dropped++;
        break;
      case "subagent_finished":
        if (e.summary) b.note(`Subagent ${e.child_session_id} finished: ${clip(String(e.summary), 400)}`, r.ts_ms);
        break;
      default:
        b.counts.skipped++;
    }
  }
  return { found, events: b.events, counts: b.counts, notes };
}
