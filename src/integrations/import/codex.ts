// Codex: one rollout per thread under ~/.codex/sessions/YYYY/MM/DD/ (and
// archived_sessions). Records are { timestamp, type, payload }: session_meta,
// turn_context, response_item (the model's history: messages, function and
// custom tool calls with their outputs, encrypted reasoning) and event_msg.
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { damageNotes, headTail, readLines, scanFor } from "./files.ts";
import { Builder, clip, FAILED_LABEL, NOTE_CLOSE, NOTE_OPEN, resultText, type Found, type Read } from "./types.ts";
import { homeDir } from "../../core/paths";

export const codexHome = () => process.env.KEEL_IMPORT_CODEX_DIR ?? process.env.CODEX_HOME ?? join(homeDir(), ".codex");

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

const TEXT_PARTS = new Set(["input_text", "output_text", "text"]);
const textOf = (content: any) =>
  (Array.isArray(content) ? content : []).filter((p: any) => TEXT_PARTS.has(p?.type)).map((p: any) => p.text ?? "").join("\n");

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
  // A rollout whose head and tail hold no prompt (long tool outputs around it) is read through for its first one.
  if (!first && !last) first = scanFor(path, (r) => { const p = prompt(r); return p && !injected(p) ? p : undefined; });
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

const COMPACTED = "Codex compacted this conversation: all of it is here, and the model reads from what Codex kept on, as it did there.";

// A call's tool by namespace and name, the way Keel names the same tool
// (mcp__<server>__<tool>): two servers' "lookup" stay two tools. A name
// already qualified, or a namespace naming the tool itself, is kept as is.
export const qualified = (name: string, namespace?: unknown) =>
  typeof namespace !== "string" || !namespace || name === namespace || name.startsWith(`${namespace}__`) ? name : `${namespace}__${name}`;

const UNAVAILABLE = "[unavailable: encrypted in the source]";

// Tool definitions as Codex declared or loaded them (namespaces of functions,
// plain functions), written out as they were. History only: the live catalog
// and the gate decide what exists and what may run.
function toolLines(tools: unknown): string[] {
  const one = (t: any, ns?: string): string[] => {
    if (t?.type === "namespace" && Array.isArray(t.tools)) return [`${t.name}${t.description ? ` (${t.description})` : ""}:`, ...t.tools.flatMap((x: any) => one(x, t.name))];
    const name = typeof t?.name === "string" ? qualified(t.name, ns) : String(t?.type ?? "tool");
    const schema = t?.parameters ?? t?.format;
    return [`${ns ? "  " : ""}- ${name}${t?.description ? `: ${t.description}` : ""}${schema ? ` ${JSON.stringify(schema)}` : ""}`];
  };
  return (Array.isArray(tools) ? tools : []).flatMap((t) => one(t));
}

const HISTORY_ONLY = "Shown as they were then; history only, not tools available now.";

export async function readCodex(path: string): Promise<Read> {
  const st = statSync(path);
  const found = codexFound(path, st.size, st.mtimeMs);
  if (!found) throw new Error("this rollout holds no conversation");
  const b = new Builder();
  const notes: string[] = [];
  // Why each skipped item was left out, counted per reason for the report.
  const skips = new Map<string, number>();
  const skip = (why: string) => { b.counts.skipped++; skips.set(why, (skips.get(why) ?? 0) + 1); };
  // A native tool search, kept as a note for the model: its query, then the
  // tools its answer loaded (by call id).
  const searches = new Map<string, { data: any }>();
  // Prompt media the file only refers to (an uploaded file id, a link).
  const missing: string[] = [];
  let model = found.model;
  const lines = readLines(await Bun.file(path).text());
  for (const r of lines.records) {
    const ts = Date.parse(r.timestamp) || st.mtimeMs;
    const p = r.payload ?? {};
    if (r.type === "turn_context" && p.model) model = p.model;
    if (r.type === "compacted") {
      // Codex replaces the model's history here: with its summary (`message`)
      // and the owner's messages it kept, else with the items it names. The
      // history before stays; a checkpoint holds what the model reads from here.
      const items: any[] = Array.isArray(p.replacement_history) ? p.replacement_history : [];
      const said = items.filter((i) => i?.type === "message" && i.role === "user").map((i) => textOf(i.content)).filter((t) => t.trim() && !injected(t));
      const summary = String(p.message ?? "").trim() || said.pop() || "";
      b.compacted(summary || "Codex replaced the conversation before this point with what follows.", ts, { owner_messages: said.filter((t) => !summary || !t.includes(summary)) });
      for (const item of items) if (!(item?.type === "message" && (item.role === "user" || item.role === "developer" || item.role === "system"))) take(item, ts);
      if (!notes.includes(COMPACTED)) notes.push(COMPACTED);
      continue;
    }
    if (r.type === "event_msg" && p.type === "turn_aborted") b.interrupted();
    if (r.type === "response_item") take(p, ts);
  }
  function take(p: any, ts: number) {
    switch (p.type) {
      case "message": {
        const text = textOf(p.content);
        if (p.role === "user") {
          if (injected(text)) { if (/^\s*<turn_aborted>/.test(text)) b.interrupted(); skip("Codex's own context in a user message (environment, instructions, notices)"); break; }
          // A note Keel wrote for the model: read back as a note, never as the owner's words.
          if (text.startsWith(`${NOTE_OPEN}\n`) && text.trimEnd().endsWith(NOTE_CLOSE)) { b.note(text.slice(NOTE_OPEN.length + 1, text.trimEnd().length - NOTE_CLOSE.length).replace(/\n$/, ""), ts, true); break; }
          // Media the file holds comes byte for byte; a reference to media it does not hold is reported.
          const media = resultText((Array.isArray(p.content) ? p.content : []).filter((c: any) => c?.type && !TEXT_PARTS.has(c.type)));
          const parts = Array.isArray(media) ? media : media ? [{ type: "text", text: media }] : [];
          for (const m of parts) if (m.type === "text") missing.push(m.text);
          b.user(text, ts, parts.filter((m) => m.type === "image"));
        } else if (p.role === "assistant" && text.trim()) b.assistant([{ type: "text", text }], ts, model);
        else if (p.role === "assistant" && p.encrypted_content) b.assistant([{ type: "text", text: UNAVAILABLE }], ts, model);
        else if (p.role === "assistant") skip("an empty assistant message");
        else skip("developer and system messages (Codex's own setup)");
        break;
      }
      case "agent_message": {
        // Another agent's message (a child reporting to its parent): agent
        // context, labelled with who wrote it, never the owner's words.
        const parts = Array.isArray(p.content) ? p.content : [];
        const text = parts.map((c: any) => (c?.type === "encrypted_content" ? UNAVAILABLE : c?.text ?? "")).join("\n").trim();
        b.note(`Agent message from ${p.author || "an agent"} to ${p.recipient || "an agent"} (another agent's words, not the owner's):\n${text || UNAVAILABLE}`, ts, true);
        break;
      }
      case "additional_tools":
        b.note([`Tools Codex declared to the model here. ${HISTORY_ONLY}`, ...toolLines(p.tools)].join("\n"), ts, true);
        break;
      case "tool_search_call": {
        const a = typeof p.arguments === "string" ? parseArgs(p.arguments) : p.arguments ?? {};
        const ask = p.encrypted_content && !a.query ? UNAVAILABLE : `"${a.query ?? ""}"${a.limit ? ` (limit ${a.limit})` : ""}`;
        b.note(`Codex searched its deferred tools for ${ask}.`, ts, true);
        if (p.call_id) searches.set(p.call_id, b.events[b.events.length - 1]!);
        break;
      }
      case "tool_search_output": {
        const lines = toolLines(p.tools);
        const loadedText = lines.length ? [`The search loaded these tools. ${HISTORY_ONLY}`, ...lines].join("\n") : "The search loaded no tools.";
        const asked = p.call_id ? searches.get(p.call_id) : undefined;
        if (asked) { asked.data.text += `\n${loadedText}`; searches.delete(p.call_id); }
        else b.note(`Codex's deferred tool search answered. ${loadedText}`, ts, true);
        break;
      }
      case "function_call":
      case "custom_tool_call":
      case "local_shell_call": {
        const encrypted = p.type === "function_call" && !p.arguments && Array.isArray(p.encrypted_function_args) && p.encrypted_function_args.length;
        const input = encrypted ? { arguments: UNAVAILABLE } : p.type === "function_call" ? parseArgs(p.arguments) : p.type === "custom_tool_call" ? { input: p.input } : { command: p.action?.command };
        const name = p.type === "local_shell_call" ? "shell" : typeof p.name === "string" && p.name ? qualified(p.name, p.namespace) : undefined;
        if (!name || !p.call_id) { skip("a tool call with no name or call id"); break; }
        b.assistant([{ type: "tool_use", id: p.call_id, name, input }], ts, model);
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        let out = typeof p.output === "string" ? p.output : Array.isArray(p.output) ? resultText(p.output) : p.output?.content ?? JSON.stringify(p.output ?? "");
        // Codex keeps no failure flag in the file: Keel's own writer labels a failed result
        // (a first line of the text, or a first text item before content items).
        let failed = typeof out === "string" && out.startsWith(`${FAILED_LABEL}\n`);
        if (failed) out = (out as string).slice(FAILED_LABEL.length + 1);
        else if (Array.isArray(out) && out[0]?.type === "text" && out[0].text === FAILED_LABEL) { failed = true; out = out.slice(1); }
        b.result({ tool_use_id: p.call_id, content: out, is_error: failed || undefined }, ts);
        break;
      }
      case "reasoning":
        b.counts.thoughts_dropped++;
        break;
      default:
        skip(`items of a kind Keel does not import (${p.type ?? "untyped"})`);
    }
  }
  notes.push(...damageNotes(lines));
  for (const [why, n] of skips) notes.push(`${n} skipped: ${why}.`);
  if (missing.length) notes.push(`Prompt media the file does not hold, not imported: ${missing.join(", ")}.`);
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} reasoning item${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: encrypted for the model that wrote them.`);
  return { found, events: b.events, counts: b.counts, notes };
}
