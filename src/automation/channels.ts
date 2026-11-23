import type { Sent } from "../engine/turn.ts";
import { Bucket, frame, keyOf, PER_MINUTE, readEvent, WAITING_MAX, type Outcome, type Pushed } from "../mcp/channel.ts";
export type { Outcome, Pushed };
import { capture, D } from "./core.ts";

// Events pushed into a running session from outside: a connected MCP
// server's (src/mcp/channel.ts has the contract) or a webhook loop's. An
// event is a message of the session's own queue, with what Engine.message
// promises any sender: stored before anything else, once under its key
// (a resend is not doubled), read by a working session at its next step,
// starting a turn in an idle one, and never starting a session the owner
// stopped (it waits behind the hold, and the sender is told). The model
// reads it framed as outside content from its source; the page shows it so.
//
// Which sessions take a server's events is the owner's choice, off by
// default: the server's switch (it may push at all) and, for the owner's
// servers, one row here per session that takes them. A session's own server
// (an editor passed it) has one switch, for its session.

export function migrate() {
  D().store.migrate("CREATE TABLE IF NOT EXISTS channel_sessions (server TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, since INTEGER NOT NULL, PRIMARY KEY (server, session_id)) WITHOUT ROWID");
}

// The sessions that take a server's events (archived ones are left out: they run no turn).
export function sessionsOf(server: string): { id: string; title: string }[] {
  const { store } = D();
  return store.db.query<{ session_id: string }, [string]>("SELECT session_id FROM channel_sessions WHERE server = ? ORDER BY since").all(server)
    .flatMap(({ session_id }) => { const s = store.session(session_id); return s && !s.archived ? [{ id: s.id, title: s.title }] : []; });
}

export function listen(server: string, session: string, on: boolean) {
  const { store } = D();
  if (on) {
    const s = store.session(session);
    if (!s) throw Object.assign(new Error("no such session"), { status: 404 });
    if (s.archived) throw Object.assign(new Error("the session is archived, so it runs no turn to read an event"), { status: 409 });
    store.db.query("INSERT OR IGNORE INTO channel_sessions (server, session_id, since) VALUES (?, ?, ?)").run(server, session, Date.now());
  } else store.db.query("DELETE FROM channel_sessions WHERE server = ? AND session_id = ?").run(server, session);
}

// A server that was removed takes nobody's events any more.
export function forget(server: string) {
  D().store.db.query("DELETE FROM channel_sessions WHERE server = ?").run(server);
}

// The owner does not take the source's events: a choice, not a failure.
export const OFF = "the owner does not take its events";

// Who pushes: `key` names the source apart from every other (its rate, its
// keys and its waiting rows are its own), `name` is what the model and the
// page call it.
export type Source = { key: string; name: string; via: "mcp" | "webhook"; ref?: string };

const buckets = new Map<string, Bucket>();
const RECENT = 20;
const recent = new Map<string, Pushed[]>();
// Events into one session go in the order they came, though bringing the
// session into memory yields.
const lines = new Map<string, Promise<unknown>>();

export const recentOf = (key: string) => recent.get(key) ?? [];

function note(src: Source, p: Pushed) {
  const list = [p, ...(recent.get(src.key) ?? [])].slice(0, RECENT);
  recent.set(src.key, list);
  D().bus.emit({ t: "feature", name: "channel", data: { source: src.key } });
  for (const o of p.outcomes) if (o.state === "refused" && o.reason !== OFF) capture(new Error(`an event from ${src.name} was not delivered: ${o.reason}`), { at: "channel", source: src.key, ...(o.session ? { session: o.session } : {}) });
}

const said = (r: Sent): Outcome["state"] => r.duplicate ? "duplicate" : r.held ? "held" : r.event ? "started" : r.steer && D().engine.isRunning(r.queued!.session_id) ? "next_step" : "waiting";

// One event into the sessions that take it (none: the owner takes none of its
// events). Resolves when each was stored or refused.
export async function push(src: Source, targets: string[] | null, params: unknown): Promise<Pushed> {
  const at = Date.now();
  const ev = readEvent(params);
  // A refused event is named by its id too, so its sender knows which one it was.
  const refuse = (reason: string, chars = 0): Pushed => {
    const id = "error" in ev ? undefined : ev.event_id;
    const p = { at, chars, ...(id ? { event_id: id } : {}), outcomes: [{ state: "refused" as const, reason }] };
    note(src, p);
    return p;
  };
  if ("error" in ev) return refuse(ev.error);
  const chars = ev.content.length;
  if (!targets) return refuse(OFF, chars);
  if (!targets.length) return refuse("no session takes its events", chars);
  const bucket = buckets.get(src.key) ?? buckets.set(src.key, new Bucket()).get(src.key)!;
  if (!bucket.take(at)) return refuse(`it sent more than ${PER_MINUTE} events in a minute`, chars);
  const { store, engine } = D();
  const text = frame(src.name, ev);
  const meta = {
    kind: "channel", source: src.name, source_key: src.key, via: src.via, ...(src.ref ? { ref: src.ref } : {}),
    ...(Object.keys(ev.attrs).length ? { attrs: ev.attrs } : {}), ...(ev.event_id ? { event_id: ev.event_id } : {}), ...(ev.cut ? { cut: ev.cut } : {}),
  };
  const k = keyOf(src.key, ev);
  const one = async (sid: string): Promise<Outcome> => {
    const s = store.session(sid);
    if (!s) return { session: sid, state: "refused", reason: "the session is gone" };
    if (s.archived) return { session: sid, state: "refused", reason: "the session is archived" };
    await store.warm(sid, false).catch(() => {});
    try {
      // The same event again is a duplicate before it is anything else.
      if (k && engine.hasInput(sid, k.key)) return { session: sid, state: "duplicate" };
      const waiting = store.queue(sid).filter((q) => q.meta?.kind === "channel" && q.meta?.source_key === src.key).length;
      if (waiting >= WAITING_MAX) return { session: sid, state: "refused", reason: `${WAITING_MAX} of its events already wait in the session` };
      return { session: sid, state: said(engine.message(sid, text, meta, k ?? {})) };
    } catch (e) {
      return { session: sid, state: "refused", reason: (e as Error).message };
    }
  };
  const outcomes = await Promise.all([...new Set(targets)].map((sid) => {
    const run = (lines.get(sid) ?? Promise.resolve()).then(() => one(sid));
    const done = run.catch(() => {});
    lines.set(sid, done);
    void done.then(() => { if (lines.get(sid) === done) lines.delete(sid); });
    return run.catch((e): Outcome => ({ session: sid, state: "refused", reason: (e as Error).message }));
  }));
  const p: Pushed = { at, chars, outcomes, ...(ev.event_id ? { event_id: ev.event_id } : {}) };
  note(src, p);
  return p;
}
