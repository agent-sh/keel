// Grok CLI (xAI): one folder per session, grouped by the working directory:
//   ~/.grok/sessions/<url-encoded cwd>/<session id>/
// (`GROK_HOME` moves ~/.grok; a group name over 255 bytes is a slug and a hash,
// and the folder itself is in a `.cwd` file inside the group).
// A session folder holds summary.json (info { id, cwd }, session_summary,
// generated_title, created_at, updated_at, last_active_at, current_model_id,
// session_kind: headless, subagent, or none for the interactive one,
// parent_session_id for a fork), chat_history.jsonl (what the model was sent,
// below), updates.jsonl (the ACP update stream: user_message_chunk with its
// promptIndex, tool_call, tool_call_update with status completed or failed,
// each with the time it was written), compaction_checkpoints/ and more.
// A session that started subagents has subagents/<id>/meta.json (parent_session_id,
// child_session_id, subagent_type, description, prompt); the child is a session
// of its own in the same tree.
//
// chat_history.jsonl is one record per line, by `type`: system (the system
// prompt), user (content: a list of parts; `synthetic_reason` marks what the
// harness added: system_reminder, project_instructions, task_completed,
// subagent_completed, notification_drain, compaction_meta; a real prompt has
// none, and the interactive route wraps it in <user_query>; the first record
// of a session is the <user_info> environment), reasoning (encrypted content
// and a short summary), assistant (content, tool_calls { id, name, arguments
// as a JSON string }, model_id), tool_result (tool_call_id, content, images as
// data URLs) and backend_tool_call (a search Grok ran on its own servers:
// x_search, web_search; no result is written). A compaction rewrites the file:
// the system prompt, the environment, the kept prompt, a compaction_meta
// record holding the summary, and what followed; the turns before it stay only
// in compaction/ (a markdown record) and updates.jsonl.
//
// Source: Grok CLI 1.0.93's own user guide (docs/user-guide/16-subagents.md and
// 17-sessions.md, installed with it) and the files it writes (2026-11-21).
// Nothing here writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { damageNotes, headTail, readLines, scanBack, scanFor } from "./files.ts";
import { Builder, clip, resultText, unavailable, type Found, type Kind, type Read } from "./types.ts";
import type { SideStore } from "./more.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const grokHome = () => process.env.KEEL_IMPORT_GROK_DIR ?? ownerEnv("GROK_HOME") ?? join(ownerHome(), ".grok");
const sessionsDir = (home: string) => join(home, "sessions");

const CHAT = "chat_history.jsonl";
const SUMMARY = "summary.json";
const UPDATES = "updates.jsonl";
const SLICE = 64 * 1024;
// A listing call reads sessions for this long; the walk calls again until none is left.
const BUDGET_MS = 40;

const json = (path: string): any => { try { const v = JSON.parse(readFileSync(path, "utf8")); return v && typeof v === "object" ? v : undefined; } catch { return undefined; } };
const timeMs = (t: unknown) => (typeof t === "string" ? Date.parse(t) || 0 : 0);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

const QUERY = /^\s*<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/;
const NOTICE = /^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (typeof p === "string" ? p : p?.type === "text" && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n");
}

type Role = "prompt" | "context" | "notice" | "summary";
// A user record by what it is: the owner's prompt, the harness's own context
// (dropped), a notice the model read (a finished task), or a compaction's summary.
function roleOf(r: any): Role {
  const why = r.synthetic_reason;
  const env = partsText(r.content).trimStart().startsWith("<user_info>");
  if (why === "compaction_meta") return env ? "context" : "summary";
  if (why === "task_completed" || why === "subagent_completed" || why === "notification_drain") return "notice";
  if (why) return "context";
  return env ? "context" : "prompt";
}
// What the person typed, without the wrapper the harness puts around it; undefined
// for a record that is not a prompt.
const promptOf = (r: any): string | undefined => {
  if (r?.type !== "user" || roleOf(r) !== "prompt") return undefined;
  const t = partsText(r.content);
  return (QUERY.exec(t)?.[1] ?? t).trim() || undefined;
};

type Walked = { dir: string; id: string; chat: string; size: number; mtime: number; summaryAt: number };

// The folder a group stands for: the `.cwd` file of a long name, else the name decoded.
function groupCwd(group: string): string | undefined {
  try { const t = readFileSync(join(group, ".cwd"), "utf8").trim(); if (t.startsWith("/")) return t; } catch {}
  try { const d = decodeURIComponent(basename(group)); return d.startsWith("/") ? d : undefined; } catch { return undefined; }
}

function walk(home: string): Walked[] {
  const root = sessionsDir(home);
  const out: Walked[] = [];
  let groups: string[] = [];
  try { groups = readdirSync(root); } catch { return []; }
  for (const g of groups) {
    const gp = join(root, g);
    let ids: string[] = [];
    try { if (!statSync(gp).isDirectory()) continue; ids = readdirSync(gp); } catch { continue; }
    for (const id of ids) {
      if (id.startsWith(".")) continue;
      const dir = join(gp, id);
      const chat = join(dir, CHAT);
      try {
        const st = statSync(chat);
        let summaryAt = 0;
        try { summaryAt = statSync(join(dir, SUMMARY)).mtimeMs; } catch {}
        out.push({ dir, id, chat, size: st.size, mtime: st.mtimeMs, summaryAt });
      } catch {}
    }
  }
  return out.sort((a, b) => Math.max(b.mtime, b.summaryAt) - Math.max(a.mtime, a.summaryAt));
}

function foundOf(w: Walked): Found | null {
  const sum = json(join(w.dir, SUMMARY)) ?? {};
  const { head, tail } = headTail(w.chat, SLICE);
  // (A file past the two slices may hold its prompts between them.)
  const big = w.size > 2 * SLICE;
  const first = head.map(promptOf).find(Boolean) ?? (big ? scanFor(w.chat, promptOf) : undefined);
  const last = tail.map(promptOf).findLast(Boolean) ?? (big ? scanBack(w.chat, promptOf) : undefined);
  // A session with no prompt (a start that was never used) has nothing to carry.
  if (!first) return null;
  const cwd = str(sum.info?.cwd) ?? groupCwd(dirname(w.dir));
  const model = str(sum.current_model_id);
  const kind: Kind = sum.session_kind === "subagent" ? "subagent" : sum.session_kind === "headless" ? "headless" : "interactive";
  return {
    harness: "grok", id: w.id, path: w.chat, ...(cwd ? { cwd } : {}),
    title: clip(str(sum.generated_title) ?? str(sum.session_summary) ?? first, 120),
    first_prompt: clip(first), last_prompt: last ? clip(last) : undefined,
    // (The session's own time; the file's only where it has none: a copied folder has a new one.)
    updated_ms: Math.max(timeMs(sum.last_active_at), timeMs(sum.updated_at)) || Math.round(w.mtime),
    size_bytes: w.size,
    ...(model ? { model } : {}),
    kind,
    ...(kind === "subagent" && str(sum.parent_session_id) ? { parent_id: sum.parent_session_id } : {}),
  };
}

// Which session started which: the parent's subagents/<id>/meta.json names the child.
// Read again only when the parent's subagents folder changed.
const startedBy = new Map<string, { at: number; children: string[] }>();
function childrenOf(w: Walked): string[] {
  const dir = join(w.dir, "subagents");
  let at: number;
  try { at = statSync(dir).mtimeMs; } catch { startedBy.delete(w.id); return []; }
  const k = startedBy.get(w.id);
  if (k && k.at === at) return k.children;
  const children: string[] = [];
  try {
    for (const n of readdirSync(dir)) {
      const m = json(join(dir, n, "meta.json"));
      children.push(str(m?.child_session_id) ?? str(m?.subagent_id) ?? n);
    }
  } catch {}
  startedBy.set(w.id, { at, children });
  return children;
}

// What each session was read as, by its path and what changed: a listing reads
// only a session that changed (a listing every few seconds reads none).
const known = new Map<string, { key: string; found: Found | null }>();
let pendingNow = 0;
let walked: { at: number; home: string; files: Walked[] } | null = null;

// Every session, newest first. `budgetMs`: how long this call may spend reading
// sessions; those not reached are left for the next call (`grokPending`), so a
// first listing of a large store never holds the daemon.
export function grokSessions(home = grokHome(), budgetMs = BUDGET_MS): Found[] {
  const until = performance.now() + budgetMs;
  // While a first listing goes on, its calls share one walk of the folders.
  const files = walked && walked.home === home && pendingNow > 0 && Date.now() - walked.at < 2000 ? walked.files : walk(home);
  walked = { at: Date.now(), home, files };
  const out: Found[] = [];
  const parent = new Map<string, string>();
  let pending = 0;
  for (const w of files) {
    for (const c of childrenOf(w)) parent.set(c, w.id);
    const key = `${w.size}:${w.mtime}:${w.summaryAt}`;
    const k = known.get(w.chat);
    let found: Found | null;
    if (k && k.key === key) found = k.found;
    else if (performance.now() > until) { pending++; continue; }
    else {
      found = null;
      try { found = foundOf(w); } catch {}
      known.set(w.chat, { key, found });
    }
    if (found) out.push(found);
  }
  pendingNow = pending;
  const listed = new Set(files.map((w) => w.chat));
  for (const p of known.keys()) if (p.startsWith(sessionsDir(home)) && !listed.has(p)) known.delete(p);
  const ids = new Set(files.map((w) => w.id));
  for (const id of startedBy.keys()) if (!ids.has(id)) startedBy.delete(id);
  return out.map((f) => {
    const p = parent.get(f.id);
    return p ? { ...f, kind: "subagent" as const, parent_id: p } : f;
  }).sort((a, b) => b.updated_ms - a.updated_ms);
}
export const grokPending = () => pendingNow;

type CallTimes = { start?: number; done?: number; failed?: boolean };

// When each prompt and each call happened, and which calls failed: from the
// update stream (the chat history carries no times).
function updatesOf(dir: string): { prompts: Map<number, number>; calls: Map<string, CallTimes> } {
  const prompts = new Map<number, number>();
  const calls = new Map<string, CallTimes>();
  const path = join(dir, UPDATES);
  if (!existsSync(path)) return { prompts, calls };
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return { prompts, calls }; }
  for (const line of text.split("\n")) {
    if (!line.includes("tool_call") && !line.includes("user_message_chunk")) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const u = r?.params?.update;
    if (!u) continue;
    const ts = Number(r.params?._meta?.agentTimestampMs) || (Number.isFinite(r.timestamp) ? r.timestamp * 1000 : 0);
    if (u.sessionUpdate === "user_message_chunk" && Number.isInteger(u._meta?.promptIndex)) {
      if (ts && !prompts.has(u._meta.promptIndex)) prompts.set(u._meta.promptIndex, ts);
    } else if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
      const c = calls.get(u.toolCallId) ?? {};
      if (ts && c.start === undefined) c.start = ts;
      if (u.status === "completed" || u.status === "failed") { if (ts) c.done = ts; if (u.status === "failed") c.failed = true; }
      calls.set(u.toolCallId, c);
    }
  }
  return { prompts, calls };
}

// An image of a result as Keel stores one: a data URL's bytes, else named as not carried.
function imageOf(i: any): any {
  const url = typeof i === "string" ? i : typeof i?.url === "string" ? i.url : typeof i?.image_url === "string" ? i.image_url : i?.image_url?.url;
  const [, media_type, data] = (typeof url === "string" && url.match(/^data:([^;,]+);base64,(.*)$/s)) || [];
  if (media_type && data) return { type: "image", media_type, data };
  return unavailable(typeof url === "string" && url ? `image at ${url}` : "image");
}

export async function readGrok(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const dir = dirname(f.path);
  const lines = readLines(await Bun.file(f.path).text());
  const { prompts, calls } = updatesOf(dir);
  const sum = json(join(dir, SUMMARY)) ?? {};
  // Times are never earlier than the record before: the history is in order.
  let last = timeMs(sum.created_at) || statSync(f.path).mtimeMs;
  const at = (t: number | undefined) => { if (t && t > last) last = t; return last; };
  const models = new Set<string>();
  const server = new Map<string, number>();
  const waiting: string[] = [];
  const unknownTypes = new Set<string>();
  let context = 0, badArgs = 0, unknown = 0, compactions = 0;
  // A call left without a result when the conversation moves on gets one, so
  // the history stays well formed for the next model.
  const settle = () => {
    for (const id of waiting.splice(0)) b.result({ tool_use_id: id, content: "Grok recorded no result for this call.", is_error: true }, last);
  };
  for (const r of lines.records) {
    if (!r || typeof r !== "object") { b.counts.skipped++; continue; }
    if (r.type === "system") { context++; b.counts.skipped++; continue; }
    if (r.type === "user") {
      const role = roleOf(r);
      if (role === "context") { context++; b.counts.skipped++; continue; }
      settle();
      const ts = at(Number.isInteger(r.prompt_index) ? prompts.get(r.prompt_index) : undefined);
      if (role === "prompt") {
        const c = resultText(r.content);
        const text = typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n");
        b.user(QUERY.exec(text)?.[1] ?? text, ts, typeof c === "string" ? [] : c.filter((p) => p.type === "image"));
      } else if (role === "notice") {
        const t = partsText(r.content);
        if (t.trim()) b.note((NOTICE.exec(t)?.[1] ?? t).trim(), ts, true);
      } else {
        compactions++;
        // What came before it in the file (the kept prompt) stays beside the summary.
        b.compacted(partsText(r.content).trim(), ts, { tail: b.events.length });
      }
      continue;
    }
    if (r.type === "reasoning") { b.counts.thoughts_dropped++; continue; }
    if (r.type === "backend_tool_call") {
      const name = str(r.kind?.name) ?? str(r.kind?.tool_type) ?? "search";
      server.set(name, (server.get(name) ?? 0) + 1);
      b.counts.skipped++;
      continue;
    }
    if (r.type === "assistant") {
      settle();
      if (typeof r.model_id === "string" && r.model_id) models.add(r.model_id);
      const text = partsText(r.content);
      const tc = (Array.isArray(r.tool_calls) ? r.tool_calls : []).filter((t: any) => t && typeof t.name === "string");
      const blocks: any[] = text.trim() ? [{ type: "text", text }] : [];
      let start: number | undefined;
      tc.forEach((t: any, i: number) => {
        const id = typeof t.id === "string" && t.id ? t.id : `grok_${b.events.length}_${i}`;
        let input: any = {};
        if (typeof t.arguments === "string" && t.arguments.trim()) {
          try { const v = JSON.parse(t.arguments); input = v && typeof v === "object" && !Array.isArray(v) ? v : { value: v }; } catch { badArgs++; }
        } else if (t.arguments && typeof t.arguments === "object") input = t.arguments;
        blocks.push({ type: "tool_use", id, name: t.name, input });
        waiting.push(id);
        start ??= calls.get(id)?.start;
      });
      b.assistant(blocks, at(start), typeof r.model_id === "string" ? r.model_id : undefined, true);
      continue;
    }
    if (r.type === "tool_result") {
      const id = typeof r.tool_call_id === "string" ? r.tool_call_id : "";
      const i = waiting.indexOf(id);
      if (i >= 0) waiting.splice(i, 1);
      const c = calls.get(id);
      let content: any = resultText(r.content);
      if (Array.isArray(r.images) && r.images.length) {
        content = [...(typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : content), ...r.images.map(imageOf)];
      }
      b.result({ tool_use_id: id, content, is_error: c?.failed }, at(c?.done));
      continue;
    }
    unknown++;
    b.counts.skipped++;
    if (typeof r.type === "string") unknownTypes.add(r.type);
  }
  settle();
  notes.push(...damageNotes(lines));
  const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (context) notes.push(`${context} record${s(context, "", "s")} Grok added to the session (its system prompt, the environment, skills and project instructions) ${s(context, "is", "are")} left out: Keel sends its own.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning record${s(b.counts.thoughts_dropped, " is", "s are")} not carried: Grok keeps it encrypted, and another model's thinking is not sent to this one.`);
  if (server.size) {
    const n = [...server.values()].reduce((a, c) => a + c, 0);
    notes.push(`${n} search${s(n, "", "es")} Grok ran on its own servers (${[...server].map(([k, v]) => `${k}: ${v}`).join(", ")}) left no result in its history and ${s(n, "is", "are")} not carried.`);
  }
  if (compactions) notes.push("Grok compacted this session: the turns before the compaction are no longer in its chat history (only its summary is), so they are not carried.");
  if (badArgs) notes.push(`${badArgs} tool call${s(badArgs, "", "s")} had arguments that are not JSON and ${s(badArgs, "is", "are")} carried with no input.`);
  if (unknown) notes.push(`${unknown} record${s(unknown, "", "s")} of ${unknownTypes.size ? [...unknownTypes].join(", ") : "an unknown kind"} could not be read and ${s(unknown, "is", "are")} left out.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const grokStore: SideStore = {
  harness: "grok",
  label: "Grok",
  store: grokHome,
  list: () => grokSessions(),
  read: readGrok,
  pending: grokPending,
};
