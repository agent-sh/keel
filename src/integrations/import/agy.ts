// Antigravity (agy): one folder per conversation. Three stores share the
// layout under ~/.gemini: antigravity-cli (the command line tool),
// antigravity (the IDE) and antigravity-acp (the ACP server an editor runs).
// The first two list conversations in conversation_summaries.db (title,
// preview, last_modified_time, workspace_uris as file:// addresses,
// parent_conversation_id for a subagent's); the ACP store has no list, only
// conversations/<id>.meta (JSON with cwd) beside a database of binary steps.
// The conversation itself is brain/<id>/.system_generated/logs/
// transcript_full.jsonl, one step per line: USER_INPUT (the request inside
// <USER_REQUEST>, the harness's notes in other tags), PLANNER_RESPONSE (the
// model: content, readable thinking, tool_calls as { name, args } without
// ids), the result of the oldest call still waiting under a step of its own
// kind (GENERIC, RUN_COMMAND, VIEW_FILE, AGENCY_TOOL_CALL and more as tools
// are added), ERROR_MESSAGE, CHECKPOINT (a compaction's summary) and
// SYSTEM_MESSAGE (the harness's own). A
// conversation kept as binary steps only has no transcript and is not listed.
// Nothing here writes.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { damageNotes, headTail, readLines } from "./files.ts";
import { Builder, clip, type Found, type Read } from "./types.ts";
import { homeDir } from "../../core/paths";

export const agyHome = () => process.env.KEEL_IMPORT_AGY_DIR ?? join(homeDir(), ".gemini");
const STORES = ["antigravity-cli", "antigravity", "antigravity-acp"] as const;
const TRANSCRIPT = ".system_generated/logs/transcript_full.jsonl";

export const transcriptOf = (store: string, id: string) => join(store, "brain", id, TRANSCRIPT);

// `2026-10-15 21:13:33.492562794+00:00` (Go's format) or RFC 3339.
const timeMs = (t: unknown) => {
  if (typeof t !== "string") return 0;
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?/.exec(t);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}${m[4] ?? "Z"}`) || 0 : 0;
};

// What the person asked, without what the harness adds around it. The request is everything between the first opening tag and the last closing
// one, kept as written (it may quote the tags or metadata-shaped text); the
// harness's metadata sits outside it. Input without the wrapper loses only the
// metadata elements it starts or ends with.
const LEAD = /^<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USER_SETTINGS)>[\s\S]*?<\/\1>/;
const TRAIL = /<(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USER_SETTINGS)>(?:(?!<\1>)[\s\S])*<\/\1>$/;
export function requestText(content: string): string {
  const a = content.indexOf("<USER_REQUEST>");
  const b = content.lastIndexOf("</USER_REQUEST>");
  if (a >= 0 && b > a) return content.slice(a + "<USER_REQUEST>".length, b).trim();
  let t = content.trim();
  for (let m; (m = LEAD.exec(t)); ) t = t.slice(m[0].length).trim();
  for (let m; (m = TRAIL.exec(t)); ) t = t.slice(0, m.index).trim();
  return t;
}

// A tool result without the times the harness puts first.
export function resultOf(content: string): string {
  let rest = content;
  for (const lead of ["Created At:", "Completed At:"]) if (rest.startsWith(lead)) rest = rest.slice(rest.indexOf("\n") + 1 || rest.length);
  return rest.replace(/^\n+/, "");
}

const fileUri = (uris: string) => {
  try {
    const u = (JSON.parse(uris) as string[]).find((x) => x.startsWith("file://"));
    return u ? decodeURIComponent(u.slice("file://".length)) : undefined;
  } catch {
    return undefined;
  }
};

function prompts(path: string) {
  const { head, tail } = headTail(path, 64 * 1024);
  const all = [...head, ...tail].filter((r) => r.type === "USER_INPUT" && typeof r.content === "string").map((r) => requestText(r.content)).filter(Boolean);
  return { first: all[0], last: all[all.length - 1] };
}

function found(store: string, id: string, row: { title?: string; preview?: string; listed_ms?: number; cwd?: string; parent?: string }): Found | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const path = transcriptOf(store, id);
  let st;
  try { st = statSync(path); } catch { return null; }
  const p = prompts(path);
  const title = [row.title, row.preview, p.last].find((t) => t?.trim()) ?? id;
  return {
    harness: "agy", id, path, cwd: row.cwd, title: clip(title, 120),
    first_prompt: p.first ? clip(p.first) : undefined, last_prompt: p.last ? clip(p.last) : undefined,
    updated_ms: Math.max(row.listed_ms ?? 0, Math.round(st.mtimeMs)), size_bytes: st.size,
    kind: row.parent ? "subagent" : "interactive", parent_id: row.parent || undefined,
  };
}

// Every readable conversation of the three stores.
export function agySessions(home = agyHome()): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  const add = (f: Found | null) => { if (f && !seen.has(f.id)) { seen.add(f.id); out.push(f); } };
  for (const name of STORES) {
    const store = join(home, name);
    const list = join(store, "conversation_summaries.db");
    if (existsSync(list)) {
      let db: Database | undefined;
      try {
        db = new Database(list, { readonly: true });
        db.exec("PRAGMA busy_timeout = 2000");
        const rows = db.query<{ id: string; title: string; preview: string; t: string; uris: string; parent: string | null }, []>(
          "SELECT conversation_id AS id, title, preview, last_modified_time AS t, workspace_uris AS uris, parent_conversation_id AS parent FROM conversation_summaries ORDER BY last_modified_time DESC",
        ).all();
        for (const r of rows) add(found(store, r.id, { title: r.title, preview: r.preview, listed_ms: timeMs(r.t), cwd: fileUri(r.uris), parent: r.parent ?? undefined }));
      } catch {
        // a store being written or of another shape: skipped this round
      } finally {
        db?.close();
      }
    } else if (existsSync(join(store, "conversations"))) {
      for (const n of readdirSync(join(store, "conversations"))) {
        if (!n.endsWith(".meta")) continue;
        let cwd: string | undefined;
        try { cwd = JSON.parse(readFileSync(join(store, "conversations", n), "utf8")).cwd || undefined; } catch {}
        add(found(store, n.slice(0, -5), { cwd }));
      }
    }
  }
  return out;
}

export async function readAgy(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const st = statSync(f.path);
  // Calls get their results in the order they were made; ids are ours.
  const waiting: string[] = [];
  let compacted = false;
  // A call left without a result when the conversation moves on gets one, so
  // the history stays well formed for the next model.
  const settle = (ts: number) => {
    for (const id of waiting.splice(0)) b.result({ tool_use_id: id, content: "No result was recorded for this call.", is_error: true }, ts);
  };
  // Steps are numbered; a parallel call's results can be written before the
  // step that made the calls, so the order is the numbering.
  const lines = readLines(await Bun.file(f.path).text());
  const steps = lines.records.map((r, i) => ({ r, k: Number.isInteger(r.step_index) ? r.step_index : i }));
  steps.sort((a, b) => a.k - b.k);
  for (const { r } of steps) {
    const ts = timeMs(r.created_at) || st.mtimeMs;
    const content = typeof r.content === "string" ? r.content : "";
    switch (r.type) {
      case "USER_INPUT": {
        settle(ts);
        const images = (Array.isArray(r.media) ? r.media : [])
          .map((m: any) => ({ mime: m?.mimeType ?? m?.mime_type, data: m?.data ?? m?.inlineData }))
          .filter((m: any) => typeof m.mime === "string" && m.mime.startsWith("image/") && typeof m.data === "string")
          .map((m: any) => ({ type: "image", source: { type: "base64", media_type: m.mime, data: m.data } }));
        b.user(requestText(content), ts, images);
        break;
      }
      case "PLANNER_RESPONSE": {
        settle(ts);
        if (typeof r.thinking === "string" && r.thinking.trim()) b.counts.thoughts_dropped++;
        const blocks: any[] = content.trim() ? [{ type: "text", text: content }] : [];
        (Array.isArray(r.tool_calls) ? r.tool_calls : []).forEach((c: any, i: number) => {
          if (!c?.name) return;
          const id = `agy${r.step_index ?? 0}_${i}`;
          waiting.push(id);
          blocks.push({ type: "tool_use", id, name: String(c.name), input: c.args && typeof c.args === "object" ? c.args : {} });
        });
        b.assistant(blocks, ts, undefined, true);
        break;
      }
      case "SYSTEM_MESSAGE":
        b.counts.skipped++; // the harness's own
        break;
      case "CHECKPOINT":
        if (content.trim()) { b.note(`Antigravity compacted the conversation here. Its summary:\n${content}`, ts, true); compacted = true; }
        break;
      default: {
        // Any other step answers the oldest waiting call; an error with no call waiting is skipped.
        const id = waiting.shift();
        if (id) b.result({ tool_use_id: id, content: resultOf(content), is_error: r.type === "ERROR_MESSAGE" || (typeof r.status === "string" && r.status !== "DONE") }, ts);
        else b.counts.skipped++;
      }
    }
  }
  settle(st.mtimeMs);
  notes.push(...damageNotes(lines));
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning step${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (compacted) notes.push("Antigravity's compaction summaries are kept as notes where they happened.");
  notes.push("Antigravity records no call ids and no model name: calls and results are paired by order.");
  return { found: f, events: b.events, counts: b.counts, notes };
}
