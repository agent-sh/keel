import type { StoredEvent } from "../core/types.ts";
import type { Deps } from "../server/app.ts";

// The daemon's parts, set once when the automation routes are built (before any
// turn runs). Tools reach the engine and the store through this.
let deps: Deps | undefined;
export const setDeps = (d: Deps) => void (deps = d);
export function D(): Deps {
  if (!deps) throw new Error("automation is not initialized");
  return deps;
}

// The tool family of a session's model, from the listing (never from its name).
export const familyOf = (model: string) => D().providers.current().find((m) => m.id === model)?.family ?? "claude";

export function emit(kind: "agent" | "wait" | "loop" | "alert" | "alerts_read" | "activity" | "snooze", data: unknown) {
  D().bus.emit({ t: "feature", name: "automation", data: { kind, data } });
}

// Set by the alerts module; loops and agents raise through it.
export const alertHook: { raise?: (kind: string, sessionId: string | null, title: string, body: string, data?: unknown) => void } = {};

export const capture = (err: unknown, context?: unknown) => D().errors.capture("server", err, { area: "automation", ...(context as object) });

// Input that is not the owner's typing: subagent results, wakes, loop runs. It
// never lands inside a running turn (between a tool call and its result): it
// starts a turn when the session is idle and waits for the turn to end when it
// is busy. Inputs waiting together arrive as one message.
type Pending = { text: string; meta: Record<string, unknown>; onSent?: (e: StoredEvent) => void };
const pending = new Map<string, Pending[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function hasPending(sessionId: string) {
  return (pending.get(sessionId)?.length ?? 0) > 0;
}

export function deliver(sessionId: string, text: string, meta: Record<string, unknown>, opts: { coalesceMs?: number; onSent?: (e: StoredEvent) => void } = {}): boolean {
  const s = D().store.session(sessionId);
  if (!s || s.archived) return false;
  const list = pending.get(sessionId) ?? [];
  list.push({ text, meta, onSent: opts.onSent });
  pending.set(sessionId, list);
  if (D().engine.isRunning(sessionId)) return true; // flushed by the turn-end hook
  if (opts.coalesceMs) {
    if (!timers.has(sessionId)) timers.set(sessionId, setTimeout(() => { timers.delete(sessionId); flush(sessionId); }, opts.coalesceMs));
  } else flush(sessionId);
  return true;
}

export function dropPending(sessionId: string) {
  pending.delete(sessionId);
}

export function flush(sessionId: string) {
  const list = pending.get(sessionId);
  if (!list?.length) return;
  if (D().engine.isRunning(sessionId)) return;
  pending.delete(sessionId);
  const s = D().store.session(sessionId);
  if (!s || s.archived) return;
  const kinds = [...new Set(list.map((p) => p.meta.kind))];
  const meta = list.length === 1 ? list[0]!.meta : { kind: kinds.length === 1 ? kinds[0] : "wake", parts: list.map((p) => p.meta) };
  try {
    const r = D().engine.send(sessionId, list.map((p) => p.text).join("\n\n"), { meta });
    if (r.event) for (const p of list) p.onSent?.(r.event);
  } catch (e) {
    capture(e, { at: "deliver", session: sessionId });
  }
}

// Called by the turn-end hook: once the turn has fully ended, what waited runs.
export function afterTurn(sessionId: string, then?: () => void) {
  D().engine.idle(sessionId).then(() => {
    try { then?.(); } catch (e) { capture(e, { at: "afterTurn" }); }
    flush(sessionId);
  });
}

// Text a model or a webhook wrote is put inside a frame it cannot close.
export function inert(text: string, tag: string): string {
  return text.replace(new RegExp(`<(\\s*/?\\s*${tag})`, "gi"), "&lt;$1");
}

export const attr = (v: unknown) => String(v ?? "").replace(/[<>"\n]/g, " ").slice(0, 200);

export function lastAssistantText(sessionId: string, afterSeq = 0): string {
  const evs = D().store.events(sessionId, afterSeq);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.kind !== "assistant") continue;
    const t = (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (t) return t;
  }
  return "";
}
