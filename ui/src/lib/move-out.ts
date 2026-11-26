// A session moved to Claude Code or Codex with one press (src/server/routes/continue.ts): written in its harness's
// own format, a terminal opened on it, the row here archived with where it went. Where no terminal opened, the
// session is shown: its strip has the command to paste.
import type { Moved, Session } from "../../../src/core/types.ts";
import { announce } from "./announce.ts";
import { api } from "./store.ts";
import { navigate } from "./ui.ts";

export type Harness = "claude" | "codex";
export const HARNESS_WORD: Record<Harness, string> = { claude: "Claude Code", codex: "Codex" };
export type ContinueOffer = { original?: { harness: Harness; source_id: string; kept_here: number }; terminal: { terminal?: string; tmux?: string }; moved?: Moved };

export const continueOffer = (id: string) => api<ContinueOffer>(`/api/sessions/${id}/continue`);

export async function continueIn(s: Pick<Session, "id" | "title">, harness: Harness, original = false): Promise<Moved> {
  const r = await api<{ moved: Moved }>(`/api/sessions/${s.id}/continue`, { method: "POST", body: JSON.stringify({ harness, ...(original ? { original: true } : {}) }) });
  const where = HARNESS_WORD[harness];
  if (r.moved.opened) announce(`${s.title || "The session"} goes on in ${where}, in a terminal`);
  else {
    announce(`${s.title || "The session"} is in ${where}; no terminal opened: ${r.moved.why ?? ""}`, "alert");
    navigate({ name: "session", id: s.id });
  }
  return r.moved;
}

export const openAgain = (id: string) => api<{ moved: Moved }>(`/api/sessions/${id}/continue`, { method: "POST", body: JSON.stringify({ again: true }) }).then((r) => r.moved);

// The words of a moved row's tag and its tooltip.
export const movedTag = (m: Moved) => `in ${HARNESS_WORD[m.harness]}`;
export const movedTip = (m: Moved) => `Moved to ${HARNESS_WORD[m.harness]}${m.original ? " (its original)" : ""}: ${m.shell_command}`;
