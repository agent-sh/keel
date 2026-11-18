import type { ImageBlock, TextBlock } from "../core/types.ts";
import type { ToolSpec } from "../providers/types.ts";

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
};

export type ToolOutput = { content: string | (TextBlock | ImageBlock)[]; is_error?: boolean };

export type Tool = ToolSpec & {
  readOnly: boolean;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (content: string): ToolOutput => ({ content, is_error: true });
