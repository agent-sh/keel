import type { StoredEvent } from "../core/types.ts";
import { heldSays } from "../core/stoppers.ts";
import { bytesPerToken, utf8Bytes } from "../engine/compact.ts";
import type { Deps } from "../server/app.ts";

// The daemon's parts, set once when the automation routes are built (before any
// turn runs). Tools reach the engine and the store through this.
let deps: Deps | undefined;
// What a module set up against the parts before these (the failure notice's
// rider reads its store's table) goes with them: it is set up again for these.
export const setDeps = (d: Deps) => {
  // A flush that waits under the dependencies before these never runs under these.
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  deps = d;
  rider.get = undefined;
};
export function D(): Deps {
  if (!deps) throw new Error("automation is not initialized");
  return deps;
}

// The tool family of a session's model, from the listing (never from its name).
export const familyOf = (model: string) => D().providers.current().find((m) => m.id === model)?.family ?? "claude";

// A frame that changes the inbox (an alert raised or changed, alerts read or marked unread)
// carries the unread counts after it (`counts`), so a page applies it and reads nothing.
export const inboxCounts: { get?: () => unknown } = {};
export function emit(kind: "agent" | "wait" | "loop" | "alert" | "alerts_read" | "activity" | "snooze" | "goal" | "tasks", data: unknown) {
  let counts: unknown;
  if (kind === "alert" || kind === "alerts_read") try { counts = inboxCounts.get?.(); } catch (e) { capture(e, { at: "inbox counts" }); }
  D().bus.emit({ t: "feature", name: "automation", data: counts ? { kind, data, counts } : { kind, data } });
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
// `ride`: the input starts no turn and is not counted as lined up: it goes with whatever is sent next.
// refresh: the part as it is when sent (its text, and what sending it settles), or nothing when it no
// longer holds. `parts`: the meta of everything lined up with it, itself included.
type Parts = Record<string, unknown>[];
type Delivery = { coalesceMs?: number; hold?: boolean; ride?: boolean; onSent?: (e: StoredEvent) => void; refresh?: (parts: Parts) => (Input & { onSent?: (e: StoredEvent) => void }) | undefined };
export type Pending = Input & Omit<Delivery, "coalesceMs" | "ride">;
// A part that never starts a turn of its own and goes with whatever is sent
// next (the failure notice). `parts`: the meta of what is being sent.
export const rider: { get?: (sessionId: string, parts: Parts) => Pending | undefined } = {};
const pending = new Map<string, Pending[]>();
const riding = new Map<string, Pending[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function hasPending(sessionId: string) {
  return (pending.get(sessionId)?.length ?? 0) > 0;
}

export function deliver(sessionId: string, text: string, meta: Record<string, unknown>, opts: Delivery = {}): boolean {
  const s = D().store.session(sessionId);
  if (!s || s.archived) return false;
  const lists = opts.ride ? riding : pending;
  const list = lists.get(sessionId) ?? [];
  list.push({ text, meta, onSent: opts.onSent, refresh: opts.refresh });
  lists.set(sessionId, list);
  // A session the owner is archiving or deleting right now: kept back, and sent only if it stays (closingOver).
  if (D().engine.isClosing?.(sessionId)) return true;
  if (D().engine.isRunning(sessionId) || opts.hold || opts.ride) return true; // flushed by the turn-end hook, or with the next input
  if (opts.coalesceMs) {
    if (!timers.has(sessionId)) timers.set(sessionId, setTimeout(() => { timers.delete(sessionId); flush(sessionId); }, opts.coalesceMs));
  } else flush(sessionId);
  return true;
}

export function dropPending(sessionId: string) {
  pending.delete(sessionId);
  riding.delete(sessionId);
}

// Takes back inputs not sent yet (a report a wait already returned, the prompt
// of a loop that was deleted); the rest still goes. Returns how many went.
export function withdraw(sessionId: string, which: (meta: Record<string, unknown>) => boolean): number {
  let went = 0;
  for (const lists of [pending, riding]) {
    const list = lists.get(sessionId);
    if (!list) continue;
    const keep = list.filter((p) => !which(p.meta));
    if (keep.length) lists.set(sessionId, keep);
    else lists.delete(sessionId);
    went += list.length - keep.length;
  }
  return went;
}

// Lined up to be sent, or riding with what is sent next.
export const isPending = (sessionId: string, which: (meta: Record<string, unknown>) => boolean) =>
  [pending, riding].some((lists) => lists.get(sessionId)?.some((p) => which(p.meta)));

// Takes back what rides (never what is lined up) and says what it took: the
// reason it could start no turn is gone, and its sender lines it up again.
export function takeRiding(sessionId: string, which: (meta: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const list = riding.get(sessionId) ?? [];
  const took = list.filter((p) => which(p.meta));
  if (!took.length) return [];
  if (took.length < list.length) riding.set(sessionId, list.filter((p) => !which(p.meta)));
  else riding.delete(sessionId);
  return took.map((p) => p.meta);
}

// One input holds at most this share of the model's window; the parts over it
// wait for the next input. A quarter: when the context is compacted the next
// request is the system prompt and the tools, the summary (itself up to a
// quarter of the window) and this input whole, and the turn still needs room
// to work in. An input longer than the window cannot be sent at all.
const INPUT_SHARE = 0.25;
function inputRoom(model: string): number {
  const window = D().providers.current().find((m) => m.id === model)?.context;
  return window ? Math.floor(window * INPUT_SHARE * bytesPerToken(model)) : Infinity;
}

export function flush(sessionId: string) {
  const list = pending.get(sessionId);
  if (!list?.length) return;
  // A daemon on its way down starts no turn: what is owed is sent by the next one. Nor does a
  // session on its way out (asked here, where the turn would start, whatever was true at delivery).
  // Nor does a session where the owner's own message is about to be the next turn (a prompt they
  // edited or sent now): what waits here goes after that turn, never in its place.
  if (D().engine.isRunning(sessionId) || D().engine.isDraining?.() || D().engine.isClosing?.(sessionId) || D().engine.startsNext?.(sessionId)) return;
  pending.delete(sessionId);
  const s = D().store.session(sessionId);
  if (!s || s.archived) return void riding.delete(sessionId);
  let rest: Pending[] = [];
  try {
    // What fits one input, in order: the first part always goes, and so does
    // the first that rides, so every input moves what waits forward.
    const rides = riding.get(sessionId) ?? [];
    const room = list.length + rides.length > 1 ? inputRoom(s.model) : Infinity;
    let size = 0;
    const fits = (parts: Pending[]) => {
      const over = parts.findIndex((p, i) => {
        const bytes = utf8Bytes(p.text);
        if (i > 0 && size + bytes > room) return true;
        size += bytes;
        return false;
      });
      return over < 0 ? parts.length : over;
    };
    const cut = fits(list);
    rest = list.slice(cut);
    const taken = new Set(rides.slice(0, fits(rides)));
    // Live statuses can change while the recipient is busy. Recheck them
    // before grouping the parts; a withdrawn status must not start a turn.
    const lined = [...list.slice(0, cut), ...taken].map((p) => p.meta);
    const fresh = (p: Pending) => {
      if (!p.refresh) return [p];
      const next = p.refresh(lined);
      return next ? [{ ...p, ...next }] : [];
    };
    const current = list.slice(0, cut).flatMap(fresh);
    if (current.length) {
      // What rides goes now, read as it is now; one that no longer holds is
      // dropped. A part that became a rider in this pass (a report whose
      // parent the owner stopped since) goes too. The rest keeps riding.
      const all = riding.get(sessionId) ?? [];
      const stay = all.filter((p) => rides.includes(p) && !taken.has(p));
      current.push(...all.filter((p) => !stay.includes(p)).flatMap(fresh));
      if (stay.length) riding.set(sessionId, stay);
      else riding.delete(sessionId);
      const extra = rider.get?.(sessionId, current.map((p) => p.meta));
      if (extra) current.push(extra);
      // The failure notice reads last, after the reports and wakes it comes with
      // (what shows it finds it there, whatever a report quotes).
      current.sort((a, b) => Number(a.meta.kind === "failures") - Number(b.meta.kind === "failures"));
      const kinds = [...new Set(current.map((p) => p.meta.kind))];
      const meta = current.length === 1 ? current[0]!.meta : { kind: kinds.length === 1 ? kinds[0] : "wake", parts: current.map((p) => p.meta) };
      // The prompt and what sending it settles (a wake no longer owed, a
      // report handed over, a run started) are one write: a daemon killed
      // here has stored both or neither, so the next one sends nothing twice.
      // A part whose settling fails stays owed and is told again; the prompt stands.
      D().store.atomic(sessionId, () => {
        const r = D().engine.send(sessionId, current.map((p) => p.text).join("\n\n"), { meta });
        if (!r.event) return;
        for (const p of current) try { p.onSent?.(r.event); } catch (e) { capture(e, { at: "deliver", session: sessionId, settling: p.meta.kind }); }
      });
    }
  } catch (e) {
    capture(e, { at: "deliver", session: sessionId });
  }
  // What did not fit is the next input: after the turn this one started, or
  // now when nothing of this one was left to send.
  if (!rest.length) return;
  pending.set(sessionId, [...rest, ...(pending.get(sessionId) ?? [])]);
  if (!D().engine.isRunning(sessionId)) flush(sessionId);
}

// After a drain that was called off: what came due while the daemon started
// no turn (a wait that fired, an agent's report, a loop run) is sent now.
// What a drain put off besides queued input (a goal's check of a turn that
// ended while the daemon drained): run when the drain is called off.
export const afterCallOff: (() => void)[] = [];
export function flushAll() {
  for (const id of [...pending.keys()]) flush(id);
  for (const f of afterCallOff) try { f(); } catch (e) { capture(e, { at: "after a called-off restart" }); }
}

// Called by the turn-end hook: once the turn has fully ended, what waited runs.
export function afterTurn(sessionId: string, then?: () => void) {
  D().engine.idle(sessionId).then(() => {
    try { then?.(); } catch (e) { capture(e, { at: "afterTurn" }); }
    flush(sessionId);
  });
}

// Who stopped the session's last turn, when it ended as stopped: the word its end keeps (src/core/stoppers.ts).
// Nothing for a turn that ended otherwise, or one stopped before every stop was named.
export function stopperOf(sessionId: string): string | undefined {
  const end = D().store.lineage(sessionId).findLast((e) => e.kind === "turn_end");
  return end?.data.reason === "interrupted" && typeof end.data.stopped_by === "string" ? end.data.stopped_by : undefined;
}

// Why the session's queue is held, in words for its model: who made the hold (a stop names itself,
// src/core/stoppers.ts). Nothing when it is not held.
export const heldWhy = (sessionId: string): string | undefined => (D().engine.isHeld(sessionId) ? heldSays(D().engine.heldBy(sessionId)) : undefined);

// Said after a report or a failure notice while other agents of the session
// still run (models set timers to wait for the rest). In a session held after
// the owner's Stop a report starts no turn, so it is not said to wake it.
// `held`: why its queue is held (heldWhy), when it is.
export const stillRunning = (left: number, held: string | undefined) =>
  `\n${left} more of your agents ${left === 1 ? "is" : "are"} still running; ${held
    ? `${held}, so ${left === 1 ? "its report does" : "their reports do"} not wake you: ${left === 1 ? "it comes" : "they come"} with your next input.`
    : `${left === 1 ? "its report wakes" : "their reports wake"} you when ready, so end your turn unless you have other work.`}`;

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
