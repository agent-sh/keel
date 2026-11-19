// Session marks and conversation operations, client side: pin, tags, done,
// step budget, messages from other sessions, archive with its background
// commands. The daemon keeps the marks; every client sees the same.
import type { Session } from "../../../src/core/types.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { actions, api } from "./store.ts";
import { stations } from "./stations.ts";

export type Marks = { session_id: string; pinned: boolean; accept_messages: boolean; peer_turns: number; unread: boolean };

export const marks = {
  get: (id: string) => api<Marks>(`/api/sessions/${id}/marks`),
  set: (id: string, body: Partial<Omit<Marks, "session_id" | "peer_turns">> & { peer_turns?: number | null }) =>
    api<Marks>(`/api/sessions/${id}/marks`, { method: "POST", body: JSON.stringify(body) }),
};

export const isPinned = (s: Session | undefined) => !!s?.settings.pinned_ms;

// A pinned session keeps its station on the bridge on every device; unpinning
// lets it go back to coming and going by attention.
export async function pin(id: string, on: boolean) {
  if (on) stations.pin(id);
  else stations.unpin(id);
  await actions.patch(id, { pinned: on } as any);
}

export const setTags = (id: string, tags: string[]) => actions.patch(id, { tags } as any);
export const setDone = (id: string, done: boolean) => actions.patch(id, { done } as any);
export const setMaxSteps = (id: string, n: number) => actions.patch(id, { max_steps: n } as any);

// Archive; when the session still runs background commands, ask first and
// stop them with it.
export async function archive(s: Session, on = true) {
  try {
    return await actions.patch(s.id, { archived: on });
  } catch (e) {
    const jobs = (e as { body?: { jobs?: { command: string }[] } }).body?.jobs;
    if (!on || (e as { status?: number }).status !== 409 || !jobs?.length) throw e;
    const ok = await confirmAction({
      title: "Stop its background commands?",
      body: `"${s.title || "New session"}" still runs ${jobs.map((j) => j.command.slice(0, 60)).join(", ")}. Archiving stops ${jobs.length > 1 ? "them" : "it"}.`,
      action: "Stop and archive",
      danger: true,
    });
    if (ok) return actions.patch(s.id, { archived: true, stop_shells: true } as any);
  }
}
