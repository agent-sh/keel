// A session leaves keel-bun as a file to read (Markdown), as JSON lines another
// keel-bun imports (a header line, then one event a line), or as a new
// transcript in Claude Code's or Codex's own store so that harness resumes it
// (`claude --resume <id>`, `codex resume <id>`). Writing into another store
// only ever adds a new file under a new id; nothing there is replaced.
import { linkSync, mkdirSync, openSync, rmSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { EVENT_REFS } from "../core/store.ts";
import type { EventKind, Session, StoredEvent } from "../core/types.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { claudeRoot } from "./import/claude.ts";
import { codexHome } from "./import/codex.ts";
import { FAILED_LABEL, NOTE_CLOSE, NOTE_OPEN } from "./import/types.ts";
import { INPUT_LABEL, inputKind } from "../core/inputs.ts";
import { ownerPrompt } from "../core/owner.ts";
import { checkpointAt } from "../engine/compact.ts";
import { ATTACHMENT_MAX } from "../engine/attachments.ts";
import { keelFileBytes, sizeText } from "../core/keel-file.ts";
import { shq } from "../tools/shell.ts";

export const EXPORT_VERSION = 2;

// A part with no text of its own is named: a tool a search loaded by its name.
const partText = (b: any): string => (b.type === "text" ? b.text : b.type === "tool_reference" ? `[loaded tool ${b.tool_name}]` : `[${b.type}]`);
const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map(partText).join("\n") : "");

// A code block no line of `text` can close: its fence is longer than any run of
// backticks inside (CommonMark), so a README with its own fences stays inside.
export function fenced(text: string, lang = ""): string {
  const run = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(run + 1);
  return text ? `${f}${lang}\n${text}\n${f}` : `${f}${lang}\n${f}`;
}

// A long result keeps its head and its tail (where a failure usually is), and says what is left out.
export const MD_RESULT_MAX = 20_000;
function clipped(text: string): string {
  if (text.length <= MD_RESULT_MAX) return text;
  const half = MD_RESULT_MAX / 2;
  return `${text.slice(0, half)}\n[${text.length - MD_RESULT_MAX} characters left out here; the Keel file keeps the whole result]\n${text.slice(-half)}`;
}

// What a stored turn ending says to a reader, when it is not a normal end.
const ENDING: Record<string, string> = {
  interrupted: "Stopped before completion by the owner.",
  restart: "Cut short by a daemon restart.",
  error: "The turn failed before completion.",
  max_steps: "Stopped at the session's step budget.",
  max_tokens: "Cut at the output limit.",
};

// What a prompt carried that a text file does not.
function carried(d: any): string {
  const blocks: any[] = d.images ?? [];
  const images = blocks.filter((b) => b.type === "image").length;
  const files = blocks.filter((b) => b.type === "attachment").map((b) => b.name);
  const parts = [images ? `${images} image${images === 1 ? "" : "s"}` : "", files.length ? `${files.length === 1 ? "file" : "files"} ${files.join(", ")}` : ""].filter(Boolean);
  return parts.length ? `*${parts.join(" and ")} attached; not included in this file.*` : "";
}

export type MarkdownOpts = { otherBranches?: number };

export function toMarkdown(s: Session, events: StoredEvent[], include: Set<string>, opts: MarkdownOpts = {}): string {
  const out = [`# ${s.title || "Session"}`, "", `Folder: \`${s.workspace}\` · Selected for the next turn: ${s.model} · ${new Date(s.created).toISOString().slice(0, 16).replace("T", " ")}`, ""];
  if (opts.otherBranches) out.push(`*The current branch only: ${opts.otherBranches} other branch${opts.otherBranches === 1 ? "" : "es"} stay${opts.otherBranches === 1 ? "s" : ""} in the session.*`, "");
  // Calls are numbered in the file; a result names its call by that number.
  const calls = new Map<string, { n: number; name: string }>();
  let answeredBy: string | undefined | null = null; // null: no reply yet
  for (const e of events) {
    if (e.kind === "user") {
      const input = inputKind(e.data);
      out.push(input ? `## ${INPUT_LABEL[input]}` : "## Owner", "");
      if (e.data.text) out.push(e.data.text, "");
      const extra = carried(e.data);
      if (extra) out.push(extra, "");
    } else if (e.kind === "assistant") {
      const parts: string[] = [];
      for (const b of e.data.blocks ?? []) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "thinking" && include.has("reasoning")) parts.push(`> ${String(b.thinking).replace(/\n/g, "\n> ")}`);
        else if (b.type === "tool_use" && include.has("tools")) {
          const n = calls.size + 1;
          calls.set(b.id, { n, name: b.name });
          parts.push(`**Call ${n}: ${b.name}**\n\n` + fenced(JSON.stringify(b.input ?? {}, null, 1), "json"));
        }
      }
      if (!parts.length) continue;
      // Who answered: said on the first reply and again whenever it changes.
      const model: string | undefined = e.data.model;
      const by = answeredBy === null || model !== answeredBy ? ` · answered by ${model ?? "an unknown model"}` : "";
      answeredBy = model;
      out.push(`## Keel${by}`, "", parts.join("\n\n"), "");
    } else if (e.kind === "tool_result" && include.has("tools")) {
      for (const r of e.data.results ?? []) {
        const c = calls.get(r.tool_use_id);
        const head = c ? `**Result of call ${c.n}: ${c.name}${r.is_error ? " (failed)" : ""}**` : `**Result of a call not in this file${r.is_error ? " (failed)" : ""}**`;
        out.push(head, "", fenced(clipped(textOf(r.content)), "text"), "");
      }
    } else if (e.kind === "turn_end" && ENDING[e.data.reason]) out.push(`*${ENDING[e.data.reason]}*`, "");
    else if (e.kind === "compaction" && e.data.summary) out.push("## Summary of the earlier conversation", "", e.data.summary, "");
  }
  return out.join("\n");
}

// An event's names of other events (a summary's `covered`, a clear's
// `undo_head`, a summary's `from_event` and `replaced_head`) through a map of
// ids; a name the map does not hold points outside what is copied and is dropped.
function renamed(data: any, to: (id: string) => string | undefined): any {
  if (!data || typeof data !== "object" || !EVENT_REFS.some((k) => typeof data[k] === "string")) return data;
  const out = { ...data };
  for (const k of EVENT_REFS) {
    if (typeof out[k] !== "string") continue;
    const id = to(out[k]);
    if (id) out[k] = id;
    else delete out[k];
  }
  return out;
}

// The Keel file: a header (with how many events follow, so a cut copy is
// caught), then one event a line. Events carry refs local to the file (e1, e2,
// ...), not the store's ids; an event that names another one of the file
// names it by its ref, and a name of an event outside the file is left out.
// With `blob` it is self-contained: each file the prompts name follows the
// events once, as a line of its own (its sha256 id, its size, its bytes in
// base64), however many prompts and names refer to it.
// With `tree` the events are the whole session, every branch: each line names
// its parent's ref, and the header the ref of the head shown (`tree.head`).
// A file larger than an import takes (`max`) is not written: with `size` (a
// stored file's bytes, known without reading it) that is found before any
// file is read.
export function toKeelJsonl(s: Session, events: StoredEvent[], opts: { blob?: (id: string) => Uint8Array | undefined; size?: (id: string) => number | undefined; max?: number; tree?: { head: string | null } } = {}): string {
  const ref = new Map(events.map((e, i) => [e.id, `e${i + 1}`]));
  const files = new Map<string, { id: string; name: string; size: number }>();
  for (const e of events) if (e.kind === "user") for (const b of e.data.images ?? []) if (b.type === "attachment") files.set(b.id, { id: b.id, name: b.name, size: b.size });
  const line = (e: StoredEvent) => ({ ref: ref.get(e.id), parent: opts.tree ? ref.get(e.parent ?? "") ?? null : undefined, kind: e.kind, data: renamed(e.data, (id) => ref.get(id)), ts: e.ts });
  const body = toJsonl(events.map(line));
  if (opts.max !== undefined) {
    const sizes = opts.blob ? [...files.values()].flatMap((f) => { const n = opts.size ? opts.size(f.id) : f.size; return n === undefined ? [] : [n]; }) : [];
    const total = keelFileBytes(Buffer.byteLength(body) + 300 * files.size, sizes);
    if (total > opts.max) throw new KeelFileTooLarge(total, sizes.reduce((a, b) => a + b, 0), opts.max);
  }
  const blobs: { blob: string; size: number; data: string }[] = [];
  if (opts.blob) for (const id of files.keys()) {
    const bytes = opts.blob(id);
    if (bytes) blobs.push({ blob: id, size: bytes.byteLength, data: Buffer.from(bytes).toString("base64") });
  }
  const header = { keel_export: EXPORT_VERSION, events: events.length, blobs: opts.blob ? blobs.length : undefined, scope: opts.tree ? "tree" : "current branch", head: opts.tree ? ref.get(opts.tree.head ?? "") ?? null : undefined, title: s.title, model: s.model, workspace: s.workspace, created: s.created, attachments: files.size ? [...files.values()] : undefined };
  return toJsonl([header]) + body + toJsonl(blobs);
}

// A Keel file no Keel would take: said with what it would weigh, before it is written.
export class KeelFileTooLarge extends Error {
  status = 413;
  constructor(readonly bytes: number, readonly files_bytes: number, readonly max: number) {
    super(files_bytes
      ? `with its attached files (${sizeText(files_bytes)} in all) the Keel file would be about ${sizeText(bytes)}, and another Keel takes at most ${sizeText(max)}: export it without the files`
      : `the Keel file would be about ${sizeText(bytes)}, and another Keel takes at most ${sizeText(max)}`);
  }
}

// `blobs`: the bytes a self-contained file carries, by their sha256 id, each
// checked against its id and size before the file is accepted.
export type ParsedExport = { ok: true; header: any; events: { ref?: string; parent?: string | null; kind: any; data: any; ts?: number }[]; blobs: Map<string, Uint8Array>; notes: string[] } | { ok: false; error: string };

export function parseKeelJsonl(text: string): ParsedExport {
  const lines = text.split("\n");
  let header: any;
  try { header = JSON.parse(lines[0] ?? ""); } catch { return { ok: false, error: "the body is not a Keel export" }; }
  if (header?.keel_export !== 1 && header?.keel_export !== EXPORT_VERSION) return { ok: false, error: "the body is not a Keel export" };
  const events: any[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    let e: any;
    try { e = JSON.parse(l); } catch { return { ok: false, error: `incomplete export: the record on line ${i + 1} is cut or unreadable` }; }
    if (typeof e?.blob === "string") {
      // A file is held to what an upload may be, before its bytes are decoded.
      if (!(e.size <= ATTACHMENT_MAX) || (typeof e.data === "string" && e.data.length > 4 * Math.ceil(ATTACHMENT_MAX / 3) + 4))
        return { ok: false, error: `the attached file on line ${i + 1} is larger than a file can be (${sizeText(ATTACHMENT_MAX)}), so nothing was imported` };
      // What the line says its bytes are is checked, never taken on its word.
      const bytes = typeof e.data === "string" && /^[0-9a-f]{64}$/.test(e.blob) ? new Uint8Array(Buffer.from(e.data, "base64")) : undefined;
      if (!bytes || bytes.byteLength !== e.size || new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== e.blob)
        return { ok: false, error: `the attached file on line ${i + 1} is damaged: its bytes do not match its digest, so nothing was imported` };
      blobs.set(e.blob, bytes);
      continue;
    }
    if (typeof e?.kind !== "string") return { ok: false, error: `the record on line ${i + 1} is not an event` };
    // An event is its kind and an object of data; what a prompt carries is a
    // list, and a file in it has a name a folder can hold. Refused here, so
    // nothing is stored for a file that would fail half way.
    if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) return { ok: false, error: `the event on line ${i + 1} has no data, so nothing was imported` };
    if (e.kind === "user" && e.data.images !== undefined) {
      if (!Array.isArray(e.data.images)) return { ok: false, error: `the prompt on line ${i + 1} does not list what it carries, so nothing was imported` };
      for (const b of e.data.images) {
        if (b?.type !== "attachment") continue;
        const name = typeof b.name === "string" ? b.name.trim() : "";
        if (typeof b.id !== "string" || !name || name === "." || name === ".." || (b.media_type !== undefined && typeof b.media_type !== "string") || (b.charset !== undefined && typeof b.charset !== "string"))
          return { ok: false, error: `the prompt on line ${i + 1} names a file without a usable name or id, so nothing was imported` };
      }
    }
    events.push(e);
  }
  const notes: string[] = [];
  if (header.keel_export === 1) notes.push("A version 1 file says nothing of its length: whether it is complete cannot be checked.");
  else if (header.events !== events.length) return { ok: false, error: `incomplete export: expected ${header.events} events, found ${events.length}` };
  if (header.blobs !== undefined && header.blobs !== blobs.size) return { ok: false, error: `incomplete export: expected ${header.blobs} attached files, found ${blobs.size}` };
  // A tree: every event has a ref of its own and a parent written before it, and the head is one of them.
  if (header.scope === "tree") {
    const seen = new Set<string>();
    for (const [i, e] of events.entries()) {
      if (typeof e.ref !== "string" || seen.has(e.ref)) return { ok: false, error: `the event on record ${i + 1} has no ref of its own, so the branches cannot be rebuilt` };
      if (e.parent != null && !seen.has(e.parent)) return { ok: false, error: `the event ${e.ref} follows ${e.parent}, which the file does not hold before it` };
      seen.add(e.ref);
    }
    if (header.head == null ? events.length > 0 : !seen.has(header.head)) return { ok: false, error: "the file does not say which of its branches is shown" };
  }
  // Bytes no prompt names are not stored for a file's saying so.
  const named = new Set<string>();
  for (const e of events) if (e.kind === "user") for (const b of e.data?.images ?? []) if (b?.type === "attachment") named.add(b.id);
  for (const id of blobs.keys()) if (!named.has(id)) return { ok: false, error: "the file carries bytes that none of its prompts names, so nothing was imported" };
  return { ok: true, header, events, blobs, notes };
}

// The events of a parsed Keel file as rows of a new session: new ids, and every
// name of another event follows that event to its new id. A version 1 file
// names a summary's covered event by its old id, which is kept as it is.
// A tree's rows name their parents and `head` is the branch shown; a branch's
// rows are a chain whose last event is the head.
export function rowsOf(parsed: Extract<ParsedExport, { ok: true }>, newId: () => string = () => Bun.randomUUIDv7()): { rows: { id: string; kind: EventKind; data: any; ts: number; parent?: string | null }[]; head?: string | null } {
  const ids = new Map<string, string>();
  const tree = parsed.header.scope === "tree";
  const rows = parsed.events.map((e) => {
    const id = newId();
    if (e.ref) ids.set(e.ref, id);
    return { id, kind: e.kind as EventKind, data: e.data, ts: Number.isFinite(e.ts) ? Number(e.ts) : Date.now(), ...(tree ? { parent: e.parent == null ? null : ids.get(e.parent)! } : {}) };
  });
  const v1 = parsed.header.keel_export === 1;
  for (const r of rows) r.data = renamed(r.data, (ref) => ids.get(ref) ?? (v1 && ref === r.data.covered ? ref : undefined));
  return tree ? { rows, head: parsed.header.head == null ? null : ids.get(parsed.header.head)! } : { rows };
}

// Claude Code wants tool ids of its own shape: each distinct source id gets one
// distinct id of that shape for the whole file, reused by its result.
function claudeIds() {
  const map = new Map<string, string>();
  const used = new Set<string>();
  return (id: string) => {
    let out = map.get(id);
    if (out) return out;
    const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
    out = (clean.startsWith("toolu_") ? clean : `toolu_${clean}`).slice(0, 64);
    if (used.has(out)) {
      let n = 1;
      while (used.has(`toolu_keel${n}`)) n++;
      out = `toolu_keel${n}`;
    }
    map.set(id, out);
    used.add(out);
    return out;
  };
}

export function forClaude(events: StoredEvent[]): StoredEvent[] {
  const idOf = claudeIds();
  return events.map((e) => {
    if (e.kind === "assistant")
      return { ...e, data: { ...e.data, blocks: (e.data.blocks ?? []).filter((b: any) => b.type !== "thinking" && b.type !== "redacted_thinking").map((b: any) => (b.type === "tool_use" ? { ...b, id: idOf(b.id) } : b)) } };
    if (e.kind === "tool_result") return { ...e, data: { results: e.data.results.map((r: any) => ({ ...r, tool_use_id: idOf(r.tool_use_id) })) } };
    return e;
  });
}

// What a session's next request is built from: from its last checkpoint on (a
// clear drops what came before it, a summary stands for it), as toMessages
// does. A handoff to resume elsewhere carries this, not the whole history.
export function activeContext(events: StoredEvent[]): StoredEvent[] {
  const cp = checkpointAt(events);
  if (cp.at < 0) return events;
  const kept = events.slice(cp.keepFrom).filter((e) => e.kind !== "compaction");
  return events[cp.at]!.data.mode === "summary" ? [events[cp.at]!, ...kept] : kept;
}

export function toCodexRollout(s: Session, events: StoredEvent[], id: string, now: number): string {
  const out: unknown[] = [];
  const line = (ts: number, type: string, payload: unknown) => out.push({ timestamp: new Date(ts).toISOString(), type, payload });
  // Codex restores model history from response items, but replays the visible
  // transcript from event messages (app-server-protocol's ThreadHistoryBuilder).
  const display = (ts: number, type: string, fields: object) => line(ts, "event_msg", { type, ...fields });
  let turnId: string | undefined;
  const finish = (ts: number, interrupted = false) => {
    if (interrupted) display(ts, "turn_aborted", { turn_id: turnId, reason: "interrupted" });
    else if (turnId) display(ts, "task_complete", { turn_id: turnId });
    turnId = undefined;
  };
  const begin = (e: StoredEvent) => {
    turnId = e.id;
    display(e.ts, "task_started", { turn_id: turnId });
  };
  const start = events[0]?.ts ?? now;
  line(start, "session_meta", { id, timestamp: new Date(start).toISOString(), cwd: s.workspace, originator: "keel", cli_version: "0.0.0", source: "cli" });
  const custom = new Set<string>();
  let model: string | undefined;
  let prev = start;
  for (const e of events) {
    if (e.kind === "user") {
      const images: string[] = (e.data.images ?? []).filter((b: any) => b.type === "image").map((b: any) => `data:${b.media_type};base64,${b.data}`);
      const text = e.data.text ?? "";
      // inputKind also recognizes older peer deliveries with only a text envelope.
      const visible = (!!text || images.length > 0) && ownerPrompt(e.data) && !inputKind(e.data);
      if (visible) {
        // Codex rollback cuts at user response items, including steers within
        // one Keel turn. Give each visible prompt its own boundary. Hidden
        // harness inputs still carry their original model-side boundaries.
        finish(prev);
      }
      // A hidden continuation still starts the model's turn. Starting at its
      // reply instead would split the input from the restored model settings.
      if (!turnId) begin(e);
      line(e.ts, "response_item", { type: "message", role: "user", content: [...images.map((image_url) => ({ type: "input_image", image_url })), ...(text ? [{ type: "input_text", text }] : [])] });
      if (visible) display(e.ts, "user_message", { message: text, images: images.length ? images : undefined });
    } else if (e.kind === "compaction" && e.data.summary) {
      finish(prev);
      begin(e);
      line(e.ts, "compacted", { message: e.data.summary });
      display(e.ts, "agent_message", { message: `Summary of the earlier conversation (Keel)\n\n${e.data.summary}` });
      finish(e.ts);
    } else if (e.kind === "turn_end") finish(e.ts, e.data.reason === "interrupted" || e.data.reason === "restart");
    else if (e.kind === "note" && e.data.model) line(e.ts, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `${NOTE_OPEN}\n${e.data.text}\n${NOTE_CLOSE}` }] });
    else if (e.kind === "assistant") {
      const blocks = e.data.blocks ?? [];
      // Who answered: Codex reads the model of each turn from its turn context.
      if (e.data.model && e.data.model !== model) {
        model = e.data.model;
        line(e.ts, "turn_context", { cwd: s.workspace, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: String(model).replace(/^[\w-]+:/, ""), summary: "auto" });
      }
      for (const b of blocks) {
        if (b.type === "text" && b.text) {
          line(e.ts, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] });
          display(e.ts, "agent_message", { message: b.text });
        } else if (b.type === "tool_use") {
          if (b.name === "apply_patch") {
            custom.add(b.id);
            line(e.ts, "response_item", { type: "custom_tool_call", status: "completed", call_id: b.id, name: b.name, input: typeof b.input?.input === "string" ? b.input.input : JSON.stringify(b.input) });
          } else line(e.ts, "response_item", { type: "function_call", name: b.name, arguments: JSON.stringify(b.input ?? {}), call_id: b.id });
        }
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        // A result with images goes as Codex's content items, the bytes kept; text alone as a string.
        const images = Array.isArray(r.content) && r.content.some((b: any) => b.type === "image");
        const text = textOf(r.content);
        const output = images
          ? [...(r.is_error ? [{ type: "input_text", text: FAILED_LABEL }] : []), ...r.content.map((b: any) => (b.type === "image" ? { type: "input_image", image_url: `data:${b.media_type};base64,${b.data}` } : { type: "input_text", text: partText(b) }))]
          : r.is_error ? `${FAILED_LABEL}\n${text}` : text;
        line(e.ts, "response_item", { type: custom.has(r.tool_use_id) ? "custom_tool_call_output" : "function_call_output", call_id: r.tool_use_id, output });
      }
    }
    prev = e.ts;
  }
  finish(prev);
  return toJsonl(out);
}

// What a handoff could not carry, said before the owner resumes it.
export function handoffNotes(format: "claude_code" | "codex", events: StoredEvent[]): string[] {
  const notes: string[] = [];
  let files = 0, unknownUsage = 0, loads = 0;
  const providers = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind === "user") for (const b of e.data.images ?? []) if (b.type === "attachment") files++;
    if (e.kind === "tool_result") for (const r of e.data.results ?? []) if (Array.isArray(r.content) && r.content.some((c: any) => c.type === "tool_reference")) loads++;
    if (e.kind === "assistant") {
      if (!e.data.usage) unknownUsage++;
      const m = String(e.data.model ?? "");
      const [p, name] = m.includes(":") ? [m.slice(0, m.indexOf(":")), m.slice(m.indexOf(":") + 1)] : ["", m];
      if (name) (providers.get(name) ?? providers.set(name, new Set()).get(name)!).add(p);
    }
  }
  if (files) notes.push(`${files} attached file${files === 1 ? " is" : "s are"} not carried: only their names were in the prompt.`);
  if (format === "codex" && loads) notes.push(`${loads} tool search result${loads === 1 ? " goes" : "s go"} as text naming the tools ${loads === 1 ? "it" : "they"} loaded: Codex loads a tool only through its own search.`);
  if (format === "claude_code" && unknownUsage) notes.push(`${unknownUsage} repl${unknownUsage === 1 ? "y has" : "ies have"} no measured usage: written as zero, which the format cannot tell from unknown.`);
  if ([...providers.values()].some((ps) => ps.size > 1)) notes.push(`${format === "codex" ? "Codex" : "Claude Code"} records a model by name only: replies from different providers of the same model read as one.`);
  return notes;
}
// A new private file, whole or not at all; an existing name is never replaced.
export function writeNew(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${crypto.randomUUID()}.part`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

const slug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, "-");

// The line to paste into a shell: into the session's folder, whatever its name
// holds (a space, a quote, a dollar sign), then the harness's resume command.
export const resumeLine = (cwd: string, resume: string) => `cd ${/^[\w@%+=:,./-]+$/.test(cwd) ? cwd : shq(cwd)} && ${resume}`;

export function exportTo(format: "claude_code" | "codex", s: Session, lineageEvents: StoredEvent[]) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const events = activeContext(lineageEvents);
  const notes = handoffNotes(format, events);
  if (format === "claude_code") {
    const path = join(claudeRoot(), slug(s.workspace), `${id}.jsonl`);
    writeNew(path, toJsonl(toClaudeRecords(s, forClaude(events), id)));
    return { format, target_id: id, path, cwd: s.workspace, resume_command: `claude --resume ${id}`, shell_command: resumeLine(s.workspace, `claude --resume ${id}`), exported_ms: now, notes };
  }
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const path = join(codexHome(), "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), `rollout-${stamp}-${id}.jsonl`);
  writeNew(path, toCodexRollout(s, events, id, now));
  return { format, target_id: id, path, cwd: s.workspace, resume_command: `codex resume ${id}`, shell_command: resumeLine(s.workspace, `codex resume ${id}`), exported_ms: now, notes };
}

export { redact, redactDeep } from "./redact.ts";
