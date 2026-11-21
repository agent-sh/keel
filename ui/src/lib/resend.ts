// Messages kept for a daemon that was away go out by themselves when it is
// back. Each goes under the id it was first sent with, and the daemon stores a
// named send once, so a message whose answer was lost is confirmed, not sent
// twice. This runs for the whole page: the session's message box may be gone.
import { dropImage, fromServer } from "./drafts.ts";
import { toBlock } from "./images.ts";
import { daemonAway, messageRefused, onCutSend, onShelf, setSendDraft, setSendImage, sendDrafts, unconfirmedSends, unread, waitingSends, type SendDraft } from "./send-drafts.ts";
import { actions, api, failed, getState, onFeature, subscribe } from "./store.ts";
import type { StoredEvent } from "../../../src/core/types.ts";

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
const AGAIN_MAX_MS = 30_000;
let again = AGAIN_MS;
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// A reload leaves a kept message's pictures as references to the session's
// server draft. They are read here, so the message goes out whether or not
// its session's box is ever opened. False when one could not be read yet.
async function readImages(sid: string, d: SendDraft): Promise<boolean> {
  for (const a of d.images.filter(unread)) {
    try {
      setSendImage(sid, d.id, a.id, await fromServer(sid, { id: a.id, name: a.name, mime: a.media_type, bytes: a.bytes, origin: null, added_ms: 0 }));
    } catch {
      return false; // asked again at the next look
    }
  }
  return true;
}

// While connected, what waits is sent, oldest first. The daemon is asked
// first whether it takes work (one small read): a message, with its pictures,
// is not posted at a daemon that would refuse it. While it does not, it is
// asked again later each time; its restart (the socket opens again) or the
// end of its drain sends at once.
async function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (busy || !getState().connected || !waitingSends().length) return;
  busy = true;
  let takes = false;
  try {
    takes = !(await api<{ draining: unknown }>("/api/bootstrap")).draining;
    for (const { key, d } of takes ? waitingSends() : []) {
      if (!getState().connected) break;
      // Still on its shelf, with its pictures read.
      if (sendDrafts(key).find((x) => x.id === d.id)?.state !== "waiting" || !(await readImages(key, d))) continue;
      const now = sendDrafts(key).find((x) => x.id === d.id);
      if (now?.state === "waiting") await sendNamed(key, now);
    }
  } catch {
    // The daemon did not answer the small read: the next look, or the reconnect, tries again.
  } finally {
    busy = false;
  }
  again = takes ? AGAIN_MS : Math.min(again * 2, AGAIN_MAX_MS);
  if (waitingSends().length && getState().connected) timer = setTimeout(() => void flush(), again);
}

// A message that starts waiting while the socket is up (the daemon is draining, or the answer was cut) is tried again soon.
export function sendWaitingSoon() {
  if (!timer && getState().connected) timer = setTimeout(() => void flush(), (again = AGAIN_MS));
}

// A send whose page went away (another tab closed, or this page was reloaded) waits now: it goes out from here.
onCutSend.waiting = sendWaitingSoon;

onFeature({
  // Every socket open, the page's first included (a reload with a send still out).
  reconnect: () => { again = AGAIN_MS; void flush(); },
  // A drain that was called off: the daemon takes work again.
  frame: (f) => { if (f.name === "daemon" && !f.data?.draining) void flush(); },
});

// A send whose answer was lost says "delivery unconfirmed" until the owner
// checks. When the transcript shows the message there is nothing left to
// check: the item goes, with its mark on the row, and its images leave the
// session's draft as after any send. The message is the owner's prompt with
// the same words and as many images that came after the first try (an
// earlier one with the same words is not it).
const isIt = (e: StoredEvent, d: SendDraft) =>
  e.kind === "user" && !e.data.kind && (!e.data.origin || e.data.origin === "queued" || e.data.origin === "steer")
  && String(e.data.text ?? "").trim() === d.text.trim() && (e.data.images?.length ?? 0) === d.images.length;
async function arrived(key: string, d: SendDraft) {
  setSendDraft(key, d.id, { ...d, state: "done" });
  await Promise.all(d.images.map((a) => (a.file ? undefined : dropImage(key, a.id))));
  setSendDraft(key, d.id);
}
let unconfirmed = unconfirmedSends();
const looked = new Map<string, StoredEvent[]>(); // the transcript each item was last held against
function look() {
  for (const { key, d } of unconfirmed) {
    const events = getState().events[key];
    if (!events || d.after === undefined || looked.get(d.id) === events) continue;
    looked.set(d.id, events);
    for (let i = events.length - 1; i >= 0 && events[i]!.seq > d.after; i--) {
      if (isIt(events[i]!, d)) { void arrived(key, d); break; }
    }
  }
}
onShelf(() => {
  unconfirmed = unconfirmedSends();
  for (const id of looked.keys()) if (!unconfirmed.some((u) => u.d.id === id)) looked.delete(id);
  look();
});
// The store says every change of the page; with nothing unconfirmed this is one length check.
subscribe(() => { if (unconfirmed.length) look(); });
