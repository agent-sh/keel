// OpenCode: one SQLite database, ~/.local/share/opencode/opencode.db (its
// data folder: $XDG_DATA_HOME/opencode). OpenCode 2 keeps a session in
// `session_v2` (directory, title, parent_id for a subagent's, model as JSON
// {providerID, id}, times in ms) and its history in `session_message`, one row
// per item in `seq` order, `data` as JSON by `type`: user ({ text, files }),
// assistant ({ model, content: text, reasoning and tool items; a tool item
// holds its id, name and state: status completed or error, input, content as
// text and file parts, error }), compaction ({ summary }), model-switched
// ({ model }), and the harness's own system, synthetic and idle items. A
// completed compaction can keep the newest messages before it verbatim beside
// its summary: `metadata.keepID` names the first one kept (an older one kept
// their text in `metadata.recent`). A prompt's files hold their bytes (base64)
// or name a row of `blob` by its hash (`uri` "media:<sha256>"), and so can a
// tool's file parts.
// OpenCode 1 kept them in `session`, `message` (role, providerID, modelID; an
// assistant message with `summary` true is a compaction's summary) and `part`
// (text, reasoning, tool with callID, tool and state, file); a database
// migrated to 2 holds both, and a session is read from the newer tables.
// OpenCode 2.3 can keep an assistant message's items in `session_part`
// instead of its content (by ordinal, one row an item).
// Opened read-only; nothing here writes.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_MAX } from "../../engine/attachments.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";

export const opencodeHome = () => process.env.KEEL_IMPORT_OPENCODE_DIR ?? join(process.env.XDG_DATA_HOME?.startsWith("/") ? process.env.XDG_DATA_HOME : join(homedir(), ".local", "share"), "opencode");
export const opencodeDb = () => join(opencodeHome(), "opencode.db");

let open: { path: string; ino: number; db: Database } | null = null;
function db(path = opencodeDb()): Database | null {
  let ino: number;
  try { ino = statSync(path).ino; } catch { return null; }
  if (open?.path === path && open.ino === ino) return open.db;
  open?.db.close();
  open = { path, ino, db: new Database(path, { readonly: true }) };
  return open.db;
}
const has = (d: Database, table: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const json = (s: unknown): any => { if (typeof s !== "string") return s ?? undefined; try { return JSON.parse(s); } catch { return undefined; } };
// OpenCode names a model by its provider and id: Keel's `provider:model`.
const modelName = (m: any): string | undefined => (m && typeof m.id === "string" ? (m.providerID ? `${m.providerID}:${m.id}` : m.id) : undefined);

const PROMPT_CHARS = 2000;

// Rows already read, by session and the time it last changed: a listing reads
// the prompts only of sessions that are new or went on.
const known = new Map<string, { at: number; found: Found | null }>();

// Every session, newest first, with its first and last prompt (their start).
// `budgetMs`: how long this call may spend reading prompts; sessions not
// reached are left for the next call (`opencodePending` says how many), so a
// first listing of a large store never holds the daemon.
export let opencodePending = 0;
export function opencodeSessions(path = opencodeDb(), budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  let pending = 0;
  const d = db(path);
  if (!d) return [];
  const size = statSync(path).size;
  const out: Found[] = [];
  const seen = new Set<string>();
  const add = (r: any, prompts: () => [string | null | undefined, string | null | undefined]) => {
    seen.add(r.id);
    const at = Number(r.time_updated) || 0;
    let k = known.get(`${path}#${r.id}`);
    if (!k || k.at !== at) {
      if (performance.now() > until) { pending++; if (!k) return; }
      else {
        const [first, last] = prompts();
        k = { at, found: first || last ? row(r, first, last) : null }; // none: no conversation in it
        known.set(`${path}#${r.id}`, k);
      }
    }
    if (k.found) out.push({ ...k.found, size_bytes: size });
  };
  const row = (r: any, first?: string | null, last?: string | null): Found => ({
      harness: "opencode", id: r.id, path: `${path}#${r.id}`, cwd: r.directory || undefined,
      title: clip(r.title?.trim() || last || first || r.id, 120),
      first_prompt: first ? clip(first) : undefined, last_prompt: last ? clip(last) : undefined,
      updated_ms: Number(r.time_updated) || 0, size_bytes: size, model: modelName(json(r.model)),
      kind: r.parent_id ? "subagent" : "interactive", parent_id: r.parent_id || undefined,
      archived: !!r.time_archived || undefined,
  });
  if (has(d, "session_v2") && has(d, "session_message")) {
    const prompt = (dir: "ASC" | "DESC") => d.query<{ t: string | null }, [string]>(`SELECT substr(json_extract(data, '$.text'), 1, ${PROMPT_CHARS}) AS t FROM session_message WHERE session_id = ? AND type = 'user' AND trim(coalesce(json_extract(data, '$.text'), '')) != '' ORDER BY seq ${dir} LIMIT 1`);
    const [first, last] = [prompt("ASC"), prompt("DESC")];
    for (const r of d.query<any, []>("SELECT id, parent_id, directory, title, model, time_updated, time_archived FROM session_v2").all()) add(r, () => [first.get(r.id)?.t, last.get(r.id)?.t]);
  }
  if (has(d, "session") && has(d, "message") && has(d, "part")) {
    const prompt = (dir: "ASC" | "DESC") => d.query<{ t: string | null }, [string]>(
      `SELECT substr(json_extract(p.data, '$.text'), 1, ${PROMPT_CHARS}) AS t FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text' AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
       ORDER BY m.time_created ${dir}, p.id ${dir} LIMIT 1`);
    const [first, last] = [prompt("ASC"), prompt("DESC")];
    for (const r of d.query<any, []>("SELECT id, parent_id, directory, title, NULL AS model, time_updated, time_archived FROM session").all()) if (!seen.has(r.id)) add(r, () => [first.get(r.id)?.t, last.get(r.id)?.t]);
  }
  opencodePending = pending;
  for (const key of known.keys()) if (key.startsWith(`${path}#`) && !seen.has(key.slice(path.length + 1))) known.delete(key);
  return out.sort((a, b) => b.updated_ms - a.updated_ms);
}

// The bytes (base64) a `media:<sha256>` reference names in OpenCode's blob table.
type Blobs = (uri: unknown) => string | undefined;
function blobs(d: Database): Blobs {
  const q = has(d, "blob") ? d.query<{ data: Uint8Array }, [string]>("SELECT data FROM blob WHERE hash = ?") : null;
  return (uri) => {
    const hash = typeof uri === "string" ? uri.match(/^media:([0-9a-f]{64})$/)?.[1] : undefined;
    const row = hash && q ? q.get(hash) : null;
    return row ? Buffer.from(row.data).toString("base64") : undefined;
  };
}

// A tool's output parts as a result: text, and an image only when its bytes are here (a data URI or a blob).
function partsOf(parts: any[], blob: Blobs): string | any[] {
  const out: any[] = [];
  for (const p of parts) {
    if (p?.type === "text") out.push({ type: "text", text: String(p.text ?? "") });
    else if (p?.type === "file") {
      const inline = typeof p.uri === "string" ? p.uri.match(/^data:([^;,]+);base64,(.*)$/) : null;
      const [type, data] = inline ? [inline[1]!, inline[2]!] : [String(p.mime ?? ""), blob(p.uri)];
      if (data !== undefined && type.startsWith("image/")) out.push({ type: "image", media_type: type, data });
      else out.push(unavailable(`file ${p.name ?? p.uri ?? ""}`.trim()));
    }
  }
  return out.length === 1 && out[0].type === "text" ? out[0].text : out;
}
// One reply's steps: its calls with their results after them, and the text
// that came after a result as the next step's (OpenCode keeps a reply's steps
// in one item; a parallel set of calls stays one step).
function step(b: Builder, ts: number, model: () => string | undefined) {
  const blocks: any[] = [];
  const results: any[] = [];
  let first = true;
  // Mid-reply (a text item arrived) only after a call; at the reply's end always, with its stop.
  const flush = (end?: { stop?: string }) => {
    if (!end && !results.length) return;
    if (blocks.length) b.assistant(blocks.splice(0), ts, model(), first, results.length ? undefined : end?.stop);
    first = false;
    for (const r of results.splice(0)) b.result(r, ts);
  };
  return { blocks, results, flush };
}
// What the model read of a prompt's files, as OpenCode sends them
// (packages/core/src/session/runner/to-llm-message.ts): an image as an image,
// a text file, a folder's listing and a PDF as a file Keel stores with the
// prompt (`data`: its bytes, stored when the copy is made). Other kinds were
// never sent to OpenCode's model.
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function promptFiles(files: any[], blob: Blobs, skip: (why: string) => void): any[] {
  const out: any[] = [];
  for (const f of files) {
    const mime = String(f?.mime ?? "");
    const data = typeof f?.data === "string" ? f.data : blob(f?.uri);
    if (!IMAGES.has(mime) && mime !== "text/plain" && mime !== "application/x-directory" && mime !== "application/pdf") { skip(`files attached to a prompt of a kind OpenCode does not send to its model (${mime || "no type"})`); continue; }
    if (data === undefined) { skip("files attached to a prompt whose bytes OpenCode no longer holds"); continue; }
    if (IMAGES.has(mime)) { out.push({ type: "image", media_type: mime, data }); continue; }
    const size = Buffer.byteLength(data, "base64");
    if (size > ATTACHMENT_MAX) { skip(`files attached to a prompt over ${ATTACHMENT_MAX / 1024 / 1024} MiB`); continue; }
    const where = f.source?.type === "uri" ? String(f.source.uri).replace(/^file:\/\//, "") : undefined;
    const name = String(f.name || (where ? where.split("/").filter(Boolean).pop() : "") || (mime === "application/x-directory" ? "folder" : "attachment"));
    out.push({ type: "attachment", name, media_type: mime === "application/pdf" ? mime : "text/plain", size, data });
  }
  return out;
}
const failure = (e: any) => (typeof e === "string" ? e : e?.message ? String(e.message) : "The call failed.");

export async function readOpencode(f: Found, path = opencodeDb()): Promise<Read> {
  const d = db(path);
  if (!d) throw new Error("OpenCode's opencode.db was not found");
  const b = new Builder();
  const notes: string[] = [];
  const skipped = new Map<string, number>();
  const skip = (why: string) => { b.counts.skipped++; skipped.set(why, (skipped.get(why) ?? 0) + 1); };
  let model = f.model;
  let compactions = 0;
  const blob = blobs(d);
  const v2 = has(d, "session_v2") && !!d.query("SELECT 1 FROM session_v2 WHERE id = ?").get(f.id);
  if (v2) {
    const rows = d.query<{ id: string; type: string; data: string; time_created: number }, [string]>("SELECT id, type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq").all(f.id);
    // OpenCode can keep an assistant message's items as rows of their own
    // (session_part, by ordinal; its data with the type in a column), the
    // message's content then empty; read as OpenCode's history.ts does: the
    // parts in order, then any content kept inline.
    const parts = has(d, "session_part") ? d.query<{ type: string; data: string }, [string]>("SELECT type, data FROM session_part WHERE message_id = ? ORDER BY ordinal") : null;
    // The first event each message gave: where a compaction's kept messages start.
    const startOf = new Map<string, number>();
    for (const row of rows) {
      startOf.set(row.id, b.events.length);
      const m = json(row.data) ?? {};
      if (row.type === "assistant" && parts) {
        const own = parts.all(row.id).map((p) => ({ ...(json(p.data) ?? {}), type: p.type }));
        if (own.length) m.content = [...own, ...(Array.isArray(m.content) ? m.content : [])];
      }
      const ts = Number(m.time?.created ?? row.time_created) || f.updated_ms;
      switch (row.type) {
        case "user":
          b.user(String(m.text ?? ""), ts, Array.isArray(m.files) ? promptFiles(m.files, blob, skip) : []);
          break;
        case "assistant": {
          model = modelName(m.model) ?? model;
          const { blocks, results, flush } = step(b, ts, () => model);
          for (const it of Array.isArray(m.content) ? m.content : []) {
            if (it?.type === "text") { if (it.text?.trim()) { flush(); blocks.push({ type: "text", text: it.text }); } }
            else if (it?.type === "reasoning") { if (it.text?.trim()) b.counts.thoughts_dropped++; }
            else if (it?.type === "tool" && it.id) {
              const s = it.state ?? {};
              blocks.push({ type: "tool_use", id: it.id, name: String(it.name ?? "tool"), input: s.input ?? {} });
              const content = Array.isArray(s.content) && s.content.length ? partsOf(s.content, blob) : "";
              if (s.status === "error") results.push({ tool_use_id: it.id, content: content || failure(s.error), is_error: true });
              else if (s.status === "completed") results.push({ tool_use_id: it.id, content: content || "Done." });
              else results.push({ tool_use_id: it.id, content: "OpenCode recorded no result for this call.", is_error: true });
            } else if (it?.type) skip(`assistant items of a kind Keel does not import (${it.type})`);
          }
          flush({ stop: m.error && !m.finish ? "interrupted" : undefined });
          break;
        }
        case "compaction": {
          // OpenCode's history starts only at a completed one (history.ts).
          if (m.status !== "completed") { skip(m.status === "failed" ? "compactions that failed" : "a compaction OpenCode had not finished"); break; }
          if (typeof m.summary !== "string" || !m.summary.trim()) { skip("a compaction with no summary"); break; }
          // Its model read the summary, then the messages from keepID on (history.ts withRecentText);
          // without a keepID it finds, the text an older one kept (recent-text.ts).
          const start = typeof m.metadata?.keepID === "string" ? startOf.get(m.metadata.keepID) : undefined;
          const recent = start === undefined && typeof m.metadata?.recent === "string" && m.metadata.recent.trim() ? m.metadata.recent : "";
          const summary = recent ? `${m.summary}\n\n<recent-context>\n${recent}\n</recent-context>` : m.summary;
          const trigger = m.reason === "manual" ? "owner" : m.reason ? "threshold" : undefined;
          // Kept messages with nothing before them: the summary covers no event here, so the model reads it and every message.
          if (start === 0 && b.events.length) b.note(summary, ts, true);
          else b.compacted(summary, ts, { trigger, tail: start === undefined ? 0 : b.events.length - start });
          compactions++;
          break;
        }
        case "model-switched":
          model = modelName(m.model) ?? model;
          break;
        case "synthetic":
          // What OpenCode added for the model (a reminder, a job's end): the model read it.
          if (typeof m.text === "string" && m.text.trim()) b.note(m.text, ts, true);
          break;
        default:
          skip(`OpenCode's own ${row.type} items (its setup and state)`);
      }
    }
  } else {
    const rows = d.query<{ id: string; data: string; time_created: number }, [string]>("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id").all(f.id);
    if (!rows.length) throw Object.assign(new Error(`OpenCode has no session ${f.id}`), { status: 404 });
    const parts = d.query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ? ORDER BY id");
    for (const row of rows) {
      const m = json(row.data) ?? {};
      const ts = Number(m.time?.created ?? row.time_created) || f.updated_ms;
      const ps = parts.all(row.id).map((p) => json(p.data) ?? {});
      if (m.role === "user") {
        const text = ps.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
        const said = ps.filter((p) => p.type === "text" && p.synthetic).map((p) => p.text).join("\n");
        if (said.trim()) b.note(said, ts, true);
        b.user(text, ts);
      } else if (m.role === "assistant") {
        if (m.modelID) model = m.providerID ? `${m.providerID}:${m.modelID}` : m.modelID;
        const text = ps.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        if (m.summary === true) { if (text.trim()) { b.compacted(text, ts); compactions++; } continue; }
        const { blocks, results, flush } = step(b, ts, () => model);
        for (const p of ps) {
          if (p.type === "text" && p.text?.trim()) { flush(); blocks.push({ type: "text", text: p.text }); }
          else if (p.type === "reasoning") { if (p.text?.trim()) b.counts.thoughts_dropped++; }
          else if (p.type === "tool" && p.callID) {
            const s = p.state ?? {};
            blocks.push({ type: "tool_use", id: p.callID, name: String(p.tool ?? "tool"), input: s.input ?? {} });
            if (s.status === "error") results.push({ tool_use_id: p.callID, content: failure(s.error), is_error: true });
            else if (s.status === "completed") results.push({ tool_use_id: p.callID, content: typeof s.output === "string" && s.output ? s.output : "Done." });
            else results.push({ tool_use_id: p.callID, content: "OpenCode recorded no result for this call.", is_error: true });
          } else if (!["step-start", "step-finish", "snapshot", "patch", "compaction"].includes(p.type)) skip(`parts of a kind Keel does not import (${p.type ?? "untyped"})`);
        }
        flush({ stop: m.error && !m.finish ? "interrupted" : undefined });
      }
    }
  }
  if (compactions) notes.push(`OpenCode compacted this conversation ${compactions === 1 ? "once" : `${compactions} times`}: all of it is here, and the model reads from the last summary on, with the messages OpenCode kept beside it, as it did there.`);
  const n = b.counts.thoughts_dropped;
  if (n) notes.push(`${n} reasoning item${n === 1 ? " is" : "s are"} not carried: ${n === 1 ? "it belongs" : "they belong"} to the model that wrote ${n === 1 ? "it" : "them"}.`);
  notes.push("OpenCode's tool names are kept as it called them (history, not a re-run).");
  for (const [why, n] of skipped) notes.push(`${n} skipped: ${why}.`);
  return { found: { ...f, model }, events: b.events, counts: b.counts, notes };
}
