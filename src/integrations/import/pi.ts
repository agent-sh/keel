// Pi (the pi coding agent, @earendil-works/pi-coding-agent): one JSONL file per session,
// ~/.pi/agent/sessions/--<working folder with / as ->--/<time>_<id>.jsonl (the agent folder is
// $PI_CODING_AGENT_DIR, the sessions folder $PI_CODING_AGENT_SESSION_DIR).
// The first line is the header ({ type "session", version 3, id, timestamp, cwd, parentSession? }).
// Every other line is an entry with `id`, `parentId` and an ISO `timestamp`, forming a tree: a
// branch made in /tree adds a child to an earlier entry, and the file's last entry is the leaf the
// session resumes at. The conversation is the path from that leaf to the root. Entry types:
// `message` (an AgentMessage: role user, assistant, toolResult, bashExecution, custom, branchSummary
// or system), `model_change`, `thinking_level_change`, `compaction` (summary, firstKeptEntryId: the
// first entry kept verbatim beside the summary), `branch_summary` (the abandoned branch, as text),
// `context_edit` (a later edit of what the model reads of an earlier entry), `custom_message`
// (an extension's text the model reads), and `custom`, `usage`, `label`, `session_info` (the
// session's name) which the model never reads. An assistant message holds text, thinking and
// toolCall blocks (id, name, arguments), the model, a stopReason (stop, toolUse, length, error,
// aborted) and an errorMessage; a toolResult holds the call's id, text and image blocks and isError.
// Sessions from before the system message existed have none; later ones start with one that holds
// Pi's prompt sections and tool declarations, which are not carried.
//
// Source: the program's own docs/session-format.md and docs/message-types.md (version 1.1.0) and
// github.com/earendil-works/pi, packages/coding-agent/src/core/session-manager.ts (2026-11-25).
// Nothing here writes.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { damageNotes, headTail, readLines, scanBack, scanFor } from "./files.ts";
import type { SideStore } from "./more.ts";
import { Builder, clip, type Found, type Read } from "./types.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

const agentDir = () => process.env.KEEL_IMPORT_PI_DIR ?? ownerEnv("PI_CODING_AGENT_DIR") ?? join(ownerHome(), ".pi", "agent");
const sessionsDir = () => (process.env.KEEL_IMPORT_PI_DIR ? undefined : ownerEnv("PI_CODING_AGENT_SESSION_DIR")) ?? join(agentDir(), "sessions");
// The newest files a listing reads: older ones wait for a later version of the list.
const LISTED_MAX = 2000;
const EDGE = 64 * 1024;

const ms = (t: unknown) => (typeof t === "string" ? Date.parse(t) || 0 : 0);

// Text of a content that is a string or blocks.
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";
// Pi's image block as Keel stores one.
const imageOf = (p: any) => ({ type: "image", media_type: p.mimeType ?? p.media_type ?? "image/png", data: p.data });
const imagesOf = (c: unknown): any[] => (Array.isArray(c) ? c.filter((p) => p?.type === "image" && typeof p.data === "string").map(imageOf) : []);

const promptOf = (r: any): string | undefined => {
  if (r?.type !== "message" || r.message?.role !== "user") return undefined;
  const t = textOf(r.message.content).trim();
  return t || undefined;
};
const modelOf = (r: any): string | undefined =>
  r?.type === "message" && r.message?.role === "assistant" && typeof r.message.model === "string" && r.message.model ? r.message.model
  : r?.type === "model_change" && typeof r.modelId === "string" ? r.modelId : undefined;

function foundOf(path: string, size: number, mtime: number): Found | null {
  const { head, tail } = headTail(path, EDGE);
  const header = head[0]?.type === "session" ? head[0] : undefined;
  const id = typeof header?.id === "string" ? header.id : path.match(/_([^_/]+)\.jsonl$/)?.[1];
  if (!id) return null;
  const first = head.map(promptOf).find(Boolean) ?? scanFor(path, promptOf);
  const last = tail.map(promptOf).findLast(Boolean) ?? scanBack(path, promptOf);
  // The session's name: the latest `session_info` of the tail, else of the head.
  const name = [...tail, ...head].reverse().find((r) => r?.type === "session_info" && typeof r.name === "string" && r.name.trim())?.name;
  const model = tail.map(modelOf).findLast(Boolean) ?? scanBack(path, modelOf) ?? head.map(modelOf).findLast(Boolean);
  return {
    harness: "pi", id, path, cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
    title: clip(name ?? first ?? id, 120),
    first_prompt: first ? clip(first) : undefined, last_prompt: last ? clip(last) : undefined,
    updated_ms: Math.round(mtime) || ms(header?.timestamp), size_bytes: size,
    ...(model ? { model } : {}),
    kind: "interactive",
  };
}

// Every session file, newest first.
function files(): { path: string; mtime: number; size: number }[] {
  const root = sessionsDir();
  const out: { path: string; mtime: number; size: number }[] = [];
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return []; }
  for (const d of dirs) {
    let names: string[] = [];
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      try { const s = statSync(join(root, d, n)); if (s.isFile()) out.push({ path: join(root, d, n), mtime: s.mtimeMs, size: s.size }); } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LISTED_MAX);
}

// What each file was read as, by its path, size and time: a listing reads only a file that changed.
const known = new Map<string, { size: number; mtime: number; found: Found | null }>();
let left = 0;
// `budgetMs`: how long this call may spend reading files; those not reached are left for the next call.
export function piSessions(budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  const out: Found[] = [];
  const all = files();
  let pending = 0;
  for (const f of all) {
    const k = known.get(f.path);
    let found: Found | null;
    if (k && k.size === f.size && k.mtime === f.mtime) found = k.found;
    else if (performance.now() > until) { pending++; continue; }
    else {
      found = null;
      try { found = foundOf(f.path, f.size, f.mtime); } catch {}
      known.set(f.path, { size: f.size, mtime: f.mtime, found });
    }
    if (found) out.push(found);
  }
  left = pending;
  const listed = new Set(all.map((f) => f.path));
  for (const p of known.keys()) if (!listed.has(p)) known.delete(p);
  return out;
}

const NO_RESULT = "No result was recorded for this call.";

export async function readPi(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const lines = readLines(await Bun.file(f.path).text());
  const entries = new Map<string, any>();
  let leaf: any;
  for (const r of lines.records) {
    if (!r || typeof r !== "object" || r.type === "session" || typeof r.id !== "string") continue;
    entries.set(r.id, r);
    leaf = r;
  }
  // The conversation: the path from the file's last entry to its root.
  const path: any[] = [];
  const onPath = new Set<string>();
  for (let e = leaf; e && !onPath.has(e.id); e = typeof e.parentId === "string" ? entries.get(e.parentId) : undefined) { path.unshift(e); onPath.add(e.id); }
  // A later edit of what the model reads of an earlier entry (on this branch).
  const edits = new Map<string, any>();
  for (const e of path) if (e.type === "context_edit" && typeof e.targetId === "string") edits.set(e.targetId, e);

  const calls = new Set<string>();
  let open: string[] = []; // calls of the last reply that have no result yet
  const flush = (ts: number) => { for (const id of open) b.result({ tool_use_id: id, content: NO_RESULT, is_error: true }, ts); open = []; };
  // The event each entry began (a compaction keeps the events from `firstKeptEntryId` on).
  const began = new Map<string, number>();
  const models = new Set<string>();
  let skipped = 0, edited = 0, errors = 0;
  const skip = () => { b.counts.skipped++; skipped++; };
  const contextNote = (e: any, text: string, ts: number) => {
    if (!text.trim()) return skip();
    flush(ts);
    b.note(`An extension added this to Pi's context (${e.customType ?? "custom"}):\n${text}`, ts, true);
  };

  for (const e of path) {
    const at = b.events.length;
    began.set(e.id, at);
    const ts = ms(e.timestamp) || (typeof e.message?.timestamp === "number" ? e.message.timestamp : 0) || f.updated_ms;
    const edit = edits.get(e.id);
    if (edit && edit.replacement === null) { skip(); edited++; continue; }
    if (edit) edited++;
    if (e.type === "message" && e.message && typeof e.message === "object") {
      const m = e.message;
      const mts = typeof m.timestamp === "number" ? m.timestamp : ts;
      // A replacement changes only the content the model reads.
      const content = edit ? edit.replacement : m.content;
      if (m.role === "user") {
        flush(mts);
        b.user(textOf(content), mts, imagesOf(content));
      } else if (m.role === "assistant") {
        flush(mts);
        const blocks: any[] = [];
        for (const p of Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []) {
          if (p?.type === "thinking") b.counts.thoughts_dropped++;
          else if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) blocks.push({ type: "text", text: p.text });
          else if (p?.type === "toolCall" && typeof p.name === "string") {
            const id = typeof p.id === "string" && p.id ? p.id : `pi_${e.id}_${blocks.length}`;
            calls.add(id);
            open.push(id);
            blocks.push({ type: "tool_use", id, name: p.name, input: p.arguments && typeof p.arguments === "object" ? p.arguments : {} });
          }
        }
        if (typeof m.model === "string" && m.model) models.add(m.model);
        const stop = m.stopReason === "aborted" ? "interrupted" : m.stopReason === "length" ? "max_tokens" : undefined;
        b.assistant(blocks, mts, m.model, true, stop);
        if (m.stopReason === "error") { errors++; b.note(`Pi's model request failed here${typeof m.errorMessage === "string" && m.errorMessage.trim() ? `: ${clip(m.errorMessage, 300)}` : "."}`, mts); }
      } else if (m.role === "toolResult") {
        const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
        if (!calls.has(id)) { skip(); continue; }
        open = open.filter((x) => x !== id);
        const parts: any[] = Array.isArray(content) ? content.map((p: any) => (p?.type === "image" && typeof p.data === "string" ? imageOf(p) : p?.type === "text" ? { type: "text", text: p.text ?? "" } : null)).filter(Boolean) : typeof content === "string" ? [{ type: "text", text: content }] : [];
        b.result({ tool_use_id: id, content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts.length ? parts : "", is_error: m.isError === true }, mts);
      } else if (m.role === "bashExecution") {
        // A command the owner ran with !, which Pi shows the model as text unless it asked not to.
        if (m.excludeFromContext || typeof m.command !== "string") skip();
        else {
          flush(mts);
          b.note([`The owner ran a shell command in Pi: ${m.command}`, m.cancelled ? "(cancelled)" : m.exitCode !== undefined && m.exitCode !== 0 ? `(exit code ${m.exitCode})` : "", typeof m.output === "string" ? m.output : "", m.truncated ? "(the output was cut)" : ""].filter(Boolean).join("\n"), mts, true);
        }
      } else if (m.role === "custom") contextNote(m, textOf(content), mts);
      else if (m.role === "branchSummary" && typeof m.summary === "string") { flush(mts); b.note(`Summary of a branch of this session the owner left:\n${m.summary}`, mts, true); }
      else skip(); // system (Pi's prompt and tool loadout), and what no reader knows
    } else if (e.type === "compaction" && typeof e.summary === "string") {
      flush(ts);
      const kept = typeof e.firstKeptEntryId === "string" && e.firstKeptEntryId !== e.id ? began.get(e.firstKeptEntryId) : undefined;
      b.compacted(e.summary, ts, { trigger: "pi", tail: kept === undefined ? 0 : b.events.length - kept });
    } else if (e.type === "branch_summary" && typeof e.summary === "string") {
      flush(ts);
      b.note(`Summary of a branch of this session the owner left:\n${e.summary}`, ts, true);
    } else if (e.type === "custom_message") contextNote(e, textOf(edit ? edit.replacement : e.content), ts);
    // (model_change, thinking_level_change, usage, label, session_info, custom: the model never reads them.)
  }
  flush(f.updated_ms);

  notes.push(...damageNotes(lines));
  const off = entries.size - onPath.size;
  if (off > 0) notes.push(`${off} entr${off === 1 ? "y" : "ies"} on other branches of Pi's session tree (abandoned or earlier paths) ${off === 1 ? "is" : "are"} left out; the conversation is the branch the session ended on.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (skipped) notes.push(`${skipped} item${skipped === 1 ? "" : "s"} (Pi's own prompt and tool declarations, results of calls not in the conversation, entries edited out of Pi's context) ${skipped === 1 ? "is" : "are"} left out.`);
  if (edited) notes.push(`${edited} entr${edited === 1 ? "y was" : "ies were"} edited in Pi's context after it was written; what the model read is carried.`);
  if (errors) notes.push(`${errors} model request${errors === 1 ? "" : "s"} failed in Pi and ${errors === 1 ? "is" : "are"} noted where ${errors === 1 ? "it" : "they"} happened.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const piStore: SideStore = {
  harness: "pi",
  label: "Pi",
  store: agentDir,
  list: () => piSessions(40),
  read: readPi,
  pending: () => left,
};
