import { type Wire, wireOf, wireScope } from "../providers/wiretap.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rootOf } from "../safety/trust.ts";
import type { Bus } from "../core/bus.ts";
import { errorScope, type ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import { conceal } from "../core/conceal.ts";
import { ownerPrompt } from "../core/owner.ts";
import { blockName, blocksOf, changedBlocks, PromptStore, type PromptPart } from "./prompt-store.ts";
import { testBuild } from "../core/build.ts";
import { BuildPins, coldReason } from "./build-pin.ts";
import type { AssistantBlock, Message, QueueItem, Session, StoredEvent, ToolResultBlock, ToolUseBlock, TurnStatus, Usage, UserBlock } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import { configDir } from "../providers/config.ts";
import type { ModelInfo, Provider, ProviderRequest, ProviderResult } from "../providers/types.ts";
import { asksOwner, registerPinnedDeferred, sessionToolsKey, toolsFor } from "../tools/registry.ts";
import { allPendingQuestions } from "../tools/interact.ts";
import { APPROVAL_CUT, QUESTION_CUT, RESTART_CUT, STOPPED_BEFORE, STOPPED_WHILE, stopKind } from "../core/stops.ts";
import { dropCallEnv } from "../tools/jobs.ts";
import { isDeferError, loadsNatively, referenced, refuseDefer, withCatalog } from "../tools/defer.ts";
import { allHooks, hookChanged, type CutState, type CutTurn, type ExternalTurn, type SystemBlock, type ToolAuthorization, type ToolCall } from "./hooks.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { READER_OUTPUT, READER_SYSTEM, type Material } from "./reader.ts";
import { readBudget, readMaterial, readSource, type ReaderHost, type ReadOutcome } from "./readers.ts";
import { STALE_BIND } from "../providers/wires/binding.ts";
import { TRANSCRIPT_PARTS_MAX, transcriptPartsPaced, bytesPerToken, capRatio, checkpointAt, OWNER_WORDS_BYTES, COMPACT_SHARE, contextBytes, contextTokens, messagesBytes, RATIO_MAX, headMoved, learnRatio, partPrompt, setRatio, transcriptParts, recut, condensePrompt, shorterPrompt, utf8Bytes, IDLE_MARGIN_MS, idleDue, type IdleFacts, checkpointData, lastWarm, preparedWarm, preparedHolds, PREPARE_SHARE, summarizable, summaryMessage, summaryPrompt, worthSummarizing } from "./compact.ts";
import { effectiveEffort, longestSure, PAUSE_MARGIN_MS, retention } from "./cachewarn.ts";
import { askedLife, cacheLives } from "../providers/wires/common.ts";
import { withoutImages } from "./images.ts";
import { anyOver, damagedImages, fitForWire, fitToolImages, imageKeys } from "./image-fit.ts";
import { imageLimits, imageRefusal, requestTooLarge } from "../providers/image-limits.ts";
import { resolveAttachments } from "./attachments.ts";
import { RETRY, RETRY_WAIT_MAX_MS, RetryTooLong, backoffMs, errorText, retryable, sleep } from "./retry.ts";
import { capResult, OUTPUT_CAP } from "../tools/spill.ts";

// What a result says of a call a restart cut or the owner's stop reached (src/core/stops.ts).
export { APPROVAL_CUT, QUESTION_CUT, RESTART_CUT };
// A result that says the turn was stopped or cut under the call, not that the call failed.
export const isStopResult = (content: unknown) => stopKind(content) !== undefined;
const outcomeOf = (session: string, callId: string) => allHooks().map((h) => h.callOutcome?.(session, callId)).find(Boolean);
const cutText = (session: string, u: { id: string; name: string }) => {
  if (asksOwner(u.name)) return QUESTION_CUT;
  const o = outcomeOf(session, u.id);
  return o === "not_run" || o === "waiting" ? APPROVAL_CUT : o ? o.denied : RESTART_CUT;
};
// A call that waits on the owner and has done nothing yet: one whose approval
// card is open (Gate), a question, a plan put up for approval. A restart does
// not answer it: it keeps no result and waits on the same card afterwards.
const waitsOnOwner = (session: string, u: { id: string; name: string }) => asksOwner(u.name) || outcomeOf(session, u.id) === "waiting";
// A call a restart cut while its card was open has no result: the next turn
// runs it again on that card. These are such calls of the branch.
const owedCalls = (session: string, line: readonly StoredEvent[]): ToolUseBlock[] => {
  const done = new Set(line.flatMap((e) => (e.kind === "tool_result" ? e.data.results.map((r: any) => r.tool_use_id) : [])));
  return line.slice(checkpointAt(line).keepFrom).flatMap((e) => (e.kind === "assistant" ? e.data.blocks : []))
    .filter((b: any) => b.type === "tool_use" && !done.has(b.id) && waitsOnOwner(session, b));
};

// The message that continues a turn a restart cut. Each cut call's result says
// what became of it (it may have partly run, or did not run); a call that
// waited for the owner (an approval, a question, a plan) is asked again on
// the same card.
export function restartText(cut: number, owed: number, unstarted = false): string {
  // The prompt was stored and the daemon went down before its turn began.
  if (unstarted) return "[harness] The daemon restarted before this turn began: none of it ran. Go on with what was asked above.";
  const parts = [
    cut === 1 ? "the result of the 1 tool call it cut says what became of it" : cut ? `the results of the ${cut} tool calls it cut say what became of each` : "",
    owed === 1 ? "1 call that waited for the owner was asked again, and its result is the owner's answer"
      : owed ? `${owed} calls that waited for the owner were asked again, and their results are the owner's answers` : "",
  ].filter(Boolean);
  return `[harness] The daemon restarted during your previous turn${parts.length ? `; ${parts.join("; ")}` : ""}. Continue where it left off.`;
}

// What the model is told about a tool call cut by the output limit.
export const CUT_CALL = "Not run: this call was cut at the output limit, so its input may be incomplete. Send it again whole if it is still needed.";

// A reply cut by the output limit is continued this many times in a row, then
// the turn ends and says so.
export const MAX_CONTINUATIONS = 3;

// Rebuild the wire conversation from the stored events of one branch (oldest
// first). Pure: the same events always give the same bytes, so the provider's
// prefix cache holds across turns.
export function toMessages(events: readonly StoredEvent[]): Message[] {
  const cp = checkpointAt(events);
  const out: Message[] = [];
  if (cp.at >= 0 && events[cp.at]!.data.mode === "summary") out.push(summaryMessage(events[cp.at]!.data));
  for (let i = cp.keepFrom; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "compaction") {
      continue; // the checkpoint's summary leads (an older one in the tail is covered)
    } else if (e.kind === "user") {
      // An image sent without a caption has no text block (providers refuse an empty one).
      const content: any[] = [...(e.data.images ?? []), ...(e.data.text ? [{ type: "text", text: e.data.text }] : [])];
      out.push({ role: "user", content });
    } else if (e.kind === "assistant") {
      // A declined reply is discarded: its partial output is not the model's answer.
      if (e.data.stop === "refusal") continue;
      // A kept turn of a harness summary (before the checkpoint): its thinking
      // came after messages the summary replaced. One stored without a
      // fingerprint is marked stale, so the wire leaves it out as it does a
      // fingerprinted one (src/providers/wires/binding.ts).
      const kept = i < cp.at ? e.data.blocks.map((b: any) => ((b.type === "thinking" || b.type === "redacted_thinking") && !b.bind ? { ...b, bind: STALE_BIND } : b)) : e.data.blocks;
      if (kept.length) out.push({ role: "assistant", content: kept });
    } else if (e.kind === "tool_result") {
      out.push({ role: "user", content: e.data.results });
    } else if (e.kind === "note" && e.data.model) {
      // A note meant for the model (a background job ended): stored, so the
      // same bytes come back on every later request.
      out.push({ role: "user", content: [{ type: "text", text: e.data.text }] });
    }
  }
  // Consecutive same-role messages merge (an interrupted turn can leave two users).
  const merged: Message[] = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) (last.content as any[]).push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] } as Message);
  }
  // Results must lead the user message immediately after their calls. A late
  // result stays in the transcript: moving it back rewrites the cached prefix,
  // and replaying its output as user text loses the untrusted tool-result role.
  const projected: Message[] = [];
  const interrupted = (id: string): ToolResultBlock => ({
    type: "tool_result", tool_use_id: id, content: STOPPED_BEFORE, is_error: true,
  });
  const pending = new Map<string, ToolResultBlock | undefined>();
  for (const m of merged) {
    if (m.role === "assistant") {
      for (const b of m.content) if (b.type === "tool_use") pending.set(b.id, undefined);
      const last = projected.at(-1);
      if (last?.role === "assistant") last.content.push(...m.content); // an orphan-only user message was omitted
      else projected.push(m);
      continue;
    }
    const rest: UserBlock[] = [];
    for (const b of m.content) {
      if (b.type !== "tool_result") rest.push(b);
      else if (pending.has(b.tool_use_id) && !pending.get(b.tool_use_id)) pending.set(b.tool_use_id, b); // keep the first reply
    }
    // Keep missing results first, then actual results in call order, just as
    // before. An interrupted round already sent to the provider keeps its bytes.
    const missing: ToolResultBlock[] = [], paired: ToolResultBlock[] = [];
    for (const [id, r] of pending) {
      if (r) paired.push(r);
      else missing.push(interrupted(id));
    }
    const content = [...missing, ...paired, ...rest];
    if (content.length) projected.push({ role: "user", content });
    pending.clear();
  }
  if (pending.size) projected.push({ role: "user", content: Array.from(pending.keys(), interrupted) });
  return projected;
}

// The stand-in of a call that has no result yet (the call asking a side
// question of the running turn) says `pending.text` instead. Only that
// stand-in, in the last message, on a copy: an earlier call a server gave the
// same id keeps its stored result, and a stored block is never written
// (stored events are frozen).
export function withPending(messages: Message[], pending: { id: string; text: string }): Message[] {
  const k = messages.length - 1, last = messages[k];
  if (last?.role !== "user") return messages;
  let done = false;
  const content = last.content.map((b) => {
    if (done || b.type !== "tool_result" || b.tool_use_id !== pending.id) return b;
    done = true;
    return { ...b, content: pending.text, is_error: false };
  });
  return done ? [...messages.slice(0, k), { role: "user", content }] : messages;
}

// A feature may hold back or replace a file's text (a repository's changed
// instruction file loads as last trusted); null leaves the file out.
export const instructionFilter: { file?: (path: string, text: string) => string | null } = {};

// The instruction files a session in `cwd` loads, outermost first: the
// owner's own (<config>/AGENTS.md, for every folder), then the AGENTS.md
// (else CLAUDE.md) of each folder from the root down to `cwd`.
// A file linked from two places is one source: it is listed once, where it is
// met first from the root down (the owner's own file before a folder's).
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export function instructionPaths(cwd: string): { path: string; scope: "owner" | "parent" | "folder" }[] {
  const found: { path: string; scope: "owner" | "parent" | "folder" }[] = [];
  const seen = new Set<string>();
  for (let dir = cwd; !seen.has(dir); dir = dirname(dir)) {
    seen.add(dir);
    const name = ["AGENTS.md", "CLAUDE.md"].find((n) => existsSync(join(dir, n))); // AGENTS.md wins in one folder
    if (name) found.unshift({ path: join(dir, name), scope: dir === cwd ? "folder" : "parent" });
    if (dirname(dir) === dir) break;
  }
  const own = join(configDir(), "AGENTS.md");
  if (existsSync(own)) found.unshift({ path: own, scope: "owner" });
  const ids = new Set<string>();
  return found.filter((f) => !ids.has(real(f.path)) && !!ids.add(real(f.path)));
}

// A `@path` line of a file outside a repository brings that file in (up to
// 4 hops), as Claude Code reads its memory files. A repository's files keep
// the line as text: what they would import is not under their trust pin.
// `seen` holds the real paths already in the prompt: a file two others import
// comes in once, and the later line stays as the reference it is.
export function expandImports(text: string, from: string, depth = 0, seen = new Set([real(from)])): string {
  if (depth >= 4) return text;
  return text.replace(/^@(\S+)[ \t]*$/gm, (line, ref: string) => {
    const p = ref.startsWith("~/") ? join(homedir(), ref.slice(2)) : resolve(dirname(from), ref);
    if (seen.has(real(p)) || rootOf(dirname(p))) return line;
    try {
      const t = readFileSync(p, "utf8");
      seen.add(real(p));
      return expandImports(t, p, depth + 1, seen).trimEnd();
    } catch {
      return line;
    }
  });
}

export function instructionFiles(cwd: string): string {
  const parts: string[] = [];
  const files = instructionPaths(cwd);
  const seen = new Set(files.map((f) => real(f.path)));
  for (const { path: p } of files) {
    let read: string;
    try {
      read = readFileSync(p, "utf8");
    } catch (e) {
      // Not left out silently: the model knows a source is missing, not removed.
      parts.push(`# ${p}\n\n(This file could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Its instructions are not loaded.)`);
      continue;
    }
    const raw = rootOf(dirname(p)) ? read : expandImports(read, p, 0, seen);
    const text = instructionFilter.file ? instructionFilter.file(p, raw) : raw;
    if (text !== null) parts.push(`# ${p}\n\n${text.slice(0, 40_000)}`);
  }
  return parts.join("\n\n");
}

// Frozen per session: nothing in it changes between turns (no clock), so the
// tools + system prefix stays cached for the whole session. The shared part
// (the same for every session on the machine) comes first, the per-session
// part (folder, date, the folder's instruction files) after it.
const CORE = [
  "You are Keel, a coding agent working on the owner's machine through tools.",
  "Do the task fully. Read before you edit. Keep replies short: lead with the result.",
].join("\n");

// The per-session part, as its two blocks: the place and the instruction files.
function sessionParts(cwd: string, created: number): PromptPart[] {
  const inst = instructionFiles(cwd);
  const place = `Working directory: ${cwd}\nPlatform: ${process.platform}. Session started ${new Date(created).toISOString().slice(0, 10)}.\n`;
  return [{ name: "place", text: place, data: place }, { name: "instruction files", text: inst ? `\nInstructions from the owner's files:\n\n${inst}` : "", data: inst }];
}

type Running = { abort: AbortController; done: Promise<void> };
// `native`: the request carries deferred tools (src/tools/defer.ts), refreshed per request.
// A transcript request the provider refused as too long is built again at
// these shares of the room (OpenCode's ladder), then the failure stands.
const SHRINK_STEPS = [1, 0.7, 0.5, 0.35];
// A part never gets smaller than this, however small the window.
const MIN_PART_BYTES = 2_000;
// Room planned in each part's request for the summary of the parts before it:
// what the model can write in one reply, at most a quarter of the window.
const SUMMARY_ROOM_BYTES = (st: Step) => Math.floor(Math.min(st.info.output, st.info.context / 4) * bytesPerToken(st.info.id));

// A summary cut at the output limit, or one too long to go with the next part
// of a transcript, is asked for again this many times: each request of a
// compaction (the one summary, or each part) has that many of its own. Then
// the compaction fails and nothing is checkpointed: the branch stays as it was.
const SUMMARY_RETRIES = 2;
// What the owner can do when a summary cannot be written whole.
const SUMMARY_REMEDIES = "compact with a focus that asks for less, switch to a model that writes longer replies, or clear the context";
// The failures of a summary that end the same way on the same context: remembered (Engine.gaveUp).
const SUMMARY_GAVE_UP = new Set(["summary_truncated", "summary_too_long", "summary_no_room"]);
// A turn that ended with one of these before any request did so because its
// context cannot be sent: the prompt that opened it got no answer (Engine.unanswered).
const NOT_SENT = new Set([...SUMMARY_GAVE_UP, "context_over_window"]);

type Step = { provider: Provider; info: ModelInfo; tools: Tool[]; system: string; systemSplit: number; systemOwn?: number; effort?: string; native?: boolean };
// A session's system prompt as a request carries it: the text, where the part
// its folder's sessions share starts (`split`) and where its own part starts (`own`).
type System = { text: string; split: number; own?: number };

// What the caller counted for a request before it is built: the tokens of the
// request that carries its context (Engine.whole), and the messages that
// count covered when the request holds more than them (a side question's
// words, a summary's prompt). Without `base` the messages given to call().
// `least`: set when nothing in the request can be compacted, so a refusal
// would be final: the fewest tokens the context can be (Engine.least). The
// request is then refused unsent only when even that is over the window.
type Fit = { tokens: number; base?: readonly Message[]; least?: number };

// The bytes the built messages hold beyond the counted ones. A message that
// is the same object in both cancels out, so only what a hook, a side
// question or the files and images resolved for the model added, replaced or
// took out is measured, not the whole request again.
function gainedBytes(base: readonly Message[], built: readonly Message[], model: string): number {
  if (base === built) return 0;
  const had = new Set(base);
  const added = built.filter((m) => !had.delete(m));
  return messagesBytes(added, model) - messagesBytes([...had], model);
}

// Bytes of the tool definitions a request carries in its prompt: a deferred
// tool is not in the prompt until a call loads it.
const toolsBytes = (tools: Pick<Tool, "name" | "description" | "input_schema" | "defer">[]) => utf8Bytes(JSON.stringify((tools ?? []).filter((t) => !t.defer).map((t) => [t.name, t.description, t.input_schema])));

// A request counted over the model's window is not sent. `unsent` tells it
// from a provider's refusal: nothing was learned about the model's count.
const overWindow = (info: ModelInfo, tokens: number) => Object.assign(
  new Error(`The request is larger than ${info.name}'s window (about ${tokens} of ${info.context} tokens), so it was not sent: compact the conversation, shorten what was added, or switch to a model with a larger window.`),
  { status: 409, code: "context_over_window", kind: "context", unsent: true },
);

const abortError = () => Object.assign(new Error("interrupted"), { name: "AbortError" });

// What became of an input: stored as the session's prompt (`event`), kept in
// its queue (`queued`, as a steer or not), or not stored again (`duplicate`:
// its sender's key was seen before).
export type Sent = { event?: StoredEvent; queued?: QueueItem; steer?: boolean; duplicate?: boolean };

export class Engine {
  private running = new Map<string, Running>();
  // The turn_start event of each running turn, from its first event to its end.
  private turns = new Map<string, string>();
  // Sessions whose queue a stop holds: stored, so the hold (and its Resume)
  // outlives a daemon restart; only an action that releases it clears it.
  private held: Set<string>;
  // Sessions whose queued prompt a stopping daemon did not start (next): stored,
  // so the next daemon starts it (startQueued).
  private owed: Set<string>;
  // When the last daemon went down, as far as the start knows (its last sign
  // of life): a turn it was running ran until then, not until this start.
  wentDown?: number;
  // The turns this start closed as cut (closeCut), by session, until recover tells of them.
  private cutAtBoot = new Map<string, CutTurn>();
  // Queued prompts a Send now has taken and not yet appended.
  private sending = new Set<string>();
  // Who asked a running turn to stop (the owner, the parent agent), kept on its turn_end.
  private stoppedBy = new Map<string, string>();
  // Sessions whose accepted prompt is still being set up for its turn, and
  // those of them a stop has already closed (interrupt).
  private setting = new Set<string>();
  private stoppedEarly = new Set<string>();
  // What a finished call left for the transcript (ToolOutput.shown), until its step is stored.
  private shown = new Map<string, unknown>();
  // How a call's error result came about, for the turn's own count: the tool
  // ran and failed, or a gate refused the call before it ran. Anything else
  // (no such tool, a call cut at the output limit, a stop) is neither.
  private verdicts = new WeakMap<ToolResultBlock, "failed" | "denied">();
  // Turns being parked for a daemon stop: their end reason is "restart".
  private parking = new Set<string>();
  private draining = false;
  // Bounded: a session that dropped out reads its system prompt back from the
  // store (the same bytes) and asks to read a file again before editing it.
  private seen = new SessionMap<Map<string, number>>(64);
  private systems = new SessionMap<System & { model?: string }>(64);
  private prompts: PromptStore;
  // The tools and prompt each session was last sent, kept across a daemon upgrade (src/engine/build-pin.ts).
  private pins: BuildPins;
  private rendering = new Map<string, Promise<System>>();
  // Sessions whose kept prompt was compared with a fresh render in this run,
  // and sessions that moved (their next request renders for the new place).
  private checked = new Set<string>();
  private moved = new Set<string>();

  constructor(
    private store: Store,
    private bus: Bus,
    private providers: Providers,
    private errors: ErrorTracker,
    private spillRoot: string,
  ) {
    this.prompts = new PromptStore(store);
    this.pins = new BuildPins(store);
    registerPinnedDeferred((id) => this.pins.deferred(id));
    // A summary prepared ahead survives a restart.
    store.migrate("CREATE TABLE IF NOT EXISTS prepared_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, covered TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)");
    // What idle compaction knows of each session's context, so a daemon that starts reads no events for it (resumeIdle).
    store.migrate("CREATE TABLE IF NOT EXISTS idle_facts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, head TEXT, model TEXT NOT NULL, wire TEXT NOT NULL, used INTEGER NOT NULL, warm INTEGER NOT NULL, sure INTEGER NOT NULL, max INTEGER NOT NULL)");
    store.migrate("CREATE TABLE IF NOT EXISTS queue_holds (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)");
    this.held = new Set(store.db.query<{ session_id: string }, []>("SELECT session_id FROM queue_holds").all().map((r) => r.session_id));
    // A session's rows are read at every step and counted for every agent listed.
    store.migrate("CREATE INDEX IF NOT EXISTS queue_session ON queue(session_id)");
    store.migrate("CREATE TABLE IF NOT EXISTS queue_owed (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)");
    this.owed = new Set(store.db.query<{ session_id: string }, []>("SELECT session_id FROM queue_owed").all().map((r) => r.session_id));
    // The inputs a sender named with a key of its own: each is stored once (claim).
    store.migrate("CREATE TABLE IF NOT EXISTS input_keys (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (session_id, key)) WITHOUT ROWID");
    // What a deleted session never read of what others sent it is told to them.
    store.queueGone = (rows, session) => this.dropped(rows, "deleted", session);
    // Each model's bytes a token, learned from what its provider counted.
    store.migrate("CREATE TABLE IF NOT EXISTS token_ratios (model TEXT PRIMARY KEY, ratio REAL NOT NULL, ts INTEGER NOT NULL)");
    for (const r of store.db.query<{ model: string; ratio: number }, []>("SELECT model, ratio FROM token_ratios").all()) { setRatio(r.model, r.ratio); this.ratioKept.set(r.model, r.ratio); }
    // A session that changed (another branch shown, archived, cleared, deleted)
    // may have made the summary being prepared for it obsolete.
    bus.on((f) => { if (f.t === "session") this.dropObsolete(f.session.id); });
  }

  private hold(id: string) {
    this.held.add(id);
    this.store.db.run("INSERT OR IGNORE INTO queue_holds (session_id) VALUES (?)", [id]);
  }

  private release(id: string) {
    if (this.held.delete(id)) this.store.db.run("DELETE FROM queue_holds WHERE session_id = ?", [id]);
  }

  // The queue's next prompt is owed a start the stopping daemon did not give it.
  private owe(id: string) {
    if (this.owed.has(id)) return;
    this.owed.add(id);
    this.store.db.run("INSERT OR IGNORE INTO queue_owed (session_id) VALUES (?)", [id]);
  }

  private settleOwed(id: string) {
    if (this.owed.delete(id)) this.store.db.run("DELETE FROM queue_owed WHERE session_id = ?", [id]);
  }

  // A queued prompt written on a branch the session no longer shows (the head
  // moved back, or an earlier prompt was edited): it is sent only when the
  // owner chooses where, here or back on its branch.
  offBranch(q: QueueItem): boolean {
    return !!q.anchor && !this.lineage(q.session_id).some((e) => e.id === q.anchor);
  }

  // The steers the running turn takes in: those written on the branch it runs
  // on. One written on another branch waits like any queued prompt of that
  // branch: the queue is held at the turn's end until the owner says where it goes.
  private liveSteers(id: string): QueueItem[] {
    return this.queued(id).filter((q) => q.steer && !this.offBranch(q));
  }

  private offBranchError() {
    return Object.assign(new Error("this prompt was queued on another branch: send it here, or go back to its branch"), { status: 409, code: "off_branch" });
  }

  // A queued prompt that Send now has taken: it can no longer be edited or removed.
  isSending(qid: string) {
    return this.sending.has(qid);
  }

  // The queue as the owner sees it: a prompt Send now has taken is on its way
  // out (its row stays stored until its prompt is, see deliver).
  queued(id: string): QueueItem[] {
    const q = this.store.queue(id);
    return this.sending.size ? q.filter((x) => !this.sending.has(x.id)) : q;
  }

  // A queued prompt leaves the queue and enters the history in one write: a
  // daemon killed at any point finds the row still queued or its one stored
  // prompt, never neither and never both. `release`: the queue's hold ends in
  // the same write. The prompt is the row as it is now (it may have been
  // edited while it waited). Undefined when the row is gone.
  // `turn`: the prompt starts a turn (see accept); a steer joins the running one.
  private deliver(qid: string, origin: "queued" | "steer", opts: { release?: boolean; turn?: boolean } = {}): StoredEvent | undefined {
    const q = this.store.queueItem(qid);
    if (!q) return undefined;
    const ev = this.store.atomic(q.session_id, () => {
      if (!this.store.dequeue(q.id)) return undefined;
      if (opts.release) this.store.db.run("DELETE FROM queue_holds WHERE session_id = ?", [q.session_id]);
      if (opts.turn) this.store.updateSession(q.session_id, { phase: "working" });
      return this.store.append(q.session_id, "user", { text: q.text, images: q.images, origin, queue_id: q.id, ...q.meta });
    });
    if (!ev) return undefined;
    // Only once the write is stored: a write that failed leaves the hold as the table has it.
    if (opts.release) this.held.delete(q.session_id);
    if (opts.turn) this.emitSession(q.session_id);
    this.emitEvent(ev);
    return ev;
  }

  // A prompt that starts a turn enters the history with the turn owed: the
  // session is marked as working in the same write. A daemon killed before
  // the turn has started (while its provider and system prompt are set up)
  // finds the session open at its next start and runs the prompt then
  // (recover), instead of leaving it with no reply and nothing to continue.
  private accept(id: string, data: unknown, parent?: string | null): StoredEvent {
    const ev = this.store.atomic(id, () => {
      this.store.updateSession(id, { phase: "working" });
      return this.store.append(id, "user", data, parent);
    });
    this.emitSession(id);
    this.emitEvent(ev);
    return ev;
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  // The turn_start event of the turn running in the session now.
  turnOf(id: string): string | undefined {
    return this.turns.get(id);
  }

  isHeld(id: string) {
    return this.held.has(id);
  }

  isDraining() {
    return this.draining;
  }

  // The session's frozen system prompt is made again at its next turn (it moved
  // to another directory or machine; the cache prefix is rebuilt once).
  forgetSystem(id: string) {
    this.systems.delete(id);
    this.moved.add(id);
  }

  // The branch the session shows, oldest first. The store keeps it (walked
  // once, grown by each appended event), so the loop's many reads of one step
  // do not rebuild the tree; the array is shared and read-only.
  lineage(id: string): readonly StoredEvent[] {
    return this.store.lineage(id);
  }

  // Stop the running turn: the model stream and running tools are cut, the
  // queue is held (nothing starts by itself until the owner sends or resumes),
  // and steers that did not reach the turn become ordinary queued prompts.
  async interrupt(id: string, by?: string) {
    const r = this.running.get(id);
    if (!r) return;
    if (by && !this.stoppedEarly.has(id)) this.stoppedBy.set(id, by);
    this.hold(id);
    // Stopped while its provider and system prompt are still set up: the turn
    // is closed as stopped here, at once and in one write, not when the setup
    // settles. A daemon killed in between then finds a stopped turn with its
    // Continue, not a prompt it still owes a turn (closeCut).
    if (this.setting.has(id) && !this.stoppedEarly.has(id)) {
      const session = this.store.session(id);
      if (session) {
        this.stoppedEarly.add(id);
        this.stoppedBy.delete(id);
        const closing = this.store.atomic(id, () => [
          this.store.append(id, "turn_start", { model: session.model }),
          this.store.append(id, "turn_end", { reason: "interrupted", usage: emptyUsage(), ms: 0, ...(by ? { stopped_by: by } : {}) }),
        ]);
        for (const e of closing) this.emitEvent(e);
      }
    }
    r.abort.abort();
    await r.done;
    for (const q of this.store.queue(id)) if (q.steer) this.store.updateQueueItem(q.id, { steer: false });
    this.emitQueue(id);
  }

  private emitEvent(e: StoredEvent) {
    this.bus.emit({ t: "event", event: e });
  }

  private append(id: string, kind: StoredEvent["kind"], data: unknown, parent?: string | null): StoredEvent {
    const e = this.store.append(id, kind, data, parent);
    this.emitEvent(e);
    return e;
  }

  emitSession(id: string) {
    const s = this.store.session(id);
    if (s) this.bus.emit({ t: "session", session: s });
  }

  emitQueue(id: string) {
    this.bus.emit({ t: "queue", session_id: id, queue: this.queued(id), held: this.held.has(id) });
  }

  private statuses = new Map<string, TurnStatus>();
  private status(id: string, status: TurnStatus) {
    if (status.kind === "idle") this.statuses.delete(id);
    else this.statuses.set(id, status);
    this.bus.emit({ t: "status", session_id: id, status });
  }

  // What the running turn waits on now (for a page that opens mid-turn).
  statusOf(id: string): TurnStatus {
    return this.statuses.get(id) ?? { kind: "idle" };
  }

  // When the reply being streamed last gave output; undefined between requests.
  private outputs = new Map<string, number>();
  outputOf(id: string): number | undefined {
    return this.outputs.get(id);
  }

  // When the provider last sent anything on the running request (output or a
  // keep-alive): a model that thinks without showing it is still alive.
  private wires = new Map<string, Wire>();
  aliveOf(id: string): number | undefined {
    return this.wires.get(id)?.last_ms;
  }

  private setPhase(id: string, phase: Session["phase"]) {
    const s = this.store.updateSession(id, { phase });
    this.bus.emit({ t: "session", session: s });
  }

  private titleFrom(id: string, text: string) {
    const s = this.store.session(id);
    if (s && !s.title) this.bus.emit({ t: "session", session: this.store.updateSession(id, { title: firstLineTitle(text) }) });
  }

  // Resolves when the session's running turn (if any) has fully ended.
  idle(id: string): Promise<void> {
    return this.running.get(id)?.done ?? Promise.resolve();
  }

  // The owner's prompt. While a turn runs: `steer` (the default) joins it at its
  // next model call, `queue` waits for the turn to end. Otherwise it starts a turn.
  // `meta` marks input that is not the owner's typing (a subagent report, a
  // wake, a loop run): { kind, ... } is stored with the event for the page.
  // `key`: the sender's own name for this input (a tool call, a send id).
  // The same key again stores nothing: the claim is one write with the prompt
  // or the queued row, so a sender that asks twice is delivered once.
  send(id: string, text: string, opts: { mode?: "send" | "steer" | "queue"; images?: any[]; meta?: Record<string, unknown>; key?: string } = {}): Sent {
    if (opts.key) {
      const { key, ...rest } = opts;
      return this.store.atomic(id, () => (this.claim(id, key) ? this.send(id, text, rest) : { duplicate: true }));
    }
    const mode = opts.mode ?? "send";
    // A queue request must not start a held session, even if nothing else is queued.
    if (this.running.has(id) || (mode === "queue" && (this.held.has(id) || this.store.queue(id).length))) {
      const q = this.store.enqueue(id, text, mode !== "queue", opts.images, opts.meta);
      this.emitQueue(id);
      return { queued: q, steer: q.steer };
    }
    // Input that is not the owner's (a report, a wake) never releases a held queue.
    if (!opts.meta) this.release(id);
    // A prompt that arrives before a cut turn was continued: the model is told of the cut first.
    this.acceptRestart(id);
    // The owner's prompt after one that could not be sent takes its place (see unanswered).
    const stale = opts.meta ? undefined : this.unanswered(id);
    const ev = this.accept(id, { text, images: opts.images?.length ? opts.images : undefined, ...opts.meta }, stale ? stale.parent : undefined);
    // The title comes from the owner's first words, not from a timer's or a report's envelope.
    // A prompt of only attachments (no words) is named by its files, or Image.
    const files = (opts.images ?? []).filter((b: any) => b?.type === "attachment").map((b: any) => String(b.name));
    if (!opts.meta) this.titleFrom(id, text || (files.length ? files.join(", ") : opts.images?.length ? "Image" : ""));
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // True the first time a session is given an input under this key.
  private claim(id: string, key: string): boolean {
    return this.store.db.query("INSERT OR IGNORE INTO input_keys (session_id, key, ts) VALUES (?, ?, ?)").run(id, key, Date.now()).changes > 0;
  }

  // A message from the session this one answers to (a parent to its agent),
  // stored before its sender is answered: as a queued row when the session
  // cannot take it now, else as its prompt. A running turn takes it at its
  // next step, as a steer, and a daemon on its way down starts no turn for
  // it: the row waits for the next one (startQueued). Otherwise it starts a
  // turn now, after the sender's earlier ones that still wait (a stop left
  // them in the queue), in the order they were sent. To this session it is
  // what a typed prompt is to the owner's own: it releases a queue a stop
  // holds. `key`: as for send.
  message(id: string, text: string, meta: Record<string, unknown>, key?: string): Sent {
    return this.store.atomic(id, () => {
      if (key && !this.claim(id, key)) return { duplicate: true };
      const wait = () => {
        const q = this.store.enqueue(id, text, true, undefined, meta);
        this.emitQueue(id);
        return { queued: q, steer: true };
      };
      if (this.running.has(id)) return wait();
      if (this.draining) {
        this.owe(id);
        return wait();
      }
      this.release(id);
      const earlier = this.store.queue(id).filter((q) => q.meta?.kind === meta.kind && !this.offBranch(q));
      if (earlier.length) {
        for (const q of earlier) if (!q.steer) this.store.updateQueueItem(q.id, { steer: true });
        const mine = wait();
        this.next(id);
        return mine;
      }
      this.acceptRestart(id);
      const ev = this.accept(id, { text, ...meta });
      this.start(id);
      this.emitQueue(id);
      return { event: ev };
    });
  }

  // Queued input that names a sender leaves the queue unread: the sender is
  // told by whoever knows it (the inputDropped hook). The owner's own queued
  // prompts name none and are not this method's.
  drop(rows: QueueItem[], why: "archived" | "removed") {
    const gone = rows.filter((q) => q.meta && this.store.dequeue(q.id));
    if (!gone.length) return;
    for (const id of new Set(gone.map((q) => q.session_id))) this.emitQueue(id);
    this.dropped(gone, why);
  }

  private dropped(rows: QueueItem[], why: "deleted" | "archived" | "removed", session?: Session) {
    for (const h of allHooks()) try { h.inputDropped?.(rows, why, session); } catch (e) { this.errors.capture("server", e, { hook: "inputDropped", session: rows[0]?.session_id }); }
  }

  // Edit-and-resend: a new version of an earlier prompt, as a sibling of it (a
  // new branch from its parent). The old branch stays and can be shown again.
  async edit(id: string, eventId: string, text: string) {
    const old = this.store.event(eventId);
    if (!old || old.session_id !== id || old.kind !== "user") throw Object.assign(new Error("not a prompt of this session"), { status: 400 });
    await this.interrupt(id);
    this.release(id);
    // An edited steer is a new turn from the same place, not a live steer: it says what it was.
    const ev = this.accept(id, { text, images: old.data.images, ...(old.data.origin === "steer" ? { edited_from: "steer" } : {}) }, old.parent);
    this.emitSession(id);
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // A queued prompt now: the running turn stops and this one is the next turn.
  // The row is marked as sending before the stop is awaited, so a second Send
  // now, an edit or a Remove in that time is told it is already sending, and
  // neither the stopping turn nor the queue takes it. It stays stored until
  // the stop is done and its prompt is written: a daemon killed while the
  // turn stops still has it queued.
  // `here`: on the branch shown now, also when it was queued on another one.
  async sendNow(id: string, qid: string, here = false) {
    if (this.sending.has(qid)) throw Object.assign(new Error("this queued prompt is already sending"), { status: 409 });
    const gone = () => Object.assign(new Error("no such queued prompt"), { status: 404 });
    const q = this.store.queueItem(qid);
    if (q && q.session_id === id && !here && this.offBranch(q)) throw this.offBranchError();
    if (!q || q.session_id !== id) throw gone();
    this.sending.add(qid);
    try {
      this.emitQueue(id);
      await this.interrupt(id);
      // Another Send now of the same stop got there first and its turn runs:
      // this row is the next prompt, at the head of the queue, and starts no
      // second turn beside that one.
      if (this.running.has(id)) return void this.nextUp(q, here);
      // Sent before a cut turn was continued: the model is told of the cut first.
      this.acceptRestart(id);
      if (!this.deliver(qid, "queued", { release: true, turn: true })) throw gone();
      this.start(id);
    } finally {
      this.sending.delete(qid);
      // Also when it failed: the row is queued again, and open pages show it again.
      this.emitQueue(id);
    }
  }

  // A queued row becomes the session's next prompt: first in the queue, with
  // the queue's hold off, so it starts when the running turn ends (`here`: on
  // the branch shown now).
  private nextUp(q: QueueItem, here: boolean) {
    const first = this.store.queue(q.session_id).filter((x) => x.id !== q.id).reduce((min, x) => Math.min(min, x.pos), q.pos);
    this.store.updateQueueItem(q.id, { steer: false, pos: first - 1, ...(here ? { anchor: this.store.session(q.session_id)?.head ?? null } : {}) });
    this.release(q.session_id);
  }

  // `here`: the next prompt goes on the branch shown now even when it was
  // queued on another one.
  resumeQueue(id: string, here = false) {
    const first = this.queued(id)[0];
    if (first && this.offBranch(first)) {
      if (!here) throw this.offBranchError();
      this.store.updateQueueItem(first.id, { anchor: this.store.session(id)?.head ?? null });
    }
    this.release(id);
    if (!this.running.has(id)) this.next(id);
    this.emitQueue(id);
  }

  // The owner acted on the session by other means than a typed prompt (their
  // speech, a goal set or resumed): after a Stop it releases the held queue as
  // a prompt they type does. A prompt queued on another branch still waits for
  // them to say where it goes.
  ownerResumes(id: string) {
    const first = this.queued(id)[0];
    if (this.held.has(id) && !(first && this.offBranch(first))) this.resumeQueue(id);
  }

  // Continue a session whose last turn was stopped, failed or was cut.
  resume(id: string) {
    if (this.running.has(id)) throw Object.assign(new Error("a turn is running"), { status: 409 });
    this.release(id);
    // A turn that sent nothing has nothing to continue from: its prompt is asked again as it stands.
    // Otherwise said as what happened: a turn that failed was not stopped.
    const failed = this.lineage(id).findLast((e) => e.kind === "turn_end")?.data.reason === "error";
    // Pressed before a cut turn was continued: the restart message is what continues it.
    if (!this.acceptRestart(id) && !this.unanswered(id)) this.accept(id, { text: failed ? "[harness] The previous turn failed before it finished. Try again, and continue where it left off." : "[harness] The previous turn was stopped before it finished. Continue where it left off.", origin: "harness" });
    this.start(id);
    this.emitQueue(id);
  }

  // The owner's prompt that the last turn of the branch could not send: the
  // turn ended before any request because its context does not fit the window
  // and cannot be made to (NOT_SENT), on the model the session is still on,
  // and nothing was said since. The next prompt is stored as another version
  // of it, as an edited prompt is, so a context that is already too large does
  // not grow by a prompt for every try. The earlier one stays stored and can
  // be shown again.
  private unanswered(id: string): StoredEvent | undefined {
    const line = this.lineage(id);
    const end = line.findLastIndex((e) => e.kind === "turn_end");
    if (end < 0) return undefined;
    const d = line[end]!.data;
    if (d.reason !== "error" || d.steps !== 0 || !NOT_SENT.has(d.code)) return undefined;
    if (line.slice(end + 1).some((e) => e.kind !== "error" && !(e.kind === "note" && !e.data.model))) return undefined;
    const start = line.findLastIndex((e, i) => i < end && e.kind === "turn_start");
    if (start < 1 || line[start]!.data.model !== this.store.session(id)?.model) return undefined;
    if (line.slice(start + 1, end).some((e) => e.kind !== "note")) return undefined;
    const prompt = line[start - 1]!;
    return prompt.kind === "user" && ownerPrompt(prompt.data) ? prompt : undefined;
  }

  // After a turn: the next queued prompt starts, unless the queue is held.
  private next(id: string) {
    if (this.held.has(id) || this.running.has(id)) return;
    // A daemon on its way down starts no turn: the next one starts what waits here (startQueued).
    if (this.draining) {
      if (this.store.queue(id).length) this.owe(id);
      return;
    }
    const s = this.store.session(id);
    if (!s || s.archived) return;
    // A Send now that is waiting for its turn to stop starts the next turn itself.
    if (this.sending.size && this.store.queue(id).some((x) => this.sending.has(x.id))) return;
    const q = this.store.queue(id)[0];
    if (!q) return;
    // Written on another branch: it waits for the owner to say where it goes.
    if (this.offBranch(q)) { this.hold(id); this.emitQueue(id); return; }
    // Its turn starts where a restart cut one that was not continued: the model is told of the cut first.
    this.acceptRestart(id);
    if (!this.deliver(q.id, q.steer ? "steer" : "queued", { turn: true })) return;
    this.settleOwed(id);
    this.start(id);
    this.emitQueue(id);
  }

  // A turn another engine handed over (see start).
  adopt(id: string) {
    if (!this.running.has(id) && !this.draining) this.start(id);
  }

  private start(id: string) {
    errorScope.run({ session: id }, () => this.startTurn(id));
  }

  // A turn that failed because the provider asked for a long wait continues
  // by itself when the wait is over, without the owner remembering: at `at`,
  // if the failure `after` is still the last thing in the session (nothing was
  // sent since) and the owner did not call it off. Kept with the session, so a
  // restart meanwhile loses nothing (rearmContinues).
  private continues = new Map<string, ReturnType<typeof setTimeout>>();
  private continueAt(id: string, at: number, after: string, round: number) {
    this.store.mergeSettings(id, { continue_at: { at, after, round } });
    this.emitSession(id);
    this.armContinue(id, at);
  }
  private armContinue(id: string, at: number) {
    clearTimeout(this.continues.get(id));
    // A timer takes at most about 24 days; a longer wait is looked at again then.
    this.continues.set(id, setTimeout(() => this.continueDue(id), Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1)));
  }
  private continueDue(id: string) {
    this.continues.delete(id);
    const s = this.store.session(id);
    const c = s?.settings.continue_at;
    if (!s || !c) return;
    if (c.at > Date.now()) return this.armContinue(id, c.at);
    // Stopping: the next daemon continues it.
    if (this.draining) return;
    this.store.mergeSettings(id, { continue_at: null });
    this.emitSession(id);
    if (s.archived || this.running.has(id) || this.held.has(id) || this.lineage(id).at(-1)?.id !== c.after) return;
    this.accept(id, { text: "[harness] The wait the provider asked for is over. Continue where the previous turn left off.", origin: "harness", continued: (c.round ?? 0) + 1 });
    this.start(id);
    this.emitQueue(id);
  }
  // How many times in a row the session continued by itself after a provider's
  // wait and the turn failed again before the model gave a step: the count the
  // turn that just ended was started with, or 0 when it was the owner's turn
  // or the model answered in it.
  private continuedInARow(id: string): number {
    // Back from the end: a reply of the model, or a prompt that is neither the
    // continue's own nor a restart's (which only goes on with the same turn), ends the row.
    const line = this.lineage(id);
    for (let i = line.length - 1; i >= 0; i--) {
      const e = line[i]!;
      if (e.kind === "assistant") return 0;
      if (e.kind !== "user") continue;
      if (typeof e.data.continued === "number") return e.data.continued;
      if (e.data.origin !== "restart") return 0;
    }
    return 0;
  }
  // The owner called it off (or a turn started): nothing continues by itself.
  cancelContinue(id: string): boolean {
    clearTimeout(this.continues.get(id));
    this.continues.delete(id);
    if (!this.store.session(id)?.settings.continue_at) return false;
    this.store.mergeSettings(id, { continue_at: null });
    this.emitSession(id);
    return true;
  }
  // At startup: the waits the last daemon kept, with one that came due meanwhile continued now.
  // An archived session continues nothing: restoring it later starts no turn the owner forgot.
  rearmContinues() {
    for (const { id, archived } of this.store.db.query<{ id: string; archived: number }, []>("SELECT id, archived FROM sessions WHERE json_extract(settings, '$.continue_at') IS NOT NULL").all()) {
      const c = this.store.session(id)?.settings.continue_at;
      if (archived) this.store.mergeSettings(id, { continue_at: null });
      else if (c && !this.continues.has(id)) this.armContinue(id, c.at);
    }
  }

  // The turn's first event. What fails from here until the turn is over is
  // captured as this turn's (src/core/errors.ts).
  private openTurn(id: string, data: unknown) {
    this.cancelContinue(id);
    const ev = this.append(id, "turn_start", data);
    this.turns.set(id, ev.id);
    const scope = errorScope.getStore();
    if (scope?.session === id) scope.turn = ev.id;
    return ev;
  }

  private startTurn(id: string) {
    // An engine a dev hot reload replaced runs no new turn (a child's task, a
    // queued prompt, a report that wakes a parent): the engine now in charge does.
    const successor = (globalThis as { __keelEngine?: Engine }).__keelEngine;
    if (this.draining && successor && successor !== this) return successor.adopt(id);
    const starting = this.store.session(id);
    if (starting) for (const h of allHooks()) try { h.turnStart?.(starting); } catch (e) { this.errors.capture("server", e, { hook: "turnStart", session: id }); }
    const abort = new AbortController();
    const scope = errorScope.getStore();
    const done = this.loop(id, abort.signal)
      .catch((e) => {
        if (abort.signal.aborted) return;
        // A refusal a hook meant (`expected`) is said in the transcript, not tracked as a failure.
        const rec = (e as any)?.expected ? undefined : this.errors.capture("provider", e, { session: id });
        // `kind` and `status`: what failed, for the page's words and actions (a ProviderError's own, or its cause's).
        const cause = e instanceof RetryTooLong ? (e.cause as any) : (e as any);
        const kind = cause?.kind;
        // The provider named when it takes requests again: the owner's session goes on by itself then,
        // unless it already did CONTINUE_MAX times in a row and the provider asked for the wait each time.
        const waits = e instanceof RetryTooLong && !this.store.session(id)?.parent_id;
        const round = waits ? this.continuedInARow(id) : 0;
        const ev = this.append(id, "error", {
          // (The box says what happens next: it continues by itself, or offers to try again.)
          message: e instanceof RetryTooLong ? errorText(e).replace("; resume after that)", ")") : errorText(e), error_id: rec?.id,
          ...(typeof kind === "string" ? { kind } : {}), ...(typeof cause?.status === "number" ? { status: cause.status } : {}),
          ...(e instanceof RetryTooLong ? { retry_at: e.retryAt } : {}),
          ...(waits && round >= CONTINUE_MAX ? { continued: round } : {}),
        });
        // Each round without a model step waits twice as long as the one before.
        if (waits && round < CONTINUE_MAX) this.continueAt(id, Date.now() + Math.max(0, (e as RetryTooLong).retryAt - Date.now()) * 2 ** round, ev.id, round);
      })
      .finally(() => {
        // The turn is over: what it left running no longer fails in it.
        if (scope) scope.turn = undefined;
        this.turns.delete(id);
        this.running.delete(id);
        this.status(id, { kind: "idle" });
        if (this.store.session(id)) this.setPhase(id, "idle");
        this.next(id);
      });
    this.running.set(id, { abort, done });
  }

  private async step(session: Session, model: string): Promise<Step> {
    const { provider, info } = await this.providers.resolve(model);
    // A model known to take no tool definitions (the owner, a probe, its listing
    // or catalog said so) is sent none: it would refuse them or answer garbled.
    const native = info.tools !== false && loadsNatively(provider.wire, info);
    const built = info.tools === false ? [] : toolsFor(info.family, native, session.id);
    // On its own model the session keeps the tools and prompt it was last
    // sent, across a daemon upgrade too, and takes this build's when no warm
    // cache holds its context or waiting would be wrong (src/engine/build-pin.ts).
    // A request on another model (an advisor, a fallback) has no cache of the
    // session's to keep: it gets this build's tools.
    const own = info.id === session.model;
    const to = { model: info.id, native, own: info.tools === false ? "no tools" : sessionToolsKey(info.family, session.id) };
    const why = own ? this.pins.due(session, to, built, () => this.coldWhy(session.id, provider, info)) : undefined;
    if (why && !(session.parent_id && !session.machine)) this.forgetSystem(session.id);
    this.pins.begin(session.id, why);
    try {
      const system = await this.systemOf(session, info);
      const effort = effectiveEffort(info, session.settings.effort);
      return { provider, info, tools: own ? this.pins.tools(session, to, built) : built, system: system.text, systemSplit: system.split, systemOwn: system.own, effort, native };
    } finally {
      this.pins.end(session.id);
    }
  }

  // Why no warm cache holds the session's context on this model, if none does.
  private coldWhy(id: string, provider: Provider, info: ModelInfo, events = this.lineage(id)): string | undefined {
    return coldReason(events, info.id, retention(provider.wire, events, info.id).max, Date.now(), this.preparedMs(id, events, { info } as Step));
  }

  // Which build the session's tools and prompt are from, and what waits.
  buildState(id: string) {
    return this.pins.state(id);
  }

  // What taking this build's tools and prompt in every open session would
  // cost: the sessions known to be behind, each with the context its next
  // request would write to the cache again (`warm`: a cache still holds it;
  // a cold one is written again anyway), and how many were not compared yet.
  async buildPins() {
    // A start builds no request for the sessions used in the last hour any
    // more (resumeIdle), so this build has not compared them yet: they are
    // compared here, when the owner asks, one at a time with the loop given
    // back between two. Older sessions stay counted as not compared until
    // their next request, as before.
    const since = Date.now() - 60 * 60_000;
    for (const id of this.pins.open().unknown) {
      const s = this.store.session(id);
      if (!s || s.updated <= since || this.running.has(id)) continue;
      try { await this.step(s, s.model); } catch (e) { this.errors.capture("provider", e, { session: id, at: "comparing a session with this build" }); }
      await new Promise<void>((r) => setImmediate(r));
    }
    const { behind, unknown, asked } = this.pins.open();
    const sessions = await Promise.all(behind.map(async (id) => {
      const s = this.store.session(id)!;
      const events = this.lineage(id);
      const warm = await this.providers.resolve(s.model).then((r) => !this.coldWhy(id, r.provider, r.info, events), () => false);
      return { id, title: s.title, tokens: contextTokens(events, s.model).used, warm };
    }));
    return { build: this.pins.state("").build, sessions, tokens: sessions.reduce((n, s) => n + (s.warm ? s.tokens : 0), 0), unknown: unknown.length, asked };
  }

  // Every open session takes this build's tools and prompt at its next request.
  adoptAllBuilds() {
    return { asked: this.pins.askAll() };
  }

  // The owner asks for this build's tools and prompt now: an idle session
  // takes them at once, a running turn at its next request. Either way the
  // next request writes the session's context to the cache again.
  async adoptBuild(id: string) {
    const session = this.store.session(id);
    if (!session) throw Object.assign(new Error("no such session"), { status: 404 });
    if (this.pins.ask(id) && !this.running.has(id)) await this.step(session, session.model);
    return this.pins.state(id);
  }

  // A subagent on this machine runs on its parent's system prompt byte for byte
  // (its own place, a worktree, is in its task message), so its first request
  // reads the prefix the parent cached instead of writing its own copy.
  // A session moved to another model (its own, not a subagent riding on its
  // parent's prompt) gets its prompt rendered again for that model: blocks
  // that depend on the model (the skill listing is cut to its window) follow it.
  private async systemOf(session: Session, info?: ModelInfo, own = true): Promise<System> {
    const system = this.systems.get(session.id);
    const local = session.parent_id && !session.machine;
    if (system && own && !local && info?.id === session.model && system.model && system.model !== info.id) {
      this.systems.delete(session.id);
      this.moved.add(session.id);
    } else if (system) return system;
    // One render at a time per session: a turn and a side question that start
    // together get the same text.
    let making = this.rendering.get(session.id);
    if (!making) {
      making = this.loadSystem(session, info).finally(() => this.rendering.delete(session.id));
      this.rendering.set(session.id, making);
    }
    return making;
  }

  // The prompt is kept with the session (session_prompts), so a restart or a
  // session that dropped out of memory sends the same bytes again. Once per
  // daemon run it is rendered again for the model it was made for and
  // compared block by block. A block that differs (an instruction file was
  // edited, a skill was added, a server published other instructions, a new
  // build reworded one) replaces the kept prompt when the session's cache is
  // cold or the change must not wait, and the row then names the blocks;
  // until then the kept prompt is sent as it was (src/engine/build-pin.ts).
  private async loadSystem(session: Session, info?: ModelInfo): Promise<System> {
    const parent = session.parent_id && !session.machine ? this.store.session(session.parent_id) : undefined;
    let system: System;
    if (parent) system = await this.systemOf(parent, info, false);
    else {
      const kept = this.prompts.get(session.id);
      const moved = this.moved.has(session.id);
      if (kept && this.checked.has(session.id) && !moved) system = kept;
      else {
        // Compared as rendered for the model the kept one was made for; when
        // that model is gone, the kept text stands until it is back.
        const forModel = !kept || moved || !kept.model || kept.model === info?.id ? info : await this.providers.resolve(kept.model).then((r) => r.info, () => undefined);
        if (kept && !forModel) return kept;
        const made = await this.renderSystem(session, forModel);
        const changed = kept ? changedBlocks(kept.blocks, made.blocks) : [];
        // A kept prompt whose blocks differ stays as it was sent while a warm
        // cache holds the context, unless a changed block must not wait: the
        // pins decide, and remember what waits (src/engine/build-pin.ts).
        const taken = this.pins.prompt(session.id, kept?.blocks, made.blocks, changed, moved);
        // A prompt made again for a new model is kept as made for it, so the
        // next run compares it against that model.
        if (kept && !taken) {
          system = kept;
          // (Its blocks stay cut as the kept one's were sent.)
          if (moved && !changed.length && forModel && kept.model !== forModel.id) this.prompts.put(session.id, { ...made, own: kept.own });
        } else {
          this.prompts.put(session.id, made, changed);
          system = made;
        }
        this.checked.add(session.id);
        this.moved.delete(session.id);
      }
    }
    this.systems.set(session.id, { text: system.text, split: system.split, own: system.own, model: parent ? undefined : this.prompts.get(session.id)?.model ?? undefined });
    return system;
  }

  private async renderSystem(session: Session, info?: ModelInfo) {
    const extra = await Promise.all(allHooks().map((h) => h.system?.(session, info) ?? ""));
    // Each block as the model is sent it, secrets as placeholders: the kept
    // prompt and its fingerprints never hold a secret's value.
    const sent = (p: PromptPart): PromptPart => ({ name: p.name, text: conceal(p.text, session.id), ...(p.data !== undefined && { data: conceal(p.data, session.id) }) });
    // A block of the owner's data keeps its place while it is empty, so its data can be compared (hooks.ts SystemBlock).
    const part = (b: string | SystemBlock, wrap: (t: string) => string): PromptPart[] =>
      typeof b === "string" ? (b ? [sent({ name: blockName(b), text: wrap(b) })] : []) : [sent({ name: b.name, text: b.text ? wrap(b.text) : "", data: b.data })];
    const shared: PromptPart[] = [sent({ name: "core", text: `${CORE}${testBuild?.core ? `\n${testBuild.core}` : ""}\n\n` }), ...extra.flatMap((b) => part(b, (t) => t + "\n\n"))];
    const own = (await Promise.all(allHooks().map((h) => h.sessionSystem?.(session, info) ?? ""))).flatMap((b) => part(b, (t) => `\n${t}\n`));
    // The place and its instruction files: the same for every session of the
    // folder (started that day), so the session's own blocks come after them.
    const folder = sessionParts(session.workspace, session.created).map(sent);
    const parts = [...shared, ...folder, ...own];
    const chars = (list: PromptPart[]) => list.reduce((n, p) => n + p.text.length, 0);
    return { text: parts.map((p) => p.text).join(""), split: chars(shared), own: chars(shared) + chars(folder), blocks: blocksOf(parts), model: info?.id ?? null };
  }

  // The first request on a model other than the one that wrote the last reply
  // tells it so, once (Codex sends a model_switch message the same way): the
  // replies above are another model's, and it should not take their claims
  // about itself as its own. Stored as a note for the model, so the bytes
  // stay the same on every later request. Nothing when no model replied yet.
  private async tellSwitch(id: string, events: readonly StoredEvent[], st: Step): Promise<boolean> {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.kind === "compaction" || (e.kind === "note" && e.data.kind === "model_told")) return false;
      if (e.kind !== "assistant") continue;
      const was: string = e.data.model;
      if (!was || was === st.info.id) return false;
      const name = (await this.providers.models()).find((m) => m.id === was)?.name ?? was;
      this.append(id, "note", { kind: "model_told", model: true, from: was, to: st.info.id, text: `[harness] The session's model changed: you are ${st.info.name} from here. The replies above came from another model (the last one from ${name}); go on with the work as it stands.` });
      return true;
    }
    return false;
  }

  // Measuring hooks never stop a call.
  private measure(id: string, f: (h: ReturnType<typeof allHooks>[number]) => void) {
    for (const h of allHooks()) try { f(h); } catch (e) { this.errors.capture("server", e, { hook: "measure", session: id }); }
  }

  // One provider call with retries for passing failures. The UI is told about
  // each wait and the half-streamed reply of a failed attempt is dropped.
  // `fit`: what the caller counted for this request. The request as it is
  // finally built (after the hooks, the tools of this request and the files
  // resolved for this model) is counted against the model's window from it,
  // and one over the window is refused here instead of sent.
  private async call(id: string, st: Step, messages: Message[], signal: AbortSignal, partial: Map<number, { kind: string; text: string }>, session: Session, quiet = false, purpose: ProviderRequest["purpose"] = quiet ? "side" : "turn", fit?: Fit): Promise<ProviderResult> {
    const counted = fit ? { messages: fit.base ?? messages, tools: toolsBytes(st.tools) } : undefined;
    // Built once: a retry sends the same request, byte for byte (the hooks run
    // once, so a note a hook stored is in every attempt).
    if (st.native && purpose !== "reader") {
      st.tools = await withCatalog(st.tools, st.info.family, messages, (e, c) => this.errors.capture("server", e, c), id);
      // A deferred tool the conversation loaded keeps the definition it was loaded with (src/engine/build-pin.ts).
      if (st.info.id === session.model) st.tools = this.pins.loaded(id, st.tools, referenced(messages));
    }
    let req: ProviderRequest = { model: st.info.model, system: st.system, systemSplit: st.systemSplit, systemOwn: st.systemOwn, messages, tools: st.tools, effort: st.effort, maxTokens: st.info.output, signal, sessionKey: id, purpose, route: st.info.id , dropThinking: this.store.session(id)?.settings.drop_thinking || undefined };
    // A reader's request carries no conversation for the hooks to add to.
    if (purpose === "reader") req.cache = false;
    else for (const h of allHooks()) if (h.beforeRequest) req = { ...req, ...(await h.beforeRequest(session, req)) };
    if (session.parent_id && purpose !== "reader") req.cacheLife = this.cacheLife(id, st);
    if (req.cache !== false) req.cacheMs = askedLife(st.provider.wire, req.cacheLife) ?? (retention(st.provider.wire, this.lineage(id), st.info.id).sure || undefined);
    // What the model can read, applied after the hooks (a hook may rebuild the messages).
    const whole = resolveAttachments(st.info.images === false ? withoutImages(req.messages, st.info.name ?? st.info.model) : req.messages, st.info);
    // Every image within what the model's host takes (a history may hold a
    // larger one from before images were scaled when stored): a refused image
    // would fail this request and every later one of the session.
    this.sayImages(id, purpose);
    const set = this.store.session(id)?.settings;
    let limits = imageLimits(st.info.family, set?.image_edge);
    let out = new Set(set?.images_out ?? []);
    // Shown while copies are made: after a restart a history with many large
    // images takes seconds before its first request is sent.
    const preparing = quiet ? undefined : () => this.status(id, { kind: "model", since: Date.now(), model: st.info.name, preparing: "images" });
    req.messages = await fitForWire(whole, limits, out, preparing);
    // What an image refusal changed for this request; kept for the session once it passes.
    let fixed: { cause: unknown; edge?: number; out?: string[] } | undefined;
    let resent = false;

    // The caller's count plus what the request gained since, at the model's bytes a token.
    const fits = () => {
      if (!fit || !counted) return;
      const gained = gainedBytes(counted.messages, req.messages, st.info.id) + toolsBytes(req.tools) - counted.tools;
      const tokens = fit.tokens + Math.round(gained / bytesPerToken(st.info.id));
      const held = fit.least === undefined ? tokens : fit.least + Math.round(gained / RATIO_MAX);
      if (held >= st.info.context) throw overWindow(st.info, tokens);
    };
    fits();
    for (let attempt = 0; ; attempt++) {
      partial.clear();
      this.measure(id, (h) => h.requestSent?.(session, req));
      const since = Date.now();
      if (!quiet) this.status(id, { kind: "model", since, model: st.info.name });
      let first = true;
      // A reply that streamed and then went silent says so: after
      // STREAM_QUIET_MS without output the status names the last output's
      // time, until the next output or the end of the request.
      let last = 0;
      let silent = false;
      const hush = quiet ? undefined : setInterval(() => {
        if (first || silent || signal.aborted || Date.now() - last < STREAM_QUIET_MS) return;
        silent = true;
        this.status(id, { kind: "model", since: last, model: st.info.name, connected: last, quiet: last });
      }, 1000);
      // The provider answered but the model has said nothing yet: shown as
      // connected, so a long silence reads as the model's, not the network's.
      const onHeaders = (h: Headers) => {
        req.onHeaders?.(h);
        if (first && !quiet && !signal.aborted) this.status(id, { kind: "model", since, model: st.info.name, connected: Date.now() });
      };
      try {
        const tap: Wire = {};
        wireOf.set(req, tap);
        if (!quiet) this.wires.set(id, tap);
        const res = await wireScope.run(tap, () => st.provider.stream({ ...req, onHeaders }, (d) => {
          if ((first || silent) && !quiet) { first = silent = false; this.status(id, { kind: "idle" }); }
          last = Date.now();
          if (!quiet) this.outputs.set(id, last);
          const p = partial.get(d.index) ?? { kind: d.kind, text: "" };
          p.text += d.text;
          partial.set(d.index, p);
          this.measure(id, (h) => h.requestDelta?.(session, req, d));
          if (!quiet) this.bus.emit({ t: "delta", session_id: id, ...d });
        }));
        clearInterval(hush);
        if (!quiet) { this.outputs.delete(id); this.wires.delete(id); }
        if (!quiet || attempt) this.status(id, { kind: "idle" });
        this.measure(id, (h) => h.requestDone?.(session, req, res));
        this.boundThinking(id, res);
        if (fixed) this.imagesFixed(id, fixed, purpose);
        return res;
      } catch (e) {
        clearInterval(hush);
        if (!quiet) { this.outputs.delete(id); this.wires.delete(id); }
        this.measure(id, (h) => h.requestFailed?.(session, req, e, signal.aborted));
        if (signal.aborted) throw abortError();
        // A route that cannot take deferred tools gets the search pair, once.
        if (st.native && !retryable(e) && isDeferError(e)) {
          this.errors.capture("provider", e, { session: id, fallback: "deferred tools refused; using search_tools" });
          refuseDefer(st.info.id);
          st.native = false;
          const eager = toolsFor(st.info.family, false, id);
          st.tools = st.info.id === session.model ? this.pins.tools(session, { model: st.info.id, native: false, own: sessionToolsKey(st.info.family, id) }, eager) : eager;
          req = { ...req, tools: st.tools };
          fits(); // every built-in is in the prompt now
          continue;
        }
        // The provider refused the request over an image, or as too large in
        // bytes while it holds images. A pixel limit it states, lower than the
        // one used, is tried first: the images are scaled to it. Else the
        // images of this history are left out, each as a note. Either way the
        // turn goes on.
        const held = retryable(e) ? [] : imageKeys(whole);
        const large = held.length > 0 && !imageRefusal(e) && requestTooLarge(e);
        // Too large in bytes can be a passing answer (a gateway's, a proxy's):
        // the same request goes once more before any image is left out.
        if (large && !resent) {
          resent = true;
          const wait = backoffMs(0);
          this.status(id, { kind: "retry", attempt: 1, max: 1, at: Date.now() + wait, message: errorText(e) });
          await sleep(wait, signal);
          continue;
        }
        const refusal = held.length ? imageRefusal(e) ?? (large ? {} : null) : null;
        if (refusal) {
          const left = held.filter((k) => !out.has(k));
          // Refused again with no image of the session in the request: it was
          // not over an image. The first refusal is the turn's error and
          // nothing is kept.
          if (!left.length) throw fixed?.cause ?? e;
          if (!fixed && refusal.edge && !(limits.edge && limits.edge <= refusal.edge) && anyOver(req.messages, refusal.edge)) {
            fixed = { cause: e, edge: refusal.edge };
            limits = imageLimits(st.info.family, refusal.edge);
          } else {
            // A stated limit that did not make the request pass is not kept.
            if (fixed?.edge) { fixed.edge = undefined; limits = imageLimits(st.info.family, set?.image_edge); }
            // The refusal names no image. The ones that do not decode in full
            // (a file cut short passes the header read it was stored on) go
            // first; all of them only when none is damaged, or when the
            // request was refused again without the damaged ones.
            const bad = fixed?.out ? [] : await damagedImages(whole, out);
            const drop = bad.length && bad.length < left.length ? bad : left;
            fixed = { cause: fixed?.cause ?? e, edge: fixed?.edge, out: [...(fixed?.out ?? []), ...drop] };
            out = new Set([...out, ...drop]);
          }
          req = { ...req, messages: await fitForWire(whole, limits, out, preparing) };
          continue;
        }
        if (!retryable(e) || attempt + 1 >= RETRY.max) throw e;
        const wait = backoffMs(attempt, e);
        if (wait > RETRY_WAIT_MAX_MS) throw new RetryTooLong(e, Date.now() + wait);
        this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: wait });
        this.status(id, { kind: "retry", attempt: attempt + 1, max: RETRY.max - 1, at: Date.now() + wait, message: errorText(e) });
        await sleep(wait, signal);
      }
    }
  }

  // A request passed after the provider refused it over an image: what made
  // it pass holds for the session from here (the same bytes on every later
  // request), the refusal is captured once, and the transcript says it.
  private imagesFixed(id: string, fixed: { cause: unknown; edge?: number; out?: string[] }, purpose: ProviderRequest["purpose"]) {
    const s = this.store.session(id);
    if (!s) return;
    this.store.mergeSettings(id, {
      ...(fixed.edge ? { image_edge: fixed.edge } : {}),
      ...(fixed.out ? { images_out: [...new Set([...(s.settings.images_out ?? []), ...fixed.out])] } : {}),
    });
    const n = fixed.out?.length ?? 0;
    const note = n
      ? { text: `${n === 1 ? "One image" : `${n} images`} left out of what the model reads: the provider refused a request over this session's images.`, left_out: n, detail: errorText(fixed.cause) }
      : { text: `Images over ${fixed.edge} px a side are sent scaled down: the provider stated that limit.`, detail: errorText(fixed.cause) };
    this.errors.capture("provider", fixed.cause, { session: id, then: n ? `${n} images left out for this session` : `images scaled to ${fixed.edge} px for this session` });
    this.imageNotes.set(id, note);
    this.sayImages(id, purpose);
  }

  // The transcript's line about it is written only inside a turn's own
  // request. A summary request (a compaction is bound to the head it read: a
  // note appended while it runs would have it thrown away with the summary
  // paid for), a side answer and a reader leave it for the next turn's request.
  // `left_out`: how many images it left out; the owner can have them sent
  // again by clearing the session's images_out (the note offers it).
  private imageNotes = new SessionMap<{ text: string; left_out?: number; detail: string }>(256);
  private sayImages(id: string, purpose: ProviderRequest["purpose"]) {
    const note = purpose === "turn" ? this.imageNotes.get(id) : undefined;
    if (!note) return;
    this.imageNotes.delete(id);
    this.append(id, "note", { kind: "images", ...note });
  }

  // A subagent's cache lifetime, where the route offers a choice. It starts
  // short (an agent usually works without pauses and the long lifetime's
  // writes cost more) and takes the long one for good once a request comes
  // later than the short lifetime less PAUSE_MARGIN_MS after the one before:
  // the agent waits (a foreground command, wait_for, its own agents), and on
  // the short lifetime each wake would write its whole context again.
  private sent = new SessionMap<number>(256);
  private cacheLife(id: string, st: Step): "short" | "long" | undefined {
    const lives = cacheLives(st.provider.wire);
    const now = Date.now();
    const prev = this.sent.get(id);
    this.sent.set(id, now);
    if (!lives) return undefined;
    if (this.store.session(id)?.settings.cache_long) return "long";
    // After a restart: the reply before this request, whatever its cache did.
    const before = prev ?? this.lineage(id).findLast((e) => e.kind === "assistant")?.ts;
    if (!before || now - before <= lives.short - PAUSE_MARGIN_MS) return "short";
    this.store.mergeSettings(id, { cache_long: true });
    return "long";
  }

  // The provider's prefix check on sent-back thinking failed although the
  // wire left out what it knew was stale: a change it cannot see. The session
  // asks for "drop_block" from then on (Anthropic's recovery), and the miss is
  // captured once. Drops of thinking another model or account wrote are not ours.
  private boundThinking(id: string, res: ProviderResult) {
    const missed = (res.input_transformations ?? []).filter((t) => t.reason === "prefix_binding_mismatch");
    if (!res.binding_refused && !missed.length) return;
    const s = this.store.session(id);
    if (!s || s.settings.drop_thinking) return;
    this.store.mergeSettings(id, { drop_thinking: true });
    this.errors.capture("provider", new Error(res.binding_refused ?? `the provider ${missed[0]!.type === "thinking_mismatch_allowed" ? "read" : "dropped"} sent-back thinking whose prefix changed`), { session: id, paths: missed.map((t) => t.path), then: "drop_block for this session" });
  }

  // A turn another agent runs (an ACP agent): it stores its own replies and calls.
  private async external(id: string, session: Session, run: ExternalTurn, signal: AbortSignal) {
    this.setPhase(id, "working");
    const t0 = Date.now();
    this.openTurn(id, { model: session.model });
    let reason = "end_turn";
    let usage: Usage = emptyUsage();
    try {
      const r = await run({
        signal,
        events: () => this.lineage(id),
        append: (kind, data) => this.append(id, kind, data),
        delta: (kind, index, text) => this.bus.emit({ t: "delta", session_id: id, kind, index, text }),
        status: (s) => this.status(id, s),
      });
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : r.reason;
      if (r.usage) { usage = r.usage; this.store.addUsage(id, usage); this.emitSession(id); }
    } catch (e) {
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : "error";
      if (!signal.aborted) throw e;
    } finally {
      const by = this.stoppedBy.get(id);
      this.stoppedBy.delete(id);
      this.append(id, "turn_end", { reason, usage, ms: Date.now() - t0, ...(by && reason === "interrupted" ? { stopped_by: by } : {}) });
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, reason))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  private async loop(id: string, signal: AbortSignal) {
    let session = this.store.session(id)!;
    for (const h of allHooks()) {
      const run = h.external?.(session);
      if (run) return this.external(id, session, run, signal);
    }
    this.setting.add(id);
    const ready = await this.step(session, session.model)
      .finally(() => this.setting.delete(id))
      // A setup that fails after the stop has nothing left to say: the turn is closed.
      // One that fails while the daemon parks its turns is closed below.
      .catch((e) => { if (this.stoppedEarly.has(id) || this.parking.has(id)) return undefined; throw e; });
    const stopped = this.stoppedEarly.delete(id);
    if (stopped || !ready) {
      // Failed while the daemon was on its way down (a provider that went
      // first, a listing cut short): the prompt keeps its turn, closed as cut
      // at its start, and the next start runs it like any turn a restart cut,
      // instead of a prompt with no turn, no error and nothing to continue.
      const parked = !stopped;
      if (parked) {
        const closing = this.store.atomic(id, () => [
          this.store.append(id, "turn_start", { model: session.model }),
          this.store.append(id, "turn_end", { reason: "restart", usage: emptyUsage(), ms: 0, unstarted: true }),
        ]);
        for (const e of closing) this.emitEvent(e);
      }
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, parked ? "restart" : "interrupted"))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
      return;
    }
    let st = ready;
    const seen = this.seen.get(id) ?? new Map();
    this.seen.set(id, seen);
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id),
      parentId: session.parent_id ?? undefined,
      questionChanged: () => this.bus.emit({ t: "questions", pending: allPendingQuestions() }),
      inContext: (text) => JSON.stringify(toMessages(this.lineage(id))).includes(JSON.stringify(text).slice(1, -1)),
      read: (source, text, prompt) => this.read(id, source, text, prompt, signal),
      readMaterial: (items, question, callId) => this.readMaterial(id, items, question, signal, callId),
      readBudget: () => readBudget(this.readerHost(id)) };

    this.setPhase(id, "working");
    const t0 = Date.now();
    let usage: Usage = emptyUsage();
    this.openTurn(id, { model: session.model, effort: st.effort });
    let reason = "end_turn";
    let cuts = 0;
    let fellBack = false;
    let compactedForFit = false;
    let summaryFailed = false;
    // The code of the error that ended the turn (context_over_window, summary_truncated), kept on its turn_end.
    let failed: string | undefined;
    let steps = 0;
    // What the turn's end says it took: the replies the model gave, its tool
    // results, those of calls that ran and failed (what telemetry and the
    // trace count too), and those of calls a gate denied. A call the turn's
    // stop or a restart cut did not fail: it is a result, not an error.
    let replies = 0;
    let toolResults = 0;
    let toolErrors = 0;
    let toolDenied = 0;
    const partial = new Map<number, { kind: string; text: string }>();
    // Each result is stored as it settles, not when the whole batch has:
    // a crash while one call still runs keeps what the others returned
    // (a denial and its reason, a finished read). The projection puts a
    // step's results back in call order. A call whose open card a stop
    // parks gets none: the next daemon asks on that card again.
    const settle = (u: ToolUseBlock) => (r: ToolResultBlock) => {
      // (A question the owner answered as the stop came keeps its answer.)
      if (this.parking.has(id) && (outcomeOf(id, u.id) === "waiting" || (asksOwner(u.name) && r.content === QUESTION_CUT))) return;
      toolResults++;
      const how = this.verdicts.get(r);
      if (how === "denied") toolDenied++;
      else if (how === "failed" && !signal.aborted) toolErrors++;
      const shown = this.shown.get(r.tool_use_id);
      this.shown.delete(r.tool_use_id);
      // One write through the store: when it fails, the result is not left in the kept events.
      this.store.atomic(id, () => {
        this.append(id, "tool_result", { results: [r], ...(shown !== undefined ? { shown: { [r.tool_use_id]: shown } } : {}) });
        for (const h of allHooks()) {
          try { h.resultStored?.(session, [r]); } catch (e) { this.errors.capture("server", e, { hook: "resultStored", session: id }); }
        }
      });
    };
    try {
      // Calls a restart cut while they waited for the owner: asked again on
      // the same card before the model is asked anything.
      const owed = owedCalls(id, this.lineage(id));
      if (owed.length) {
        this.status(id, { kind: "tool", since: Date.now(), names: [...new Set(owed.map((u) => u.name))] });
        // A question whose tool the session's model no longer has cannot be put back: it expired.
        const gone = (u: ToolUseBlock) => asksOwner(u.name) && !st.tools.some((t) => t.name === u.name);
        await Promise.all(owed.map((u) => this.tracked(id, u, gone(u) ? Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: u.id, is_error: true, content: QUESTION_CUT }) : this.runTool(session, st.tools, u, ctx)).then(settle(u))));
        this.status(id, { kind: "idle" });
        if (signal.aborted) throw signal.reason;
      }
      for (;;) {
        // Steers sent while the last step ran join here, after its tool results.
        // The owner's own words (a steer with no meta) release a held queue, as
        // a prompt typed while idle does: the turn they joined may be one a wait
        // or a loop started in a session the owner had stopped.
        for (const q of this.liveSteers(id)) if (this.deliver(q.id, "steer", { release: !q.meta })) this.emitQueue(id);
        session = this.store.session(id)!;
        // A model or effort chosen while the turn runs takes effect at its next request.
        if (session.model !== st.info.id || effectiveEffort(st.info, session.settings.effort) !== st.effort) st = await this.step(session, session.model);
        // The owner's step budget for one turn (none by default).
        const budget = session.settings.max_steps ?? 0;
        if (budget > 0 && steps >= budget) {
          this.append(id, "note", { kind: "max_steps", text: `Stopped after ${steps} model steps: the step budget of this session. Resume to go on.` });
          reason = "max_steps";
          break;
        }
        steps++;
        // The last step of the budget answers in words: the request keeps its
        // tools (the cached prefix), and calls it still makes are not run.
        if (budget > 0 && steps === budget) this.append(id, "user", { text: `[harness] This is the last model step this turn may take (the session's step budget is ${budget}). Do not call tools: reply with where the work stands and what is left to do.`, origin: "harness" });
        let events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        const used = this.used(events, st);
        // The whole request against the window: the same count for a context
        // a reply has measured, the system prompt and tools on top for one
        // that is only its bytes.
        const over = this.whole(events, st) >= st.info.context;
        // A history with no reply of its own yet (one long first message) is
        // summarized only when it cannot be sent as it is.
        // (The prompts that opened a turn with no reply yet are not summarized: they follow the summary whole.)
        if ((used >= limit || over) && !summaryFailed && (over || events.some((e) => e.kind === "assistant")) && worthSummarizing(summarizable(events))) {
          // A summary prepared ahead swaps in at once; else the turn waits for one.
          // One that fails while the context still fits is said, and the turn goes on whole.
          // (A context whose summary could not be written whole is not asked for again:
          // compactNow says so at once, with no request, and the turn says it once.)
          if (!this.applyPrepared(id, events)) await this.compactNow(id, { auto: true, trigger: "threshold", signal, step: st }).catch((e) => {
            if (signal.aborted || over) throw e;
            summaryFailed = true;
            const rec = this.errors.capture("provider", e, { session: id, at: "threshold compaction" });
            this.append(id, "note", { kind: "compaction_failed", text: `The context was not compacted (${rec.message}); this turn goes on with it whole.` });
          });
          events = this.lineage(id);
          // A request counted over the window is never sent.
          // (What is left cannot be made smaller: held to the fewest tokens it can be.)
          const now = this.whole(events, st);
          if (this.least(events, st) >= st.info.context) throw Object.assign(new Error(`The context is still larger than ${st.info.name}'s window after compacting (about ${now} of ${st.info.context} tokens): switch to a model with a larger window, or start a new session.`), { status: 409, code: "context_over_window" });
        } else if (steps === 1 && this.cacheCold(id, events, st) && this.applyPrepared(id, events)) {
          // Back after the cache expired: the summary written while idle (or
          // ahead) replaces the history instead of the history being written again.
          events = this.lineage(id);
        } else if (!summaryFailed && used >= limit * (PREPARE_SHARE / COMPACT_SHARE)) {
          this.prepare(id, st);
        }
        // A context no warm cache holds any more (just compacted or cleared, expired),
        // the owner's request, or a pin past its age: this build's tools and prompt from this request on.
        const waits = st.info.id === session.model ? this.pins.waits(id) : undefined;
        if (waits === "now" || (waits && this.coldWhy(id, st.provider, st.info, events))) st = await this.step(session, session.model);
        if (await this.tellSwitch(id, events, st)) events = this.lineage(id);
        const messages = toMessages(events);
        let res: ProviderResult;
        try {
          // A context with nothing to compact (a first long message, a fresh
          // summary and the prompts after it) cannot be made smaller: it is
          // sent unless it is over the window however its bytes are counted.
          const final = !worthSummarizing(summarizable(events));
          res = await this.call(id, st, messages, signal, partial, session, false, "turn", { tokens: this.whole(events, st), ...(final ? { least: this.least(events, st) } : {}) });
        } catch (e) {
          // Counted over the window before it was sent: the provider said nothing about its own count.
          const unsent = !!(e as any)?.unsent;
          // Refused by the provider as over its window: its count of this context is higher than Keel's.
          if (!signal.aborted && (e as any)?.kind === "context" && !unsent) this.refused(st, events);
          // The request no longer fits the window: compact once and go on.
          // (A context that is a fresh summary, or only the prompts that opened
          // the turn, has nothing left to compact: the provider's error stands.)
          if (!signal.aborted && (e as any)?.kind === "context" && !compactedForFit && worthSummarizing(summarizable(events))) {
            compactedForFit = true;
            await this.compactNow(id, { auto: true, trigger: unsent ? "threshold" : "overflow", signal, step: st });
            continue;
          }
          if (signal.aborted) {
            // Keep what the owner already saw of the reply.
            const text = [...partial.entries()].sort(([a], [b]) => a - b).filter(([, p]) => p.kind === "text" && p.text.trim()).map(([, p]) => ({ type: "text" as const, text: p.text }));
            if (text.length) { this.append(id, "assistant", { blocks: text, model: st.info.id, usage: emptyUsage(), stop: "interrupted" }); replies++; }
          }
          throw e;
        }
        for (const h of allHooks()) await h.afterResponse?.(session, res, messages);
        const u: Usage = res.usage; // priced by the registry from the model's listed price
        this.learn(id, st, events, u);
        usage = addUsage(usage, u);
        this.store.addUsage(id, u);
        this.emitSession(id);

        if (res.stop === "refusal") {
          this.append(id, "assistant", { blocks: res.blocks, model: st.info.id, usage: u, stop: "refusal", stop_details: res.stop_details ?? null });
          replies++;
          const fb = session.settings.fallback;
          if (fb && fb !== st.info.id && !fellBack) {
            fellBack = true;
            const from = st.info.name;
            st = await this.step(session, fb);
            this.store.updateSession(id, { model: fb });
            this.emitSession(id);
            this.append(id, "note", { kind: "fallback", text: `${from} declined${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}. Continuing on ${st.info.name}.` });
            continue;
          }
          reason = "refusal";
          break;
        }

        const blocks: AssistantBlock[] = res.blocks;
        // At the output limit the last tool call may be cut, even when its input
        // parses: it is kept (its id stays paired) but never run.
        const cut = res.stop === "max_tokens" && blocks.at(-1)?.type === "tool_use" ? (blocks.at(-1) as ToolUseBlock) : undefined;
        this.append(id, "assistant", { blocks, model: st.info.id, usage: u, stop: res.stop });
        replies++;

        if (res.stop === "model_context_window_exceeded") {
          await this.compactNow(id, { auto: true, trigger: "overflow", signal, step: st });
          continue;
        }
        const uses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use" && b !== cut);
        ctx.room = Math.max(0, st.info.context - (u.input + u.cache_read + u.cache_write + u.output));
        if (uses.length || cut) {
          if (uses.length) this.status(id, { kind: "tool", since: Date.now(), names: [...new Set(uses.map((u) => u.name))] });
          const spent = budget > 0 && steps >= budget;
          await Promise.all(uses.map((u) => (spent ? Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Not run: the step budget of this turn is spent." }) : this.tracked(id, u, this.runTool(session, st.tools, u, ctx))).then(settle(u))));
          if (cut) settle(cut)({ type: "tool_result", tool_use_id: cut.id, is_error: true, content: CUT_CALL });
          this.status(id, { kind: "idle" });
          for (const h of allHooks()) await (async () => h.stepDone?.(session))().catch((e) => this.errors.capture("server", e, { hook: "stepDone", session: id }));
          if (signal.aborted) { reason = this.parking.has(id) ? "restart" : "interrupted"; break; }
        }
        if (res.stop === "max_tokens") {
          if (++cuts > MAX_CONTINUATIONS) { reason = "max_tokens"; break; }
          this.append(id, "user", { text: `[harness] Your last reply was cut off at the output limit (${st.info.output} tokens). Continue exactly where it stopped.`, origin: "harness" });
          continue;
        }
        cuts = 0;
        if (res.stop === "pause_turn") continue; // a server tool paused; the same request goes on
        if (res.stop === "tool_use" && uses.length) continue;
        // The model is done, but a steer arrived during its last reply: go on.
        if (this.liveSteers(id).length) continue;
        reason = res.stop;
        break;
      }
    } catch (e) {
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : "error";
      if (!signal.aborted) { failed = typeof (e as any)?.code === "string" ? (e as any).code : undefined; throw e; }
    } finally {
      const by = this.stoppedBy.get(id);
      this.stoppedBy.delete(id);
      this.append(id, "turn_end", { reason, usage, ms: Date.now() - t0, steps: replies, tools: toolResults, tool_errors: toolErrors, tool_denied: toolDenied, ...(failed ? { code: failed } : {}), ...(by && reason === "interrupted" ? { stopped_by: by } : {}) });
      // Between turns, a context past the preparing share gets its summary ready.
      if (!signal.aborted) {
        const events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        if (this.used(events, st) >= limit * (PREPARE_SHARE / COMPACT_SHARE)) this.prepare(id, st);
        this.scheduleIdle(id, st);
      }
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, reason))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  // The calls of each running turn that have not returned yet.
  private inflight = new Map<string, Map<string, ToolUseBlock>>();
  private tracked(id: string, u: ToolUseBlock, run: Promise<ToolResultBlock>): Promise<ToolResultBlock> {
    const calls = this.inflight.get(id) ?? new Map<string, ToolUseBlock>();
    this.inflight.set(id, calls.set(u.id, u));
    return run.finally(() => { calls.delete(u.id); if (!calls.size && this.inflight.get(id) === calls) this.inflight.delete(id); });
  }
  // Whether a running turn does nothing but wait on the owner: every call it
  // has out is a question, a plan put up for approval, or one whose approval
  // card is open. Such a turn does not end by itself, however long it is given.
  // A program's call (run_code) waits on the owner when every call it has out does.
  waitsOnOwner(id: string): boolean {
    const calls = this.inflight.get(id);
    const awaits = (callId: string) => allHooks().some((h) => h.awaitsOwner?.(id, callId));
    return !!calls?.size && [...calls.values()].every((u) => {
      if (asksOwner(u.name) || awaits(u.id)) return true;
      const inner = this.nested.get(`${id}:${u.id}`);
      return !!inner?.size && [...inner].every(awaits);
    });
  }
  // The calls a program has out, by session and the turn's call that runs the program.
  private nested = new Map<string, Set<string>>();

  private async runTool(session: Session, tools: Tool[], u: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlock> {
    // Built when the stop comes: a stop for a daemon restart says so.
    const interrupted = (): ToolResultBlock => ({
      type: "tool_result", tool_use_id: u.id, is_error: true,
      content: this.parking.has(ctx.sessionId) ? cutText(ctx.sessionId, u) : STOPPED_WHILE,
    });
    if (ctx.signal.aborted) return interrupted();
    const tool = tools.find((t) => t.name === u.name);
    // A tool an upgrade took away while the session ran says so: the model called it before.
    if (!tool) return { type: "tool_result", tool_use_id: u.id, content: this.pins.removed(session.id, u.name) ? `${u.name} was removed by an upgrade of Keel and is no longer available. Use the tools you have now.` : `No tool named ${u.name}.`, is_error: true };
    const callTool = (name: string, input: any, id: string): Promise<ToolResultBlock> => {
      // Nested calls have no question card of their own, and the program can
      // exit without awaiting its calls. Ask in a top-level call instead.
      if (tools.some((t) => t.name === name && t.asksOwner)) return Promise.resolve({
        type: "tool_result", tool_use_id: id, is_error: true,
        content: `${name} cannot wait for the owner inside run_code. Call it directly outside the program.`,
      });
      // Tracked under the call of the turn whose program made it (a drain asks what it waits on).
      const top = ctx.nestedIn ?? u.id;
      const key = `${ctx.sessionId}:${top}`;
      const mine = this.nested.get(key) ?? new Set<string>();
      this.nested.set(key, mine.add(id));
      return this.runTool(session, tools, { type: "tool_use", id, name, input }, { ...ctx, nestedIn: top })
        .finally(() => { mine.delete(id); if (!mine.size && this.nested.get(key) === mine) this.nested.delete(key); });
    };
    const call: ToolCall = { id: u.id, tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id, callTool } };
    // An interrupt answers at once, whether or not a gate or the tool honors the signal.
    // The listener goes when the call settles: the turn's signal is shared by all its calls.
    let onStop = () => {};
    const stopped = new Promise<null>((r) => { onStop = () => r(null); ctx.signal.addEventListener("abort", onStop, { once: true }); });
    let result: ToolResultBlock;
    // Measured from dispatch: a call that never ran (denied, stopped at its gate) has no row.
    let t0: number | undefined;
    let preparedInput = false;
    const ran = (r: ToolResultBlock, outcome: "ok" | "error" | "interrupted", error?: Error) => {
      const ms = Date.now() - t0!;
      this.measure(session.id, (h) => h.toolRan?.(session, call, r, { ms, outcome, error }));
      if (outcome === "error") this.verdicts.set(r, "failed");
      return r;
    };
    // What a hook of the owner's did to the call rides with its result: the
    // model reads the input that was judged and ran (the history keeps what it
    // wrote), and the card shows both.
    const told = (r: ToolResultBlock): ToolResultBlock => {
      const h = call.hook;
      if (!h || (h.from === undefined && !h.skipped)) return r;
      if (h.from !== undefined) {
        const note = hookChanged(call.input, t0 !== undefined);
        r.content = typeof r.content === "string" ? `${r.content}\n\n${note}` : [...r.content, { type: "text", text: note }];
      }
      const shown = this.shown.get(u.id);
      this.shown.set(u.id, { ...(shown && typeof shown === "object" ? shown : {}), hook: { ...(h.from !== undefined ? { input: call.input } : {}), ...(h.skipped ? { allowed: h.allowed ?? "" } : {}) } });
      return r;
    };
    // Refused before it ran (the owner's answer, a rule, the judge): the model is told why.
    const denied = (why: string): ToolResultBlock => {
      const r: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: why, is_error: true };
      this.verdicts.set(r, "denied");
      return told(r);
    };
    let thrown: Error | undefined;
    try {
      // The owner's hooks first: every gate after them judges the input they left.
      for (const h of allHooks()) {
        if (!h.prepareTool) continue;
        const prepared = Promise.resolve(h.prepareTool(session, call));
        prepared.catch(() => {});
        const g = await Promise.race([prepared, stopped]);
        if (ctx.signal.aborted) return interrupted();
        if (!g) continue;
        if ("deny" in g) return denied(g.deny);
        if (g.input !== undefined) { call.hook = { ...call.hook, from: call.hook?.from ?? call.input }; call.input = g.input; }
        if (g.allow !== undefined) call.hook = { ...call.hook, allowed: g.allow };
      }
      const authorizations: ToolAuthorization[] = [];
      for (const h of allHooks()) {
        if (!h.beforeTool) continue;
        const gate = Promise.resolve(h.beforeTool(session, call));
        gate.catch(() => {});
        const g = await Promise.race([gate, stopped]);
        if (ctx.signal.aborted) return interrupted();
        if (!g) continue;
        if ("deny" in g) return denied(g.deny);
        if (g.input !== undefined) call.input = g.input;
        if (g.ctx) call.ctx = { ...call.ctx, ...g.ctx };
        if (g.authorization) authorizations.push(g.authorization);
      }
      for (const a of authorizations) if (a.refresh) {
        const refresh = a.refresh(call);
        refresh.catch(() => {});
        await Promise.race([refresh, stopped]);
        if (ctx.signal.aborted) return interrupted();
      }
      let input = call.input;
      preparedInput = true;
      for (const h of allHooks()) { const x = h.execInput?.(session, call); if (x !== undefined) input = x; }
      const authorizationError = authorizations.length ? () => authorizations.find((a) => !a.valid(call, input))?.deny : undefined;
      const deny = authorizationError?.();
      if (deny) return denied(deny);
      const runCtx = authorizationError ? { ...call.ctx, authorizationError } : call.ctx;
      // A dispatch set by a hook runs the call elsewhere (another machine's hands).
      t0 = Date.now();
      const run = runCtx.dispatch ? runCtx.dispatch(tool, input, runCtx) : tool.run(input, runCtx);
      // After a stop the tool may still fail on its way out; that is expected.
      run.catch(() => {});
      const out = await Promise.race([run, stopped]);
      if (!out) return ran(interrupted(), "interrupted");
      // No tool stores more text than the cap (its own, when it bounds its
      // result itself): the rest is in a file the result names. An image
      // enters the history within what every provider takes.
      const held = await capResult(out.content, tool.resultCap ?? OUTPUT_CAP, runCtx.dispatch ? undefined : ctx.spillDir, u.name);
      result = { type: "tool_result", tool_use_id: u.id, content: await fitToolImages(held, ctx.spillDir, !!runCtx.dispatch), is_error: out.is_error || undefined };
      if (out.shown !== undefined) this.shown.set(u.id, out.shown);
      ran(result, result.is_error ? "error" : "ok");
    } catch (e) {
      if (ctx.signal.aborted) return t0 === undefined ? interrupted() : ran(interrupted(), "interrupted");
      const err = e instanceof Error ? e : new Error(String(e));
      const failed: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: `Tool failed: ${err.message}`.slice(0, OUTPUT_CAP), is_error: true };
      // Measured before it is captured: the call's span exists by then and has
      // named itself on the error, so the error row and the span point at each other.
      if (t0 !== undefined) ran(failed, "error", err);
      this.errors.capture("tool", err, { tool: u.name, session: ctx.sessionId });
      // A call that never ran (a gate threw) ends here; one whose tool threw goes to the hooks below.
      if (t0 === undefined) return told(failed);
      result = failed;
      thrown = err;
    } finally {
      if (preparedInput && t0 === undefined) dropCallEnv(call.id);
      ctx.signal.removeEventListener("abort", onStop);
    }
    if (thrown) {
      for (const h of allHooks()) await (async () => h.toolFailed?.(session, call, result, thrown))().catch((e) => this.errors.capture("server", e, { hook: "toolFailed", tool: u.name, session: session.id }));
      return told(result);
    }
    // A hook that throws at once is caught like one that rejects.
    for (const h of allHooks()) await (async () => h.afterTool?.(session, call, result))().catch((e) => this.errors.capture("server", e, { hook: "afterTool", tool: u.name, session: session.id }));
    return told(result);
  }

  // Sessions whose summary could not be written whole (cut at the output limit
  // each time, or too long to carry between the parts of a transcript), with
  // the context it was tried on: the last checkpoint and the model. Each try
  // reads the whole context, and the same context ends the same way, so no
  // summary is asked for by itself (ahead, while idle, at the compaction line)
  // until a checkpoint lands or the session is on another model. At the
  // window, where a turn cannot go on without one, the turn ends with that
  // error, which names what the owner can do.
  // The memory holds only for that context as it grows: the last event the
  // failed try covered must still be at its place on the branch shown (a
  // shorter branch, or another one, is a context of its own). It is kept for
  // each of the two ways a summary is written: `line`, one request on the
  // session's own messages while the context fits, and `window`, the
  // transcript in parts once it does not. A failure at the line leaves the
  // turn at the window one try by the other way before it fails.
  private gaveUp = new SessionMap<{ key: string; at: number; id: string; tried: Set<"line" | "window">; error: Error }>(256);
  private gaveUpKey(events: readonly StoredEvent[], st: Step): string {
    const cp = checkpointAt(events).at;
    return `${cp < 0 ? "" : events[cp]!.id}|${st.info.id}`;
  }
  private gaveUpFor(id: string, events: readonly StoredEvent[], st: Step) {
    const g = this.gaveUp.get(id);
    return g && g.key === this.gaveUpKey(events, st) && events[g.at]?.id === g.id ? g : undefined;
  }
  private summaryGaveUp(id: string, events: readonly StoredEvent[], st: Step, over: boolean): Error | undefined {
    const g = this.gaveUpFor(id, events, st);
    return g?.tried.has(over ? "window" : "line") ? g.error : undefined;
  }
  private giveUp(id: string, events: readonly StoredEvent[], st: Step, covered: StoredEvent | undefined, over: boolean, e: unknown) {
    if (!covered || !SUMMARY_GAVE_UP.has((e as any)?.code)) return;
    const had = this.gaveUpFor(id, events, st);
    const at = had ? had.at : events.findLastIndex((x) => x.id === covered.id);
    if (at < 0) return;
    this.gaveUp.set(id, { key: this.gaveUpKey(events, st), at, id: events[at]!.id, tried: new Set([...(had?.tried ?? []), over ? "window" as const : "line" as const]), error: e as Error });
  }

  // Summaries being written ahead. Each can be stopped, and names the event it covers up to.
  private preparing = new Map<string, { abort: AbortController; covered: string }>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // When the prepared summary's request read this context's cache on the
  // model's route: one written for this branch on the same prefix (preparedWarm).
  private preparedMs(id: string, events: readonly StoredEvent[], st: Step): number {
    const row = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    return row && events.some((e) => e.id === row.covered) ? preparedWarm(JSON.parse(row.data), st.info.id) : 0;
  }

  // The cache of this context has surely expired: no request of this model
  // read or wrote it within the longest lifetime the route may keep it.
  private cacheCold(id: string, events: readonly StoredEvent[], st: Step): boolean {
    const warm = lastWarm(events, st.info.id, this.preparedMs(id, events, st));
    return warm > 0 && Date.now() - warm > retention(st.provider.wire, events, st.info.id).max;
  }

  // After a restart: idle sessions whose cache may still be warm get their timer
  // again. The pass reads no session's events: what the decision needs was
  // kept when the session last ended a turn (idle_facts), and it holds for as
  // long as the session shows the same head on the same model and route. A
  // session with no such facts (one an older build left, one whose branch
  // changed outside a turn) is read once, and the loop is given back before
  // the next. The request itself (tools, system prompt) is built when the
  // timer fires, for the sessions it fires for.
  async resumeIdle() {
    const since = Date.now() - 60 * 60_000;
    const routes = new Map<string, Promise<{ provider: Provider; info: ModelInfo }>>();
    const route = (model: string) => routes.get(model) ?? routes.set(model, this.providers.resolve(model)).get(model)!;
    for (const { id } of this.store.db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE updated > ? AND archived = 0").all(since)) {
      const s = this.store.session(id);
      if (!s || this.running.has(id) || s.parent_id || s.settings.idle_compact === false) continue;
      try {
        const { provider, info } = await route(s.model);
        // No answer on this route can show a lifetime that leaves idle time to use.
        if (longestSure(provider.wire) < 2 * IDLE_MARGIN_MS) continue;
        let facts = this.idleFacts(id);
        if (!facts || facts.head !== s.head || facts.model !== info.id || facts.wire !== provider.wire) {
          facts = this.readIdleFacts(s, provider.wire, info.id);
          // One session's events were read: the loop is given back before the next.
          await new Promise<void>((r) => setImmediate(r));
          if (this.running.has(id) || this.store.session(id)?.head !== facts.head) continue;
        }
        this.armIdle(s, facts, info.context, () => this.step(this.store.session(id)!, s.model));
      } catch (e) { this.errors.capture("provider", e, { session: id, at: "idle compaction after a restart" }); }
    }
  }

  private idleFacts(id: string): IdleFacts | undefined {
    return this.store.db.query<IdleFacts, [string]>("SELECT head, model, wire, used, warm, sure, max FROM idle_facts WHERE session_id = ?").get(id) ?? undefined;
  }

  // What idle compaction needs to know of the context the session shows, read
  // from its events and kept with it.
  private readIdleFacts(session: Session, wire: Provider["wire"], model: string): IdleFacts {
    const events = this.lineage(session.id);
    const keep = retention(wire, events, model);
    const facts: IdleFacts = { head: session.head, model, wire: wire ?? "", used: contextTokens(events, model).used, warm: lastWarm(events, model), sure: keep.sure, max: keep.max };
    this.store.db.query("INSERT OR REPLACE INTO idle_facts (session_id, head, model, wire, used, warm, sure, max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(session.id, facts.head, facts.model, facts.wire, facts.used, facts.warm, facts.sure, facts.max);
    return facts;
  }

  // After a turn: a context big enough gets its summary prepared shortly
  // before its cache lifetime ends, unless the session works again before then.
  private scheduleIdle(id: string, st: Step) {
    const session = this.store.session(id);
    // An agent's context is not prepared while idle: an ended agent is seldom
    // taken up again, and one that waits within its turn is not idle.
    if (!session || session.parent_id || session.settings.idle_compact === false) {
      clearTimeout(this.idleTimers.get(id));
      this.idleTimers.delete(id);
      return;
    }
    this.armIdle(session, this.readIdleFacts(session, st.provider.wire, st.info.id), st.info.context, () => st);
  }

  // Sets the session's idle timer from the facts of its context (idleDue).
  // `step`: the request the summary is asked on, made when the timer fires.
  private armIdle(session: Session, facts: IdleFacts, context: number, step: () => Step | Promise<Step>) {
    const id = session.id;
    clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
    const due = idleDue(facts, session.settings.compact_at ?? Math.floor(context * COMPACT_SHARE), Date.now());
    if (due === undefined) return;
    const t = setTimeout(async () => {
      this.idleTimers.delete(id);
      const idle = () => { const now = this.store.session(id); return !this.running.has(id) && !this.draining && !!now && !now.archived; };
      if (!idle()) return;
      try {
        const st = await step();
        if (idle()) this.prepare(id, st, true);
      } catch (e) { this.errors.capture("provider", e, { session: id, at: "idle compaction" }); }
    }, Math.max(0, due - Date.now()));
    (t as any).unref?.();
    this.idleTimers.set(id, t);
  }

  // Write a summary of the context as it stands now, in the background (the
  // turn goes on). It is stored with the event it covers up to, and swapped in
  // when the context reaches the compaction limit.
  // `idle`: written for idle compaction, so it covers the whole context: an
  // older summary that covers less is written again.
  // The work can be stopped: a preparation serves only while the event it
  // covers up to is on the branch shown, after its last checkpoint, in an open
  // session of a daemon that is not stopping. That is checked when the session
  // changes and again when the summary arrives, so obsolete work is cut short
  // and nothing of it is stored. One that still holds is stored and reused.
  private prepare(id: string, st: Step, idle = false) {
    const current = this.preparing.get(id);
    if (this.draining || (current && !current.abort.signal.aborted)) return;
    const events = this.lineage(id);
    const covered = events.findLast((e) => e.kind !== "turn_start" && e.kind !== "turn_end");
    if (!covered || !worthSummarizing(events) || this.summaryGaveUp(id, events, st, false)) return;
    const have = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    if (have && preparedHolds(events, have.covered, idle, JSON.parse(have.data))) return;
    const abort = new AbortController();
    this.preparing.set(id, { abort, covered: covered.id });
    const session = this.store.session(id)!;
    const before = this.used(events, st);
    const t0 = Date.now();
    this.summarize(id, st, session, events, abort.signal)
      .then((res) => {
        this.emitSession(id);
        const summary = res.summary;
        if (!summary) return;
        const data = { mode: "summary", ...(res.parts ? { parts: res.parts, outputs_shortened: res.clipped, ...(res.steps_left_out ? { steps_left_out: res.steps_left_out } : {}) } : {}), ...checkpointData(events, summary, this.wordsBudget(st)), auto: true, ahead: !idle, trigger: idle ? "idle" : "threshold", covered: covered.id, tokens_before: before, usage: res.usage, model: st.info.id, prepared_ms: Date.now(), duration_ms: Date.now() - t0 };
        if (abort.signal.aborted || !this.preparationHolds(id, covered.id, data)) return;
        this.store.db.run("INSERT OR REPLACE INTO prepared_summaries (session_id, covered, data, ts) VALUES (?, ?, ?, ?)", [id, covered.id, JSON.stringify(data), Date.now()]);
      })
      .catch((e) => {
        if (abort.signal.aborted) return;
        this.giveUp(id, events, st, covered, false, e);
        this.errors.capture("provider", e, { session: id, at: "preparing a summary" });
      })
      .finally(() => { if (this.preparing.get(id)?.abort === abort) this.preparing.delete(id); });
  }

  private preparationHolds(id: string, covered: string, data?: { statements_done?: string[] }): boolean {
    const s = this.store.session(id);
    return !!s && !s.archived && !this.draining && preparedHolds(this.lineage(id), covered, false, data);
  }

  private dropObsolete(id: string) {
    const p = this.preparing.get(id);
    if (p && !p.abort.signal.aborted && !this.preparationHolds(id, p.covered)) p.abort.abort();
  }

  // The prepared summary as a checkpoint, when it covers part of this branch
  // after its last checkpoint. The events since stay verbatim after it.
  private applyPrepared(id: string, events: readonly StoredEvent[]): boolean {
    const row = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    if (!row) return false;
    const data = JSON.parse(row.data);
    if (!preparedHolds(events, row.covered, false, data)) {
      // Written for another branch: kept for when that branch is shown again.
      // One this branch has passed (a checkpoint came after it) serves no more.
      if (events.some((e) => e.id === row.covered) || !this.store.event(row.covered)) this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
      return false;
    }
    this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
    const ev = this.append(id, "compaction", data);
    this.emitSession(id);
    const session = this.store.session(id);
    if (session) void this.compacted(session, ev);
    return true;
  }

  // Bytes of what every request carries before the conversation and the
  // provider counts: a deferred tool is not in the prompt until a call loads it.
  private prefixBytes(st: Step): number {
    return utf8Bytes(st.system ?? "") + toolsBytes(st.tools);
  }

  // Tokens the next request of this context carries, as this model counts
  // them: what the compaction line is held against. A context no reply has
  // measured (an imported history, a fresh checkpoint) is estimated whole from
  // its bytes, without the system prompt and the tools (they fit in the room
  // the compaction share leaves; whole() counts them against the window). A
  // session just moved from another model is never counted lower than that
  // model measured it (contextTokens).
  private used(events: readonly StoredEvent[], st: Step): number {
    return contextTokens(events, st.info.id).used;
  }

  // Tokens of the whole request that carries this context, held against the
  // model's window. A count a reply measured already holds the system prompt
  // and the tools; a context that is only its bytes (no reply with a count
  // yet) gets them on top. The compaction line stays on the conversation
  // alone (used): the room above it is for this.
  private whole(events: readonly StoredEvent[], st: Step): number {
    return contextTokens(events, st.info.id, Math.ceil(this.prefixBytes(st) / bytesPerToken(st.info.id))).used;
  }

  // The fewest tokens the request that carries this context can be. A count a
  // reply measured is that count. A count from bytes alone can be far too
  // high: the model's learned bytes a token come from tool-heavy sessions, and
  // prose (a long first message, a pasted document) runs near twice that. Its
  // floor is the bytes, system prompt and tools included, at the most bytes a
  // token a model is taken to have. A request that cannot be made smaller is
  // refused unsent only when this is over the window; under it the request is
  // sent, and a provider that refuses it teaches the ratio (refused()).
  private least(events: readonly StoredEvent[], st: Step): number {
    const t = contextTokens(events, st.info.id);
    return t.measured ? t.used : Math.ceil((contextBytes(events, st.info.id) + this.prefixBytes(st)) / RATIO_MAX);
  }

  // What the provider counted for a request against the bytes Keel counted
  // for it: the model's bytes a token, kept across restarts.
  private learn(id: string, st: Step, events: readonly StoredEvent[], u: Usage) {
    try {
      const ratio = learnRatio(st.info.id, contextBytes(events, st.info.id) + this.prefixBytes(st), u.input + u.cache_read + u.cache_write);
      if (ratio) this.keepRatio(st.info.id, ratio);
    } catch (e) {
      this.errors.capture("server", e, { at: "learning the token ratio", model: st.info.id, session: id });
    }
  }

  // A model's ratio as last written to the store. Every reply moves the ratio
  // a little; it is written when it has moved by a hundredth since (or at
  // once after a refusal). A restart then starts within a hundredth of where
  // the last daemon was, far below what an estimate from bytes is good for,
  // and a step of a turn does not pay a write for it.
  private ratioKept = new Map<string, number>();
  private keepRatio(model: string, ratio: number, now = false) {
    const kept = this.ratioKept.get(model);
    if (!now && kept !== undefined && Math.abs(ratio - kept) < kept / 100) return;
    this.ratioKept.set(model, ratio);
    this.store.db.run("INSERT OR REPLACE INTO token_ratios (model, ratio, ts) VALUES (?, ?, ?)", [model, ratio, Date.now()]);
  }

  // The owner's words kept verbatim through a compaction: OWNER_WORDS_BYTES,
  // or a quarter of a window too small to hold that beside the summary.
  // `next`: the model the session switches to after this summary (the owner
  // compacts before a switch): its window bounds the words too.
  private wordsBudget(st: Step, next?: ModelInfo): number {
    const quarter = (m: ModelInfo) => Math.floor((m.context / 4) * bytesPerToken(m.id));
    return Math.min(OWNER_WORDS_BYTES, quarter(st.info), next ? quarter(next) : Infinity);
  }

  // The provider refused this context as over the model's window: Keel's count
  // of it was too low, so the model's bytes a token come down to fit the refusal.
  private refused(st: Step, events: readonly StoredEvent[]) {
    const ratio = capRatio(st.info.id, contextBytes(events, st.info.id) + this.prefixBytes(st), st.info.context);
    if (ratio) this.keepRatio(st.info.id, ratio, true);
  }

  // The summary of a context. Written on the session's own request (tools and
  // system unchanged, so that call reads the history from cache) when the
  // request fits the model's window. A history that does not fit (an imported
  // one, a window smaller than the model it came from) is read as a text
  // transcript: tool outputs shortened oldest first until one request holds
  // it, else in parts oldest first, each with the summary of the parts before
  // it. A request the provider still refuses as too long is built again smaller.
  // `transcript`: read as a transcript from the start (the single request was tried on this context and failed).
  // `planned`: told once the transcript is cut, before its first request: how
  // many requests it takes and about how many tokens they send.
  private async summarize(id: string, st: Step, session: Session, events: readonly StoredEvent[], signal: AbortSignal, focus?: string, transcript = false, planned?: (plan: { requests: number; done: number; input_tokens: number; cost?: number; steps_left_out?: number }) => void): Promise<{ summary: string; usage: Usage; parts?: number; clipped?: number; steps_left_out?: number }> {
    focus ??= allHooks().map((h) => h.compactFocus?.(session)).find(Boolean);
    let usage = emptyUsage();
    const one = async (ask: Message[], fit: Fit): Promise<string> => {
      for (let retries = SUMMARY_RETRIES; ; ) {
        const res = await this.call(id, st, ask, signal, new Map(), session, true, "summary", fit); // the summary is not a reply
        usage = addUsage(usage, res.usage);
        this.store.addUsage(id, res.usage);
        if (res.stop === "refusal") return "";
        // The request and its reply together passed the window: asking for a
        // shorter reply to the same request ends the same way. The history is
        // read as a transcript instead (in smaller parts, when it already is one).
        if (res.stop === "model_context_window_exceeded") throw Object.assign(new Error(`the summary request filled ${st.info.name}'s window before the summary was written`), { kind: "context", filled: true });
        // Cut at the output limit, its end (where the work stands, the next
        // step) is missing: it is never kept. Asked again, shorter.
        if (res.stop !== "max_tokens") return res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        if (retries-- <= 0) throw Object.assign(new Error(`the summary was cut at ${st.info.name}'s output limit (${st.info.output} tokens) each time it was asked for, so nothing was kept: ${SUMMARY_REMEDIES}`), { status: 409, code: "summary_truncated" });
        const note = shorterPrompt(st.info.output);
        const last = ask.at(-1)!;
        if (!(last.content as any[]).some((b) => b.type === "text" && b.text === note)) ask = [...ask.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: note }] } as Message];
      }
    };
    const messages = toMessages(events);
    let over: unknown;
    if (!transcript && !(this.whole(events, st) >= st.info.context)) {
      try {
        return { summary: await one([...messages, { role: "user", content: [{ type: "text", text: summaryPrompt(focus) }] }], { tokens: this.whole(events, st), base: messages }), usage };
      } catch (e) {
        if (signal.aborted || (e as any)?.kind !== "context") throw e;
        over = e;
        // Refused by the provider as over its window: its count of this context was higher than Keel's.
        if (!(e as any).unsent && !(e as any).filled) this.refused(st, events);
      }
    }
    // What one request can hold of the transcript: the compaction share of
    // the window less the request's own prefix, in this model's bytes a token.
    const room = Math.floor(st.info.context * COMPACT_SHARE * bytesPerToken(st.info.id)) - this.prefixBytes(st);
    // Each request is the prompt's own words, the summary of the parts before
    // it and one part. The parts are cut for a summary of SUMMARY_ROOM_BYTES;
    // a summary that came back longer takes its room from the parts after it.
    const words = utf8Bytes(partPrompt("", 0, 2, " ", 1, focus));
    const carry = SUMMARY_ROOM_BYTES(st);
    const text = (t: string): Message[] => [{ role: "user", content: [{ type: "text", text: t }] }];
    // A request of one message and no history: the system prompt and tools, then what the message holds.
    const alone: Fit = { tokens: Math.ceil(this.prefixBytes(st) / bytesPerToken(st.info.id)), base: [] };
    for (const share of SHRINK_STEPS) {
      // Never less than the prompt, a summary and one smallest part.
      const budget = Math.max(Math.floor(room * share), words + carry + MIN_PART_BYTES);
      // At most TRANSCRIPT_PARTS_MAX parts: a longer history leaves its oldest steps out and says so.
      const cut = await transcriptPartsPaced(messages, budget - words - carry, TRANSCRIPT_PARTS_MAX);
      if (signal.aborted) throw new Error("the compaction was stopped");
      const clipped = cut.clipped, leftOut = cut.left_out.steps;
      let parts = cut.parts;
      // What the requests will send: each its prefix, the prompt, its part and the summary carried into it.
      const per = bytesPerToken(st.info.id);
      const tokens = Math.ceil(parts.reduce((n, p, k) => n + this.prefixBytes(st) + words + utf8Bytes(p) + (k ? carry : 0), 0) / per);
      const plan = (done: number) => planned?.({ requests: parts.length, done, input_tokens: tokens, ...(st.info.price ? { cost: (tokens * st.info.price.input) / 1e6 } : {}), ...(leftOut ? { steps_left_out: leftOut } : {}) });
      try {
        let summary = "";
        for (let k = 0; k < parts.length; k++) {
          plan(k);
          summary = await one(text(partPrompt(parts[k]!, k, parts.length, summary, clipped, focus, leftOut)), alone);
          if (!summary) return { summary, usage };
          if (k + 1 === parts.length) break;
          // The next request carries this summary. One that leaves no room for
          // a part is asked for again within what does, a bounded number of times.
          let left = budget - words - utf8Bytes(summary);
          const most = budget - words - MIN_PART_BYTES;
          for (let retries = SUMMARY_RETRIES; left < MIN_PART_BYTES && retries-- > 0 && utf8Bytes(summary) + words <= budget; ) {
            summary = await one(text(condensePrompt(summary, most)), alone);
            if (!summary) return { summary, usage };
            left = budget - words - utf8Bytes(summary);
          }
          if (left < MIN_PART_BYTES) throw Object.assign(new Error(`the summary of the transcript's earlier parts is too long to go with the next part (${utf8Bytes(summary)} bytes, ${most} fit), so nothing was kept: ${SUMMARY_REMEDIES}`), { status: 409, code: "summary_too_long" });;
          // The rest of the transcript, cut again for the room this summary leaves.
          if (utf8Bytes(parts[k + 1]!) > left) parts = [...parts.slice(0, k + 1), ...recut(parts.slice(k + 1).join(""), left)];
        }
        return { summary, usage, parts: parts.length, clipped, ...(leftOut ? { steps_left_out: leftOut } : {}) };
      } catch (e) {
        if (signal.aborted || (e as any)?.kind !== "context") throw e;
        over = e;
      }
    }
    // No part of it fits with the room a summary needs, at any size tried: said
    // with what can be done, and remembered like a summary that is cut each time.
    throw Object.assign(new Error(`the history could not be summarized within ${st.info.name}'s window, in one request or in parts (${errorText(over).slice(0, 160)}): switch to a model with a larger window, or clear the context`), { status: 409, code: "summary_no_room", cause: over });
  }

  // Summarize the context into a checkpoint. Runs inside a turn (auto, before a
  // call that would not fit) or on the owner's request between turns.
  // `trigger`: what started it (the threshold, a request that did not fit, the owner).
  async compactNow(id: string, opts: { focus?: string; auto?: boolean; trigger?: "threshold" | "overflow" | "owner"; signal?: AbortSignal; step?: Step; next?: ModelInfo } = {}) {
    const session = this.store.session(id)!;
    const events = this.lineage(id);
    // A turn with no reply yet: the prompts that opened it stay out of the summary and follow it whole.
    const upto = summarizable(events);
    const messages = toMessages(upto);
    if (!messages.length || !worthSummarizing(upto)) throw Object.assign(new Error("nothing to compact"), { status: 409 });
    const st = opts.step ?? (await this.step(session, session.model));
    if (upto.length < events.length) {
      const opening = events.slice(upto.length);
      const tokens = contextTokens(opening, st.info.id).used;
      // Not compacted with the rest and with no count of its own: over the window only if it is at any bytes a token.
      if (Math.ceil(contextBytes(opening, st.info.id) / RATIO_MAX) >= st.info.context) throw Object.assign(new Error(`The prompt this turn answers is about ${tokens} tokens (${opening.reduce((n, e) => n + (e.kind === "user" ? utf8Bytes(String(e.data.text ?? "")) : 0), 0)} bytes), more than ${st.info.name}'s window of ${st.info.context} tokens, so it cannot be sent whole: shorten it, or switch to a model with a larger window.`), { status: 409, code: "context_over_window" });
    }
    const before = this.used(events, st);
    // Not asked again by itself for a context whose summary could not be written whole; the owner's own request is.
    // At the window, a failure remembered from the line leaves one try by the way not tried: the transcript in parts.
    const over = this.whole(events, st) >= st.info.context;
    const gaveUp = opts.auto ? this.summaryGaveUp(id, events, st, over) : undefined;
    if (gaveUp) throw gaveUp;
    const transcript = !!opts.auto && over && !!this.gaveUpFor(id, events, st);
    for (const h of allHooks()) await Promise.resolve().then(() => h.beforeCompact?.(session, { auto: !!opts.auto, focus: opts.focus })).catch((e) => this.errors.capture("server", e, { hook: "beforeCompact", session: id }));
    this.status(id, { kind: "compacting", auto: !!opts.auto });
    const own = new AbortController();
    const signal = opts.signal ?? own.signal;
    const t0 = Date.now();
    try {
      // A history read in parts says first what it will take, and how far it is.
      const planned = (plan: NonNullable<Extract<TurnStatus, { kind: "compacting" }>["plan"]>) => this.status(id, { kind: "compacting", auto: !!opts.auto, plan });
      const res = await this.summarize(id, st, session, upto, signal, opts.focus, transcript, planned).catch((e) => { this.giveUp(id, events, st, upto.at(-1), over, e); throw e; });
      const u: Usage = res.usage;
      const summary = res.summary;
      if (!summary) throw Object.assign(new Error("the model wrote no summary"), { status: 409 });
      // Bound to the branch it summarized; the owner's compaction also to no turn having started since.
      const moved = headMoved(events.at(-1)?.id, this.store.session(id)?.head);
      // Inside a turn, a note a hook stored for the summary request itself (memory
      // for the prompt, when the summary is the turn's first request) follows the
      // summarized events on the same branch: it stays verbatim after the summary.
      let covered = upto.length < events.length ? upto.at(-1)!.id : undefined;
      if (moved) {
        const now = this.lineage(id);
        const at = now.findIndex((e) => e.id === events.at(-1)!.id);
        if (!opts.auto || at < 0 || now.slice(at + 1).some((e) => e.kind !== "note")) throw moved;
        covered ??= events.at(-1)!.id;
      }
      if (!opts.auto && this.running.has(id)) throw Object.assign(new Error("a turn started while the summary was written: nothing was applied; compact when it has ended"), { status: 409, code: "head_moved" });
      const ev = this.append(id, "compaction", {
        mode: "summary", ...(res.parts ? { parts: res.parts, outputs_shortened: res.clipped, ...(res.steps_left_out ? { steps_left_out: res.steps_left_out } : {}) } : {}), ...checkpointData(upto, summary, this.wordsBudget(st, opts.next)), focus: opts.focus, auto: !!opts.auto,
        trigger: opts.trigger ?? (opts.auto ? "threshold" : "owner"), tokens_before: before, usage: u, model: st.info.id, duration_ms: Date.now() - t0, ...(covered ? { covered } : {}),
      });
      this.emitSession(id);
      await this.compacted(session, ev);
      return ev;
    } finally {
      this.status(id, { kind: "idle" });
    }
  }

  // A summary is in place: told to the modules that follow compactions.
  private async compacted(session: Session, ev: StoredEvent) {
    for (const h of allHooks()) await Promise.resolve().then(() => h.afterCompact?.(session, ev)).catch((e) => this.errors.capture("server", e, { hook: "afterCompact", session: session.id }));
  }

  // Before the daemon stops: no new turn starts; running turns get `ms` to end
  // by themselves, then are parked (cut, with "restart" as their end reason) so
  // the next daemon resumes them.
  async drain(ms: number) {
    await this.settle(ms);
    await this.park();
  }

  // The first half of a drain: no new turn starts, and running turns get `ms`
  // to end by themselves. Nothing is cut yet, so the drain can still be called off.
  // A turn that only waits on the owner (a question, a plan, an approval card)
  // is not waited for: it would take the whole time and still be waiting, with
  // new work refused meanwhile. It is parked with its card open, and the next
  // daemon puts the card back. Looked at again every SETTLE_CHECK_MS, since a
  // turn at work may start to wait on the owner and the owner may answer one.
  async settle(ms: number) {
    this.draining = true;
    // A summary being prepared is not waited for: the next daemon prepares it again.
    for (const p of this.preparing.values()) p.abort.abort();
    // What a hook still has under way (a fleet move) is waited for like a turn at work.
    let moving = 0;
    const moves: Promise<unknown>[] = [];
    for (const h of allHooks()) {
      try { const p = h.draining?.(); if (p) { moving++; moves.push(p.catch(() => {}).finally(() => { moving--; })); } } catch (e) { this.errors.capture("server", e, { hook: "draining" }); }
    }
    const deadline = Date.now() + ms;
    for (;;) {
      const busy = [...this.running.entries()].filter(([id]) => !this.waitsOnOwner(id)).map(([, r]) => r.done);
      const left = deadline - Date.now();
      if ((!busy.length && !moving) || left <= 0) return;
      await Promise.race([Promise.all([...busy, ...(moving ? moves : [])]), Bun.sleep(Math.min(left, SETTLE_CHECK_MS))]);
    }
  }

  // The second half: the turns still running are parked.
  async park() {
    await Promise.all([...this.running.entries()].map(async ([id, r]) => {
      this.parking.add(id);
      for (const h of allHooks()) try { h.turnParking?.(id); } catch (e) { this.errors.capture("server", e, { hook: "turnParking", session: id }); }
      r.abort.abort();
      await r.done;
    }));
  }

  // A drain called off before any turn was parked: turns start again, first
  // the prompts that waited in a queue meanwhile.
  undrain() {
    this.draining = false;
    for (const h of allHooks()) try { h.drainOff?.(); } catch (e) { this.errors.capture("server", e, { hook: "drainOff" }); }
    for (const { session_id } of this.store.db.query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM queue").all()) this.next(session_id);
    // The drain stopped the summaries being prepared and let the idle timers
    // pass unused: idle sessions get their timer again, as after a start.
    void this.resumeIdle();
    // A provider's wait that ended during the drain was left for the next daemon: this one takes it.
    this.rearmContinues();
  }

  // At startup: a turn the last daemon left open (a crash, a kill) is closed
  // the way a stop would close it, and a turn cut by a restart continues by
  // itself, through any number of restarts. A prompt that was accepted and
  // whose turn had not started yet (the daemon went down while its provider
  // or system prompt was set up) is closed as a turn cut at its start, so it
  // continues the same way. Only a session whose continued turns keep being
  // cut before a step is done (STALLED_MAX) is held, with the reason shown
  // and its Continue. A session with an owner of its own (an agent's, through
  // the cutTurn hook) may say otherwise.
  async recover(openAtBoot: string[], waitModel: (model: string) => Promise<void>) {
    this.closeCut(openAtBoot);
    // Every module is up by now: the turns this start closed are told of
    // first, whoever goes on with them.
    for (const [id, cut] of this.cutAtBoot) {
      const s = this.store.session(id);
      if (s) this.tellCut(s, cut);
    }
    this.rearmContinues();
    this.startQueued(openAtBoot, waitModel);
    return this.continueCut(waitModel);
  }

  // At startup: the queued prompts the last daemon owed a start. Its turn
  // ended while that daemon was stopping, when nothing starts (next), or the
  // daemon was killed before the end of the turn got to its queue (the session
  // still carried the working mark): nothing else would take the row until
  // the owner typed there. A session whose turn a restart cut gets its rows
  // from the continued turn instead: a steer in its first request, a queued
  // prompt after it. A held queue stays held, and a row that waits for any
  // other reason (a queue from before this was kept) is left to the owner.
  private startQueued(openAtBoot: string[], waitModel: (model: string) => Promise<void>) {
    for (const id of new Set([...this.owed, ...openAtBoot])) {
      const s = this.store.session(id);
      if (!s || !this.store.queue(id).length) { this.settleOwed(id); continue; }
      if (s.archived || this.held.has(id) || this.running.has(id)) continue;
      const end = this.lineage(id).at(-1);
      if (end?.kind === "turn_end" && end.data.reason === "restart") continue;
      void waitModel(s.model).then(() => this.next(id), (e) => this.errors.capture("provider", e, { session: id, at: "queued prompt after restart" }));
    }
  }

  // The record of a cut turn (who is told is not the engine's business): a
  // hook that fails never stops the recovery.
  private told = new Set<string>();
  private tellCut(s: Session, cut: CutTurn, state?: CutState, why?: string) {
    if (!state && this.told.has(cut.end_event)) return;
    this.told.add(cut.end_event);
    for (const h of allHooks()) {
      try { if (state) h.turnCutSettled?.(s, cut, state, why); else h.turnCut?.(s, cut); } catch (e) { this.errors.capture("server", e, { hook: state ? "turnCutSettled" : "turnCut", session: s.id }); }
    }
  }

  // The closing half of recover, on its own so a start can run it before
  // anything of its own is delivered (a monitor's wake, an agent's report):
  // what the last daemon left open is closed first, and a prompt this start
  // stores is not mistaken for one the last daemon owed a turn. `openAtBoot`
  // are the sessions that carried the working mark when the store was opened;
  // one that no longer does (closed already, or its turn was parked since) or
  // that runs a turn now is left alone. Safe to call again.
  closeCut(openAtBoot: string[]) {
    for (const id of openAtBoot) {
      const session = this.store.session(id);
      if (!session || session.phase !== "working" || this.running.has(id)) continue;
      try {
        this.closeOne(id, session);
      } catch (e) {
        // One session that cannot be read must not stop the others: its mark
        // is taken off without acting, and it is left as it was found.
        this.errors.capture("server", e, { at: "recover", session: id });
        this.store.bootSettled(id);
        this.emitSession(id);
      }
    }
  }

  private closeOne(id: string, session: Session) {
    {
      const line = this.lineage(id);
      const lastStart = line.findLastIndex((e) => e.kind === "turn_start");
      const lastEnd = line.findLastIndex((e) => e.kind === "turn_end");
      // Closed in the write that takes the working mark off the session: a
      // daemon killed here closes it at its next start, once.
      const closing: StoredEvent[] = [];
      this.store.atomic(id, () => {
        if (lastStart > lastEnd) {
          const results = new Set(line.slice(lastStart).flatMap((e) => (e.kind === "tool_result" ? e.data.results.map((r: any) => r.tool_use_id) : [])));
          // A call whose card is still open is left for the continued turn (owedCalls).
          const cut = line.slice(lastStart).flatMap((e) => (e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "tool_use" && !results.has(b.id) && !waitsOnOwner(id, b)) : []));
          if (cut.length) closing.push(this.store.append(id, "tool_result", { results: cut.map((u: any) => ({ type: "tool_result", tool_use_id: u.id, content: cutText(id, u), is_error: true })) }));
          // It ran until the daemon went down (its last sign of life, or the
          // turn's own last event when that is later), not until this start.
          const down = Math.min(Date.now(), Math.max(this.wentDown ?? 0, line.at(-1)!.ts));
          closing.push(this.store.append(id, "turn_end", { reason: "restart", usage: emptyUsage(), ms: Math.max(0, down - line[lastStart]!.ts), crashed: true, down_ms: down }));
        } else if (owedTurn(line.slice(lastEnd + 1))) {
          closing.push(this.store.append(id, "turn_start", { model: session.model }));
          closing.push(this.store.append(id, "turn_end", { reason: "restart", usage: emptyUsage(), ms: 0, crashed: true, unstarted: true }));
        }
        this.store.bootSettled(id);
      });
      const end = closing.at(-1);
      if (end) this.cutAtBoot.set(id, cutOf(id, this.lineage(id), end));
      for (const e of closing) this.emitEvent(e);
      this.emitSession(id);
    }
  }

  private async continueCut(waitModel: (model: string) => Promise<void>) {
    // Each session on its own: a provider still starting holds only its sessions.
    // The continued turns start a few at a time, the newest first, spaced out,
    // so a restart with many open sessions does not send every replayed context
    // to the providers in the same second.
    const slots = new Slots(RESUME_AT_ONCE, RESUME_GAP_MS);
    // Only the sessions whose branch ends in a turn a restart cut are read:
    // the store finds them from each session's last event.
    const sessions = this.store.cutSessions();
    await Promise.all(sessions.map(async (s) => {
      const line = this.lineage(s.id);
      const end = line.at(-1);
      if (s.archived || end?.kind !== "turn_end" || end.data.reason !== "restart") return;
      // A turn a stop parked is found here; one this start closed was told of already.
      const cut = this.cutAtBoot.get(s.id)?.end_event === end.id ? this.cutAtBoot.get(s.id)! : cutOf(s.id, line, end);
      this.tellCut(s, cut);
      const held = (text: string) => {
        this.append(s.id, "note", { kind: "restart", text });
        for (const h of allHooks()) try { h.cutTurnHeld?.(s, text); } catch (e) { this.errors.capture("server", e, { hook: "cutTurnHeld", session: s.id }); }
        this.tellCut(s, cut, "held", text);
      };
      // A turn that waits on the owner's card is waiting, not stalled.
      const owed = owedCalls(s.id, line).length;
      const stalled = owed ? 0 : stalledContinuations(line);
      const verdict = allHooks().map((h) => h.cutTurn?.(s, { stalled })).find(Boolean);
      if (verdict !== "continue" && (verdict || stalled >= STALLED_MAX)) return held(verdict ? verdict.hold : `This turn was resumed after a daemon restart ${stalled} times in a row, and each time the daemon went down again before a tool call finished, so it was not resumed again. Resume when you want it to go on.`);
      try {
        await waitModel(s.model);
      } catch (e) {
        const rec = this.errors.capture("provider", e, { session: s.id, at: "resume after restart" });
        return held(`The turn was cut by a daemon restart and could not resume: ${rec.message}. Resume when the model is back.`);
      }
      // A turn that goes back to a question or a plan sends no request until
      // the owner answers: it takes no slot, so the card is back at once and
      // the turns that do send are not held behind it. One that goes back to
      // an approval card may send at once (the mode it is in now may settle
      // the card by itself): it takes a slot and gives it back as soon as it
      // is seen waiting on the owner.
      const cards = owed > 0 && owedCalls(s.id, line).every((u) => asksOwner(u.name));
      if (!cards) await slots.take();
      try {
        // Checked again right before starting: the owner may have moved on, archived or sent meanwhile.
        const now = this.store.session(s.id);
        if (!now || now.archived || this.running.has(s.id) || this.lineage(s.id).at(-1)?.id !== end.id) return this.tellCut(s, cut, "moved");
        // And its owner is asked again: an agent stopped while its turn waited
        // for its model or a slot (its goal cleared or replaced, its parent's
        // turn stopped) is not continued, as if the stop had come first.
        const again = allHooks().map((h) => h.cutTurn?.(now, { stalled })).find(Boolean);
        if (again && again !== "continue") return held(again.hold);
        this.acceptRestart(s.id);
        this.start(s.id);
        this.emitQueue(s.id);
        this.tellCut(s, cut, "continued");
        // Held until the turn ends or its first steps had time to run: a turn that
        // then waits on the owner (an approval) does not hold back the others.
        if (!cards) await Promise.race([this.running.get(s.id)?.done, Bun.sleep(RESUME_HOLD_MS), ...(owed ? [this.untilOnOwner(s.id, RESUME_HOLD_MS)] : [])]);
      } finally {
        if (!cards) slots.give();
      }
    }));
  }

  // Resolves once the session's turn only waits on the owner (or ended, or `ms` passed).
  private async untilOnOwner(id: string, ms: number) {
    for (const end = Date.now() + ms; this.running.has(id) && !this.waitsOnOwner(id) && Date.now() < end; ) await Bun.sleep(50);
  }

  // The message that continues a turn a restart cut, stored when the branch
  // ends in such a turn: by the continuation itself, and before a prompt that
  // arrives first (the owner's, a kept send going out again), so the model is
  // told of the cut either way. A branch whose card still waits and whose last
  // such message the model never read gets no second one: restarts while a
  // card waits do not grow the context.
  // True when the branch ends in a cut turn and now has its restart message.
  private acceptRestart(id: string): boolean {
    const line = this.lineage(id);
    const end = line.at(-1);
    if (end?.kind !== "turn_end" || end.data.reason !== "restart") return false;
    const owed = owedCalls(id, line).length;
    const told = line.findLastIndex((e) => e.kind === "user" && e.data.origin === "restart");
    if (owed && told >= 0 && !line.slice(told).some((e) => e.kind === "assistant")) return true;
    const cutTools = line.slice(line.findLastIndex((e) => e.kind === "turn_start")).flatMap((e) => (e.kind === "tool_result" ? e.data.results.filter((r: any) => stopKind(r.content) === "cut") : [])).length;
    this.accept(id, { origin: "restart", text: restartText(cutTools, owed, !!end.data.unstarted) });
    return true;
  }

  // One answer outside the history (a side question): the session's own model,
  // tools and system on its stored branch plus `extra`, so the prefix is read
  // from cache. Nothing is appended; the cost counts for the session.
  // `model`: answer on another model (an advisor) over the same conversation.
  // `pending`: the text for a call of the running turn that has no result yet
  // (the call asking), in place of the "interrupted" stand-in.
  async ask(id: string, extra: Message[], signal: AbortSignal, model?: string, pending?: { id: string; text: string }): Promise<ProviderResult & { model_id: string }> {
    const session = this.store.session(id)!;
    const st = await this.step(session, model ?? session.model);
    const line = this.lineage(id);
    const messages = toMessages(line);
    // The stored branch is what the count below covers; the question's words come on top.
    // (A side question compacts nothing: an unmeasured branch is held to the fewest tokens it can be.)
    const fit: Fit = { tokens: this.whole(line, st), base: [...messages], least: this.least(line, st) };
    if (pending) messages.splice(0, messages.length, ...withPending(messages, pending));
    const last = messages.at(-1);
    for (const m of extra) {
      if (last?.role === "user" && m === extra[0] && m.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, ...m.content] };
      else messages.push(m);
    }
    // A request counted over the window is never sent: the branch with the
    // question's words, on the model that answers (the session's or an advisor's).
    const res = await this.call(id, st, messages, signal, new Map(), session, true, "side", fit);
    this.store.addUsage(id, res.usage);
    this.emitSession(id);
    return { ...res, model_id: st.info.id };
  }

  // Long content read by the session's reader models (src/engine/readers.ts)
  // with the working model's request; the answer goes back as the tool's result.
  // An answer from part of it names what went unread; throws when no reader
  // gave an answer (each failure is captured once).
  async read(id: string, source: string, text: string, prompt: string, signal: AbortSignal): Promise<{ text: string; model: string; usage: Usage; compiled: boolean; unread: string[] }> {
    return readSource(this.readerHost(id), source, text, prompt, signal);
  }

  // One reading job for the session: no conversation and no cache go with it,
  // each request is booked with purpose "reader", and `callId` gets the job's
  // progress on the bus (feature "readers").
  async readMaterial(id: string, items: Material[], question: string, signal: AbortSignal, callId?: string): Promise<ReadOutcome> {
    return readMaterial(this.readerHost(id, callId), items, question, signal);
  }

  private readerHost(id: string, callId?: string): ReaderHost {
    const session = this.store.session(id)!;
    return {
      models: () => this.providers.models(),
      current: async () => (await this.providers.resolve(session.model)).info,
      listPrice: (m) => this.providers.catalog.lookup(m.model)?.price,
      capture: (e, c) => this.errors.capture("provider", e, { session: id, ...c }),
      progress: callId ? (p) => this.bus.emit({ t: "feature", name: "readers", session_id: id, data: { call_id: callId, ...p } }) : undefined,
      ask: async (m, prompt, sig) => {
        const { provider, info } = await this.providers.resolve(m.id);
        const effort = info.efforts.includes("low") ? "low" : undefined;
        const st: Step = { provider, info: { ...info, output: Math.min(info.output || READER_OUTPUT, READER_OUTPUT) }, tools: [], system: READER_SYSTEM, systemSplit: 0, effort };
        const res = await this.call(id, st, [{ role: "user", content: [{ type: "text", text: conceal(prompt, id) }] }], sig, new Map(), session, true, "reader");
        this.store.addUsage(id, res.usage);
        this.emitSession(id);
        return { text: res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n"), usage: res.usage, stop: res.stop };
      },
    };
  }

  // /clear: a fresh context in the same session (no summary). Undo = head back.
  clear(id: string) {
    const events = this.lineage(id);
    const last = events.at(-1);
    if (!last || (last.kind === "compaction" && last.data.mode === "clear")) throw Object.assign(new Error("the context is already fresh"), { status: 409 });
    const ev = this.append(id, "compaction", { mode: "clear", undo_head: last.id });
    this.emitSession(id);
    return ev;
  }
}


// A cut turn as the record tells it, read off the branch it ends: the step it
// was on, the calls that were running (their results say a restart cut them)
// and the ones that wait on the owner (an approval, a question or a plan
// card, left open for the continued turn). `end`: the turn_end that closed it.
function cutOf(session: string, line: readonly StoredEvent[], end: StoredEvent): CutTurn {
  const at = line.findIndex((e) => e.id === end.id);
  const startAt = line.findLastIndex((e, i) => i < at && e.kind === "turn_start");
  const turn = line.slice(Math.max(startAt, 0), at < 0 ? line.length : at);
  const calls = new Map<string, string>(turn.flatMap((e) => (e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => [b.id, b.name] as [string, string]) : [])));
  const results = turn.flatMap((e) => (e.kind === "tool_result" ? e.data.results : []));
  const done = new Set(results.map((r: any) => r.tool_use_id));
  const tools = results.filter((r: any) => stopKind(r.content) === "cut").map((r: any) => calls.get(r.tool_use_id) ?? "a tool");
  const waiting = [...calls].filter(([id, name]) => !done.has(id) && waitsOnOwner(session, { id, name })).length;
  const steps = turn.filter((e) => e.kind === "assistant").length;
  const start = line[startAt];
  const ran = typeof end.data.ms === "number" ? end.data.ms : 0;
  return {
    turn_event: start?.id ?? end.id, end_event: end.id, started_ms: start?.ts ?? end.ts, ran_ms: ran,
    down_ms: typeof end.data.down_ms === "number" ? end.data.down_ms : end.data.crashed ? (start?.ts ?? end.ts) + ran : end.ts,
    crashed: !!end.data.crashed, unstarted: !!end.data.unstarted,
    // A call that was running or waited is of the step the model had given; else the model was on the next one.
    step: tools.length || waiting ? steps : steps + 1, tools, waiting,
  };
}

// What follows a session's last ended turn when a prompt was accepted and the
// daemon went down before its turn started: the prompt, and no turn after it.
// A turn that failed while it was set up said so (an error) and is not owed;
// only what follows the last prompt counts, so a prompt sent after such a
// failure is.
function owedTurn(tail: readonly StoredEvent[]): boolean {
  const prompt = tail.findLastIndex((e) => e.kind === "user");
  return prompt >= 0 && !tail.slice(prompt).some((e) => e.kind === "error" || e.kind === "turn_start");
}

// A session continued this many times in a row, each continuation cut by the
// next restart before it finished a step, is not continued again: something
// takes the daemon down before the turn can move (a command of its own that
// restarts or kills the daemon, a crash the turn causes), and each round costs
// a model request with no one watching. A few quick restarts in a row are
// ordinary (installs), so the count is not lower; restarts are otherwise never
// counted: a turn that gets a step done between them goes on.
export const STALLED_MAX = 3;
// A turn continued by itself this many times in a row after a provider's long
// wait, the provider asking for the wait again each time before the model
// gave a step, is not continued again: each round is a request and four more
// events with no one watching. The same count as STALLED_MAX, for the same
// reason; the owner's Try again starts the count over.
const CONTINUE_MAX = 3;
// A reply's outputs follow each other within a second or two, and a pause
// before a call's input can take ten. This long without any is not a pause:
// the status says the stream went silent, and since when.
export const STREAM_QUIET_MS = 20_000;

// How many turns at the end of a branch, in a row, were continuations after a
// restart that a restart cut again before they finished a step (a tool call
// that ran to its result). A continuation that got a step done ends the count:
// the work moves between restarts.
export function stalledContinuations(line: readonly StoredEvent[]): number {
  let n = 0;
  for (let end = line.length - 1; end >= 0; ) {
    const e = line[end]!;
    if (e.kind !== "turn_end" || e.data.reason !== "restart") break;
    const start = line.findLastIndex((x, i) => i < end && x.kind === "turn_start");
    const prompt = line.findLastIndex((x, i) => i < start && x.kind === "user");
    if (prompt < 0 || line[prompt]!.data.origin !== "restart") break;
    if (line.slice(start, end).some((x) => x.kind === "tool_result" && x.data.results.some((r: any) => stopKind(r.content) !== "cut"))) break;
    n++;
    end = prompt - 1;
  }
  return n;
}

// Continued turns after a restart: this many run at once, each start at least
// this far after the previous one. Three covers the usual one to three open
// sessions with no wait; more queue behind them.
const RESUME_AT_ONCE = Number(process.env.KEEL_RESUME_AT_ONCE || 3);
const RESUME_GAP_MS = Number(process.env.KEEL_RESUME_GAP_MS ?? 1000);
const RESUME_HOLD_MS = 30_000;
// How often a drain looks again at which running turns only wait on the owner.
const SETTLE_CHECK_MS = 250;

class Slots {
  private waiting: (() => void)[] = [];
  private last = 0;
  constructor(private free: number, private gapMs: number) {}
  async take() {
    while (this.free <= 0) await new Promise<void>((r) => this.waiting.push(r));
    this.free--;
    const wait = this.last + this.gapMs - Date.now();
    this.last = Math.max(Date.now(), this.last + this.gapMs);
    if (wait > 0) await Bun.sleep(wait);
  }
  give() {
    this.free++;
    this.waiting.shift()?.();
  }
}

// A title from the first prompt: its first line, cut at a word before 80
// characters with an ellipsis, never in the middle of a word.
export function firstLineTitle(text: string, max = 80): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "\u2026";
}
