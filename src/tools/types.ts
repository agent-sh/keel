import type { ImageBlock, TextBlock, ToolResultBlock } from "../core/types.ts";
import type { ToolSpec } from "../providers/types.ts";
import type { CallClass } from "../safety/policy.ts";

export type ToolContext = {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  spillDir: string;
  // Files the model has read this session, with their mtime then: Edit/Write
  // refuse to overwrite a file the model never saw or that changed since.
  seen: Map<string, number>;
  // Set by a beforeTool hook: turns a command's argv into the argv that runs
  // it confined (bubblewrap, a systemd scope). Every tool that spawns uses it.
  wrapSpawn?: (argv: string[]) => string[];
  // The tool_use id of the call being run (set per call by the engine).
  callId?: string;
  // Set by a beforeTool hook: runs the call somewhere else (the session's
  // machine) instead of tool.run here.
  dispatch?: (tool: Tool, input: any, ctx: ToolContext) => Promise<ToolOutput>;
  // Set by the engine: runs another tool of the session as a call of its own
  // (gate, hooks, dispatch, under the id given), for a tool that calls tools (run_code).
  callTool?: (name: string, input: any, id: string) => Promise<ToolResultBlock>;
};

export type ToolOutput = { content: string | (TextBlock | ImageBlock)[]; is_error?: boolean };

export type Tool = ToolSpec & {
  readOnly: boolean;
  // A dispatcher (mcp_call) names the tool it will run, so the permission gate
  // judges and grants that tool, not the dispatcher.
  // `cls`, when given, is what the call does (a drive tool judges its target).
  target?(input: any): Promise<{ name: string; readOnly: boolean; input: any; cls?: CallClass } | null>;
  // A shared tool offered only to these families (default: every family).
  families?: string[];
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (content: string): ToolOutput => ({ content, is_error: true });
