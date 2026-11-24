import { type Wire, wireOf, wireScope } from "../providers/wiretap.ts";
import { during } from "../admin/activity.ts";
import { outward } from "../safety/egress.ts";
import { timed } from "../admin/stall.ts";
import { heldFile } from "../core/store-files.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rootOf } from "../safety/trust.ts";
import { crossing, crossingIn, routeOf, RouteRefused, sayCrossing } from "../safety/content-routes.ts";
import { allowedOnly, type RoutePurpose } from "../safety/route-rule.ts";
import { DeltaJoin } from "./deltas.ts";
import type { Bus } from "../core/bus.ts";
import type { Ruled } from "../safety/trial.ts";
import { asAsker } from "../core/asker.ts";
import { errorScope, type ErrorTracker } from "../core/errors.ts";
import { diskFull, refusedWrite, type Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import { conceal } from "../core/conceal.ts";
import { ownerPrompt, ownersMeta } from "../core/owner.ts";
import { blockName, blocksOf, changedBlocks, ownChanges, PromptStore, urgentBlock, type PromptBlock, type PromptPart, type StoredPrompt } from "./prompt-store.ts";
import { NOTE_KIND, promptNote, toldOf, type Rendered } from "./prompt-note.ts";
import { editedPath, noteMark, type Marks } from "./instruction-marks.ts";
import { testBuild } from "../core/build.ts";
import { BuildPins, coldReason, pinAged } from "./build-pin.ts";
import { SCHEMA_RESENDS, ToolFit, wireOf as fitWireOf } from "./tool-fit.ts";
import type { AssistantBlock, ErrorRecord, Message, QueueItem, Session, StoredEvent, ToolResultBlock, ToolUseBlock, TurnStatus, Usage, UserBlock } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import { configDir } from "../providers/config.ts";
import { shutWords } from "../providers/account.ts";
import { EFFORT_LADDER, type ModelInfo, type Price, type Provider, type ProviderRequest, type ProviderResult } from "../providers/types.ts";
import { asksOwner, registerPinnedDeferred, sessionToolsKey, sharedTool, toolsFor } from "../tools/registry.ts";
import { allPendingQuestions } from "../tools/interact.ts";
import { AGENT_BUDGET_SPENT, APPROVAL_CUT, CAP_SPENT, BUDGET_SPENT, CUT_CALL, QUESTION_CUT, RESTART_CUT, stopKind, stoppedBefore, stoppedWhile } from "../core/stops.ts";
import { holds, ownerStop, stopSays } from "../core/stoppers.ts";
import { dropCallEnv } from "../tools/jobs.ts";
import { closestNote, pauseNote, resolvedNote, resolveToolName } from "../tools/resolve.ts";
import { answers, callPaths, stoppedWaiting, unansweredText } from "../tools/fs-bound.ts";
import { inputProblem } from "../tools/validate.ts";
import { isDeferError, keepReferenced, loadsNatively, referenced, refuseDefer, unknownToolHint, withCatalog } from "../tools/defer.ts";
import { allHooks, cacheBreaks, hookChanged, type CutState, type CutTurn, type ExternalTurn, type SystemBlock, type ToolAuthorization, type ToolCall } from "./hooks.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { READER_OUTPUT, READER_SYSTEM, readerChoices, type Material } from "./reader.ts";
import { trialModel } from "./model-trial.ts";
import { readBudget, readMaterial, readSource, smallModels, type ReaderHost, type ReadOutcome } from "./readers.ts";
import { REWORD_SYSTEM, rewordHolds, rewordPrompt } from "../automation/successor.ts";
import { cleanTitle, derivedTitle, firstReply, modelTitles, ownerPrompts, TITLE_OUTPUT, TITLE_SYSTEM, titleOwed, titlePrompt, weakStart } from "./title.ts";
import { STALE_BIND } from "../providers/wires/binding.ts";
import { derived } from "../core/message-facts.ts";
import { TRANSCRIPT_PARTS_MAX, transcriptPartsPaced, countPaced, bytesPerToken, capRatio, checkpointAt, OWNER_WORDS_BYTES, COMPACT_SHARE, contextBytes, contextTokens, openingBytes, messagesBytes, RATIO_MAX, headMoved, learnRatio, partPrompt, setRatio, transcriptParts, recut, condensePrompt, shorterPrompt, utf8Bytes, IDLE_MARGIN_MS, idleDue, idleMinTokens, type IdleFacts, checkpointData, settle, settleAsk, type Settled, lastWarm, preparedWarm, preparedFits, preparedHolds, PREPARE_SHARE, summarizable, summaryMessage, summaryPrompt, worthSummarizing, keptMessages, fixedContext } from "./compact.ts";
import { effectiveEffort, LONGEST_KEEP_MS, longestSure, PAUSE_MARGIN_MS, retention, switchWarning } from "./cachewarn.ts";
import { askedLife, cacheLives } from "../providers/wires/common.ts";
import { CachePlans, marginOf } from "./cache-plans.ts";
import { cacheState, capsuleText, decideFollowUp, isWay, missingFrom, rereadBytes, storyOf, taskShape, type FollowUpPlan, type Way } from "./follow-up.ts";
import { anchorsOf, TRAIL_BYTES } from "./trail.ts";
import { priceCompaction, residual, type PriceVerdict, type Residual } from "./price-compact.ts";
import { PriceFacts } from "./price-facts.ts";
import type { WaitShape } from "./cache-plan.ts";
import { withoutImages } from "./images.ts";
import { anyOver, damagedImages, fitForWire, fitToolImages, imageKeys, oldestForSize } from "./image-fit.ts";
import { oldestResultsForSize, shortenResults } from "./size-fit.ts";
import { imageLimits, imageRefusal, requestTooLarge } from "../providers/image-limits.ts";
import { resolveAttachments } from "./attachments.ts";
import { RETRY, RETRY_WAIT_MAX_MS, RetryTooLong, backoffMs, errorText, movesToFallback, overloaded, overloadedGroup, retriesLeft, retryAfterMs, retryable, sleep, type MoveWhy } from "./retry.ts";
import { OUTAGE } from "../providers/outage.ts";
import { settings as ownerSettings } from "../admin/settings.ts";
import { dueIn, judge, judgeMove, noteText as routeNote, ruleFor, type Rule as RouteChangeRule, type Why as RouteWhy } from "./route-change.ts";
import { ASK_USD_DEFAULT, carriedEffort } from "./switch-rule.ts";
import { carrySettings } from "../server/switch.ts";
import { laneOf, rateLimited, type Lane } from "../providers/admission.ts";
import { depthOf } from "../core/agent-tree.ts";
import { unreachable } from "../providers/unreachable.ts";
import { reportedUsage } from "../providers/reported.ts";
import { capResult, OUTPUT_CAP } from "../tools/spill.ts";
import { HEAD_SHARE, inlineCap } from "../tools/carry.ts";
import { homeDir } from "../core/paths";
import { outsideRefusal } from "../core/watch.ts";

// What a result says of a call a restart cut or the owner's stop reached (src/core/stops.ts).
export { APPROVAL_CUT, QUESTION_CUT, RESTART_CUT };
// A result that says the turn was stopped or cut under the call, not that the call failed.
export const isStopResult = (content: unknown) => stopKind(content) !== undefined;
// A call in a few words, for a sentence that names it: its tool, and its command or file when it has one.
const callWords = (u: ToolUseBlock) => {
  const i = (u.input ?? {}) as Record<string, unknown>;
  const of = [i.command, i.cmd, i.file_path, i.path].find((v): v is string => typeof v === "string" && !!v.trim())?.trim().split("\n")[0];
  return of ? `${u.name} (${of.length > 80 ? `${of.slice(0, 80)}...` : of})` : u.name;
};
const outcomeOf = (session: string, callId: string) => allHooks().map((h) => h.callOutcome?.(session, callId)).find(Boolean);
// What a call a restart cut is answered with. An error, except when what the
// call was for is known to be stored (`done`): then the answer says so.
const cutResult = (session: string, u: { id: string; name: string }): { content: string; is_error: boolean } => {
  if (asksOwner(u.name)) return { content: QUESTION_CUT, is_error: true };
  const o = outcomeOf(session, u.id);
  if (o && typeof o === "object" && "done" in o) return { content: o.done, is_error: false };
  return { content: o === "not_run" || o === "waiting" ? APPROVAL_CUT : o ? o.denied : RESTART_CUT, is_error: true };
};
// A call that waits on the owner and has done nothing yet: one whose approval
// card is open (Gate), a question, a plan put up for approval. A restart does
// not answer it: it keeps no result and waits on the same card afterwards.
const waitsOnOwner = (session: string, u: { id: string; name: string }) => asksOwner(u.name) || outcomeOf(session, u.id) === "waiting";
// A call a restart cut while its card was open has no result: the next turn
// runs it again on that card. These are such calls of the branch.
const owedCalls = (session: string, line: readonly StoredEvent[]): ToolUseBlock[] => unanswered(line).filter((b) => waitsOnOwner(session, b));
// Where a follow-up to a finished agent starts, as its sender stored it with
// the message (`follow_up` in the prompt's data, Engine.followUp): read from
// the prompts that open the turn now starting, so it holds across a restart
// and no other turn reads it. Its focus is the message.
export function followUpMark(line: readonly StoredEvent[]): { way: "carry" | "summary"; focus: string } | undefined {
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "turn_start" || e.kind === "note") continue;
    // A turn a restart cut, and the message that continues it, are not the opener.
    if (e.kind === "turn_end" && e.data.reason === "restart") continue;
    if (e.kind !== "user") return undefined;
    if (e.data.origin === "restart") continue;
    const w = e.data.follow_up;
    if (isWay(w) && w !== "capsule") return { way: w, focus: String(e.data.text ?? "").slice(0, 4_000) };
  }
  return undefined;
}

// The calls of the context the branch shows (from its last checkpoint) that
// have no result. A result is stored after its call, so one that answers a
// call of that part lies in that part too: nothing before the checkpoint is
// read, and a turn's start costs what its context holds, not what the
// session ever held.
export function unanswered(line: readonly StoredEvent[]): ToolUseBlock[] {
  const from = checkpointAt(line).keepFrom;
  const done = new Set<string>();
  const calls: ToolUseBlock[] = [];
  for (let i = from; i < line.length; i++) {
    const e = line[i]!;
    if (e.kind === "tool_result") for (const r of e.data.results) done.add(r.tool_use_id);
    else if (e.kind === "assistant") for (const b of e.data.blocks) if (b.type === "tool_use") calls.push(b);
  }
  return calls.filter((b) => !done.has(b.id));
}

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

// Whether the branch holds a restart message no reply came after: walked back from its end to the
// last reply, reading the body of a prompt alone.
export function unreadRestart(line: readonly StoredEvent[]): boolean {
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    if (e.kind === "assistant") return false;
    if (e.kind === "user" && e.data.origin === "restart") return true;
  }
  return false;
}

// What a call that names a tool the session does not have is answered with.
// When the attempt that answered a request was sent: a request that waited out
// an outage or retried was answered by its last attempt, which read or wrote the
// cache then, not when the first attempt went.
const answeredAt = new WeakMap<ProviderResult, number>();

export const noSuchTool = (name: string) => `No tool named ${name}.`;
export const isNoSuchTool = (content: unknown) => typeof content === "string" && /^No tool named .+\.$/.test(content);

// What the model is told about a tool call cut by the output limit.
export { CUT_CALL } from "../core/stops.ts";

// A reply cut by the output limit is continued this many times in a row, then
// the turn ends and says so.
export const MAX_CONTINUATIONS = 3;

// Rebuild the wire conversation from the stored events of one branch (oldest
// first). Pure: the same events always give the same bytes, so the provider's
// prefix cache holds across turns.
export function toMessages(events: readonly StoredEvent[]): Message[] {
  const cp = checkpointAt(events);
  const out: Message[] = [];
  // (The blocks made here of a stored body are made once per body: the same objects each request, src/core/message-facts.ts.)
  if (cp.at >= 0 && events[cp.at]!.data.mode === "summary") { const d = events[cp.at]!.data; out.push(derived(d, "summary", () => summaryMessage(d))); }
  for (let i = cp.keepFrom; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "compaction") {
      continue; // the checkpoint's summary leads (an older one in the tail is covered)
    } else if (e.kind === "user") {
      // An image sent without a caption has no text block (providers refuse an empty one).
      const content: any[] = [...(e.data.images ?? []), ...(e.data.text ? [derived(e.data, "text", () => ({ type: "text", text: e.data.text, ...(e.data.system === true && { system: true }) }))] : [])];
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
      out.push({ role: "user", content: [derived(e.data, "note", () => ({ type: "text", text: e.data.text, ...(e.data.system === true && { system: true }) }))] });
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
  // A call with no result was ended by its turn's stop: who stopped it is on that turn's end
  // (none named: the user's words, the bytes every earlier request sent).
  const stopperOf = new Map<string, string>();
  let by: string | undefined;
  for (let i = events.length - 1; i >= cp.keepFrom; i--) {
    const e = events[i]!;
    if (e.kind === "turn_end") by = e.data.reason === "interrupted" && typeof e.data.stopped_by === "string" ? e.data.stopped_by : undefined;
    else if (e.kind === "assistant" && by !== undefined) for (const b of e.data.blocks) if (b.type === "tool_use") stopperOf.set(b.id, by);
  }
  const interrupted = (id: string): ToolResultBlock => ({
    type: "tool_result", tool_use_id: id, content: stoppedBefore(stopperOf.get(id)), is_error: true,
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
// (else CLAUDE.md) of each folder from the home folder down to `cwd` (from
// the root, for a folder outside the home): the folders above the home are
// other accounts' and the system's, as the agents' walk stops there too
// (src/automation/agents.ts).
// A file linked from two places is one source: it is listed once, where it is
// met first from the root down (the owner's own file before a folder's).
// `marks`: every path looked for is noted with its mark on disk, before it is
// looked at (src/engine/instruction-marks.ts).
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
export function instructionPaths(cwd: string, marks?: Marks): { path: string; scope: "owner" | "parent" | "folder" }[] {
  const found: { path: string; scope: "owner" | "parent" | "folder" }[] = [];
  const seen = new Set<string>();
  for (let dir = cwd; !seen.has(dir); dir = dirname(dir)) {
    seen.add(dir);
    if (marks) for (const n of ["AGENTS.md", "CLAUDE.md"]) noteMark(marks, join(dir, n));
    const name = ["AGENTS.md", "CLAUDE.md"].find((n) => existsSync(join(dir, n))); // AGENTS.md wins in one folder
    if (name) found.unshift({ path: join(dir, name), scope: dir === cwd ? "folder" : "parent" });
    if (dirname(dir) === dir || dir === homeDir()) break;
  }
  const own = join(configDir(), "AGENTS.md");
  noteMark(marks, own);
  if (existsSync(own)) found.unshift({ path: own, scope: "owner" });
  const ids = new Set<string>();
  return found.filter((f) => !ids.has(real(f.path)) && !!ids.add(real(f.path)));
}

// A `@path` line of a file outside a repository brings that file in (up to
// 4 hops), as Claude Code reads its memory files. A repository's files keep
// the line as text: what they would import is not under their trust pin.
// `seen` holds the real paths already in the prompt: a file two others import
// comes in once, and the later line stays as the reference it is.
export function expandImports(text: string, from: string, depth = 0, seen = new Set([real(from)]), marks?: Marks): string {
  return expandMapped(text, from, depth, seen, marks).text;
}

// Where a line of an expanded text is on disk: each line of the result starts at `at`, and is line
// `line` of `path` (a file the first imports, or the first itself).
export type LineSource = { at: number; path: string; line: number };
export function expandMapped(text: string, from: string, depth = 0, seen = new Set([real(from)]), marks?: Marks): { text: string; lines: LineSource[] } {
  const lines: LineSource[] = [];
  const own = text.split("\n");
  if (depth >= 4) {
    let at = 0;
    own.forEach((l, i) => { lines.push({ at, path: from, line: i + 1 }); at += l.length + 1; });
    return { text, lines };
  }
  let out = "";
  own.forEach((line, i) => {
    if (i) out += "\n";
    // (A line of a CRLF file keeps its \r after what it brings in.)
    const cr = line.endsWith("\r") ? "\r" : "";
    const m = /^@(\S+)[ \t]*$/.exec(cr ? line.slice(0, -1) : line);
    const ref = m?.[1];
    const p = ref ? (ref.startsWith("~/") ? join(homeDir(), ref.slice(2)) : resolve(dirname(from), ref)) : "";
    if (ref && !seen.has(real(p)) && !rootOf(dirname(p)) && !heldFile(p)) {
      noteMark(marks, p);
      let t: string | undefined;
      try { t = readFileSync(p, "utf8"); } catch {}
      if (t !== undefined) {
        seen.add(real(p));
        const r = expandMapped(t, p, depth + 1, seen, marks);
        const kept = r.text.trimEnd();
        for (const x of r.lines) if (x.at < kept.length || (x.at === 0 && !kept.length)) lines.push({ ...x, at: out.length + x.at });
        out += kept + cr;
        return;
      }
    }
    lines.push({ at: out.length, path: from, line: i + 1 });
    out += line;
  });
  return { text: out, lines };
}

// How much of one instruction file the prompt, or a call's result, carries: Claude Code's
// (code.claude.com/docs/en/memory, the per-file limit of files that load on demand) is 40,000
// characters on a 200K window and 150,000 on a 1M window. Between the two it grows in a line; a
// smaller window gets its share of 40,000, never under 8,000 (a few pages of rules); a window
// nobody stated counts as 200K.
export function instructionLimit(window?: number): number {
  const w = window && window > 0 ? window : 200_000;
  if (w <= 200_000) return Math.max(8_000, Math.round((40_000 * w) / 200_000));
  if (w >= 1_000_000) return 150_000;
  return Math.round(40_000 + ((w - 200_000) * 110_000) / 800_000);
}

// A file past the limit: its start, cut at a line end where one is near, then a line that says
// it was cut and where the rest starts, for the model to read it (as Claude Code's note does).
// The line is the one on disk: `lines` maps a text with its imports brought in (expandMapped) to
// the file each part is from; `lines: null` says the text is not what the file holds now (the
// version the owner last trusted), so no line of the file is named.
export function cutInstructions(path: string, text: string, limit: number, lines?: LineSource[] | null): string {
  if (text.length <= limit) return text;
  const nl = text.lastIndexOf("\n", limit);
  const at = nl >= limit / 2 ? nl + 1 : limit;
  const kept = text.slice(0, at);
  const said = `(Cut here: this is ${at.toLocaleString("en-US")} of the file's ${text.length.toLocaleString("en-US")} characters, as much as fits this model's window. Its later instructions are not in your context.`;
  let where: string;
  if (lines === null) where = `What is here is the version the owner last trusted, and ${path} has changed since, so read it only as far as he trusts it.`;
  else {
    // The line the rest starts on: the next one after a whole line, else the line the cut is in.
    const src = lines?.length ? lines.findLast((x) => x.at <= at) ?? lines[0]! : { at: 0, path, line: 1 };
    const line = src.line + (text.slice(src.at, at).split("\n").length - 1);
    where = src.path === path
      ? `Read ${path} from line ${line} with the Read tool before you work on what they may cover.`
      : `Read ${src.path} from line ${line} with the Read tool (${path} imports it), and then the rest of ${path} after the line that imports it, before you work on what they may cover.`;
  }
  return `${kept.trimEnd()}\n\n${said} ${where})`;
}

// `window`: the context window of the model the prompt is for, in tokens (instructionLimit).
// `marks`: each file's mark on disk, noted before it is read (src/engine/instruction-marks.ts).
export function instructionFiles(cwd: string, window?: number, marks?: Marks): string {
  const limit = instructionLimit(window);
  const parts: string[] = [];
  const files = instructionPaths(cwd, marks);
  const seen = new Set(files.map((f) => real(f.path)));
  for (const { path: p } of files) {
    let read: string;
    try {
      const held = heldFile(p);
      if (held) throw new Error(held);
      read = readFileSync(p, "utf8");
    } catch (e) {
      // Not left out silently: the model knows a source is missing, not removed.
      parts.push(`# ${p}\n\n(This file could not be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}. Its instructions are not loaded.)`);
      continue;
    }
    const mapped = rootOf(dirname(p)) ? undefined : expandMapped(read, p, 0, seen, marks);
    const raw = mapped?.text ?? read;
    const text = instructionFilter.file ? instructionFilter.file(p, raw) : raw;
    if (text !== null) parts.push(`# ${p}\n\n${cutInstructions(p, text, limit, text !== raw ? null : mapped?.lines)}`);
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
function sessionParts(cwd: string, created: number, window?: number, marks?: Marks): PromptPart[] {
  const inst = instructionFiles(cwd, window, marks);
  const place = `Working directory: ${cwd}\nPlatform: ${process.platform}. Session started ${new Date(created).toISOString().slice(0, 10)}.\n`;
  return [{ name: "place", text: place, data: place }, { name: "instruction files", text: inst ? `\nInstructions from the owner's files:\n\n${inst}` : "", data: inst }];
}

type Running = { abort: AbortController; done: Promise<void>; providerWaiting?: boolean; providerWaitMs?: number };
// `native`: the request carries deferred tools (src/tools/defer.ts), refreshed per request.
// A transcript request the provider refused as too long is built again at
// these shares of the room (OpenCode's ladder), then the failure stands.
const SHRINK_STEPS = [1, 0.7, 0.5, 0.35];
// A part never gets smaller than this, however small the window.
const MIN_PART_BYTES = 2_000;
// Room planned in each part's request for the summary of the parts before it:
// what the model can write in one reply, at most a quarter of the window.
const SUMMARY_ROOM_BYTES = (st: Step) => Math.floor(Math.min(st.info.output, st.info.context / 4) * bytesPerToken(st.info.id));

// What a compaction by price keeps of its decision on its event: what the
// steps ahead were expected to read less and what the summary cost (dollars),
// the steps priced, where their forecast came from, and the context it keeps.
const priceData = (p: PriceVerdict & { ahead: Residual; delay: number; keep: number }) => ({
  save_usd: Math.round(p.save * 1e4) / 1e4, cost_usd: Math.round(p.cost * 1e4) / 1e4, steps: Math.round(p.steps * 10) / 10,
  from: p.ahead.from, comparable: p.ahead.n, delay: p.delay, keep_tokens: Math.round(p.keep), gap_tokens: p.gap, best_gap_tokens: p.best_gap,
});

// A summary cut at the output limit, or one too long to go with the next part
// of a transcript, is asked for again this many times: each request of a
// compaction (the one summary, or each part) has that many of its own. Then
// the compaction fails and nothing is checkpointed: the branch stays as it was.
const SUMMARY_RETRIES = 2;
// What the owner can do when a summary cannot be written whole.
const SUMMARY_REMEDIES = "compact with a focus that asks for less, switch to a model that writes longer replies, or clear the context";
// The model's steps since the branch's last checkpoint (a summary's backoff counts in them).
const stepsSince = (events: readonly StoredEvent[]): number => {
  let n = 0;
  for (let i = events.length - 1; i >= 0 && events[i]!.kind !== "compaction"; i--) if (events[i]!.kind === "assistant") n++;
  return n;
};
// The failures of a summary that end the same way on the same context: remembered (Engine.gaveUp).
const SUMMARY_GAVE_UP = new Set(["summary_truncated", "summary_too_long", "summary_no_room"]);
// A turn that ended with one of these before any request did so because its
// context cannot be sent: the prompt that opened it got no answer (Engine.unanswered).
const NOT_SENT = new Set([...SUMMARY_GAVE_UP, "context_over_window"]);

type Step = { provider: Provider; info: ModelInfo; tools: Tool[]; system: string; systemSplit: number; systemOwn?: number; effort?: string; native?: boolean };
// A session's system prompt as a request carries it: the text, where the part
// its folder's sessions share starts (`split`) and where its own part starts
// (`own`), and the blocks it is made of (absent for one kept before they were).
type System = { text: string; split: number; own?: number; blocks?: PromptBlock[] };

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

// What a request streamed so far, by block: the stop keeps the whole items (src/engine/turn.ts).
export type Streamed = Map<number, { kind: string; text: string; name?: string; done?: boolean }>;
// The items of a reply a stop keeps: its text, and each tool call whose input is whole (the stream
// moved on from it, or its input is a complete object) and that the model has. Thinking is dropped
// (it has no signature yet); a call cut mid-input is discarded.
export function streamedItems(partial: Streamed, tools: string[]): (AssistantBlock & { type: "text" | "tool_use" })[] {
  const out: (AssistantBlock & { type: "text" | "tool_use" })[] = [];
  for (const [, p] of [...partial.entries()].sort(([a], [b]) => a - b)) {
    if (p.kind === "text") { if (p.text.trim()) out.push({ type: "text", text: p.text }); continue; }
    if (p.kind !== "tool_input" || !p.name || !tools.includes(p.name)) continue;
    const raw = p.text.trim(), input = raw ? parseJsonObject(raw) : p.done ? {} : undefined;
    if (input !== undefined) out.push({ type: "tool_use", id: `call_${Bun.randomUUIDv7().replace(/-/g, "")}`, name: p.name, input });
  }
  return out;
}
const parseJsonObject = (s: string): Record<string, unknown> | undefined => {
  try { const v = JSON.parse(s); return v && typeof v === "object" && !Array.isArray(v) ? v : undefined; } catch { return undefined; }
};

const abortError = () => Object.assign(new Error("interrupted"), { name: "AbortError" });

// What became of an input: stored as the session's prompt (`event`), kept in
// its queue (`queued`, as a steer or not), or not stored again (`duplicate`:
// its sender's key was seen before).
// `held`: it is in the queue under a hold its sender may not release (the
// owner stopped the session): nothing starts until the owner resumes it.
export type Sent = { event?: StoredEvent; queued?: QueueItem; steer?: boolean; duplicate?: boolean; held?: boolean };

// A turn's request that leaves an overloaded model for the session's fallback (retry.ts
// movesToFallback): the turn goes on on `step` for the rest of that turn.
class MovedToFallback extends Error {
  constructor(readonly step: Step, readonly why: MoveWhy, readonly overloadedMs: number, cause: unknown) {
    super(`moved to ${step.info.id}`, { cause });
    this.name = "MovedToFallback";
  }
}

// A request of an agent that leaves the route that is out for the model the owner's rule names
// (src/engine/route-change.ts): the agent goes on on `step` and stays there.
class MovedByRule extends Error {
  constructor(readonly step: Step, readonly why: RouteWhy, readonly ms: number, cause: unknown, readonly extra?: number) {
    super(`moved to ${step.info.id} by the owner's rule`, { cause });
    this.name = "MovedByRule";
  }
}

// A prompt in the owner's own words: typed, steered, queued or said by the owner, with nothing that
// marks it as another sender's (a harness input, an agent's task, another session's message).
const OWNER_ORIGINS = new Set([undefined, "owner", "steer", "queued", "voice"]);
const ownerWords = (d: any) => !!d && OWNER_ORIGINS.has(d.origin) && !d.kind && !d.from && !d.agent_id && !(typeof d.text === "string" && d.text.startsWith("[harness]"));

export class Engine {
  private running = new Map<string, Running>();
  // Whether a page shows the session now (the app sets it: a socket names the session's stream).
  // Its requests go before agents' in the account's line (src/providers/admission.ts).
  viewed?: (id: string) => boolean;
  // Each model that answers overloaded, across the daemon's sessions: the first such answer of
  // the overload going on, and the last. An answer of the model ends it, and so does a quiet of
  // OUTAGE.flapMs (an overload after that is another one, as an outage's is).
  private busyModels = new Map<string, { since: number; last: number }>();
  // The unspent retry budget of a request parked in an outage, for its first
  // call on the same route and purpose in the continued turn.
  private resumedProviderRetry = new Map<string, { model: string; purpose: "turn" | "summary"; spent: number }>();
  // When the model first answered overloaded to a request a daemon stop parked, for the same
  // model's first request in the continued turn: the owner's rule counts its minutes from there.
  private resumedBusy = new Map<string, { model: string; since: number }>();
  // The turn_start event of each running turn, from its first event to its end.
  private turns = new Map<string, string>();
  // Sessions whose queue a stop holds: stored, so the hold (and its Resume)
  // outlives a daemon restart; only an action that releases it clears it.
  // With who made it (the `by` of the stop: "owner", "parent", ...), when it
  // was said: a hold nobody named is the owner's.
  private held: Map<string, string | null>;
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
  // Who asked a running turn to stop (a word of src/core/stoppers.ts), kept on its turn_end. A turn
  // ends as interrupted only through interrupt(), so every such end has one.
  private stoppedBy = new Map<string, string>();
  // Sessions another program runs and Keel only records (the children an ACP agent announces): no input reaches them
  // through `send` or `message`, which refuse with the module's words. A module adds its check by its name.
  readonly inputRefusals = new Map<string, (id: string) => string | undefined>();
  inputRefused(id: string): string | undefined {
    for (const refuse of this.inputRefusals.values()) {
      const why = refuse(id);
      if (why) return why;
    }
    return undefined;
  }
  private refuseInput(id: string) {
    const why = this.inputRefused(id);
    if (why) throw Object.assign(new Error(why), { status: 409 });
  }
  // Sessions whose running turn is being stopped so that the owner's own message is the next one
  // (a prompt they edited, a queued prompt they sent now): until that turn has started, nothing
  // else starts one there (the queue's next row, a wake, a report).
  private replacing = new Map<string, number>();
  // Sessions whose accepted prompt is still being set up for its turn, and
  // those of them a stop has already closed (interrupt).
  private setting = new Set<string>();
  private stoppedEarly = new Set<string>();
  // What a finished call left for the transcript (ToolOutput.shown), until its step is stored.
  private shown = new Map<string, unknown>();
  // What the gate's rules decided of a call (ToolCall.ruled), until its result is stored with it.
  private ruled = new Map<string, Ruled>();
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
  // Tools fitted to the wire each request goes on (src/engine/tool-fit.ts).
  private toolFit: ToolFit;
  private rendering = new Map<string, Promise<System>>();
  // Sessions whose kept prompt was compared with a fresh render in this run,
  // and sessions that moved (their next request renders for the new place).
  private checked = new Set<string>();
  private moved = new Set<string>();
  // The marks on disk of the instruction files each session's last render read
  // or looked for (src/engine/instruction-marks.ts). One that dropped out has
  // the prompt rendered and compared again at the session's next request.
  private marks = new SessionMap<Marks>(1024);
  // The newest render of a session's prompt while its kept one stays sent: a
  // change of the owner's side is told at the tail until it is folded in
  // (src/engine/prompt-note.ts).
  private fresh = new SessionMap<Rendered>(256);
  // Subagents on this machine that send their own copy of their parent's
  // earlier prompt, while their own cache holds it: when the copy was made.
  private diverged = new Map<string, number>();
  // Sessions whose prompt is made again because they take this build's at a
  // cold moment, not because they moved.
  private adopting = new Set<string>();

  constructor(
    private store: Store,
    private bus: Bus,
    private providers: Providers,
    private errors: ErrorTracker,
    private spillRoot: string,
  ) {
    this.prompts = new PromptStore(store);
    this.pins = new BuildPins(store);
    this.toolFit = new ToolFit(store, (e, context) => this.errors.capture("provider", e, context));
    this.cachePlans = new CachePlans({
      store, errors,
      append: (id, kind, data) => this.append(id, kind, data),
      isRunning: (id) => this.running.has(id),
      isHeld: (id) => this.held.has(id),
      draining: () => this.draining,
      waitShape: (id) => this.waitShape?.(id),
      replan: (id) => {
        const s = this.store.session(id);
        if (s && !this.running.has(id)) void this.step(s, s.model).then((st) => { if (!this.running.has(id)) this.planPark(this.store.session(id) ?? s, st); })
          .catch((e) => this.errors.capture("provider", e, { session: id, at: "cache plan after a model switch" }));
      },
      call: async (id, st, messages, signal, tokens) => {
        const res = await this.call(id, st as Step, messages, signal, new Map(), this.store.session(id)!, true, "warm", { tokens, base: messages });
        // Counted with the session's usage, without moving it in the list: a warm read is not work
        // (and a session moved as recent would be planned again by every start: resumeIdle).
        this.store.addUsage(id, res.usage, { keepPlace: true });
        this.emitSession(id);
        return res;
      },
      prepare: (id, st) => this.prepare(id, st as Step, true),
    });
    registerPinnedDeferred((id) => this.pins.deferred(id));
    // A summary prepared ahead survives a restart.
    store.migrate("CREATE TABLE IF NOT EXISTS prepared_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, covered TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)");
    // What idle compaction knows of each session's context, so a daemon that starts reads no events for it (resumeIdle).
    store.migrate("CREATE TABLE IF NOT EXISTS idle_facts (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, head TEXT, model TEXT NOT NULL, wire TEXT NOT NULL, used INTEGER NOT NULL, warm INTEGER NOT NULL, sure INTEGER NOT NULL, max INTEGER NOT NULL)");
    store.migrate("CREATE TABLE IF NOT EXISTS queue_holds (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)");
    if (!store.columnExists("queue_holds", "by")) store.migrate("ALTER TABLE queue_holds ADD COLUMN by TEXT");
    this.held = new Map(store.db.query<{ session_id: string; by: string | null }, []>("SELECT session_id, by FROM queue_holds").all().map((r) => [r.session_id, r.by]));
    store.migrate("CREATE TABLE IF NOT EXISTS queue_owed (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)");
    this.owed = new Set(store.db.query<{ session_id: string }, []>("SELECT session_id FROM queue_owed").all().map((r) => r.session_id));
    // The inputs a sender named with a key of its own: each is stored once (claim).
    store.migrate("CREATE TABLE IF NOT EXISTS input_keys (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL, ts INTEGER NOT NULL, fp TEXT, PRIMARY KEY (session_id, key)) WITHOUT ROWID");
    if (!store.columnExists("input_keys", "fp")) store.migrate("ALTER TABLE input_keys ADD COLUMN fp TEXT");
    store.migrate("CREATE INDEX IF NOT EXISTS input_keys_ts ON input_keys(ts)");
    // What a deleted session never read of what others sent it is told to them.
    store.queueGone = (rows, session) => this.dropped(rows, "deleted", session);
    // Each model's bytes a token, learned from what its provider counted.
    store.migrate("CREATE TABLE IF NOT EXISTS token_ratios (model TEXT PRIMARY KEY, ratio REAL NOT NULL, ts INTEGER NOT NULL)");
    for (const r of store.db.query<{ model: string; ratio: number }, []>("SELECT model, ratio FROM token_ratios").all()) { setRatio(r.model, r.ratio); this.ratioKept.set(r.model, r.ratio); }
    // A session that changed (another branch shown, archived, cleared, deleted)
    // may have made the summary being prepared for it obsolete.
    bus.on((f) => { if (f.t === "session") this.dropObsolete(f.session.id); });
  }

  // `by`: who stops it. The owner's hold (named so, or by nobody) stays the
  // owner's. Another maker's stays its first maker's, and becomes the owner's
  // when the owner stops the session too.
  private hold(id: string, by?: string) {
    const maker = by ?? null;
    if (this.held.has(id)) {
      const had = this.held.get(id);
      if (!had || had === "owner" || had === maker || (maker && maker !== "owner")) return;
    }
    this.setHold(id, maker);
  }

  private setHold(id: string, by: string | null) {
    this.held.set(id, by);
    this.cachePlans.end(id, "held"); // nothing is sent for a session that is held
    // (Owed when the store takes no writes: a stop holds the queue in memory at once.)
    this.store.sqlOrLater("hold", [id, by], "a stop's hold on the queue");
  }

  // Who made the session's hold, as far as it is known: the stop that made it
  // said so, or (a hold from before that was kept) the last turn's stop did.
  heldBy(id: string): string | undefined {
    if (!this.held.has(id)) return undefined;
    const by = this.held.get(id);
    if (by) return by;
    const end = this.lineage(id).findLast((e) => e.kind === "turn_end");
    return end?.data.reason === "interrupted" && typeof end.data.stopped_by === "string" ? end.data.stopped_by : undefined;
  }

  // A stop of a session with no turn running (an agent stopped while it waits):
  // its queue is held as a stop of a running turn holds it.
  holdQueue(id: string, by?: string) {
    this.hold(id, by);
    this.emitQueue(id);
  }

  // The hold goes when one of `makers` made it. True when the queue is not held after this.
  releaseHold(id: string, makers: readonly string[]): boolean {
    if (!this.held.has(id)) return true;
    const by = this.heldBy(id);
    if (!by || !makers.includes(by)) return false;
    this.release(id);
    return true;
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

  // How many prompts wait in each session, as the owner sees them.
  queuedCounts(): Map<string, number> {
    return this.store.queueCounts(this.sending);
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

  // The sessions with a turn running now, from what the engine holds (no read of the store).
  runningIds(): string[] {
    return [...this.running.keys()];
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

  // Sessions the owner is archiving or deleting right now. Their commands are stopped first, which
  // takes seconds, and what comes due meanwhile (a command's end, a report, a wait) starts no turn
  // in a session that is about to be gone: whoever delivers it keeps it back (src/automation/core.ts)
  // and is told when the session stays after all (the closingOver hook).
  private closing = new Set<string>();
  isClosing(id: string) {
    return this.closing.has(id);
  }
  async whileClosing<T>(ids: string[], work: () => Promise<T>): Promise<T> {
    const mine = ids.filter((id) => !this.closing.has(id));
    for (const id of mine) this.closing.add(id);
    try { return await work(); } finally {
      for (const id of mine) this.closing.delete(id);
      for (const id of mine) for (const h of allHooks()) try { h.closingOver?.(id); } catch (e) { this.errors.capture("server", e, { hook: "closingOver", session: id }); }
    }
  }

  // The session's frozen system prompt is made again at its next turn. It
  // moved to another directory or machine: the cache prefix is rebuilt once.
  // Not moved (`moved` false: its project's instructions changed): it is
  // compared again, and a change of the owner's side is told at the tail.
  forgetSystem(id: string, moved = true) {
    this.systems.delete(id);
    this.adopting.delete(id);
    if (moved) this.moved.add(id);
    else this.checked.delete(id);
  }

  // The session whose prompt this one's requests carry: itself, or for a
  // subagent on this machine its top session.
  private promptHolder(session: Session): Session | undefined {
    for (let x: Session | undefined = session, hops = 0; x && hops < 32; hops++) {
      if (!x.parent_id || x.machine) return x;
      x = this.store.session(x.parent_id);
    }
    return undefined;
  }

  // Whether an instruction file of the prompt the session's requests carry was
  // edited, made or deleted since that prompt was rendered: a stat of each file
  // the render read or looked for, before each request of a turn. When one
  // was, the prompt is rendered and compared again as at a daemon start: a
  // change of the owner's side is told at the tail while a warm cache holds the
  // context, and taken into the prompt when it is cold (loadSystem). True when
  // the session's own prompt was forgotten and its step is to be made again;
  // a subagent riding its top session's prompt has that one rendered here, and
  // is told by the note (tellPrompt).
  private async instructionsEdited(session: Session, info: ModelInfo): Promise<boolean> {
    const top = this.promptHolder(session);
    if (!top || !this.checked.has(top.id) || this.rendering.has(top.id)) return false;
    const marks = this.marks.get(top.id);
    if (marks && editedPath(marks) === undefined) return false;
    this.forgetSystem(top.id, false);
    if (top.id === session.id) return true;
    await this.systemOf(top, info, false);
    return false;
  }

  // The prompt the session holds is not the one this step was made with: a
  // request of one of its subagents rendered it again and took a change.
  private heldElsewhere(id: string, st: Step): boolean {
    const held = this.systems.get(id);
    return !!held && held.text !== st.system;
  }

  // The branch the session shows, oldest first. The store keeps it (walked
  // once, grown by each appended event), so the loop's many reads of one step
  // do not rebuild the tree; the array is shared and read-only.
  lineage(id: string): readonly StoredEvent[] {
    return this.store.lineage(id);
  }

  // The turn that runs was started, or steered into, by the owner's own words (not a loop, a wake,
  // a report or an agent): read back from the end to the last turn's end.
  byOwner(id: string): boolean {
    const line = this.lineage(id);
    // A turn a restart cut and the continued one are one turn: past the restart message the
    // end of the cut turn does not end the search, whoever started that turn counts.
    let continued = false;
    for (let i = line.length - 1; i >= 0; i--) {
      const e = line[i]!;
      if (e.kind === "turn_end") {
        if (continued && e.data.reason === "restart") { continued = false; continue; }
        return false;
      }
      if (e.kind === "user" && e.data.origin === "restart") continued = true;
      if (e.kind === "user" && ownerPrompt(e.data)) return true;
    }
    return false;
  }

  // Stop the running turn: the model stream and running tools are cut, and
  // steers that did not reach the turn become ordinary queued prompts.
  // `by`: who stops it, a word of src/core/stoppers.ts. Every caller says one:
  // the turn's end keeps it, and what follows from the stop is read from it.
  // Only the owner's own Stop holds the queue as theirs (nothing starts by
  // itself until the owner sends or resumes); the stop of an agent by its side
  // and a move of the session keep it waiting for their own time (holds).
  // The first stop names the turn's end; the owner's Stop after another's does.
  async interrupt(id: string, by: string) {
    const r = this.running.get(id);
    if (!r) {
      // No turn: the owner's compaction, if one is being written, is what the stop is for.
      const c = this.compacting.get(id);
      if (c && !c.abort.signal.aborted) { c.by = by; c.abort.abort(); }
      return;
    }
    if (!this.stoppedEarly.has(id) && (!this.stoppedBy.has(id) || ownerStop(by))) this.stoppedBy.set(id, by);
    // A stop always stops: what it writes besides (the hold on the queue,
    // the turn's end) is owed when the store takes no writes, and the turn
    // is aborted whatever becomes of those.
    // (Each is owed with its record: a restart of the daemon keeps the stop: Store.orLater.)
    const owed = (write: () => void) => { try { write(); } catch (e) { this.errors.capture("server", e, { session: id, at: "interrupt" }); } };
    if (holds(by)) owed(() => this.hold(id, by));
    // Stopped while its provider and system prompt are still set up: the turn
    // is closed as stopped here, at once and in one write, not when the setup
    // settles. A daemon killed in between then finds a stopped turn with its
    // Continue, not a prompt it still owes a turn (closeCut).
    if (this.setting.has(id) && !this.stoppedEarly.has(id)) {
      const session = this.store.session(id);
      if (session) {
        this.stoppedEarly.add(id);
        const who = this.stoppedBy.get(id) ?? by;
        this.stoppedBy.delete(id);
        owed(() => {
          const at = Date.now(), ids = [Bun.randomUUIDv7(), Bun.randomUUIDv7()] as const;
          const start = { model: session.model }, end = { reason: "interrupted", usage: emptyUsage(), ms: 0, stopped_by: who };
          this.store.orLater("a stopped turn's start and end", () => {
            const closing = this.store.atomic(id, () => [this.store.append(id, "turn_start", start, undefined, at, ids[0]), this.store.append(id, "turn_end", end, undefined, at, ids[1])]);
            for (const e of closing) this.emitEvent(e);
          }, [{ op: "event", id: ids[0], session: id, kind: "turn_start", data: start, at }, { op: "event", id: ids[1], session: id, kind: "turn_end", data: end, at }]);
        });
      }
    }
    r.abort.abort();
    await r.done;
    owed(() => void this.store.sqlOrLater("unsteer", [id], "the queue after a stop"));
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

  // The writes into a session whose work another program runs and Keel only records (the children an ACP agent
  // announces): its events and its streamed text, with no turn of Keel's behind them (so no working mark either:
  // a daemon that goes down closes the marked sessions' turns and goes on with them).
  passive(id: string): { append(kind: StoredEvent["kind"], data: unknown): StoredEvent; delta(kind: "text" | "thinking", index: number, text: string): void; status(s: TurnStatus): void } {
    return {
      append: (kind, data) => { this.deltas.end(id); return this.append(id, kind, data); },
      delta: (kind, index, text) => this.deltas.push(id, { kind, index, text }),
      status: (s) => this.status(id, s),
    };
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

  // The outage of its provider the session's turn waits in (src/providers/outage.ts).
  outageOf(id: string) {
    return this.providers.outages?.of(id);
  }

  // When the reply being streamed last gave output; undefined between requests.
  private outputs = new Map<string, number>();
  // A stream's text is joined for a moment before it is sent on as a frame (src/engine/deltas.ts).
  readonly deltas = new DeltaJoin((session, d) => this.bus.emit({ t: "delta", session_id: session, ...d }));
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
    if (s && !s.title) this.bus.emit({ t: "session", session: this.store.updateSession(id, { title: firstLineTitle(text), title_by: "prompt" }) });
  }

  // Sessions whose title a small model is writing now, and those where no
  // choice gave one: they keep the title they have until the daemon starts
  // again (a request a turn after another would fail the same way).
  // `untitled`: no model could be asked at all (kept until the daemon starts again). `titleFails`: the
  // requests that failed, per session: one failure (a provider down for a minute) must not cost the
  // session its title, so the next turn ends ask again, TITLE_TRIES times in all, then the session keeps
  // the words it has (a failure that repeats, a spend limit or a refusal, is not asked at every turn end).
  private titling = new Set<string>();
  private untitled = new Set<string>();
  private titleFails = new Map<string, number>();
  // Bumped when the session's task changes under a title request (an edit of
  // the first prompt): that request's title is not saved, and one is asked
  // for the new prompt once its reply is in.
  private titleGen = new Map<string, number>();

  // After a turn's end: the title a small model writes, when one is owed
  // (src/engine/title.ts). Off the turn: nothing waits for it, it is no part of
  // any turn's prefix, and a failure keeps the title the session had. An
  // agent's session keeps the name its parent gave it.
  private retitle(id: string) {
    let s = this.store.session(id);
    if (!s || s.parent_id || s.archived) return;
    // A title a model, the owner or the session's maker gave owes nothing (no read of the history for it).
    if (s.title && s.title_by !== "prompt" && s.title_by !== "start") return;
    const line = this.lineage(id);
    // A session that reads "New session" with the owner's words in it (their first prompt reached the history
    // by a way `send` does not title: a queued one) gets the first prompt's line at once. An empty title is
    // never one the owner gave.
    if (!s.title) {
      const first = ownerPrompts(line)[0];
      if (first) {
        s = this.store.updateSession(id, { title: firstLineTitle(first), title_by: "prompt" });
        this.bus.emit({ t: "session", session: s });
      }
    }
    if (this.titling.has(id) || this.untitled.has(id) || (this.titleFails.get(id) ?? 0) >= TITLE_TRIES || !modelTitles()) return;
    if (!titleOwed(s.title_by, line)) return;
    this.titling.add(id);
    const gen = this.titleGen.get(id) ?? 0;
    void this.writeTitle(id, s, line, gen)
      .catch((e) => { this.titleFails.set(id, (this.titleFails.get(id) ?? 0) + 1); this.errors.capture("provider", e, { session: id, at: "title" }); })
      .finally(() => {
        this.titling.delete(id);
        // The task changed meanwhile and its reply may be in already: its title is owed now.
        if ((this.titleGen.get(id) ?? 0) !== gen && !this.running.has(id)) this.retitle(id);
      });
  }

  // A session an import made: its exchange exists already, so its title is not waited for. A title that is
  // only the source's first prompt (or none) becomes the first prompt's line and a model writes the real
  // one now; a title the source gave (its own name, its AI title) is left as it is.
  adoptImport(id: string) {
    const s = this.store.session(id);
    if (!s || s.parent_id || s.title_by) return;
    const first = ownerPrompts(this.lineage(id))[0];
    if (!first || !derivedTitle(s.title, first)) return;
    this.bus.emit({ t: "session", session: this.store.updateSession(id, { ...(s.title ? {} : { title: firstLineTitle(first) }), title_by: "prompt" }) });
    this.retitle(id);
  }

  // The candidates of a choice whose provider the session's folder allows, in their order. The
  // ones left out ahead of the first one kept would have been asked: each is said once (an allowed
  // one takes its place). With none left the work is done without, and the session's model hears of it.
  private allowedModels<T extends ModelInfo>(id: string, purpose: RoutePurpose, list: T[]): T[] {
    const a = routeOf(this.store, id);
    const kept = allowedOnly(a, list);
    if (kept.length === list.length) return kept;
    const s = this.store.session(id);
    for (const m of list) {
      if (kept.includes(m)) break;
      sayCrossing(s, crossingIn(a, purpose, m.id, m.provider)!, !kept.length);
    }
    return kept;
  }

  // The small models a request of the session's tree reads through first: the owner's, with the model the
  // tree is trying in this role (src/engine/model-trial.ts) ahead of them.
  private ownSmall(id: string, role: "reader" | "small"): string[] {
    const t = trialModel(role, this.store.session(id), (x) => this.store.session(x));
    return t ? [t, ...smallModels().filter((x) => x !== t)] : smallModels();
  }

  // One request for the title, through the owner's small models in order (the
  // readers' choices: src/engine/reader.ts), each at its lowest effort. The
  // title is saved only if nobody renamed the session meanwhile.
  private writeTitle(id: string, s: Session, line: readonly StoredEvent[], gen: number): Promise<void> {
    return during("task", () => this.writeTitleOf(id, s, line, gen), "a session title");
  }
  private async writeTitleOf(id: string, s: Session, line: readonly StoredEvent[], gen: number) {
    const prompts = ownerPrompts(line);
    // (The owner's prompts and the model's reply: their own words, src/safety/secrets.ts Words.)
    const prompt = conceal(titlePrompt(prompts, firstReply(line)), id, "own");
    const [models, cur] = await Promise.all([this.providers.models(), this.providers.resolve(s.model).then((r) => r.info)]);
    // The session's own model is a reader's last choice, never a title's (unless the owner named it a
    // small model): a title is not worth a request at the working model's price. With no other
    // choice the session keeps its first prompt's words.
    const own = this.ownSmall(id, "small");
    const named = [...own, process.env.KEEL_READER_MODEL];
    const choices = this.allowedModels(id, "title", readerChoices(models, cur, Math.ceil(prompt.length / bytesPerToken(cur.id)) + TITLE_OUTPUT, process.env, (m) => this.providers.catalog?.lookup(m.model)?.price, own)
      .filter((m) => m.id !== cur.id || named.includes(m.id)));
    // No choice now is no choice at the next turn's end either: not looked for again until a start.
    if (!choices.length) { this.untitled.add(id); return; }
    let last: unknown;
    for (const m of choices) {
      try {
        const { provider, info } = await this.providers.resolve(m.id);
        const effort = ["none", "minimal", "low"].find((e) => info.efforts.includes(e));
        const st: Step = { provider, info: { ...info, output: Math.min(info.output || TITLE_OUTPUT, TITLE_OUTPUT) }, tools: [], system: TITLE_SYSTEM, systemSplit: 0, effort };
        const res = await this.call(id, st, [{ role: "user", content: [{ type: "text", text: prompt }] }], AbortSignal.timeout(60_000), new Map(), s, true, "title");
        this.store.addUsage(id, res.usage);
        const title = cleanTitle(res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n"));
        if (!title || res.stop === "refusal") throw new Error(`the title model (${info.name}) ${res.stop === "refusal" ? "refused" : "gave no title"}`);
        const now = this.store.session(id);
        if (!now || now.title !== s.title || now.title_by !== s.title_by || (this.titleGen.get(id) ?? 0) !== gen) return;
        const by = s.title_by === "prompt" && weakStart(prompts[0] ?? "") ? "start" : "model";
        this.bus.emit({ t: "session", session: this.store.updateSession(id, { title, title_by: by }) });
        return;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw last;
  }

  // A declined task's brief restated (src/automation/successor.ts): one
  // request with the task alone, through the owner's small models in order,
  // the successor's model last. Counted on the session `id`. Undefined when no
  // model gave a brief that holds (each failure is captured once).
  async reword(id: string, model: string, task: string, signal: AbortSignal): Promise<{ text: string; model: string } | undefined> {
    const cur = await this.providers.resolve(model).then((r) => r.info);
    const out = Math.min(READER_OUTPUT, Math.ceil((task.length * 2) / bytesPerToken(cur.id)) + 256);
    return this.small(id, model, { system: REWORD_SYSTEM, prompt: rewordPrompt(task), out, signal, at: "successor reword", holds: (text) => rewordHolds(task, text) });
  }

  // One request with no tools, through the owner's small models in order (the
  // readers' choices: src/engine/reader.ts), the model `model` last, each at its
  // lowest effort. Counted on the session `id`. The first answer that `holds`
  // is taken; undefined when none did (each failure is captured once, under `at`).
  async small(id: string, model: string, o: { system: string; prompt: string; out: number; signal: AbortSignal; at: string; holds: (text: string) => boolean }): Promise<{ text: string; model: string } | undefined> {
    const [models, cur] = await Promise.all([this.providers.models(), this.providers.resolve(model).then((r) => r.info)]);
    const choices = this.allowedModels(id, "reader", readerChoices(models, cur, Math.ceil(o.prompt.length / bytesPerToken(cur.id)) + o.out, process.env, (m) => this.providers.catalog?.lookup(m.model)?.price, this.ownSmall(id, "small")));
    const s = this.store.session(id);
    if (!s) return undefined;
    for (const m of choices) {
      if (o.signal.aborted) return undefined;
      // (A route out of credit or signed out would refuse at once.)
      if (this.providers.shut(m.id)) continue;
      try {
        const { provider, info } = await this.providers.resolve(m.id);
        const effort = ["none", "minimal", "low"].find((e) => info.efforts.includes(e));
        const st: Step = { provider, info: { ...info, output: Math.min(info.output || o.out, o.out) }, tools: [], system: o.system, systemSplit: 0, effort };
        const res = await this.call(id, st, [{ role: "user", content: [{ type: "text", text: o.prompt }] }], o.signal, new Map(), s, true, "reader");
        this.store.addUsage(id, res.usage);
        const text = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        if (res.stop === "refusal" || res.stop === "max_tokens" || !o.holds(text)) continue;
        return { text, model: info.id };
      } catch (e) {
        if (!o.signal.aborted) this.errors.capture("provider", e, { session: id, at: o.at, model: m.id });
      }
    }
    return undefined;
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
  // A session another harness runs is shown here read-only: what is sent to it would go nowhere.
  private refuseOutside(id: string) {
    const s = this.store.session(id);
    if (s?.outside) throw Object.assign(new Error(outsideRefusal(s)), { status: 409, code: "outside" });
  }

  send(id: string, text: string, opts: { mode?: "send" | "steer" | "queue"; images?: any[]; meta?: Record<string, unknown>; key?: string } = {}): Sent {
    this.refuseOutside(id);
    this.refuseInput(id);
    if (opts.key) {
      const { key, ...rest } = opts;
      return this.store.atomic(id, () => (this.claim(id, key) ? this.send(id, text, rest) : { duplicate: true }));
    }
    const mode = opts.mode ?? "send";
    // A queue request must not start a held session, even if nothing else is queued.
    if (this.running.has(id) || (mode === "queue" && (this.held.has(id) || this.store.queue(id).length)) || this.inputHeld(id, opts.meta)) {
      const q = this.store.enqueue(id, text, mode !== "queue" && this.running.has(id), opts.images, opts.meta);
      this.emitQueue(id);
      return { queued: q, steer: q.steer };
    }
    // Input that is not the owner's (a report, a wake) never releases a held queue.
    if (ownersMeta(opts.meta)) this.release(id);
    // A prompt that arrives before a cut turn was continued: the model is told of the cut first.
    this.acceptRestart(id);
    // The owner's prompt after one that could not be sent takes its place (see unanswered).
    const stale = ownersMeta(opts.meta) ? this.unanswered(id) : undefined;
    const ev = this.accept(id, { text, images: opts.images?.length ? opts.images : undefined, ...opts.meta }, stale ? stale.parent : undefined);
    // The title comes from the owner's first words, not from a timer's or a report's envelope.
    // A prompt of only attachments (no words) is named by its files, or Image.
    const files = (opts.images ?? []).filter((b: any) => b?.type === "attachment").map((b: any) => String(b.name));
    if (ownersMeta(opts.meta)) this.titleFrom(id, text || (files.length ? files.join(", ") : opts.images?.length ? "Image" : ""));
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // Whether a hook keeps this input (another session's message) from starting a turn now: it waits in the queue.
  private inputHeld(id: string, meta: Record<string, unknown> | undefined): boolean {
    if (meta?.kind !== "peer") return false;
    const s = this.store.session(id);
    if (!s) return false;
    return allHooks().some((h) => { try { return !!h.holdsInput?.(s, meta); } catch (e) { this.errors.capture("server", e, { hook: "holdsInput", session: id }); return false; } });
  }

  // What a hook kept back is let go (a raised cap): the queue's next prompt starts if nothing else holds it.
  queueReleased(id: string) {
    if (this.running.has(id) || !this.store.queue(id).length) return;
    this.next(id);
    this.emitQueue(id);
  }

  // True the first time a session is given an input under this key. `fp`: a
  // fingerprint of the input's words; the same key with other words is the
  // sender's mistake and is refused, as a send id is (409), not answered as
  // sent. Keys are kept as long as the owner's send ids are.
  private claim(id: string, key: string, fp?: string): boolean {
    const now = Date.now();
    if (this.store.db.query("INSERT OR IGNORE INTO input_keys (session_id, key, ts, fp) VALUES (?, ?, ?, ?)").run(id, key, now, fp ?? null).changes > 0) {
      this.store.db.query("DELETE FROM input_keys WHERE ts < ?").run(now - KEYS_KEPT_MS);
      return true;
    }
    const had = this.store.db.query<{ fp: string | null }, [string, string]>("SELECT fp FROM input_keys WHERE session_id = ? AND key = ?").get(id, key);
    if (fp && had?.fp && had.fp !== fp) throw Object.assign(new Error("this send id was used for another message; send this one under a new id"), { status: 409 });
    return false;
  }

  // The input stored under this key: undefined when none was, and its words'
  // fingerprint (claim) when the sender gave one.
  inputUnder(id: string, key: string): { fp: string | null } | undefined {
    return this.store.db.query<{ fp: string | null }, [string, string]>("SELECT fp FROM input_keys WHERE session_id = ? AND key = ?").get(id, key) ?? undefined;
  }

  // Whether an input was stored for the session under this key.
  hasInput(id: string, key: string): boolean {
    return !!this.store.db.query("SELECT 1 FROM input_keys WHERE session_id = ? AND key = ?").get(id, key);
  }

  // A message from the session this one answers to (a parent to its agent),
  // stored before its sender is answered: as a queued row when the session
  // cannot take it now, else as its prompt. A running turn takes it at its
  // next step, as a steer. A session the owner stopped starts nothing: the
  // message is a queued row behind the hold, in the order it came, until the
  // owner resumes the queue (`held`), whether it was sent before the stop,
  // after it or while the daemon stops. A daemon on its way down starts no
  // turn either: the row waits for the next one (startQueued). Otherwise it
  // starts a turn now, after the sender's earlier ones that still wait, in the
  // order they were sent. `releases`: the makers of a hold this sender may
  // release, which are the stops it made itself; any other hold stays.
  // `key`, `fp`: as for claim.
  message(id: string, text: string, meta: Record<string, unknown>, opts: { key?: string; fp?: string; releases?: readonly string[] } = {}): Sent {
    this.refuseOutside(id);
    this.refuseInput(id);
    return this.store.atomic(id, () => {
      if (opts.key && !this.claim(id, opts.key, opts.fp)) return { duplicate: true };
      const wait = (steer: boolean) => {
        const q = this.store.enqueue(id, text, steer, undefined, meta);
        this.emitQueue(id);
        return { queued: q, steer };
      };
      if (this.running.has(id)) return wait(true);
      if (!this.releaseHold(id, opts.releases ?? [])) return { ...wait(false), held: true };
      if (this.draining) {
        this.owe(id);
        return wait(true);
      }
      const earlier = this.store.queue(id).filter((q) => q.meta?.kind === meta.kind && !this.offBranch(q));
      if (earlier.length) {
        for (const q of earlier) if (!q.steer) this.store.updateQueueItem(q.id, { steer: true });
        const mine = wait(true);
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
    const gone = rows.filter((q) => !ownersMeta(q.meta) && this.store.dequeue(q.id));
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
    // The running turn ends for the owner's new version of the prompt: their act, and not a Stop.
    return this.replace(id, async () => {
      await this.interrupt(id, "edit");
      this.release(id);
      // An edited steer is a new turn from the same place, not a live steer: it says what it was.
      const ev = this.accept(id, { text, images: old.data.images, ...(old.data.origin === "steer" ? { edited_from: "steer" } : {}) }, old.parent);
      // A new version of the first prompt is a new task: the title is its words
      // until the next reply makes one again. A title the owner gave stays.
      const s = this.store.session(id);
      const first = ownerPrompts(this.lineage(id)).length === 1 && !old.data.kind;
      if (s && first && s.title_by && s.title_by !== "hook" && text.trim()) {
        this.titleGen.set(id, (this.titleGen.get(id) ?? 0) + 1);
        this.store.updateSession(id, { title: firstLineTitle(text), title_by: "prompt" });
      }
      this.emitSession(id);
      this.start(id);
      this.emitQueue(id);
      return { event: ev };
    });
  }

  // While the owner's message takes the running turn's place: nothing else starts a turn in the
  // session between the old turn's end and the new one's start (next, and what the automation
  // delivers: startsNext). What was kept back goes if no turn started after all.
  private async replace<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.replacing.set(id, (this.replacing.get(id) ?? 0) + 1);
    const stops = this.running.has(id);
    let failed = false;
    try { return await work(); } catch (e) {
      failed = true;
      throw e;
    } finally {
      const left = (this.replacing.get(id) ?? 1) - 1;
      if (left > 0) this.replacing.set(id, left);
      else {
        this.replacing.delete(id);
        // The owner's message could not be made the next turn (its write failed) and the turn it was to
        // replace is stopped: nothing else starts in its place. The queue waits for the owner, who sees why.
        if (failed && stops && !this.running.has(id)) { this.hold(id, "owner"); this.emitQueue(id); }
        else if (!this.running.has(id)) {
          this.next(id);
          for (const h of allHooks()) try { h.closingOver?.(id); } catch (e) { this.errors.capture("server", e, { hook: "closingOver", session: id }); }
        }
      }
    }
  }
  // Whether the owner's own message is about to be the session's next turn (see replace).
  startsNext(id: string) {
    return this.replacing.has(id);
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
      // The running turn ends for the owner's queued prompt: their act, and not a Stop.
      await this.replace(id, async () => {
        await this.interrupt(id, "send_now");
        // Another Send now of the same stop got there first and its turn runs:
        // this row is the next prompt, at the head of the queue, and starts no
        // second turn beside that one.
        if (this.running.has(id)) return void this.nextUp(q, here);
        // Sent before a cut turn was continued: the model is told of the cut first.
        this.acceptRestart(id);
        if (!this.deliver(qid, "queued", { release: true, turn: true })) throw gone();
        this.start(id);
      });
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
    // (That one body: asked at every prompt of the owner's, and a session at rest holds no bodies.)
    const d = this.store.body(line[end]!);
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
    if (this.held.has(id) || this.running.has(id) || this.replacing.has(id)) return;
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
    // Another session's message that a hook keeps back (a reached cap): it waits where it is.
    if (q.meta?.kind === "peer" && this.inputHeld(id, q.meta)) return;
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
    errorScope.run({ session: id }, () => asAsker("a turn", () => this.startTurn(id)));
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
    this.cachePlans.end(id, "woke"); // the wait it parked on is over
    return this.opened(id, this.append(id, "turn_start", data));
  }
  private opened(id: string, ev: StoredEvent) {
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
        // The turn is over, and not by a stop: what it still ran with its
        // signal (a command, a wait) is stopped with it, so nothing goes on
        // without a turn that owns it.
        abort.abort();
        // Its session was deleted under it: there is nothing to write the failure to, and it is no
        // failure of anyone's (the turn's writes are refused once the row is gone).
        if (!this.store.session(id)) return;
        // The store takes no writes (its disk does not answer): the turn's
        // failure is said in the session when it does, with why it stopped.
        if (refusedWrite(e) || diskFull(e) || this.store.refusing) {
          this.errors.capture("server", e, { session: id, at: "a turn ended: the store takes no writes" });
          // Which calls of the turn had finished (their results are owed with it) and which were stopped:
          // a call that ran is never asked for again by sending the prompt a second time.
          const calls = this.unsaved.get(id);
          this.unsaved.delete(id);
          const ran = calls?.filter((c) => !c.stopped).map((c) => c.what) ?? [];
          const stopped = calls?.some((c) => c.stopped) ?? true;
          // (Calls of the turn's earlier steps ran too, and are stored: the prompt is not to be sent a second time for those either.)
          const line = this.lineage(id);
          const earlier = line.slice(line.findLastIndex((ev) => ev.kind === "turn_start") + 1).some((ev) => ev.kind === "tool_result");
          const message = "This turn stopped: the daemon's store took no writes (its disk did not answer, or was full: see Errors). "
            + (ran.length
              ? `These ran before the store stopped taking writes, and their results are kept: ${ran.join(", ")}. ${stopped ? "What else it was running was stopped. " : ""}Try again goes on from there; do not send the prompt a second time, or they run again.`
              : earlier
                ? "What it was running was stopped. Its earlier calls ran and their results are kept: try again goes on from there; do not send the prompt a second time, or they run again."
                : "What it was running was stopped. Send the prompt again, or try again.");
          this.store.appendOrLater(id, "error", { message }, (ev) => this.emitEvent(ev));
          return;
        }
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
      // What saying so fails on (the session went between the check and the write) is kept as one
      // error, never as a rejection nobody handles.
      .catch((e) => { if (this.store.session(id)) this.errors.capture("server", e, { at: "a failed turn's error", session: id }); })
      .finally(() => {
        // The turn is over: what it left running no longer fails in it.
        if (scope) scope.turn = undefined;
        this.turns.delete(id);
        this.running.delete(id);
        this.unsaved.delete(id);
        this.resumedProviderRetry.delete(id);
        this.resumedBusy.delete(id);
        this.status(id, { kind: "idle" });
        // (Owed when the store takes no writes: the turn is over in memory either way.)
        if (!this.store.orLater("a session's phase", () => { if (this.store.session(id)) this.setPhase(id, "idle"); })) {
          this.store.phaseOwed(id, "idle");
          this.emitSession(id);
        }
        try { this.next(id); } catch (e) { if (!refusedWrite(e)) throw e; }
      });
    this.running.set(id, { abort, done });
  }

  // `effort`: the effort wanted (the session's unless the turn chose another: turnWant).
  private async step(session: Session, model: string, effort = session.settings.effort): Promise<Step> {
    const { provider, info } = await this.providers.resolve(model);
    // A model known to take no tool definitions (the owner, a probe, its listing
    // or catalog said so) is sent none: it would refuse them or answer garbled.
    const native = info.tools !== false && loadsNatively(provider.wire, info);
    // Fitted to the wire before the pin: the pin keeps the tools as they were sent.
    const built = info.tools === false ? [] : this.toolFit.fit(session, fitWireOf(provider, info), toolsFor(info.family, native, session.id));
    // On its own model the session keeps the tools and prompt it was last
    // sent, across a daemon upgrade too, and takes this build's when no warm
    // cache holds its context or waiting would be wrong (src/engine/build-pin.ts).
    // A request on another model (an advisor, a fallback) has no cache of the
    // session's to keep: it gets this build's tools.
    const own = info.id === session.model;
    const to = { model: info.id, native, own: info.tools === false ? "no tools" : sessionToolsKey(info.family, session.id) };
    const why = own ? this.pins.due(session, to, built, () => this.coldWhy(session.id, provider, info)) : undefined;
    const local = !!session.parent_id && !session.machine;
    // (Made again for this build at a cold moment: not a move, so its subagents may keep their copies.)
    if (why && !local) { this.forgetSystem(session.id); this.adopting.add(session.id); }
    // A subagent that kept its parent's earlier prompt rides the parent's again once its cache is cold.
    const copy = local ? this.diverged.get(session.id) : undefined;
    if (own && copy !== undefined && (pinAged(copy) || this.coldWhy(session.id, provider, info))) this.systems.delete(session.id);
    this.pins.begin(session.id, why);
    try {
      const system = await this.systemOf(session, info);
      return { provider, info, tools: own ? this.pins.tools(session, to, built) : built, system: system.text, systemSplit: system.split, systemOwn: system.own, effort: effectiveEffort(info, effort), native };
    } finally {
      this.pins.end(session.id);
    }
  }

  // The inline part of a text result for this session after a step that
  // used `u` (src/tools/carry.ts): its context, its model's price, and the
  // requests its context has had since its checkpoint and can still take.
  private inlineOf(session: Session, st: Step, u: Usage): { cap: number; head: number } {
    const events = this.lineage(session.id);
    const from = checkpointAt(events).at + 1;
    let steps = 0, first = 0, output = 0;
    for (let i = from; i < events.length; i++) {
      const e = events[i]!;
      if (e.kind !== "assistant" || !e.data.usage) continue;
      const p = e.data.usage.input + e.data.usage.cache_read + e.data.usage.cache_write;
      if (!steps) first = p;
      steps++;
      output += e.data.usage.output ?? 0;
    }
    const context = u.input + u.cache_read + u.cache_write;
    const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
    const cap = inlineCap({
      context, price: st.info.price, steps: Math.max(1, steps), room: Math.max(0, limit - context),
      growth: steps > 1 ? Math.max(0, context - first) / (steps - 1) : 0, output: steps ? output / steps : u.output, bytes: bytesPerToken(st.info.id),
    });
    return { cap, head: HEAD_SHARE };
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
  // daemon run, and again when an instruction file it read was edited
  // (instructionsEdited), it is rendered again for the model it was made for
  // and compared block by block. A block that differs (an instruction file was
  // edited, a skill was added, a server published other instructions, a new
  // build reworded one) replaces the kept prompt when the session's cache is
  // cold or the change must not wait, and the row then names the blocks;
  // until then the kept prompt is sent as it was (src/engine/build-pin.ts).
  private async loadSystem(session: Session, info?: ModelInfo): Promise<System> {
    const parent = session.parent_id && !session.machine ? this.store.session(session.parent_id) : undefined;
    let system: System;
    if (parent) {
      // Its own copy of the parent's earlier prompt (kept when the parent's
      // changed while this cache was warm) until its cache is cold, the
      // pin's age passes, or the parent's has a block this build marks urgent.
      const theirs = await this.systemOf(parent, info, false);
      const mine = this.prompts.get(session.id);
      const keep = mine && mine.text !== theirs.text && !pinAged(mine.rendered) && !urgentBlock(mine.blocks, changedBlocks(mine.blocks, theirs.blocks ?? []));
      if (mine && keep && !(await this.coldOf(session))) {
        system = mine;
        this.diverged.set(session.id, mine.rendered);
      } else {
        if (mine) this.prompts.drop(session.id);
        this.diverged.delete(session.id);
        system = theirs;
      }
    } else {
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
        // A change of the owner's side is taken now when no warm cache holds the kept one.
        const own = kept ? ownChanges(kept.blocks, made.blocks, changed) : [];
        const taken = this.pins.prompt(session.id, kept?.blocks, made.blocks, changed, moved, own.length ? await this.coldOf(session) : undefined);
        // A prompt made again for a new model is kept as made for it, so the
        // next run compares it against that model.
        if (kept && !taken) {
          system = kept;
          // A change of the owner's side is told at the tail meanwhile (tellPrompt).
          if (own.length) this.fresh.set(session.id, made);
          else this.fresh.delete(session.id);
          // (Its blocks stay cut as the kept one's were sent.)
          if (moved && !changed.length && forModel && kept.model !== forModel.id) this.prompts.put(session.id, { ...made, own: kept.own });
        } else {
          // A change that must not wait (an urgent block, a move) reaches its subagents too.
          if (kept && changed.length) {
            if ((moved && !this.adopting.has(session.id)) || urgentBlock(kept.blocks, changed)) this.unshelter(session.id);
            else this.shelter(session.id, kept);
          }
          this.prompts.put(session.id, made, changed);
          this.fresh.delete(session.id);
          system = made;
        }
        this.checked.add(session.id);
        this.moved.delete(session.id);
        this.adopting.delete(session.id);
      }
    }
    this.systems.set(session.id, { text: system.text, split: system.split, own: system.own, blocks: system.blocks, model: parent ? undefined : this.prompts.get(session.id)?.model ?? undefined });
    return system;
  }

  // Why no warm cache holds the session's context on its own model, if none
  // may; a model that does not resolve has no cache to keep.
  private async coldOf(session: Session): Promise<string | undefined> {
    const r = await this.providers.resolve(session.model).catch(() => undefined);
    // (Read off the loop first: the session in hand may be another's parent, not in memory.)
    if (r) await this.store.warm(session.id);
    return r ? this.coldWhy(session.id, r.provider, r.info) : "the model is not available";
  }

  // The session's prompt is replaced (`kept` was sent until now). Its
  // subagents on this machine ride it byte for byte; one that may still hold
  // a warm cache of the earlier prompt keeps that as its own copy, so its next
  // request reads its cache instead of writing its context again, and rides
  // the new one once its cache is cold (loadSystem). One idle for longer than
  // any route keeps a prefix has nothing left to keep.
  private shelter(id: string, kept: StoredPrompt) {
    const since = Date.now() - LONGEST_KEEP_MS;
    // Copies of subagents idle past any cache's life keep nothing: they go.
    this.prompts.dropCopies(since);
    for (const d of this.store.descendants(id)) {
      const s = this.store.session(d);
      if (!s || s.machine || s.archived || s.updated < since || !this.ridesOn(s, id)) continue;
      this.prompts.put(d, { text: kept.text, split: kept.split, own: kept.own, blocks: kept.blocks, model: kept.model });
      this.diverged.set(d, Date.now());
    }
  }

  // The session took a prompt that must not wait: its subagents on this
  // machine drop the copies they kept and the prompt they hold in memory, so
  // their next request carries the new one.
  private unshelter(id: string) {
    for (const d of this.store.descendants(id)) {
      const s = this.store.session(d);
      if (!s || s.machine) continue;
      if (this.diverged.delete(d) || this.prompts.get(d)) this.prompts.drop(d);
      this.systems.delete(d);
    }
  }

  // Whether a subagent's requests carry `root`'s prompt: every session between
  // them is on this machine and sends no copy of its own.
  private ridesOn(s: Session, root: string): boolean {
    for (let x: Session | undefined = s, hops = 0; x && hops < 32; hops++) {
      if (!x.parent_id || x.machine || (x !== s && this.prompts.get(x.id))) return false;
      if (x.parent_id === root) return !this.prompts.get(s.id);
      x = this.store.session(x.parent_id);
    }
    return false;
  }

  // The newest render of the prompt a session's requests are made from: the
  // session's own, or for a subagent on this machine its top session's.
  private latestPrompt(session: Session): Rendered | undefined {
    for (let x: Session | undefined = session, hops = 0; x && hops < 32; hops++) {
      if (!x.parent_id || x.machine) {
        // A render that waits but is no longer in memory: unknown until it is made again (a revert would be claimed).
        const fresh = this.fresh.get(x.id);
        if (!fresh && this.pins.telling(x.id)) return undefined;
        const p = fresh ?? this.systems.get(x.id) ?? this.prompts.get(x.id);
        return p?.blocks ? { text: p.text, blocks: p.blocks } : undefined;
      }
      x = this.store.session(x.parent_id);
    }
    return undefined;
  }

  // A change of the owner's side of the prompt that the model does not hold
  // yet is told at the tail of the history, once (src/engine/prompt-note.ts).
  // Stored as a note for the model, so later requests carry the same bytes.
  private tellPrompt(session: Session, events: readonly StoredEvent[]): boolean {
    const sent = this.systems.get(session.id);
    const latest = sent?.blocks ? this.latestPrompt(session) : undefined;
    if (!sent?.blocks || !latest) return false;
    const told = toldOf(events, checkpointAt(events).keepFrom);
    if (latest.text === sent.text && !told.size) return false;
    const note = promptNote({ text: sent.text, blocks: sent.blocks }, latest, told);
    if (!note) return false;
    this.append(session.id, "note", { kind: NOTE_KIND, model: true, system: true, short: note.short, blocks: note.blocks, text: note.text });
    return true;
  }

  private async renderSystem(session: Session, info?: ModelInfo) {
    const extra = await Promise.all(allHooks().map((h) => h.system?.(session, info) ?? ""));
    // Each block as the model is sent it, secrets as placeholders: the kept
    // prompt and its fingerprints never hold a secret's value.
    // (The owner's instructions and Keel's: their own words, where a secret that is an ordinary word stays that word.)
    const sent = (p: PromptPart): PromptPart => ({ name: p.name, text: conceal(p.text, session.id, "own"), ...(p.data !== undefined && { data: conceal(p.data, session.id, "own") }), ...(p.same !== undefined && { same: conceal(p.same, session.id, "own") }) });
    // A block of the owner's data keeps its place while it is empty, so its data can be compared (hooks.ts SystemBlock).
    const part = (b: string | SystemBlock, wrap: (t: string) => string): PromptPart[] =>
      typeof b === "string" ? (b ? [sent({ name: blockName(b), text: wrap(b) })] : []) : [sent({ name: b.name, text: b.text ? wrap(b.text) : "", data: b.data, ...(b.same !== undefined && { same: b.same ? wrap(b.same) : "" }) })];
    const shared: PromptPart[] = [sent({ name: "core", text: `${CORE}${testBuild?.core ? `\n${testBuild.core}` : ""}\n\n` }), ...extra.flatMap((b) => part(b, (t) => t + "\n\n"))];
    const own = (await Promise.all(allHooks().map((h) => h.sessionSystem?.(session, info) ?? ""))).flatMap((b) => part(b, (t) => `\n${t}\n`));
    // The place and its instruction files: the same for every session of the
    // folder (started that day), so the session's own blocks come after them.
    // (The instruction files' marks on disk, noted before they are read: an edit is noticed by them, instructionsEdited.)
    const marks: Marks = new Map();
    const folder = sessionParts(session.workspace, session.created, info && !info.context_assumed ? info.context : undefined, marks).map(sent);
    this.marks.set(session.id, marks);
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
      this.append(id, "note", { kind: "model_told", model: true, system: true, from: was, to: st.info.id, text: `[harness] The session's model changed: you are ${st.info.name} from here. The replies above came from another model (the last one from ${name}); go on with the work as it stands.` });
      return true;
    }
    return false;
  }

  // The model and effort a step of the turn runs at: the session's, or what an
  // inline skill named for the rest of the turn (Claude Code's skills
  // frontmatter: src/tools/skill-turn.ts). Its model is a listed one, by id or
  // by a word of its name on the session's provider; one on another provider
  // only when the choice may go wider (a repository's skill the owner has not
  // trusted does not send the conversation elsewhere). An effort the model
  // does not list keeps the session's. What was taken or left is said once a
  // turn in a note for the owner. A turn that fell back stays on the fallback.
  private async turnWant(id: string, session: Session, fellBack: boolean, told: Set<string>): Promise<{ model: string; effort?: string }> {
    const own = { model: session.model, effort: session.settings.effort };
    let c: ReturnType<NonNullable<ReturnType<typeof allHooks>[number]["turnChoice"]>>;
    for (const h of allHooks()) { c = h.turnChoice?.(session); if (c) break; }
    if (!c) return own;
    const say = (key: string, text: string) => {
      if (told.has(key)) return;
      told.add(key);
      this.append(id, "note", { kind: "skill_model", text });
    };
    const models = await this.providers.models();
    const cur = models.find((m) => m.id === session.model);
    const curName = cur?.name ?? session.model;
    let model = session.model;
    let info = cur;
    if (c.model && !fellBack) {
      const w = c.model.toLowerCase();
      const provider = cur?.provider ?? session.model.slice(0, session.model.indexOf(":"));
      const hit = models.find((m) => m.id === c.model || m.model === c.model)
        ?? models.find((m) => m.provider === provider && (m.model.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)));
      if (!hit) say(`model:${c.model}`, `The skill ${c.from} names the model ${c.model}, which no listed model matches: the turn stays on ${curName}.`);
      else if (hit.provider !== provider && !c.wider) say(`model:${c.model}`, `The skill ${c.from} names ${hit.name}, on another provider than the session's. A repository's skill moves the conversation to another provider only once the owner trusts it: the turn stays on ${curName}.`);
      else if (!c.wider && hit.id !== session.model && !noDearer(hit.price, cur?.price)) say(`model:${c.model}`, `The skill ${c.from} names ${hit.name}, which costs more than ${curName} or has no known price. A repository's skill the owner has not trusted moves the turn only to a model no dearer than the session's: the turn stays on ${curName}.`);
      else { model = hit.id; info = hit; }
    }
    let effort = own.effort;
    if (c.effort) {
      const rank = (e?: string) => (e ? EFFORT_LADDER.indexOf(e) : -1);
      if (!info?.efforts.includes(c.effort)) say(`effort:${c.effort}:${model}`, `The skill ${c.from} names the effort ${c.effort}, which ${info?.name ?? model} does not list: the turn keeps the session's effort.`);
      // (No effort set: the provider's default, which Keel cannot rank.)
      else if (!c.wider && c.effort !== own.effort && (rank(c.effort) < 0 || rank(own.effort) < 0 || rank(c.effort) > rank(own.effort))) say(`effort:${c.effort}:${model}`, `The skill ${c.from} names the effort ${c.effort}, above the session's${own.effort ? ` (${own.effort})` : " (the model's default)"}. A repository's skill the owner has not trusted only lowers the effort: the turn keeps the session's.`);
      else effort = c.effort;
    }
    if (model !== session.model || effort !== own.effort) {
      say(`took:${model}:${effort}`, `The skill ${c.from} runs the rest of this turn on ${info?.name ?? model}${effort && effort !== own.effort ? ` at effort ${effort}` : ""}. ${curName} comes back with the next message.`);
    }
    return { model, effort };
  }

  // Measuring hooks never stop a call.
  private measure(id: string, f: (h: ReturnType<typeof allHooks>[number]) => void) {
    for (const h of allHooks()) try { f(h); } catch (e) { this.errors.capture("server", e, { hook: "measure", session: id }); }
  }

  // An overloaded answer of `model`: how long the model has answered so across the daemon, from
  // the first answer of the overload going on (or this request's own first, when that is earlier).
  private overloadSeen(model: string, own = Date.now()): number {
    const now = Date.now();
    const was = this.busyModels.get(model);
    const since = Math.min(own, was && now - was.last < OUTAGE.flapMs ? was.since : now);
    this.busyModels.set(model, { since, last: now });
    if (this.busyModels.size > 64) this.busyModels.delete(this.busyModels.keys().next().value!);
    return now - since;
  }

  // Whether the session's fallback model is on a provider its folder does not allow: said once, and
  // the turn stays on its own model.
  private fallbackCrosses(id: string, fb: string): boolean {
    const c = crossing(this.store, id, "fallback", fb);
    if (c) sayCrossing(this.store.session(id), c);
    return !!c;
  }

  // Whether this turn's request leaves its overloaded model for the session's fallback now: only
  // on the session's own model (the fallback, once moved to, is waited out like any model), to a
  // fallback that lists and holds the context without compacting (a summary written there would
  // replace the session's history for a model it leaves at the next turn).
  private async overloadMove(id: string, session: Session, st: Step, req: ProviderRequest, fit: Fit | undefined, f: Omit<Parameters<typeof movesToFallback>[0], "cacheMs" | "cachedAt" | "now">, cause: unknown): Promise<MovedToFallback | undefined> {
    const fb = this.store.session(id)?.settings.fallback;
    if (!fb || fb === st.info.id || st.info.id !== session.model) return undefined;
    if (this.fallbackCrosses(id, fb)) return undefined;
    const now = Date.now();
    const cachedAt = Math.max(lastWarm(this.lineage(id), st.info.id), this.cachePlans.warmedAt(id, st.info.id));
    const why = movesToFallback({ ...f, cacheMs: req.cacheMs, cachedAt, now });
    if (!why) return undefined;
    // A fallback whose route its last answer shut (out of credit, signed out) would refuse the turn at
    // once: the turn waits for its own model instead, and the session's errors say why (one row a cause).
    const shut = shutWords(this.providers.shut(fb));
    if (shut) {
      this.errors.capture("provider", new Error(`The fallback ${fb} was skipped for an overloaded model: ${shut}`), { session: id, at: "the fallback model for an overloaded one", fallback: fb });
      return undefined;
    }
    let to: Step;
    try {
      to = await this.step(session, fb);
    } catch (e) {
      this.errors.capture("provider", e, { session: id, at: "the fallback model for an overloaded one", fallback: fb });
      return undefined;
    }
    if ((fit?.tokens ?? 0) >= Math.floor(to.info.context * COMPACT_SHARE)) return undefined;
    return new MovedToFallback(to, why, f.overloadedMs, cause);
  }

  // The agent's type, when the session is an agent (the agents table is the automation's).
  private roleOf(session: Session): string | undefined {
    if (!session.parent_id) return undefined;
    try { return this.store.db.query<{ type: string }, [string]>("SELECT type FROM agents WHERE session_id = ? LIMIT 1").get(session.id)?.type; } catch { return undefined; }
  }

  // The owner's rule for moving this agent off the route its request is on (src/engine/route-change.ts).
  // Never for a session of the owner's, and never for a request that is not a turn's step.
  private routeRule(session: Session, st: Step): RouteChangeRule | undefined {
    if (!session.parent_id) return undefined;
    const rules: RouteChangeRule[] = ownerSettings().route_change?.rules ?? [];
    return rules.length ? ruleFor(rules, this.roleOf(session), st.provider.id) : undefined;
  }

  // The agent leaves its route for the model the rule names, when that is somewhere it can go on now:
  // listed, on another provider, taking tools, its provider reachable and not overloaded, its route
  // taking work, and its provider one the session's folder allows. Not so: it keeps waiting, and
  // why is said once in its failures.
  private async ruleMove(id: string, session: Session, st: Step, rule: RouteChangeRule, why: RouteWhy, ms: number, cause: unknown): Promise<MovedByRule | undefined> {
    const skip = (words: string) => {
      this.errors.capture("provider", new Error(`The owner's rule to move this agent to ${rule.to} was not applied: ${words}. It keeps waiting.`), { session: id, at: "route change", to: rule.to }, { group: `route change skipped: ${rule.to}: ${words}`, quietLog: true });
      return undefined;
    };
    const now = Date.now();
    const models = await this.providers.models();
    const fact = judge(rule, models, {
      out: st.provider.id,
      down: this.providers.outages.list().map((o) => o.provider),
      busy: [...this.busyModels].filter(([, b]) => now - b.last < OUTAGE.flapMs).map(([m]) => m),
      shut: shutWords(this.providers.shut(rule.to)),
    });
    if (!fact.ok) return skip(fact.why);
    const cross = crossing(this.store, id, "fallback", rule.to, fact.model.provider);
    if (cross) { sayCrossing(this.store.session(id) ?? session, cross); return skip(`its provider is not allowed for this session's folder`); }
    const info = models.find((m) => m.id === rule.to)!;
    // A dollar budget or cap that holds the agent would not hold on a model with no listed price.
    for (const h of allHooks()) {
      let no: string | undefined;
      try { no = h.moveRefused?.(session, { id: info.id, name: info.name, price: info.price }); } catch (e) { this.errors.capture("server", e, { hook: "moveRefused", session: id }); }
      if (no) return skip(no);
    }
    // The effort goes with it to the nearest level the target lists, as in the owner's own switch.
    const want = this.store.session(id)?.settings.effort ?? session.settings.effort;
    const effort = want ? carriedEffort(want, info.efforts) : undefined;
    let to: Step;
    try { to = await this.step(session, rule.to, effort); } catch (e) { return skip(errorText(e)); }
    // What it costs and whether it fits, judged as the owner's own switch is, with nobody to ask.
    const events = this.lineage(id);
    const ranOn: string = events.findLast((e) => e.kind === "assistant" && e.data.usage)?.data.model ?? st.info.id;
    const wire = (model: string) => this.providers.get(model.slice(0, model.indexOf(":")))?.wire ?? "anthropic_messages";
    const lost = switchWarning({ lineage: events, now, to: info, toEffort: effort, from: this.providers.cachedModel(ranOn), toWire: wire(info.id), fromWire: wire(ranOn) });
    const limit = session.settings.compact_at ?? Math.floor(to.info.context * COMPACT_SHARE);
    const askUsd = Number(ownerSettings().model_switch?.ask_usd);
    const move = judgeMove({ warning: lost.warning, over: this.whole(events, to) >= limit, askUsd: Number.isFinite(askUsd) && askUsd >= 0 ? askUsd : ASK_USD_DEFAULT }, info.name);
    if (!move.ok) return skip(move.why);
    return new MovedByRule(to, why, ms, cause, move.extra);
  }

  // Where a request stands in its account's line: the owner's own turn first, then a session a page
  // shows, then agents by depth; what no turn waits on at once (a reader, a title, a summary made
  // ahead, a side answer) last. A summary the running turn waits on is the turn's.
  private laneOf(id: string, session: Session, purpose: ProviderRequest["purpose"], signal: AbortSignal) {
    const inTurn = purpose === "turn" || (purpose === "summary" && this.running.get(id)?.abort.signal === signal);
    const top = !session.parent_id;
    return laneOf({
      inTurn, top,
      ownerTurn: inTurn && top && this.ownerTurn(id),
      shown: inTurn && !!this.viewed?.(id),
      depth: top ? 0 : depthOf((s) => this.store.session(s)?.parent_id, id),
    });
  }

  // Whether the running turn answers the owner: one of its prompts (the one that started it, or a
  // steer since) is the owner's own words, not a harness input, a report, a wake or another session's message.
  private ownerTurn(id: string): boolean {
    const line = this.lineage(id);
    let started = false;
    for (let i = line.length - 1; i >= 0; i--) {
      const e = line[i]!;
      if (e.kind === "user" && ownerWords(e.data)) return true;
      if (e.kind === "turn_start") started = true;
      else if (started && e.kind !== "user") return false;
    }
    return false;
  }

  // One provider call with retries for passing failures. The UI is told about
  // each wait and the half-streamed reply of a failed attempt is dropped.
  // `fit`: what the caller counted for this request. The request as it is
  // finally built (after the hooks, the tools of this request and the files
  // resolved for this model) is counted against the model's window from it,
  // and one over the window is refused here instead of sent.
  private async call(id: string, st: Step, messages: Message[], signal: AbortSignal, partial: Streamed, session: Session, quiet = false, purpose: ProviderRequest["purpose"] = quiet ? "side" : "turn", fit?: Fit): Promise<ProviderResult> {
    const counted = fit ? { messages: fit.base ?? messages, tools: toolsBytes(st.tools) } : undefined;
    // A call to a provider the session's folder does not allow is never sent (src/safety/content-routes.ts).
    // A turn's, a summary's and a warm read's refusal is told by what fails on it; the rest are told here.
    const cross = crossing(this.store, id, purpose ?? "turn", st.info.id, st.provider.id);
    if (cross) {
      sayCrossing(this.store.session(id) ?? session, cross, !(purpose === "turn" || purpose === "summary" || purpose === "warm"));
      throw new RouteRefused(cross);
    }
    // Built once: a retry sends the same request, byte for byte (the hooks run
    // once, so a note a hook stored is in every attempt).
    const bare = purpose === "reader" || purpose === "title";
    // A title is written after the turn, while the session is idle or already in its next turn:
    // what it waits on is no part of the session's status.
    const shown = purpose !== "title";
    if (st.native && !bare) {
      st.tools = await withCatalog(st.tools, st.info.family, messages, (e, c) => this.errors.capture("server", e, c), id);
      // An MCP server's schemas as the wire takes them, before a loaded one is pinned as it was sent.
      st.tools = this.toolFit.fit(session, fitWireOf(st.provider, st.info), st.tools);
      // A deferred tool the conversation loaded keeps the definition it was loaded with (src/engine/build-pin.ts).
      if (st.info.id === session.model) st.tools = this.pins.loaded(id, st.tools, referenced(messages));
      // A tool an earlier search loaded that the fit leaves out is still declared, as a stand-in that says why.
      st.tools = keepReferenced(st.tools, messages, id);
    }
    // A tool whose schema the provider refused in this session goes without its parameters.
    if (!bare) st.tools = this.toolFit.overlay(id, st.tools);
    let req: ProviderRequest = { model: st.info.model, system: st.system, systemSplit: st.systemSplit, systemOwn: st.systemOwn, messages, tools: st.tools, effort: st.effort, maxTokens: purpose === "warm" ? 1 : st.info.output, signal, sessionKey: id, purpose, route: st.info.id , dropThinking: this.store.session(id)?.settings.drop_thinking || undefined };
    // A reader's request, a title's and a server's sampling request are sent once: nothing later reads a cache of them.
    if (bare || purpose === "sampling") req.cache = false;
    // A reader's request and a title's carry no conversation for the hooks to add to. A
    // sampling request goes through them (secrets, budget, telemetry); the
    // ones that add to a conversation add only to a turn's.
    // Whether it may be sent at all (the spend limit) is asked of every request, a bare one too.
    for (const h of allHooks()) h.mayRequest?.(session, req);
    if (!bare) for (const h of allHooks()) if (h.beforeRequest) req = { ...req, ...(await h.beforeRequest(session, req)) };
    if (session.parent_id && !bare && purpose !== "sampling") req.cacheLife = this.cacheLife(id, st, purpose);
    if (req.cache !== false) req.cacheMs = askedLife(st.provider.wire, req.cacheLife) ?? (retention(st.provider.wire, this.lineage(id), st.info.id).sure || undefined);
    // What the model can read, applied after the hooks (a hook may rebuild the messages).
    const base = timed(() => "preparing a request's conversation for the model (attachments, images)", () => resolveAttachments(st.info.images === false ? withoutImages(req.messages, st.info.name ?? st.info.model) : req.messages, st.info, id));
    // Every image within what the model's host takes (a history may hold a
    // larger one from before images were scaled when stored): a refused image
    // would fail this request and every later one of the session.
    this.sayImages(id, purpose);
    this.saySizes(id, purpose);
    const set = this.store.session(id)?.settings;
    let limits = imageLimits(st.info.family, set?.image_edge);
    let out = new Set(set?.images_out ?? []);
    // The long tool results this session sends shortened (a provider refused a request as too large once):
    // a projection of the stored history, the same bytes on every request.
    let short = new Set(set?.results_short ?? []);
    // What this request shortened after a refusal, and the refusal that began it.
    const shortened: string[] = [];
    let shortCause: unknown;
    let whole = timed(() => "shortening the long results of a request's conversation", () => shortenResults(base, short));
    // Shown while copies are made: after a restart a history with many large
    // images takes seconds before its first request is sent.
    const preparing = quiet ? undefined : () => this.status(id, { kind: "model", since: Date.now(), model: st.info.name, preparing: "images" });
    req.messages = await fitForWire(whole, limits, out, preparing);
    // What an image refusal changed for this request; kept for the session once it passes.
    let fixed: { cause: unknown; edge?: number; out?: string[]; large?: boolean } | undefined;
    let resent = false;
    // Tools this request was sent again without the parameters of (a provider refused their schema).
    let schemaResends = 0;
    // The failures this request was sent again after (a retry that passes heals them).
    const retried: ErrorRecord[] = [];
    // The provider could not be reached and this request waits for it: captured once, however long it takes.
    let down = false;
    // When the model first answered that it is overloaded, for a request that waits it out.
    let busySince: number | undefined;
    let busyTries = 0;
    // The owner's rule for a route that is out was applied to this request's wait (once: src/engine/route-change.ts).
    let ruleSpent = false;
    // A request the turn cannot go on without waits for a provider that cannot be reached; a call its
    // caller can go on without (a reader, a side answer, a summary made ahead) fails at once.
    const running = this.running.get(id);
    const outages = purpose === "turn" || (purpose === "summary" && running?.abort.signal === signal) ? this.providers.outages : undefined;
    const kept = outages && purpose === "turn" ? this.resumedBusy.get(id) : undefined;
    if (kept && kept.model === st.info.id) { busySince = kept.since; this.resumedBusy.delete(id); }

    // The caller's count plus what the request gained since, at the model's bytes a token.
    const fits = () => {
      if (!fit || !counted) return;
      const gained = gainedBytes(counted.messages, req.messages, st.info.id) + toolsBytes(req.tools) - counted.tools;
      const tokens = fit.tokens + Math.round(gained / bytesPerToken(st.info.id));
      const held = fit.least === undefined ? tokens : fit.least + Math.round(gained / RATIO_MAX);
      if (held >= st.info.context) throw overWindow(st.info, tokens);
    };
    fits();
    // Where the request stands in its account's line if the account's limit holds requests; a retry keeps its place.
    // A held request says so in the session's status, with when the account said it takes requests again.
    // A retry of this request's own 429 keeps its retry status while it waits there (the provider's
    // message, the attempt, the countdown), with the line's words added.
    // (Told again only when what it waits for changes: each retry status starts a wait in the trace.)
    let lineRetry: { attempt: number; max: number; at: number; message: string; limit: string } | undefined;
    req.lane = {
      ...this.laneOf(id, session, purpose, signal), since: Date.now(),
      held: (h) => {
        if (quiet || !shown || signal.aborted) return;
        if (lineRetry) {
          if ((h.until ?? lineRetry.at) === lineRetry.at && h.why === lineRetry.limit) return;
          lineRetry = { ...lineRetry, at: h.until ?? lineRetry.at, limit: h.why };
          this.status(id, { kind: "retry", ...lineRetry });
          return;
        }
        this.status(id, { kind: "model", since: Date.now(), model: st.info.name, limit: { ...(h.until ? { until: h.until } : {}), why: h.why } });
      },
      going: () => {
        lineRetry = undefined;
        if (!quiet && shown && !signal.aborted) this.status(id, { kind: "model", since: Date.now(), model: st.info.name });
      },
    } satisfies Lane;
    let attempt = 0;
    const carry = outages && this.resumedProviderRetry.get(id);
    if (carry && carry.model === st.info.id && carry.purpose === purpose) {
      attempt = carry.spent;
      this.resumedProviderRetry.delete(id);
    }
    for (;;) {
      partial.clear();
      let lastAt: number | undefined;
      this.measure(id, (h) => h.requestSent?.(session, req));
      const since = Date.now();
      // (A retry the account's line holds keeps its retry status until the line lets it go.)
      if (lineRetry && !this.providers.admission.held(this.providers.routeOf(st.info.id), st.info.model)) lineRetry = undefined;
      if (!quiet && !lineRetry) this.status(id, { kind: "model", since, model: st.info.name });
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
        // (The hooks that time a stream's pieces, looked up once a request, not at every piece.)
        const timing = allHooks().filter((h) => h.requestDelta);
        // (Its transfers are the model's, in the outward ledger: src/safety/egress.ts.)
        const res = await outward({ tool: "model", via: st.provider.id, session: id }, () => wireScope.run(tap, () => st.provider.stream({ ...req, onHeaders, connectWaitMs: outages?.active(st.provider.id) ? OUTAGE.probeMs : undefined }, (d) => {
          if ((first || silent) && !quiet) { first = silent = false; this.status(id, { kind: "idle" }); }
          last = Date.now();
          if (!quiet) this.outputs.set(id, last);
          const p = partial.get(d.index) ?? { kind: d.kind, text: "" };
          p.text += d.text;
          if (d.kind === "tool_input" && d.name) p.name = d.name;
          // A block the stream moved on from is whole.
          if (lastAt !== undefined && lastAt !== d.index) { const was = partial.get(lastAt); if (was) was.done = true; }
          lastAt = d.index;
          partial.set(d.index, p);
          for (const h of timing) try { h.requestDelta!(session, req, d); } catch (e) { this.errors.capture("server", e, { hook: "measure", session: id }); }
          if (!quiet) this.deltas.push(id, d);
        }))).finally(() => { if (!quiet) this.deltas.end(id); });
        clearInterval(hush);
        if (!quiet) { this.outputs.delete(id); this.wires.delete(id); }
        if ((!quiet || attempt) && shown) this.status(id, { kind: "idle" });
        this.measure(id, (h) => h.requestDone?.(session, req, res));
        this.boundThinking(id, res);
        if (fixed) this.imagesFixed(id, fixed, purpose);
        if (shortened.length) this.resultsShortened(id, shortened, shortCause, purpose);
        // The failures this request was sent again for are healed: recorded, not open.
        if (retried.length) this.errors.recovered(retried, id);
        answeredAt.set(res, since);
        if (this.busyModels.size) this.busyModels.delete(st.info.id);
        return res;
      } catch (e) {
        clearInterval(hush);
        if (!quiet) { this.outputs.delete(id); this.wires.delete(id); }
        const uncounted = unreachable(e);
        // No headers may mean the POST was accepted. Probe before the next
        // attempt, but spend a counted retry and never go past its ceiling.
        const slow = !!(e as { probeBeforeRetry?: boolean })?.probeBeforeRetry;
        const waitForProvider = !signal.aborted && outages && (uncounted || (slow && attempt + 1 < RETRY.max));
        if (waitForProvider && uncounted) this.measure(id, (h) => h.requestWaiting?.(session, req));
        else {
          this.measure(id, (h) => h.requestFailed?.(session, req, e, signal.aborted));
          // What the attempt's stream reported before it ended is the session's spend, as its ledger row says.
          const spent = reportedUsage(e);
          if (spent) this.store.addUsage(id, spent, { keepPlace: true });
        }
        if (signal.aborted) {
          outages?.left(id);
          throw abortError();
        }
        // A warm read is tried once, and says nothing to the session: its plan decides again.
        if (purpose === "warm") throw e;
        // A canary that did not fail pre-send falls back to the usual policy.
        // It no longer waits in the outage, even if it did not show recovery.
        if (down && !waitForProvider) outages?.left(id);
        // A route that cannot take deferred tools gets the search pair, once.
        if (st.native && !retryable(e) && isDeferError(e)) {
          this.errors.capture("provider", e, { session: id, fallback: "deferred tools refused; using search_tools" });
          refuseDefer(st.info.id);
          st.native = false;
          const eager = this.toolFit.fit(session, fitWireOf(st.provider, st.info), toolsFor(st.info.family, false, id));
          st.tools = this.toolFit.overlay(id, st.info.id === session.model ? this.pins.tools(session, { model: st.info.id, native: false, own: sessionToolsKey(st.info.family, id) }, eager) : eager);
          req = { ...req, tools: st.tools };
          fits(); // every built-in is in the prompt now
          attempt++;
          continue;
        }
        // The provider refused one tool's input schema (a 400 naming it): sent
        // again with that tool declared without its parameters, as it is for
        // the rest of the session; the model can still call it.
        if (!retryable(e) && !bare && schemaResends < SCHEMA_RESENDS && this.toolFit.refused(session, e, req.tools, fitWireOf(st.provider, st.info))) {
          schemaResends++;
          st.tools = this.toolFit.overlay(id, st.tools);
          req = { ...req, tools: this.toolFit.overlay(id, req.tools as Tool[]) };
          attempt++;
          continue;
        }
        // The provider refused the request over an image, or as too large in
        // bytes while it holds images. A pixel limit it states, lower than the
        // one used, is tried first: the images are scaled to it. Else the
        // images of this history are left out, each as a note. Either way the
        // turn goes on.
        const held = retryable(e) ? [] : imageKeys(whole);
        const sizeRefused = !retryable(e) && !imageRefusal(e) && requestTooLarge(e);
        const large = held.length > 0 && sizeRefused;
        // Too large in bytes can be a passing answer (a gateway's, a proxy's):
        // the same request goes once more before any image is left out.
        if (large && !resent) {
          resent = true;
          const wait = backoffMs(0);
          if (shown) this.status(id, { kind: "retry", attempt: 1, max: 1, at: Date.now() + wait, message: errorText(e) });
          await sleep(wait, signal);
          attempt++;
          continue;
        }
        // Too large in bytes with no image left to drop: the long tool results are sent shortened,
        // oldest first, and the request goes again. (The stored history is not changed.)
        if (sizeRefused && !held.some((k) => !out.has(k))) {
          const more = oldestResultsForSize(whole, short);
          if (more.length) {
            shortCause ??= e;
            shortened.push(...more);
            short = new Set([...short, ...more]);
            whole = shortenResults(base, short);
            req = { ...req, messages: await fitForWire(whole, limits, out, preparing) };
            attempt++;
            continue;
          }
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
            // A refusal as too large in bytes that names no image leaves out the
            // oldest only (oldestForSize); a request refused again drops more.
            const bad = fixed?.out || large ? [] : await damagedImages(whole, out);
            const drop = large ? oldestForSize(whole, left) : bad.length && bad.length < left.length ? bad : left;
            fixed = { cause: fixed?.cause ?? e, edge: fixed?.edge, out: [...(fixed?.out ?? []), ...drop], ...(large ? { large: true } : {}) };
            out = new Set([...out, ...drop]);
          }
          req = { ...req, messages: await fitForWire(whole, limits, out, preparing) };
          attempt++;
          continue;
        }
        // Wait with the provider's other sessions. Joining the wait costs no
        // retry; a request cut without headers still counts as an attempt.
        if (waitForProvider) {
          if (slow && !uncounted) {
            attempt++;
            retried.push(this.errors.capture("provider", e, { session: id, retry: attempt, wait_ms: 0 }, { quietLog: true }));
          } else if (!down) retried.push(this.errors.capture("provider", e, { session: id, provider: st.provider.id, retry: 1, wait_ms: 0 }, { group: `provider unreachable: ${st.provider.id}`, quietLog: true }));
          down = true;
          const retry = { model: st.info.id, purpose: purpose === "summary" ? "summary" as const : "turn" as const, spent: attempt };
          // An agent's wait is as long as the owner's rule for its type lets it (src/engine/route-change.ts):
          // the rule's time is counted from when the route went out, and the wait is left at that time,
          // once, whether or not the agent can move then.
          const rule = purpose === "turn" && !ruleSpent ? this.routeRule(session, st) : undefined;
          const leave = new AbortController();
          const back = outages.wait(st.provider.id, e, rule ? AbortSignal.any([signal, leave.signal]) : signal, { session: id, retry });
          const outSince = outages.of(id)?.since ?? Date.now();
          if (!quiet) this.status(id, { kind: "retry", attempt: 0, max: 0, at: 0, message: errorText(e), unreachable: outSince });
          const waitStart = performance.now();
          if (running) running.providerWaiting = true;
          const due = rule ? setTimeout(() => leave.abort(), dueIn(rule, outSince, Date.now())) : undefined;
          try {
            await back;
          } catch (gone) {
            if (rule && leave.signal.aborted && !signal.aborted) {
              ruleSpent = true;
              const moved = await this.ruleMove(id, session, st, rule, "outage", Date.now() - outSince, e);
              if (moved) {
                this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: 0, then: `this agent went on on ${moved.step.info.id} by the owner's rule` }, { group: `provider unreachable: ${st.provider.id}`, quietLog: true });
                throw moved;
              }
              continue;
            }
            if (!signal.aborted) throw gone; // the wait's ceiling: the failure itself
            // A restart parks the turn while it waits: said, so the next daemon reads a wait and not a stall.
            if (this.parking.has(id)) this.append(id, "note", {
              kind: "provider_wait", text: "The provider could not be reached when the daemon restarted: this turn waits for it and goes on by itself.",
              retry,
            });
            else outages.left(id);
            throw abortError();
          } finally {
            clearTimeout(due);
            const ms = Math.round(performance.now() - waitStart);
            this.measure(id, (h) => h.requestWaitEnded?.(session, req, ms));
            if (running) {
              running.providerWaiting = false;
              running.providerWaitMs = (running.providerWaitMs ?? 0) + ms;
            }
          }
          continue;
        }
        // An overloaded model is waited out past the count by a request the turn cannot go on
        // without (retry.ts overloaded; a reader or a side answer keeps the count), and its
        // answers are one Errors row for the model, whatever words each came in.
        // The tries an overloaded model took are counted apart: a different failure after them
        // has its own count of retries (`attempt - busyTries`), and theirs grows by their own.
        const full = overloaded(e);
        if (full) (e as { group?: string }).group ??= overloadedGroup(st.info.id);
        const waitsOut = full && !!outages;
        if (waitsOut) busySince ??= Date.now();
        const busyFor = full ? this.overloadSeen(st.info.id, busySince) : 0;
        const counted = attempt - busyTries;
        // An agent's rule for an overloaded route (src/engine/route-change.ts): it moves once the model
        // has answered overloaded for the rule's time, and its tries are not spaced past that time.
        const rule = waitsOut && purpose === "turn" ? this.routeRule(session, st) : undefined;
        const ruleMs = rule ? Math.round(rule.minutes * 60_000) : 0;
        const wait = rule && busyFor < ruleMs ? Math.min(backoffMs(busyTries, e), ruleMs - busyFor + 250) : backoffMs(waitsOut ? busyTries : counted, e);
        const ruled = rule && busyFor >= ruleMs ? await this.ruleMove(id, session, st, rule, "overloaded", busyFor, e) : undefined;
        if (ruled) {
          this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: 0, then: `this agent went on on ${ruled.step.info.id} by the owner's rule` });
          throw ruled;
        }
        // A turn's request on the session's own model may go on on its fallback (retry.ts movesToFallback).
        const moved = waitsOut && purpose === "turn" ? await this.overloadMove(id, session, st, req, fit, { tries: busyTries, overloadedMs: busyFor, nextWaitMs: wait, asked: retryAfterMs(e) !== undefined }, e) : undefined;
        if (moved) {
          this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: 0, then: `this turn went on on ${moved.step.info.id}` });
          throw moved;
        }
        if (!retriesLeft(e, counted, waitsOut ? busySince : undefined)) throw e;
        // Only a wait the provider asked for is longer than a turn waits (backoffMs keeps its own under it).
        if (wait > RETRY_WAIT_MAX_MS && retryAfterMs(e) !== undefined) throw new RetryTooLong(e, Date.now() + wait);
        // A rate limit the account's line now holds is waited out there, in its order: the owner's
        // turn ahead of agents, and one request first when the hold ends (src/providers/admission.ts).
        const line = rateLimited(e) ? this.providers.admission.held(this.providers.routeOf(st.info.id), st.info.model) : undefined;
        if (line) {
          retried.push(this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: Math.max(0, line.until - Date.now()), then: "waits in the account's line" }));
          if (shown) {
            lineRetry = { attempt: counted + 1, max: RETRY.max - 1, at: line.until, message: errorText(e), limit: line.why };
            this.status(id, { kind: "retry", ...lineRetry });
          }
          attempt++;
          continue;
        }
        retried.push(this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: wait }));
        if (shown) this.status(id, { kind: "retry", attempt: (waitsOut ? busyTries : counted) + 1, max: waitsOut ? 0 : RETRY.max - 1, at: Date.now() + wait, message: errorText(e) });
        // Where the counted retries would have ended the turn, the session that started it hears
        // that it still waits (once a request), so it can stop it or move the work to another model.
        if (waitsOut && busyTries === RETRY.max - 1) this.measure(id, (h) => h.capacityWaiting?.(session, st.info.id, Date.now() - busySince!));
        try {
          await sleep(wait, signal);
        } catch (stopped) {
          // A stop for a restart parks the turn in this wait: the wait's start is kept, so the next
          // daemon counts the owner's rule from it, not from its own first try.
          if (waitsOut && signal.aborted && this.parking.has(id) && purpose === "turn") this.append(id, "note", { kind: "overload_wait", model: st.info.id, since: busySince, text: `${st.info.name} was answering that it is overloaded when the daemon restarted: this turn goes on and keeps counting the wait.` });
          throw stopped;
        }
        if (waitsOut) busyTries++;
        attempt++;
      }
    }
  }

  // A request passed after the provider refused it over an image: what made
  // it pass holds for the session from here (the same bytes on every later
  // request), the refusal is captured once, and the transcript says it.
  private imagesFixed(id: string, fixed: { cause: unknown; edge?: number; out?: string[]; large?: boolean }, purpose: ProviderRequest["purpose"]) {
    const s = this.store.session(id);
    if (!s) return;
    this.store.mergeSettings(id, {
      ...(fixed.edge ? { image_edge: fixed.edge } : {}),
      ...(fixed.out ? { images_out: [...new Set([...(s.settings.images_out ?? []), ...fixed.out])] } : {}),
    });
    const n = fixed.out?.length ?? 0;
    const note = n
      ? { text: `${n === 1 ? "One image" : `${n} images`} left out of what the model reads: ${fixed.large ? "the provider refused a request as too large, so the oldest images of this session are no longer sent." : "the provider refused a request over this session's images."}`, left_out: n, detail: errorText(fixed.cause) }
      : { text: `Images over ${fixed.edge} px a side are sent scaled down: the provider stated that limit.`, detail: errorText(fixed.cause) };
    this.errors.capture("provider", fixed.cause, { session: id, then: n ? `${n} images left out for this session` : `images scaled to ${fixed.edge} px for this session` });
    this.imageNotes.set(id, note);
    this.sayImages(id, purpose);
  }

  // A request passed after the provider refused it as too large in bytes and the long tool results were
  // sent shortened: kept for the session from here (the same bytes on every later request), the refusal
  // captured once, and the transcript says what was done.
  private resultsShortened(id: string, ids: string[], cause: unknown, purpose: ProviderRequest["purpose"]) {
    const s = this.store.session(id);
    if (!s) return;
    this.store.mergeSettings(id, { results_short: [...new Set([...(s.settings.results_short ?? []), ...ids])] });
    this.errors.capture("provider", cause, { session: id, then: `${ids.length} long tool results sent shortened for this session` });
    this.sizeNotes.set(id, { text: `${ids.length === 1 ? "One long tool result is" : `${ids.length} long tool results are`} sent shortened to its start and end: the provider refused a request as too large, so the oldest long results of this session are no longer sent whole. What is stored is unchanged.`, shortened: ids.length, detail: errorText(cause) });
    this.saySizes(id, purpose);
  }
  private sizeNotes = new SessionMap<{ text: string; shortened: number; detail: string }>(256);
  private saySizes(id: string, purpose: ProviderRequest["purpose"]) {
    const note = purpose === "turn" ? this.sizeNotes.get(id) : undefined;
    if (!note) return;
    this.sizeNotes.delete(id);
    this.append(id, "note", { kind: "results_short", ...note });
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
  // A warm request (src/engine/cache-plans.ts) asks for the lifetime the session's last request
  // asked for (a read with another marker would keep the entry at another lifetime), and counts
  // as the request before the next: the wake after a warm read is not late.
  private lifeAsked = new SessionMap<"short" | "long">(256);
  private cacheLife(id: string, st: Step, purpose?: ProviderRequest["purpose"]): "short" | "long" | undefined {
    const lives = cacheLives(st.provider.wire);
    const now = Date.now();
    const prev = this.sent.get(id);
    this.sent.set(id, now);
    if (!lives) return undefined;
    if (purpose === "warm") return this.lifeAsked.get(id) ?? (this.store.session(id)?.settings.cache_long ? "long" : "short");
    const life = this.lifeFor(id, st, lives, now, prev);
    this.lifeAsked.set(id, life);
    return life;
  }
  private lifeFor(id: string, st: Step, lives: { short: number; long: number }, now: number, prev: number | undefined): "short" | "long" {
    if (this.store.session(id)?.settings.cache_long) return "long";
    // After a restart: the reply before this request, whatever its cache did, or a warm read after it
    // (a wake it kept warm is not late: a longer marker there would write the context again).
    const before = prev ?? (Math.max(this.lineage(id).findLast((e) => e.kind === "assistant")?.ts ?? 0, this.cachePlans.warmedAt(id, st.info.id)) || undefined);
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
        // (What the join still holds of the text goes out before the event that stores it: a page drops its draft at that event.)
        append: (kind, data) => { this.deltas.end(id); return this.append(id, kind, data); },
        delta: (kind, index, text) => this.deltas.push(id, { kind, index, text }),
        status: (s) => this.status(id, s),
        // (Read when a stop reaches the agent: the stop's word is set before the turn's signal aborts.)
        stopper: () => this.stoppedBy.get(id),
        runTool: (which, input, callId) => {
          const tool = typeof which === "string" ? sharedTool(which) : which;
          const name = typeof which === "string" ? which : which.name;
          if (!tool) return Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: callId, content: noSuchTool(name), is_error: true });
          const seen = this.seen.get(id) ?? new Map();
          this.seen.set(id, seen);
          const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id), parentId: session.parent_id ?? undefined,
            questionChanged: () => this.bus.emit({ t: "questions", pending: allPendingQuestions() }) };
          const u: ToolUseBlock = { type: "tool_use", id: callId, name, input: input ?? {} };
          // (Tracked as the turn's own calls are: a card it waits on is a wait on the owner. What it showed is the agent's to show.)
          return this.tracked(id, u, this.runTool(session, [tool], u, ctx)).finally(() => this.shown.delete(callId));
        },
      });
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : r.reason;
      if (r.usage) { usage = r.usage; this.store.addUsage(id, usage); this.emitSession(id); }
      // (It answered: an account problem its route had is over. A test's stand-in registry may keep none.)
      if (!signal.aborted) this.providers.turnAnswered?.(session.model);
    } catch (e) {
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : "error";
      // Its failure is the route's last answer: out of credit or signed out, no new work starts on it.
      if (!signal.aborted) this.providers.turnAnswered?.(session.model, e);
      if (!signal.aborted) throw e;
    } finally {
      this.deltas.end(id);
      const by = this.stoppedBy.get(id);
      this.stoppedBy.delete(id);
      this.store.appendOrLater(id, "turn_end", { reason, usage, ms: Date.now() - t0, ...(by && reason === "interrupted" ? { stopped_by: by } : {}) }, (e) => this.emitEvent(e));
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, reason))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  // The bodies a turn's first request is made from are read off the loop before the turn reads
  // them: the shown branch from its last checkpoint on (and that checkpoint's own event, which
  // says where it keeps from). A session at rest gives its bodies back after two minutes, and a
  // turn that starts then read them back a run at a time, on the loop, from the disk.
  // `line`: the branch as the caller read it (the same events: their bodies are read through them).
  private async warmContext(id: string, line: readonly StoredEvent[] = this.lineage(id)) {
    try {
      let at = line.length - 1;
      while (at >= 0 && line[at]!.kind !== "compaction") at--;
      if (at >= 0) await this.store.warmBodies(id, line[at]!.seq, line[at]!.seq);
      const from = line[checkpointAt(line).keepFrom]?.seq;
      if (from !== undefined) await this.store.warmBodies(id, from);
    } catch {
      // What could not be read ahead is read by the turn, as it was.
    }
  }

  private async loop(id: string, signal: AbortSignal) {
    let session = this.store.session(id)!;
    for (const h of allHooks()) {
      const run = h.external?.(session);
      if (run) return this.external(id, session, run, signal);
    }
    this.setting.add(id);
    // (A session not in memory yet has its pages read off the loop first: store.warm.)
    // (And the bodies its first request is made from, which a session at rest gave back: warmContext.)
    const ready = await this.store.warm(id, false).then(() => this.warmContext(id)).then(() => this.step(session, session.model))
      .finally(() => this.setting.delete(id))
      // A setup that fails after the stop has nothing left to say: the turn is closed.
      // One that fails while the daemon parks its turns is closed below.
      .catch((e) => { if (this.stoppedEarly.has(id) || this.parking.has(id)) return undefined; throw e; });
    const stopped = this.stoppedEarly.delete(id);
    // (The turn's first writes wait for a long hold of the store's write lock to be over, as a step's do: Store.clear.)
    if (ready && !stopped && this.store.pacing?.()) await this.store.clear(signal);
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
    // Aborted when the turn fails while calls of a step still run (`batch`): the turn's own signal stays what a stop is.
    const failing = new AbortController();
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal: AbortSignal.any([signal, failing.signal]), seen, spillDir: join(this.spillRoot, id),
      parentId: session.parent_id ?? undefined,
      questionChanged: () => this.bus.emit({ t: "questions", pending: allPendingQuestions() }),
      inContext: (text) => JSON.stringify(toMessages(this.lineage(id))).includes(JSON.stringify(text).slice(1, -1)),
      read: (source, text, prompt) => this.read(id, source, text, prompt, signal),
      readMaterial: (items, question, callId) => this.readMaterial(id, items, question, signal, callId),
      readBudget: () => readBudget(this.readerHost(id)) };

    const t0 = Date.now();
    let usage: Usage = emptyUsage();
    // One commit: the session works from its turn's first event on (the two frames go out after it, in their order).
    this.cancelContinue(id);
    this.cachePlans.end(id, "woke"); // the wait it parked on is over: its note goes before the turn
    const began = this.store.atomic(id, () => ({ s: this.store.updateSession(id, { phase: "working" }), ev: this.store.append(id, "turn_start", { model: session.model, effort: st.effort }) }));
    this.bus.emit({ t: "session", session: began.s });
    this.emitEvent(began.ev);
    this.opened(id, began.ev);
    let reason = "end_turn";
    let cuts = 0;
    let fellBack = false;
    // The turn left its overloaded model for the session's fallback (once a turn), and the model
    // the session had when the turn began or the owner last chose one.
    let movedOn = false;
    let ownModel = session.model;
    // What this step runs on, and the notes about an inline skill's choice already said this turn.
    let want: { model: string; effort?: string } = { model: session.model, effort: session.settings.effort };
    const told = new Set<string>();
    let compactedForFit = false;
    let summaryFailed = false;
    // The code of the error that ended the turn (context_over_window, summary_truncated), kept on its turn_end.
    let failed: string | undefined;
    let steps = 0;
    // A budget a hook keeps for the session (an agent's) is spent: this step is its last, a report in
    // words with no call run, and the turn ends "budget" after it.
    let closing = false;
    // The closing step is a dollar cap's, and the cap's note was told in this turn.
    let closingCap = false;
    let capNoted = false;
    // What the turn's end says it took: the replies the model gave, its tool
    // results, those of calls that ran and failed (what telemetry and the
    // trace count too), and those of calls a gate denied. A call the turn's
    // stop or a restart cut did not fail: it is a result, not an error.
    let replies = 0;
    let toolResults = 0;
    let toolErrors = 0;
    let toolDenied = 0;
    const partial: Streamed = new Map();
    // Each result is stored as it settles, not when the whole batch has:
    // a crash while one call still runs keeps what the others returned
    // (a denial and its reason, a finished read). The projection puts a
    // step's results back in call order. A call whose open card a stop
    // parks gets none: the next daemon asks on that card again.
    // A result is stored once the store's write lock is not held for long (Store.clear): the turn
    // waits for that off the loop. Should the store stop taking writes meanwhile, the result is
    // owed at once (so a restart or a kill keeps it), and the turn waits on for the store to take it.
    const settle = (u: ToolUseBlock) => (r: ToolResultBlock) => (this.store.pacing?.() && !this.store.refusing ? this.store.clear(signal, undefined, true).then(() => settleNow(u)(r)) : settleNow(u)(r));
    const settleNow = (u: ToolUseBlock) => (r: ToolResultBlock): void | Promise<void> => {
      // (A question the owner answered as the stop came keeps its answer.)
      if (this.parking.has(id) && (outcomeOf(id, u.id) === "waiting" || (asksOwner(u.name) && r.content === QUESTION_CUT))) return;
      toolResults++;
      const how = this.verdicts.get(r);
      if (how === "denied") toolDenied++;
      else if (how === "failed" && !signal.aborted) toolErrors++;
      const shown = this.shown.get(r.tool_use_id);
      this.shown.delete(r.tool_use_id);
      const ruled = this.ruled.get(r.tool_use_id);
      this.ruled.delete(r.tool_use_id);
      // One write through the store: when it fails, the result is not left in the kept events.
      // When the store takes no writes the result is owed, like the turn's end after it (Store.orLater):
      // an answer the owner gave, or what a command they allowed printed, is not thrown away. The turn
      // cannot go on from a result that is not stored, so it ends here, saying which calls had finished.
      const at = Date.now(), eid = Bun.randomUUIDv7();
      // What an error result is, kept with it: the call ran and failed, a gate refused it, or it was not
      // run for another reason. Whoever counts later (an agent's report) counts as this turn's end does.
      const data = this.store.redact(id, "tool_result", { results: [r], ...(r.is_error ? { verdict: how ?? "none" } : {}), ...(shown !== undefined ? { shown: { [r.tool_use_id]: shown } } : {}), ...(ruled ? { ruled } : {}) });
      let made = false;
      const stored = this.store.orLater("a tool's result", () => this.store.atomic(id, () => {
        this.emitEvent(this.store.append(id, "tool_result", data, undefined, at, eid));
        for (const h of allHooks()) {
          try { h.resultStored?.(session, [r]); } catch (e) { this.errors.capture("server", e, { hook: "resultStored", session: id }); }
        }
        made = true;
      }), [{ op: "event", id: eid, session: id, kind: "tool_result", data, at }]);
      if (stored) return;
      const ends = () => {
        const calls = this.unsaved.get(id) ?? [];
        this.unsaved.set(id, calls);
        calls.push({ what: callWords(u), stopped: (signal.aborted || failing.signal.aborted) && stopKind(r.content) !== undefined });
        throw Object.assign(new Error("the store takes no writes: this call's result is owed, and the turn ends here"), { code: "SQLITE_READONLY" });
      };
      // Owed. Where the store stopped for a hold of its write lock that ends (a start of the log on
      // a slow disk), the turn waits for it: the result is made in its order, and the turn goes on.
      if (this.store.pacing?.()) return this.store.clear(signal).then(() => { if (!made) ends(); });
      ends();
    };
    // A step's calls. When one of them fails the turn (its result cannot be stored, or it threw past its
    // wrapper), the others are stopped and waited for: their results are stored, or owed, before the
    // turn's end, never after it.
    const batch = async (runs: Promise<unknown>[]) => {
      try { await Promise.all(runs); } catch (e) {
        failing.abort();
        await Promise.allSettled(runs);
        throw e;
      }
    };
    try {
      // What the turn reads from here on is its context: the events after the last checkpoint, with
      // their bodies. They are brought in a slice at a time first. A context is a window's worth and
      // most of it is in memory already; a history no checkpoint was ever made in (an import) is all
      // of the session, and read in one piece it held the loop for as long as the read took.
      await this.warmContext(id);
      // Calls a restart cut while they waited for the owner: asked again on
      // the same card before the model is asked anything.
      const owed = owedCalls(id, this.lineage(id));
      if (owed.length) {
        this.status(id, { kind: "tool", since: Date.now(), names: [...new Set(owed.map((u) => u.name))] });
        // A question whose tool the session's model no longer has cannot be put back: it expired.
        const gone = (u: ToolUseBlock) => asksOwner(u.name) && !st.tools.some((t) => t.name === u.name);
        await batch(owed.map((u) => this.tracked(id, u, gone(u) ? Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: u.id, is_error: true, content: QUESTION_CUT }) : this.runTool(session, st.tools, u, ctx)).then(settle(u))));
        this.status(id, { kind: "idle" });
        if (signal.aborted) throw signal.reason;
      }
      let retaken = 0;
      for (;;) {
        // (What the step had stored when a write of it was refused: see the catch at the loop's end.)
        const head0 = this.store.session(id)?.head, steps0 = steps;
        try {
        // (What a step writes waits for a long hold of the store's write lock to be over: Store.clear.)
        if (this.store.pacing?.()) await this.store.clear(signal);
        // Steers sent while the last step ran join here, after its tool results.
        // The owner's own words (a steer with no meta) release a held queue, as
        // a prompt typed while idle does: the turn they joined may be one a wait
        // or a loop started in a session the owner had stopped.
        for (const q of this.liveSteers(id)) if (this.deliver(q.id, "steer", { release: ownersMeta(q.meta) })) this.emitQueue(id);
        // A row a stopping daemon owed a start, taken by the turn the next one continued: nothing is owed for an empty queue.
        if (this.owed.has(id) && !this.store.queue(id).length) this.settleOwed(id);
        session = this.store.session(id)!;
        // A model or effort chosen while the turn runs takes effect at its next request: the
        // owner's, or an inline skill's for the rest of the turn (turnWant). A turn that went on on
        // the fallback stays there unless the owner chose another model meanwhile.
        const chosen = session.model !== ownModel && session.model !== st.info.id;
        if (chosen) { ownModel = session.model; movedOn = false; }
        want = await this.turnWant(id, session, fellBack || movedOn, told);
        if ((want.model !== st.info.id && (chosen || !movedOn)) || effectiveEffort(st.info, want.effort) !== st.effort) st = await this.step(session, movedOn ? st.info.id : want.model, want.effort);
        // The owner's step budget for one turn (none by default).
        const budget = session.settings.max_steps ?? 0;
        if (budget > 0 && steps >= budget) {
          this.append(id, "note", { kind: "max_steps", text: `Stopped after ${steps} model steps: the step budget of this session. Resume to go on.` });
          reason = "max_steps";
          break;
        }
        // A budget of the session's own (an agent's steps, minutes or dollars) that is spent: one
        // more step, in words, then the turn ends. Asked before each step, so a turn a wake starts
        // after the budget ran out gets only that step.
        if (!closing) for (const h of allHooks()) {
          const said = h.budget?.(session, () => this.byOwner(id));
          if (!said) continue;
          const o = typeof said === "string" ? { text: said } : said;
          if (o.note) {
            if (!capNoted) { capNoted = true; this.append(id, "user", { text: o.text, origin: "harness" }); }
            continue;
          }
          closing = true;
          closingCap = !!o.cap;
          this.append(id, "user", { text: o.text, origin: "harness" });
          break;
        }
        steps++;
        // The last step of the budget answers in words: the request keeps its
        // tools (the cached prefix), and calls it still makes are not run.
        if (budget > 0 && steps === budget) this.append(id, "user", { text: `[harness] This is the last model step this turn may take (the session's step budget is ${budget}). Do not call tools: reply with where the work stands and what is left to do.`, origin: "harness", system: true });
        // (A history not counted yet is counted here in slices: the counts below then read what is kept.)
        await countPaced(this.lineage(id), st.info.id);
        let events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        let mark: ReturnType<typeof followUpMark>;
        let priced: ReturnType<Engine["priced"]>;
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
          if (!this.applyPrepared(id, events, undefined, st)) await this.compactNow(id, { auto: true, trigger: "threshold", signal, step: st }).catch((e) => {
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
        } else if (steps === 1 && (mark = followUpMark(events))?.way === "summary") {
          // A follow-up to a summary with none prepared (the owner's choice): written now, the message its focus.
          if (!this.applyPrepared(id, events, undefined, st)) await this.compactNow(id, { auto: true, trigger: "follow_up", focus: mark!.focus, signal, step: st }).catch((e) => {
            if (signal.aborted) throw e;
            const rec = this.errors.capture("provider", e, { session: id, at: "follow-up summary" });
            this.append(id, "note", { kind: "compaction_failed", text: `The context was not summarized for the follow-up (${rec.message}); it goes on with it whole.` });
          });
          events = this.lineage(id);
        } else if (steps === 1 && mark?.way === "carry") {
          // A follow-up decided to go on in the whole context: no summary replaces it now.
        } else if (steps === 1 && this.cacheCold(id, events, st) && this.applyPrepared(id, events, undefined, st)) {
          // Back after the cache expired: the summary written while idle (or
          // ahead) replaces the history instead of the history being written again.
          events = this.lineage(id);
        } else if (!summaryFailed && (priced = this.priced(session, events, st, used))?.compact && events.some((e) => e.kind === "assistant") && worthSummarizing(summarizable(events))) {
          // Compaction by price: the summary is written in the background while
          // the steps go on, and put in place at the first step after it is
          // ready, the newest steps kept as they were (no tool result the model
          // has not answered yet is summarized away, and no step waits for it).
          if (this.applyPrepared(id, events, priced, st)) events = this.lineage(id);
          else this.prepare(id, st, false);
        } else if (!summaryFailed && used >= limit * (PREPARE_SHARE / COMPACT_SHARE)) {
          this.prepare(id, st);
        }
        // A context no warm cache holds any more (just compacted or cleared, expired),
        // the owner's request, or a pin past its age: this build's tools and prompt from this request on.
        // An instruction file edited since the prompt was rendered: compared again now (instructionsEdited),
        // and a prompt taken under a running turn by another session's request is this request's too.
        if (st.info.id === session.model && ((await this.instructionsEdited(session, st.info)) || this.heldElsewhere(id, st))) st = await this.step(session, session.model);
        const waits = st.info.id === session.model ? this.pins.waits(id) : undefined;
        if (waits === "now" || (waits && this.coldWhy(id, st.provider, st.info, events))) st = await this.step(session, session.model);
        if (await this.tellSwitch(id, events, st)) events = this.lineage(id);
        if (st.info.id === session.model && this.tellPrompt(session, events)) events = this.lineage(id);
        const messages = toMessages(events);
        let res: ProviderResult;
        let sentAt = 0;
        try {
          // A context with nothing to compact (a first long message, a fresh
          // summary and the prompts after it) cannot be made smaller: it is
          // sent unless it is over the window however its bytes are counted.
          const final = !worthSummarizing(summarizable(events));
          sentAt = Date.now();
          res = await this.call(id, st, messages, signal, partial, session, false, "turn", { tokens: this.whole(events, st), ...(final ? { least: this.least(events, st) } : {}) });
          sentAt = answeredAt.get(res) ?? sentAt;
        } catch (e) {
          // The session's model stayed overloaded: this turn goes on on its fallback, once, and the
          // next turn tries its own model first (its turn_start names it; tellSwitch tells each model).
          // The agent's route stayed out past the owner's rule: it goes on on the model the rule names, for good.
          if (e instanceof MovedByRule && signal.aborted) throw e.cause;
          if (e instanceof MovedByRule) {
            const now = this.store.session(id) ?? session;
            const from = now.model;
            const fromName = `${st.info.name} (${st.info.provider})`;
            const wasEffort = now.settings.effort;
            st = e.step;
            // The model and what it keeps of the session's settings (effort, speed) move together.
            const settings = carrySettings(now.settings, st.info);
            if (wasEffort) { const x = carriedEffort(wasEffort, st.info.efforts); if (x) settings.effort = x; }
            this.store.updateSession(id, { model: st.info.id, settings });
            this.emitSession(id);
            ownModel = st.info.id;
            const change = { why: e.why, from: fromName, to: `${st.info.name} (${st.info.provider})`, ms: e.ms, ...(e.extra ? { extra: e.extra } : {}), ...(wasEffort !== settings.effort ? { effort: { from: wasEffort, to: settings.effort } } : {}) };
            this.append(id, "note", { kind: "fallback", route_change: true, why: e.why, from, to: st.info.id, waited_ms: e.ms, text: routeNote(change) });
            this.measure(id, (h) => h.routeChanged?.(session, { ...change, fromModel: from, toModel: st.info.id }));
            continue;
          }
          if (e instanceof MovedToFallback && (signal.aborted || movedOn)) throw e.cause;
          if (e instanceof MovedToFallback) {
            movedOn = true;
            const from = st.info.name;
            st = e.step;
            const span = e.overloadedMs < 60_000 ? `${Math.max(1, Math.round(e.overloadedMs / 1000))} s` : `${Math.round(e.overloadedMs / 60_000)} min`;
            const said = e.why === "asked" ? `${from} is overloaded and asked for a wait longer than a turn waits` : `${from} has answered that it is overloaded for ${span}`;
            this.append(id, "note", { kind: "fallback", overloaded: true, why: e.why, from: session.model, to: st.info.id, waited_ms: e.overloadedMs, text: `${said}. This turn continues on ${st.info.name}; the next turn tries ${from} first.` });
            continue;
          }
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
            // Keep what the owner already saw of the reply, and each call it finished
            // streaming (a stop for a restart keeps the text only: the turn goes on).
            const kept = streamedItems(partial, this.parking.has(id) ? [] : st.tools.map((t) => t.name));
            if (kept.length) {
              this.append(id, "assistant", { blocks: kept, model: st.info.id, usage: emptyUsage(), stop: "interrupted" });
              replies++;
              // A kept call never ran: its result says so, and the history stays valid.
              for (const u of kept) if (u.type === "tool_use") {
                await settleNow(u)({ type: "tool_result", tool_use_id: u.id, is_error: true, content: stoppedBefore(this.stoppedBy.get(id)) });
              }
            }
          }
          throw e;
        }
        // A wait kept warm before this request is told by what it read (src/engine/cache-plans.ts).
        if (this.cachePlans.owes(id)) this.cachePlans.answered(id, { route: st.info.id, usage: res.usage, sentAt, compactedAt: events.findLast((e) => e.kind === "compaction")?.ts, cause: cacheBreaks.get(res) });
        for (const h of allHooks()) await h.afterResponse?.(session, res, messages);
        // (Right before the step's own writes: the hold's notice comes a moment before the lock is taken.)
        if (this.store.pacing?.()) await this.store.clear(signal);
        const u: Usage = res.usage; // priced by the registry from the model's listed price
        this.learn(id, st, events, u);
        usage = addUsage(usage, u);
        // (What the reply cost is written with the reply, as one commit: below. A declined one stores it here.)
        if (res.stop === "refusal") { this.store.addUsage(id, u); this.emitSession(id); }

        if (res.stop === "refusal") {
          this.append(id, "assistant", { blocks: res.blocks, model: st.info.id, usage: u, stop: "refusal", stop_details: res.stop_details ?? null });
          replies++;
          const fb = session.settings.fallback;
          if (fb && fb !== st.info.id && !fellBack && !this.fallbackCrosses(id, fb)) {
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
        // One commit for the step: what the reply cost and the reply. The frames go out once it is stored, in the order they did.
        const stored = this.store.atomic(id, () => {
          this.store.addUsage(id, u);
          return this.store.append(id, "assistant", { blocks, model: st.info.id, usage: u, stop: res.stop });
        });
        this.emitSession(id);
        this.emitEvent(stored);
        replies++;

        if (res.stop === "model_context_window_exceeded") {
          await this.compactNow(id, { auto: true, trigger: "overflow", signal, step: st });
          continue;
        }
        const uses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use" && b !== cut);
        ctx.room = Math.max(0, st.info.context - (u.input + u.cache_read + u.cache_write + u.output));
        ctx.inline = this.inlineOf(session, st, u);
        if (uses.length || cut) {
          if (uses.length) this.status(id, { kind: "tool", since: Date.now(), names: [...new Set(uses.map((u) => u.name))] });
          const spent = closing || (budget > 0 && steps >= budget);
          // A step that runs past the cache's lifetime keeps it by its plan.
          // (Its history as the next request projects it: the notes this request's hooks stored are in it.)
          const sentWith = () => toMessages(this.lineage(id).filter((e) => e.seq < stored.seq));
          const planned = uses.length && !spent ? this.cachePlans.tool(id, st, events, sentWith, this.toolShape(id, uses), sentAt, u) : undefined;
          try {
          await batch(uses.map((u, index) => (spent ? Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: u.id, is_error: true, content: closing ? (closingCap ? CAP_SPENT : AGENT_BUDGET_SPENT) : BUDGET_SPENT }) : this.tracked(id, u, this.runTool(session, st.tools, u, { ...ctx, reply: { seq: stored.seq, index } }))).then(settle(u))));
          } finally { planned?.(); }
          if (cut) await settleNow(cut)({ type: "tool_result", tool_use_id: cut.id, is_error: true, content: CUT_CALL });
          this.status(id, { kind: "idle" });
          for (const h of allHooks()) await (async () => h.stepDone?.(session))().catch((e) => this.errors.capture("server", e, { hook: "stepDone", session: id }));
          if (signal.aborted) { reason = this.parking.has(id) ? "restart" : "interrupted"; break; }
        }
        // The budget's report is written: the turn ends here, whatever the reply asked for.
        if (closing && res.stop !== "pause_turn") { reason = "budget"; break; }
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
        } catch (e) {
          // A write of this step landed on a hold of the store's write lock all the same (the loop
          // reached it later than the hold's notice allows for) and was refused. Nothing of the step
          // is stored yet (the branch ends where it did): the turn waits for the lock to be given up
          // and takes the step again. It does not end for a hold that ends.
          // (The same for a write that found the disk full: the turn waits for room.)
          if (!(refusedWrite(e) || diskFull(e)) || signal.aborted || !this.store.pacing?.() || this.store.session(id)?.head !== head0 || ++retaken > 3) throw e;
          steps = steps0;
          await this.store.clear(signal);
        }
      }
    } catch (e) {
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : "error";
      // (A write the store refused is said as that, not by SQLite's name for it.)
      if (!signal.aborted) { failed = refusedWrite(e) || diskFull(e) ? "store_refusing" : typeof (e as any)?.code === "string" ? (e as any).code : undefined; throw e; }
    } finally {
      const by = this.stoppedBy.get(id);
      this.stoppedBy.delete(id);
      const providerWaitMs = this.running.get(id)?.providerWaitMs ?? 0;
      this.store.appendOrLater(id, "turn_end", { reason, usage, ms: Math.max(0, Date.now() - t0 - providerWaitMs), ...(providerWaitMs ? { provider_wait_ms: providerWaitMs } : {}), steps: replies, tools: toolResults, tool_errors: toolErrors, tool_denied: toolDenied, ...(failed ? { code: failed } : {}), ...(by && reason === "interrupted" ? { stopped_by: by } : {}) }, (e) => this.emitEvent(e));
      // Between turns, a context past the preparing share gets its summary ready.
      if (!signal.aborted) {
        const events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        if (this.used(events, st) >= limit * (PREPARE_SHARE / COMPACT_SHARE)) this.prepare(id, st);
        this.scheduleIdle(id, st);
      }
      // The first reply is in: the session gets a title that says its task.
      if (!this.parking.has(id)) try { this.retitle(id); } catch (e) { this.errors.capture("server", e, { session: id, at: "title" }); }
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, reason))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  // The calls of a turn whose results were owed when the store took no writes: what each was, and whether it was stopped.
  private unsaved = new Map<string, { what: string; stopped: boolean }[]>();
  // The calls of each running turn that have not returned yet.
  private inflight = new Map<string, Map<string, ToolUseBlock>>();
  // A call an MCP App in the transcript made of a tool of its own server
  // (src/server/routes/mcp-apps.ts): through the owner's hooks and the
  // permission gate as a model's call goes, under an id of its own. Nothing
  // of it enters the history; the app's card shows it.
  // `asker`: the app, as its approval card names it ("The board app").
  runForApp(id: string, tool: Tool, input: unknown, callId: string, signal: AbortSignal, asker: string): Promise<ToolResultBlock> {
    const session = this.store.session(id);
    if (!session) return Promise.resolve({ type: "tool_result", tool_use_id: callId, content: "The session is gone.", is_error: true });
    const seen = this.seen.get(id) ?? new Map();
    this.seen.set(id, seen);
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id), parentId: session.parent_id ?? undefined, asker,
      questionChanged: () => this.bus.emit({ t: "questions", pending: allPendingQuestions() }) };
    const u: ToolUseBlock = { type: "tool_use", id: callId, name: tool.name, input: input ?? {} };
    return this.runTool(session, [tool], u, ctx).finally(() => this.shown.delete(callId));
  }

  // How a call's error result came about: it ran and failed, or a gate refused it.
  verdictOf(r: ToolResultBlock): "failed" | "denied" | undefined { return this.verdicts.get(r); }

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
    // Built when the stop comes: a stop for a daemon restart says so, any other stop names who made it
    // (`running`: the tool had started, so it may have partly run).
    const interrupted = (running = false): ToolResultBlock => {
      const by = this.stoppedBy.get(ctx.sessionId);
      return {
        type: "tool_result", tool_use_id: u.id,
        ...(this.parking.has(ctx.sessionId) ? cutResult(ctx.sessionId, u) : { content: running ? stoppedWhile(by) : stoppedBefore(by), is_error: true }),
      };
    };
    if (ctx.signal.aborted) return interrupted();
    const tool = tools.find((t) => t.name === u.name);
    // A tool an upgrade took away while the session ran says so: the model called it before.
    if (!tool) {
      // A name that is another tool's by case or as its job's alias in another harness runs as that
      // tool (the stored call keeps the name the model wrote), and its result says so once.
      const removed = this.pins.removed(session.id, u.name);
      const found = removed ? undefined : resolveToolName(u.name, tools, u.input);
      if (found && "as" in found) {
        const r = await this.runTool(session, tools, { ...u, name: found.as.name }, ctx);
        const note = resolvedNote(u.name, found.as.name);
        r.content = typeof r.content === "string" ? `${r.content}\n\n${note}` : [...r.content, { type: "text", text: note }];
        r.resolved_as = found.as.name;
        return r;
      }
      const none: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: removed ? `${u.name} was removed by an upgrade of Keel and is no longer available. Use the tools you have now.` : noSuchTool(u.name) + (await unknownToolHint(u.name, tools, session.id).catch(() => "")) + (pauseNote(u.name, tools) || closestNote(found && "near" in found ? found.near : [])), is_error: true };
      // A failed call like any other: it has its span and its row in the tools
      // table under the name the model gave, and the turn counts it.
      this.measure(session.id, (h) => h.toolRan?.(session, { id: u.id, tool: { name: u.name, description: "", input_schema: {}, readOnly: true, run: async () => none } as Tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id } }, none, { ms: 0, outcome: "error" }));
      this.verdicts.set(none, "failed");
      return none;
    }
    const callTool = (name: string, input: any, id: string, signal?: AbortSignal): Promise<ToolResultBlock> => {
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
      return this.runTool(session, tools, { type: "tool_use", id, name, input }, { ...ctx, nestedIn: top, ...(signal ? { signal } : {}) })
        .finally(() => { mine.delete(id); if (!mine.size && this.nested.get(key) === mine) this.nested.delete(key); });
    };
    const offers = (name: string) => tools.some((t) => t.name === name);
    const call: ToolCall = { id: u.id, tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id, callTool, offers } };
    // An interrupt answers at once, whether or not a gate or the tool honors the signal.
    // The listener goes when the call settles: the turn's signal is shared by all its calls.
    let onStop = () => {};
    const stopped = new Promise<null>((r) => { onStop = () => r(null); ctx.signal.addEventListener("abort", onStop, { once: true }); });
    let result: ToolResultBlock;
    // Measured from dispatch: a call that never ran (denied, stopped at its gate) has no row.
    let t0: number | undefined;
    // The tool's run, once dispatched: what the call added to its process's environment lives until it settles.
    let dispatched: Promise<unknown> | undefined;
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
      if (!h || (h.from === undefined && !h.skipped && !h.failed?.length)) return r;
      if (h.from !== undefined) {
        const note = hookChanged(call.input, t0 !== undefined);
        r.content = typeof r.content === "string" ? `${r.content}\n\n${note}` : [...r.content, { type: "text", text: note }];
      }
      const shown = this.shown.get(u.id);
      this.shown.set(u.id, { ...(shown && typeof shown === "object" ? shown : {}), hook: { ...(h.from !== undefined ? { input: call.input } : {}), ...(h.skipped ? { allowed: h.allowed ?? "" } : {}), ...(h.failed?.length ? { failed: h.failed } : {}) } });
      return r;
    };
    // Refused before it ran (the owner's answer, a rule, the judge): the model is told why.
    const denied = (why: string): ToolResultBlock => {
      const r: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: why, is_error: true };
      this.verdicts.set(r, "denied");
      return told(r);
    };
    // A path on a mount that stopped answering holds the loop for whoever stats it, a Stop included: the paths
    // a call names are asked about off the loop first, within a limit and the turn's signal (src/tools/fs-bound.ts).
    // A call that runs on another machine names that machine's paths.
    let asked: unknown;
    const answering = async (input: unknown): Promise<ToolResultBlock | undefined> => {
      if (session.machine || asked === input) return undefined;
      asked = input;
      const none = await answers(callPaths(call, input), { signal: ctx.signal });
      if (!none) return undefined;
      if (none.why === "stopped" || ctx.signal.aborted) {
        const r = interrupted();
        // A stop that came while a path had not answered says so: the read did not finish, and why.
        if (typeof r.content === "string" && none.waited_ms >= 1000) r.content += ` ${stoppedWaiting(none)}`;
        return r;
      }
      return denied(unansweredText(none));
    };
    let thrown: Error | undefined;
    try {
      { const no = await answering(call.input); if (no) return no; }
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
      // A call whose input is not the tool's (a field missing, one it does not have, a value of the wrong kind) is
      // answered with what is wrong and the fields the tool has, before any gate sees it, any path is asked about and it runs. It
      // is judged after the owner's hooks: one that fills a field in has made the call right. The call is a
      // failed one like any other: it has its span and its row in the tools table.
      const invalid = inputProblem(tool, call.input);
      if (invalid) {
        const bad: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: invalid, is_error: true };
        this.measure(session.id, (h) => h.toolRan?.(session, call, bad, { ms: 0, outcome: "error" }));
        this.verdicts.set(bad, "failed");
        return told(bad);
      }
      // (A hook may have named other paths.)
      { const no = await answering(call.input); if (no) return no; }
      const authorizations: ToolAuthorization[] = [];
      for (const h of allHooks()) {
        if (!h.beforeTool) continue;
        const gate = Promise.resolve(h.beforeTool(session, call));
        gate.catch(() => {});
        const g = await Promise.race([gate, stopped]);
        if (ctx.signal.aborted) return interrupted();
        if (!g) continue;
        if ("deny" in g) return denied(g.deny);
        // (Marked for the transcript: the call did not run, and says so on its line.)
        if ("answer" in g) { this.shown.set(u.id, { ledger: true }); return told({ type: "tool_result", tool_use_id: u.id, content: g.answer }); }
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
      for (const h of allHooks()) { const x = h.execInput?.(session, call); if (x !== undefined) input = x; }
      { const no = await answering(input); if (no) return no; }
      const authorizationError = authorizations.length ? () => authorizations.find((a) => !a.valid(call, input))?.deny : undefined;
      const deny = authorizationError?.();
      if (deny) return denied(deny);
      const runCtx = authorizationError ? { ...call.ctx, authorizationError } : call.ctx;
      // A dispatch set by a hook runs the call elsewhere (another machine's hands).
      t0 = Date.now();
      // What the call sends out is the call's, in the outward ledger (src/safety/egress.ts).
      const run = outward({ tool: u.name, call: u.id, session: session.id }, () => (runCtx.dispatch ? runCtx.dispatch(tool, input, runCtx) : tool.run(input, runCtx)));
      dispatched = run;
      // After a stop the tool may still fail on its way out; that is expected.
      run.catch(() => {});
      const out = await Promise.race([run, stopped]);
      if (!out) return ran(interrupted(true), "interrupted");
      // No tool stores more text than the cap (its own, when it bounds its
      // result itself): the rest is in a file the result names. An image
      // enters the history within what every provider takes.
      // A failed call keeps the whole cap: its error is what the model acts on.
      const held = await capResult(out.content, tool.resultCap ?? OUTPUT_CAP, runCtx.dispatch ? undefined : ctx.spillDir, u.name, out.is_error || tool.resultCap !== undefined || runCtx.dispatch ? undefined : ctx.inline);
      result = { type: "tool_result", tool_use_id: u.id, content: await fitToolImages(held, ctx.spillDir, !!runCtx.dispatch), is_error: out.is_error || undefined };
      if (out.shown !== undefined) this.shown.set(u.id, out.shown);
      ran(result, result.is_error ? "error" : "ok");
    } catch (e) {
      if (ctx.signal.aborted) return t0 === undefined ? interrupted() : ran(interrupted(true), "interrupted");
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
      // What the call added for the process it starts is not kept past the call, whether it started one or not (a
      // tool that ran no command, one that threw, a later gate's refusal); a run a stop left going keeps it until
      // it settles, for a command it still starts.
      // (A call a program made has no result of its own in the history: what its rules decided is not kept.)
      if (call.ruled && !ctx.nestedIn) {
        if (this.ruled.size >= 4096) this.ruled.delete(this.ruled.keys().next().value!);
        this.ruled.set(u.id, call.ruled);
      }
      if (dispatched) void dispatched.then(() => dropCallEnv(session.id, call.id), () => dropCallEnv(session.id, call.id));
      else dropCallEnv(session.id, call.id);
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
  // A summary written ahead that failed for another cause (refused, empty, a
  // provider error past the driver's retries) may come out the next time, but
  // each try reads the whole context: tried again on the same context (the
  // same checkpoint and model) only after 2^k of its steps, k the failures so
  // far (2, 4, 8, ...). The tries over S steps are then about log2(S), not S,
  // and a failure that passes (an overload) is tried again two steps later.
  // Kept in memory: a restart tries again at once, once.
  private summaryBackoff = new SessionMap<{ key: string; at: number; fails: number }>(256);
  private summaryHeld(id: string, events: readonly StoredEvent[], st: Step): boolean {
    const b = this.summaryBackoff.get(id);
    return !!b && b.key === this.gaveUpKey(events, st) && stepsSince(events) < b.at + 2 ** b.fails;
  }
  private summaryMissed(id: string, events: readonly StoredEvent[], st: Step) {
    const key = this.gaveUpKey(events, st);
    const b = this.summaryBackoff.get(id);
    this.summaryBackoff.set(id, { key, at: stepsSince(events), fails: b?.key === key ? b.fails + 1 : 1 });
  }
  private giveUp(id: string, events: readonly StoredEvent[], st: Step, covered: StoredEvent | undefined, over: boolean, e: unknown) {
    if (!covered || !SUMMARY_GAVE_UP.has((e as any)?.code)) return;
    const had = this.gaveUpFor(id, events, st);
    const at = had ? had.at : events.findLastIndex((x) => x.id === covered.id);
    if (at < 0) return;
    this.gaveUp.set(id, { key: this.gaveUpKey(events, st), at, id: events[at]!.id, tried: new Set([...(had?.tried ?? []), over ? "window" as const : "line" as const]), error: e as Error });
  }

  // What each waiting session does with its prompt cache (src/engine/cache-plans.ts).
  readonly cachePlans: CachePlans;

  // Summaries being written ahead. Each can be stopped, and names the event it covers up to.
  private preparing = new Map<string, { abort: AbortController; covered: string }>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // When the prepared summary's request read this context's cache on the
  // model's route: one written for this branch on the same prefix (preparedWarm).
  // (Or a request that kept it warm while the session waited: src/engine/cache-plans.ts.)
  private preparedMs(id: string, events: readonly StoredEvent[], st: Step): number {
    const row = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    const prepared = row && events.some((e) => e.id === row.covered) ? preparedWarm(JSON.parse(row.data), st.info.id) : 0;
    return Math.max(prepared, this.cachePlans.warmedAt(id, st.info.id));
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
    // Subagents' copies of a parent's earlier prompt that no cache holds any more (Engine.shelter).
    this.prompts.dropCopies(Date.now() - LONGEST_KEEP_MS);
    const routes = new Map<string, Promise<{ provider: Provider; info: ModelInfo }>>();
    const route = (model: string) => routes.get(model) ?? routes.set(model, this.providers.resolve(model)).get(model)!;
    // (A session another harness runs is not Keel's to plan or compact: src/integrations/outside/service.ts.)
    for (const { id } of this.store.db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE updated > ? AND archived = 0 AND outside IS NULL").all(since)) {
      const s = this.store.session(id);
      if (s?.outside) continue;
      // A session parked on a wait gets its cache plan again (its step is built for it: few wait).
      if (s && !this.running.has(id) && !this.held.has(id) && this.waitShape?.(id)) {
        let planned = false;
        try { const st = await this.step(s, s.model); planned = !this.running.has(id) && this.planPark(this.store.session(id) ?? s, st); }
        catch (e) { this.errors.capture("provider", e, { session: id, at: "cache plan after a restart" }); }
        if (planned || s.parent_id) continue;
      }
      if (!s || this.running.has(id) || s.parent_id || s.settings.idle_compact === false) continue;
      try {
        const { provider, info } = await route(s.model);
        // No answer on this route can show a lifetime that leaves idle time to use.
        if (longestSure(provider.wire) < 2 * IDLE_MARGIN_MS) continue;
        let facts = this.idleFacts(id);
        if (!facts || facts.head !== s.head || facts.model !== info.id || facts.wire !== provider.wire) {
          // Its events are read: a session that is not in memory is brought in off the loop first
          // (this pass and the start's own pass over the same sessions run side by side).
          if (!this.store.isKept(id)) {
            await this.store.warm(id, false);
            if (this.running.has(id) || this.store.session(id)?.head !== s.head) continue;
          }
          // And the bodies its count reads (its context from the last checkpoint on), off the loop too.
          const line = this.lineage(id);
          await this.warmContext(id, line);
          if (this.running.has(id) || this.store.session(id)?.head !== s.head) continue;
          facts = this.readIdleFacts(s, provider.wire, info.id, line);
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
  private readIdleFacts(session: Session, wire: Provider["wire"], model: string, events: readonly StoredEvent[] = this.lineage(session.id)): IdleFacts {
    const keep = retention(wire, events, model);
    const facts: IdleFacts = { head: session.head, model, wire: wire ?? "", used: contextTokens(events, model).used, warm: lastWarm(events, model), sure: keep.sure, max: keep.max };
    // (Kept so a start reads no events for it; one that is lost is read again: written with the next commit, src/core/side.ts.)
    this.store.side.later("a context's idle facts", () => void this.store.db.query("INSERT OR REPLACE INTO idle_facts (session_id, head, model, wire, used, warm, sure, max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(session.id, facts.head, facts.model, facts.wire, facts.used, facts.warm, facts.sure, facts.max));
    return facts;
  }

  // What the session waits on now (set by the automation module): a wait it set, with its due
  // time, deadline and how long its earlier waits of that kind lasted.
  waitShape?: (id: string) => WaitShape | undefined;

  // A session's waits were settled with no wake (cancelled, its agent stopped): its plan ends with nothing left to wait for.
  waitsSettled(id: string) {
    if (!this.waitShape?.(id)) this.cachePlans.end(id, "cancelled");
  }

  // A session parked on a wait: its cache plan (src/engine/cache-plan.ts). False when it waits on nothing or has no plan.
  private planPark(session: Session, st: Step, step: () => Promise<Step> = async () => st): boolean {
    // A session the owner (or another stop) holds starts nothing, and nothing is sent for it.
    if (this.held.has(session.id)) return false;
    const shape = this.waitShape?.(session.id);
    if (!shape) return false;
    const events = this.lineage(session.id);
    const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
    const used = this.used(events, st);
    // Its wake compacts anyway, from a summary that holds: a warm cache would serve nothing.
    if (used >= limit) {
      const have = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(session.id);
      if (have && preparedHolds(events, have.covered, false, JSON.parse(have.data)) && this.preparedFits(session.id, events, JSON.parse(have.data), st)) return true;
    }
    // A summary is a choice where idle compaction would make one: a long context worth summarizing.
    const summary = session.settings.idle_compact !== false && used >= idleMinTokens(limit) && worthSummarizing(summarizable(events)) && !this.summaryGaveUp(session.id, events, st, false);
    const out = Math.ceil(SUMMARY_ROOM_BYTES(st) / bytesPerToken(st.info.id));
    // (No plan where nothing tells how long the route keeps the cache, or what it costs: idle compaction's rules hold.)
    return !!this.cachePlans.park(session, st, events, shape, {
      tokens: used, step, messages: () => toMessages(this.lineage(session.id)),
      ...(summary ? { summaryTokens: { out, after: Math.ceil(this.prefixBytes(st) / bytesPerToken(st.info.id)) + out } } : {}),
    });
  }

  // A tool step: how long steps of the same tool took in this session, and its own time limit.
  private toolShape(id: string, uses: ToolUseBlock[]): WaitShape {
    const name = uses[0]!.name;
    let past: number[] = [];
    try {
      past = this.store.db.query<{ ms: number }, [string, string]>("SELECT ms FROM telemetry_tools WHERE session_id = ? AND tool = ? AND ms IS NOT NULL ORDER BY ts DESC LIMIT 20").all(id, name).map((r) => r.ms);
    } catch {} // a store without telemetry
    const limits = uses.map((u) => Number((u.input as any)?.timeout ?? (u.input as any)?.timeout_ms)).filter((x) => Number.isFinite(x) && x > 0);
    return { kind: `tool:${name}`, ...(past.length ? { past } : {}), ...(limits.length === uses.length ? { deadline: Date.now() + Math.max(...limits) } : {}) };
  }

  // After a turn: a context big enough gets its summary prepared shortly
  // before its cache lifetime ends, unless the session works again before then.
  private scheduleIdle(id: string, st: Step) {
    const session = this.store.session(id);
    // A session that waits on a wait it set (an agent's or the owner's) gets a cache plan instead.
    if (session && this.planPark(session, st)) {
      clearTimeout(this.idleTimers.get(id));
      this.idleTimers.delete(id);
      return;
    }
    // An agent's context is not prepared while idle: an ended agent is seldom
    // taken up again (one that waits has a plan above).
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
        // The timer fires when the session has been idle for minutes, so its bodies were given back:
        // they are read off the loop first (the summary's count and checks read every one of them).
        await this.store.warm(id, false);
        await this.warmContext(id);
        if (!idle()) return;
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
    if (!covered || !worthSummarizing(events) || this.summaryGaveUp(id, events, st, false) || this.summaryHeld(id, events, st)) return;
    const have = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    if (have && preparedHolds(events, have.covered, idle, JSON.parse(have.data)) && this.preparedFits(id, events, JSON.parse(have.data), st)) return;
    const abort = new AbortController();
    this.preparing.set(id, { abort, covered: covered.id });
    const session = this.store.session(id)!;
    const before = this.used(events, st);
    const t0 = Date.now();
    this.summarize(id, st, session, events, abort.signal)
      .then(async (res) => {
        this.emitSession(id);
        const summary = res.summary;
        if (!summary) {
          if (!abort.signal.aborted) this.summaryMissed(id, events, st);
          return;
        }
        this.summaryBackoff.delete(id);
        const settled = await this.settled(events, summary);
        const data = { mode: "summary", ...(res.parts ? { parts: res.parts, outputs_shortened: res.clipped, ...(res.steps_left_out ? { steps_left_out: res.steps_left_out } : {}) } : {}), ...timed(() => "making a compaction's checkpoint (its kept messages, trail and probe)", () => checkpointData(events, summary, this.wordsBudget(st), settled)), auto: true, ahead: !idle, trigger: idle ? "idle" : "threshold", covered: covered.id, tokens_before: before, usage: res.usage, model: st.info.id, prepared_ms: Date.now(), duration_ms: Date.now() - t0 };
        if (abort.signal.aborted || !this.preparationHolds(id, covered.id, data)) return;
        this.store.db.run("INSERT OR REPLACE INTO prepared_summaries (session_id, covered, data, ts) VALUES (?, ?, ?, ?)", [id, covered.id, JSON.stringify(data), Date.now()]);
      })
      .catch((e) => {
        if (abort.signal.aborted) return;
        this.giveUp(id, events, st, covered, false, e);
        this.summaryMissed(id, events, st);
        // A summary made ahead that could not reach the provider is made again later: nothing failed that anyone needs to read.
        if (unreachable(e)) return;
        this.errors.capture("provider", e, { session: id, at: "preparing a summary" });
      })
      .finally(() => { if (this.preparing.get(id)?.abort === abort) this.preparing.delete(id); });
  }

  // Compaction by price (src/engine/price-compact.ts): whether this agent's
  // context is worth a summary now, priced over the steps it is expected to
  // take. Only for an agent whose tree runs it (its own setting, or its root's:
  // a trial's arm sets the root's), and only below the window's line, which
  // compacts anyway. Undefined when it cannot be priced.
  private readonly priceFacts = new PriceFacts(() => this.store.priceFactsOff, (e) => this.errors.capture("server", e, { at: "reading the ledger for compaction by price" }));
  private agentKinds = new Map<string, string | undefined>();
  private priceOn(session: Session): boolean {
    if (!session.parent_id) return false;
    for (let s: Session | undefined = session, up = 0; s && up < 32; s = s.parent_id ? this.store.session(s.parent_id) : undefined, up++) {
      if (s.settings.compact_by_price !== undefined) return s.settings.compact_by_price === true;
    }
    return false;
  }
  private priced(session: Session, events: readonly StoredEvent[], st: Step, used: number): (PriceVerdict & { ahead: Residual; delay: number; keep: number }) | undefined {
    const price = st.info.price;
    if (!price || !this.priceOn(session)) return undefined;
    const bpt = bytesPerToken(st.info.id);
    const tokens = (bytes: number) => Math.ceil(bytes / bpt);
    const prefix = tokens(this.prefixBytes(st));
    if (used <= prefix) return undefined;
    // Its steps so far, and the context each read since the last checkpoint (what a step adds).
    let done = 0;
    const since: { ts: number; prompt: number }[] = [];
    const cp = checkpointAt(events).at;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.kind !== "assistant") continue;
      done++;
      const u = e.data.usage;
      if (i > cp && u && e.data.model === st.info.id) since.push({ ts: e.ts, prompt: (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0) });
    }
    const growth = taskShape(since.slice(-20).map((s) => s.prompt)).growth;
    const facts = this.priceFacts.get();
    const sum = facts?.summaries.get(st.info.id);
    // The summary's size and time as this model's summaries had them; else its room (the most it may be).
    const out = sum?.out ?? tokens(SUMMARY_ROOM_BYTES(st));
    const gaps = since.slice(-11).map((s, k, a) => (k ? s.ts - a[k - 1]!.ts : 0)).slice(1).filter((g) => g > 0).sort((a, b) => a - b);
    const stepMs = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;
    // The steps the summary takes to be written while the agent works: it is in place at the next one at the earliest.
    const delay = Math.max(1, sum?.ms && stepMs ? Math.ceil(sum.ms / stepMs) : 1);
    // (The agents table is made by the automation: an engine without it prices the agent as of no kind.)
    if (!this.agentKinds.has(session.id)) this.agentKinds.set(session.id, this.store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() ? this.store.db.query<{ type: string }, [string]>("SELECT type FROM agents WHERE session_id = ? LIMIT 1").get(session.id)?.type : undefined);
    const ahead = residual(done, delay, { type: this.agentKinds.get(session.id), model: st.info.id }, facts?.lives ?? []);
    const ask = { used, prefix, growth, summaryIn: tokens(utf8Bytes(summaryPrompt())), summaryOut: out, ahead, price, long: this.asksLong(session.id, st) };
    // A bound first: even a summary that kept nothing but the prefix would not pay.
    const bound = priceCompaction({ ...ask, keep: prefix + out });
    if (!bound?.compact) return bound && { ...bound, ahead, delay, keep: prefix + out };
    // What the summary keeps: the words kept verbatim, the fixed context, the trail and the steps taken while it is written.
    const kept = keptMessages(events, this.wordsBudget(st));
    const keptBytes = [...kept.owner_messages, ...(kept.other_messages ?? [])].reduce((n, t) => n + utf8Bytes(t), 0) + fixedContext(events).reduce((n, f) => n + utf8Bytes(f.text), 0) + TRAIL_BYTES;
    // And what the agent reads again after it: the files it wrote since the last checkpoint, at their newest read.
    const span = events.slice(Math.max(0, checkpointAt(events).keepFrom));
    const written = new Set<string>();
    for (const e of span) if (e.kind === "assistant") for (const b of e.data.blocks ?? []) {
      const p = b.type === "tool_use" ? b.input?.file_path ?? b.input?.path : undefined;
      if (typeof p === "string" && ["content", "new_string", "edits", "patch"].some((k) => b.input?.[k] !== undefined)) written.add(p);
    }
    const keep = prefix + out + tokens(keptBytes + rereadBytes(span, [...written])) + delay * growth;
    const v = priceCompaction({ ...ask, keep });
    return v && { ...v, ahead, delay, keep };
  }

  // A summary's statements checked against every message of the branch it
  // summarizes (settle). The messages before the last checkpoint are in
  // nobody's memory, so the check is made on the read thread from the stored
  // events; undefined where it cannot be (no thread, a part of a branch):
  // checkpointData then makes it in place.
  private async settled(lineage: readonly StoredEvent[], summary: string): Promise<Settled | undefined> {
    const ask = this.store.settleOff && settleAsk(lineage, summary);
    if (!ask) return undefined;
    try {
      return await this.store.settleOff!(ask);
    } catch (e) {
      this.errors.capture("server", e, { at: "settling a summary off the loop", session: ask.session });
      return undefined;
    }
  }

  // The context a prepared summary leaves fits under the compaction line with room for the next
  // steps (src/engine/compact.ts preparedFits), on the model the session's next step uses.
  private preparedFits(id: string, events: readonly StoredEvent[], data: Record<string, unknown>, st?: Step): boolean {
    const session = this.store.session(id);
    if (!session) return false;
    const info = st?.info ?? this.providers.current().find((m) => m.id === session.model);
    // A model not listed now: its window is unknown here, and the turn that reaches its line decides.
    if (!info) return true;
    return preparedFits(events, data, info.id, session.settings.compact_at ?? Math.floor(info.context * COMPACT_SHARE));
  }

  private preparationHolds(id: string, covered: string, data?: { statements_done?: string[] }): boolean {
    const s = this.store.session(id);
    return !!s && !s.archived && !this.draining && preparedHolds(this.lineage(id), covered, false, data);
  }

  // Asked at every frame of a session whose summary is being prepared (it is
  // idle meanwhile, and its rows may have been given back): whether the event
  // the summary covers up to is still on the branch after its last checkpoint
  // is looked for from the branch's end back, so nothing is brought in for it.
  private dropObsolete(id: string) {
    const p = this.preparing.get(id);
    if (!p || p.abort.signal.aborted) return;
    const s = this.store.session(id);
    let holds = false;
    if (s && !s.archived && !this.draining) for (const e of this.store.back(id)) {
      if (e.kind === "compaction") break;
      if (e.id === p.covered) { holds = true; break; }
    }
    if (!holds) p.abort.abort();
  }

  // The prepared summary as a checkpoint, when it covers part of this branch
  // after its last checkpoint. The events since stay verbatim after it.
  // `price`: put in place by compaction by price, which says so with what it priced.
  private applyPrepared(id: string, events: readonly StoredEvent[], price?: NonNullable<ReturnType<Engine["priced"]>>, st?: Step): boolean {
    const row = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    if (!row) return false;
    const data = JSON.parse(row.data);
    if (price) Object.assign(data, { trigger: "price", price: priceData(price) });
    if (!preparedHolds(events, row.covered, false, data)) {
      // Written for another branch: kept for when that branch is shown again.
      // One this branch has passed (a checkpoint came after it) serves no more.
      if (events.some((e) => e.id === row.covered) || !this.store.event(row.covered)) this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
      return false;
    }
    // What came after it outgrew it (preparedFits): it serves no more on this branch, whose history
    // after it only grows, and a fresh summary is written in its place (the caller's, or prepared ahead).
    if (!this.preparedFits(id, events, data, st)) {
      this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
      return false;
    }
    this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
    const ev = this.append(id, "compaction", data);
    this.emitSession(id);
    const session = this.store.session(id);
    if (session) void this.compacted(session, ev);
    return true;
  }

  // Where a follow-up to a finished agent starts (src/engine/follow-up.ts
  // decides): its context, the summary prepared while it was idle, or a
  // capsule of its work. A capsule, or a prepared summary, is put in place
  // here, before the message is stored. Going on whole, or a summary the
  // owner chose with none prepared, is said by `mark`: the sender stores it
  // with the message (`follow_up` in its meta), and the turn that message
  // opens reads it at its first step (followUpMark), on this daemon or the
  // next. What was chosen and why is kept with the agent's record and told
  // in its parent's activity. `report`: the agent's reports since its last
  // checkpoint, newest first (src/automation/agents.ts, capsuleReport).
  async followUp(id: string, o: { title: string; report: string; tasks: number; since: number; message: string; ended: "completed" | "failed" | "stopped" | "incomplete"; force?: Way }): Promise<(FollowUpPlan & { mark?: "carry" | "summary" }) | undefined> {
    const session = this.store.session(id);
    if (!session || this.running.has(id)) return undefined;
    await this.warmContext(id);
    await countPaced(this.lineage(id), session.model);
    const st = await this.step(session, session.model);
    if (this.running.has(id)) return undefined;
    const events = this.lineage(id);
    const model = st.info.id, bpt = bytesPerToken(model);
    const tokens = (bytes: number) => Math.ceil(bytes / bpt);
    const used = this.used(events, st);
    // A wire that does not say how long it keeps a cache may still hold it up to the longest it may (cacheCold).
    const ret = retention(st.provider.wire, events, model);
    const cache = cacheState({ touched: lastWarm(events, model, this.preparedMs(id, events, st)), now: Date.now(), own: st.provider.caching?.life, sure: ret.sure, max: ret.max, margin: marginOf });
    const warm = cache === "warm", maybe = cache === "maybe";
    // The task it finished: the context each of its steps read on this model.
    const ctx = events.filter((e) => e.seq > o.since && e.kind === "assistant" && e.data.model === model && e.data.usage).map((e) => (e.data.usage.input ?? 0) + (e.data.usage.cache_read ?? 0) + (e.data.usage.cache_write ?? 0));
    const shape = taskShape(ctx);
    const facts = { used, prefix: tokens(this.prefixBytes(st)), warm, ...(maybe ? { maybe } : {}), long: this.asksLong(id, st), price: st.info.price, steps: shape.steps, growth: shape.growth, ended: o.ended, force: o.force };
    // The owner chose that it goes on whole: no capsule is made to be priced.
    if (o.force === "carry") return { ...decideFollowUp({ ...facts, capsule: 0, reread: 0 }), mark: "carry" };
    // The capsule: its report, and the story of the checkpoint before it
    // verbatim, inside the summary settle() makes (the statements that
    // checkpoint carried stay above it, as the model reads them).
    const cp = checkpointAt(events);
    const prev = cp.at >= 0 && events[cp.at]!.data.mode === "summary" ? String(events[cp.at]!.data.summary ?? "") : "";
    const text = capsuleText({ ...o, before: prev ? storyOf(prev) : undefined });
    const PLACE = "\u0000capsule\u0000";
    const settled = (await this.settled(events, PLACE)) ?? settle(events, PLACE, events[cp.at]?.data.statements ?? []);
    if (this.running.has(id) || this.store.session(id)?.head !== events.at(-1)?.id) return undefined;
    const story = { ...settled, summary: settled.summary.replace(PLACE, () => text) };
    const capsule = { ...timed(() => "making a follow-up's capsule (its kept messages and trail)", () => checkpointData(events, text, this.wordsBudget(st), story)), capsule: true };
    const capBytes = messagesBytes([summaryMessage(capsule)], model);
    const prepared = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    const ready = prepared && preparedHolds(events, prepared.covered, false, JSON.parse(prepared.data)) && this.preparedFits(id, events, JSON.parse(prepared.data), st) ? JSON.parse(prepared.data) : undefined;
    // What the message names that the context holds and the capsule leaves out, and what a fresh start reads again.
    const { missing, reread } = timed(() => "weighing a follow-up's fresh start (what it names, what it reads again)", () => {
      const span = events.slice(cp.keepFrom);
      const kept = JSON.stringify(summaryMessage(capsule).content);
      let held: string | undefined;
      const missing = missingFrom([...anchorsOf(o.message)], kept, (a) => (held ??= JSON.stringify(span.map((e) => e.data))).includes(a));
      const written = (capsule.trail?.files ?? []).filter((f) => f.created || f.edits || f.writes).map((f) => f.path);
      return { missing, reread: tokens(rereadBytes(span, [...written, ...missing.filter((m) => /\.\w{1,5}$/.test(m))])) };
    });
    const plan = decideFollowUp({
      ...facts, capsule: tokens(capBytes), ...(ready ? { prepared: tokens(messagesBytes([summaryMessage(ready)], model)) } : {}), reread, missing,
    });
    if (plan.way === "capsule") {
      const ev = this.append(id, "compaction", { mode: "summary", ...capsule, auto: true, trigger: "follow_up", tokens_before: used, model });
      this.emitSession(id);
      void this.compacted(session, ev);
      return plan;
    }
    if (plan.way === "summary" && this.applyPrepared(id, events, undefined, st)) return plan;
    return { ...plan, mark: plan.way };
  }

  // Whether this session's next request asks for the long cache lifetime, as
  // cacheLife would decide it (without moving what it keeps): an agent asks
  // for the short one unless it chose the long one, or its last request was
  // longer ago than the short lifetime less PAUSE_MARGIN_MS.
  private asksLong(id: string, st: Step): boolean {
    const lives = cacheLives(st.provider.wire);
    const s = this.store.session(id);
    if (!lives || !s) return false;
    if (!s.parent_id || s.settings.cache_long) return true;
    const before = this.sent.get(id) ?? (Math.max(this.lineage(id).findLast((e) => e.kind === "assistant")?.ts ?? 0, this.cachePlans.warmedAt(id, st.info.id)) || undefined);
    return !!before && Date.now() - before > lives.short - PAUSE_MARGIN_MS;
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
      // (Nothing to learn from a session deleted under its request.)
      if (this.store.session(id)) this.errors.capture("server", e, { at: "learning the token ratio", model: st.info.id, session: id });
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
    // (Read at a start only: written with the other side rows, src/core/side.ts.)
    const at = Date.now();
    this.store.side.later("a model's bytes a token", () => void this.store.db.run("INSERT OR REPLACE INTO token_ratios (model, ratio, ts) VALUES (?, ?, ?)", [model, ratio, at]));
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
  compactNow(id: string, opts: { focus?: string; auto?: boolean; trigger?: "threshold" | "overflow" | "owner" | "follow_up"; signal?: AbortSignal; step?: Step; next?: ModelInfo } = {}) {
    return during("task", () => this.compactNowOf(id, opts), "a compaction");
  }
  private async compactNowOf(id: string, opts: { focus?: string; auto?: boolean; trigger?: "threshold" | "overflow" | "owner" | "follow_up"; signal?: AbortSignal; step?: Step; next?: ModelInfo } = {}) {
    const session = this.store.session(id)!;
    // (Asked for between turns too: a history not read or counted yet is read and counted in slices first.)
    await this.warmContext(id);
    await countPaced(this.lineage(id), opts.step?.info.id ?? session.model);
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
      if (Math.ceil(contextBytes(opening, st.info.id) / RATIO_MAX) >= st.info.context) {
        // What was counted, by what added it: the prompt's own bytes are not the whole of it when a note of the harness came with it.
        const b = openingBytes(opening, st.info.id);
        const parts = [`its prompt of ${b.prompt} bytes`, ...(b.notes ? [`${b.notes} bytes of notes the harness added for the model`] : []), ...(b.other ? [`${b.other} bytes of other input`] : [])];
        throw Object.assign(new Error(`The input this turn answers is about ${tokens} tokens (${parts.join(", ")}), more than ${st.info.name}'s window of ${st.info.context} tokens, so it cannot be sent whole: ${b.notes > b.prompt ? "the harness notes are the larger part, which is a fault of the harness" : "shorten the prompt"}, or switch to a model with a larger window.`), { status: 409, code: "context_over_window" });
      }
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
    // A compaction inside a turn is stopped with the turn. One asked for between turns (the owner's, or the
    // one before a model switch) has no turn: Engine.interrupt reaches it through `compacting`.
    const own: { abort: AbortController; by?: string } = { abort: new AbortController() };
    if (!opts.signal) this.compacting.set(id, own);
    const signal = opts.signal ?? own.abort.signal;
    const t0 = Date.now();
    try {
      // A history read in parts says first what it will take, and how far it is.
      const planned = (plan: NonNullable<Extract<TurnStatus, { kind: "compacting" }>["plan"]>) => this.status(id, { kind: "compacting", auto: !!opts.auto, plan });
      const res = await this.summarize(id, st, session, upto, signal, opts.focus, transcript, planned).catch((e) => { this.giveUp(id, events, st, upto.at(-1), over, e); throw e; });
      const u: Usage = res.usage;
      const summary = res.summary;
      if (!summary) throw Object.assign(new Error("the model wrote no summary"), { status: 409 });
      // (Checked against the conversation before anything below is decided: that waits for the read thread.)
      const settled = await this.settled(upto, summary);
      if (own.abort.signal.aborted) throw new Error("stopped");
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
        mode: "summary", ...(res.parts ? { parts: res.parts, outputs_shortened: res.clipped, ...(res.steps_left_out ? { steps_left_out: res.steps_left_out } : {}) } : {}), ...timed(() => "making a compaction's checkpoint (its kept messages, trail and probe)", () => checkpointData(upto, summary, this.wordsBudget(st, opts.next), settled)), focus: opts.focus, auto: !!opts.auto,
        trigger: opts.trigger ?? (opts.auto ? "threshold" : "owner"), tokens_before: before, usage: u, model: st.info.id, duration_ms: Date.now() - t0, ...(covered ? { covered } : {}),
      });
      this.emitSession(id);
      await this.compacted(session, ev);
      return ev;
    } catch (e) {
      // The owner's stop: nothing was stored and nothing failed.
      if (own.abort.signal.aborted && !opts.signal) throw Object.assign(new Error(`The compaction was ${stopSays(own.by)}. Nothing was changed.`), { status: 409, code: "stopped", stopped_by: own.by });
      throw e;
    } finally {
      if (this.compacting.get(id) === own) this.compacting.delete(id);
      this.status(id, { kind: "idle" });
    }
  }

  // The compactions asked for between turns that are being written now, each with the way to stop it.
  private compacting = new Map<string, { abort: AbortController; by?: string }>();

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
    this.cachePlans.stopAll(); // the next daemon plans what still waits again
    // What a hook still has under way (a fleet move) is waited for like a turn at work.
    let moving = 0;
    const moves: Promise<unknown>[] = [];
    for (const h of allHooks()) {
      try { const p = h.draining?.(); if (p) { moving++; moves.push(p.catch(() => {}).finally(() => { moving--; })); } } catch (e) { this.errors.capture("server", e, { hook: "draining" }); }
    }
    const deadline = Date.now() + ms;
    for (;;) {
      // (Nor is a turn that only waits for a provider it cannot reach: it is parked and waits on in the next daemon.)
      const busy = [...this.running.entries()].filter(([id, r]) => !this.waitsOnOwner(id) && !r.providerWaiting).map(([, r]) => r.done);
      const left = deadline - Date.now();
      if ((!busy.length && !moving) || left <= 0) return;
      await Promise.race([Promise.all([...busy, ...(moving ? moves : [])]), Bun.sleep(Math.min(left, SETTLE_CHECK_MS))]);
    }
  }

  // The second half: the turns still running are parked.
  async park() {
    // The outages stay as they are for the next daemon: a parked turn has not stopped waiting.
    this.providers.outages?.stop();
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
      // (An archived session's is started when it is restored: startOwed.)
      if (s.archived || this.held.has(id) || this.running.has(id)) continue;
      const end = this.lineage(id).at(-1);
      if (end?.kind === "turn_end" && end.data.reason === "restart") continue;
      this.owe(id);
      void this.startWhenListed(id, waitModel);
    }
  }

  // The owed prompt starts once the session's model is listed. While it is not
  // (a provider still starting, a model gone), the session says so in a note,
  // once, as a cut turn that could not resume does, and the start is tried
  // again every half minute (KEEL_QUEUED_RETRY_MS) until it goes, the row leaves the queue, the
  // owner stops or archives the session, or the daemon stops.
  private async startWhenListed(id: string, waitModel: (model: string) => Promise<void>) {
    for (let said = false; ; ) {
      const s = this.store.session(id);
      if (!s || s.archived || this.draining || this.held.has(id) || this.running.has(id) || !this.owed.has(id) || !this.store.queue(id).length) return;
      try {
        await waitModel(s.model);
        return this.startOwed(id);
      } catch (e) {
        if (!said) {
          const rec = this.errors.capture("provider", e, { session: id, at: "queued prompt after restart" });
          this.append(id, "note", { kind: "restart", text: `A prompt waits in this session's queue since the daemon restarted, and it could not start: ${rec.message}. It starts by itself when the model is back.` });
          said = true;
        }
      }
      await Bun.sleep(queuedRetryMs());
    }
  }

  // The start a stopping daemon owed the session's queue is given now, if one
  // is owed: at the next start, and when an archived session is restored (it
  // starts nothing while archived, and would otherwise start by itself at
  // some later restart).
  startOwed(id: string) {
    if (!this.owed.has(id)) return;
    if (!this.store.queue(id).length) return this.settleOwed(id);
    this.next(id);
  }

  // Whether the session's turns are run outside the engine's loop (an agent of
  // another program): such a turn takes a message when it ends, not at a step.
  isExternal(id: string): boolean {
    const s = this.store.session(id);
    return !!s && allHooks().some((h) => { try { return !!h.external?.(s); } catch { return false; } });
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
          if (cut.length) closing.push(this.store.append(id, "tool_result", { results: cut.map((u: any) => ({ type: "tool_result", tool_use_id: u.id, ...cutResult(id, u) })) }));
          // It ran until the daemon went down (its last sign of life, or the
          // turn's own last event when that is later), not until this start.
          const down = Math.min(Date.now(), Math.max(this.wentDown ?? 0, line.at(-1)!.ts));
          const waiting = !cut.length ? this.providers.outages?.carriedWait(id) : undefined;
          const duration = Math.max(0, down - line[lastStart]!.ts);
          const waitMs = waiting === undefined ? 0 : Math.max(0, down - Math.max(waiting.at, line[lastStart]!.ts));
          closing.push(this.store.append(id, "turn_end", { reason: "restart", usage: emptyUsage(), ms: duration - waitMs, crashed: true, down_ms: down,
            ...(waiting === undefined ? {} : { provider_waiting: true, provider_wait_ms: waitMs, provider_retry: waiting.retry }),
          }));
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
    // Every cut turn goes on at once: they were all running when the daemon went
    // down, so continuing them asks the providers for no more than they already
    // had. A provider that cannot be reached holds its turns in the shared
    // outage wait (src/providers/outage.ts), and one that limits requests says
    // so with its own answer, which the turn's retries follow. A limit set for
    // the daemon (KEEL_RESUME_AT_ONCE, KEEL_RESUME_GAP_MS) queues them instead.
    const slots = new Slots(resumeAtOnce(), resumeGapMs());
    // Only the sessions whose branch ends in a turn a restart cut are read:
    // the store finds them from each session's last event.
    const sessions = this.store.cutSessions();
    await Promise.all(sessions.map(async (s) => {
      // Not in memory after a start: its pages are read off the loop first (store.warm).
      await this.store.warm(s.id, false);
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
        // (What it went on with instead, a newer turn and who started it, is read when the record is whole.)
        // (The branch's end is the session's head: the session may be out of memory again by now, and is not read for it.)
        if (!now || now.archived || this.running.has(s.id) || now.head !== end.id) return this.tellCut(s, cut, "moved", !now ? "not continued: its session was deleted" : now.archived ? "not continued: its session was archived" : undefined);
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
        if (!cards && slots.limited) await Promise.race([this.running.get(s.id)?.done, Bun.sleep(RESUME_HOLD_MS), ...(owed ? [this.untilOnOwner(s.id, RESUME_HOLD_MS)] : [])]);
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
    // Asked at every input (a prompt, a report, a wake), and the answer is
    // no for all but a session a restart cut: the branch's last event says
    // so, and it is read by itself when the session is not in memory. An
    // agent's report into a long session nobody has open would otherwise
    // read the whole of it here, where the loop waits.
    // (For a session in memory too: its last event's kind is known without its body, and that one
    // body is read by itself. Read through the branch, it brought its whole run back from the table.)
    if (this.store.isKept(id) && this.lineage(id).at(-1)?.kind !== "turn_end") return false;
    const last = this.store.headEvent(id);
    if (last?.kind !== "turn_end" || last.data.reason !== "restart") return false;
    const line = this.lineage(id);
    const end = line.at(-1);
    if (end?.kind !== "turn_end" || end.data.reason !== "restart") return false;
    const owed = owedCalls(id, line).length;
    // A restart message the model has not read yet: looked for back to the last reply only, by kind
    // first (a body is read for a prompt alone). Looked for over the whole branch, a session that was
    // never told of a restart read every prompt back to its first, and the runs that hold them, from
    // before its last checkpoint too, where nothing had read them ahead (warmContext).
    if (owed && unreadRestart(line)) return true;
    const cut = line.slice(line.findLastIndex((e) => e.kind === "turn_start"));
    const parked = cut.findLast((e) => e.kind === "note" && e.data.kind === "provider_wait");
    const busy = cut.findLast((e) => e.kind === "note" && e.data.kind === "overload_wait");
    if (busy && typeof busy.data.model === "string" && Number.isFinite(busy.data.since)) this.resumedBusy.set(id, { model: busy.data.model, since: busy.data.since });
    const retry = parked?.data.retry ?? end.data.provider_retry;
    if (retry && typeof retry.model === "string" && (retry.purpose === "turn" || retry.purpose === "summary") &&
        Number.isSafeInteger(retry.spent) && retry.spent > 0) {
      this.resumedProviderRetry.set(id, retry);
    }
    if (!owed && (parked || end.data.provider_waiting)) return true;
    const cutTools = cut.flatMap((e) => (e.kind === "tool_result" ? e.data.results.filter((r: any) => stopKind(r.content) === "cut") : [])).length;
    this.accept(id, { origin: "restart", system: true, text: restartText(cutTools, owed, !!end.data.unstarted) });
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

  // One reply of the session's model for an MCP server's sampling request,
  // after the owner allowed it (src/mcp/manager.ts sample): the server's
  // system prompt and messages, no tools, none of the session's history,
  // booked to the session as a side request.
  // What such a request is for the session's model, before the owner allows
  // it: its name, the request's tokens counted from its bytes at the model's
  // bytes a token, its window, and the most it can cost at the list price
  // (the reply at its bound). Null cost: no price is known.
  async sampleSize(id: string, req: { system?: string; messages: Message[]; maxTokens: number }): Promise<{ model: string; tokens: number; window: number; cost: number | null }> {
    const session = this.store.session(id);
    if (!session) throw new Error("the session is gone");
    const { info } = await this.providers.resolve(session.model);
    const tokens = Math.ceil((utf8Bytes(req.system ?? "") + messagesBytes(req.messages, info.id)) / bytesPerToken(info.id));
    const price = info.price ?? this.providers.catalog.lookup(info.model)?.price;
    const cost = price ? (tokens * price.input + Math.min(req.maxTokens, info.output || req.maxTokens) * price.output) / 1e6 : null;
    return { model: info.name || info.model, tokens, window: info.context, cost };
  }

  async sample(id: string, req: { system?: string; messages: Message[]; maxTokens: number }, signal: AbortSignal): Promise<{ text: string; model: string; stop: string }> {
    const session = this.store.session(id);
    if (!session) throw new Error("the session is gone");
    const { provider, info } = await this.providers.resolve(session.model);
    // A request counted over the model's window is never sent.
    const size = await this.sampleSize(id, req);
    if (size.window && size.tokens + Math.min(req.maxTokens, info.output || req.maxTokens) > size.window) throw new Error(`the request is about ${size.tokens} tokens with its reply, over ${size.model}'s window of ${size.window}`);
    const st: Step = { provider, info: { ...info, output: Math.min(info.output || req.maxTokens, req.maxTokens) }, tools: [], system: req.system ?? "", systemSplit: 0 };
    const res = await this.call(id, st, req.messages, signal, new Map(), session, true, "sampling");
    this.store.addUsage(id, res.usage);
    this.emitSession(id);
    return { text: res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n"), model: info.model ?? info.id, stop: res.stop };
  }

  private readerHost(id: string, callId?: string): ReaderHost {
    const session = this.store.session(id)!;
    let told = false;
    return {
      // Only models of the providers the session's folder allows read for it (src/safety/content-routes.ts).
      models: async () => allowedOnly(routeOf(this.store, id), await this.providers.models()),
      current: async () => (await this.providers.resolve(session.model)).info,
      small: this.ownSmall(id, "reader"),
      shut: (m) => shutWords(this.providers.shut(m.id)),
      listPrice: (m) => this.providers.catalog.lookup(m.model)?.price,
      capture: (e, c) => this.errors.capture("provider", e, { session: id, ...c }),
      progress: callId ? (p) => this.bus.emit({ t: "feature", name: "readers", session_id: id, data: { call_id: callId, ...p } }) : undefined,
      ask: async (m, prompt, sig) => {
        // The job's first request: the owner's named readers ahead of this one that the folder does not
        // allow would have read instead, and are said once (an allowed reader reads in their place).
        if (!told) {
          told = true;
          const all = await this.providers.models();
          const named = [...this.ownSmall(id, "reader"), process.env.KEEL_READER_MODEL].flatMap((n) => all.filter((x) => x.id === n));
          const at = named.findIndex((x) => x.id === m.id);
          this.allowedModels(id, "reader", at < 0 ? named : named.slice(0, at));
        }
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
// A turn that continues one a restart cut is the same work: the steps the
// model gave and the calls still open on a card are counted from where the
// first of them began, so a card that was open before an earlier restart is
// still what the turn waits on, not "the model".
export function cutOf(session: string, line: readonly StoredEvent[], end: StoredEvent): CutTurn {
  const at = line.findIndex((e) => e.id === end.id);
  const upto = at < 0 ? line.length : at;
  const startAt = line.findLastIndex((e, i) => i < upto && e.kind === "turn_start");
  let first = Math.max(startAt, 0);
  for (;;) {
    const before = line.findLastIndex((e, i) => i < first && e.kind === "turn_end");
    if (before < 0 || line[before]!.data.reason !== "restart") break;
    // Another prompt between the two (the owner's, a report): a turn of its own, not the cut one going on.
    if (line.slice(before + 1, first).some((e) => e.kind === "user" && e.data.origin !== "restart")) break;
    const began = line.findLastIndex((e, i) => i < before && e.kind === "turn_start");
    if (began < 0) break;
    first = began;
  }
  const turn = line.slice(Math.max(startAt, 0), upto);
  const whole = line.slice(first, upto);
  const calls = new Map<string, string>(whole.flatMap((e) => (e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "tool_use").map((b: any) => [b.id, b.name] as [string, string]) : [])));
  const done = new Set(whole.flatMap((e) => (e.kind === "tool_result" ? e.data.results : [])).map((r: any) => r.tool_use_id));
  // Cut in this run of the turn: an earlier run's cut calls were told then.
  const tools = turn.flatMap((e) => (e.kind === "tool_result" ? e.data.results : [])).filter((r: any) => stopKind(r.content) === "cut").map((r: any) => calls.get(r.tool_use_id) ?? "a tool");
  const waiting = [...calls].filter(([id, name]) => !done.has(id) && waitsOnOwner(session, { id, name })).length;
  const steps = whole.filter((e) => e.kind === "assistant").length;
  const start = line[startAt];
  const ran = typeof end.data.ms === "number" ? end.data.ms : 0;
  return {
    turn_event: start?.id ?? end.id, end_event: end.id, started_ms: start?.ts ?? end.ts, ran_ms: ran,
    down_ms: typeof end.data.down_ms === "number" ? end.data.down_ms : end.data.crashed ? (start?.ts ?? end.ts) + ran : end.ts,
    crashed: !!end.data.crashed, unstarted: !!end.data.unstarted,
    // A call that was running or waited is of the step the model had given; else the model was on the next one.
    step: tools.length || waiting ? Math.max(steps, 1) : steps + 1, tools, waiting,
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
    // A turn that waited for a provider it could not reach did not stall: it had nothing to do meanwhile.
    if (line[end]?.data.provider_waiting || line.slice(start, end).some((x) => x.kind === "note" && x.data.kind === "provider_wait")) break;
    n++;
    end = prompt - 1;
  }
  return n;
}

// How long a sender's key is kept: as long as the owner's send ids (30 days).
const KEYS_KEPT_MS = 30 * 86_400_000;
// How long until a queue owed a start is tried again while its model is not listed.
const queuedRetryMs = () => Number(process.env.KEEL_QUEUED_RETRY_MS ?? 30_000);
// Continued turns after a restart: all at once and with no gap, unless the
// daemon is given a limit: then this many run at once, each start at least
// this far after the previous one, and a turn holds its place until it ends,
// waits on the owner or has run for RESUME_HOLD_MS.
const resumeAtOnce = () => Number(process.env.KEEL_RESUME_AT_ONCE || Infinity);
const resumeGapMs = () => Number(process.env.KEEL_RESUME_GAP_MS || 0);
const RESUME_HOLD_MS = 30_000;
// How often a drain looks again at which running turns only wait on the owner.
const SETTLE_CHECK_MS = 250;

class Slots {
  private waiting: (() => void)[] = [];
  private last = 0;
  constructor(private free: number, private gapMs: number) {}
  get limited() { return Number.isFinite(this.free) || this.gapMs > 0; }
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
const TITLE_TRIES = 3;
export function firstLineTitle(text: string, max = 80): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "\u2026";
}

// Whether a model's price is at most another's: input and output, and the cache rates the second states,
// at the base rate and at the dearest of its context tiers. A price unknown on either side is not.
export function noDearer(p: Price | undefined, than: Price | undefined): boolean {
  if (!p || !than || p.estimated || than.estimated) return false;
  const top = (x: Price, k: "input" | "output" | "cache_read" | "cache_write") => Math.max(x[k] ?? -1, ...(x.tiers ?? []).map((t) => t[k] ?? -1));
  for (const k of ["input", "output", "cache_read", "cache_write"] as const) {
    if (than[k] === undefined && !(than.tiers ?? []).some((t) => t[k] !== undefined)) continue;
    if (p[k] === undefined || p[k]! > (than[k] ?? Infinity) || top(p, k) > top(than, k)) return false;
  }
  return true;
}
