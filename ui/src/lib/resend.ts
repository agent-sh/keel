// Messages kept for a daemon that was away go out by themselves when it is
// back. Each goes under the id it was first sent with, and the daemon stores a
// named send once, so a message whose answer was lost is confirmed, not sent
// twice. This runs for the whole page: the session's message box may be gone.
import { dropImage } from "./drafts.ts";
import { toBlock } from "./images.ts";
import { daemonAway, messageRefused, setSendDraft, sendDrafts, unread, waitingSends, type SendDraft } from "./send-drafts.ts";
import { actions, failed, getState, onFeature } from "./store.ts";

// Requests of one message that got no answer while the socket stayed up. A
// daemon that is there and still never answers this message (a request it
// cannot take) is not asked for ever: after a few the owner decides.
const unanswered = new Map<string, number>();
const UNANSWERED_MAX = 5;

// One send of a kept message of a session of this daemon. What became of it is on its shelf.
export async function sendNamed(sid: string, entry: SendDraft) {
  setSendDraft(sid, entry.id, { ...entry, state: "sending", error: undefined });
  try {
    await actions.send(sid, entry.text.trim(), { images: entry.images.map(toBlock), mode: entry.queue ? "queue" : undefined, client_id: entry.id });
  } catch (e) {
    const n = e instanceof TypeError && getState().connected ? (unanswered.get(entry.id) ?? 0) + 1 : 0;
    if (n) unanswered.set(entry.id, n);
    if (n >= UNANSWERED_MAX) {
      unanswered.delete(entry.id);
      return setSendDraft(sid, entry.id, { ...entry, state: "unconfirmed", error: "The daemon's answer did not arrive." });
    }
    if (daemonAway(e)) return setSendDraft(sid, entry.id, { ...entry, state: "waiting", error: undefined });
    unanswered.delete(entry.id);
    const words = failed(e, { at: "send", session_id: sid });
    return setSendDraft(sid, entry.id, { ...entry, state: messageRefused(e, sid) ? "refused" : "unconfirmed", error: words });
  }
  unanswered.delete(entry.id);
  setSendDraft(sid, entry.id, { ...entry, state: "done" });
  await Promise.all(entry.images.map((a) => (a.file ? undefined : dropImage(sid, a.id))));
  setSendDraft(sid, entry.id);
}

const AGAIN_MS = 2_000;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// While connected, what waits is sent, oldest first; a daemon that still takes
// no work (it is draining) is asked again shortly.
async function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (busy || !getState().connected) return;
  busy = true;
  try {
    for (const { key, d } of waitingSends()) {
      if (!getState().connected) break;
      // Still on its shelf, and its pictures are read (a reload leaves references until the box reads them).
      const now = sendDrafts(key).find((x) => x.id === d.id);
      if (now?.state !== "waiting" || now.images.some(unread)) continue;
      await sendNamed(key, now);
    }
  } finally {
    busy = false;
  }
  if (waitingSends().length && getState().connected) timer = setTimeout(() => void flush(), AGAIN_MS);
}

// A message that starts waiting while the socket is up (the daemon is draining, or the answer was cut) is tried again soon.
export function sendWaitingSoon() {
  if (!timer && getState().connected) timer = setTimeout(() => void flush(), AGAIN_MS);
}

// Every socket open, the page's first included (a reload with a send still out).
onFeature({ reconnect: () => void flush() });
