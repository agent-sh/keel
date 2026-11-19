// Claude Code: one JSON-lines transcript per session under
// ~/.claude/projects/<folder slug>/<session id>.jsonl, subagents under
// <session id>/subagents/. Records chain by parentUuid; the branch shown is the
// chain from the newest record back, which also starts after a compaction (its
// summary is the first message of the chain).
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Builder, clip, resultText, type Found, type Read } from "./types.ts";
import { damageNotes, headTail, readLines, scanFor } from "./files.ts";

export const claudeRoot = () => process.env.KEEL_IMPORT_CLAUDE_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

// Every transcript file with its size and time (no file is opened).
export function* claudeFiles(root = claudeRoot()): Generator<{ path: string; size: number; mtime: number }> {
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return; }
  for (const d of dirs) {
    const dir = join(root, d);
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const p = join(dir, n);
      if (n.endsWith(".jsonl")) {
        try { const s = statSync(p); yield { path: p, size: s.size, mtime: s.mtimeMs }; } catch {}
      } else if (!n.includes(".")) {
        // <session>/subagents/agent-*.jsonl
        let subs: string[] = [];
        try { subs = readdirSync(join(p, "subagents")); } catch { continue; }
        for (const s of subs) if (s.endsWith(".jsonl")) {
          const sp = join(p, "subagents", s);
          try { const st = statSync(sp); yield { path: sp, size: st.size, mtime: st.mtimeMs }; } catch {}
        }
      }
    }
  }
}

// The words of a user record the owner typed, or null for a record that is not that.
// A question of only images (no caption) is a prompt too: its words are "Image prompt".
function promptOf(r: any): string | null {
  if (r?.type !== "user" || r.isMeta || r.isCompactSummary) return null;
  const c = r.message?.content;
  const blocks = Array.isArray(c) && !c.some((b: any) => b?.type === "tool_result") ? c : [];
  const text = typeof c === "string" ? c : blocks.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n");
  if (!text.trim()) return blocks.some((b: any) => b?.type === "image") ? IMAGE_PROMPT : null;
  if (/^<(local-command|command-stdout|bash-stdout|system-reminder)/.test(text.trim())) return null;
  return text;
}
const IMAGE_PROMPT = "Image prompt";

// How Claude Code (or a writer of its format) recorded a reply that did not
// simply finish; null and the plain endings say nothing more.
const shortStop = (s: unknown) => (typeof s === "string" && !["end_turn", "tool_use", "stop_sequence", "pause_turn"].includes(s) ? s : undefined);

const INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;
const commandText = (t: string) => {
  const name = t.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  if (!name) return t;
  const args = t.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? "";
  return `${name}${args ? " " + args : ""}`;
};

export function claudeFound(path: string, size: number, mtime: number): Found | null {
  const { head, tail } = headTail(path, 48 * 1024);
  let cwd: string | undefined, model: string | undefined, first: string | undefined, entry: string | undefined, sid: string | undefined;
  for (const r of head) {
    cwd ??= r.cwd;
    sid ??= r.sessionId;
    entry ??= r.entrypoint;
    if (!model && r.type === "assistant" && r.message?.model && r.message.model !== "<synthetic>") model = r.message.model;
    if (!first) { const p = promptOf(r); if (p && !/^\/(clear|exit|resume)\b/.test(commandText(p))) first = commandText(p); }
  }
  let title: string | undefined, last: string | undefined;
  for (const r of tail) {
    if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
    else if (!title && r.type === "ai-title" && r.aiTitle) title = r.aiTitle;
    else if (!title && r.type === "summary" && r.summary) title = r.summary;
    if (r.type === "last-prompt" && r.lastPrompt) last = r.lastPrompt;
    else { const p = promptOf(r); if (p) last = commandText(p); }
    cwd ??= r.cwd;
  }
  // A Claude Code transcript whose head and tail hold no prompt (long tool
  // outputs around it) is read through for its first one.
  if (!first && !last) {
    const hit = scanFor(path, (r) => { const p = promptOf(r); return p && !/^\/(clear|exit|resume)\b/.test(commandText(p)) ? { text: commandText(p), r } : undefined; });
    if (hit) { first = hit.text; cwd ??= hit.r.cwd; sid ??= hit.r.sessionId; }
  }
  if (!first && !last) return null; // no conversation in it
  const sub = basename(dirname(path)) === "subagents";
  return {
    harness: "claude",
    id: sub ? basename(path, ".jsonl") : sid ?? basename(path, ".jsonl"),
    path,
    cwd,
    title: clip(title ?? first ?? last ?? "", 120),
    first_prompt: first && clip(first),
    last_prompt: last && clip(last),
    updated_ms: Math.round(mtime),
    size_bytes: size,
    model,
    kind: sub ? "subagent" : entry && /^sdk/.test(entry) ? "headless" : "interactive",
    parent_id: sub ? basename(dirname(dirname(path))) : undefined,
  };
}

export async function readClaude(path: string): Promise<Read> {
  const st = statSync(path);
  const found = claudeFound(path, st.size, st.mtimeMs);
  if (!found) throw new Error("this transcript holds no conversation");
  const lines = readLines(await Bun.file(path).text());
  const records = lines.records;
  const byId = new Map<string, any>();
  let leaf: any;
  // Every record with a uuid is a link of the chain (attachments and progress
  // records sit between messages); only messages are converted.
  for (const r of records) {
    if (!r.uuid) continue;
    byId.set(r.uuid, r);
    if ((r.type === "user" || r.type === "assistant") && !r.isMeta && !r.isSidechain) leaf = r;
  }
  if (!leaf) for (const r of records) if (r.uuid && (r.type === "user" || r.type === "assistant")) leaf = r; // a subagent's file is all sidechain
  const chain: any[] = [];
  const seen = new Set<string>();
  for (let r = leaf; r && !seen.has(r.uuid); r = r.parentUuid ? byId.get(r.parentUuid) : undefined) {
    seen.add(r.uuid);
    chain.push(r);
  }
  chain.reverse();
  const b = new Builder();
  const notes: string[] = [];
  let lastMsg: string | undefined;
  for (const r of chain) {
    const ts = Date.parse(r.timestamp) || st.mtimeMs;
    if (r.type === "user") {
      const c = r.message?.content;
      // A meta message is model-visible and not the owner's words: a note the model reads.
      if (r.isMeta) {
        const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "";
        if (t.trim()) b.note(t, ts, true);
        else b.counts.skipped++;
        continue;
      }
      // Claude Code's marker of a reply the owner stopped.
      if (typeof c === "string" ? INTERRUPTED.test(c) : Array.isArray(c) && c.length === 1 && c[0]?.type === "text" && INTERRUPTED.test(c[0].text ?? "")) { b.interrupted(); continue; }
      if (r.isCompactSummary) {
        b.note(typeof c === "string" ? c : resultText(c) as string, ts, true);
        notes.push("Starts at Claude Code's last compaction: the summary it made is the first message.");
        continue;
      }
      if (typeof c === "string") {
        if (/^<(local-command-stdout|command-stdout|bash-stdout)/.test(c.trim())) { b.counts.skipped++; continue; }
        b.user(commandText(c), ts);
        continue;
      }
      const texts: string[] = [];
      const images: any[] = [];
      for (const blk of Array.isArray(c) ? c : []) {
        if (blk?.type === "tool_result") b.result({ tool_use_id: blk.tool_use_id, content: resultText(blk.content), is_error: blk.is_error }, ts);
        else if (blk?.type === "text") texts.push(blk.text);
        else if (blk?.type === "image") images.push(blk);
      }
      if (texts.length || images.length) b.user(texts.join("\n"), ts, images);
    } else if (r.type === "assistant") {
      const m = r.message ?? {};
      const blocks: any[] = [];
      for (const blk of Array.isArray(m.content) ? m.content : []) {
        if (blk?.type === "text" && blk.text) blocks.push({ type: "text", text: blk.text });
        else if (blk?.type === "tool_use") blocks.push({ type: "tool_use", id: blk.id, name: blk.name, input: blk.input ?? {} });
        else if (blk?.type === "thinking" || blk?.type === "redacted_thinking") b.counts.thoughts_dropped++;
      }
      if (!blocks.length) continue;
      b.assistant(blocks, ts, m.model, m.id !== lastMsg || b.events[b.events.length - 1]?.kind !== "assistant", shortStop(m.stop_reason));
      lastMsg = m.id;
    }
  }
  notes.push(...damageNotes(lines));
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: signatures belong to the model that wrote them.`);
  return { found, events: b.events, counts: b.counts, notes };
}
