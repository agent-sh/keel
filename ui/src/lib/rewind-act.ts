// The acts of the rewind that read the page's state or call the daemon (the choices are in rewind.ts).
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { api, getState, reportError } from "./store.ts";
import { seedComposer } from "./ui.ts";

// One Undo for the chat and the files of a rewind. The page follows the head the daemon moved.
export async function undoRewind(sessionId: string, noteId: string, stopShells = false): Promise<void> {
  const r = await api<{ prompt_text?: string }>(`/api/sessions/${sessionId}/rewind`, { method: "POST", body: JSON.stringify({ undo_rewind: noteId, stop_shells: stopShells || undefined }) });
  // The prompt the rewind gave back to the box is back in the conversation: the box lets it go if it still holds it.
  if (r.prompt_text) seedComposer("", sessionId, { replacing: r.prompt_text });
}
export const undoRewindOrReport = (sessionId: string, noteId: string) => undoRewind(sessionId, noteId).catch(reportError);
export const sessionLine = (sessionId: string): StoredEvent[] => {
  const st = getState();
  return lineage(st.events[sessionId] ?? [], st.sessions[sessionId]?.head ?? null);
};
