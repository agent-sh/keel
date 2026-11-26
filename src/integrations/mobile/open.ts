// Open on phone: the owner, at the desk, sends one session to the phone already paired with this
// daemon. It goes as one push the owner asked for, to each paired phone with a push token; its
// notification opens that session in the app. The push names the session by its id and the device
// it is for, nothing else: no pairing code, no token, no words of the session but its title. A
// phone whose registration is another device's (it paired again elsewhere) drops it, so a stale
// registration never opens another daemon's session.

import type { PushMessage } from "./push.ts";
import type { PushRecord } from "./store.ts";

export const OPEN_KIND = "open";

// The push for one session; the device it goes to is named as it is sent (push.send).
export function openPush(session: { id: string; title: string }): PushMessage {
  return {
    kind: OPEN_KIND,
    session_id: session.id,
    high: true,
    device: true,
    data: { title: session.title.trim() || "A session", body: "Sent from the computer. Tap to open it here.", pri: "high", ek: OPEN_KIND },
  };
}

// Why a session cannot be sent, before anything is: a session another machine holds lives on that
// daemon, which the phone paired here does not reach.
export function openRefusal(s: { machine?: string | null; outside?: unknown } | null | undefined): string | null {
  if (!s) return "No such session on this daemon.";
  if (s.machine) return "This session runs on another machine. Open it from that machine's own Keel.";
  if (s.outside) return "This session is another tool's history, which the phone does not show.";
  return null;
}

// What the owner is told after the push went: by name, whether each phone confirmed it.
export function openAnswer(recs: (PushRecord & { name?: string })[]): { ok: boolean; words: string } {
  if (!recs.length) return { ok: false, words: "No paired phone has a push token yet. Open the app on the phone once." };
  const sent = recs.filter((r) => r.ok);
  if (!sent.length) return { ok: false, words: `Not sent: ${recs[0]?.error ?? "the push service refused it"}.` };
  const got = sent.filter((r) => r.acked_ms);
  const names = (rs: typeof recs) => rs.map((r) => r.name || "the phone").join(", ");
  if (got.length) return { ok: true, words: `Sent to ${names(got)}. Tap the notification there.` };
  return { ok: true, words: `Sent to ${names(sent)}, not confirmed yet: the phone may be offline. It shows there when the phone is back, within 15 minutes.` };
}
