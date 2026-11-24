// The rule for a session another harness runs on this machine (Claude Code,
// Codex: `Session.outside`, src/integrations/outside/service.ts): Keel only
// shows it. Nothing of its text (title, prompts, replies, transcript, its
// state line) leaves this daemon: no hook of the owner's, no memory store, no
// paired machine, no phone gets it. Continuing it in Keel makes a copy of its
// own, with no `outside` mark, and that copy is shared as any session is.
import type { Session } from "./types.ts";

export const isOutside = (s: Pick<Session, "outside"> | null | undefined): boolean => !!s?.outside;

// The session a bus frame is about, by id (none for a frame of no one session).
export function frameSession(f: { t: string; [k: string]: any }): string | undefined {
  if (f.t === "session") return f.session?.id;
  if (f.t === "event") return f.event?.session_id;
  if (typeof f.session_id === "string") return f.session_id;
  // The automation's frames carry what they are about inside (an alert, a wake: src/automation/core.ts emit).
  if (f.t === "feature" && typeof f.data?.data?.session_id === "string") return f.data.data.session_id;
  return undefined;
}

// The ids of every such session now (a column of the sessions table, set when one is made).
export const outsideIds = (db: { query: (sql: string) => { all: () => unknown[] } }): Set<string> =>
  new Set((db.query("SELECT id FROM sessions WHERE outside IS NOT NULL").all() as { id: string }[]).map((r) => r.id));

// The same sessions by the id the agent view gives them on this machine (src/drive/agentview.ts rowId:
// <harness>:<its own id>), so the sessions elsewhere routes leave them out for a caller blind to them too.
export const outsideSources = (db: { query: (sql: string) => { all: () => unknown[] } }): Set<string> =>
  new Set((db.query("SELECT json_extract(outside, '$.harness') || ':' || json_extract(outside, '$.source_id') AS k FROM sessions WHERE outside IS NOT NULL").all() as { k: string | null }[]).flatMap((r) => (r.k ? [r.k] : [])));

// What another machine's relay of this daemon is shown: every session and frame but those of a session
// another harness runs. The ids are read once, when the relay opens; one made after is known by its
// first frame (the session frame that makes it comes before any other of it).
export function forPeers(db: Parameters<typeof outsideIds>[0]) {
  const away = outsideIds(db);
  return {
    sessions: <S extends { id: string }>(all: S[]) => all.filter((s) => !away.has(s.id)),
    states: <V>(all: Record<string, V>) => Object.fromEntries(Object.entries(all).filter(([id]) => !away.has(id))),
    pass(f: { t: string; [k: string]: any }): boolean {
      if (f.t === "session" && isOutside(f.session)) away.add(f.session.id);
      const about = frameSession(f);
      return !about || !away.has(about);
    },
  };
}
