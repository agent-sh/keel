// What the owner decided in Claude Code about project MCP servers, read from
// files a repository cannot write: ~/.claude.json's entries for projects
// (keyed by the folder Claude Code ran in) and ~/.claude/settings.json.
// Pure and self-contained: it runs on the read thread (src/server/read-tasks.ts).
import { readFileSync } from "node:fs";

export type ClaudeChoice = { all: boolean; on: string[]; off: string[] };

export function claudeMcpChoices(files: string[], roots: string[]): Record<string, ClaudeChoice> {
  const out: Record<string, ClaudeChoice> = {};
  const add = (root: string, src: any) => {
    if (!src || typeof src !== "object") return;
    const c = (out[root] ??= { all: false, on: [], off: [] });
    if (src.enableAllProjectMcpServers === true) c.all = true;
    for (const n of Array.isArray(src.enabledMcpjsonServers) ? src.enabledMcpjsonServers : []) c.on.push(String(n));
    for (const n of Array.isArray(src.disabledMcpjsonServers) ? src.disabledMcpjsonServers : []) c.off.push(String(n));
  };
  for (const f of files) {
    let raw: any;
    try { raw = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    if (f.endsWith(".claude.json")) for (const r of roots) add(r, raw?.projects?.[r]);
    else for (const r of roots) add(r, raw); // the user's settings: every project
  }
  return out;
}
