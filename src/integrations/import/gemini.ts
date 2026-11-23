// Gemini CLI: one file per session under ~/.gemini/tmp/<project>/chats/.
// <project> is a short name of the project's folder (the folder itself is in
// <project>/.project_root) or, from older versions, a hash of it. A session
// is `session-<time>-<id>.jsonl`; a subagent's is `<id>.jsonl` in a folder
// named for its parent's session. Older versions wrote one JSON object
// (`.json`) with every message.
//
// The JSONL file is a log: a metadata record (sessionId, projectHash,
// startTime, lastUpdated, summary, kind), message records (id, timestamp,
// type user, gemini, info, error or warning, content as Gemini parts; a
// gemini message has toolCalls with their result parts and status, thoughts
// and the model), `$set` (metadata, or a whole new message list), `$patch`
// (a message's content or a call's result changed, messages removed or
// reordered) and `$rewindTo` (the messages from that id on are gone). They
// are applied in order, as Gemini CLI loads its own sessions, so what is read
// is the conversation as Gemini CLI would resume it.
//
// Source: github.com/google-gemini/gemini-cli, packages/core/src/services/
// chatRecordingService.ts and chatRecordingTypes.ts, and packages/core/src/
// config/storage.ts and projectRegistry.ts (main, 2026-11-21). Nothing here writes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { damageNotes, headTail, readLines } from "./files.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";

export const geminiHome = () => process.env.KEEL_IMPORT_GEMINI_DIR ?? join(homedir(), ".gemini");
// The newest files a listing reads: older ones wait for a later version of the list.
const LISTED_MAX = 400;
// A legacy file is read whole to be listed: past this it is not listed.
const LEGACY_MAX = 32 * 1024 * 1024;

type Msg = { id: string; type: string; timestamp?: string; content?: unknown; toolCalls?: any[]; thoughts?: unknown[]; model?: string };
type Conversation = { meta: Record<string, any>; messages: Msg[]; cut?: boolean };

const isMsg = (r: any): r is Msg => r && typeof r === "object" && typeof r.id === "string" && !("$patch" in r) && typeof r.type === "string";

// The most messages a file's records may touch, summed over all of them (a
// message added, removed, patched or moved counts one each time). Gemini CLI
// writes a few per message (a session of 10,000 messages is some 50,000); a
// file past this is no session of its, and the
// rest of its records is not applied (the read says so).
export const WORK_MAX = 1_000_000;

// Every record of a session file applied in order (Gemini CLI's own loader).
// The messages are a list with each id's place: a rewind cuts the list at a
// place, so a file's records cost what they touch, not the list's length each.
export function conversationOf(records: any[]): Conversation {
  let meta: Record<string, any> = {};
  let list: (Msg | undefined)[] = [];
  let at = new Map<string, number>();
  let work = 0;
  const put = (m: Msg) => { const i = at.get(m.id); if (i === undefined) { at.set(m.id, list.length); list.push(m); } else list[i] = m; work++; };
  const reset = () => { work += list.length; list = []; at = new Map(); };
  const patch = (p: any) => {
    const i = typeof p?.id === "string" ? at.get(p.id) : undefined;
    const m = i === undefined ? undefined : list[i];
    if (!m) return;
    work++;
    if (p.content !== undefined) m.content = p.content;
    if (Array.isArray(p.toolCalls) && Array.isArray(m.toolCalls)) for (const t of p.toolCalls) {
      work++;
      const c = m.toolCalls.find((x) => x?.id === t?.id);
      if (c && t && typeof t === "object" && "result" in t) c.result = t.result;
    }
  };
  let cut = false;
  for (const r of records) {
    if (work > WORK_MAX) { cut = true; break; }
    if (!r || typeof r !== "object") continue;
    if (typeof r.$rewindTo === "string") {
      const i = at.get(r.$rewindTo);
      if (i === undefined) reset();
      else { for (let k = i; k < list.length; k++) { const m = list[k]; if (m) at.delete(m.id); } work += list.length - i; list.length = i; }
    } else if (r.$patch && typeof r.$patch === "object") {
      const p = r.$patch;
      if (typeof p.id === "string") patch(p);
      for (const u of Array.isArray(p.updates) ? p.updates : []) patch(u);
      for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) {
        const i = typeof id === "string" ? at.get(id) : undefined;
        if (i !== undefined) { list[i] = undefined; at.delete(id); }
        work++;
      }
      if (Array.isArray(p.orderIds)) {
        // The named ones go last, in the order named; the rest keep theirs before them.
        const ordered: Msg[] = [];
        const named = new Set<string>();
        for (const id of p.orderIds) {
          work++;
          const i = typeof id === "string" && !named.has(id) ? at.get(id) : undefined;
          const m = i === undefined ? undefined : list[i];
          if (m) { named.add(id); ordered.push(m); }
        }
        const rest = list.filter((m): m is Msg => !!m && !named.has(m.id));
        work += 2 * list.length; // the list made again, and its places
        list = [...rest, ...ordered];
        at = new Map(list.map((m, i) => [m!.id, i]));
      }
    } else if (isMsg(r)) put(r);
    else if (r.$set && typeof r.$set === "object") {
      const { messages: all, ...rest } = r.$set;
      if (Array.isArray(all)) { reset(); for (const m of all) if (isMsg(m)) put(m); }
      meta = { ...meta, ...rest };
    } else if (typeof r.sessionId === "string" && typeof r.projectHash === "string") {
      const { messages: all, ...rest } = r;
      meta = { ...meta, ...rest };
      if (Array.isArray(all)) for (const m of all) if (isMsg(m)) put(m);
    }
  }
  return { meta, messages: list.filter((m): m is Msg => !!m), ...(cut ? { cut } : {}) };
}

// A file's records: a JSONL log, or an older version's one JSON object.
function recordsOf(text: string, path: string): { records: any[]; lines?: ReturnType<typeof readLines> } {
  if (path.endsWith(".json")) {
    try { return { records: [JSON.parse(text)] }; } catch { return { records: [] }; }
  }
  const lines = readLines(text);
  return { records: lines.records, lines };
}

// Gemini parts as text and images (a string, a part, or a list of them).
function partsOf(c: unknown): any[] {
  return c == null ? [] : Array.isArray(c) ? c : [c];
}
export function textOf(c: unknown): string {
  return partsOf(c).map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" && !p.thought ? p.text : "")).join("");
}
const imagesOf = (c: unknown) => partsOf(c)
  .filter((p: any) => typeof p?.inlineData?.data === "string" && String(p.inlineData.mimeType ?? "").startsWith("image/"))
  .map((p: any) => ({ type: "image", source: { type: "base64", media_type: p.inlineData.mimeType, data: p.inlineData.data } }));

// What a call returned: its function response's output (or error), and any other parts with it.
function resultOf(tc: any): { content: any; is_error: boolean } {
  const parts = partsOf(tc.result);
  const out: any[] = [];
  let failed = tc.status === "error" || tc.status === "cancelled";
  for (const p of parts as any[]) {
    const r = p?.functionResponse?.response;
    if (r !== undefined) {
      if (r?.error !== undefined) failed = true;
      const v = r?.output ?? r?.error ?? r;
      out.push({ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) });
    } else if (typeof p === "string" || typeof p?.text === "string") out.push({ type: "text", text: typeof p === "string" ? p : p.text });
    else if (typeof p?.inlineData?.data === "string") out.push(String(p.inlineData.mimeType ?? "").startsWith("image/") ? { type: "image", media_type: p.inlineData.mimeType, data: p.inlineData.data } : unavailable(`${p.inlineData.mimeType ?? "a file"} the call returned`));
  }
  if (!out.length && typeof tc.resultDisplay === "string" && tc.resultDisplay) out.push({ type: "text", text: tc.resultDisplay });
  if (!out.length) out.push({ type: "text", text: tc.status === "cancelled" ? "The call was cancelled." : failed ? "The call failed." : "No result was recorded for this call." });
  return { content: out.length === 1 && out[0].type === "text" ? out[0].text : out, is_error: failed || (!parts.length && tc.status !== "success") };
}

const timeMs = (t: unknown) => (typeof t === "string" ? Date.parse(t) || 0 : 0);

// The folder a project's directory under tmp/ stands for.
function projectRoot(dir: string): string | undefined {
  // (An absolute folder, written plainly: `..` and `.` in what the file says are resolved.)
  try { const p = readFileSync(join(dir, ".project_root"), "utf8").trim(); return isAbsolute(p) ? resolve(p) : undefined; } catch { return undefined; }
}

// Every session file, newest first: tmp/<project>/chats/*.json(l) and a subagent's under chats/<parent>/.
function sessionFiles(home: string): { path: string; project: string; parent?: string; mtime: number; size: number }[] {
  const tmp = join(home, "tmp");
  const out: { path: string; project: string; parent?: string; mtime: number; size: number }[] = [];
  const add = (path: string, project: string, parent?: string) => { try { const s = statSync(path); if (s.isFile()) out.push({ path, project, parent, mtime: s.mtimeMs, size: s.size }); } catch {} };
  let projects: string[] = [];
  try { projects = readdirSync(tmp); } catch { return []; }
  for (const p of projects) {
    const chats = join(tmp, p, "chats");
    let names: string[] = [];
    try { names = readdirSync(chats); } catch { continue; }
    for (const n of names) {
      const path = join(chats, n);
      if (/\.jsonl?$/.test(n)) { if (n.startsWith("session-")) add(path, join(tmp, p)); continue; }
      let inner: string[] = [];
      try { if (statSync(path).isDirectory()) inner = readdirSync(path); } catch {}
      for (const m of inner) if (m.endsWith(".jsonl")) add(join(path, m), join(tmp, p), n);
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LISTED_MAX);
}

function prompts(messages: Msg[]): string[] {
  return messages.filter((m) => m.type === "user").map((m) => textOf(m.content).trim()).filter(Boolean);
}

export function geminiFound(file: { path: string; project: string; parent?: string; mtime: number; size: number }): Found | null {
  let c: Conversation;
  if (file.path.endsWith(".json")) {
    if (file.size > LEGACY_MAX) return null;
    c = conversationOf(recordsOf(readFileSync(file.path, "utf8"), file.path).records);
  } else {
    // The head holds the metadata and the first prompts; the tail the latest metadata and prompts.
    const { head, tail } = headTail(file.path, 64 * 1024);
    const both = conversationOf([...head, ...tail]);
    c = { meta: both.meta, messages: [...conversationOf(head).messages, ...conversationOf(tail).messages] };
  }
  const id = typeof c.meta.sessionId === "string" ? c.meta.sessionId : undefined;
  if (!id) return null;
  const p = prompts(c.messages);
  const model = c.messages.findLast((m) => m.type === "gemini" && typeof m.model === "string")?.model;
  const summary = typeof c.meta.summary === "string" ? c.meta.summary : undefined;
  return {
    harness: "gemini", id, path: file.path, cwd: projectRoot(file.project),
    title: clip([summary, p[0]].find((t) => t?.trim()) ?? id, 120),
    first_prompt: p[0] ? clip(p[0]) : undefined, last_prompt: p.at(-1) ? clip(p.at(-1)!) : undefined,
    updated_ms: Math.max(timeMs(c.meta.lastUpdated), Math.round(file.mtime)), size_bytes: file.size,
    ...(model ? { model } : {}),
    kind: c.meta.kind === "subagent" || file.parent ? "subagent" : "interactive",
    ...(file.parent ? { parent_id: file.parent } : {}),
  };
}

export function geminiSessions(home = geminiHome()): Found[] {
  const out: Found[] = [];
  const seen = new Set<string>();
  for (const f of sessionFiles(home)) {
    let found: Found | null = null;
    try { found = geminiFound(f); } catch {}
    // A session resumed from an older `.json` is written on as `.jsonl`: the newer file is the one listed.
    if (found && !seen.has(found.id)) { seen.add(found.id); out.push(found); }
  }
  return out;
}

export async function readGemini(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const st = statSync(f.path);
  const { records, lines } = recordsOf(await Bun.file(f.path).text(), f.path);
  const c = conversationOf(records);
  const models = new Set<string>();
  for (const m of c.messages) {
    const ts = timeMs(m.timestamp) || st.mtimeMs;
    if (m.type === "user") {
      b.user(textOf(m.content), ts, imagesOf(m.content));
    } else if (m.type === "gemini") {
      if (Array.isArray(m.thoughts) && m.thoughts.length) b.counts.thoughts_dropped += m.thoughts.length;
      if (m.model) models.add(m.model);
      const text = textOf(m.content);
      const calls = (Array.isArray(m.toolCalls) ? m.toolCalls : []).filter((t) => t && typeof t.name === "string");
      const blocks: any[] = text.trim() ? [{ type: "text", text }] : [];
      const ids = calls.map((t, i) => (typeof t.id === "string" && t.id ? t.id : `gemini_${m.id}_${i}`));
      calls.forEach((t, i) => blocks.push({ type: "tool_use", id: ids[i], name: t.name, input: t.args && typeof t.args === "object" ? t.args : {} }));
      b.assistant(blocks, ts, m.model, true);
      // Each call's result follows the reply that made it, so the history stays well formed for the next model.
      calls.forEach((t, i) => b.result({ tool_use_id: ids[i]!, ...resultOf(t) }, timeMs(t.timestamp) || ts));
    } else b.counts.skipped++; // info, error and warning lines are Gemini CLI's own display
  }
  if (lines) notes.push(...damageNotes(lines));
  if (c.cut) notes.push("The session's log changes its messages more often than any session Gemini CLI writes: what it holds after that point is left out.");
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thought summar${b.counts.thoughts_dropped === 1 ? "y is" : "ies are"} not carried: another model's thinking is not sent to this one.`);
  if (b.counts.skipped) notes.push(`${b.counts.skipped} line${b.counts.skipped === 1 ? "" : "s"} Gemini CLI showed (info, warnings, errors) ${b.counts.skipped === 1 ? "is" : "are"} not part of the conversation and ${b.counts.skipped === 1 ? "is" : "are"} left out.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}
