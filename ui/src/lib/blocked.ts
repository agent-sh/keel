// Calls refused without the owner (the judge in full auto or reviewer mode),
// per session: the list above the composer and each refused call in the
// transcript read the same state. Fed by REST once per session, then frames.
import { useEffect, useSyncExternalStore } from "react";
import type { Blocked } from "../../../src/safety/gate.ts";
import { api, onFeature, reportError } from "./store.ts";

export type { Blocked };

let lists: Record<string, Blocked[]> = {};
const loaded = new Set<string>();
const subs = new Set<() => void>();
const put = (sid: string, b: Blocked) => {
  lists = { ...lists, [sid]: [b, ...(lists[sid] ?? []).filter((x) => x.id !== b.id)] };
  subs.forEach((f) => f());
};
onFeature({ frame: (f) => { if (f.name === "blocked" && f.session_id) put(f.session_id, f.data as Blocked); } });

const EMPTY: Blocked[] = [];
export function useBlocked(sessionId: string | undefined): Blocked[] {
  useEffect(() => {
    if (!sessionId || loaded.has(sessionId)) return;
    loaded.add(sessionId);
    api<{ blocked: Blocked[] }>(`/api/sessions/${sessionId}/blocked`).then((r) => {
      const mine = new Set((lists[sessionId] ?? []).map((b) => b.id));
      lists = { ...lists, [sessionId]: [...(lists[sessionId] ?? []), ...r.blocked.filter((b) => !mine.has(b.id))] };
      subs.forEach((f) => f());
    }).catch((e) => { loaded.delete(sessionId); reportError(e); });
  }, [sessionId]);
  return useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => (sessionId ? lists[sessionId] ?? EMPTY : EMPTY));
}

// The owner lets one retry of exactly that call through.
export const allowRetry = (sessionId: string, id: string) => api(`/api/sessions/${sessionId}/blocked/${id}`, { method: "POST" }).catch(reportError);

export const refusedBy = (b: Blocked) =>
  b.by === "reviewer" ? "The reviewer refused a call" : b.by === "unavailable" ? "Refused: the judge could not review it" : b.by === "streak" ? "Refused after repeated refusals" : "The judge refused a call";
