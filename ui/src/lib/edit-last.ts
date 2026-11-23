// Up in an empty message box opens the last prompt in its edit box, and Enter
// there sends it as a new version (the edit path of Transcript.tsx). The Codex
// app restores the previous prompt on Up in an empty composer; Claude Code
// recalls its prompt history the same way. Here the prompt is edited in place,
// so the new words replace the old turn instead of following it.
import { shownAsPrompt } from "../../../src/core/owner.ts";
import type { StoredEvent } from "../../../src/core/types.ts";

// Inputs the harness adds inside a turn (a restart note, its own notice): the
// prompt before them is still the turn's prompt.
const inTurn = (e: StoredEvent) => e.kind === "user" && (e.data.origin === "harness" || e.data.origin === "restart");

// The prompt Up opens on the branch `line`, or null. At rest (the turn ended,
// was stopped or failed) it is the last prompt, when nothing but the turn's
// own notes came in after it (another session's message, an agent's report or
// a wake started a turn of its own: editing the prompt before it would drop
// that). While a turn runs, only until its reply starts (no reply stored and
// none streaming): a turn already at work is steered, not edited by a key.
export function promptToEdit(line: readonly StoredEvent[], working: boolean, streaming: boolean): string | null {
  const at = line.findLastIndex(shownAsPrompt);
  if (at < 0) return null;
  const after = line.slice(at + 1);
  if (after.some((e) => e.kind === "user" && !inTurn(e))) return null;
  if (working && (streaming || after.some((e) => e.kind === "assistant"))) return null;
  return line[at]!.id;
}
