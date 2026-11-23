import type { Sent } from "../engine/turn.ts";
import { Bucket, frame, keyOf, PER_MINUTE, readEvent, WAITING_MAX, type Outcome, type Pushed } from "../mcp/channel.ts";
export type { Outcome, Pushed };
import { capture, D } from "./core.ts";
import { stopper } from "../core/stoppers.ts";

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

// Each row names the server by its name and by what it is (`ident`: a hash of
// its endpoint, src/mcp/sources.ts). A server removed by any path (its file
// edited, its plugin gone) drops its rows when the manager says so (forget);
// one removed while the daemon was down, and another under its name since, is
// a server of another endpoint: its rows are not that server's, and go.
export function migrate() {
  const { store } = D();
  store.migrate("CREATE TABLE IF NOT EXISTS channel_sessions (server TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, since INTEGER NOT NULL, PRIMARY KEY (server, session_id)) WITHOUT ROWID");
  if (!store.columnExists("channel_sessions", "ident")) store.migrate("ALTER TABLE channel_sessions ADD COLUMN ident TEXT");
}

// The sessions that take a server's events (archived ones are left out: they run no turn).
export function sessionsOf(server: string, ident: string): { id: string; title: string }[] {
  const { store } = D();
  if (store.db.query("DELETE FROM channel_sessions WHERE server = ? AND ident IS NOT ?").run(server, ident).changes) D().bus.emit({ t: "feature", name: "channel", data: { source: `mcp:${server}` } });
  return store.db.query<{ session_id: string }, [string]>("SELECT session_id FROM channel_sessions WHERE server = ? ORDER BY since").all(server)
    .flatMap(({ session_id }) => { const s = store.session(session_id); return s && !s.archived ? [{ id: s.id, title: s.title }] : []; });
}

export function listen(server: string, ident: string, session: string, on: boolean) {
  const { store } = D();
  if (on) {
    const s = store.session(session);
    if (!s) throw Object.assign(new Error("no such session"), { status: 404 });
    if (s.archived) throw Object.assign(new Error("the session is archived, so it runs no turn to read an event"), { status: 409 });
    store.db.query("INSERT INTO channel_sessions (server, session_id, since, ident) VALUES (?, ?, ?, ?) ON CONFLICT (server, session_id) DO UPDATE SET ident = excluded.ident").run(server, session, Date.now(), ident);
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
// An event that waits behind a hold says whose stop made it: the owner's, or
// another's (an agent its parent stopped), in the words of src/core/stoppers.ts.
function outcomeOf(sid: string, r: Sent): Outcome {
  const state = said(r);
  if (state !== "held") return { session: sid, state };
  const by = D().engine.heldBy(sid);
  return { session: sid, state, ...(by ? { by } : {}), ...(stopper(by).held ? { reason: stopper(by).held } : {}) };
}
const REUSED = "its event id was used for another event; send this one under a new id";

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
  const { store, engine } = D();
  const k = keyOf(src.key, ev);
  // An event stored before under its id: the same words are a duplicate, other
  // words under that id are the sender's mistake and refused (as Engine.claim
  // refuses them). Asked first, so a resend is answered as what it is whatever
  // the rate: it costs the session nothing.
  const before = (sid: string): Outcome | undefined => {
    const had = k ? engine.inputUnder(sid, k.key) : undefined;
    if (!had) return undefined;
    return had.fp && had.fp !== k!.fp ? { session: sid, state: "refused", reason: REUSED } : { session: sid, state: "duplicate" };
  };
  const all = [...new Set(targets)];
  const known = new Map(all.flatMap((sid) => { const o = before(sid); return o ? [[sid, o] as const] : []; }));
  const fresh = all.filter((sid) => !known.has(sid));
  const bucket = buckets.get(src.key) ?? buckets.set(src.key, new Bucket()).get(src.key)!;
  const over = fresh.length > 0 && !bucket.take(at);
  const rate = `it sent more than ${PER_MINUTE} events in a minute`;
  const text = frame(src.name, ev);
  const meta = {
    kind: "channel", source: src.name, source_key: src.key, via: src.via, ...(src.ref ? { ref: src.ref } : {}),
    ...(Object.keys(ev.attrs).length ? { attrs: ev.attrs } : {}), ...(ev.event_id ? { event_id: ev.event_id } : {}), ...(ev.cut ? { cut: ev.cut } : {}),
  };
  const one = async (sid: string): Promise<Outcome> => {
    const was = known.get(sid);
    if (was) return was;
    if (over) return { session: sid, state: "refused", reason: rate };
    const s = store.session(sid);
    if (!s) return { session: sid, state: "refused", reason: "the session is gone" };
    if (s.archived) return { session: sid, state: "refused", reason: "the session is archived" };
    await store.warm(sid, false).catch(() => {});
    try {
      // The same event again (sent while this one waited for the session) is a duplicate before it is anything else.
      const again = before(sid);
      if (again) return again;
      const waiting = store.queue(sid).filter((q) => q.meta?.kind === "channel" && q.meta?.source_key === src.key).length;
      if (waiting >= WAITING_MAX) return { session: sid, state: "refused", reason: `${WAITING_MAX} of its events already wait in the session` };
      return outcomeOf(sid, engine.message(sid, text, meta, k ?? {}));
    } catch (e) {
      return { session: sid, state: "refused", reason: (e as { status?: number }).status === 409 ? REUSED : (e as Error).message };
    }
  };
  const outcomes = await Promise.all(all.map((sid) => {
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
