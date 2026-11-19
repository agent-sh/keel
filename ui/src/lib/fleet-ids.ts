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
    case "feature": {
      // An automation update names its sessions inside the payload (a goal's or
      // a checklist's session, an agent's parent): those are the other daemon's too.
      const d = f.name === "automation" ? (f.data as { kind: string; data: any }) : null;
      const q = (v: unknown) => (typeof v === "string" ? map(v) : v);
      const inner = d?.data && typeof d.data === "object" && ("session_id" in d.data || "parent_id" in d.data)
        ? { ...d, data: { ...d.data, ...("session_id" in d.data ? { session_id: q(d.data.session_id) } : {}), ...("parent_id" in d.data ? { parent_id: q(d.data.parent_id) } : {}) } }
        : f.data;
      return { ...f, session_id: map(f.session_id), data: inner };
    }
    default: return null;
  }
}
