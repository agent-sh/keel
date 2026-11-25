// GitHub Copilot CLI: one folder per session under ~/.copilot/session-state/<uuid>/ (older versions wrote
// a flat <uuid>.jsonl there). The folder holds `events.jsonl` (the session's event log, one JSON record a
// line), `workspace.yaml` (id, cwd, name, created_at, updated_at, client_name), `checkpoints/` and `files/`.
// ~/.copilot/session-store.db is an index of the same sessions (cwd, summary, turns) and is not read: the
// log is whole and the index lags it. A folder with no events.jsonl never held a conversation.
//
// Every record is { id, parentId, timestamp, type, data, agentId? }: `session.start` (cwd in
// data.context.cwd, selectedModel), `user.message` (data.content as typed, transformedContent as the
// model saw it, attachments), `assistant.message` (content, toolRequests with toolCallId, name and
// arguments, model, reasoning text and encrypted blocks), `tool.execution_start` and
// `tool.execution_complete` (success, result.content as the model read it, error, contents and
// binaryResultsForLlm for images), `session.binary_asset` (bytes of an attached image by assetId),
// `session.compaction_complete` (summaryContent), `session.context_cleared`, `session.snapshot_rewind`
// (events removed by a rewind), `abort`, `session.error`, and bookkeeping (usage, fusion, permission,
// mode and model changes). An event with an agentId belongs to a sub-agent that the root's `task` call
// started. A long log can be rotated: the head then starts with `session.journal_link` naming the archive
// `events.N.jsonl` that holds what came before, and replay checkpoint records (`checkpoint: true`).
//
// Source: github.com/github/copilot-sdk, docs/features/session-persistence.md and
// nodejs/src/generated/session-events.ts (main, 2026-11-23), checked against logs written by Copilot CLI
// 1.0.x. Nothing here writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { damageNotes, readLines, scanBack, scanFor } from "./files.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";
import type { SideStore } from "./more.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const copilotHome = () => process.env.KEEL_IMPORT_COPILOT_DIR ?? ownerEnv("COPILOT_HOME") ?? join(ownerHome(), ".copilot");
const stateDir = () => join(copilotHome(), "session-state");

// The newest sessions a listing reads, and how long one call may spend reading files (the rest waits
// for the next call: `pending`).
const LISTED_MAX = 600;
const BUDGET_MS = 150;

const timeMs = (t: unknown) => (typeof t === "string" ? Date.parse(t) || 0 : 0);
const isRec = (r: any) => r && typeof r === "object" && typeof r.type === "string" && r.data && typeof r.data === "object";

type Entry = { id: string; log: string; dir?: string; mtime: number; size: number };

function entries(): Entry[] {
  const root = stateDir();
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: Entry[] = [];
  for (const n of names) {
    const p = join(root, n);
    try {
      const s = statSync(p);
      if (s.isDirectory()) {
        const log = join(p, "events.jsonl");
        const l = statSync(log, { throwIfNoEntry: false });
        if (l?.isFile()) out.push({ id: n, log, dir: p, mtime: Math.max(l.mtimeMs, statSync(join(p, "workspace.yaml"), { throwIfNoEntry: false })?.mtimeMs ?? 0), size: l.size });
      } else if (s.isFile() && /\.jsonl$/.test(n)) out.push({ id: n.replace(/\.jsonl$/, ""), log: p, mtime: s.mtimeMs, size: s.size });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LISTED_MAX);
}

function workspace(dir?: string): Record<string, any> {
  if (!dir) return {};
  try {
    const y = Bun.YAML.parse(readFileSync(join(dir, "workspace.yaml"), "utf8"));
    return y && typeof y === "object" ? (y as Record<string, any>) : {};
  } catch { return {}; }
}

// A prompt the owner typed (not a skill's hidden text).
const owners = (r: any): string | undefined => (r?.type === "user.message" && typeof r.data?.content === "string" && r.data.content.trim() && !String(r.data.source ?? "").startsWith("skill-") ? r.data.content.trim() : undefined);

export function copilotFound(e: Entry): Found | null {
  const start = scanFor(e.log, (r) => (r?.type === "session.start" ? r : undefined));
  const ws = workspace(e.dir);
  const id = typeof start?.data?.sessionId === "string" ? start.data.sessionId : typeof ws.id === "string" ? ws.id : e.id;
  const first = scanFor(e.log, owners);
  const last = scanBack(e.log, owners);
  const model = scanBack(e.log, (r) => (r?.type === "assistant.message" && !r.agentId && typeof r.data?.model === "string" ? r.data.model : undefined))
    ?? (typeof start?.data?.selectedModel === "string" && start.data.selectedModel !== "auto" ? start.data.selectedModel : undefined);
  const cwd = typeof start?.data?.context?.cwd === "string" ? start.data.context.cwd : typeof ws.cwd === "string" ? ws.cwd : undefined;
  const named = [ws.name, ws.summary].find((t) => typeof t === "string" && t.trim());
  const parent = start?.data?.detachedFromSpawningParentSessionId;
  return {
    harness: "copilot", id, path: e.log, ...(cwd ? { cwd } : {}),
    title: clip(named ?? first ?? id, 120),
    first_prompt: first ? clip(first) : undefined, last_prompt: last ? clip(last) : undefined,
    updated_ms: Math.max(timeMs(ws.updated_at), Math.round(e.mtime)), size_bytes: e.size,
    ...(model ? { model } : {}),
    kind: typeof parent === "string" ? "subagent" : "interactive",
    ...(typeof parent === "string" ? { parent_id: parent } : {}),
  };
}

const known = new Map<string, { size: number; mtime: number; found: Found | null }>();
let pendingCount = 0;

export function copilotSessions(budgetMs = BUDGET_MS): Found[] {
  const until = performance.now() + budgetMs;
  const out: Found[] = [];
  const files = entries();
  let pending = 0;
  for (const f of files) {
    const k = known.get(f.log);
    let found: Found | null;
    if (k && k.size === f.size && k.mtime === f.mtime) found = k.found;
    else if (performance.now() > until) { pending++; if (k?.found) out.push(k.found); continue; }
    else {
      found = null;
      try { found = copilotFound(f); } catch {}
      known.set(f.log, { size: f.size, mtime: f.mtime, found });
    }
    if (found) out.push(found);
  }
  pendingCount = pending;
  const listed = new Set(files.map((f) => f.log));
  const root = stateDir();
  for (const p of known.keys()) if (p.startsWith(root) && !listed.has(p)) known.delete(p);
  return out;
}

// The session's records, oldest first: a rotated head's archives first (each archive may itself link back).
function journal(log: string, notes: string[]): { records: any[]; lines: ReturnType<typeof readLines>[] } {
  const texts: string[] = [];
  const seen = new Set<string>();
  let path = log;
  let missing = false;
  for (;;) {
    seen.add(path);
    let text = "";
    try { text = readFileSync(path, "utf8"); } catch { break; }
    texts.unshift(text);
    let link: unknown;
    const nl = text.indexOf("\n");
    try { const r = JSON.parse(nl < 0 ? text : text.slice(0, nl)); link = r?.type === "session.journal_link" ? r.data?.previousFile : undefined; } catch {}
    if (typeof link !== "string") break;
    const prev = join(dirname(path), basename(link));
    if (seen.has(prev)) break;
    if (!existsSync(prev)) { missing = true; break; }
    path = prev;
  }
  if (missing) notes.push("The log was rotated and its older archive is missing: the replay checkpoint at the start of what remains stands in for it.");
  const lines = texts.map(readLines);
  // A later file's replay checkpoint repeats what the archive before it holds.
  const records = lines.flatMap((l, i) => l.records.filter((r) => isRec(r) && !(r.checkpoint === true && i > 0)));
  return { records, lines };
}

// The records a rewind left in place: it removes the events it names (or every event from the first one on).
function afterRewinds(records: any[]): any[] {
  const kept: any[] = [];
  for (const r of records) {
    if (r.type !== "session.snapshot_rewind") { kept.push(r); continue; }
    const ids = Array.isArray(r.data.eventIds) ? new Set<string>(r.data.eventIds) : undefined;
    if (ids) { for (let i = kept.length - 1; i >= 0; i--) if (ids.has(kept[i].id)) kept.splice(i, 1); continue; }
    const from = kept.findIndex((x) => x.id === r.data.upToEventId);
    if (from >= 0) kept.length = from;
  }
  return kept;
}

type Asset = { media_type: string; data: string };

function imageOf(mime: unknown, data: unknown): any | undefined {
  return typeof data === "string" && data && typeof mime === "string" && mime.startsWith("image/") ? { type: "image", media_type: mime, data } : undefined;
}

// What a tool's result gave the model: its text, and the images it returned.
function resultOf(d: any, assets: Map<string, Asset>): { content: string | any[]; is_error: boolean } {
  const failed = d.success === false || !!d.error;
  const text = typeof d.result?.content === "string" && d.result.content ? d.result.content : typeof d.error?.message === "string" ? d.error.message : "";
  const parts: any[] = [];
  const binary: any[] = Array.isArray(d.result?.binaryResultsForLlm) ? d.result.binaryResultsForLlm : [];
  const contents: any[] = Array.isArray(d.result?.contents) ? d.result.contents.filter((c: any) => c?.type === "image") : [];
  for (const b of binary.length ? binary : contents) {
    const a = typeof b?.assetId === "string" ? assets.get(b.assetId) : undefined;
    const img = imageOf(b?.mimeType, b?.data) ?? (a ? { type: "image", ...a } : undefined);
    parts.push(img ?? unavailable(b?.type === "image" || String(b?.mimeType ?? "").startsWith("image/") ? "image the log does not hold" : `${b?.type ?? "binary"} result${b?.mimeType ? ` (${b.mimeType})` : ""}`));
  }
  if (!parts.length) return { content: text, is_error: failed };
  return { content: [...(text ? [{ type: "text", text }] : []), ...parts], is_error: failed };
}

export async function readCopilot(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const { records: all, lines } = journal(f.path, notes);
  const records = afterRewinds(all);
  const rewound = all.filter((r) => r.type !== "session.snapshot_rewind").length - records.length;
  // The bytes of attached images, the ends of calls, and the calls that were asked for.
  const assets = new Map<string, Asset>();
  const done = new Map<string, any>();
  const asked = new Set<string>();
  records.forEach((r) => {
    if (r.type === "session.binary_asset") {
      const m = imageOf(r.data.mimeType, r.data.data);
      if (m && typeof r.data.assetId === "string") assets.set(r.data.assetId, { media_type: m.media_type, data: m.data });
    } else if (r.agentId) return;
    else if (r.type === "tool.execution_complete" && typeof r.data.toolCallId === "string" && !done.has(r.data.toolCallId)) done.set(r.data.toolCallId, r);
    else if (r.type === "assistant.message") { for (const t of r.data.toolRequests ?? []) if (typeof t?.toolCallId === "string") asked.add(t.toolCallId); }
  });

  let agentEvents = 0, skillPrompts = 0, attachmentsLeft = 0, errors = 0, clears = 0, subagents = 0, truncations = 0;
  let reasoningPending = false;
  const models = new Set<string>();
  // Cut by the owner's stop: an abort comes before the next prompt.
  const cancelled = (at: number) => { const j = records.findIndex((x, k) => k > at && !x.agentId && (x.type === "abort" || x.type === "user.message")); return j >= 0 && records[j].type === "abort"; };
  const callResult = (id: string, at: number, ts: number) => {
    const c = done.get(id);
    if (c) b.result({ tool_use_id: id, ...resultOf(c.data, assets) }, timeMs(c.timestamp) || ts);
    else b.result({ tool_use_id: id, content: cancelled(at) ? "The call was cancelled." : "No result was recorded for this call.", is_error: true }, ts);
  };

  records.forEach((r, i) => {
    const d = r.data;
    const ts = timeMs(r.timestamp) || f.updated_ms;
    if (r.agentId) { agentEvents++; return; }
    switch (r.type) {
      case "user.message": {
        if (String(d.source ?? "").startsWith("skill-")) { skillPrompts++; return; }
        const images: any[] = [];
        for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
          const m = typeof a?.assetId === "string" ? assets.get(a.assetId) : undefined;
          const img = m ? { type: "image", ...m } : a?.type === "blob" ? imageOf(a.mimeType, a.data) : undefined;
          if (img) images.push(img); else attachmentsLeft++;
        }
        b.user(typeof d.content === "string" ? d.content : "", ts, images);
        return;
      }
      case "assistant.message": {
        if (d.reasoningText || d.reasoningOpaque || d.encryptedContent || d.reasoningBlocks) { if (!reasoningPending) b.counts.thoughts_dropped++; }
        reasoningPending = false;
        const calls = (Array.isArray(d.toolRequests) ? d.toolRequests : []).filter((t: any) => t && typeof t.name === "string" && typeof t.toolCallId === "string");
        const text = typeof d.content === "string" ? d.content : "";
        const blocks: any[] = text.trim() ? [{ type: "text", text }] : [];
        for (const t of calls) blocks.push({ type: "tool_use", id: t.toolCallId, name: t.name, input: t.arguments && typeof t.arguments === "object" ? t.arguments : {} });
        if (typeof d.model === "string") models.add(d.model);
        b.assistant(blocks, ts, typeof d.model === "string" ? d.model : undefined, true);
        for (const t of calls) callResult(t.toolCallId, i, ts);
        return;
      }
      case "assistant.reasoning": b.counts.thoughts_dropped++; reasoningPending = true; return;
      case "tool.execution_start":
        // A call the user asked for outright has no assistant request: it stands as a reply of its own.
        if (typeof d.toolCallId !== "string" || asked.has(d.toolCallId) || typeof d.toolName !== "string") return;
        asked.add(d.toolCallId);
        b.assistant([{ type: "tool_use", id: d.toolCallId, name: d.toolName, input: d.arguments && typeof d.arguments === "object" ? d.arguments : {} }], ts, undefined, true);
        callResult(d.toolCallId, i, ts);
        return;
      case "session.compaction_complete":
        if (d.success && typeof d.summaryContent === "string" && d.summaryContent.trim()) b.compacted(d.summaryContent, ts, typeof d.trigger === "string" ? { trigger: d.trigger } : {});
        return;
      case "session.context_cleared": clears++; b.note(`Copilot CLI cleared its context here${typeof d.messagesCleared === "number" ? ` (${d.messagesCleared} messages)` : ""}: what follows did not see what came before.`, ts); return;
      case "session.truncation": truncations++; return;
      case "abort": b.interrupted(); return;
      case "session.error": errors++; return;
      case "subagent.started": subagents++; return;
      default: return; // usage, fusion, permission, mode, model and tool bookkeeping
    }
  });

  b.counts.skipped = agentEvents + skillPrompts;
  for (const l of lines) notes.push(...damageNotes(l));
  const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning block${s(b.counts.thoughts_dropped, " is", "s are")} not carried: another model's thinking is not sent to this one, and Copilot CLI keeps most of it encrypted.`);
  if (agentEvents || subagents) notes.push(`${subagents} sub-agent run${s(subagents, "", "s")}: ${agentEvents} event${s(agentEvents, "", "s")} of their own steps ${s(agentEvents, "is", "are")} left out; the answer each gave is in the result of the call that started it.`);
  if (skillPrompts) notes.push(`${skillPrompts} skill text${s(skillPrompts, "", "s")} Copilot CLI added to the prompt ${s(skillPrompts, "is", "are")} not the owner's words and ${s(skillPrompts, "is", "are")} left out.`);
  if (attachmentsLeft) notes.push(`${attachmentsLeft} attachment${s(attachmentsLeft, "", "s")} (files, folders, selections, references) named in a prompt ${s(attachmentsLeft, "is", "are")} not carried: the log holds their names, not what the model read.`);
  if (rewound) notes.push(`${rewound} event${s(rewound, "", "s")} the session rewound ${s(rewound, "is", "are")} left out, as Copilot CLI left them out.`);
  if (errors) notes.push(`${errors} error${s(errors, "", "s")} Copilot CLI recorded (a quota or a refused request, for example) ${s(errors, "is", "are")} not part of the conversation.`);
  if (truncations) notes.push(`Copilot CLI shortened the context it sent ${truncations} time${s(truncations, "", "s")}; the whole conversation is carried.`);
  if (clears) notes.push(`The context was cleared ${clears} time${s(clears, "", "s")}.`);
  if (models.size > 1) notes.push(`The session used ${[...models].join(", ")}.`);
  notes.push("The system prompt Copilot CLI wrote is not carried; Keel writes its own.");
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const copilotStore: SideStore = {
  harness: "copilot",
  label: "GitHub Copilot CLI",
  store: copilotHome,
  list: () => copilotSessions(),
  pending: () => pendingCount,
  read: readCopilot,
};
