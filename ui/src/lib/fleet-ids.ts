// A session of another daemon is shown here under the id "<machine>--<id>".
// Every API call for it goes through this daemon's forwarder, so the session
// view, approvals and panels work on it unchanged.
import type { Frame, Session, StoredEvent } from "../../../src/core/types.ts";

const RE = /^([A-Za-z0-9]+)--([\w-]+)$/;

export const remoteId = (machine: string, id: string) => `${machine}--${id}`;

export function splitId(id: string): { machine: string; id: string } | null {
  const m = id.match(RE);
  return m ? { machine: m[1]!, id: m[2]! } : null;
}

export const apiPath = (p: string) => p.replace(/^\/api\/sessions\/([A-Za-z0-9]+)--([\w-]+)/, "/api/fleet/machines/$1/api/sessions/$2");

// An /api path that is about a session's own machine (its repository's trust, hooks, quarantine): for a session of
// another daemon it goes to that daemon, which holds the folder; for one of this daemon it is the path itself.
export const machineApi = (sessionId: string, path: string) => {
  const r = splitId(sessionId);
  return r ? path.replace(/^\/api\//, `/api/fleet/machines/${r.machine}/api/`) : path;
};
// The session's id on the daemon that holds it.
export const ownId = (sessionId: string) => splitId(sessionId)?.id ?? sessionId;

// Its parent is a session of that daemon too: the backlink opens it there.
export const asRemote = (machine: string, s: Session): Session => ({ ...s, id: remoteId(machine, s.id), machine, ...(s.parent_id ? { parent_id: remoteId(machine, s.parent_id) } : {}) });

// What the API answered for a session, keyed as the page knows it.
export function localize(id: string, s: Session, events?: StoredEvent[]) {
  const r = splitId(id);
  if (!r) return { session: s, events };
  return { session: asRemote(r.machine, s), events: events?.map((e) => ({ ...e, session_id: id })) };
}

// A frame relayed from another daemon, with its session ids made local.
export function relayed(machine: string, f: Frame): Frame | null {
  const map = (sid?: string) => (sid ? remoteId(machine, sid) : sid);
  switch (f.t) {
    case "session": return { ...f, session: asRemote(machine, f.session) };
    case "event": return { t: "event", event: { ...f.event, session_id: map(f.event.session_id)! } };
    case "delta": return { ...f, session_id: map(f.session_id)! };
    case "queue": return { ...f, session_id: map(f.session_id)! };
    case "status": return { ...f, session_id: map(f.session_id)! };
    case "questions": return {
      ...f, machine,
      pending: f.pending.map((q) => ({ ...q, session_id: map(q.session_id)!, parent_id: map(q.parent_id) })),
    };
    case "feature": {
      // An automation update names its sessions inside the payload (a goal's or
      // a checklist's session, an agent's parent): those are the other daemon's too.
      const d = f.name === "automation" ? (f.data as { kind: string; data: any }) : null;
      const q = (v: unknown) => (typeof v === "string" ? map(v) : v);
      const inner = d?.data && typeof d.data === "object" && ("session_id" in d.data || "parent_id" in d.data)
        ? { ...d, data: { ...d.data, ...("session_id" in d.data ? { session_id: q(d.data.session_id) } : {}), ...("parent_id" in d.data ? { parent_id: q(d.data.parent_id) } : {}) } }
        : f.data;
      // A session's state names the agent session its first ask waits in: that daemon's too.
      const state = f.name === "state" && f.data && typeof f.data === "object" && typeof (f.data as { child?: unknown }).child === "string" ? { ...f.data, child: map((f.data as { child: string }).child) } : null;
      // The unread counts on an inbox frame are that daemon's inbox, not this one's: they stay there.
      const own = d && inner && typeof inner === "object" && "counts" in inner ? (({ counts: _theirs, ...rest }) => rest)(inner as Record<string, unknown>) : inner;
      return { ...f, session_id: map(f.session_id), data: state ?? own };
    }
    default: return null;
  }
}
