import { useSyncExternalStore } from "react";
import type { Attachment } from "./images.ts";

export type SendDraft = {
  id: string;
  text: string;
  images: Attachment[];
  queue: boolean;
  state: "sending" | "refused" | "unconfirmed" | "parked";
  error?: string;
};

// This page's recovery shelf. A response can arrive after its composer
// unmounts, so key it by the full session ID (including the fleet prefix),
// not by the displayed pane. The New box has a separate key.
const empty: readonly SendDraft[] = [];
const drafts = new Map<string, readonly SendDraft[]>();
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const sendDrafts = (key: string) => drafts.get(key) ?? empty;
export const useSendDrafts = (key: string) => useSyncExternalStore(subscribe, () => sendDrafts(key));
export const hasSavedImage = (key: string, id: string) => sendDrafts(key).some((d) => d.images.some((a) => a.id === id));
export const hasSendDrafts = () => drafts.size > 0;

export function setSendDraft(key: string, id: string, draft?: SendDraft) {
  const old = sendDrafts(key);
  const next = old.some((d) => d.id === id) ? old.flatMap((d) => d.id === id ? draft ? [draft] : [] : [d]) : draft ? [...old, draft] : old;
  if (next.length) drafts.set(key, next);
  else drafts.delete(key);
  listeners.forEach((f) => f());
}

// A missing/cut response, a proxy failure or a server fault can happen after
// acceptance. Only refusals from the message route before it can append or
// queue the prompt (or the daemon's admission check) get a Retry button.
export function messageRefused(err: unknown, sid?: string) {
  const e = err as { path?: string; status?: number; body?: { error?: unknown; draining?: boolean } } | null;
  return !!sid && e?.path === `/api/sessions/${sid}/messages` && typeof e.body?.error === "string"
    && (e.status === 400 || e.status === 404 || e.status === 409 || (e.status === 503 && e.body.draining === true));
}
