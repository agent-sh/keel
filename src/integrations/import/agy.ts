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
// SYSTEM_MESSAGE (the harness's own). A reply names its model (`model`), a
// failed step carries its words in `error` (and a command its `exit_code`),
// a step recorded while it still ran has the status RUNNING and is no failure,
// and a prompt's media are `{ mime_type, uri }`: the file is read from the
// conversation's own upload folder when it is there. A
// conversation kept as binary steps only has no transcript and is not listed.
// Nothing here writes.
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { damageNotes, headTail, readLines } from "./files.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";
import { STORE } from "../../providers/image-limits.ts";
import { ownerHome } from "../../core/paths";

export const agyHome = () => process.env.KEEL_IMPORT_AGY_DIR ?? join(ownerHome(), ".gemini");
export const STORES = ["antigravity-cli", "antigravity", "antigravity-acp"] as const;
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
  const both = [...head, ...tail];
  const all = both.filter((r) => r.type === "USER_INPUT" && typeof r.content === "string").map((r) => requestText(r.content)).filter(Boolean);
  // The newest reply's model: the tail is read after the head.
  const model = tail.findLast((r) => r.type === "PLANNER_RESPONSE" && typeof r.model === "string" && r.model)?.model ?? head.findLast((r) => r.type === "PLANNER_RESPONSE" && typeof r.model === "string" && r.model)?.model;
  return { first: all[0], last: all[all.length - 1], model: model as string | undefined };
}

function found(store: string, id: string, row: Listed): Found | null {
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
    ...(p.model ? { model: p.model } : {}),
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
      // (A store being written or of another shape: skipped this round.)
      const rows = [...(agyListed(store) ?? new Map<string, Listed>())].sort((a, b) => (b[1].listed_ms ?? 0) - (a[1].listed_ms ?? 0));
      for (const [id, r] of rows) add(found(store, id, r));
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

// The store and the conversation a transcript's path names (transcriptOf).
export function agyPlace(path: string): { store: string; id: string } | undefined {
  if (basename(path) !== "transcript_full.jsonl") return undefined;
  const conv = dirname(dirname(dirname(path)));
  const brain = dirname(conv);
  if (basename(brain) !== "brain" || join(conv, TRANSCRIPT) !== path) return undefined;
  return { store: dirname(brain), id: basename(conv) };
}

type Listed = { title?: string; preview?: string; listed_ms?: number; cwd?: string; parent?: string; status?: string };
const LISTED = "SELECT conversation_id AS id, title, preview, last_modified_time AS t, workspace_uris AS uris, parent_conversation_id AS parent FROM conversation_summaries";

// What a store lists of its conversations, by id: the list's rows (with the run status Antigravity keeps on each,
// CASCADE_RUN_STATUS_IDLE, _RUNNING, _BUSY, _CANCELING, where the list has it), or null when the store keeps no list
// (the ACP store) or the list could not be read now (being written: asked again later).
export function agyListed(store: string, ids?: string[]): Map<string, Listed> | null {
  const list = join(store, "conversation_summaries.db");
  if (!existsSync(list)) return null;
  let db: Database | undefined;
  try {
    db = new Database(list, { readonly: true });
    // (A whole list waits for a writer as the Imports page did; a lookup of the live watcher waits less.)
    db.exec(`PRAGMA busy_timeout = ${ids ? 200 : 2000}`);
    const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(conversation_summaries)").all().map((c) => c.name));
    // (One text for any number of ids: the ids go as one JSON value.)
    const sql = `${LISTED.replace(" FROM", `${cols.has("status") ? ", status" : ""} FROM`)}${ids ? " WHERE conversation_id IN (SELECT value FROM json_each(?))" : ""}`;
    const rows = db.query<{ id: string; title: string; preview: string; t: string; uris: string; parent: string | null; status?: string }, string[]>(sql).all(...(ids ? [JSON.stringify(ids)] : []));
    return new Map(rows.map((r) => [r.id, { title: r.title, preview: r.preview, listed_ms: timeMs(r.t), cwd: fileUri(r.uris), parent: r.parent ?? undefined, ...(typeof r.status === "string" && r.status ? { status: r.status } : {}) }]));
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// A conversation by its transcript's path, as the list names it. Null for a path that is no transcript, or a
// conversation the store's list does not hold yet (its row comes after its first steps: looked at again later).
export function agyFoundAt(path: string): Found | null {
  const at = agyPlace(path);
  if (!at) return null;
  if (existsSync(join(at.store, "conversation_summaries.db"))) {
    const row = agyListed(at.store, [at.id])?.get(at.id);
    return row ? found(at.store, at.id, row) : null;
  }
  let cwd: string | undefined;
  try { cwd = JSON.parse(readFileSync(join(at.store, "conversations", `${at.id}.meta`), "utf8")).cwd || undefined; } catch {}
  return found(at.store, at.id, { cwd });
}

// A prompt's media: bytes the record holds, else the file its `uri` names (kept in the conversation's own
// `.user_uploaded` folder, found by its name: the uri names the machine that wrote it), else named as unavailable.
function mediaOf(m: any, transcript: string): any[] {
  const mime = m?.mimeType ?? m?.mime_type;
  const data = m?.data ?? m?.inlineData;
  if (typeof mime !== "string") return [];
  const image = mime.startsWith("image/") && STORE.formats.includes(mime);
  if (typeof data === "string") return image ? [{ type: "image", source: { type: "base64", media_type: mime, data } }] : [unavailable(`${mime} attachment`)];
  const name = typeof m?.uri === "string" ? basename(m.uri) : "";
  if (!image || !name) return [unavailable(`${mime} attachment${name ? ` ${name}` : ""}`)];
  const brain = dirname(dirname(dirname(transcript)));
  try {
    const bytes = readFileSync(join(brain, ".user_uploaded", name));
    const base64 = bytes.toString("base64");
    if (base64.length <= (STORE.base64 ?? Infinity)) return [{ type: "image", source: { type: "base64", media_type: mime, data: base64 } }];
  } catch {}
  return [unavailable(`${mime} attachment ${name}`)];
}

// A step's failure words: its own `error`, with what it printed after.
const failureOf = (r: any, content: string) => [typeof r.error === "string" ? r.error : "", content].filter((x) => x.trim()).join("\n");

// Antigravity's steps as Keel's events, as they are read from the transcript (the import reads the whole file, the
// watcher of live sessions what it gained: src/integrations/outside/service.ts). Steps are numbered, and the
// numbering is the order: a parallel call's results can be written before the step that made the calls. A step
// written again under a number it already used is a rewind (the owner went back to an earlier step there): it and
// every step after it are replaced. `push` keeps a step; `settle` converts the steps kept, in their order. A step
// that comes, after a settle, under a number already converted (a rewind, a step written late) sets `rewound`: the
// conversion is made again from the file's start.
export class AgyConvert {
  b = new Builder();
  rewound = false;
  compacted = false;
  models = new Set<string>();
  private kept = new Map<number, { r: any; ts: number }>();
  private done = new Set<number>();
  private next = 0;
  private lines = 0;
  // Calls get their results in the order they were made; ids are ours.
  private waiting: string[] = [];
  constructor(private path: string) {}

  push(r: any, fallbackTs: number) {
    if (!r || typeof r !== "object") return;
    const k = Number.isInteger(r.step_index) ? r.step_index : this.lines;
    this.lines++;
    if (k < this.next || this.done.has(k)) { this.rewound = true; return; }
    if (this.kept.has(k)) for (const n of [...this.kept.keys()]) if (n >= k) this.kept.delete(n);
    this.kept.set(k, { r, ts: timeMs(r.created_at) || fallbackTs });
  }

  settle() {
    const steps = [...this.kept.entries()].sort((a, b) => a[0] - b[0]);
    this.kept.clear();
    for (const [k, { r, ts }] of steps) {
      this.step(r, ts);
      this.done.add(k);
      this.next = Math.max(this.next, k + 1);
    }
  }

  // A call left without a result when the conversation moves on gets one, so the history stays well formed for the
  // next model.
  close(ts: number) {
    for (const id of this.waiting.splice(0)) this.b.result({ tool_use_id: id, content: "No result was recorded for this call.", is_error: true }, ts);
  }

  private step(r: any, ts: number) {
    const b = this.b;
    const content = typeof r.content === "string" ? r.content : "";
    switch (r.type) {
      case "USER_INPUT": {
        this.close(ts);
        const images = (Array.isArray(r.media) ? r.media : []).flatMap((m: any) => mediaOf(m, this.path));
        // Never marked typed: a prompt typed in the IDE or the command line and one a script passed with `agy -p`
        // are the same step (USER_EXPLICIT, the request in USER_REQUEST), and nothing the store records tells them
        // apart. Until it records how a prompt was entered, a copy's prompts stay outside content.
        b.user(requestText(content), ts, images);
        break;
      }
      case "PLANNER_RESPONSE": {
        this.close(ts);
        if (typeof r.thinking === "string" && r.thinking.trim()) b.counts.thoughts_dropped++;
        const blocks: any[] = content.trim() ? [{ type: "text", text: content }] : [];
        (Array.isArray(r.tool_calls) ? r.tool_calls : []).forEach((c: any, i: number) => {
          if (!c?.name) return;
          const id = `agy${r.step_index ?? 0}_${i}`;
          this.waiting.push(id);
          blocks.push({ type: "tool_use", id, name: String(c.name), input: c.args && typeof c.args === "object" ? c.args : {} });
        });
        if (!blocks.length && typeof r.error === "string" && r.error.trim()) { b.note(`Antigravity's model request failed here: ${clip(r.error, 300)}`, ts); break; }
        b.assistant(blocks, ts, typeof r.model === "string" && r.model ? r.model : undefined, true);
        if (typeof r.model === "string" && r.model) this.models.add(r.model);
        break;
      }
      case "SYSTEM_MESSAGE":
        b.counts.skipped++; // the harness's own
        break;
      case "CHECKPOINT":
        if (content.trim()) { b.note(`Antigravity compacted the conversation here. Its summary:\n${content}`, ts, true); this.compacted = true; }
        break;
      default: {
        // Any other step answers the oldest waiting call; an error with no call waiting is skipped.
        const id = this.waiting.shift();
        // A failure: an error step, a step that says ERROR (its own words in `error`) or a command that exited with a code.
        // RUNNING is a step recorded while it ran, not a failure.
        const failed = r.type === "ERROR_MESSAGE" || r.status === "ERROR" || (r.type === "RUN_COMMAND" && Number.isInteger(r.exit_code) && r.exit_code !== 0);
        const text = failed ? failureOf(r, resultOf(content)) : resultOf(content);
        if (id) b.result({ tool_use_id: id, content: failed && r.type === "RUN_COMMAND" && Number.isInteger(r.exit_code) && r.exit_code !== 0 ? `${text}\n[exit code ${r.exit_code}]`.trim() : text, is_error: failed }, ts);
        else b.counts.skipped++;
      }
    }
  }
}

export async function readAgy(f: Found): Promise<Read> {
  const notes: string[] = [];
  const st = statSync(f.path);
  const c = new AgyConvert(f.path);
  const lines = readLines(await Bun.file(f.path).text());
  for (const r of lines.records) c.push(r, st.mtimeMs);
  c.settle();
  c.close(st.mtimeMs);
  const b = c.b;
  notes.push(...damageNotes(lines));
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning step${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (c.compacted) notes.push("Antigravity's compaction summaries are kept as notes where they happened.");
  if (c.models.size > 1) notes.push(`The conversation used ${[...c.models].join(", ")}.`);
  notes.push("Antigravity records no call ids: calls and results are paired by order.");
  return { found: f, events: b.events, counts: b.counts, notes };
}
