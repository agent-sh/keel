// Codex: one rollout per thread under ~/.codex/sessions/YYYY/MM/DD/ (and
// archived_sessions). Records are { timestamp, type, payload }: session_meta,
// turn_context, response_item (the model's history: messages, function and
// custom tool calls with their outputs, encrypted reasoning) and event_msg.
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { headTail, parseLines } from "./files.ts";
import { Builder, clip, resultText, type Found, type Read } from "./types.ts";

export const codexHome = () => process.env.KEEL_IMPORT_CODEX_DIR ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");

export function* codexFiles(home = codexHome()): Generator<{ path: string; size: number; mtime: number }> {
  const walk = function* (dir: string, depth: number): Generator<{ path: string; size: number; mtime: number }> {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".jsonl") && n.startsWith("rollout-")) {
        try { const s = statSync(p); yield { path: p, size: s.size, mtime: s.mtimeMs }; } catch {}
      } else if (depth < 4 && !n.includes(".")) yield* walk(p, depth + 1);
    }
  };
  yield* walk(join(home, "sessions"), 0);
  yield* walk(join(home, "archived_sessions"), 0);
}

// Text Codex puts in a user message that the owner did not type.
const injected = (t: string) => /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|<skills_instructions>|# AGENTS\.md instructions|<turn_aborted>|<subagent_notification>)/.test(t);

const textOf = (content: any) =>
  (Array.isArray(content) ? content : []).filter((p: any) => p?.type === "input_text" || p?.type === "output_text" || p?.type === "text").map((p: any) => p.text ?? "").join("\n");

export function codexFound(path: string, size: number, mtime: number): Found | null {
  const { head, tail } = headTail(path, 64 * 1024);
  const meta = head.find((r) => r.type === "session_meta")?.payload ?? {};
  let first: string | undefined, last: string | undefined, model: string | undefined, cwd: string | undefined = meta.cwd;
  const prompt = (r: any) => (r.type === "response_item" && r.payload?.type === "message" && r.payload.role === "user" ? textOf(r.payload.content) : "");
  for (const r of head) {
    if (r.type === "turn_context") { model ??= r.payload?.model; cwd ??= r.payload?.cwd; }
    const p = prompt(r);
    if (!first && p && !injected(p)) first = p;
  }
  for (const r of tail) {
    const p = prompt(r);
    if (p && !injected(p)) last = p;
    if (r.type === "turn_context" && r.payload?.model) model = r.payload.model;
  }
  if (!first && !last) return null;
  const sub = meta.source && typeof meta.source === "object" && "subagent" in meta.source;
  return {
    harness: "codex",
    id: meta.id ?? basename(path, ".jsonl").replace(/^rollout-[^-]+-[^-]+-[^-]+-[^-]+-/, ""),
    path,
    cwd,
    title: clip(first ?? last ?? "", 120),
    first_prompt: first && clip(first),
    last_prompt: last && clip(last),
    updated_ms: Math.round(mtime),
    size_bytes: size,
    model,
    kind: sub ? "subagent" : meta.source === "exec" ? "headless" : "interactive",
    parent_id: sub ? meta.source.subagent?.thread_spawn?.parent_thread_id : undefined,
  };
}

const parseArgs = (a: any) => {
  if (typeof a !== "string") return a ?? {};
  try { return JSON.parse(a); } catch { return { input: a }; }
};

const COMPACTED = "Starts at Codex's last compaction: the history it kept is where this begins.";

export async function readCodex(path: string): Promise<Read> {
  const st = statSync(path);
  const found = codexFound(path, st.size, st.mtimeMs);
  if (!found) throw new Error("this rollout holds no conversation");
  const b = new Builder();
  const notes: string[] = [];
  let model = found.model;
  for (const r of parseLines(await Bun.file(path).text())) {
    const ts = Date.parse(r.timestamp) || st.mtimeMs;
    const p = r.payload ?? {};
    if (r.type === "turn_context" && p.model) model = p.model;
    if (r.type === "compacted") {
      // What Codex replaces the history with after a compaction.
      b.events.length = 0;
      if (Array.isArray(p.replacement_history)) for (const item of p.replacement_history) take(item, ts);
      else if (p.message) b.note(String(p.message), ts, true);
      if (!notes.includes(COMPACTED)) notes.push(COMPACTED);
      continue;
    }
    if (r.type === "response_item") take(p, ts);
  }
  function take(p: any, ts: number) {
    switch (p.type) {
      case "message": {
        const text = textOf(p.content);
        if (p.role === "user") {
          if (injected(text)) { b.counts.skipped++; break; }
          const images = (p.content ?? []).filter((c: any) => c?.type === "input_image" && typeof c.image_url === "string" && c.image_url.startsWith("data:")).map((c: any) => {
            const [, mime, data] = c.image_url.match(/^data:([^;]+);base64,(.*)$/) ?? [];
            return { type: "image", source: { type: "base64", media_type: mime, data } };
          });
          b.user(text, ts, images);
        } else if (p.role === "assistant" && text.trim()) b.assistant([{ type: "text", text }], ts, model);
        else b.counts.skipped++; // developer and system messages are Codex's own setup
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        const input = p.type === "function_call" ? parseArgs(p.arguments) : p.type === "custom_tool_call" ? { input: p.input } : { command: p.action?.command };
        const name = p.type === "local_shell_call" ? "shell" : p.name;
        if (!name || !p.call_id) { b.counts.skipped++; break; }
        b.assistant([{ type: "tool_use", id: p.call_id, name, input }], ts, model);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        const out = typeof p.output === "string" ? p.output : Array.isArray(p.output) ? resultText(p.output) : p.output?.content ?? JSON.stringify(p.output ?? "");
        b.result({ tool_use_id: p.call_id, content: out }, ts);
        break;
      }
      case "reasoning":
        b.counts.thoughts_dropped++;
        break;
      default:
        b.counts.skipped++;
    }
  }
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning item${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: encrypted for the model that wrote them.`);
  return { found, events: b.events, counts: b.counts, notes };
}
