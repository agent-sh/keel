import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Message, Session, StoredEvent, ToolResultBlock, ToolUseBlock, Usage } from "../core/types.ts";
import { addUsage, emptyUsage } from "../core/types.ts";
import type { Providers } from "../providers/registry.ts";
import type { ProviderRequest } from "../providers/types.ts";
import { toolsFor } from "../tools/registry.ts";
import { allHooks, type ToolCall } from "./hooks.ts";
import type { Tool, ToolContext } from "../tools/types.ts";

// Rebuild the wire conversation from stored events. Append-only: the same
// events always give the same bytes, so the provider's prefix cache holds.
export function toMessages(events: StoredEvent[]): Message[] {
  const out: Message[] = [];
  for (const e of events) {
    if (e.kind === "user") {
      const content: any[] = [...(e.data.images ?? []), { type: "text", text: e.data.text }];
      out.push({ role: "user", content });
    } else if (e.kind === "assistant") {
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
  // A message the owner sent while tools ran lands between the tool calls and
  // their results; results must lead the user message that follows tool_use.
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

function instructionFiles(cwd: string): string {
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

export class Engine {
  private running = new Map<string, Running>();
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

  interrupt(id: string) {
    this.running.get(id)?.abort.abort();
  }

  private emitEvent(e: StoredEvent) {
    this.bus.emit({ t: "event", event: e });
  }

  private setPhase(id: string, phase: "idle" | "working" | "error") {
    const s = this.store.updateSession(id, { phase });
    this.bus.emit({ t: "session", session: s });
  }

  send(id: string, text: string, images: any[] = []): StoredEvent {
    const ev = this.store.append(id, "user", { text, images: images.length ? images : undefined });
    this.emitEvent(ev);
    const s = this.store.session(id);
    if (s && !s.title) this.bus.emit({ t: "session", session: this.store.updateSession(id, { title: text.slice(0, 80).split("\n")[0] }) });
    if (!this.running.has(id)) this.start(id);
    return ev;
  }

  private start(id: string) {
    const abort = new AbortController();
    const done = this.loop(id, abort.signal)
      .catch((e) => {
        if (abort.signal.aborted) return;
        const rec = this.errors.capture("provider", e, { session: id });
        this.emitEvent(this.store.append(id, "error", { message: rec.message }));
      })
      .finally(() => {
        this.running.delete(id);
        const s = this.store.session(id);
        if (s) this.setPhase(id, "idle");
      });
    this.running.set(id, { abort, done });
  }

  private async loop(id: string, signal: AbortSignal) {
    const session = this.store.session(id)!;
    const { provider, info } = await this.providers.resolve(session.model);
    const tools: Tool[] = toolsFor(info.family);
    let system = this.systems.get(id);
    if (system === undefined) {
      const extra = (await Promise.all(allHooks().map((h) => h.system?.(session) ?? ""))).filter(Boolean);
      system = [systemPrompt(session.workspace, session.created), ...extra].join("\n\n");
      this.systems.set(id, system);
    }
    const seen = this.seen.get(id) ?? new Map();
    this.seen.set(id, seen);
    const ctx: ToolContext = { sessionId: id, cwd: session.workspace, signal, seen, spillDir: join(this.spillRoot, id) };
    const effort = info.efforts.includes("high") ? "high" : undefined;

    this.setPhase(id, "working");
    const t0 = Date.now();
    let usage: Usage = emptyUsage();
    this.emitEvent(this.store.append(id, "turn_start", { model: session.model }));
    let reason = "end_turn";
    try {
      for (;;) {
        const messages = toMessages(this.store.events(id));
        let req: ProviderRequest = { model: info.model, system, messages, tools, effort, maxTokens: info.output, signal };
        for (const h of allHooks()) if (h.beforeRequest) req = { ...req, ...(await h.beforeRequest(session, req)) };
        const res = await provider.stream(req, (d) => this.bus.emit({ t: "delta", session_id: id, ...d }));
        for (const h of allHooks()) await h.afterResponse?.(session, res, messages);
        usage = addUsage(usage, res.usage);
        this.store.addUsage(id, res.usage);
        this.emitEvent(this.store.append(id, "assistant", { blocks: res.blocks, model: session.model, usage: res.usage, stop: res.stop }));
        const uses = res.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
        if (res.stop !== "tool_use" || !uses.length) { reason = res.stop; break; }
        const results = await Promise.all(uses.map((u) => this.runTool(session, tools, u, ctx)));

        this.emitEvent(this.store.append(id, "tool_result", { results }));
        if (signal.aborted) { reason = "interrupted"; break; }
      }
    } catch (e) {
      reason = signal.aborted ? "interrupted" : "error";
      if (!signal.aborted) throw e;
    } finally {
      this.emitEvent(this.store.append(id, "turn_end", { reason, usage, ms: Date.now() - t0 }));
      for (const h of allHooks()) await Promise.resolve(h.turnEnd?.(session, reason)).catch((e) => this.errors.capture("server", e, { hook: "turnEnd" }));
    }
  }

  private async runTool(session: Session, tools: Tool[], u: ToolUseBlock, ctx: ToolContext): Promise<ToolResultBlock> {
    const tool = tools.find((t) => t.name === u.name);
    if (!tool) return { type: "tool_result", tool_use_id: u.id, content: `No tool named ${u.name}.`, is_error: true };
    const call: ToolCall = { id: u.id, tool, input: u.input ?? {}, ctx: { ...ctx, callId: u.id } };
    let result: ToolResultBlock;
    try {
      for (const h of allHooks()) {
        const g = await h.beforeTool?.(session, call);
        if (!g) continue;
        if ("deny" in g) return { type: "tool_result", tool_use_id: u.id, content: g.deny, is_error: true };
        if (g.input !== undefined) call.input = g.input;
        if (g.ctx) call.ctx = { ...call.ctx, ...g.ctx };
      }
      const out = await tool.run(call.input, call.ctx);
      result = { type: "tool_result", tool_use_id: u.id, content: out.content, is_error: out.is_error || undefined };
    } catch (e) {
      this.errors.capture("tool", e, { tool: u.name, session: ctx.sessionId });
      return { type: "tool_result", tool_use_id: u.id, content: `Tool failed: ${(e as Error).message}`, is_error: true };
    }
    for (const h of allHooks()) await Promise.resolve(h.afterTool?.(session, call, result)).catch((e) => this.errors.capture("server", e, { hook: "afterTool" }));
    return result;
  }
}
