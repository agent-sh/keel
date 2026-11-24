import type { Ruled } from "../safety/trial.ts";
import type { Message, QueueItem, Session, StoredEvent, ToolResultBlock, TurnStatus, Usage } from "../core/types.ts";
import type { ModelInfo, ProviderRequest, ProviderResult } from "../providers/types.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { Crossing } from "../safety/route-rule.ts";

// One tool call as the turn is about to run it.
// `hook`: what the owner's PreToolUse hooks did to the call before any gate saw
// it. `from`: the input the model wrote, when a hook changed it (`input` is then
// what every gate judges and what runs). `allowed`: a hook allowed the call,
// with its reason; `skipped`: that allow answered an ask in the owner's place.
// `hook.failed`: hooks of the call that failed (src/integrations/hooks.ts hookFailureText): shown under it.
// `ruled`: what the gate's rules decided of the call, stored with its result (src/safety/trial.ts).
export type ToolCall = { id: string; tool: Tool; input: any; ctx: ToolContext; hook?: { from?: any; allowed?: string; skipped?: true; failed?: string[] }; ruled?: Ruled };

// What a hook says reaches the model as the hook's words and nothing else: at
// most HOOK_SAID characters, with no tag in it (every `<` that could open or
// close one is written `&lt;`, so it closes no frame it is put in and opens
// none the harness uses, whatever their names), and nowhere the mark the
// harness or a hook's own prompt starts with. Its text can come from another
// machine (an http hook's answer, an MCP tool's).
export const HOOK_SAID = 10_000;
export const hookSaid = (v: unknown, max = HOOK_SAID) => String(v).slice(0, max).replace(/<(?=\s*[A-Za-z\/!?])/g, "&lt;").replace(/\[(harness|hook)\]/gi, "($1)");

// What the model reads on the result of a call whose input a hook changed:
// the input that was judged, and whether the call ran with it.
export const hookChanged = (input: unknown, ran: boolean) =>
  `<hook event="PreToolUse">\nA hook of the owner's changed this call's input before it was judged. ${ran ? "It ran with" : "It did not run. The input that was judged"}:\n${hookSaid(JSON.stringify(input) ?? "", 4000)}\n</hook>`;

// What a beforeTool hook may answer: refuse the call (the reason is the tool
// result the model sees), or run it with a changed input or context (a
// sandbox sets ctx.wrapSpawn). Nothing means "no opinion".
// A permission that must still hold at dispatch. Refresh any asynchronous
// target after earlier hooks, then check synchronously with the executed input.
export type ToolAuthorization = {
  refresh?(call: ToolCall): Promise<void>;
  valid(call: ToolCall, input: any): boolean;
  deny: string;
};
// `answer`: the call is answered without running (the check ledger's answer to
// a check that already passed on the same files): its result is that text,
// not an error, and the hooks after this one are not asked.
export type ToolGate = void | { deny: string } | { answer: string } | { input?: any; ctx?: Partial<ToolContext>; authorization?: ToolAuthorization };

// A block of the system prompt that renders the owner's or the machine's own
// data (their servers, skills, agent types, files): `data` is that data alone,
// without the words around it, and `name` names the block also while it is
// empty. A kept prompt follows a change of the data at the first request after
// a daemon start; a change of the words alone is the build's and waits until
// the session's cache is cold (src/engine/build-pin.ts). A plain string is the
// build's own words.
// `same`: what the block is compared by, when its text also holds what changes
// with nothing it describes changing (which descriptions a listing cut to fit
// keeps, by how often each was used): the block is made again only when this,
// or the data, differs. Absent: its text.
export type SystemBlock = { name: string; text: string; data: string; same?: string };

// A turn a daemon stop or kill cut, as the next start found it.
export type CutTurn = {
  turn_event: string;  // its turn_start event
  end_event: string;   // the turn_end that closed it
  started_ms: number;
  ran_ms: number;      // how long it ran before it was cut
  down_ms: number;     // when it was cut: when the daemon went down, as far as that is known
  crashed: boolean;    // the daemon went down under it; false: a stop parked it
  unstarted: boolean;  // the prompt was accepted and its turn never began
  step: number;        // the step it was on
  tools: string[];     // the calls that were running
  waiting: number;     // calls that wait on the owner: an approval, a question or a plan card left open
};
// What became of it: continued by itself, held for the owner (with the reason),
// or the session went on by other means before it was continued.
export type CutState = "continued" | "held" | "moved";

// Points where feature modules join the turn loop without editing it.
export type TurnHooks = {
  // Extra text for the system prompt; called once per session (the prompt is
  // frozen), with the model the session's first request goes to.
  system?: (s: Session, model?: ModelInfo) => string | SystemBlock | Promise<string | SystemBlock>;
  // Text of the session's own part of the prompt, after the cache split (a
  // project's instructions): it never enters the prefix other sessions share.
  // Rendered and kept like the rest; Engine.forgetSystem has it made again.
  sessionSystem?: (s: Session, model?: ModelInfo) => string | SystemBlock | Promise<string | SystemBlock>;
  // Change the request just before it is sent (compaction, volatile-tail notes).
  // Must keep the prefix stable: append, never rewrite earlier messages.
  // Runs for every purpose: a hook that answers the newest prompt or rebuilds
  // the messages from the branch does so for `purpose: "turn"` only (a summary
  // or side request carries its own ask, which the branch does not hold).
  beforeRequest?: (s: Session, req: ProviderRequest) => ProviderRequest | Promise<ProviderRequest>;
  // Whether a request may be sent at all (a spend limit): it throws to refuse
  // it. Runs for every request, a reader's and a title's too, which skip
  // beforeRequest (they carry no conversation to add to), and before it.
  mayRequest?: (s: Session, req: ProviderRequest) => void;
  // Every provider call, turn steps, summaries and side answers alike, for
  // measuring only: the request exactly as sent (after every beforeRequest and
  // the attachment projection), then its answer or its failure (`aborted`: the
  // turn was stopped; a retry may follow). `req` is the same object in all three.
  requestSent?: (s: Session, req: ProviderRequest) => void;
  requestDone?: (s: Session, req: ProviderRequest, res: ProviderResult) => void;
  requestWaitEnded?: (s: Session, req: ProviderRequest, ms: number) => void;
  requestWaiting?: (s: Session, req: ProviderRequest) => void;
  requestFailed?: (s: Session, req: ProviderRequest, err: unknown, aborted: boolean) => void;
  // A turn's request has been answered overloaded as many times as the counted retries and is
  // still tried (src/engine/retry.ts overloaded): `ms` since the model first said so. Once a request.
  capacityWaiting?: (s: Session, model: string, ms: number) => void;
  // An agent's route stayed out for as long as the owner's rule says, and the agent went on on
  // another model for good (src/engine/route-change.ts). `from`, `to`: the models' names.
  routeChanged?: (s: Session, c: { why: "outage" | "overloaded"; from: string; to: string; ms: number; fromModel: string; toModel: string; extra?: number; effort?: { from?: string; to?: string } }) => void;
  // Asked before the owner's rule moves an agent to `to`: words when a limit the hook keeps would not
  // hold there (a dollar budget or cap, which a model with no listed price never reaches). The agent
  // then keeps waiting, and the words are said once in its failures.
  moveRefused?: (s: Session, to: { id: string; name: string; price?: unknown }) => string | undefined;
  // A model call for the session would go to a provider its folder does not allow, and was not
  // made (src/safety/content-routes.ts). `tell`: its model is to hear of it with its next input.
  routeRefused?: (s: Session, c: Crossing, tell: boolean) => void;
  // Tools the request leaves out because their input schema cannot be made to
  // fit the wire (src/providers/wires/schema-fit.ts), each named once a session.
  toolsLeftOut?: (s: Session, left: { name: string; why: string }[]) => void;
  // A provider refused one tool's input schema: the request was sent again
  // with that tool declared without its parameters, as it is from here.
  toolSchemaRefused?: (s: Session, tool: string, message: string) => void;
  // Each streamed piece of the answer, side answers too (they never reach the bus).
  requestDelta?: (s: Session, req: ProviderRequest, d: { kind: string; text: string }) => void;
  afterResponse?: (s: Session, res: ProviderResult, messages: Message[]) => void | Promise<void>;
  // The owner's hooks on a call, before every beforeTool: refuse it, change its
  // input (`call.input` becomes it and `call.hook.from` keeps what the model
  // wrote) or allow it (`call.hook.allowed`, which the permission gate reads).
  prepareTool?: (s: Session, call: ToolCall) => void | { deny: string } | { input?: any; allow?: string } | Promise<void | { deny: string } | { input?: any; allow?: string }>;
  // Before each tool call, in registration order; may wait (an approval). The
  // first deny wins and the call does not run. Watch call.ctx.signal.
  beforeTool?: (s: Session, call: ToolCall) => ToolGate | Promise<ToolGate>;
  // The input the tool runs with when it differs from the one shown and
  // recorded (a secret's value in place of its placeholder). Asked after every
  // beforeTool passed; call.input keeps what the model wrote.
  execInput?: (s: Session, call: ToolCall) => any;
  // After each call that ran, with its result (checkpoints, audit).
  afterTool?: (s: Session, call: ToolCall, result: ToolResultBlock) => void | Promise<void>;
  // A call whose tool threw (afterTool does not run for it): the failed result
  // the model gets, which the hook may add to.
  toolFailed?: (s: Session, call: ToolCall, result: ToolResultBlock, error: Error) => void | Promise<void>;
  // For measuring only: every call that was dispatched, however it ended,
  // with the time the tool itself took (no approval wait, no afterTool hooks).
  // `error`: what the tool threw, when it threw (a result that only says it failed has none).
  toolRan?: (s: Session, call: ToolCall, result: ToolResultBlock, ran: { ms: number; outcome: "ok" | "error" | "interrupted"; error?: Error }) => void;
  // A tool result was stored: called in the same SQLite transaction as the
  // append, so what it records (a handback delivered) commits with the result.
  resultStored?: (s: Session, results: ToolResultBlock[]) => void;
  // After a step's tool results are stored, before the next model call (a
  // tool that asked for a fresh context gets its checkpoint here).
  stepDone?: (s: Session) => void | Promise<void>;
  // Before each model step: the words of the harness's last request when a budget the hook keeps
  // for the session is spent (an agent's steps, minutes or dollars). That step's calls are not run
  // and the turn ends "budget" after it. Nothing: the step goes on as usual. `cap`: the words are the
  // session's dollar cap's (its calls' results say so). `note`: not a last step, only a note the turn
  // carries once (a cap that is reached while the owner's own message runs the turn). `byOwner`: the
  // turn was started or steered by the owner's own words (asked only when it matters).
  budget?: (s: Session, byOwner: () => boolean) => string | { text: string; cap?: boolean; note?: boolean } | undefined;
  // An input from another session (kind "peer") that must wait for a reason the hook keeps (a reached
  // dollar cap): stored in the session's queue, and not started while this says so. Asked when the
  // input comes to an idle session and again when the queue would start it; the owner's own words
  // are never asked.
  holdsInput?: (s: Session, meta: Record<string, unknown>) => boolean;
  // A turn is starting in the session, whatever started it (a prompt, a queued
  // one, a report, a continuation after a restart).
  turnStart?: (s: Session) => void;
  turnEnd?: (s: Session, reason: string) => void | Promise<void>;
  // The model and effort the rest of the turn runs at in place of the session's
  // (an inline skill's frontmatter: src/tools/skill-turn.ts). `from`: what chose
  // them, said in the note. `wider`: the model may be on another provider.
  turnChoice?: (s: Session) => { model?: string; effort?: string; from: string; wider: boolean } | undefined;
  // At startup, a turn a daemon restart cut is about to continue by itself.
  // `stalled`: how many continuations in a row were cut before they finished a
  // step. A session's owner (an agent's record) answers "continue", or `hold`
  // with the reason it is not continued (shown in the session). No answer: the
  // engine's rule, which continues unless the count reached STALLED_MAX.
  cutTurn?: (s: Session, cut: { stalled: number }) => "continue" | { hold: string } | undefined;
  // A cut turn was not continued, for the reason given (a hook's, the engine's
  // rule, or a model that did not come back).
  cutTurnHeld?: (s: Session, why: string) => void;
  // For the record only: each turn the last daemon's stop or kill cut, once
  // this start has every module up, and then what became of it.
  turnCut?: (s: Session, cut: CutTurn) => void;
  turnCutSettled?: (s: Session, cut: CutTurn, state: CutState, why?: string) => void;
  // A call a restart cut, with no stored result: what its approval recorded.
  // `denied`: the text the model gets (the owner's reason in it); `not_run`:
  // nothing answered it, so it never ran; `waiting`: its card is still open (or
  // was answered since), so the continued turn runs the call again and gets
  // that card back. `done`: what the call was for was stored before the cut
  // (a message kept for its receiver): the text says so, and the result is no
  // error. Nothing known: it may have partly run.
  callOutcome?: (sessionId: string, callId: string) => { denied: string } | { done: string } | "not_run" | "waiting" | undefined;
  // Whether the call waits on a card only the owner can answer, right now (an open approval).
  awaitsOwner?: (sessionId: string, callId: string) => boolean;
  // A call that is no question tool put a question to the owner on its card
  // (an MCP server asked while the call ran), and that question closed.
  // `askId`: one per question (a call's server can ask more than one).
  ownerAsked?: (sessionId: string, callId: string, text: string, askId: string) => void;
  ownerAnswered?: (sessionId: string, callId: string, answered: boolean, askId: string) => void;
  // Queued input that named a sender left a session's queue unread: its
  // session was deleted or archived, or the owner removed the row. Whoever
  // knows the sender tells it (src/automation/undelivered.ts).
  // `session`: the receiver, when it is gone from the store by now.
  inputDropped?: (rows: QueueItem[], why: "deleted" | "archived" | "removed", session?: Session) => void;
  // A session the owner was archiving or deleting stays after all (a command of it would not
  // stop): what was kept back for it while it was on its way out goes now.
  closingOver?: (sessionId: string) => void;
  // The daemon stops and parks this session's turn (before its signal aborts).
  turnParking?: (sessionId: string) => void;
  // Work that is not a turn and that a stop should not cut (a session moving
  // to another machine): the drain waits for it too, within its time.
  draining?: () => Promise<unknown> | undefined;
  // A drain was called off: what waited for the daemon to stop goes on.
  drainOff?: () => void;
  // Before a compaction summarises the history (a memory tool reads it whole first).
  // `auto`: Keel started it (the line, the window, idle); else the owner asked, with `focus` as their words.
  beforeCompact?: (s: Session, why?: { auto: boolean; focus?: string }) => void | Promise<void>;
  // A summary took the place of the history it covers (`ev` is the stored compaction event).
  afterCompact?: (s: Session, ev: StoredEvent) => void | Promise<void>;
  // What a summary of this session keeps above all, when the owner named nothing
  // (the helper's summary keeps their decisions and commitments, not files).
  compactFocus?: (s: Session) => string | undefined;
  // A session another agent answers (an ACP agent): its runner takes the whole
  // turn, keeps its own history, and stores what happened through `io`. The
  // first hook that returns a runner wins; the provider loop does not run.
  external?: (s: Session) => ExternalTurn | undefined;
};

export type ExternalIO = {
  signal: AbortSignal;
  events(): readonly StoredEvent[];   // the branch shown, as it is now
  append(kind: StoredEvent["kind"], data: unknown): StoredEvent;
  delta(kind: "text" | "thinking", index: number, text: string): void;
  status(s: TurnStatus): void;
  // A tool of Keel's run for the agent, as a call of this session's model
  // would run: the owner's hooks, the permission gate, then the tool. A shared
  // tool by its name, or one the runner makes (a terminal's command). The
  // result is the agent's to show; nothing of the call is stored here.
  runTool(tool: string | Tool, input: unknown, id: string): Promise<ToolResultBlock>;
};
export type ExternalTurn = (io: ExternalIO) => Promise<{ reason: string; usage?: Usage }>;

// What the ledger found of a turn request's cache, set by its requestDone
// (src/admin/telemetry.ts cacheBreak): the cause it counts a break by, or
// "none" when the request read the cache. A wait kept warm is told by it
// (src/engine/cache-plans.ts answered): a break the warm requests did not
// cause is not theirs.
export const cacheBreaks = new WeakMap<ProviderResult, string>();

const hooks: TurnHooks[] = [];
export const registerHooks = (h: TurnHooks) => void hooks.push(h);
export const allHooks = () => hooks;

// A model request sent outside the engine's request loop (the policy judge's): the measuring hooks see
// it as they see the engine's (sent, each streamed piece, its answer or its failure), so the ledger,
// the trace and the owner's request hooks count it with the rest. `aborted`: stopped by its caller,
// not by its own time limit (a time limit that ends a request is that request's failure).
export async function measured(s: Session, req: ProviderRequest, send: (onDelta: (d: { kind: string; text: string }) => void) => Promise<ProviderResult>, aborted: () => boolean = () => false): Promise<ProviderResult> {
  const each = (f: (h: TurnHooks) => void) => { for (const h of hooks) try { f(h); } catch { /* a measuring hook never fails the request */ } };
  each((h) => h.requestSent?.(s, req));
  try {
    const res = await send((d) => each((h) => h.requestDelta?.(s, req, d)));
    each((h) => h.requestDone?.(s, req, res));
    return res;
  } catch (e) {
    each((h) => h.requestFailed?.(s, req, e, aborted()));
    throw e;
  }
}
