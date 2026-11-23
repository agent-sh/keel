// An agent's own memory folder: Claude Code's sub-agent `memory` field
// (code.claude.com/docs/en/sub-agents, "Enable persistent memory"). The scope
// names the folder: `user` is ~/.claude/agent-memory/<agent>/, `project` is
// <project>/.claude/agent-memory/<agent>/ (kept in version control), `local`
// is <project>/.claude/agent-memory-local/<agent>/. The agent's task carries
// how to use the folder and the first 200 lines or 25 KB of its MEMORY.md,
// whichever comes first; Read, Write and Edit are in its tools. Turning
// Claude Code's auto memory off (the `autoMemoryEnabled` setting, or
// CLAUDE_CODE_DISABLE_AUTO_MEMORY) turns this off too, as there.
import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { importHome } from "../mcp/sources.ts";
import { rootOf } from "../safety/trust.ts";
import { withoutHidden } from "../core/hidden-chars.ts";

export type MemoryScope = "user" | "project" | "local";
export const SCOPES: readonly MemoryScope[] = ["user", "project", "local"];
export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25 * 1024;

// The folder of an agent's memory, for an agent working in `cwd`. None for
// a name that is only dots (or nothing) once made a folder's name: ".." would
// be the scope's own parent folder (~/.claude for the user scope).
export function memoryDir(scope: MemoryScope, agent: string, cwd: string, home = importHome()): string | null {
  const name = agent.replace(/[^\w.-]+/g, "-");
  if (/^\.*$/.test(name)) return null;
  if (scope === "user") return join(home, ".claude", "agent-memory", name);
  const project = rootOf(cwd) ?? cwd;
  return join(project, ".claude", scope === "project" ? "agent-memory" : "agent-memory-local", name);
}

// Whether the owner turned Claude Code's auto memory off.
export function memoryOff(env: Record<string, string | undefined> = process.env, home = importHome()): boolean {
  const v = env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  if (v && v !== "0" && v.toLowerCase() !== "false") return true;
  try { return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))?.autoMemoryEnabled === false; } catch { return false; }
}

// What of MEMORY.md an agent starts with: its first lines, within both bounds,
// and whether it was cut (the agent is then asked to curate it).
// `more`: the file goes on past `text` (only its start was read).
export function memoryHead(text: string, more = false): { text: string; cut: boolean } {
  const lines = text.split("\n");
  let out = lines.slice(0, MEMORY_LINES).join("\n");
  let cut = (lines.length > MEMORY_LINES && lines.slice(MEMORY_LINES).some((l) => l.trim())) || more;
  if (Buffer.byteLength(out) > MEMORY_BYTES) {
    // Cut on a whole line where one fits, never inside a character.
    const bytes = Buffer.from(out).subarray(0, MEMORY_BYTES);
    out = bytes.toString("utf8").replace(/\uFFFD$/, "");
    const nl = out.lastIndexOf("\n");
    if (nl > 0) out = out.slice(0, nl);
    cut = true;
  }
  return { text: out, cut };
}

// MEMORY.md as the agent's task carries it: what the agent wrote there is its
// own notes, never the harness's words. Characters a reader cannot see are
// taken out, and markup that would read as the harness's own (a tag such as
// <system-reminder> or <nested-instructions>, a [harness] or [keel] line) is
// written so it no longer does, as Claude Code does with MEMORY.md (2.1.284).
// A bracket tag is any that starts with one of the harness's words, with what
// follows it ([harness take-over], [ keel: x ]); the full-width and small forms
// of the brackets count as brackets. An emoji keeps its joiners and variation
// selectors (a family, a flag of two pictographs): they draw as one picture,
// and a run of pictographs holds no letters to make a word with.
const EMOJI = /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*)/u;
const WIDE: Record<string, string> = { "\uFF3B": "[", "\uFF3D": "]", "\uFF1C": "<", "\uFF1E": ">", "\uFE64": "<", "\uFE65": ">", "\u2039": "<", "\u203A": ">", "\u3008": "<", "\u3009": ">", "\u27E8": "<", "\u27E9": ">" };
export function neutralMemory(text: string): string {
  return text.split(EMOJI).map((part, i) => (i % 2 ? part : withoutHidden(part))).join("")
    .replace(/[\uFF3B\uFF3D\uFF1C\uFF1E\uFE64\uFE65\u2039\u203A\u3008\u3009\u27E8\u27E9]/g, (c) => WIDE[c]!)
    .replace(/<(?=\s*[A-Za-z\/!?])/g, "&lt;")
    .replace(/\[(\s*(?:harness|hook|keel|sandbox|system)\b[^\]]{0,200})\]/gi, "($1)");
}

// What a write that left MEMORY.md past its bound is told, with the call's
// result (Claude Code 2.1.210: a write that leaves the index over its read
// limit is said, not cut in silence). Nothing while it is within the bound.
export function memoryOver(text: string): string | undefined {
  const head = memoryHead(text);
  if (!head.cut) return undefined;
  const lines = text.replace(/\n+$/, "").split("\n").length;
  const kb = Math.ceil(Buffer.byteLength(text) / 1024);
  const from = head.text.split("\n").length + 1;
  return `[harness] MEMORY.md is now ${lines} lines and ${kb} KB: past the ${MEMORY_LINES} lines or ${MEMORY_BYTES / 1024} KB you are given at each start, so from line ${from} on it is not read again. Move the detail into other files of the folder and keep MEMORY.md an index within the bound.`;
}

const WHERE: Record<MemoryScope, string> = {
  user: "yours across every project",
  project: "kept with this project and shared through its version control",
  local: "kept with this project and not in version control",
};

// The block of the agent's task about its memory.
export function memoryBlock(scope: MemoryScope, dir: string, memory: string | null, more = false): string {
  const head = memory === null ? null : memoryHead(memory, more);
  return [
    `You have a memory folder of your own at ${dir} (${scope} scope: ${WHERE[scope]}). It outlives this task: what you save there, you read again in later tasks.`,
    "Read it before you start and save what you learn as you work: preferences and corrections you were given, decisions, patterns and pitfalls you found. Create the folder when you first save.",
    `Keep MEMORY.md there as its index, in short lines that point to other files of the folder for detail. Only its first ${MEMORY_LINES} lines (at most ${MEMORY_BYTES / 1024} KB) are given to you at each start.`,
    head === null ? "MEMORY.md does not exist yet."
      : `MEMORY.md now${head.cut ? `, cut at that bound: curate it so what matters stays within it` : ""}:\n${neutralMemory(head.text).trim() || "(empty)"}`,
  ].join("\n");
}

// The block for an agent, with its MEMORY.md read now.
export function agentMemory(scope: MemoryScope, agent: string, cwd: string): { dir: string; block: string } | { refused: string } {
  const dir = memoryDir(scope, agent, cwd);
  if (dir === null) return { refused: `the agent's name "${agent}" is no name a folder can have` };
  // Only its start is read: past the byte bound nothing of it is given.
  let memory: string | null = null, more = false;
  try {
    const fd = openSync(join(dir, "MEMORY.md"), "r");
    try {
      const buf = Buffer.alloc(MEMORY_BYTES + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      more = n > MEMORY_BYTES;
      memory = buf.subarray(0, n).toString("utf8");
    } finally { closeSync(fd); }
  } catch {}
  return { dir, block: memoryBlock(scope, dir, memory, more) };
}
