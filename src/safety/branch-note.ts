// What the disk holds from turns the branch shown does not contain. When the
// head moves off turns that changed files and the files stay (an edited
// prompt, a version arrow, a chat-only rewind), the new branch's history says
// nothing of them: its model would re-create, re-read or contradict those
// files. The first request of the new branch carries one note naming them
// (Gemini CLI's rewind page advises telling the model the same). Made from
// the turn checkpoints, no model call; a turn is told once, and a file
// restore that already told it counts.
import type { StoredEvent } from "../core/types.ts";

export const BRANCH_NOTE = "branch_files";
const SHOWN = 30;

// The turns (their start events' seq, as checkpoints name them) that are not on `line` and that no
// note on it has told: a branch_files note, or a rewind note that put their files back.
export function leftTurns(starts: readonly number[], line: readonly StoredEvent[]): number[] {
  const on = new Set<number>();
  const told = new Set<number>();
  for (const e of line) {
    if (e.kind === "turn_start") on.add(e.seq);
    else if (e.kind === "note" && Array.isArray(e.data.turns)) for (const t of e.data.turns) told.add(Number(t));
  }
  return starts.filter((t) => !on.has(t) && !told.has(t));
}

// The note's words for the model, and the short line the transcript shows.
export function branchNote(files: readonly string[]): { short: string; text: string } {
  const names = files.slice(0, SHOWN).join(", ") + (files.length > SHOWN ? ` and ${files.length - SHOWN} more` : "");
  return {
    short: `Files changed on another branch: ${files.length}`,
    text: `[harness] The owner moved this conversation to a branch that does not contain some earlier turns. Those turns changed these files, and they stay on disk as that branch left them: ${names}. This branch has not seen them, so their content is unknown to it: read a file before relying on it.`,
  };
}
