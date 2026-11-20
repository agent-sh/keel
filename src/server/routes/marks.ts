// Session marks: pinned, tags, done, the step budget, and whether other
// sessions may message this one and how many turns they may start before the
// owner speaks here again. Daemon state in the session's settings, so every
// client (the page, the phone, the command line) agrees; setting a mark does
// not move the session in the list.
import * as alerts from "../../automation/alerts.ts";
import type { Session } from "../../core/types.ts";
import { PEER_TURNS } from "../../fleet/messages.ts";
import { registerListFilter, registerSessionPatch, type RouteModule } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const refuse = (message: string, status = 400) => Object.assign(new Error(message), { status });

const TAG_CHARS = 200;

// Tags as stored: trimmed, without repeats, each a short line of text.
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) throw refuse("tags is a list of strings");
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string") throw refuse("tags is a list of strings");
    const x = t.trim();
    if (!x) continue;
    if (x.length > TAG_CHARS) throw refuse(`a tag is at most ${TAG_CHARS} characters`);
    if (/[\u0000-\u001f\u007f]/.test(x)) throw refuse("a tag holds no control characters");
    if (!out.some((o) => o.toLowerCase() === x.toLowerCase())) out.push(x);
  }
  return out;
}

const steps = (v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 0) throw refuse("max_steps is a whole number of 0 or more (0: no budget)");
  return v as number;
};

export const marksOf = (s: Session, unread: number) => ({
  session_id: s.id,
  pinned: !!s.settings.pinned_ms,
  accept_messages: s.settings.accept_messages !== false,
  peer_turns: s.settings.peer_turns ?? PEER_TURNS,
  unread: unread > 0,
});

export const marksRoutes: RouteModule = ({ store, bus }) => {
  const emit = (id: string) => {
    const s = store.session(id);
    if (s) bus.emit({ t: "session", session: s });
    return s;
  };
  const unreadOf = (id: string) => {
    try { return alerts.unreadCounts().sessions[id] ?? 0; } catch { return 0; }
  };

  registerSessionPatch({
    id: "marks",
    fields: ["pinned", "tags", "done", "max_steps"],
    check(_s, b) {
      if (b.pinned !== undefined && typeof b.pinned !== "boolean") throw refuse("pinned is true or false");
      if (b.done !== undefined && typeof b.done !== "boolean") throw refuse("done is true or false");
      if (b.tags !== undefined) cleanTags(b.tags);
      if (b.max_steps !== undefined) steps(b.max_steps);
    },
    apply(s, b) {
      const patch: Record<string, unknown> = {};
      if (b.pinned !== undefined) patch.pinned_ms = b.pinned ? (s.settings.pinned_ms ?? Date.now()) : null;
      if (b.tags !== undefined) patch.tags = cleanTags(b.tags).length ? cleanTags(b.tags) : null;
      if (b.done !== undefined) patch.done_ms = b.done ? Date.now() : null;
      if (b.max_steps !== undefined) patch.max_steps = steps(b.max_steps) || null;
      store.mergeSettings(s.id, patch);
    },
  });

  registerListFilter("marks", (s, q) => {
    const tag = q.get("tag");
    if (tag && !(s.settings.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
    if (q.get("pinned") === "1" && !s.settings.pinned_ms) return false;
    return true;
  });

  // Whether the last turn failed, kept on the session so every list (the
  // rail, the phone, the command line) shows it without the session's events.
  // Sessions from before the mark get it from their stored events once.
  const failedAt = (id: string) => {
    const e = store.db
      .query<{ kind: string; ts: number; reason: string | null }, [string]>(
        "SELECT kind, ts, json_extract(data, '$.reason') AS reason FROM events WHERE session_id = ? AND kind IN ('turn_start', 'turn_end', 'error') ORDER BY seq DESC LIMIT 1")
      .get(id);
    return e && (e.kind === "error" || (e.kind === "turn_end" && e.reason === "error")) ? e.ts : null;
  };
  // How the last turn ended, for lists that have no events: a stopped turn
  // and one waiting to resume after a restart are not "done".
  const lastEnd = (id: string) =>
    store.db.query<{ reason: string | null }, [string]>("SELECT json_extract(data, '$.reason') AS reason FROM events WHERE session_id = ? AND kind = 'turn_end' ORDER BY seq DESC LIMIT 1").get(id)?.reason ?? null;
  for (const s of [...store.sessions(), ...store.sessions({ archived: true })]) {
    if (!s.settings.last_end) { const r = lastEnd(s.id); if (r) store.mergeSettings(s.id, { last_end: r }); }
    if (s.settings.failed_ms) continue;
    const at = failedAt(s.id);
    if (at) store.mergeSettings(s.id, { failed_ms: at });
  }
  bus.on((f) => {
    if (f.t !== "event") return;
    const { kind, session_id: id, data, ts } = f.event;
    if (kind === "turn_start" && store.session(id)?.settings.failed_ms) store.mergeSettings(id, { failed_ms: null });
    else if (kind === "error" || (kind === "turn_end" && data.reason === "error")) store.mergeSettings(id, { failed_ms: ts, ...(kind === "turn_end" ? { last_end: "error" } : {}) });
    else if (kind === "turn_end" && data.reason) store.mergeSettings(id, { last_end: String(data.reason) });
    else return;
    emit(id);
  });

  // The owner's next prompt reopens a session they marked done.
  bus.on((f) => {
    if (f.t !== "event" || f.event.kind !== "user") return;
    const d = f.event.data;
    if (d.origin === "harness" || d.origin === "restart" || d.kind) return;
    const s = store.session(f.event.session_id);
    if (s?.settings.done_ms) { store.mergeSettings(s.id, { done_ms: null }); emit(s.id); }
  });

  return {
    "/api/sessions/:id/marks": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        return s ? json(marksOf(s, unreadOf(s.id))) : bad("no such session", 404);
      },
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        if (["pinned", "accept_messages", "peer_turns", "unread"].every((k) => b[k] === undefined)) return bad("give pinned, accept_messages, peer_turns or unread");
        for (const k of ["pinned", "accept_messages", "unread"]) if (b[k] !== undefined && typeof b[k] !== "boolean") return bad(`${k} is true or false`);
        if (b.peer_turns !== undefined && b.peer_turns !== null && !(Number.isInteger(b.peer_turns) && b.peer_turns >= 1))
          return bad("peer_turns is a whole number of 1 or more (accept_messages: false refuses every message), or null for the default");
        const patch: Record<string, unknown> = {};
        if (b.pinned !== undefined) patch.pinned_ms = b.pinned ? (s.settings.pinned_ms ?? Date.now()) : null;
        if (b.accept_messages !== undefined) patch.accept_messages = b.accept_messages ? null : false;
        if (b.peer_turns !== undefined) patch.peer_turns = b.peer_turns;
        store.mergeSettings(s.id, patch);
        if (b.unread === false) alerts.markRead({ session_id: s.id });
        if (b.unread === true && !unreadOf(s.id)) {
          const last = alerts.list({ limit: 500 }).find((a) => a.session_id === s.id);
          if (!last) return bad("the session has no alert to mark unread", 409);
          alerts.markUnread(last.id);
        }
        const next = emit(s.id)!;
        return json(marksOf(next, unreadOf(s.id)));
      },
    },
  };
};
