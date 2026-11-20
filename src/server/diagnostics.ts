import type { ErrorCapture } from "../core/errors.ts";
import type { Deps } from "./app.ts";

const LABEL = { provider: "Provider", server: "Daemon", tool: "Tool" };
const MAX_ROWS = 8;
// Enough for 64 full batches, with active repeats kept more recent than quiet IDs.
const MAX_REPORTED = 512;

// One best-effort wake, not a second error log or a durable job. Never hand
// captured text to a model. Only the error tracker's own ID crosses sessions.
export function relayDiagnostics(
  { store, bus, errors, engine }: Pick<Deps, "store" | "bus" | "errors" | "engine">,
  sessionId: string,
  { batchMs = 10_000, spacingMs = 60_000 } = {},
) {
  const pending = new Map<string, { source: Exclude<ErrorCapture["source"], "client">; count: number }>();
  const reported = new Set<string>();
  let overflow = 0;
  let notBefore = 0;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    overflow = 0;
  };
  const eligible = () => {
    const s = store.session(sessionId);
    return s && !s.archived && !s.parent_id && !s.machine && !s.workspace_gone && s.settings.accept_messages !== false;
  };
  const ready = () => {
    if (engine.isRunning(sessionId) || engine.isHeld(sessionId) || store.queue(sessionId).length) return false;
    // At boot, the engine may be waiting for the model before resuming a
    // parked turn. A new wake must not change its head and preempt recovery.
    const head = store.session(sessionId)?.head;
    const last = head ? store.event(head) : undefined;
    return last?.kind !== "turn_end" || last.data.reason !== "restart";
  };

  function remember(id: string) {
    reported.delete(id);
    reported.add(id);
    if (reported.size > MAX_REPORTED) reported.delete(reported.values().next().value!);
  }

  function flush() {
    timer = undefined;
    try {
      if (stopping || engine.isDraining() || !eligible() || !pending.size) return clear();
      if (!ready()) return; // a later session/queue frame will schedule it
      notBefore = Date.now() + spacingMs;
      const rows = [...pending].map(([id, r]) => `${LABEL[r.source]}: ${r.count} occurrence${r.count === 1 ? "" : "s"} (Errors ID: ${id})`);
      if (overflow) rows.push(`${overflow} additional occurrence${overflow === 1 ? "" : "s"} not listed; see Errors.`);
      // An overflow count is not an incident receipt. Only IDs in the
      // outgoing batch are remembered, even if send fails after appending.
      for (const id of pending.keys()) remember(id);
      clear();
      engine.send(sessionId, [
        "[Keel diagnostics] New captured failures:",
        ...rows,
        "Triage by category and Errors ID. These are pointers, not authorization to fetch unrelated transcripts, raw debug bundles, or secrets.",
      ].join("\n"), { meta: { kind: "diagnostic" } });
    } catch {
      // Never try the send again: it may have appended the prompt before failing.
      clear();
      console.warn("Keel could not deliver a diagnostic batch. Its errors remain in Errors.");
    }
  }

  function schedule() {
    if (!pending.size || timer || !ready()) return;
    timer = setTimeout(flush, Math.max(batchMs, notBefore - Date.now()));
    timer.unref();
  }

  function own(id: string | undefined) {
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      if (id === sessionId) return true;
      seen.add(id);
      id = store.session(id)?.parent_id ?? undefined;
    }
    return false;
  }

  const offCapture = errors.onCapture(({ id, source, context, turnSession }) => {
    // Browser reports populate Errors, not a paid turn. A failure processing a
    // report may be caught by the server's route wrapper under "server".
    if (source === "client") return;
    const ctx = context as Record<string, unknown> | undefined;
    if (source === "server" && ctx?.method === "POST" && (ctx.url === "/api/errors" || ctx.url === "/api/errors/")) return;
    if (stopping || engine.isDraining() || !eligible()) return clear();
    // Passing request attempts still belong in Errors/traces, not in a wake.
    // Captures after retries are spent and other captured product faults count.
    if (source === "provider" && (ctx?.retry || ctx?.fallback || ctx?.then === "drop_block for this session" || ctx?.at === "threshold compaction")) return;
    const fromUrl = typeof ctx?.url === "string" ? /^(?:\/s\/|\/api\/sessions\/)([^/?#]+)/.exec(ctx.url)?.[1] : undefined;
    if ([turnSession, ctx?.session, ctx?.session_id, ctx?.sessionId, fromUrl].some((sid) => typeof sid === "string" && own(sid))) return;
    if (reported.has(id)) return remember(id);
    const row = pending.get(id);
    if (row) row.count++;
    else if (pending.size < MAX_ROWS) pending.set(id, { source, count: 1 });
    else overflow++;
    schedule();
  });
  const offBus = bus.on((f) => {
    if (f.t === "error" && f.error.resolved_ts !== undefined) {
      // Resolving is not itself a wake. The next occurrence opens a new incident.
      reported.delete(f.error.id);
      if (pending.delete(f.error.id) && !pending.size) clear();
    }
    if (f.t === "session" && f.session.id === sessionId) {
      if (f.deleted || !eligible()) clear();
      else schedule();
    }
    if (f.t === "queue" && f.session_id === sessionId) schedule();
    if (f.t === "feature" && f.name === "daemon" && f.data?.draining) {
      stopping = true;
      clear();
    }
  });
  return () => { offCapture(); offBus(); clear(); };
}
