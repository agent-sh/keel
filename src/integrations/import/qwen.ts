// Qwen Code (QwenLM/qwen-code, a fork of Gemini CLI): one JSONL file per session,
// ~/.qwen/projects/<folder with every non-alphanumeric as ->/chats/<session id>.jsonl; versions before
// that kept it in ~/.qwen/tmp/<sha256 of the folder>/chats/ in the same format. The base folder is
// $QWEN_RUNTIME_DIR or $QWEN_HOME, else ~/.qwen. A title the owner or Qwen chose can sit in
// `<id>.title.json` ({ displayName }) beside the session, or in a `custom_title` record.
//
// A file is a tree of records ({ uuid, parentUuid, sessionId, timestamp, type user | assistant |
// tool_result | system, subtype?, cwd, version, message?, model?, usageMetadata?, toolCallResult?,
// systemPayload?, isSidechain?, agentId? }). `message` is Gemini Content: { role user | model, parts }
// with parts text (thought: true for a thought), functionCall { id, name, args }, functionResponse
// { id, name, response { output | error } }, inlineData { mimeType, data } and fileData. Several records
// can share a uuid (one reply written in pieces): their parts are joined, as Qwen Code does. The
// conversation is the chain of parents from the file's last conversation record, as Qwen Code
// resumes it: a rewind or a fork leaves other branches in the file. System records with a subtype
// mostly serve its screen (ui_telemetry, file_history_snapshot, session_*, goal_*, artifacts) and are
// not read; `chat_compression` holds the history the model reads after a compaction (summary turns
// first, then the turns kept verbatim), `notification`, `cron` and `background_task_completed` hold
// text the model read that is not the owner's, and `parent_session`, `agent_bootstrap` and
// `agent_launch_prompt` mark a session a subagent ran in. Records of Qwen's background agents
// (isSidechain, agentId) are not the main conversation.
//
// Source: github.com/QwenLM/qwen-code (v0.28.4, main 2026-11-25), packages/core/src/services/
// chatRecordingService.ts (ChatRecord), sessionService.ts, session-title-sidecar.ts,
// utils/transcript-records.ts (the walk) and config/storage.ts (the folders). Nothing here writes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { damageNotes, headTail, readLines, scanBack, scanFor } from "./files.ts";
import type { SideStore } from "./more.ts";
import { Builder, clip, type Found, type Read } from "./types.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

const qwenHome = () => process.env.KEEL_IMPORT_QWEN_DIR ?? ownerEnv("QWEN_RUNTIME_DIR") ?? ownerEnv("QWEN_HOME") ?? join(ownerHome(), ".qwen");
const LISTED_MAX = 2000;
const EDGE = 64 * 1024;
const SESSION_FILE = /^([0-9a-fA-F-]{32,36})\.jsonl$/;
// Records that are no part of the conversation (Qwen Code's own list).
const NOT_CONVERSATION = new Set(["session_sources_snapshot", "generated_ui_state", "session_artifact_event", "session_artifact_snapshot", "managed_session_header_v1", "managed_session_event_v1", "managed_session_commit_v1", "managed_session_snapshot_base_v1"]);
// Records the model reads that are not the owner's words.
const FOR_THE_MODEL = new Set(["notification", "cron", "background_task_completed", "agent_mention", "agent_message", "realtime_message", "at_command", "omni_recall"]);
// Records the owner's own prompts are kept in.
const PROMPTS = new Set([undefined, "mid_turn_user_message", "agent_launch_prompt"]);

const ms = (t: unknown) => (typeof t === "string" ? Date.parse(t) || 0 : 0);
const isRecord = (r: any) => r && typeof r === "object" && typeof r.uuid === "string" && typeof r.type === "string";
const conversational = (r: any) => !(r.type === "system" && typeof r.subtype === "string" && NOT_CONVERSATION.has(r.subtype));
const partsOf = (m: any): any[] => (Array.isArray(m?.parts) ? m.parts : []);
const textOf = (m: any) => partsOf(m).filter((p) => typeof p?.text === "string" && !p.thought).map((p) => p.text).join("\n");

const promptOf = (r: any): string | undefined => {
  if (r?.type !== "user" || !PROMPTS.has(r.subtype) || r.message?.role !== "user" || partsOf(r.message).some((p) => p?.functionResponse)) return undefined;
  return textOf(r.message).trim() || undefined;
};
const modelOf = (r: any): string | undefined =>
  r?.type === "assistant" && !r.isSidechain && typeof r.model === "string" && r.model ? r.model
  : r?.subtype === "session_model" && typeof r.systemPayload?.modelId === "string" ? r.systemPayload.modelId : undefined;
const titleOf = (r: any): string | undefined => (r?.subtype === "custom_title" && typeof r.systemPayload?.customTitle === "string" && r.systemPayload.customTitle.trim() ? r.systemPayload.customTitle.trim() : undefined);

type File = { path: string; id: string; mtime: number; size: number; side: number };

function files(): File[] {
  const home = qwenHome();
  const out: File[] = [];
  for (const root of ["projects", "tmp"]) {
    let dirs: string[] = [];
    try { dirs = readdirSync(join(home, root)); } catch { continue; }
    for (const d of dirs) {
      const chats = join(home, root, d, "chats");
      let names: string[] = [];
      try { names = readdirSync(chats); } catch { continue; }
      const has = new Set(names);
      for (const n of names) {
        const id = n.match(SESSION_FILE)?.[1];
        if (!id) continue;
        try {
          const s = statSync(join(chats, n));
          let side = 0;
          if (has.has(`${id}.title.json`)) { try { side = statSync(join(chats, `${id}.title.json`)).mtimeMs; } catch {} }
          if (s.isFile()) out.push({ path: join(chats, n), id, mtime: s.mtimeMs, size: s.size, side });
        } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LISTED_MAX);
}

function sidecarTitle(path: string): string | undefined {
  try {
    const t = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".title.json"), "utf8"));
    return typeof t?.displayName === "string" && t.displayName.trim() ? t.displayName.trim() : undefined;
  } catch { return undefined; }
}

function foundOf(f: File): Found | null {
  const { head, tail } = headTail(f.path, EDGE);
  const recs = [...head, ...tail].filter(isRecord);
  const first = head.map(promptOf).find(Boolean) ?? scanFor(f.path, promptOf);
  const last = tail.map(promptOf).findLast(Boolean) ?? scanBack(f.path, promptOf);
  const cwd = recs.find((r) => typeof r.cwd === "string" && r.cwd)?.cwd;
  const name = (f.side ? sidecarTitle(f.path) : undefined) ?? tail.map(titleOf).findLast(Boolean) ?? scanBack(f.path, titleOf) ?? head.map(titleOf).findLast(Boolean);
  const model = tail.map(modelOf).findLast(Boolean) ?? scanBack(f.path, modelOf) ?? head.map(modelOf).findLast(Boolean);
  const parent = head.find((r) => r?.subtype === "parent_session")?.systemPayload?.parentSessionId;
  const agent = head.some((r) => r?.subtype === "agent_bootstrap" || r?.subtype === "agent_launch_prompt");
  if (!recs.length && !f.size) return null;
  return {
    harness: "qwen", id: f.id, path: f.path, cwd,
    title: clip(name ?? first ?? f.id, 120),
    first_prompt: first ? clip(first) : undefined, last_prompt: last ? clip(last) : undefined,
    updated_ms: Math.round(Math.max(f.mtime, f.side)), size_bytes: f.size,
    ...(model ? { model } : {}),
    kind: agent ? "subagent" : "interactive",
    ...(agent && typeof parent === "string" ? { parent_id: parent } : {}),
  };
}

const known = new Map<string, { size: number; mtime: number; side: number; found: Found | null }>();
let left = 0;
export function qwenSessions(budgetMs = Infinity): Found[] {
  const until = performance.now() + budgetMs;
  const out: Found[] = [];
  const seen = new Set<string>();
  const all = files();
  let pending = 0;
  for (const f of all) {
    const k = known.get(f.path);
    let found: Found | null;
    if (k && k.size === f.size && k.mtime === f.mtime && k.side === f.side) found = k.found;
    else if (performance.now() > until) { pending++; continue; }
    else {
      found = null;
      try { found = foundOf(f); } catch {}
      known.set(f.path, { size: f.size, mtime: f.mtime, side: f.side, found });
    }
    // The same id in the older and the newer folder: the newer file is the one listed.
    if (found && !seen.has(found.id)) { seen.add(found.id); out.push(found); }
  }
  left = pending;
  const listed = new Set(all.map((f) => f.path));
  for (const p of known.keys()) if (!listed.has(p)) known.delete(p);
  return out;
}

const NO_RESULT = "No result was recorded for this call.";

// Qwen Code's own walk: records sharing a uuid are one (their parts joined), and the conversation is
// the chain of parents from the last conversation record.
function chainOf(records: any[]): { chain: any[]; off: number; gap: boolean } {
  const byUuid = new Map<string, any>();
  let leaf: string | undefined;
  for (const r of records) {
    if (!conversational(r)) continue;
    const had = byUuid.get(r.uuid);
    if (!had) byUuid.set(r.uuid, { ...r, message: r.message ? { ...r.message, parts: [...partsOf(r.message)] } : undefined });
    else {
      if (r.message) had.message = had.message ? { ...had.message, parts: [...partsOf(had.message), ...partsOf(r.message)] } : { ...r.message, parts: [...partsOf(r.message)] };
      if (r.model && !had.model) had.model = r.model;
      if (r.toolCallResult && !had.toolCallResult) had.toolCallResult = r.toolCallResult;
    }
    leaf = r.uuid;
  }
  const chain: any[] = [];
  const seen = new Set<string>();
  let gap = false;
  for (let id: string | null | undefined = leaf; id && !seen.has(id);) {
    const r = byUuid.get(id);
    if (!r) { gap = true; break; }
    seen.add(id);
    chain.unshift(r);
    id = r.parentUuid;
    if (id && !byUuid.has(id)) { gap = true; break; }
  }
  return { chain, off: byUuid.size - chain.length, gap };
}

const imageOf = (p: any) => ({ type: "image", media_type: p.inlineData.mimeType ?? "image/png", data: p.inlineData.data });
const isImage = (p: any) => typeof p?.inlineData?.data === "string" && String(p.inlineData.mimeType ?? "image/png").startsWith("image/");

export async function readQwen(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const lines = readLines(await Bun.file(f.path).text());
  const { chain, off, gap } = chainOf(lines.records.filter(isRecord));
  const calls = new Set<string>();
  let open: { id: string; name: string }[] = [];
  const flush = (ts: number) => { for (const c of open) b.result({ tool_use_id: c.id, content: NO_RESULT, is_error: true }, ts); open = []; };
  const models = new Set<string>();
  const unread = new Set<string>();
  let sidechain = 0, skipped = 0, bootstrapped = 0, orphans = 0;
  const skip = () => { b.counts.skipped++; skipped++; };

  for (const r of chain) {
    const ts = ms(r.timestamp) || f.updated_ms;
    if (r.isSidechain || r.agentId) { sidechain++; continue; }
    if (r.type === "system" && r.subtype === "chat_compression") {
      const p = r.systemPayload;
      const hist: any[] = Array.isArray(p?.compressedHistory) ? p.compressedHistory : [];
      const k = Math.min(hist.length, typeof p?.summaryPrefixLength === "number" ? p.summaryPrefixLength : hist[1]?.role === "model" ? 2 : 1);
      const skipIdx = new Set<number>(Array.isArray(p?.directoryContextIndices) ? p.directoryContextIndices : []);
      const summary = hist.slice(0, k).filter((c, i) => c?.role === "user" && !skipIdx.has(i)).map((c) => textOf(c)).filter((t) => t.trim()).join("\n\n");
      if (!summary) continue;
      flush(ts);
      // The turns Qwen Code kept verbatim beside the summary are the newest of the history.
      let want = hist.length - k;
      let tail = 0;
      for (let i = b.events.length - 1; i >= 0 && want > 0; i--) {
        const kind = b.events[i]!.kind;
        if (kind === "user" || kind === "assistant" || kind === "tool_result") want--;
        tail = b.events.length - i;
      }
      b.compacted(summary, ts, { trigger: "qwen", tail: want > 0 ? 0 : tail });
      continue;
    }
    if (r.subtype === "agent_bootstrap") { bootstrapped++; continue; }
    if (!r.message || typeof r.message !== "object") continue; // records for Qwen's own screen and bookkeeping
    if (r.type === "system" && !FOR_THE_MODEL.has(r.subtype)) continue;
    const parts = partsOf(r.message);
    const role = r.message.role === "model" ? "model" : "user";

    if (role === "model") {
      flush(ts);
      const blocks: any[] = [];
      for (const [i, p] of parts.entries()) {
        if (p?.thought === true && typeof p.text === "string") b.counts.thoughts_dropped++;
        else if (typeof p?.text === "string") { if (p.text.trim()) blocks.push({ type: "text", text: p.text }); }
        else if (p?.functionCall && typeof p.functionCall.name === "string") {
          const id = typeof p.functionCall.id === "string" && p.functionCall.id ? p.functionCall.id : `qwen_${r.uuid}_${i}`;
          calls.add(id);
          open.push({ id, name: p.functionCall.name });
          blocks.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args && typeof p.functionCall.args === "object" ? p.functionCall.args : {} });
        }
      }
      if (typeof r.model === "string" && r.model) models.add(r.model);
      b.assistant(blocks, ts, r.model, true);
      continue;
    }

    // A user turn: the owner's words, results of the model's calls, or text the model read.
    const responses = parts.filter((p) => p?.functionResponse);
    const images = parts.filter(isImage);
    for (const p of parts) if (p?.fileData) unread.add(`a file reference${typeof p.fileData.fileUri === "string" ? ` (${p.fileData.fileUri})` : ""}`);
    if (responses.length) {
      const failed = r.toolCallResult?.status === "error" || r.toolCallResult?.status === "cancelled" || !!r.toolCallResult?.error;
      for (const [i, p] of responses.entries()) {
        const fr = p.functionResponse;
        let id = typeof fr.id === "string" ? fr.id : "";
        if (!open.some((c) => c.id === id)) id = open.find((c) => c.name === fr.name)?.id ?? "";
        const resp = fr.response;
        const text = typeof resp === "string" ? resp : typeof resp?.output === "string" ? resp.output : typeof resp?.error === "string" ? resp.error : resp == null ? "" : JSON.stringify(resp);
        const media = [...(Array.isArray(fr.parts) ? fr.parts : []), ...(i === responses.length - 1 ? images : [])].filter(isImage).map(imageOf);
        const content = media.length ? [...(text ? [{ type: "text", text }] : []), ...media] : text;
        const isError = resp?.error !== undefined || (failed && responses.length === 1);
        if (!id) {
          // A response whose call is not in the conversation: what it said, for the model to read, not a result.
          orphans++;
          b.note(`A tool result Qwen Code recorded (${fr.name ?? "unknown tool"}):\n${text}`, ts, true);
          continue;
        }
        open = open.filter((c) => c.id !== id);
        b.result({ tool_use_id: id, content, is_error: isError }, ts);
      }
      continue;
    }
    const text = textOf(r.message);
    if (r.type === "system" || FOR_THE_MODEL.has(r.subtype)) {
      if (text.trim()) {
        flush(ts);
        const what = r.subtype === "cron" ? "A scheduled prompt" : r.subtype === "at_command" ? "Files the owner referenced with @" : r.subtype === "agent_message" || r.subtype === "agent_mention" ? "A message from another agent" : "A notice";
        b.note(`${what} in Qwen Code (not the owner's words):\n${text}`, ts, true);
      } else skip();
    } else if (r.type === "user" && (PROMPTS.has(r.subtype) || r.subtype === "slash_command")) {
      if (r.subtype === "slash_command" && r.systemPayload?.sentToModel !== true) continue;
      flush(ts);
      b.user(text, ts, images.map(imageOf));
    } else skip();
  }
  flush(f.updated_ms);

  notes.push(...damageNotes(lines));
  if (gap) notes.push("The chain of Qwen Code's records has a missing parent: what came before that point is not in the file and is left out.");
  if (off > 0) notes.push(`${off} record${off === 1 ? "" : "s"} on other branches of the file (a rewind or a fork) ${off === 1 ? "is" : "are"} left out; the conversation is the branch the session ended on.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: another model's thinking is not sent to this one.`);
  if (sidechain) notes.push(`${sidechain} record${sidechain === 1 ? "" : "s"} written by Qwen Code's background agents ${sidechain === 1 ? "is" : "are"} not the main conversation and ${sidechain === 1 ? "is" : "are"} left out.`);
  if (bootstrapped) notes.push("This session ran as an agent of another one: the history it inherited from its parent (the agent_bootstrap record) is left out.");
  if (unread.size) notes.push(`Not carried: ${[...unread].join(", ")}; Qwen Code kept a reference, not the bytes.`);
  if (orphans) notes.push(`${orphans} tool result${orphans === 1 ? "" : "s"} had no call in the conversation and ${orphans === 1 ? "is" : "are"} carried as a note.`);
  if (skipped) notes.push(`${skipped} record${skipped === 1 ? "" : "s"} of a kind this reader does not know ${skipped === 1 ? "is" : "are"} left out.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const qwenStore: SideStore = {
  harness: "qwen",
  label: "Qwen Code",
  store: qwenHome,
  list: () => qwenSessions(40),
  read: readQwen,
  pending: () => left,
};
