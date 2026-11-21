import type { ImageBlock, TextBlock, ToolRefBlock, ToolResultBlock } from "../core/types.ts";
import type { ToolSpec } from "../providers/types.ts";
import type { CallClass } from "../safety/policy.ts";
import type { Material } from "../engine/reader.ts";
import type { ReadOutcome } from "../engine/readers.ts";

export type ToolContext = {
  sessionId: string;
  parentId?: string;
  // A question started or stopped waiting for an answer.
  questionChanged?: () => void;
  // Set by the engine: whether this text is in what the model sees now (the
  // context after the last compaction or clear, on the branch shown).
  inContext?: (text: string) => boolean;
  cwd: string;
  signal: AbortSignal;
  spillDir: string;
  // Tokens left in the model's context window after its last request (set by
  // the engine before each round of calls): what a large read may fill.
  room?: number;
  // Files the model has read this session, with their mtime then: Edit/Write
  // refuse to overwrite a file the model never saw or that changed since.
  seen: Map<string, number>;
  // Set by a beforeTool hook: turns a command's argv into the argv that runs
  // it confined (bubblewrap, a systemd scope). Every tool that spawns uses it.
  wrapSpawn?: (argv: string[]) => string[];
  // The confinement wrapSpawn applies (set with it): a tool that runs its
  // command on another machine asks that machine for the same.
  confined?: { sandbox: "workspace-write" | "read-only"; network: boolean };
  // The tool_use id of the call being run (set per call by the engine).
  callId?: string;
  // Set by a beforeTool hook: runs the call somewhere else (the session's
  // machine) instead of tool.run here.
  dispatch?: (tool: Tool, input: any, ctx: ToolContext) => Promise<ToolOutput>;
  // Recheck an Auto authorization at an invocation reached after a lookup.
  authorizationError?: () => string | undefined;
  // Set by the engine: runs another tool of the session as a call of its own
  // (gate, hooks, dispatch, under the id given), for a tool that calls tools (run_code).
  callTool?: (name: string, input: any, id: string) => Promise<ToolResultBlock>;
  // Set by the engine: long content read by the session's reader model with a
  // request; resolves to the reader's answer (src/engine/reader.ts).
  // `compiled` false: the text is every part's findings, not one answer.
  // `unread`: parts of the content no reader read, which the answer does not cover.
  read?: (source: string, text: string, prompt: string) => Promise<{ text: string; model: string; compiled?: boolean; unread?: string[] }>;
  // Set by the engine: one reading job over many sources, split across reader
  // models and compiled into one answer (src/engine/readers.ts).
  readMaterial?: (items: Material[], question: string, callId?: string) => Promise<ReadOutcome>;
  // Set by the engine: the most characters one reading job of the session
  // reads, from the model listing; the readers tool gathers no more.
  readBudget?: () => Promise<number>;
};

// `shown`: what the transcript shows for the call besides its result (the
// owner's answers to a question, by question), stored on the tool_result event
// and never sent to a model.
export type ToolOutput = { content: string | (TextBlock | ImageBlock | ToolRefBlock)[]; is_error?: boolean; shown?: unknown };

// What a call of a tool does, for the permission gate: declared by the tool,
// never read off its input. readOnly tools are reads; a tool that declares no
// kind is judged by its name ("other": it asks, and a grant names it).
//   shell: runs the command in its input here; edit: writes the paths in its
//   input; control: input to, or the stop of, a process an allowed call
//   started; remote: acts on another machine.
export type ToolKind = "shell" | "edit" | "control" | "remote";

export type Tool = ToolSpec & {
  readOnly: boolean;
  kind?: ToolKind;
  // Its input goes to another machine (keel__run_on): sent with secret placeholders, never values.
  peer?: boolean;
  // Where a call's relative paths resolve, when not the session's folder
  // (apply_patch: the shell's current directory).
  cwdOf?(ctx: ToolContext, input: any): string;
  // The effective command Auto can judge, or undefined for an unsupported
  // invocation (custom interpreter, login startup, intercepted commands).
  autoShell?(input: any): { command: string; interpreter: string; options?: unknown } | undefined;
  // A dispatcher (mcp_call) names the tool it will run, so the permission gate
  // judges and grants that tool, not the dispatcher.
  // `cls`, when given, is what the call does (a drive tool judges its target).
  // `source` names what runs it (an MCP server's binding): a grant is for that
  // source. `shape` is the tool's name, description, schema and read flag as
  // judged: a remembered refusal or retry is for that shape on that source.
  target?(input: any): Promise<{ name: string; readOnly: boolean; input: any; cls?: CallClass; source?: string; shape?: string } | null>;
  // A shared tool offered only to these families (default: every family).
  families?: string[];
  // It only waits on the owner's answer (a question, a plan to approve): a
  // restart leaves it without a result, and the continued turn runs it again
  // with the same call id, so the same card waits.
  asksOwner?: boolean;
  // Every call goes to the owner on a card of its own (a mail sent as them),
  // in every mode: no grant, mode or reviewer settles it. `shown`: the card's text.
  confirm?: { why: string; shown(input: any): string };
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (content: string): ToolOutput => ({ content, is_error: true });
