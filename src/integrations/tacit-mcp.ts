// tacit's own tools (tacit_search, tacit_fact, tacit_add and the rest) as a
// server Keel brings itself, beside the store's hooks (tacit.ts). The hooks
// name these tools in every block they give ("run one tacit_search"), so a
// machine where Keel runs the hooks offers the tools too: the store's own
// `tacit mcp`, started at the first call, under the writer a note from Keel
// is recorded as (memory-store.ts). Its list ships with Keel, so a search
// starts nothing; once it runs, its own list is the one offered.
//
// A session with memory turned off is refused here, before any card: the
// owner said that session does not read the store.
import type { McpManager } from "../mcp/manager.ts";
import type { McpTool } from "../mcp/client.ts";
import { memoryWriter } from "./memory-store.ts";
import { findBin } from "./tacit.ts";
import shipped from "./tacit_tools.json" with { type: "json" };

export const TACIT_SERVER = "tacit";

// The tools that only read the store, or record which of its lines helped
// (tacit_mark changes no fact): they run without asking. tacit_add writes a
// note, so it asks as any other change does.
const READS = new Set(["tacit_tree", "tacit_search", "tacit_fact", "tacit_episode", "tacit_mark"]);

export const MEMORY_OFF = "Memory is turned off in this session: the owner's memory store is not read or written from it.";

export function installTacitServer(m: McpManager, useMemory: (session: string) => boolean, bin = findBin("TACIT_BIN", "tacit")) {
  m.addBundled(TACIT_SERVER, {
    label: "Memory (tacit)",
    config: bin ? { command: bin, args: ["mcp", "--harness", memoryWriter()] } : null,
    missing: "tacit is not installed on this machine (not on PATH, in ~/.local/bin or at TACIT_BIN)",
    tools: (shipped.tools as any[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) as McpTool[],
    instructions: shipped.instructions,
    reads: (tool) => READS.has(tool),
    call(tool, input, ctx, run) {
      if (!useMemory(ctx.sessionId)) return Promise.resolve({ content: MEMORY_OFF, is_error: true });
      return run(tool, input);
    },
  });
}
