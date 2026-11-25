// Kimi Code (the `kimi` command, 2.x; the Python Kimi CLI that kept ~/.kimi/sessions/*/context.jsonl is
// archived and not read): sessions under ~/.kimi-code/sessions/<project>/session_<id>/, where <project> is
// `wd_<folder name>_<hash>`. A session folder holds `state.json` (id, cwd, title, isCustomTitle, lastPrompt,
// archived, createdAt and updatedAt in ms, agents: main and sub-agents), `agents/<agent>/wire.jsonl` (main,
// and agent-N for each sub-agent), `media/` (an image or file a message carries by a `kimi-file://<id>`
// reference, with `media/meta/<id>.json` naming its file and type), `logs/` and `notify/`.
// ~/.kimi-code/session_index.jsonl lists the folders and is not needed: the folders are walked.
//
// A wire is one JSON record a line, each with `type`, `time` (ms) and `agentId`: `metadata` first
// (protocol_version 1.5), then the context stream the model's history is rebuilt from, as Kimi Code's own
// reader does: `context.append_message` (a user message with an `origin`: user, skill_activation,
// plugin_command, system_trigger, task, shell_command, hook_result, cron_job, injection), and
// `context.append_loop_event` with `step.begin`, `content.part` (text, think, image_url), `tool.call`,
// `tool.result` (output as text or parts, isError) and `step.end`; a message that arrives while a step's
// calls wait for their results is held until they are in, and a call with no result by the step's end is
// given an interrupted one. Also `context.apply_compaction` (the summary the model reads from then on),
// `context.clear`, `context.undo` (the last N owner turns are gone), `llm.request` (the model of a step),
// `turn.ended`, `subagent.*` and bookkeeping (usage, tokens, tools, permission, files). `agent.message.appended`
// repeats the messages with usage and is not read.
//
// Source: github.com/MoonshotAI/kimi-code (apps/vis/server/src/lib/context-projector.ts,
// packages/agent-core-v2 agent/contextMemory, agent/media, wire), docs/en/configuration/overrides.md
// (main, 2026-11-23), checked against wires written by Kimi Code 2.3.x. Nothing here writes.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { damageNotes, readLines, scanBack, scanFor } from "./files.ts";
import { Builder, clip, unavailable, type Found, type Read } from "./types.ts";
import type { SideStore } from "./more.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const kimiHome = () => process.env.KEEL_IMPORT_KIMI_DIR ?? ownerEnv("KIMI_CODE_HOME") ?? join(ownerHome(), ".kimi-code");

const LISTED_MAX = 600;
const BUDGET_MS = 150;
const INTERRUPTED = "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.";

type Entry = { sid: string; agent: string; dir: string; log: string; mtime: number; size: number };

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; }
}

function entries(): Entry[] {
  const root = join(kimiHome(), "sessions");
  const out: Entry[] = [];
  let buckets: string[] = [];
  try { buckets = readdirSync(root); } catch { return []; }
  for (const bk of buckets) {
    let names: string[] = [];
    try { names = readdirSync(join(root, bk)); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("session_")) continue;
      const dir = join(root, bk, n);
      let agents: string[] = [];
      try { agents = readdirSync(join(dir, "agents")); } catch { continue; }
      for (const a of agents) {
        const log = join(dir, "agents", a, "wire.jsonl");
        const s = statSync(log, { throwIfNoEntry: false });
        if (s?.isFile()) out.push({ sid: n, agent: a, dir, log, mtime: s.mtimeMs, size: s.size });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LISTED_MAX);
}

// What the owner or a trigger said, as a wire record holds it (not Kimi's own reminders).
const ASKS = new Set(["user", "skill_activation", "plugin_command", "system_trigger", "cron_job"]);
const textOfParts = (c: unknown) => (Array.isArray(c) ? c.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n") : "");
const asked = (r: any): string | undefined => {
  if (r?.type !== "context.append_message" || r.message?.role !== "user" || !ASKS.has(r.message.origin?.kind ?? "user")) return undefined;
  const t = textOfParts(r.message.content).trim();
  return t || undefined;
};
const modelOf = (r: any): string | undefined => (r?.type === "llm.request" && typeof r.model === "string" && r.model ? r.model : undefined);
const aliasOf = (r: any): string | undefined => ((r?.type === "profile.bind" || r?.type === "config.update") && typeof r.modelAlias === "string" ? r.modelAlias.replace(/^[^/]*\//, "") : undefined);

export function kimiFound(e: Entry): Found | null {
  const state = readJson(join(e.dir, "state.json")) ?? {};
  const sid = typeof state.id === "string" ? state.id : e.sid;
  const first = scanFor(e.log, asked);
  const last = scanBack(e.log, asked);
  const model = scanBack(e.log, modelOf) ?? scanFor(e.log, aliasOf);
  const main = e.agent === "main";
  const named = main && typeof state.title === "string" && state.title.trim() ? state.title : undefined;
  return {
    harness: "kimi", id: main ? sid : `${sid}:${e.agent}`, path: e.log,
    ...(typeof state.cwd === "string" ? { cwd: state.cwd } : {}),
    title: clip(named ?? first ?? sid, 120),
    first_prompt: first ? clip(first) : undefined, last_prompt: last ? clip(last) : undefined,
    updated_ms: Math.max(typeof state.updatedAt === "number" ? state.updatedAt : Date.parse(state.updatedAt) || 0, Math.round(e.mtime)), size_bytes: e.size,
    ...(model ? { model } : {}),
    kind: main ? "interactive" : "subagent",
    ...(main ? {} : { parent_id: sid }),
    ...(state.archived === true ? { archived: true } : {}),
  };
}

const known = new Map<string, { size: number; mtime: number; found: Found | null }>();
let pendingCount = 0;

export function kimiSessions(budgetMs = BUDGET_MS): Found[] {
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
      try { found = kimiFound(f); } catch {}
      known.set(f.log, { size: f.size, mtime: f.mtime, found });
    }
    if (found) out.push(found);
  }
  pendingCount = pending;
  const listed = new Set(files.map((f) => f.log));
  const root = join(kimiHome(), "sessions");
  for (const p of known.keys()) if (p.startsWith(root) && !listed.has(p)) known.delete(p);
  return out;
}

// An image a message holds: bytes in `media/` by `kimi-file://<id>`, inline as a data URL, or elsewhere.
function imageOf(url: unknown, media: string, left: { n: number }): any {
  if (typeof url !== "string") return unavailable("image");
  const data = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (data) return { type: "image", media_type: data[1]!, data: data[2]! };
  const ref = url.match(/^kimi-file:\/\/([A-Za-z0-9._-]+)$/);
  if (ref) {
    const id = ref[1]!;
    const meta = readJson(join(media, "meta", `${id}.json`));
    let file = typeof meta?.key === "string" ? join(media, basename(meta.key)) : "";
    if (!file || !existsSync(file)) {
      try { const f = readdirSync(media).find((n) => n.startsWith(`${id}.`)); file = f ? join(media, f) : ""; } catch { file = ""; }
    }
    const type = typeof meta?.mediaType === "string" ? meta.mediaType : /\.jpe?g$/i.test(file) ? "image/jpeg" : /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : /\.gif$/i.test(file) ? "image/gif" : "";
    if (file && type.startsWith("image/")) { try { return { type: "image", media_type: type, data: readFileSync(file).toString("base64") }; } catch {} }
    left.n++;
    return unavailable(`image ${id}, its file is not in the session's media folder`);
  }
  left.n++;
  return unavailable(`image at ${clip(url, 80)}`);
}

// A tool's output or a message's content as parts Keel stores; images and the kinds that cannot be carried named.
function partsOf(content: unknown, media: string, left: { n: number; other: Map<string, number> }): { text: string; parts: any[]; images: any[] } {
  const parts: any[] = [];
  const images: any[] = [];
  const text: string[] = [];
  if (typeof content === "string") { text.push(content); parts.push({ type: "text", text: content }); } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p?.type === "text" && typeof p.text === "string") { text.push(p.text); parts.push({ type: "text", text: p.text }); }
      else if (p?.type === "image_url") { const im = p.omitted ? unavailable(`image omitted by Kimi Code (${p.omitted})`) : imageOf(p.imageUrl?.url, media, left); (im.type === "image" ? images : parts).push(im); if (im.type === "image") parts.push(im); }
      else if (p?.type === "audio_url" || p?.type === "video_url") { const k = p.type === "audio_url" ? "audio" : "video"; left.other.set(k, (left.other.get(k) ?? 0) + 1); parts.push(unavailable(k)); }
    }
  }
  return { text: text.join("\n"), parts, images };
}

type Item =
  | { k: "user"; text: string; images: any[]; ts: number; anchor: boolean }
  | { k: "note"; text: string; ts: number; model: boolean }
  | { k: "assistant"; ts: number; parts: any[]; calls: { id: string; name: string; input: any }[]; thoughts: number; model?: string; interrupted?: boolean; uuid: string }
  | { k: "tool"; id: string; content: any; error: boolean; ts: number }
  | { k: "compaction"; summary: string; ts: number; trigger?: string };

const vacuous = (p: any) => (p.type === "text" ? typeof p.text !== "string" || !p.text.trim() : p.type === "think" ? p.encrypted === undefined && p.hidden !== true && !String(p.think ?? "").trim() : false);

export async function readKimi(f: Found): Promise<Read> {
  const b = new Builder();
  const notes: string[] = [];
  const text = await Bun.file(f.path).text();
  const lines = readLines(text);
  const media = join(f.path, "..", "..", "..", "media");
  const left = { n: 0, other: new Map<string, number>() };
  const items: Item[] = [];
  const anchors: Item[] = [];
  let injections = 0, skipped = 0, attachments = 0, subagents = 0, undos = 0, clears = 0, failedTurns = 0, keptUsers = 0, stepErrors = 0;
  let model = "";
  let compactTrigger: string | undefined;

  // The loop's fold, as Kimi Code writes it: an open assistant step, calls waiting for results, messages held behind them.
  let open: (Item & { k: "assistant" }) | undefined;
  let openStep: string | undefined;
  let openCalls = false, openVacuous = true;
  const blocks = new Map<number, number>();
  const pending = new Map<string, string>();
  let deferred: { item: Item; ts: number }[] = [];
  const push = (item: Item) => { items.push(item); if (item.k === "user" && item.anchor) anchors.push(item); };
  const flush = () => { if (pending.size || !deferred.length) return; for (const d of deferred) push(d.item); deferred = []; };
  const interrupted = (ts: number) => {
    if (!pending.size) return;
    for (const [id] of pending) if (!items.some((x) => x.k === "tool" && x.id === id)) items.push({ k: "tool", id, content: INTERRUPTED, error: true, ts });
    pending.clear();
    flush();
  };
  const settle = (ts: number) => {
    if (!open) return;
    interrupted(ts);
    if (!openCalls && openVacuous) { const i = items.indexOf(open); if (i >= 0) items.splice(i, 1); }
    else open.model = model || undefined;
    open = undefined; openStep = undefined;
  };
  const reset = () => { open = undefined; openStep = undefined; pending.clear(); deferred = []; blocks.clear(); };
  const message = (m: any, ts: number) => {
    const kind = m.origin?.kind ?? "user";
    let item: Item | undefined;
    if (m.role !== "user") { skipped++; return; }
    const { text: t, images } = partsOf(m.content, media, left);
    if (kind === "injection") { injections++; return; }
    if (kind === "compaction_summary") return;
    if (ASKS.has(kind)) {
      if (!t.trim() && !images.length) return;
      attachments += Array.isArray(m.origin?.attachments) ? m.origin.attachments.length : 0;
      item = { k: "user", text: t, images, ts, anchor: kind === "user" || (kind === "skill_activation" || kind === "plugin_command") && m.origin?.trigger === "user-slash" };
    } else {
      // Task notifications, shell commands, hooks: what the model was told, not what the owner said.
      if (!t.trim()) return;
      item = { k: "note", text: t, ts, model: true };
    }
    if (pending.size) deferred.push({ item, ts }); else push(item);
  };

  records: for (const r of lines.records) {
    if (!r || typeof r !== "object" || typeof r.type !== "string") continue;
    const ts = typeof r.time === "number" ? r.time : f.updated_ms;
    switch (r.type) {
      case "llm.request": if (modelOf(r)) model = r.model; break;
      case "profile.bind": case "config.update": if (!model && aliasOf(r)) model = aliasOf(r)!; break;
      case "full_compaction.begin": compactTrigger = typeof r.source === "string" ? r.source : undefined; break;
      case "context.append_message": if (r.message && typeof r.message === "object") message(r.message, ts); break;
      case "context.append_loop_event": {
        const e = r.event;
        if (!e || typeof e !== "object") break;
        if (e.type === "step.begin") {
          settle(ts);
          open = { k: "assistant", ts, parts: [], calls: [], thoughts: 0, uuid: String(e.uuid) };
          items.push(open); openStep = String(e.uuid); openCalls = false; openVacuous = true; blocks.clear();
        } else if (e.type === "step.end") { settle(ts); flush(); }
        else if (e.type === "content.part") {
          if (!open || e.stepUuid !== openStep || !e.part) break;
          const part = e.part;
          const at = typeof e.block === "number" ? blocks.get(e.block) : undefined;
          // A block written again (a partial reply, then the whole one) replaces the first.
          if (at !== undefined) open.parts[at] = part; else { if (typeof e.block === "number") blocks.set(e.block, open.parts.length); open.parts.push(part); }
          openVacuous = open.parts.every(vacuous);
        } else if (e.type === "tool.call") {
          if (!open || e.stepUuid !== openStep || typeof e.toolCallId !== "string" || typeof e.name !== "string") break;
          let input = e.args;
          if (input === undefined && typeof e.argsRaw === "string") { try { input = JSON.parse(e.argsRaw); } catch {} }
          open.calls.push({ id: e.toolCallId, name: e.name, input: input && typeof input === "object" ? input : {} });
          pending.set(e.toolCallId, e.name); openCalls = true;
        } else if (e.type === "tool.result") {
          if (!pending.has(e.toolCallId)) break;
          pending.delete(e.toolCallId);
          const { parts } = partsOf(e.result?.output, media, left);
          const content = parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts.length ? parts : "";
          items.push({ k: "tool", id: e.toolCallId, content, error: e.result?.isError === true, ts });
          flush();
        }
        break;
      }
      case "context.apply_compaction": {
        settle(ts); reset();
        const s = typeof r.contextSummary === "string" && r.contextSummary.trim() ? r.contextSummary : typeof r.summary === "string" ? r.summary : textOfParts(r.summary?.content);
        if (!s.trim()) break;
        if (typeof r.keptUserMessageCount === "number") keptUsers = Math.max(keptUsers, r.keptUserMessageCount);
        items.push({ k: "compaction", summary: s, ts, trigger: compactTrigger });
        anchors.length = 0;
        break;
      }
      case "context.clear":
        settle(ts); reset(); clears++; anchors.length = 0;
        items.push({ k: "note", text: "Kimi Code cleared its context here: what follows did not see what came before.", ts, model: false });
        break;
      case "context.undo": {
        settle(ts); reset();
        const n = typeof r.count === "number" ? r.count : 0;
        if (n < 1 || n > anchors.length) break;
        const cut = items.indexOf(anchors[anchors.length - n]!);
        if (cut < 0) break;
        items.length = cut;
        anchors.length = anchors.length - n;
        undos++;
        break;
      }
      case "turn.ended": {
        if (r.reason === "failed") failedTurns++;
        else if (typeof r.reason === "string" && /^(cancel|abort|interrupt)/.test(r.reason)) {
          settle(ts);
          const a = items.findLast((x) => x.k === "assistant");
          if (a?.k === "assistant") a.interrupted = true;
        }
        break;
      }
      case "turn.step.interrupted": stepErrors++; break;
      case "subagent.spawned": subagents++; break;
      default: break;
    }
    continue records;
  }
  settle(f.updated_ms);

  for (const it of items) {
    if (it.k === "user") b.user(it.text, it.ts, it.images);
    else if (it.k === "note") b.note(it.text, it.ts, it.model);
    else if (it.k === "compaction") b.compacted(it.summary, it.ts, it.trigger ? { trigger: it.trigger } : {});
    else if (it.k === "tool") b.result({ tool_use_id: it.id, content: it.content, is_error: it.error }, it.ts);
    else {
      const bl: any[] = [];
      for (const p of it.parts) {
        if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) bl.push({ type: "text", text: p.text });
        else if (p?.type === "think") b.counts.thoughts_dropped++;
      }
      for (const c of it.calls) bl.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      b.assistant(bl, it.ts, it.model, true);
      if (it.interrupted) b.interrupted();
    }
  }

  b.counts.skipped = injections + skipped;
  notes.push(...damageNotes(lines));
  const s = (n: number, one: string, many: string) => (n === 1 ? one : many);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning block${s(b.counts.thoughts_dropped, " is", "s are")} not carried: another model's thinking is not sent to this one.`);
  if (injections) notes.push(`${injections} reminder${s(injections, "", "s")} Kimi Code added to the context (date, folder, mode) ${s(injections, "is", "are")} not the owner's words and ${s(injections, "is", "are")} left out.`);
  if (subagents) notes.push(`${subagents} sub-agent run${s(subagents, "", "s")}: each is a row of its own, and its answer is in the result of the call that started it.`);
  if (attachments) notes.push(`${attachments} attachment${s(attachments, "", "s")} (files named in a prompt) ${s(attachments, "is", "are")} not carried: the wire holds their names, not what the model read.`);
  if (left.n) notes.push(`${left.n} image${s(left.n, "", "s")} could not be read from the session's media folder and ${s(left.n, "is", "are")} named instead.`);
  for (const [k, n] of left.other) notes.push(`${n} ${k} file${s(n, " is", "s are")} not carried.`);
  if (undos) notes.push(`${undos} undo${s(undos, "", "s")} removed turns from the context; they are left out, as Kimi Code left them out.`);
  if (clears) notes.push(`The context was cleared ${clears} time${s(clears, "", "s")}.`);
  if (keptUsers) notes.push(`A compaction kept the ${keptUsers} latest user messages beside its summary; they stand before it in the history.`);
  if (failedTurns || stepErrors) notes.push(`${failedTurns} turn${s(failedTurns, "", "s")} ended with an error${stepErrors ? ` (${stepErrors} step${s(stepErrors, "", "s")} stopped on one)` : ""}; the errors are not part of the conversation.`);
  notes.push("The system prompt Kimi Code wrote is not carried; Keel writes its own.");
  return { found: f, events: b.events, counts: b.counts, notes };
}

export const kimiStore: SideStore = {
  harness: "kimi",
  label: "Kimi Code",
  store: kimiHome,
  list: () => kimiSessions(),
  pending: () => pendingCount,
  read: readKimi,
};
