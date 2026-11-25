// The instruction files a repository can bring into a session's prompt, by path
// from a folder: every name any family's chain loads (src/engine/native-memory.ts
// reads these lists, so does the trust scan in trust.ts, and so does the head
// of a pull request's read of the base branch's own copies). One place, so a
// file a chain loads is never a file the trust pin does not cover.

// Claude Code's: the project file, the same under .claude, and the personal one.
export const CLAUDE_FILES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] as const;
// What stands in for them where none of those exists.
export const CLAUDE_AGENTS_FILES = ["AGENTS.md", ".claude/AGENTS.md"] as const;
// Codex's: the override first, then the shared file (its fallback names come from the owner's config).
export const CODEX_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

// Every name a chain can load from a folder of a repository, in the order a scan lists them.
export const INSTRUCTION_FILES: readonly string[] = [...new Set([...CODEX_FILES, ...CLAUDE_AGENTS_FILES, ...CLAUDE_FILES])];

// The names to scan for, with the fallback names the owner's Codex config adds.
export function instructionNames(fallback: readonly string[] = []): string[] {
  return [...new Set([...INSTRUCTION_FILES, ...fallback])];
}

// Whether a path (from a repository's root, or absolute) is one of those files.
export function isInstructionPath(path: string, fallback: readonly string[] = []): boolean {
  const names = instructionNames(fallback);
  return names.some((n) => path === n || path.endsWith(`/${n}`));
}
