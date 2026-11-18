// A session leaves keel-bun as a file to read (Markdown), as JSON lines another
// keel-bun imports (a header line, then one event a line), or as a new
// transcript in Claude Code's or Codex's own store so that harness resumes it
// (`claude --resume <id>`, `codex resume <id>`). Writing into another store
// only ever adds a new file under a new id; nothing there is replaced.
import { linkSync, mkdirSync, openSync, rmSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session, StoredEvent } from "../core/types.ts";
import { toClaudeRecords, toJsonl } from "./claude-format.ts";
import { claudeRoot } from "./import/claude.ts";
import { codexHome } from "./import/codex.ts";

export const EXPORT_VERSION = 1;

const textOf = (c: any): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n") : "");

export function toMarkdown(s: Session, events: StoredEvent[], include: Set<string>): string {
  const out = [`# ${s.title || "Session"}`, "", `Folder: \`${s.workspace}\` · Model: ${s.model} · ${new Date(s.created).toISOString().slice(0, 16).replace("T", " ")}`, ""];
  for (const e of events) {
    if (e.kind === "user") out.push("## Owner", "", e.data.text, "");
    else if (e.kind === "assistant") {
      const parts: string[] = [];
      for (const b of e.data.blocks ?? []) {
        if (b.type === "text") parts.push(b.text);
        else if (b.type === "thinking" && include.has("reasoning")) parts.push(`> ${String(b.thinking).replace(/\n/g, "\n> ")}`);
        else if (b.type === "tool_use" && include.has("tools")) parts.push("```json\n" + JSON.stringify({ tool: b.name, input: b.input }, null, 1) + "\n```");
      }
      if (parts.length) out.push("## Keel", "", parts.join("\n\n"), "");
    } else if (e.kind === "tool_result" && include.has("tools")) {
      for (const r of e.data.results ?? []) out.push("```text\n" + textOf(r.content).slice(0, 20_000) + "\n```", "");
    } else if (e.kind === "compaction" && e.data.summary) out.push("## Summary of the earlier conversation", "", e.data.summary, "");
  }
  return out.join("\n");
}

export function toKeelJsonl(s: Session, events: StoredEvent[]): string {
  const header = { keel_export: EXPORT_VERSION, title: s.title, model: s.model, workspace: s.workspace, created: s.created };
  return toJsonl([header, ...events.map((e) => ({ kind: e.kind, data: e.data, ts: e.ts }))]);
}

export function parseKeelJsonl(text: string): { header: any; events: { kind: any; data: any; ts: number }[] } | null {
  const lines = text.split("\n").filter((l) => l.trim());
  let header: any;
  try { header = JSON.parse(lines[0] ?? ""); } catch { return null; }
  if (header?.keel_export !== EXPORT_VERSION) return null;
  const events: any[] = [];
  for (const l of lines.slice(1)) {
    const e = JSON.parse(l);
    if (typeof e?.kind !== "string") return null;
    events.push(e);
  }
  return { header, events };
}

// Claude Code wants tool ids of its own shape.
const claudeId = (id: string) => {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = clean.startsWith("toolu_") ? clean : `toolu_${clean}`;
  return full.slice(0, 64);
};

function forClaude(events: StoredEvent[]): StoredEvent[] {
  return events.map((e) => {
    if (e.kind === "assistant")
      return { ...e, data: { ...e.data, blocks: (e.data.blocks ?? []).filter((b: any) => b.type !== "thinking" && b.type !== "redacted_thinking").map((b: any) => (b.type === "tool_use" ? { ...b, id: claudeId(b.id) } : b)) } };
    if (e.kind === "tool_result") return { ...e, data: { results: e.data.results.map((r: any) => ({ ...r, tool_use_id: claudeId(r.tool_use_id) })) } };
    return e;
  });
}

export function toCodexRollout(s: Session, events: StoredEvent[], id: string, now: number): string {
  let ts = now;
  const out: unknown[] = [];
  const line = (type: string, payload: unknown) => out.push({ timestamp: new Date(ts++).toISOString(), type, payload });
  line("session_meta", { id, timestamp: new Date(now).toISOString(), cwd: s.workspace, originator: "keel", cli_version: "0.0.0", source: "cli" });
  const custom = new Set<string>();
  for (const e of events) {
    if (e.kind === "user") line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: e.data.text }] });
    else if (e.kind === "compaction" && e.data.summary) line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `Summary of the conversation so far:\n\n${e.data.summary}` }] });
    else if (e.kind === "note" && e.data.model) line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: e.data.text }] });
    else if (e.kind === "assistant") {
      for (const b of e.data.blocks ?? []) {
        if (b.type === "text" && b.text) line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: b.text }] });
        else if (b.type === "tool_use") {
          if (b.name === "apply_patch") {
            custom.add(b.id);
            line("response_item", { type: "custom_tool_call", status: "completed", call_id: b.id, name: b.name, input: typeof b.input?.input === "string" ? b.input.input : JSON.stringify(b.input) });
          } else line("response_item", { type: "function_call", name: b.name, arguments: JSON.stringify(b.input ?? {}), call_id: b.id });
        }
      }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? [])
        line("response_item", { type: custom.has(r.tool_use_id) ? "custom_tool_call_output" : "function_call_output", call_id: r.tool_use_id, output: textOf(r.content) });
    }
  }
  return toJsonl(out);
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

export function exportTo(format: "claude_code" | "codex", s: Session, events: StoredEvent[]) {
  const id = crypto.randomUUID();
  const now = Date.now();
  if (format === "claude_code") {
    const path = join(claudeRoot(), slug(s.workspace), `${id}.jsonl`);
    writeNew(path, toJsonl(toClaudeRecords(s, forClaude(events), id)));
    return { format, target_id: id, path, cwd: s.workspace, resume_command: `claude --resume ${id}`, exported_ms: now };
  }
  const d = new Date(now);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const path = join(codexHome(), "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), `rollout-${stamp}-${id}.jsonl`);
  writeNew(path, toCodexRollout(s, events, id, now));
  return { format, target_id: id, path, cwd: s.workspace, resume_command: `codex resume ${id}`, exported_ms: now };
}

// Secrets out of a file that leaves the machine's stores: well-known key and
// token shapes, and private key blocks. Each hit becomes [redacted].
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(re, (m, p1) => (typeof p1 === "string" && /^Bearer\s+$/.test(p1) ? `${p1}[redacted]` : "[redacted]"));
  return out;
}

// Every string of a JSON value, redacted by itself (ids and keys stay).
export function redactDeep(v: any): any {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" || k === "tool_use_id" ? x : redactDeep(x)]));
  return v;
}
