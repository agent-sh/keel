import type { ImageBlock, TextBlock, ToolRefBlock, ToolResultBlock } from "../core/types.ts";
import type { ToolSpec } from "../providers/types.ts";
import type { CallClass } from "../safety/policy.ts";
import type { Material } from "../engine/reader.ts";
import type { ReadOutcome } from "../engine/readers.ts";
import type { WebUse } from "../safety/addresses.ts";

export type ToolContext = {
  sessionId: string;
  parentId?: string;
  // Whose call it is in the heavy-command line when the parent is not known here (a call another machine sent).
  heavyWho?: "session" | "agent";
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
  // The characters of a text result kept inline for what carrying them costs
  // this session now (set with `room`; src/tools/carry.ts), and the share of
  // them from the start of the result.
  inline?: { cap: number; head: number };
  // Files the model has read this session, with their mtime then: Edit/Write
  // refuse to overwrite a file the model never saw or that changed since.
  seen: Map<string, number>;
  // Set by a beforeTool hook: turns a command's argv into the argv that runs
  // it confined (bubblewrap, a systemd scope). Every tool that spawns uses it.
  wrapSpawn?: (argv: string[]) => string[];
  // Set by the check ledger's beforeTool hook (src/checks) on a call that runs
  // one of the repository's checks: the shell reports each command it runs
  // with the statuses before it, so the check is known to have started (a
  // wait before it can give up) and by its own status.
  checkRun?: boolean;
  // The confinement wrapSpawn applies (set with it): a tool that runs its
  // command on another machine asks that machine for the same.
  // `since`: when the confinement was set for the call (what its proxy refused after that is the call's).
  confined?: { sandbox: "workspace-write" | "read-only"; network: boolean; since?: number };
  // Set by a beforeTool hook: the files and folders this call was judged for, where they are (no link in a path).
  // A file tool opens nothing else (src/tools/files.ts hold).
  judged?: string[];
  // With it: the file each of those names was at the gate's look (device and inode), or null for a name that was
  // not there. A name that is another file by the time of the open is not what was judged.
  looked?: Record<string, string | null>;
  // Set by the permission gate on a reading call: the credential a path is or is in (src/safety/credentials.ts).
  // A search of a folder leaves out what it names; a path the call names by itself was asked about at the gate.
  credential?: (path: string) => { what: string } | null;
  // The tool_use id of the call being run (set per call by the engine).
  callId?: string;
  // Set on a call a program made (run_code): the id of the turn's call that runs the program.
  nestedIn?: string;
  // Set by a beforeTool hook: runs the call somewhere else (the session's
  // machine) instead of tool.run here.
  dispatch?: (tool: Tool, input: any, ctx: ToolContext) => Promise<ToolOutput>;
  // Recheck an Auto authorization at an invocation reached after a lookup.
  authorizationError?: () => string | undefined;
  // Set by the engine: runs another tool of the session as a call of its own
  // (gate, hooks, dispatch, under the id given), for a tool that calls tools (run_code).
  // `signal`: the call's own, for a program that went on past its turn (the turn's does not stop it).
  callTool?: (name: string, input: any, id: string, signal?: AbortSignal) => Promise<ToolResultBlock>;
  // Set by the engine: whether the session's tool set offers this tool (a hint names only what the model has).
  offers?: (name: string) => boolean;
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
  // A mark of a change a live session must not wait for (src/core/build.ts
  // URGENT): any new text, written on the tool itself so two branches that
  // each mark a tool change two places and merge clean.
  urgent?: string;
  kind?: ToolKind;
  // A shell tool whose shell reports each command it runs to the check ledger
  // when asked (ctx.checkRun, src/tools/shell.ts): a check behind a wait, or
  // with commands after it, is known to have started and by its own status.
  tracesChecks?: true;
  // A shell tool that applies an apply_patch invocation in its command itself
  // (no shell runs): the gate judges such a call as the edit it is.
  appliesPatch?: true;
  // Its input goes to another machine (keel__run_on): sent with secret placeholders, never values.
  peer?: boolean;
  // Where a call's relative paths resolve, when not the session's folder
  // (apply_patch: the shell's current directory).
  cwdOf?(ctx: ToolContext, input: any): string;
  // The program a shell tool hands its command to, when a call can name one
  // (exec_command's shell). The gate reads a command as bash does: what
  // another interpreter runs is never taken for a read.
  interpreter?(input: any): string;
  // The effective command Auto can judge, or undefined for an unsupported
  // invocation (custom interpreter, login startup, intercepted commands).
  autoShell?(input: any): { command: string; interpreter: string; options?: unknown } | undefined;
  // A command an external agent already asked about runs without a second card (src/acp/terminals.ts; the gate's answeredOnce).
  answeredBefore?: true;
  // A dispatcher (mcp_call) names the tool it will run, so the permission gate
  // judges and grants that tool, not the dispatcher.
  // `cls`, when given, is what the call does (a drive tool judges its target).
  // `source` names what runs it (an MCP server's binding): a grant is for that
  // source. `shape` is the tool's name, description, schema and read flag as
  // judged: a remembered refusal or retry is for that shape on that source.
  // `session`: the session that calls, for a tool only it is offered.
  target?(input: any, session?: string): Promise<{ name: string; readOnly: boolean; input: any; cls?: CallClass; source?: string; shape?: string } | null>;
  // The running build's own input schema, when the definition a request
  // carries is one the session was sent before (src/tools/pin.ts): what the
  // permission gate reads, never the pinned one.
  built?: Record<string, unknown>;
  // What it does on the web (src/safety/addresses.ts): a search, whose results
  // name addresses a fetch may then go to unasked, or a fetch, which goes
  // unasked only to an address the session has seen and is judged as a send
  // to any other.
  web?: WebUse;
  // A shared tool offered only to these families (default: every family).
  families?: string[];
  // It only waits on the owner's answer (a question, a plan to approve): a
  // restart leaves it without a result, and the continued turn runs it again
  // with the same call id, so the same card waits.
  asksOwner?: boolean;
  // Every call goes to the owner on a card of its own (a mail sent as them),
  // in every mode: no grant, mode or reviewer settles it. `shown`: the card's text.
  confirm?: { why: string; shown(input: any): string };
  // The most characters of text its result may hold, when that is not the
  // one cap of every tool (OUTPUT_CAP, which the engine enforces through the
  // spill): set only by a tool that bounds its result itself, with the reason.
  resultCap?: number;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
};

export const ok = (content: string): ToolOutput => ({ content });
export const fail = (content: string): ToolOutput => ({ content, is_error: true });
