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

export function emit(kind: "agent" | "wait" | "loop" | "alert" | "alerts_read" | "activity" | "snooze" | "goal" | "tasks", data: unknown) {
  D().bus.emit({ t: "feature", name: "automation", data: { kind, data } });
}

// Set by the alerts module; loops and agents raise through it.
export const alertHook: { raise?: (kind: string, sessionId: string | null, title: string, body: string, data?: unknown) => void } = {};

export const capture = (err: unknown, context?: unknown) => D().errors.capture("server", err, { area: "automation", ...(context as object) });

// Text cut to at most `max` UTF-16 units on a whole character (a grapheme, so an
// emoji or a flag is never split), with an ellipsis when something was cut.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const { segment } of graphemes.segment(s)) {
    if (out.length + segment.length > max - 1) break;
    out += segment;
  }
  return out + "…";
}

// A row reference for keyset paging: "ts:id" (ids are time-ordered), or a bare
// timestamp from an older client.
export function cursor(before: string | null | undefined): { ts: number; id: string } | undefined {
  if (!before) return undefined;
  const [t, id = ""] = before.split(":");
  const ts = Number(t);
  if (!Number.isFinite(ts)) throw Object.assign(new Error("before is a cursor (ts:id)"), { status: 400 });
  return { ts, id };
}

// Input that is not the owner's typing: subagent results, wakes, loop runs. It
// never lands inside a running turn (between a tool call and its result): it
// starts a turn when the session is idle and waits for the turn to end when it
// is busy. Inputs waiting together arrive as one message.
type Input = { text: string; meta: Record<string, unknown> };
// `hold`: the input waits for the session's next turn to end (a turn the engine is about to continue).
// refresh: the part as it is when sent (its text, and what sending it settles), or nothing when it no
// longer holds. `parts`: the meta of everything lined up with it, itself included.
type Parts = Record<string, unknown>[];
type Delivery = { coalesceMs?: number; hold?: boolean; onSent?: (e: StoredEvent) => void; refresh?: (parts: Parts) => (Input & { onSent?: (e: StoredEvent) => void }) | undefined };
export type Pending = Input & Omit<Delivery, "coalesceMs">;
// A part that never starts a turn of its own and goes with whatever is sent
// next (the failure notice). `parts`: the meta of what is being sent.
export const rider: { get?: (sessionId: string, parts: Parts) => Pending | undefined } = {};
const pending = new Map<string, Pending[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function hasPending(sessionId: string) {
  return (pending.get(sessionId)?.length ?? 0) > 0;
}

export function deliver(sessionId: string, text: string, meta: Record<string, unknown>, opts: Delivery = {}): boolean {
  const s = D().store.session(sessionId);
  if (!s || s.archived) return false;
  const list = pending.get(sessionId) ?? [];
  list.push({ text, meta, onSent: opts.onSent, refresh: opts.refresh });
  pending.set(sessionId, list);
  if (D().engine.isRunning(sessionId) || opts.hold) return true; // flushed by the turn-end hook
  if (opts.coalesceMs) {
    if (!timers.has(sessionId)) timers.set(sessionId, setTimeout(() => { timers.delete(sessionId); flush(sessionId); }, opts.coalesceMs));
  } else flush(sessionId);
  return true;
}

export function dropPending(sessionId: string) {
  pending.delete(sessionId);
}

// Takes back inputs not sent yet (a report a wait already returned, the prompt
// of a loop that was deleted); the rest still goes. Returns how many went.
export function withdraw(sessionId: string, which: (meta: Record<string, unknown>) => boolean): number {
  const list = pending.get(sessionId);
  if (!list) return 0;
  const keep = list.filter((p) => !which(p.meta));
  if (keep.length) pending.set(sessionId, keep);
  else pending.delete(sessionId);
  return list.length - keep.length;
}

export const isPending = (sessionId: string, which: (meta: Record<string, unknown>) => boolean) => !!pending.get(sessionId)?.some((p) => which(p.meta));

export function flush(sessionId: string) {
  const list = pending.get(sessionId);
  if (!list?.length) return;
  // A daemon on its way down starts no turn: what is owed is sent by the next one.
  if (D().engine.isRunning(sessionId) || D().engine.isDraining?.()) return;
  pending.delete(sessionId);
  const s = D().store.session(sessionId);
  if (!s || s.archived) return;
  try {
    // Live statuses can change while the recipient is busy. Recheck them
    // before grouping the parts; a withdrawn status must not start a turn.
    const lined = list.map((p) => p.meta);
    const current = list.flatMap((p) => {
      if (!p.refresh) return [p];
      const next = p.refresh(lined);
      return next ? [{ ...p, ...next }] : [];
    });
    if (!current.length) return;
    const extra = rider.get?.(sessionId, current.map((p) => p.meta));
    if (extra) current.push(extra);
    // The failure notice reads last, after the reports and wakes it comes with
    // (what shows it finds it there, whatever a report quotes).
    current.sort((a, b) => Number(a.meta.kind === "failures") - Number(b.meta.kind === "failures"));
    const kinds = [...new Set(current.map((p) => p.meta.kind))];
    const meta = current.length === 1 ? current[0]!.meta : { kind: kinds.length === 1 ? kinds[0] : "wake", parts: current.map((p) => p.meta) };
    const r = D().engine.send(sessionId, current.map((p) => p.text).join("\n\n"), { meta });
    if (r.event) for (const p of current) p.onSent?.(r.event);
  } catch (e) {
    capture(e, { at: "deliver", session: sessionId });
  }
}

// After a drain that was called off: what came due while the daemon started
// no turn (a wait that fired, an agent's report, a loop run) is sent now.
export function flushAll() {
  for (const id of [...pending.keys()]) flush(id);
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
