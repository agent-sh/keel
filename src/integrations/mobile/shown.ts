// What this daemon's pushes put on the phones, so that a take-back goes only
// where something shows. A notification of a request is known by its `aid`
// (the app posts it under that id); everything of a session by its id.
import type { PushMessage } from "./push.ts";

export class PhoneShown {
  private sessions = new Set<string>();
  private cards = new Map<string, string>(); // aid -> session

  // A push that reached a phone.
  pushed(m: PushMessage) {
    if (!m.session_id) return;
    this.sessions.add(m.session_id);
    if (m.data.aid) this.cards.set(m.data.aid, m.session_id);
  }

  // One request was answered (or read) while its session still has something unread:
  // its notification alone comes down. The push names no session, so an app from before
  // this takes nothing down for it, rather than everything of the session.
  takeBack(aid: string | undefined): PushMessage | null {
    if (!aid || !this.cards.delete(aid)) return null;
    return { kind: "withdraw", session_id: null, high: false, data: { aid } };
  }

  // Nothing in the session is unread: everything shown for it comes down.
  clear(sessionId: string): PushMessage | null {
    for (const [aid, s] of this.cards) if (s === sessionId) this.cards.delete(aid);
    if (!this.sessions.delete(sessionId)) return null;
    return { kind: "withdraw", session_id: sessionId, high: false, data: {} };
  }
}
