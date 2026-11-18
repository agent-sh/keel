import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import type { AssistantBlock, Message, Session, StoredEvent, ToolResultBlock, ToolUseBlock, TurnStatus, Usage } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import type { ModelInfo, Provider, ProviderRequest, ProviderResult } from "../providers/types.ts";
import { toolsFor } from "../tools/registry.ts";
import { allHooks, type ToolCall } from "./hooks.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { COMPACT_SHARE, contextTokens, ownerWords, summaryMessage, summaryPrompt } from "./compact.ts";
import { withoutImages } from "./images.ts";
import { RETRY, backoffMs, errorText, retryable, sleep } from "./retry.ts";

// A reply cut by the output limit is continued this many times in a row, then
// the turn ends and says so.
export const MAX_CONTINUATIONS = 3;

// Rebuild the wire conversation from the stored events of one branch (oldest
// first). Pure: the same events always give the same bytes, so the provider's
// prefix cache holds across turns.
export function toMessages(events: StoredEvent[]): Message[] {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "compaction") { start = i; break; }
  const out: Message[] = [];
  for (let i = start; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "compaction") {
      if (e.data.mode === "summary") out.push(summaryMessage(e.data));
    } else if (e.kind === "user") {
      const content: any[] = [...(e.data.images ?? []), { type: "text", text: e.data.text }];
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

export function instructionFiles(cwd: string): string {
  const parts: string[] = [];
  let dir = cwd;
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = join(dir, name);
      if (existsSync(p)) {
        try { parts.unshift(`# ${p}\n\n${readFileSync(p, "utf8").slice(0, 40_000)}`); } catch {}
        break; // AGENTS.md wins over CLAUDE.md in the same folder
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return parts.join("\n\n");
}

// Frozen per session: nothing in it changes between turns (no clock), so the
// tools + system prefix stays cached for the whole session.
function systemPrompt(cwd: string, created: number): string {
  const inst = instructionFiles(cwd);
  return [
    "You are Keel, a coding agent working on the owner's machine through tools.",
    "Do the task fully. Read before you edit. Keep replies short: lead with the result.",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}. Session started ${new Date(created).toISOString().slice(0, 10)}.`,
    inst ? `\nInstructions from the owner's files:\n\n${inst}` : "",
  ].join("\n");
}

type Running = { abort: AbortController; done: Promise<void> };
type Step = { provider: Provider; info: ModelInfo; tools: Tool[]; system: string; effort?: string };

const abortError = () => Object.assign(new Error("interrupted"), { name: "AbortError" });

export class Engine {
  private running = new Map<string, Running>();
  private held = new Set<string>();
  private seen = new Map<string, Map<string, number>>();
  private systems = new Map<string, string>();

  constructor(
    private store: Store,
    private bus: Bus,
    private providers: Providers,
    private errors: ErrorTracker,
    private spillRoot: string,
  ) {}

  isRunning(id: string) {
    return this.running.has(id);
  }

  isHeld(id: string) {
    return this.held.has(id);
  }

  lineage(id: string): StoredEvent[] {
    return lineage(this.store.events(id), this.store.session(id)?.head ?? null);
  }

  // Stop the running turn: the model stream and running tools are cut, the
  // queue is held (nothing starts by itself until the owner sends or resumes),
  // and steers that did not reach the turn become ordinary queued prompts.
  async interrupt(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    this.held.add(id);
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

  private status(id: string, status: TurnStatus) {
    this.bus.emit({ t: "status", session_id: id, status });
  }

  private setPhase(id: string, phase: Session["phase"]) {
    const s = this.store.updateSession(id, { phase });
    this.bus.emit({ t: "session", session: s });
  }

  private titleFrom(id: string, text: string) {
    const s = this.store.session(id);
    if (s && !s.title) this.bus.emit({ t: "session", session: this.store.updateSession(id, { title: text.slice(0, 80).split("\n")[0] }) });
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
      const q = this.store.enqueue(id, text, mode !== "queue");
      this.emitQueue(id);
      return { queued: q, steer: q.steer };
    }
    this.held.delete(id);
    const ev = this.append(id, "user", { text, images: opts.images?.length ? opts.images : undefined, ...opts.meta });
    this.titleFrom(id, text);
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
    this.held.delete(id);
    const ev = this.append(id, "user", { text, images: old.data.images }, old.parent);
    this.emitSession(id);
    this.start(id);
    this.emitQueue(id);
    return { event: ev };
  }

  // A queued prompt now: the running turn stops and this one is the next turn.
  async sendNow(id: string, qid: string) {
    const q = this.store.queueItem(qid);
    if (!q || q.session_id !== id) throw Object.assign(new Error("no such queued prompt"), { status: 404 });
    await this.interrupt(id);
    this.store.dequeue(qid);
    this.held.delete(id);
    this.append(id, "user", { text: q.text, origin: "queued" });
    this.start(id);
    this.emitQueue(id);
  }

  resumeQueue(id: string) {
    this.held.delete(id);
    if (!this.running.has(id)) this.next(id);
    this.emitQueue(id);
  }

  // Continue a session whose last turn was stopped, failed or was cut.
  resume(id: string) {
    if (this.running.has(id)) throw Object.assign(new Error("a turn is running"), { status: 409 });
    this.held.delete(id);
    this.append(id, "user", { text: "[harness] The previous turn was stopped before it finished. Continue where it left off.", origin: "harness" });
    this.start(id);
    this.emitQueue(id);
  }

  // After a turn: the next queued prompt starts, unless the queue is held.
  private next(id: string) {
    if (this.held.has(id) || this.running.has(id)) return;
    const s = this.store.session(id);
    if (!s || s.archived) return;
    const q = this.store.queue(id)[0];
    if (!q) return;
    this.store.dequeue(q.id);
    this.append(id, "user", { text: q.text, origin: q.steer ? "steer" : "queued" });
    this.start(id);
    this.emitQueue(id);
  }

  private start(id: string) {
    const abort = new AbortController();
    const done = this.loop(id, abort.signal)
      .catch((e) => {
        if (abort.signal.aborted) return;
        const rec = this.errors.capture("provider", e, { session: id });
        this.append(id, "error", { message: errorText(e), error_id: rec.id });
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
    let system = this.systems.get(session.id);
    if (system === undefined) {
      const extra = (await Promise.all(allHooks().map((h) => h.system?.(session) ?? ""))).filter(Boolean);
      system = [systemPrompt(session.workspace, session.created), ...extra].join("\n\n");
      this.systems.set(session.id, system);
    }
    const want = session.settings.effort;
    const effort = want && info.efforts.includes(want) ? want : info.efforts.includes("high") ? "high" : undefined;
    return { provider, info, tools: toolsFor(info.family), system, effort };
  }

  // One provider call with retries for passing failures. The UI is told about
  // each wait and the half-streamed reply of a failed attempt is dropped.
  private async call(id: string, st: Step, messages: Message[], signal: AbortSignal, partial: Map<number, { kind: string; text: string }>, session: Session, quiet = false): Promise<ProviderResult> {
    for (let attempt = 0; ; attempt++) {
      partial.clear();
      let req: ProviderRequest = { model: st.info.model, system: st.system, messages: st.info.images === false ? withoutImages(messages, st.info.name ?? st.info.model) : messages, tools: st.tools, effort: st.effort, maxTokens: st.info.output, signal, sessionKey: id };
      for (const h of allHooks()) if (h.beforeRequest) req = { ...req, ...(await h.beforeRequest(session, req)) };
      try {
        const res = await st.provider.stream(req, (d) => {
          const p = partial.get(d.index) ?? { kind: d.kind, text: "" };
          p.text += d.text;
          partial.set(d.index, p);
          if (!quiet) this.bus.emit({ t: "delta", session_id: id, ...d });
        });
        if (attempt) this.status(id, { kind: "idle" });
        return res;
      } catch (e) {
        if (signal.aborted) throw abortError();
        if (!retryable(e) || attempt + 1 >= RETRY.max) throw e;
        const wait = backoffMs(attempt, e);
        this.errors.capture("provider", e, { session: id, retry: attempt + 1, wait_ms: wait });
        this.status(id, { kind: "retry", attempt: attempt + 1, max: RETRY.max - 1, at: Date.now() + wait, message: errorText(e) });
        await sleep(wait, signal);
      }
    }
  }

  private async loop(id: string, signal: AbortSignal) {
    let session = this.store.session(id)!;
    let st = await this.step(session, session.model);
    const seen = this.seen.get(id) ?? new Map();
    this.seen.set(id, seen);
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id) };

    this.setPhase(id, "working");
    const t0 = Date.now();
    let usage: Usage = emptyUsage();
    this.append(id, "turn_start", { model: session.model, effort: st.effort });
    let reason = "end_turn";
    let cuts = 0;
    let fellBack = false;
    let compactedForFit = false;
    const partial = new Map<number, { kind: string; text: string }>();
    try {
      for (;;) {
        // Steers sent while the last step ran join here, after its tool results.
        for (const q of this.store.queue(id).filter((q) => q.steer)) {
          this.store.dequeue(q.id);
          this.append(id, "user", { text: q.text, origin: "steer" });
          this.emitQueue(id);
        }
        session = this.store.session(id)!;
        let events = this.lineage(id);
        const limit = session.settings.compact_at ?? Math.floor(st.info.context * COMPACT_SHARE);
        if (events.some((e) => e.kind === "assistant") && contextTokens(events).used >= limit) {
          await this.compactNow(id, { auto: true, signal, step: st });
          events = this.lineage(id);
        }
        const messages = toMessages(events);
        let res: ProviderResult;
        try {
          res = await this.call(id, st, messages, signal, partial, session);
        } catch (e) {
          // The request no longer fits the window: compact once and go on.
          if (!signal.aborted && (e as any)?.kind === "context" && !compactedForFit) {
            compactedForFit = true;
            await this.compactNow(id, { auto: true, signal, step: st });
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

        let blocks: AssistantBlock[] = res.blocks;
        if (res.stop === "max_tokens" && blocks.at(-1)?.type === "tool_use") blocks = blocks.slice(0, -1); // its input was cut
        this.append(id, "assistant", { blocks, model: st.info.id, usage: u, stop: res.stop });

        if (res.stop === "model_context_window_exceeded") {
          await this.compactNow(id, { auto: true, signal, step: st });
          continue;
        }
        const uses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (uses.length) {
          const results = await Promise.all(uses.map((u) => this.runTool(session, st.tools, u, ctx)));
          this.append(id, "tool_result", { results });
          if (signal.aborted) { reason = "interrupted"; break; }
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
      reason = signal.aborted ? "interrupted" : "error";
      if (!signal.aborted) throw e;
    } finally {
      this.append(id, "turn_end", { reason, usage, ms: Date.now() - t0 });
      for (const h of allHooks()) await Promise.resolve(h.turnEnd?.(session, reason)).catch((e) => this.errors.capture("server", e, { hook: "turnEnd", session: id }));
    }
  }

  private async runTool(session: Session, tools: Tool[], u: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlock> {
    const interrupted: ToolResultBlock = { type: "tool_result", tool_use_id: u.id, content: "Interrupted by the user while this tool ran.", is_error: true };
    if (ctx.signal.aborted) return interrupted;
    const tool = tools.find((t) => t.name === u.name);
    if (!tool) return { type: "tool_result", tool_use_id: u.id, content: `No tool named ${u.name}.`, is_error: true };
    const call: ToolCall = { id: u.id, tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id } };
    // An interrupt answers at once, whether or not a gate or the tool honors the signal.
    const stopped = new Promise<null>((r) => ctx.signal.addEventListener("abort", () => r(null), { once: true }));
    let result: ToolResultBlock;
    try {
      for (const h of allHooks()) {
        if (!h.beforeTool) continue;
        const gate = Promise.resolve(h.beforeTool(session, call));
        gate.catch(() => {});
        const g = await Promise.race([gate, stopped]);
        if (ctx.signal.aborted) return interrupted;
        if (!g) continue;
        if ("deny" in g) return { type: "tool_result", tool_use_id: u.id, content: g.deny, is_error: true };
        if (g.input !== undefined) call.input = g.input;
        if (g.ctx) call.ctx = { ...call.ctx, ...g.ctx };
      }
      // A dispatch set by a hook runs the call elsewhere (another machine's hands).
      const run = call.ctx.dispatch ? call.ctx.dispatch(tool, call.input, call.ctx) : tool.run(call.input, call.ctx);
      // After a stop the tool may still fail on its way out; that is expected.
      run.catch(() => {});
      const out = await Promise.race([run, stopped]);
      if (!out) return interrupted;
      result = { type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.is_error || undefined };
    } catch (e) {
      if (ctx.signal.aborted) return interrupted;
      this.errors.capture("tool", e, { tool: u.name, session: ctx.sessionId });
      return { type: "tool_result", tool_use_id: u.id, content: `Tool failed: ${(e as Error).message}`, is_error: true };
    }
    for (const h of allHooks()) await Promise.resolve(h.afterTool?.(session, call, result)).catch((e) => this.errors.capture("server", e, { hook: "afterTool", tool: u.name, session: session.id }));
    return result;
  }

  // Summarize the context into a checkpoint. Runs inside a turn (auto, before a
  // call that would not fit) or on the owner's request between turns.
  async compactNow(id: string, opts: { focus?: string; auto?: boolean; signal?: AbortSignal; step?: Step } = {}) {
    const session = this.store.session(id)!;
    const events = this.lineage(id);
    const messages = toMessages(events);
    if (!messages.length || (events.at(-1)?.kind === "compaction")) throw Object.assign(new Error("nothing to compact"), { status: 409 });
    const st = opts.step ?? (await this.step(session, session.model));
    const before = contextTokens(events).used;
    this.status(id, { kind: "compacting", auto: !!opts.auto });
    const own = new AbortController();
    const signal = opts.signal ?? own.signal;
    try {
      // The same tools and system as the session's turns: that prefix is read from cache.
      const ask: Message[] = [...messages, { role: "user", content: [{ type: "text", text: summaryPrompt(opts.focus) }] }];
      const res = await this.call(id, st, ask, signal, new Map(), session, true); // the summary is not a reply
      const u: Usage = res.usage;
      this.store.addUsage(id, u);
      const summary = res.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (res.stop === "refusal" || !summary) throw Object.assign(new Error("the model wrote no summary"), { status: 409 });
      const ev = this.append(id, "compaction", {
        mode: "summary", summary, owner_messages: ownerWords(events), focus: opts.focus, auto: !!opts.auto,
        tokens_before: before, usage: u, model: st.info.id,
      });
      this.emitSession(id);
      return ev;
    } finally {
      this.status(id, { kind: "idle" });
    }
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
