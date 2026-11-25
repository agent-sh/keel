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

// The turns (their start events' seq, as checkpoints name them) that are not on `line`. Only the kinds
// and seqs of the events are looked at: no body is read, so the common case (every turn is on the
// branch) costs a pass over the list and nothing from the disk.
export function offBranch(starts: readonly number[], line: readonly StoredEvent[]): number[] {
  const on = new Set<number>();
  for (const e of line) if (e.kind === "turn_start") on.add(e.seq);
  return starts.filter((t) => !on.has(t));
}

// The notes that may tell a turn (`seq` after it: a note comes after what it tells) and have not been read yet:
// the first of them is where a reader that can wait warms the bodies from. `read`: the notes already read.
export function unreadNotes(line: readonly StoredEvent[], after: number, read: ReadonlyMap<string, readonly number[]>): StoredEvent[] {
  return line.filter((e) => e.kind === "note" && e.seq > after && !read.has(e.id));
}

// The turns of `starts` that are not on `line` and that no note on it has told: a branch_files note, or
// a rewind note that put their files back. The notes' bodies are read only for a turn that is off the
// branch, only from that turn on, and once for each note (`read` keeps what each told).
export function leftTurns(starts: readonly number[], line: readonly StoredEvent[], read: Map<string, readonly number[]> = new Map()): number[] {
  const off = offBranch(starts, line);
  if (!off.length) return [];
  const told = new Set<number>();
  const from = Math.min(...off);
  for (const e of line) {
    if (e.kind !== "note" || e.seq <= from) continue;
    let turns: readonly number[] = read.get(e.id) ?? [];
    if (!read.has(e.id)) {
      const said = e.data.turns;
      turns = Array.isArray(said) ? said.map(Number) : [];
      read.set(e.id, turns);
    }
    for (const t of turns) told.add(t);
  }
  return off.filter((t) => !told.has(t));
}

// The note's words for the model, and the short line the transcript shows.
export function branchNote(files: readonly string[]): { short: string; text: string } {
  const names = files.slice(0, SHOWN).join(", ") + (files.length > SHOWN ? ` and ${files.length - SHOWN} more` : "");
  return {
    short: `Files changed on another branch: ${files.length}`,
    text: `[harness] The owner moved this conversation to a branch that does not contain some earlier turns. Those turns changed these files, and they stay on disk as that branch left them: ${names}. This branch has not seen them, so their content is unknown to it: read a file before relying on it.`,
  };
}
