// Cursor Agent (the `cursor-agent` CLI): its data folder is $CURSOR_DATA_DIR, else ~/.cursor.
// Two places hold a session:
//
//  - chats/<md5 of the workspace path>/<agent id>/store.db: a SQLite database (write-ahead log
//    mode) of two tables. `meta` holds one row, key "0", the hex of a JSON object (agentId,
//    latestRootBlobId, name, mode, createdAt, lastUsedModel and, for a subagent, subagentInfo:
//    parentAgentId, rootParentAgentId, toolCallId, typeName). `blobs` (id, data) is a content
//    addressed store (the id is the hex of a SHA-256). The root blob (latestRootBlobId) is a
//    protobuf (ConversationStateStructure): field 1 repeats the blob ids of the messages in
//    order (rootPromptMessagesJson), 9 the workspace URIs (file://), 13 the blob ids of summary
//    archives (a blob holding protobuf: 1 the ids of the messages the summary replaced, 2 the
//    summary text), 26 the start time in ms. A message blob is JSON in the AI SDK shape: role
//    system, user (a string, or parts), assistant (text, reasoning, redacted-reasoning,
//    tool-call with toolCallId, toolName, args) and tool (tool-result with toolCallId, result,
//    experimental_content; providerOptions.cursor.highLevelToolCallResult.isError). This holds
//    the whole conversation with every tool result, so it is what is read when it exists.
//  - projects/<workspace path with every run of other characters as "-">/agent-transcripts/
//    <id>/<id>.jsonl (a subagent's: <id>/subagents/<sid>.jsonl): lines of {role, message:
//    {content: [text and tool_use parts]}} and {type: "turn_ended", status, error}. It keeps the
//    words and the calls but no call id and no tool result, and it is the only record of a
//    session whose database is gone. A user's words are wrapped in <user_query>, after a
//    <timestamp> line.
//
// Source: the installed program's own bundle (cursor-agent 2026.10.01: the agent store, the
// transcript writer, the path rules and the conversation state's field table) and the files of a
// real store, read for their shapes only (2026-11-21). Nothing here writes.
import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OWNER_MEDIA_BYTES } from "../../engine/compact.ts";
import { fitImage, imageKey } from "../../engine/image-fit.ts";
import { STORE } from "../../providers/image-limits.ts";
import { ownerEnv, ownerHome } from "../../core/paths";
import { damageNotes, headTail, readLines } from "./files.ts";
import type { SideStore } from "./more.ts";
import { Builder, clip, resultText, unavailable, type Found, type Read } from "./types.ts";

export const cursorHome = () => process.env.KEEL_IMPORT_CURSOR_DIR ?? (ownerEnv("CURSOR_DATA_DIR")?.trim() || join(ownerHome(), ".cursor"));

// How long one listing may read for (a first listing of a large store never holds the loop).
const BUDGET_MS = 40;
const TAIL = 64 * 1024;
const DEFAULT_NAMES = new Set(["", "new agent", "untitled"]);

type Row = { id: string; path: string; mtime: number; size: number; kind: "store" | "transcript"; parent?: string; slug?: string };
const known = new Map<string, { size: number; mtime: number; found: Found | null }>();
let left = 0;

const json = (s: unknown): any => { try { return JSON.parse(String(s)); } catch { return undefined; } };
const dirs = (p: string) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const stat = (p: string) => { try { return statSync(p); } catch { return null; } };

// ---- the database ----

type Proto = Map<number, (Buffer | number)[]>;
// The fields of one protobuf message: a length-delimited field as bytes, a varint as a number
// (no other wire type is in the state; one that cannot be read ends the message).
function proto(b: Uint8Array): Proto {
  const out: Proto = new Map();
  let i = 0;
  const varint = () => { let v = 0, s = 0; for (;;) { const c = b[i++]; if (c === undefined) throw new Error("cut"); v += (c & 127) * 2 ** s; if (!(c & 128)) return v; s += 7; } };
  try {
    while (i < b.length) {
      const tag = varint(), f = Math.floor(tag / 8), w = tag & 7;
      const add = (v: Buffer | number) => { const l = out.get(f); if (l) l.push(v); else out.set(f, [v]); };
      if (w === 0) add(varint());
      else if (w === 2) { const n = varint(); if (i + n > b.length) break; add(Buffer.from(b.subarray(i, i + n))); i += n; }
      else if (w === 1) i += 8;
      else if (w === 5) i += 4;
      else break;
    }
  } catch {}
  return out;
}
const bytes = (p: Proto, f: number) => (p.get(f) ?? []).filter((v): v is Buffer => Buffer.isBuffer(v));
const hexIds = (p: Proto, f: number) => bytes(p, f).filter((b) => b.length === 32).map((b) => b.toString("hex"));

type Meta = { agentId?: string; latestRootBlobId?: string; name?: string; createdAt?: number; lastUsedModel?: string; subagentInfo?: { parentAgentId?: string } };
function metaOf(d: Database): Meta | undefined {
  const row = d.query("SELECT value FROM meta WHERE key = '0'").get() as { value: string } | null;
  if (!row) return undefined;
  return json(/^[0-9a-f]+$/i.test(row.value) ? Buffer.from(row.value, "hex").toString("utf8") : row.value);
}
const blob = (d: Database, id: string): Buffer | undefined => {
  const r = d.query("SELECT data FROM blobs WHERE id = ?").get(id) as { data: Uint8Array } | null;
  return r ? Buffer.from(r.data) : undefined;
};
const message = (d: Database, id: string): any => { const b = blob(d, id); return b && b[0] === 0x7b ? json(b.toString("utf8")) : undefined; };
// Its role from the first bytes of a blob, so a listing reads no tool result to find a prompt.
const roleOf = (d: Database, id: string): string | undefined => {
  const r = d.query("SELECT substr(data, 1, 24) AS h FROM blobs WHERE id = ?").get(id) as { h: Uint8Array } | null;
  return r ? /^\{"role":"([a-z]+)"/.exec(Buffer.from(r.h).toString("latin1"))?.[1] : undefined;
};
const fileOf = (uri: Buffer | undefined): string | undefined => {
  const s = uri?.toString("utf8");
  if (!s?.startsWith("file://")) return undefined;
  try { return decodeURIComponent(s.slice(7)); } catch { return s.slice(7); }
};

// A user's message holds the words in <user_query>, a <timestamp> before them, and sometimes
// context Cursor added (open files, rules); the first message of a session is all context.
const QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/g;
const STAMP = /<timestamp>([^<]*)<\/timestamp>/;
const CONTEXT = /^\s*<(?:user_info|git_status|agent_transcripts|rules|system_reminder|open_and_recently_viewed_files)>/;
// "Tuesday, Aug 18, 2026, 4:02 AM (UTC+3)" as a time.
function stampMs(s: string | undefined): number | undefined {
  const m = s && /^\s*(?:[A-Za-z]+,\s*)?([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)\s*(?:\(UTC([+-])(\d{1,2})(?::?(\d{2}))?\))?/i.exec(s);
  if (!m) return undefined;
  const day = Date.parse(`${m[1]} UTC`);
  if (!Number.isFinite(day)) return undefined;
  const hour = (Number(m[2]) % 12) + (m[4]!.toUpperCase() === "PM" ? 12 : 0);
  const off = m[5] ? (m[5] === "-" ? -1 : 1) * (Number(m[6]) * 60 + Number(m[7] ?? 0)) : 0;
  return day + (hour * 60 + Number(m[3]) - off) * 60_000;
}
function promptOf(texts: string[]): { text: string; ts?: number; context: boolean; dropped: boolean } {
  const all = texts.join("\n");
  const ts = stampMs(STAMP.exec(all)?.[1]);
  const asked = [...all.matchAll(QUERY)].map((m) => m[1]!).filter(Boolean);
  if (asked.length) return { text: asked.join("\n\n"), ts, context: false, dropped: all.replace(QUERY, "").replace(STAMP, "").trim() !== "" };
  if (CONTEXT.test(all)) return { text: "", context: true, dropped: false };
  return { text: all.replace(STAMP, "").trim(), ts, context: false, dropped: false };
}
const partsText = (c: unknown): string[] => (typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text) : []);

const promptsIn = (d: Database, ids: string[], from: "start" | "end"): string | undefined => {
  for (let k = 0; k < ids.length; k++) {
    const id = ids[from === "start" ? k : ids.length - 1 - k]!;
    if (roleOf(d, id) !== "user") continue;
    const p = promptOf(partsText(message(d, id)?.content));
    if (p.text) return p.text;
  }
  return undefined;
};

function storeFound(r: Row): Found | null {
  const d = new Database(r.path, { readonly: true });
  try {
    const meta = metaOf(d);
    if (!meta?.latestRootBlobId) return null;
    const rootBytes = blob(d, meta.latestRootBlobId);
    const root = rootBytes ? proto(rootBytes) : new Map();
    const ids = hexIds(root, 1);
    const first = promptsIn(d, ids, "start");
    if (!first) return null; // no prompt in it: no conversation
    const last = promptsIn(d, ids, "end") ?? first;
    const name = (meta.name ?? "").trim();
    const parent = meta.subagentInfo?.parentAgentId;
    return {
      harness: "cursor", id: meta.agentId ?? r.id, path: r.path, cwd: fileOf(bytes(root, 9)[0]),
      title: clip(DEFAULT_NAMES.has(name.toLowerCase()) ? first : name, 120),
      first_prompt: clip(first), last_prompt: clip(last),
      updated_ms: Math.round(r.mtime), size_bytes: r.size,
      ...(meta.lastUsedModel ? { model: meta.lastUsedModel } : {}),
      kind: meta.subagentInfo ? "subagent" : "interactive", ...(parent ? { parent_id: parent } : {}),
    };
  } finally { d.close(); }
}

// ---- the transcripts ----

type Line = { role?: string; message?: { content?: unknown }; type?: string; status?: string; error?: string };
// The folder a project's slug stands for: the one existing folder whose name, with every run of other
// characters as "-", spells it (the slug loses the slashes, so it is looked for, never decoded).
const folders = new Map<string, string | undefined>();
const slugOf = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
function folderOf(slug: string): string | undefined {
  if (folders.has(slug)) return folders.get(slug);
  const walk = (dir: string, rest: string, depth: number): string | undefined => {
    if (!rest) return dir;
    if (depth > 14) return undefined;
    for (const n of dirs(dir)) {
      const s = slugOf(n);
      if (s && (rest === s || rest.startsWith(s + "-"))) {
        const hit = walk(join(dir, n), rest === s ? "" : rest.slice(s.length + 1), depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  const hit = walk("/", slug, 0);
  // (Only a hit is kept: a folder made later is found by a later listing.)
  if (hit) folders.set(slug, hit);
  return hit;
}

function transcriptFound(r: Row): Found | null {
  const { head, tail } = headTail(r.path, TAIL);
  const asks = (l: Line[]) => l.filter((x) => x.role === "user").map((x) => promptOf(partsText(x.message?.content)).text).filter(Boolean);
  const first = asks(head)[0];
  if (!first) return null;
  const last = asks(tail).at(-1) ?? first;
  return {
    harness: "cursor", id: r.id, path: r.path, cwd: r.slug ? folderOf(r.slug) : undefined,
    title: clip(first, 120), first_prompt: clip(first), last_prompt: clip(last),
    updated_ms: Math.round(r.mtime), size_bytes: r.size,
    kind: r.parent ? "subagent" : "interactive", ...(r.parent ? { parent_id: r.parent } : {}),
  };
}

// ---- the listing ----

function rows(home: string): Row[] {
  const out: Row[] = [];
  const stores = new Set<string>();
  for (const h of dirs(join(home, "chats"))) for (const id of dirs(join(home, "chats", h))) {
    const path = join(home, "chats", h, id, "store.db");
    const s = stat(path);
    if (!s) continue;
    // The write-ahead log holds what the database does not yet: its time and size count.
    const w = stat(path + "-wal");
    stores.add(id);
    out.push({ id, path, kind: "store", mtime: Math.max(s.mtimeMs, w?.mtimeMs ?? 0), size: s.size + (w?.size ?? 0) });
  }
  const projects = join(home, "projects");
  for (const slug of dirs(projects)) {
    const base = join(projects, slug, "agent-transcripts");
    for (const id of dirs(base)) {
      const add = (path: string, sid: string, parent?: string) => {
        const s = stat(path);
        // A session with a database is read from it, which keeps what a transcript does not.
        if (s?.isFile() && !stores.has(sid)) out.push({ id: sid, path, kind: "transcript", mtime: s.mtimeMs, size: s.size, parent, slug });
      };
      add(join(base, id, `${id}.jsonl`), id);
      try { for (const f of readdirSync(join(base, id, "subagents"))) if (f.endsWith(".jsonl")) add(join(base, id, "subagents", f), f.slice(0, -6), id); } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function list(): Found[] {
  const until = performance.now() + BUDGET_MS;
  const home = cursorHome();
  const all = rows(home);
  const out: Found[] = [];
  let pending = 0;
  for (const r of all) {
    const k = known.get(r.path);
    let found: Found | null;
    const mtime = Math.round(r.mtime);
    if (k && k.size === r.size && k.mtime === mtime) found = k.found;
    else if (performance.now() > until) { pending++; found = k?.found ?? null; }
    else {
      found = null;
      try { found = r.kind === "store" ? storeFound(r) : transcriptFound(r); } catch {}
      known.set(r.path, { size: r.size, mtime, found });
    }
    if (found) out.push(found);
  }
  left = pending;
  const listed = new Set(all.map((r) => r.path));
  for (const p of known.keys()) if (p.startsWith(home) && !listed.has(p)) known.delete(p);
  return out.sort((a, b) => b.updated_ms - a.updated_ms);
}

// ---- reading ----

// An image as Cursor keeps it: base64 in `image` or `data` (or a data URL), its type beside it.
type Pending = { type: "image"; media_type: string; data: string; fit: true };
function imageOf(p: any): Pending | undefined {
  const url = typeof p.image === "string" ? /^data:([^;,]+);base64,(.*)$/.exec(p.image) : null;
  const data = url ? url[2]! : typeof p.image === "string" ? p.image : typeof p.data === "string" ? p.data : undefined;
  const media_type = String(url?.[1] ?? p.mediaType ?? p.mimeType ?? p.mime_type ?? "");
  return data && /^image\//.test(media_type) && !/^https?:/.test(data) ? { type: "image", media_type, data, fit: true } : undefined;
}
// Every image of the copy within what Keel stores (STORE: one over it is scaled down, one that cannot
// be is left out and named), newest first within what one copy carries (OWNER_MEDIA_BYTES).
async function fitMedia(events: { kind: string; data: any }[], skip: (why: string) => void, counts: { media: number }) {
  const done = new Map<string, any>();
  let total = 0, full = false;
  const one = async (p: Pending): Promise<any> => {
    const drop = (why: string, line: string) => { skip(why); counts.media--; return unavailable(line); };
    if (full) return drop(`images past ${OWNER_MEDIA_BYTES / 1024 / 1024} MB of images in one copy (the newest are kept)`, "an older image, past what one copy carries");
    const key = imageKey(p.data);
    let f = done.get(key);
    if (!f) {
      const r = await fitImage({ type: "image", media_type: p.media_type, data: p.data }, STORE);
      done.set(key, (f = "refused" in r ? { refused: r.refused } : r.block));
    }
    if ("refused" in f) return drop(`images Keel could not fit to its image limits (${f.refused})`, `an image: ${f.refused}`);
    if (total + f.data.length > OWNER_MEDIA_BYTES) { full = true; return one(p); }
    total += f.data.length;
    return f;
  };
  const fix = async (l: any[]) => { for (let j = l.length - 1; j >= 0; j--) if (l[j]?.fit) l[j] = await one(l[j]); };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "user" && Array.isArray(e.data.images)) await fix(e.data.images);
    else if (e.kind === "tool_result") for (const r of e.data.results) if (Array.isArray(r.content)) await fix(r.content);
  }
}

// A tool message's result: its text and images, failed when Cursor says so.
function resultOf(c: any, msgErr: boolean | undefined, only: boolean): { content: any; is_error?: boolean } {
  const parts: any[] = [];
  for (const p of Array.isArray(c.experimental_content) ? c.experimental_content : []) {
    if (p?.type === "text") parts.push({ type: "text", text: String(p.text ?? "") });
    else if (p?.type === "image") parts.push(imageOf(p) ?? unavailable("image"));
    else if (p?.type) parts.push(unavailable(`${p.type} content`));
  }
  const content = parts.length ? (parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts) : resultText(c.result);
  const own = c.result && typeof c.result === "object" && "error" in c.result ? true : undefined;
  return { content, is_error: (typeof c.isError === "boolean" ? c.isError : own ?? (only ? msgErr : undefined)) || undefined };
}

const NO_RESULT = "the session holds no result for this call";

async function readStore(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const d = new Database(f.path, { readonly: true });
  const skips = new Map<string, number>();
  const skip = (why: string) => { b.counts.skipped++; skips.set(why, (skips.get(why) ?? 0) + 1); };
  const models = new Set<string>();
  try {
    const meta = metaOf(d);
    const rootBytes = meta?.latestRootBlobId ? blob(d, meta.latestRootBlobId) : undefined;
    if (!rootBytes) throw new Error("the session's root record is missing");
    const root = proto(rootBytes);
    const rootIds = hexIds(root, 1);
    let clock = Number(root.get(26)?.[0]) || Number(meta?.createdAt) || statSync(f.path).mtimeMs;
    let n = 0;
    const at = () => clock + n++;
    // Calls no result answered (a session cut short): named, never given a result.
    const waiting: string[] = [];
    const answerAll = () => { for (const id of waiting.splice(0)) b.result({ tool_use_id: id, content: unavailable(NO_RESULT), is_error: true }, at()); };
    let damaged = 0, missing = 0, droppedContext = false;

    const take = (id: string) => {
      const row = blob(d, id);
      if (!row) { missing++; return; }
      if (row[0] !== 0x7b) { skip("records that are not messages"); return; }
      const m = json(row.toString("utf8"));
      if (!m || typeof m !== "object") { damaged++; return; }
      if (m.role === "system") { skip("Cursor's own system prompt"); return; }
      if (m.role === "user") {
        answerAll();
        const p = promptOf(partsText(m.content));
        if (p.context) { skip("Cursor's own context message (environment, git status, rules)"); return; }
        if (p.dropped) droppedContext = true;
        if (p.ts) { clock = p.ts; n = 0; }
        const images: any[] = [];
        if (Array.isArray(m.content)) for (const part of m.content) {
          if (part?.type === "image") images.push(imageOf(part) ?? unavailable("image"));
          else if (part?.type === "file") images.push(unavailable(`file ${part.filename ?? ""}`.trim()));
        }
        b.user(p.text, at(), images);
        return;
      }
      if (m.role === "assistant") {
        answerAll();
        const blocks: any[] = [];
        let model: string | undefined;
        for (const part of Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []) {
          if (part?.type === "text" && String(part.text ?? "").trim()) blocks.push({ type: "text", text: part.text });
          else if (part?.type === "reasoning" || part?.type === "redacted-reasoning") {
            b.counts.thoughts_dropped++;
            const name = part.providerOptions?.cursor?.modelName;
            if (typeof name === "string" && name) model = name;
          } else if (part?.type === "tool-call" && typeof part.toolName === "string") {
            const cid = typeof part.toolCallId === "string" && part.toolCallId ? part.toolCallId : `cursor_${n}_${blocks.length}`;
            waiting.push(cid);
            blocks.push({ type: "tool_use", id: cid, name: part.toolName, input: part.args && typeof part.args === "object" ? part.args : {} });
          } else if (part?.type === "image") blocks.push(unavailable("an image the model wrote"));
        }
        if (model) models.add(model);
        b.assistant(blocks, at(), model ?? meta?.lastUsedModel, true);
        return;
      }
      if (m.role === "tool") {
        const cur = m.providerOptions?.cursor?.highLevelToolCallResult;
        const err = typeof cur?.isError === "boolean" ? cur.isError : undefined;
        const results = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c?.type === "tool-result");
        for (const c of results) {
          const w = waiting.indexOf(c.toolCallId);
          if (w < 0) { skip("tool results with no call before them"); continue; }
          waiting.splice(w, 1);
          b.result({ tool_use_id: c.toolCallId, ...resultOf(c, err, results.length === 1) }, at());
        }
        return;
      }
      skip(`messages of role ${String(m.role)}`);
    };

    // A summary Cursor made: the messages it replaced come first, then the summary, then the rest.
    const archives = hexIds(root, 13).flatMap((id) => { const a = blob(d, id); return a ? [proto(a)] : []; });
    const seen = new Set<string>();
    const summaries: string[] = [];
    for (const a of archives) {
      for (const id of hexIds(a, 1)) if (!seen.has(id)) { seen.add(id); try { take(id); } catch { damaged++; } }
      const text = bytes(a, 2)[0]?.toString("utf8").trim();
      if (text) { answerAll(); b.compacted(text, at()); summaries.push(text); }
    }
    for (const id of rootIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      // The summary as a message of the conversation is the compaction already.
      const m = summaries.length && roleOf(d, id) === "user" ? message(d, id) : undefined;
      if (m && summaries.some((s) => partsText(m.content).join("\n").includes(s.slice(0, 200)))) continue;
      try { take(id); } catch { damaged++; }
    }
    answerAll();
    if (damaged) notes.push(`${damaged} record${damaged === 1 ? "" : "s"} of the session could not be read and ${damaged === 1 ? "is" : "are"} left out.`);
    if (missing) notes.push(`${missing} message${missing === 1 ? " is" : "s are"} named by the session but not in its database and left out.`);
    if (droppedContext) notes.push("Context Cursor added beside a prompt (files, rules, git status) is left out; the prompt is what was typed.");
    if (summaries.length) notes.push(`Cursor summarized the conversation ${summaries.length} time${summaries.length === 1 ? "" : "s"}; each summary is carried where it was made, with the messages before it.`);
  } finally { d.close(); }
  await fitMedia(b.events, skip, b.counts);
  return finish(f, b, notes, skips, models);
}

function finish(f: Found, b: Builder, notes: string[], skips: Map<string, number>, models: Set<string>): Read {
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thought${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: Cursor keeps them encrypted, and another model's thinking is not sent to this one.`);
  for (const [why, n] of skips) notes.push(`${n} skipped: ${why}.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: models.size === 1 && !f.model ? { ...f, model: [...models][0] } : f, events: b.events, counts: b.counts, notes };
}

async function readTranscript(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const lines = readLines(await Bun.file(f.path).text());
  const skips = new Map<string, number>();
  const skip = (why: string) => { b.counts.skipped++; skips.set(why, (skips.get(why) ?? 0) + 1); };
  const st = statSync(f.path);
  let n = 0, clock = st.birthtimeMs || st.mtimeMs, failed = 0, calls = 0, dropped = false;
  const waiting: string[] = [];
  const answerAll = () => { for (const id of waiting.splice(0)) b.result({ tool_use_id: id, content: unavailable("Cursor's transcript does not keep tool results") }, clock + n++); };
  for (const l of lines.records as Line[]) {
    if (l.type === "turn_ended") { if (l.status === "error") failed++; continue; }
    const parts = Array.isArray(l.message?.content) ? (l.message!.content as any[]) : typeof l.message?.content === "string" ? [{ type: "text", text: l.message.content }] : [];
    if (l.role === "user") {
      answerAll();
      const p = promptOf(partsText(parts));
      if (p.context) { skip("Cursor's own context message (environment, git status, rules)"); continue; }
      if (p.dropped) dropped = true;
      if (p.ts) { clock = p.ts; n = 0; }
      b.user(p.text, clock + n++);
    } else if (l.role === "assistant") {
      answerAll();
      const blocks: any[] = [];
      for (const part of parts) {
        if (part?.type === "text" && String(part.text ?? "").trim()) blocks.push({ type: "text", text: part.text });
        else if (part?.type === "tool_use" && typeof part.name === "string") {
          const id = `cursor_${f.id.slice(0, 8)}_${calls++}`;
          waiting.push(id);
          blocks.push({ type: "tool_use", id, name: part.name, input: part.input && typeof part.input === "object" ? part.input : {} });
        }
      }
      b.assistant(blocks, clock + n++, undefined, true);
    } else skip("lines that are not messages");
  }
  answerAll();
  notes.push(...damageNotes(lines));
  notes.push("This session is read from Cursor's transcript, which keeps the words and the tool calls but no tool results, so each call's result is named as not kept.");
  if (dropped) notes.push("Context Cursor added beside a prompt (files, rules, git status) is left out; the prompt is what was typed.");
  if (failed) notes.push(`${failed} turn${failed === 1 ? "" : "s"} ended with an error in Cursor (a limit or a failure); the words of the turn are what was kept.`);
  return finish(f, b, notes, skips, new Set());
}

export const cursorStore: SideStore = {
  harness: "cursor",
  label: "Cursor Agent",
  store: cursorHome,
  list,
  read: (f) => (f.path.endsWith(".db") ? readStore(f) : readTranscript(f)),
  pending: () => left,
};
