// Session marks: pinned, tags, done, the step budget, and whether other
// sessions may message this one and how many turns they may start before the
// owner speaks here again. Daemon state in the session's settings, so every
// client (the page, the phone, the command line) agrees; setting a mark does
// not move the session in the list.
import { isPeerMessage, ownerPrompt } from "../../core/owner.ts";
import { closingAsk, replyText } from "../../core/closing-ask.ts";
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

// The failure a session is in now: when it failed. One the page knows only from the session's
// events (no mark was made of it) has this stamp, which does not move with the session's activity.
export const NO_FAIL_MARK = -1;
export const failStamp = (s: Pick<Session, "settings">) => s.settings.failed_ms ?? NO_FAIL_MARK;
// A device says it showed the session's failure: kept only when it names the failure the session is in
// now (one that failed again meanwhile is news again).
export const failSeen = (s: Pick<Session, "settings">, stamp: unknown) => (stamp === failStamp(s) && s.settings.fail_seen_ms !== stamp ? { fail_seen_ms: stamp } : null);
// At the first start with the mark: a failure from before it counts as seen, unless its alert is
// still unread and it happened after the owner's last prompt in any session (older than that, the
// owner has been at the page since and went on with other work: it is not news).
export const failSeenBefore = (s: Pick<Session, "settings">, unreadAlert: boolean, lastPrompt = 0) =>
  (s.settings.failed_ms && s.settings.fail_seen_ms === undefined ? { fail_seen_ms: unreadAlert && s.settings.failed_ms >= lastPrompt ? 0 : s.settings.failed_ms } : null);

// When the owner last wrote a prompt, in any session: from each session's newest user events
// (`read`, newest first). Only the owner's own words count (src/core/owner.ts): an agent's task, a
// supervisor's nudge and a hook's prompt are written by the harness, minutes ago on a machine with
// agents at work, and would file every failure since the owner left as seen. An agent's session
// holds none of the owner's words. The newest sessions are looked at: no pass over every event.
export function lastOwnerPrompt(sessions: Pick<Session, "id" | "parent_id" | "updated">[], read: (id: string) => { ts: number; origin?: unknown; kind?: unknown }[]): number {
  let at = 0;
  for (const s of sessions.filter((x) => !x.parent_id).sort((a, b) => b.updated - a.updated).slice(0, 60)) {
    const own = read(s.id).find((e) => ownerPrompt({ kind: e.kind ?? undefined, origin: e.origin ?? undefined }));
    if (own && own.ts > at) at = own.ts;
  }
  return at;
}

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
    fields: ["pinned", "tags", "done", "max_steps", "fail_seen", "agents_fail_seen"],
    check(_s, b) {
      if (b.pinned !== undefined && typeof b.pinned !== "boolean") throw refuse("pinned is true or false");
      if (b.done !== undefined && typeof b.done !== "boolean") throw refuse("done is true or false");
      if (b.tags !== undefined) cleanTags(b.tags);
      if (b.max_steps !== undefined) steps(b.max_steps);
      if (b.fail_seen !== undefined && !Number.isFinite(b.fail_seen)) throw refuse("fail_seen is the time of the failure that was shown");
      if (b.agents_fail_seen !== undefined && !Number.isFinite(b.agents_fail_seen)) throw refuse("agents_fail_seen is the time of the agents' failure that was shown");
    },
    apply(s, b) {
      const patch: Record<string, unknown> = {};
      if (b.pinned !== undefined) patch.pinned_ms = b.pinned ? (s.settings.pinned_ms ?? Date.now()) : null;
      if (b.tags !== undefined) patch.tags = cleanTags(b.tags).length ? cleanTags(b.tags) : null;
      if (b.done !== undefined) patch.done_ms = b.done ? Date.now() : null;
      if (b.max_steps !== undefined) patch.max_steps = steps(b.max_steps) || null;
      if (b.fail_seen !== undefined) Object.assign(patch, failSeen(s, b.fail_seen));
      // Kept only when it names the agents' failure it is in now (one that came meanwhile is news again).
      if (b.agents_fail_seen !== undefined && b.agents_fail_seen === s.settings.agents_failed_ms) patch.agents_fail_seen_ms = b.agents_fail_seen;
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
  const unreadFailure = (id: string) => {
    try { return !!store.db.query<{ n: number }, [string]>("SELECT 1 AS n FROM alerts WHERE session_id = ? AND read = 0 AND kind IN ('failed', 'limit', 'loop_failed') LIMIT 1").get(id); } catch { return false; }
  };
  // When the owner last wrote a prompt, in any session: read once, and only when a failure needs it
  // (each session by its own index).
  let prompted: number | undefined;
  const lastPrompt = () => {
    if (prompted !== undefined) return prompted;
    const q = store.db.query<{ ts: number; origin: string | null; kind: string | null }, [string]>(
      "SELECT ts, json_extract(data, '$.origin') AS origin, json_extract(data, '$.kind') AS kind FROM events WHERE session_id = ? AND kind = 'user' ORDER BY seq DESC LIMIT 20");
    return (prompted = lastOwnerPrompt([...store.sessions(), ...store.sessions({ archived: true })], (id) => q.all(id)));
  };
  const endOf = (id: string) =>
    store.db.query<{ reason: string | null; by: string | null }, [string]>("SELECT json_extract(data, '$.reason') AS reason, json_extract(data, '$.stopped_by') AS by FROM events WHERE session_id = ? AND kind = 'turn_end' ORDER BY seq DESC LIMIT 1").get(id);
  const lastEnd = (id: string) => endOf(id)?.reason ?? null;
  // Every session is read once, at the first start with these marks (a store
  // says when that was done). After that a start reads only the sessions the
  // last daemon left working: their turn was closed at this start, before
  // this module listened. Two reads of its events a session, at every start,
  // was half a second of a start on a store of 2,600 sessions.
  store.migrate("CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const marked = !!store.db.query("SELECT 1 FROM admin_meta WHERE key = 'session_marks_read'").get();
  const boot = new Set(store.bootWorking);
  const toRead = marked ? (boot.size ? [...store.sessions(), ...store.sessions({ archived: true })].filter((s) => boot.has(s.id)) : []) : [...store.sessions(), ...store.sessions({ archived: true })];
  for (const s of toRead) {
    // Also a turn closed at this start before this module listened (a cut turn's restart end).
    // (With who stopped it, for lists that read no events: "stopped by a hook".)
    { const e = endOf(s.id), r = e?.reason ?? null; const by = r === "interrupted" ? e?.by ?? null : null; if (r && (r !== s.settings.last_end || by !== (s.settings.stopped_by ?? null))) store.mergeSettings(s.id, { last_end: r, stopped_by: by }); }
    const at = s.settings.failed_ms ?? failedAt(s.id);
    // A declined turn from before the mark counts as seen (a new one is marked unseen as it ends).
    if (!at && s.settings.fail_seen_ms === undefined && (s.settings.last_end ?? lastEnd(s.id)) === "refusal") store.mergeSettings(s.id, { fail_seen_ms: NO_FAIL_MARK });
    if (!at) continue;
    if (!s.settings.failed_ms) store.mergeSettings(s.id, { failed_ms: at });
    // Whether the owner has looked at a failure is kept with it (fail_seen_ms), so every device agrees.
    if (s.settings.fail_seen_ms !== undefined) continue;
    const unread = unreadFailure(s.id);
    const before = failSeenBefore({ settings: { ...s.settings, failed_ms: at } }, unread, unread ? lastPrompt() : 0);
    if (before) store.mergeSettings(s.id, before);
  }
  if (!marked) store.db.query("INSERT OR REPLACE INTO admin_meta (key, value) VALUES ('session_marks_read', ?)").run(String(Date.now()));
  bus.on((f) => {
    if (f.t !== "event") return;
    const { kind, session_id: id, data, ts } = f.event;
    const had = store.session(id)?.settings;
    if (kind === "turn_start" && (had?.failed_ms || had?.fail_seen_ms !== undefined)) store.mergeSettings(id, { failed_ms: null, fail_seen_ms: null });
    else if (kind === "turn_start") return;
    else if (kind === "error" || (kind === "turn_end" && data.reason === "error")) {
      // A failure is news: nobody has looked at this one. A turn's error and its end are one failure:
      // the end does not make it news again.
      const same = kind === "turn_end" && !!had?.failed_ms && ts - had.failed_ms < 5000;
      store.mergeSettings(id, { ...(same ? {} : { failed_ms: ts, fail_seen_ms: 0 }), ...(kind === "turn_end" ? { last_end: "error" } : {}) });
    }
    // A turn the model declined is a failure under its own word: news until some device shows it.
    else if (kind === "turn_end" && data.reason) store.mergeSettings(id, { last_end: String(data.reason), stopped_by: data.reason === "interrupted" && typeof data.stopped_by === "string" ? data.stopped_by : null, ...(data.reason === "refusal" ? { fail_seen_ms: 0 } : {}) });
    else return;
    emit(id);
  });

  // A question an unattended turn of a top session ended asking the owner in prose (src/core/closing-ask.ts) is
  // owed until the owner writes there: kept with the session, so its state says "needs you" across restarts. A
  // turn the owner's words started or steered asks nothing this way: he is there (on the live store, those replies
  // that ended in a question were greetings). One point read a turn's end: its last reply.
  const ownerIn = new Set<string>();
  bus.on((f) => {
    if (f.t !== "event") return;
    const { kind, session_id: id, data } = f.event;
    if (kind === "user") {
      if (!ownerPrompt(data) || isPeerMessage(f.event)) return;
      ownerIn.add(id);
      if (store.session(id)?.settings.asks_owner) { store.mergeSettings(id, { asks_owner: null }); emit(id); }
      return;
    }
    if (kind !== "turn_end") return;
    const owner = ownerIn.delete(id);
    const s = store.session(id);
    if (owner || !s || s.parent_id || data.reason !== "end_turn" || !f.event.parent) return;
    const reply = store.event(f.event.parent);
    if (reply?.kind !== "assistant") return;
    const text = closingAsk(replyText(reply.data));
    if (!text) return;
    store.mergeSettings(id, { asks_owner: { id: reply.id, seq: reply.seq, ts: reply.ts, text } });
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
