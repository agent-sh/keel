// The message box's side of a session's server draft: images attached in the
// page are kept there until sent (so a reload or a session switch keeps them),
// and text or images put in from outside are taken into the box once.
import type { Draft, DraftFile } from "../../../src/server/routes/drafts.ts";
import type { Attachment } from "./images.ts";
import { api, reportError, says } from "./store.ts";

export type { Draft, DraftFile };

const base = (sid: string) => `/api/sessions/${sid}/draft`;

export const getDraft = (sid: string) => api<Draft>(base(sid));

// A file removed meanwhile (another window sent or dropped it) answers 404:
// that is no attachment, never its error text as one.
export async function fromServer(sid: string, f: DraftFile): Promise<Attachment | null> {
  const url = `${base(sid)}/files/${f.id}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`draft image: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { type: "image", media_type: f.mime as Attachment["media_type"], data: btoa(s), id: f.id, name: f.name, url, bytes: f.bytes };
}

// A drop can come from a remounted composer, before the original keep has
// finished. Let that write land first, so it cannot bring the image back.
const keeping = new Map<string, Promise<unknown>>();
// An image this page kept is the page's until a draft the daemon sends lists it. A draft made
// before the keep landed does not have it and may still reach the page after the keep was
// answered (a frame on the socket, which the answer does not wait for): it takes nothing from
// the box. A keep that failed is not waited for.
const unlisted = new Set<string>();
export const isKeeping = (id: string) => keeping.has(id) || unlisted.has(id);
export const draftListed = (ids: Iterable<string>) => { for (const id of ids) unlisted.delete(id); };
// How many keeps this page started and finished: a draft read that a keep started or finished
// under may be from before it, and is read again (keeps()).
let moved = 0;
export const keeps = () => moved;
export function keepImage(sid: string, a: Attachment) {
  moved++;
  unlisted.add(a.id);
  const write = api(base(sid), { method: "POST", body: JSON.stringify({ images: [{ id: a.id, name: a.name, mime: a.media_type, data: a.data }], origin: "page" }) })
    .catch((e) => { unlisted.delete(a.id); reportError(e, { at: "draft keep" }); }).finally(() => { moved++; keeping.delete(a.id); });
  keeping.set(a.id, write);
  return write;
}

export const dropImage = async (sid: string, id: string) => {
  unlisted.delete(id);
  await keeping.get(id);
  // keepalive: a send's or a discard's release still lands when the page reloads right after.
  await api(`${base(sid)}/files/${id}`, { method: "DELETE", keepalive: true }).catch(() => {}); // a file that was never kept is fine
};

export const clearDraft = (sid: string) => api(base(sid), { method: "DELETE" }).catch((e) => reportError(e, { at: "draft clear" }));

// Text from outside was moved into the box: empty it on the server, only if
// it is still that write (a newer one stays for the next take).
export const textTaken = (sid: string, at: number) => api(base(sid), { method: "POST", body: JSON.stringify({ text: "", taken: at, origin: "page" }) }).catch((e) => reportError(e, { at: "draft take" }));

// The owner is typing here: a capture without a session comes to this one.
const lastPing = new Map<string, number>();
export function typing(sid: string) {
  const now = Date.now();
  if (now - (lastPing.get(sid) ?? 0) < 10_000) return;
  lastPing.set(sid, now);
  says(`/api/sessions/${sid}/presence`);
}

// Whether this page's box holds an unsent message (text or images), said when
// it changes and repeated while it holds one, so momentum waits instead of
// overtaking it. Only presence goes out, never the text.
// The daemon drops a claim not repeated for three beats (a page that closed
// without saying so); each page speaks for its own box only.
const DRAFT_BEAT_MS = 30_000;
const page = crypto.randomUUID();
const said = new Map<string, boolean>();
const post = (sid: string, draft: boolean) => says(`/api/sessions/${sid}/presence`, { draft, page });
export function draftHere(sid: string, present: boolean): () => void {
  if ((said.get(sid) ?? false) !== present) post(sid, present);
  said.set(sid, present);
  if (!present) return () => {};
  const t = setInterval(() => post(sid, true), DRAFT_BEAT_MS);
  return () => clearInterval(t);
}
// The page goes away or moves to another session: its box no longer counts.
export function draftGone(sid: string) {
  if (said.get(sid)) post(sid, false);
  said.delete(sid);
}
