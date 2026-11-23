import type { QueueItem, Session } from "../core/types.ts";
import { D, capture } from "./core.ts";
import * as failures from "./failures.ts";

// A message one session sent another that left the receiver's queue unread:
// the receiver was deleted or archived, or the owner removed the row. The
// sender was told the message was taken, so it is told this too, as a failure
// in its scope (failures.ts): one notice, which starts a turn of the sender
// when it is idle. Told once: the failure's row is what is owed, so a restart
// neither loses nor repeats it. A sender on another daemon is not told here.
const WHY = { deleted: "its session was deleted", archived: "its session was archived", removed: "the owner removed it from that session's queue" } as const;

// Who sent a queued row, and how the receiver is named to it: a message to an
// agent from its parent or from another agent of its tree (the agent's id),
// another session's message (the receiver's session, by the end of its id).
function senderOf(q: QueueItem, receiver?: Session): { session: string; ref: { id: string; label?: string }; name: string; words: string } | undefined {
  const m = q.meta as { kind?: unknown; agent_id?: unknown; from_agent?: unknown; from?: { session_id?: unknown } } | undefined;
  if (m?.kind === "steer" && typeof m.agent_id === "string") {
    const row = D().store.db.query<{ parent_id: string; session_id: string; title: string }, [string]>("SELECT parent_id, session_id, title FROM agents WHERE id = ?");
    const a = row.get(m.agent_id);
    // Another agent of the tree sent it: that agent is told, in its own session.
    const peer = typeof m.from_agent === "string" ? row.get(m.from_agent) : undefined;
    if (typeof m.from_agent === "string") return a && peer ? { session: peer.session_id, ref: { id: m.agent_id, label: a.title }, name: "the agent", words: q.text.replace(/^Message from agent [^\n]*, another agent of your session's tree:\n/, "") } : undefined;
    return a ? { session: a.parent_id, ref: { id: m.agent_id, label: a.title }, name: "the agent", words: q.text.replace(/^Message from the session that started you:\n/, "") } : undefined;
  }
  if (m?.kind === "peer" && typeof m.from?.session_id === "string") {
    // The message's own words: the frame's last part.
    const words = q.text.split("\n\n").slice(1).join("\n\n").replace(/\n<\/external_input>\s*$/, "");
    return { session: m.from.session_id, ref: { id: q.session_id.slice(-12), label: receiver?.title }, name: "that session", words: words || q.text };
  }
  return undefined;
}

export function inputDropped(rows: QueueItem[], why: keyof typeof WHY, receiver?: Session) {
  const told = new Set<string>();
  for (const q of rows) {
    try {
      const to = senderOf(q, receiver ?? D().store.session(q.session_id));
      // A sender that is gone too (its family was deleted with it) has nobody to tell.
      if (!to || !D().store.session(to.session)) continue;
      // One line: why, then the message's own words (a notice shows a ref's failure on one line).
      if (failures.record(to.session, { kind: "message", cls: why, message: `${WHY[why]} before ${to.name} read it. The message: ${to.words.replace(/\s+/g, " ").trim()}`, ref: to.ref, tell: "wake" })) told.add(to.session);
    } catch (e) {
      capture(e, { at: "undelivered message", session: q.session_id });
    }
  }
  for (const id of told) failures.wake(id);
}

// An archived session runs no turn: what others sent it and it has not read
// leaves its queue and is told to them. The owner's own queued prompts stay.
export function onArchived(s: Session) {
  const rows = D().store.queue(s.id).filter((q) => senderOf(q, s));
  if (rows.length) D().engine.drop(rows, "archived");
}
