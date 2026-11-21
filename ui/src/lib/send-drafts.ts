import { useSyncExternalStore } from "react";
import { splitId } from "./fleet-ids.ts";
import type { Attachment } from "./images.ts";

export type SendDraft = {
  id: string;
  text: string;
  images: Attachment[];
  queue: boolean;
  // sending: the request is out. done: sent or discarded, its images are being
  // released. Neither is shown; the rest are the items the owner acts on.
  // waiting: the daemon was away or restarting; the message goes out by itself
  // when it is back, under the same id, so the daemon takes it once (resend.ts).
  state: "sending" | "waiting" | "refused" | "unconfirmed" | "parked" | "done";
  error?: string;
  // Attachments a reload could not bring back, by name.
  lost?: string[];
};

// This browser's recovery shelf: sends the daemon refused or did not confirm,
// and drafts set aside for a restored one. A response can arrive after its
// composer unmounts, so it is keyed by the full session ID (including the
// fleet prefix), not by the displayed pane; the New box has a key of its own.
// It is kept in localStorage (the words and a reference per attachment; a
// session's images stay in its server draft), so a reload or a second tab
// shows each item with its own images instead of finding them in the box.
const NEW = "new";
const STORE = "keel.sends.";
export const shelfKey = (sid?: string) => sid ?? NEW;

const empty: readonly SendDraft[] = [];
const drafts = new Map<string, readonly SendDraft[]>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
// Requests this page is waiting on. Another tab's word on them is not taken.
const own = new Set<string>();

export const sendDrafts = (key: string) => drafts.get(key) ?? empty;
export const useSendDrafts = (key: string) => useSyncExternalStore(subscribe, () => sendDrafts(key));
export const shown = (d: SendDraft) => d.state === "waiting" || d.state === "refused" || d.state === "unconfirmed" || d.state === "parked";
// A session of this daemon: its message route takes each named send once, so
// sending one again under its id is safe. The New box and a session of another
// machine (a daemon that may predate the ids) keep the owner's own check.
export const namedSends = (key: string) => key !== NEW && !splitId(key);
// Every send waiting for the daemon, with its shelf.
export const waitingSends = () => [...drafts].flatMap(([key, list]) => list.filter((d) => d.state === "waiting").map((d) => ({ key, d })));
export const hasSavedImage = (key: string, id: string) => sendDrafts(key).some((d) => d.images.some((a) => a.id === id));
// Images the shelf holds in the session's server draft, which takes 20 in all.
export const savedImages = (key: string) => sendDrafts(key).reduce((n, d) => n + d.images.filter((a) => !a.file).length, 0);
// An image a reload left in the session's server draft: its composer reads it.
export const unread = (a: Attachment) => !a.file && !a.data;
// What a reload would cut or lose: a request still out, and the New box's
// pictures (it has no server draft, so they are in this page only).
export const sendsBusy = () => own.size > 0 || sendDrafts(NEW).some((d) => d.images.some((a) => !a.file));

// What a session's row says: a send that did not go, or one nobody confirmed.
export const unsentOf = (sid: string): "refused" | "unconfirmed" | null => {
  const list = sendDrafts(sid);
  return list.some((d) => d.state === "refused") ? "refused" : list.some((d) => d.state === "unconfirmed") ? "unconfirmed" : null;
};
export const useUnsent = (sid: string | undefined) => useSyncExternalStore(subscribe, () => (sid ? unsentOf(sid) : null));
// A message of the session waits for the daemon: nothing for the owner to do, but the list says it is not there yet.
export const useWaitingSend = (sid: string) => useSyncExternalStore(subscribe, () => sendDrafts(sid).some((d) => d.state === "waiting"));
export const useShelfVersion = () => useSyncExternalStore(subscribe, () => version);

function put(key: string, next: readonly SendDraft[]) {
  if (next.length) drafts.set(key, next);
  else drafts.delete(key);
  version++;
  listeners.forEach((f) => f());
}

type Ref = Pick<Attachment, "id" | "name" | "media_type" | "bytes" | "file">;
type Stored = Omit<SendDraft, "images"> & { images: Ref[] };

function save(key: string) {
  const list = sendDrafts(key).filter((d) => d.state !== "done");
  try {
    if (!list.length) return localStorage.removeItem(STORE + key);
    const stored: Stored[] = list.map(({ images, ...d }) => ({ ...d, images: images.map(({ id, name, media_type, bytes, file }) => ({ id, name, media_type, bytes, file })) }));
    localStorage.setItem(STORE + key, JSON.stringify(stored));
  } catch (e) {
    // A full store: the shelf stays in this page, and the page's handler tracks the failure.
    void Promise.reject(e);
  }
}

// `boot`: this page has just loaded, so a request marked as out has nobody
// waiting for its answer any more.
function read(key: string, raw: string | null, boot: boolean): SendDraft[] {
  try {
    return parse(key, raw, boot);
  } catch {
    // Stored data this page cannot read must not stop it from loading.
    try { localStorage.removeItem(STORE + key); } catch { /* storage is unavailable */ }
    return [];
  }
}

function parse(key: string, raw: string | null, boot: boolean): SendDraft[] {
  let list: Stored[];
  try { list = JSON.parse(raw ?? "[]"); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const have = sendDrafts(key);
  return list.filter((s) => s && typeof s.id === "string" && Array.isArray(s.images)).map((s): SendDraft => {
    const cut = boot && s.state === "sending";
    // A named send the reload cut goes out again under its id: taken once, whether or not it arrived.
    const base = { ...s, text: String(s.text ?? ""), ...(!cut ? {} : namedSends(key) ? { state: "waiting" as const, error: undefined } : { state: "unconfirmed" as const, error: "The page was reloaded before the daemon answered." }) };
    // Attachments never change after the item is made: the copy already here is the full one.
    const mine = have.find((d) => d.id === s.id);
    if (mine) return { ...base, images: mine.images, lost: mine.lost };
    const images: Attachment[] = [];
    const lost = Array.isArray(s.lost) ? s.lost.map(String) : [];
    for (const r of s.images) {
      if (!r || typeof r.id !== "string") continue;
      const a = { type: "image" as const, media_type: r.media_type, data: "", id: r.id, name: r.name, bytes: r.bytes };
      if (r.file) images.push({ ...a, url: `/api/attachments/${r.file.id}`, file: r.file });
      else if (key === NEW) lost.push(r.name);
      else images.push({ ...a, url: "" });
    }
    return { ...base, images, lost: lost.length ? lost : undefined };
  });
}

for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (!k?.startsWith(STORE)) continue;
  const key = k.slice(STORE.length);
  const list = read(key, localStorage.getItem(k), true);
  if (list.length) drafts.set(key, list);
}
// Another tab changed a shelf: take its list, beside what this page is sending.
window.addEventListener("storage", (e) => {
  if (e.storageArea !== localStorage || !e.key?.startsWith(STORE)) return;
  const key = e.key.slice(STORE.length);
  put(key, [...read(key, e.newValue, false).filter((d) => !own.has(d.id)), ...sendDrafts(key).filter((d) => own.has(d.id))]);
});

export function setSendDraft(key: string, id: string, draft?: SendDraft) {
  // A session deleted while its send was out: there is nowhere to send it again, so nothing is kept for it.
  if (dropped.has(key)) draft = undefined;
  if (draft && (draft.state === "sending" || draft.state === "done")) own.add(id);
  else own.delete(id);
  const old = sendDrafts(key);
  put(key, old.some((d) => d.id === id) ? old.flatMap((d) => d.id === id ? draft ? [draft] : [] : [d]) : draft ? [...old, draft] : old);
  save(key);
}

// An image read back from the session's draft after a reload, or `null` when
// the draft no longer has it: the item then names it as lost.
export function setSendImage(key: string, id: string, image: string, got: Attachment | null) {
  const d = sendDrafts(key).find((x) => x.id === id);
  const at = d?.images.find((a) => a.id === image);
  if (!d || !at) return;
  const next = got ? { ...d, images: d.images.map((a) => (a === at ? got : a)) } : { ...d, images: d.images.filter((a) => a !== at), lost: [...(d.lost ?? []), at.name] };
  put(key, sendDrafts(key).map((x) => (x === d ? next : x)));
  save(key);
}

// A deleted session takes its shelf with it.
const dropped = new Set<string>();
export function dropSendDrafts(key: string) {
  dropped.add(key);
  for (const d of sendDrafts(key)) own.delete(d.id);
  if (drafts.has(key)) put(key, empty);
  try { localStorage.removeItem(STORE + key); } catch { /* nothing was stored */ }
}

// A session deleted while no page was open left its kept sends and the words
// typed into its box in this browser's storage for good. Once the session
// list is in, each stored key of a session of this daemon that the list does
// not have is asked about (`exists`: an archived session or an agent's is not
// in the list and keeps its own), and what belongs to no session is removed.
const TYPED = "keel.draft.";
export async function dropOrphans(listed: (id: string) => boolean, exists: (id: string) => Promise<boolean>) {
  const ids = new Set<string>();
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    const id = k.startsWith(STORE) ? k.slice(STORE.length) : k.startsWith(TYPED) ? k.slice(TYPED.length) : NEW;
    if (id !== NEW && !splitId(id) && !listed(id)) ids.add(id);
  }
  for (const id of ids) {
    if (listed(id) || (await exists(id))) continue;
    dropSendDrafts(id);
    try { localStorage.removeItem(TYPED + id); } catch { /* storage is unavailable */ }
  }
}

// Where a new session's first message goes: the plain create, one in a fresh
// worktree, one on a machine of the fleet.
const CREATES = ["/api/sessions", "/api/worktrees", "/api/fleet/sessions"];

// A missing or cut response, a proxy failure or a server fault can happen
// after acceptance. Only the daemon's own refusal is a certain non-send: from
// the message route before it can append or queue the prompt, from a create
// route (each answers 4xx only before a session exists, or after deleting the
// one it made), from the admission check in front of both, or a passkey check
// that was needed and not given (the request is not repeated).
// The daemon was not there to take it: the request never got an answer (the
// daemon is down, or its answer was cut), or the daemon said it takes no new
// work while it restarts.
export function daemonAway(err: unknown) {
  const e = err as { status?: number; body?: { draining?: boolean } } | null;
  return err instanceof TypeError || (e?.status === 503 && e.body?.draining === true);
}

export function messageRefused(err: unknown, sid?: string) {
  const e = err as { path?: string; status?: number; body?: { error?: unknown; draining?: boolean } } | null;
  if (e?.status === 428) return true;
  if (typeof e?.body?.error !== "string") return false;
  if (sid ? e.path !== `/api/sessions/${sid}/messages` : !CREATES.includes(e.path ?? "")) return false;
  return e.status === 400 || e.status === 403 || e.status === 404 || e.status === 409 || (e.status === 503 && e.body.draining === true);
}
