import { type Wire, wireOf, wireScope } from "../providers/wiretap.ts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rootOf } from "../safety/trust.ts";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { SessionMap } from "../core/session-map.ts";
import { lineage } from "../core/tree.ts";
import type { AssistantBlock, Message, QueueItem, Session, StoredEvent, ToolResultBlock, ToolUseBlock, TurnStatus, Usage } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import { configDir } from "../providers/config.ts";
import type { ModelInfo, Provider, ProviderRequest, ProviderResult } from "../providers/types.ts";
import { asksOwner, toolsFor } from "../tools/registry.ts";
import { isDeferError, loadsNatively, refuseDefer, withCatalog } from "../tools/defer.ts";
import { allHooks, type ExternalTurn, type ToolCall } from "./hooks.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { pickReader, readerPrompt } from "./reader.ts";
import { checkpointAt, COMPACT_SHARE, contextTokens, IDLE_MARGIN_MS, idleMinTokens, lastWarm, ownerMedia, ownerWords, PREPARE_SHARE, summaryMessage, summaryPrompt } from "./compact.ts";
import { retention } from "./cachewarn.ts";
import { withoutImages } from "./images.ts";
import { resolveAttachments } from "./attachments.ts";
import { RETRY, RETRY_WAIT_MAX_MS, backoffMs, errorText, retryable, sleep } from "./retry.ts";

// What the model is told about a tool call a daemon restart cut.
export const RESTART_CUT = "Interrupted by a daemon restart while this tool ran. It may have partly run: check its effects before running it again.";
// A question cut by a restart did nothing: no answer was recorded.
export const QUESTION_CUT = "No answer was recorded before the daemon restarted: the question expired. Ask it again if the decision still matters.";
const cutText = (tool: string) => (asksOwner(tool) ? QUESTION_CUT : RESTART_CUT);

// What the model is told about a tool call cut by the output limit.
export const CUT_CALL = "Not run: this call was cut at the output limit, so its input may be incomplete. Send it again whole if it is still needed.";

// A reply cut by the output limit is continued this many times in a row, then
// the turn ends and says so.
export const MAX_CONTINUATIONS = 3;

// Rebuild the wire conversation from the stored events of one branch (oldest
// first). Pure: the same events always give the same bytes, so the provider's
// prefix cache holds across turns.
export function toMessages(events: StoredEvent[]): Message[] {
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
      if (e.data.blocks.length) out.push({ role: "assistant", content: e.data.blocks });
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
  // Results must lead the user message that follows tool_use.
  for (const m of merged) {
    if (m.role === "user") (m.content as any[]).sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
  }
  // A turn cut mid-tool leaves tool_use without results: close them.
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i]!;
    if (m.role !== "assistant") continue;
    const uses = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (!uses.length) continue;
    const next = merged[i + 1];
    const have = new Set(next?.role === "user" ? next.content.filter((b) => b.type === "tool_result").map((b: any) => b.tool_use_id) : []);
    const missing: ToolResultBlock[] = uses.filter((u) => !have.has(u.id)).map((u) => ({
      type: "tool_result", tool_use_id: u.id, content: "Interrupted by the user before this tool ran.", is_error: true,
    }));
    if (!missing.length) continue;
    if (next?.role === "user") (next.content as any[]).unshift(...missing);
    else merged.splice(i + 1, 0, { role: "user", content: missing });
  }
  return merged;
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

function sessionPrompt(cwd: string, created: number): string {
  const inst = instructionFiles(cwd);
  return [
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}. Session started ${new Date(created).toISOString().slice(0, 10)}.`,
    inst ? `\nInstructions from the owner's files:\n\n${inst}` : "",
  ].join("\n");
}

type Running = { abort: AbortController; done: Promise<void> };
// `native`: the request carries deferred tools (src/tools/defer.ts), refreshed per request.
type Step = { provider: Provider; info: ModelInfo; tools: Tool[]; system: string; systemSplit: number; effort?: string; native?: boolean };

const abortError = () => Object.assign(new Error("interrupted"), { name: "AbortError" });

export class Engine {
  private running = new Map<string, Running>();
  // Sessions whose queue a stop holds: stored, so the hold (and its Resume)
  // outlives a daemon restart; only an action that releases it clears it.
  private held: Set<string>;
  // Queued prompts a Send now has taken and not yet appended.
  private sending = new Set<string>();
  // Who asked a running turn to stop (the owner, the parent agent), kept on its turn_end.
  private stoppedBy = new Map<string, string>();
  // What a finished call left for the transcript (ToolOutput.shown), until its step is stored.
  private shown = new Map<string, unknown>();
  // Turns being parked for a daemon stop: their end reason is "restart".
  private parking = new Set<string>();
  private draining = false;
  // Bounded: a session that dropped out rebuilds its system prompt (its cache
  // prefix went cold long before 64 other sessions ran) and asks to read a file
  // again before editing it.
  private seen = new SessionMap<Map<string, number>>(64);
  private systems = new SessionMap<{ text: string; split: number }>(64);

  constructor(
    private store: Store,
    private bus: Bus,
    private providers: Providers,
    private errors: ErrorTracker,
    private spillRoot: string,
  ) {
    // A summary prepared ahead survives a restart.
    store.migrate("CREATE TABLE IF NOT EXISTS prepared_summaries (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, covered TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL)");
    store.migrate("CREATE TABLE IF NOT EXISTS queue_holds (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE)");
    this.held = new Set(store.db.query<{ session_id: string }, []>("SELECT session_id FROM queue_holds").all().map((r) => r.session_id));
  }

  private hold(id: string) {
    this.held.add(id);
    this.store.db.run("INSERT OR IGNORE INTO queue_holds (session_id) VALUES (?)", [id]);
  }

  private release(id: string) {
    if (this.held.delete(id)) this.store.db.run("DELETE FROM queue_holds WHERE session_id = ?", [id]);
  }

  // A queued prompt written on a branch the session no longer shows (the head
  // moved back, or an earlier prompt was edited): it is sent only when the
  // owner chooses where, here or back on its branch.
  offBranch(q: QueueItem): boolean {
    return !!q.anchor && !this.lineage(q.session_id).some((e) => e.id === q.anchor);
  }

  private offBranchError() {
    return Object.assign(new Error("this prompt was queued on another branch: send it here, or go back to its branch"), { status: 409, code: "off_branch" });
  }

  // A queued prompt that Send now has taken: it can no longer be edited or removed.
  isSending(qid: string) {
    return this.sending.has(qid);
  }

  isRunning(id: string) {
    return this.running.has(id);
  }

  isHeld(id: string) {
    return this.held.has(id);
  }

  // The session's frozen system prompt is made again at its next turn (it moved
  // to another directory or machine; the cache prefix is rebuilt once).
  forgetSystem(id: string) {
    this.systems.delete(id);
  }

  lineage(id: string): StoredEvent[] {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  // Stop the running turn: the model stream and running tools are cut, the
  // queue is held (nothing starts by itself until the owner sends or resumes),
  // and steers that did not reach the turn become ordinary queued prompts.
  async interrupt(id: string, by?: string) {
    const r = this.running.get(id);
    if (!r) return;
    if (by) this.stoppedBy.set(id, by);
    this.hold(id);
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
    this.bus.emit({ t: "queue", session_id: id, queue: this.store.queue(id), held: this.held.has(id) });
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
  send(id: string, text: string, opts: { mode?: "send" | "steer" | "queue"; images?: any[]; meta?: Record<string, unknown> } = {}) {
    const mode = opts.mode ?? "send";
    if (this.running.has(id) || (mode === "queue" && this.store.queue(id).length)) {
      const q = this.store.enqueue(id, text, mode !== "queue", opts.images);
      this.emitQueue(id);
      return { queued: q, steer: q.steer };
    }
    // Input that is not the owner's (a report, a wake) never releases a held queue.
    if (!opts.meta) this.release(id);
    const ev = this.append(id, "user", { text, images: opts.images?.length ? opts.images : undefined, ...opts.meta });
    // The title comes from the owner's first words, not from a timer's or a report's envelope.
    // A prompt of only attachments (no words) is named by its files, or Image.
    const files = (opts.images ?? []).filter((b: any) => b?.type === "attachment").map((b: any) => String(b.name));
    if (!opts.meta) this.titleFrom(id, text || (files.length ? files.join(", ") : opts.images?.length ? "Image" : ""));
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // Edit-and-resend: a new version of an earlier prompt, as a sibling of it (a
  // new branch from its parent). The old branch stays and can be shown again.
  async edit(id: string, eventId: string, text: string) {
    const old = this.store.event(eventId);
    if (!old || old.session_id !== id || old.kind !== "user") throw Object.assign(new Error("not a prompt of this session"), { status: 400 });
    await this.interrupt(id);
    this.release(id);
    // An edited steer is a new turn from the same place, not a live steer: it says what it was.
    const ev = this.append(id, "user", { text, images: old.data.images, ...(old.data.origin === "steer" ? { edited_from: "steer" } : {}) }, old.parent);
    this.emitSession(id);
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // A queued prompt now: the running turn stops and this one is the next turn.
  // The row is taken before the stop is awaited, so a second Send now, an
  // edit or a Remove in that time is told it is already sending.
  // `here`: on the branch shown now, also when it was queued on another one.
  async sendNow(id: string, qid: string, here = false) {
    if (this.sending.has(qid)) throw Object.assign(new Error("this queued prompt is already sending"), { status: 409 });
    const q = this.store.queueItem(qid);
    if (q && q.session_id === id && !here && this.offBranch(q)) throw this.offBranchError();
    if (!q || q.session_id !== id || !this.store.dequeue(qid)) throw Object.assign(new Error("no such queued prompt"), { status: 404 });
    this.sending.add(qid);
    try {
      this.emitQueue(id);
      await this.interrupt(id);
      this.release(id);
      this.append(id, "user", { text: q.text, images: q.images, origin: "queued", queue_id: q.id });
      this.start(id);
      this.emitQueue(id);
    } finally {
      this.sending.delete(qid);
    }
  }

  // `here`: the next prompt goes on the branch shown now even when it was
  // queued on another one.
  resumeQueue(id: string, here = false) {
    const first = this.store.queue(id)[0];
    if (first && this.offBranch(first)) {
      if (!here) throw this.offBranchError();
      this.store.updateQueueItem(first.id, { anchor: this.store.session(id)?.head ?? null });
    }
    this.release(id);
    if (!this.running.has(id)) this.next(id);
    this.emitQueue(id);
  }

  // Continue a session whose last turn was stopped, failed or was cut.
  resume(id: string) {
    if (this.running.has(id)) throw Object.assign(new Error("a turn is running"), { status: 409 });
    this.release(id);
    this.append(id, "user", { text: "[harness] The previous turn was stopped before it finished. Continue where it left off.", origin: "harness" });
    this.start(id);
    this.emitQueue(id);
  }

  // After a turn: the next queued prompt starts, unless the queue is held.
  private next(id: string) {
    if (this.held.has(id) || this.running.has(id) || this.draining) return;
    const s = this.store.session(id);
    if (!s || s.archived) return;
    const q = this.store.queue(id)[0];
    if (!q) return;
    // Written on another branch: it waits for the owner to say where it goes.
    if (this.offBranch(q)) { this.hold(id); this.emitQueue(id); return; }
    if (!this.store.dequeue(q.id)) return;
    this.append(id, "user", { text: q.text, images: q.images, origin: q.steer ? "steer" : "queued", queue_id: q.id });
    this.start(id);
    this.emitQueue(id);
  }

  // A turn another engine handed over (see start).
  adopt(id: string) {
    if (!this.running.has(id) && !this.draining) this.start(id);
  }

  private start(id: string) {
    // An engine a dev hot reload replaced runs no new turn (a child's task, a
    // queued prompt, a report that wakes a parent): the engine now in charge does.
    const successor = (globalThis as { __keelEngine?: Engine }).__keelEngine;
    if (this.draining && successor && successor !== this) return successor.adopt(id);
    const abort = new AbortController();
    const done = this.loop(id, abort.signal)
      .catch((e) => {
        if (abort.signal.aborted) return;
        // A refusal a hook meant (`expected`) is said in the transcript, not tracked as a failure.
        const rec = (e as any)?.expected ? undefined : this.errors.capture("provider", e, { session: id });
        this.append(id, "error", { message: errorText(e), error_id: rec?.id });
      })
      .finally(() => {
        this.running.delete(id);
        this.status(id, { kind: "idle" });
        if (this.store.session(id)) this.setPhase(id, "idle");
        this.next(id);
      });
    this.running.set(id, { abort, done });
  }

  private async step(session: Session, model: string): Promise<Step> {
    const { provider, info } = await this.providers.resolve(model);
    const system = await this.systemOf(session);
    const want = session.settings.effort;
    const effort = want && info.efforts.includes(want) ? want : info.efforts.includes("high") ? "high" : undefined;
    // A model known to take no tool definitions (the owner, a probe, its listing
    // or catalog said so) is sent none: it would refuse them or answer garbled.
    const native = info.tools !== false && loadsNatively(provider.wire, info);
    return { provider, info, tools: info.tools === false ? [] : toolsFor(info.family, native), system: system.text, systemSplit: system.split, effort, native };
  }

  // A subagent on this machine runs on its parent's system prompt byte for byte
  // (its own place, a worktree, is in its task message), so its first request
  // reads the prefix the parent cached instead of writing its own copy.
  private async systemOf(session: Session): Promise<{ text: string; split: number }> {
    let system = this.systems.get(session.id);
    if (system) return system;
    const parent = session.parent_id && !session.machine ? this.store.session(session.parent_id) : undefined;
    if (parent) system = await this.systemOf(parent);
    else {
      const extra = (await Promise.all(allHooks().map((h) => h.system?.(session) ?? ""))).filter(Boolean);
      const shared = [CORE, ...extra].join("\n\n") + "\n\n";
      system = { text: shared + sessionPrompt(session.workspace, session.created), split: shared.length };
    }
    this.systems.set(session.id, system);
    return system;
  }

  // Measuring hooks never stop a call.
  private measure(f: (h: ReturnType<typeof allHooks>[number]) => void) {
    for (const h of allHooks()) try { f(h); } catch (e) { this.errors.capture("server", e, { hook: "measure" }); }
  }

  // One provider call with retries for passing failures. The UI is told about
  // each wait and the half-streamed reply of a failed attempt is dropped.
  private async call(id: string, st: Step, messages: Message[], signal: AbortSignal, partial: Map<number, { kind: string; text: string }>, session: Session, quiet = false, purpose: ProviderRequest["purpose"] = quiet ? "side" : "turn"): Promise<ProviderResult> {
    // Built once: a retry sends the same request, byte for byte (the hooks run
    // once, so a note a hook stored is in every attempt).
    if (st.native && purpose !== "reader") st.tools = await withCatalog(st.tools, st.info.family, messages);
    let req: ProviderRequest = { model: st.info.model, system: st.system, systemSplit: st.systemSplit, messages, tools: st.tools, effort: st.effort, maxTokens: st.info.output, signal, sessionKey: id, purpose, route: st.info.id };
    // A reader's request carries no conversation for the hooks to add to.
    if (purpose === "reader") req.cache = false;
    else for (const h of allHooks()) if (h.beforeRequest) req = { ...req, ...(await h.beforeRequest(session, req)) };
    // A subagent works without pauses, then ends: the hour's dearer cache writes buy it nothing.
    if (session.parent_id && purpose !== "reader") req.cacheTtl = "5m";
    // What the model can read, applied after the hooks (a hook may rebuild the messages).
    req.messages = resolveAttachments(st.info.images === false ? withoutImages(req.messages, st.info.name ?? st.info.model) : req.messages, st.info);
    for (let attempt = 0; ; attempt++) {
      partial.clear();
      this.measure((h) => h.requestSent?.(session, req));
      const since = Date.now();
      if (!quiet) this.status(id, { kind: "model", since, model: st.info.name });
      let first = true;
      // The provider answered but the model has said nothing yet: shown as
      // connected, so a long silence reads as the model's, not the network's.
      const onHeaders = (h: Headers) => {
        req.onHeaders?.(h);
        if (first && !quiet && !signal.aborted) this.status(id, { kind: "model", since, model: st.info.name, connected: Date.now() });
      };
      try {
        const tap: Wire = {};
        wireOf.set(req, tap);
        const res = await wireScope.run(tap, () => st.provider.stream({ ...req, onHeaders }, (d) => {
          if (first && !quiet) { first = false; this.status(id, { kind: "idle" }); }
          const p = partial.get(d.index) ?? { kind: d.kind, text: "" };
          p.text += d.text;
          partial.set(d.index, p);
          this.measure((h) => h.requestDelta?.(session, req, d));
          if (!quiet) this.bus.emit({ t: "delta", session_id: id, ...d });
        }));
        if (!quiet || attempt) this.status(id, { kind: "idle" });
        this.measure((h) => h.requestDone?.(session, req, res));
        return res;
      } catch (e) {
        this.measure((h) => h.requestFailed?.(session, req, e, signal.aborted));
        if (signal.aborted) throw abortError();
        // A route that cannot take deferred tools gets the search pair, once.
        if (st.native && !retryable(e) && isDeferError(e)) {
          this.errors.capture("provider", e, { session: id, fallback: "deferred tools refused; using search_tools" });
          refuseDefer(st.info.id);
          st.native = false;
          st.tools = toolsFor(st.info.family);
          req = { ...req, tools: st.tools };
          continue;
        }
        if (!retryable(e) || attempt + 1 >= RETRY.max) throw e;
        const wait = backoffMs(attempt, e);
        if (wait > RETRY_WAIT_MAX_MS) {
          const at = new Date(Date.now() + wait).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
          throw Object.assign(new Error(`${errorText(e)} (the provider asked to wait until ${at}, longer than a turn waits; Continue after that)`), { name: "RetryTooLong" });
        }
        this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: wait });
        this.status(id, { kind: "retry", attempt: attempt + 1, max: RETRY.max - 1, at: Date.now() + wait, message: errorText(e) });
        await sleep(wait, signal);
      }
    }
  }

  // A turn another agent runs (an ACP agent): it stores its own replies and calls.
  private async external(id: string, session: Session, run: ExternalTurn, signal: AbortSignal) {
    this.setPhase(id, "working");
    const t0 = Date.now();
    this.append(id, "turn_start", { model: session.model });
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
    let st = await this.step(session, session.model);
    const seen = this.seen.get(id) ?? new Map();
    this.seen.set(id, seen);
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id), read: (source, text, prompt) => this.read(id, source, text, prompt, signal).catch((e) => { if (!signal.aborted) this.errors.capture("provider", e, { session: id, at: "reader", source }); throw e; }) };

    this.setPhase(id, "working");
    const t0 = Date.now();
    let usage: Usage = emptyUsage();
    this.append(id, "turn_start", { model: session.model, effort: st.effort });
    let reason = "end_turn";
    let cuts = 0;
    let fellBack = false;
    let compactedForFit = false;
    let steps = 0;
    const partial = new Map<number, { kind: string; text: string }>();
    try {
      for (;;) {
        // Steers sent while the last step ran join here, after its tool results.
        for (const q of this.store.queue(id).filter((q) => q.steer)) {
          if (!this.store.dequeue(q.id)) continue;
          this.append(id, "user", { text: q.text, images: q.images, origin: "steer", queue_id: q.id });
          this.emitQueue(id);
        }
        session = this.store.session(id)!;
        // The owner's step budget for one turn (none by default).
        const budget = session.settings.max_steps ?? 0;
        if (budget > 0 && steps >= budget) {
          this.append(id, "note", { kind: "max_steps", text: `Stopped after ${steps} model steps: the step budget of this session. Continue to go on.` });
          reason = "max_steps";
          break;
        }
        steps++;
        // The last step of the budget answers in words: the request keeps its
        // tools (the cached prefix), and calls it still makes are not run.
        if (budget > 0 && steps === budget) this.append(id, "user", { text: `[harness] This is the last model step this turn may take (the session's step budget is ${budget}). Do not call tools: reply with where the work stands and what is left to do.`, origin: "harness" });
        let events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        const used = contextTokens(events).used;
        if (events.some((e) => e.kind === "assistant") && used >= limit) {
          // A summary prepared ahead swaps in at once; else the turn waits for one.
          if (!this.applyPrepared(id, events)) await this.compactNow(id, { auto: true, trigger: "threshold", signal, step: st });
          events = this.lineage(id);
        } else if (steps === 1 && this.cacheCold(id, events, st) && this.applyPrepared(id, events)) {
          // Back after the cache expired: the summary written while idle (or
          // ahead) replaces the history instead of the history being written again.
          events = this.lineage(id);
        } else if (used >= limit * (PREPARE_SHARE / COMPACT_SHARE)) {
          this.prepare(id, st);
        }
        const messages = toMessages(events);
        let res: ProviderResult;
        try {
          res = await this.call(id, st, messages, signal, partial, session);
        } catch (e) {
          // The request no longer fits the window: compact once and go on.
          if (!signal.aborted && (e as any)?.kind === "context" && !compactedForFit) {
            compactedForFit = true;
            await this.compactNow(id, { auto: true, trigger: "overflow", signal, step: st });
            continue;
          }
          if (signal.aborted) {
            // Keep what the owner already saw of the reply.
            const text = [...partial.entries()].sort(([a], [b]) => a - b).filter(([, p]) => p.kind === "text" && p.text.trim()).map(([, p]) => ({ type: "text" as const, text: p.text }));
            if (text.length) this.append(id, "assistant", { blocks: text, model: session.model, usage: emptyUsage(), stop: "interrupted" });
          }
          throw e;
        }
        for (const h of allHooks()) await h.afterResponse?.(session, res, messages);
        const u: Usage = res.usage; // priced by the registry from the model's listed price
        usage = addUsage(usage, u);
        this.store.addUsage(id, u);
        this.emitSession(id);

        if (res.stop === "refusal") {
          this.append(id, "assistant", { blocks: res.blocks, model: st.info.id, usage: u, stop: "refusal", stop_details: res.stop_details ?? null });
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

        if (res.stop === "model_context_window_exceeded") {
          await this.compactNow(id, { auto: true, trigger: "overflow", signal, step: st });
          continue;
        }
        const uses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use" && b !== cut);
        ctx.room = Math.max(0, st.info.context - (u.input + u.cache_read + u.cache_write + u.output));
        if (uses.length || cut) {
          if (uses.length) this.status(id, { kind: "tool", since: Date.now(), names: [...new Set(uses.map((u) => u.name))] });
          const spent = budget > 0 && steps >= budget;
          const results = await Promise.all(uses.map((u) => (spent ? Promise.resolve<ToolResultBlock>({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Not run: the step budget of this turn is spent." }) : this.runTool(session, st.tools, u, ctx))));
          if (cut) results.push({ type: "tool_result", tool_use_id: cut.id, is_error: true, content: CUT_CALL });
          this.status(id, { kind: "idle" });
          const shown = Object.fromEntries(results.filter((r) => this.shown.has(r.tool_use_id)).map((r) => [r.tool_use_id, this.shown.get(r.tool_use_id)]));
          for (const r of results) this.shown.delete(r.tool_use_id);
          this.append(id, "tool_result", { results, ...(Object.keys(shown).length ? { shown } : {}) });
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
        if (this.store.queue(id).some((q) => q.steer)) continue;
        reason = res.stop;
        break;
      }
    } catch (e) {
      reason = signal.aborted ? (this.parking.has(id) ? "restart" : "interrupted") : "error";
      if (!signal.aborted) throw e;
    } finally {
      const by = this.stoppedBy.get(id);
      this.stoppedBy.delete(id);
      this.append(id, "turn_end", { reason, usage, ms: Date.now() - t0, ...(by && reason === "interrupted" ? { stopped_by: by } : {}) });
      // Between turns, a context past the preparing share gets its summary ready.
      if (!signal.aborted) {
        const events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        if (contextTokens(events).used >= limit * (PREPARE_SHARE / COMPACT_SHARE)) this.prepare(id, st);
        this.scheduleIdle(id, st);
      }
      for (const h of allHooks()) await (async () => h.turnEnd?.(session, reason))().catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  private async runTool(session: Session, tools: Tool[], u: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlock> {
    // Built when the stop comes: a stop for a daemon restart says so.
    const interrupted = (): ToolResultBlock => ({
      type: "tool_result", tool_use_id: u.id, is_error: true,
      content: this.parking.has(ctx.sessionId) ? cutText(u.name) : "Interrupted by the user while this tool ran.",
    });
    if (ctx.signal.aborted) return interrupted();
    const tool = tools.find((t) => t.name === u.name);
    if (!tool) return { type: "tool_result", tool_use_id: u.id, content: `No tool named ${u.name}.`, is_error: true };
    const callTool = (name: string, input: any, id: string) => this.runTool(session, tools, { type: "tool_use", id, name, input }, ctx);
    const call: ToolCall = { id: u.id, tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id, callTool } };
    // An interrupt answers at once, whether or not a gate or the tool honors the signal.
    // The listener goes when the call settles: the turn's signal is shared by all its calls.
    let onStop = () => {};
    const stopped = new Promise<null>((r) => { onStop = () => r(null); ctx.signal.addEventListener("abort", onStop, { once: true }); });
    let result: ToolResultBlock;
    // Measured from dispatch: a call that never ran (denied, stopped at its gate) has no row.
    let t0: number | undefined;
    const ran = (r: ToolResultBlock, outcome: "ok" | "error" | "interrupted") => {
      const ms = Date.now() - t0!;
      this.measure((h) => h.toolRan?.(session, call, r, { ms, outcome }));
      return r;
    };
    try {
      for (const h of allHooks()) {
        if (!h.beforeTool) continue;
        const gate = Promise.resolve(h.beforeTool(session, call));
        gate.catch(() => {});
        const g = await Promise.race([gate, stopped]);
        if (ctx.signal.aborted) return interrupted();
        if (!g) continue;
        if ("deny" in g) return { type: "tool_result", tool_use_id: u.id, content: g.deny, is_error: true };
        if (g.input !== undefined) call.input = g.input;
        if (g.ctx) call.ctx = { ...call.ctx, ...g.ctx };
      }
      let input = call.input;
      for (const h of allHooks()) { const x = h.execInput?.(session, call); if (x !== undefined) input = x; }
      // A dispatch set by a hook runs the call elsewhere (another machine's hands).
      t0 = Date.now();
      const run = call.ctx.dispatch ? call.ctx.dispatch(tool, input, call.ctx) : tool.run(input, call.ctx);
      // After a stop the tool may still fail on its way out; that is expected.
      run.catch(() => {});
      const out = await Promise.race([run, stopped]);
      if (!out) return ran(interrupted(), "interrupted");
      result = { type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.is_error || undefined };
      if (out.shown !== undefined) this.shown.set(u.id, out.shown);
      ran(result, result.is_error ? "error" : "ok");
    } catch (e) {
      if (ctx.signal.aborted) return t0 === undefined ? interrupted() : ran(interrupted(), "interrupted");
      this.errors.capture("tool", e, { tool: u.name, session: ctx.sessionId });
      const failed: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: `Tool failed: ${(e as Error).message}`, is_error: true };
      return t0 === undefined ? failed : ran(failed, "error");
    } finally {
      ctx.signal.removeEventListener("abort", onStop);
    }
    // A hook that throws at once is caught like one that rejects.
    for (const h of allHooks()) await (async () => h.afterTool?.(session, call, result))().catch((e) => this.errors.capture("server", e, { hook: "afterTool", tool: u.name, session: session.id }));
    return result;
  }

  private preparing = new Set<string>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // The prepared summary's time, when there is one.
  private preparedMs(id: string): number {
    const row = this.store.db.query<{ data: string }, [string]>("SELECT data FROM prepared_summaries WHERE session_id = ?").get(id);
    return row ? Number(JSON.parse(row.data).prepared_ms ?? 0) : 0;
  }

  // The cache of this context has surely expired: no request read it within
  // the longest lifetime the route may keep it.
  private cacheCold(id: string, events: StoredEvent[], st: Step): boolean {
    const warm = lastWarm(events, this.preparedMs(id));
    return warm > 0 && Date.now() - warm > retention(st.provider.wire, events, st.info.id).max;
  }

  // After a restart: idle sessions whose cache may still be warm get their timer again.
  async resumeIdle() {
    const since = Date.now() - 60 * 60_000;
    for (const { id } of this.store.db.query<{ id: string }, [number]>("SELECT id FROM sessions WHERE updated > ? AND archived = 0").all(since)) {
      const s = this.store.session(id);
      if (!s || this.running.has(id)) continue;
      try { this.scheduleIdle(id, await this.step(s, s.model)); } catch (e) { this.errors.capture("provider", e, { session: id, at: "idle compaction after a restart" }); }
    }
  }

  // After a turn: a context big enough gets its summary prepared shortly
  // before its cache lifetime ends, unless the session works again before then.
  private scheduleIdle(id: string, st: Step) {
    clearTimeout(this.idleTimers.get(id));
    this.idleTimers.delete(id);
    const session = this.store.session(id);
    if (!session || session.settings.idle_compact === false) return;
    const events = this.lineage(id);
    const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
    if (contextTokens(events).used < idleMinTokens(limit)) return;
    const life = retention(st.provider.wire, events, st.info.id).sure;
    if (life < 2 * IDLE_MARGIN_MS) return; // a five-minute cache leaves no idle time to use
    const due = lastWarm(events) + life - IDLE_MARGIN_MS - Date.now();
    const t = setTimeout(() => {
      this.idleTimers.delete(id);
      if (this.running.has(id) || !this.store.session(id)) return;
      this.prepare(id, st, true);
    }, Math.max(0, due));
    (t as any).unref?.();
    this.idleTimers.set(id, t);
  }

  // Write a summary of the context as it stands now, in the background (the
  // turn goes on). It is stored with the event it covers up to, and swapped in
  // when the context reaches the compaction limit.
  // `idle`: written for idle compaction, so it covers the whole context: an
  // older summary that covers less is written again.
  private prepare(id: string, st: Step, idle = false) {
    if (this.preparing.has(id)) return;
    const events = this.lineage(id);
    const covered = events.findLast((e) => e.kind !== "turn_start" && e.kind !== "turn_end");
    if (!covered || covered.kind === "compaction") return;
    const have = this.store.db.query<{ covered: string }, [string]>("SELECT covered FROM prepared_summaries WHERE session_id = ?").get(id);
    if (have && events.some((e) => e.id === have.covered) && events.findIndex((e) => e.id === have.covered) > checkpointAt(events).at && (!idle || have.covered === covered.id)) return;
    this.preparing.add(id);
    const session = this.store.session(id)!;
    const ask: Message[] = [...toMessages(events), { role: "user", content: [{ type: "text", text: summaryPrompt() }] }];
    const before = contextTokens(events).used;
    const t0 = Date.now();
    this.call(id, st, ask, new AbortController().signal, new Map(), session, true, "summary")
      .then((res) => {
        this.store.addUsage(id, res.usage);
        this.emitSession(id);
        const summary = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
        if (res.stop === "refusal" || !summary) return;
        const data = { mode: "summary", summary, owner_messages: ownerWords(events), owner_media: ownerMedia(events), auto: true, ahead: !idle, trigger: idle ? "idle" : "threshold", covered: covered.id, tokens_before: before, usage: res.usage, model: st.info.id, prepared_ms: Date.now(), duration_ms: Date.now() - t0 };
        this.store.db.run("INSERT OR REPLACE INTO prepared_summaries (session_id, covered, data, ts) VALUES (?, ?, ?, ?)", [id, covered.id, JSON.stringify(data), Date.now()]);
      })
      .catch((e) => this.errors.capture("provider", e, { session: id, at: "preparing a summary" }))
      .finally(() => this.preparing.delete(id));
  }

  // The prepared summary as a checkpoint, when it covers part of this branch
  // after its last checkpoint. The events since stay verbatim after it.
  private applyPrepared(id: string, events: StoredEvent[]): boolean {
    const row = this.store.db.query<{ covered: string; data: string }, [string]>("SELECT covered, data FROM prepared_summaries WHERE session_id = ?").get(id);
    if (!row) return false;
    this.store.db.run("DELETE FROM prepared_summaries WHERE session_id = ?", [id]);
    const at = events.findIndex((e) => e.id === row.covered);
    if (at < 0 || at <= checkpointAt(events).at) return false;
    this.append(id, "compaction", JSON.parse(row.data));
    this.emitSession(id);
    return true;
  }

  // Summarize the context into a checkpoint. Runs inside a turn (auto, before a
  // call that would not fit) or on the owner's request between turns.
  // `trigger`: what started it (the threshold, a request that did not fit, the owner).
  async compactNow(id: string, opts: { focus?: string; auto?: boolean; trigger?: "threshold" | "overflow" | "owner"; signal?: AbortSignal; step?: Step } = {}) {
    const session = this.store.session(id)!;
    const events = this.lineage(id);
    const messages = toMessages(events);
    if (!messages.length || (events.at(-1)?.kind === "compaction")) throw Object.assign(new Error("nothing to compact"), { status: 409 });
    const st = opts.step ?? (await this.step(session, session.model));
    const before = contextTokens(events).used;
    for (const h of allHooks()) await Promise.resolve().then(() => h.beforeCompact?.(session)).catch((e) => this.errors.capture("server", e, { hook: "beforeCompact" }));
    this.status(id, { kind: "compacting", auto: !!opts.auto });
    const own = new AbortController();
    const signal = opts.signal ?? own.signal;
    const t0 = Date.now();
    try {
      // The same tools and system as the session's turns: that prefix is read from cache.
      const ask: Message[] = [...messages, { role: "user", content: [{ type: "text", text: summaryPrompt(opts.focus) }] }];
      const res = await this.call(id, st, ask, signal, new Map(), session, true, "summary"); // the summary is not a reply
      const u: Usage = res.usage;
      this.store.addUsage(id, u);
      const summary = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (res.stop === "refusal" || !summary) throw Object.assign(new Error("the model wrote no summary"), { status: 409 });
      const ev = this.append(id, "compaction", {
        mode: "summary", summary, owner_messages: ownerWords(events), owner_media: ownerMedia(events), focus: opts.focus, auto: !!opts.auto,
        trigger: opts.trigger ?? (opts.auto ? "threshold" : "owner"), tokens_before: before, usage: u, model: st.info.id, duration_ms: Date.now() - t0,
      });
      this.emitSession(id);
      return ev;
    } finally {
      this.status(id, { kind: "idle" });
    }
  }

  // Before the daemon stops: no new turn starts; running turns get `ms` to end
  // by themselves, then are parked (cut, with "restart" as their end reason) so
  // the next daemon resumes them.
  async drain(ms: number) {
    this.draining = true;
    const all = [...this.running.values()].map((r) => r.done);
    if (all.length) await Promise.race([Promise.all(all), Bun.sleep(ms)]);
    await Promise.all([...this.running.entries()].map(async ([id, r]) => {
      this.parking.add(id);
      r.abort.abort();
      await r.done;
    }));
  }

  // At startup: a turn the last daemon left open (a crash, a kill) is closed
  // the way a stop would close it, and a turn cut by a restart continues by
  // itself, once: a turn that was itself such a continuation and was cut
  // again waits for the owner's Continue.
  async recover(openAtBoot: string[], waitModel: (model: string) => Promise<void>) {
    for (const id of openAtBoot) {
      const line = this.lineage(id);
      const lastStart = line.findLastIndex((e) => e.kind === "turn_start");
      if (lastStart < 0 || line.slice(lastStart).some((e) => e.kind === "turn_end")) continue;
      const results = new Set(line.slice(lastStart).flatMap((e) => (e.kind === "tool_result" ? e.data.results.map((r: any) => r.tool_use_id) : [])));
      const cut = line.slice(lastStart).flatMap((e) => (e.kind === "assistant" ? e.data.blocks.filter((b: any) => b.type === "tool_use" && !results.has(b.id)) : []));
      if (cut.length) this.append(id, "tool_result", { results: cut.map((u: any) => ({ type: "tool_result", tool_use_id: u.id, content: cutText(u.name), is_error: true })) });
      this.append(id, "turn_end", { reason: "restart", usage: emptyUsage(), ms: Date.now() - line[lastStart]!.ts, crashed: true });
    }
    // Each session on its own: a provider still starting holds only its sessions.
    // The continued turns start a few at a time, the newest first, spaced out,
    // so a restart with many open sessions does not send every replayed context
    // to the providers in the same second.
    const slots = new Slots(RESUME_AT_ONCE, RESUME_GAP_MS);
    const sessions = this.store.sessions().sort((a, b) => b.updated - a.updated);
    await Promise.all(sessions.map(async (s) => {
      const line = this.lineage(s.id);
      const end = line.at(-1);
      if (s.archived || end?.kind !== "turn_end" || end.data.reason !== "restart") return;
      // The prompt that started the cut turn.
      const prompt = line.slice(0, line.findLastIndex((e) => e.kind === "turn_start")).findLast((e) => e.kind === "user");
      if (prompt?.data.origin === "restart") {
        this.append(s.id, "note", { kind: "restart", text: "The daemon restarted again during the continued turn. Continue when you want it to go on." });
        return;
      }
      const cutTools = line.slice(line.findLastIndex((e) => e.kind === "turn_start")).flatMap((e) => (e.kind === "tool_result" ? e.data.results.filter((r: any) => r.content === RESTART_CUT || r.content === QUESTION_CUT) : [])).length;
      try {
        await waitModel(s.model);
      } catch (e) {
        const rec = this.errors.capture("provider", e, { session: s.id, at: "resume after restart" });
        this.append(s.id, "note", { kind: "restart", text: `The turn was cut by a daemon restart and could not continue: ${rec.message}. Continue when the model is back.` });
        return;
      }
      await slots.take();
      try {
        // Checked again right before starting: the owner may have moved on, archived or sent meanwhile.
        const now = this.store.session(s.id);
        if (!now || now.archived || this.running.has(s.id) || this.lineage(s.id).at(-1)?.id !== end.id) return;
        this.append(s.id, "user", {
          origin: "restart",
          text: `[harness] The daemon restarted during your previous turn${cutTools ? `; ${cutTools} tool call${cutTools > 1 ? "s" : ""} it cut ${cutTools > 1 ? "are" : "is"} marked as interrupted` : ""}. Continue where it left off.`,
        });
        this.start(s.id);
        this.emitQueue(s.id);
        // Held until the turn ends or its first steps had time to run: a turn that
        // then waits on the owner (an approval) does not hold back the others.
        await Promise.race([this.running.get(s.id)?.done, Bun.sleep(RESUME_HOLD_MS)]);
      } finally {
        slots.give();
      }
    }));
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
    const messages = toMessages(this.lineage(id));
    if (pending) for (const m of messages) for (const b of m.content as any[]) if (b.type === "tool_result" && b.tool_use_id === pending.id) { b.content = pending.text; b.is_error = false; }
    const last = messages.at(-1);
    for (const m of extra) {
      if (last?.role === "user" && m === extra[0] && m.role === "user") messages[messages.length - 1] = { role: "user", content: [...last.content, ...m.content] };
      else messages.push(m);
    }
    const res = await this.call(id, st, messages, signal, new Map(), session, true);
    this.store.addUsage(id, res.usage);
    this.emitSession(id);
    return { ...res, model_id: st.info.id };
  }

  // Long content read by the session's reader model (src/engine/reader.ts)
  // with the working model's request; the answer goes back as the tool's result.
  async read(id: string, source: string, text: string, prompt: string, signal: AbortSignal): Promise<{ text: string; model: string; usage: Usage }> {
    const session = this.store.session(id)!;
    const cur = (await this.providers.resolve(session.model)).info;
    const pick = pickReader(await this.providers.models(), cur, Math.ceil(text.length / 3) + 4_000);
    const { provider, info } = await this.providers.resolve(pick.id);
    const effort = info.efforts.includes("low") ? "low" : undefined;
    const st: Step = { provider, info, tools: [], system: "You read content for a coding agent and answer its request from that content.", systemSplit: 0, effort };
    const res = await this.call(id, { ...st, info: { ...info, output: Math.min(info.output, 8_192) } }, [{ role: "user", content: [{ type: "text", text: readerPrompt(source, prompt, text) }] }], signal, new Map(), session, true, "reader");
    this.store.addUsage(id, res.usage);
    this.emitSession(id);
    const answer = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    if (res.stop === "refusal" || !answer) throw new Error(`the reader (${info.name}) gave no answer`);
    return { text: answer, model: info.name, usage: res.usage };
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


// Continued turns after a restart: this many run at once, each start at least
// this far after the previous one. Three covers the usual one to three open
// sessions with no wait; more queue behind them.
const RESUME_AT_ONCE = Number(process.env.KEEL_RESUME_AT_ONCE || 3);
const RESUME_GAP_MS = Number(process.env.KEEL_RESUME_GAP_MS ?? 1000);
const RESUME_HOLD_MS = 30_000;

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
