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

export type MemoryScope = "user" | "project" | "local";
export const SCOPES: readonly MemoryScope[] = ["user", "project", "local"];
export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25 * 1024;

// The folder of an agent's memory, for an agent working in `cwd`.
export function memoryDir(scope: MemoryScope, agent: string, cwd: string, home = importHome()): string {
  const name = agent.replace(/[^\w.-]+/g, "-");
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
      : `MEMORY.md now${head.cut ? `, cut at that bound: curate it so what matters stays within it` : ""}:\n${head.text.trim() || "(empty)"}`,
  ].join("\n");
}

// The block for an agent, with its MEMORY.md read now.
export function agentMemory(scope: MemoryScope, agent: string, cwd: string): { dir: string; block: string } {
  const dir = memoryDir(scope, agent, cwd);
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
