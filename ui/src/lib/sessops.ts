// Session marks and conversation operations, client side: pin, tags, done,
// step budget, messages from other sessions, archive with its background
// commands. The daemon keeps the marks; every client sees the same.
import type { Session } from "../../../src/core/types.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { listActed } from "./list-hold.ts";
import { pinMark, pinMove, pinnedOrder } from "./list-order.ts";
import { actions, api, getState } from "./store.ts";

export type Marks = { session_id: string; pinned: boolean; accept_messages: boolean; peer_turns: number; unread: boolean };

export const marks = {
  get: (id: string) => api<Marks>(`/api/sessions/${id}/marks`),
  set: (id: string, body: Partial<Omit<Marks, "session_id" | "peer_turns">> & { peer_turns?: number | null }) =>
    api<Marks>(`/api/sessions/${id}/marks`, { method: "POST", body: JSON.stringify(body) }),
};

export const isPinned = (s: Session | undefined) => !!s?.settings.pinned_ms;

// A pinned session leads the list on every device.
export async function pin(id: string, on: boolean) {
  listActed(id); // the owner's own act: the list shows it at once, held or not
  await actions.patch(id, { pinned: on } as any);
}

// The list's pinned sessions, in their order.
export const pinnedNow = (): Session[] => pinnedOrder(Object.values(getState().sessions).filter((s) => !s.archived && !s.parent_id && !s.settings.helper));
// A session put at a place among the pinned (a drop there): it takes a mark between its new
// neighbours' (lib/list-order.ts). The order is the pins' own marks, so it is the same on every
// device, and a session that was not pinned is pinned by it.
export async function placePin(id: string, at: number): Promise<void> {
  const rest = pinnedNow().filter((s) => s.id !== id);
  const i = Math.max(0, Math.min(rest.length, at));
  listActed(id);
  await actions.patch(id, { settings: { pinned_ms: pinMark(rest[i - 1]?.settings.pinned_ms, rest[i]?.settings.pinned_ms, Date.now()) } } as any);
}
// A pinned session moved by places among the pinned (Alt Up and Alt Down on its row). Says whether it moved.
export async function movePin(id: string, by: number): Promise<boolean> {
  const all = pinnedNow();
  const from = all.findIndex((s) => s.id === id);
  if (pinMove(all, id, from + by, Date.now()) === null) return false;
  await placePin(id, from + by);
  return true;
}

export const setTags = (id: string, tags: string[]) => actions.patch(id, { tags } as any);
export const setDone = (id: string, done: boolean) => actions.patch(id, { done } as any);
export const writeRecap = (id: string) => api<{ digest: any }>(`/api/sessions/${id}/recap`, { method: "POST" }).then((r) => r.digest);
export const setSkillMode = (id: string, skill: string | null) => api(`/api/sessions/${id}/skill-mode`, { method: "POST", body: JSON.stringify({ skill }) });
export const moveSession = (id: string, body: { cwd?: string; copy_files?: boolean; init_git?: boolean }) =>
  api<{ session: Session; files_copied: number }>(`/api/sessions/${id}/folder`, { method: "POST", body: JSON.stringify(body) });
export const cloneSession = (id: string, body: { cwd?: string; worktree?: { name?: string; base?: string } }) =>
  api<{ session: Session; events_copied: number }>(`/api/sessions/${id}/clone`, { method: "POST", body: JSON.stringify(body) });
export const setMaxSteps = (id: string, n: number) => actions.patch(id, { max_steps: n } as any);

// Archive; when the session still runs background commands, ask first and
// stop them with it.
export async function archive(s: Session, on = true) {
  listActed(s.id);
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
