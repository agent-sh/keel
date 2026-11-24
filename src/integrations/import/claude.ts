// Claude Code: one JSON-lines transcript per session under
// ~/.claude/projects/<folder slug>/<session id>.jsonl, subagents under
// <session id>/subagents/. Records chain by parentUuid; the branch shown is the
// chain from the newest record back; a compaction's boundary record has no
// parent and names the record it follows (logicalParentUuid), so the chain
// goes on through it, and its summary is a checkpoint in the copy.
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Builder, clip, resultText, type Found, type Read } from "./types.ts";
import { damageNotes, headTail, readLines, scanBack, scanFor } from "./files.ts";
import { ownerEnv, ownerHome } from "../../core/paths";

export const claudeRoot = () => process.env.KEEL_IMPORT_CLAUDE_DIR ?? join(ownerEnv("CLAUDE_CONFIG_DIR") ?? join(ownerHome(), ".claude"), "projects");

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

// The model a record answered with ("<synthetic>" marks Claude Code's own notices).
const modelOf = (r: any): string | undefined => (r?.type === "assistant" && typeof r.message?.model === "string" && r.message.model !== "<synthetic>" ? r.message.model : undefined);

// Claude Code's permission modes as Keel's (recorded on each prompt).
const PERM = new Map<string, Found["perm_mode"]>([["default", "ask"], ["acceptEdits", "auto-edits"], ["auto", "auto"], ["bypassPermissions", "full-auto"], ["plan", "plan"], ["dontAsk", "read-only"]]);
const permOf = (r: any): Found["perm_mode"] =>
  r?.type === "user" && typeof r.permissionMode === "string" && r.permissionMode ? PERM.get(r.permissionMode) ?? "ask" : undefined;

export function claudeFound(path: string, size: number, mtime: number): Found | null {
  const { head, tail } = headTail(path, 48 * 1024);
  let perm: Found["perm_mode"];
  let cwd: string | undefined, model: string | undefined, first: string | undefined, entry: string | undefined, sid: string | undefined;
  for (const r of head) {
    cwd ??= r.cwd;
    sid ??= r.sessionId;
    entry ??= r.entrypoint;
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
    model = modelOf(r) ?? model; // the latest reply's model: a session can switch models
    perm = permOf(r) ?? perm;
  }
  // A Claude Code transcript whose head and tail hold no prompt (long tool
  // outputs around it) is read through for its first one.
  if (!first && !last) {
    const hit = scanFor(path, (r) => { const p = promptOf(r); return p && !/^\/(clear|exit|resume)\b/.test(commandText(p)) ? { text: commandText(p), r } : undefined; });
    if (hit) { first = hit.text; cwd ??= hit.r.cwd; sid ??= hit.r.sessionId; }
  }
  if (!first && !last) return null; // no conversation in it
  // The tail of a long transcript can be all tool output: then the last reply
  // anywhere in the file names the model (the first one can be from before a
  // model switch).
  model ??= scanBack(path, modelOf);
  perm ??= head.map(permOf).findLast(Boolean);
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
    perm_mode: perm,
    kind: sub ? "subagent" : entry && /^sdk/.test(entry) ? "headless" : "interactive",
    parent_id: sub ? basename(dirname(dirname(path))) : undefined,
  };
}

// A record's chain parent. A compaction's boundary starts a chain of its own
// (no parent): the record it follows is its logical parent, so the history
// before it is read too.
const parentOf = (r: any): string | undefined =>
  r.parentUuid ?? (r.type === "system" && r.subtype === "compact_boundary" && r.logicalParentUuid ? r.logicalParentUuid : undefined);

// A message record that can end the branch shown (the newest such is its leaf).
const leafLike = (r: any) => !!r.uuid && (r.type === "user" || r.type === "assistant") && !r.isMeta && !r.isSidechain;

// The records of a branch, in order, converted to events one at a time: a
// whole read converts its chain at once, a transcript followed as it grows
// converts each part its new leaf chains onto (ClaudeChain).
export class ClaudeConvert {
  b = new Builder();
  compactions = 0;
  private lastMsg: string | undefined;
  private trigger: string | undefined;
  push(r: any, fallbackTs: number) {
    const b = this.b;
    const ts = Date.parse(r.timestamp) || fallbackTs;
    if (r.type === "system" && r.subtype === "compact_boundary") { this.trigger = r.compactMetadata?.trigger; return; }
    if (r.type === "user") {
      const c = r.message?.content;
      // A meta message is model-visible and not the owner's words: a note the model reads.
      if (r.isMeta) {
        const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "";
        if (t.trim()) b.note(t, ts, true);
        else b.counts.skipped++;
        return;
      }
      // Claude Code's marker of a reply the owner stopped.
      if (typeof c === "string" ? INTERRUPTED.test(c) : Array.isArray(c) && c.length === 1 && c[0]?.type === "text" && INTERRUPTED.test(c[0].text ?? "")) { b.interrupted(); return; }
      if (r.isCompactSummary) {
        const text = typeof c === "string" ? c : resultText(c);
        const trigger = this.trigger;
        b.compacted(typeof text === "string" ? text : text.filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n"), ts, { trigger: trigger === "auto" ? "threshold" : trigger === "manual" ? "owner" : undefined });
        this.compactions++;
        this.trigger = undefined;
        return;
      }
      if (typeof c === "string") {
        if (/^<(local-command-stdout|command-stdout|bash-stdout)/.test(c.trim())) { b.counts.skipped++; return; }
        b.user(commandText(c), ts);
        return;
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
      if (!blocks.length) return;
      b.assistant(blocks, ts, m.model, m.id !== this.lastMsg || b.events[b.events.length - 1]?.kind !== "assistant", shortStop(m.stop_reason));
      this.lastMsg = m.id;
    }
  }
}

// The branch of a transcript followed as the file grows. Records are pushed as
// they are read; `advance` gives the records the newest leaf adds to the
// branch, in order, when that leaf chains back to the branch's last leaf.
// Only records after that leaf are kept (a child is written after its parent,
// so nothing before it can join the branch). A leaf that does not chain back
// (the owner rewound and went on from an earlier message) says so: the caller
// reads the file again from its start.
export class ClaudeChain {
  private leaf: string | undefined;
  private after: any[] = [];
  push(records: any[]) {
    for (const r of records) if (r?.uuid) this.after.push(r);
  }
  advance(): any[] | "rewound" {
    const at = this.after.findLastIndex(leafLike);
    if (at < 0) return [];
    const byId = new Map<string, any>();
    for (let i = 0; i <= at; i++) byId.set(this.after[i].uuid, this.after[i]);
    const seg: any[] = [];
    const seen = new Set<string>();
    let reached = this.leaf === undefined;
    for (let r: any = this.after[at]; r && !seen.has(r.uuid); ) {
      seen.add(r.uuid);
      seg.push(r);
      const up = parentOf(r);
      if (this.leaf !== undefined && up === this.leaf) { reached = true; break; }
      r = up ? byId.get(up) : undefined;
    }
    // The branch's start (the first leaf) chains to nothing it holds; a later leaf must reach the last one.
    if (!reached) return "rewound";
    seg.reverse();
    this.leaf = this.after[at].uuid;
    this.after = this.after.slice(at + 1);
    return seg;
  }
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
    if (leafLike(r)) leaf = r;
  }
  if (!leaf) for (const r of records) if (r.uuid && (r.type === "user" || r.type === "assistant")) leaf = r; // a subagent's file is all sidechain
  const chain: any[] = [];
  const seen = new Set<string>();
  const up = (r: any) => { const p = parentOf(r); return p ? byId.get(p) : undefined; };
  for (let r = leaf; r && !seen.has(r.uuid); r = up(r)) {
    seen.add(r.uuid);
    chain.push(r);
  }
  chain.reverse();
  found.model = chain.map(modelOf).findLast(Boolean) ?? found.model;
  // The fast listing samples the file, not its active branch. Only this
  // branch's recorded mode can set the new session's permissions.
  found.perm_mode = chain.map(permOf).findLast(Boolean);
  const conv = new ClaudeConvert();
  const b = conv.b;
  const notes: string[] = [];
  for (const r of chain) conv.push(r, st.mtimeMs);
  const compactions = conv.compactions;
  if (compactions) notes.push(`Claude Code compacted this conversation ${compactions === 1 ? "once" : `${compactions} times`}: all of it is here, and the model reads from the last summary on, as it did there.`);
  notes.push(...damageNotes(lines));
  if (b.counts.thoughts_dropped) notes.push(`${b.counts.thoughts_dropped} thinking block${b.counts.thoughts_dropped === 1 ? " is" : "s are"} not carried: signatures belong to the model that wrote them.`);
  return { found, events: b.events, counts: b.counts, notes };
}
