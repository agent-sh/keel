// The message box's side of a session's server draft: images attached in the
// page are kept there until sent (so a reload or a session switch keeps them),
// and text or images put in from outside are taken into the box once.
import type { Draft, DraftFile } from "../../../src/server/routes/drafts.ts";
import type { Attachment } from "./images.ts";
import { api, reportError } from "./store.ts";

export type { Draft, DraftFile };

const base = (sid: string) => `/api/sessions/${sid}/draft`;

export const getDraft = (sid: string) => api<Draft>(base(sid));

export async function fromServer(sid: string, f: DraftFile): Promise<Attachment> {
  const url = `${base(sid)}/files/${f.id}`;
  const buf = await (await fetch(url)).arrayBuffer();
  let s = "";
  const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return { type: "image", media_type: f.mime as Attachment["media_type"], data: btoa(s), id: f.id, name: f.name, url, bytes: f.bytes };
}

export const keepImage = (sid: string, a: Attachment) =>
  api(base(sid), { method: "POST", body: JSON.stringify({ images: [{ id: a.id, name: a.name, mime: a.media_type, data: a.data }], origin: "page" }) }).catch((e) => reportError(e, { at: "draft keep" }));

export const dropImage = (sid: string, id: string) =>
  api(`${base(sid)}/files/${id}`, { method: "DELETE" }).catch(() => {}); // a file that was never kept is fine

export const clearDraft = (sid: string) => api(base(sid), { method: "DELETE" }).catch((e) => reportError(e, { at: "draft clear" }));

// Text from outside was moved into the box: empty it on the server.
export const textTaken = (sid: string) => api(base(sid), { method: "POST", body: JSON.stringify({ text: "", origin: "page" }) }).catch((e) => reportError(e, { at: "draft take" }));

// The owner is typing here: a capture without a session comes to this one.
const lastPing = new Map<string, number>();
export function typing(sid: string) {
  const now = Date.now();
  if (now - (lastPing.get(sid) ?? 0) < 10_000) return;
  lastPing.set(sid, now);
  fetch(`/api/sessions/${sid}/presence`, { method: "POST" }).catch(() => {});
}
