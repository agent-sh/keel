// Session marks and conversation operations, client side: pin, tags, done,
// step budget, messages from other sessions, archive with its background
// commands. The daemon keeps the marks; every client sees the same.
import type { Session } from "../../../src/core/types.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { listActed } from "./list-hold.ts";
import { actions, api } from "./store.ts";

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
