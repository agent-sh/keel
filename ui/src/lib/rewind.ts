// Rewinding from a prompt of the transcript (the dialog is components/RewindDialog.tsx): which prompts the
// branch shown holds and what each changed, and the rewind that can still be undone. Pure; the acts are in rewind-act.ts.
import { shownAsPrompt } from "../../../src/core/owner.ts";
import type { StoredEvent } from "../../../src/core/types.ts";

export type PromptRow = { id: string; text: string; files: number; seq: number };
type Turns = readonly { turn: number; files: readonly unknown[] }[];

// The prompts of a branch, oldest first, each with the files the turns it started changed: the turns whose
// start events stand on the branch between it and the next prompt (a turn of another branch is not its).
export function promptRowsOf(prompts: readonly { id: string; seq: number; text: string; attachments?: boolean }[], starts: ReadonlySet<number>, turns: Turns): PromptRow[] {
  return prompts.map((p, i) => {
    const until = prompts[i + 1]?.seq ?? Infinity;
    const files = turns.filter((t) => t.turn > p.seq && t.turn < until && starts.has(t.turn)).reduce((n, t) => n + t.files.length, 0);
    return { id: p.id, text: p.text || (p.attachments ? "(attachments)" : "(no words)"), files, seq: p.seq };
  });
}

// From the events the page holds (the newest part of a long branch: the dialog asks the daemon for all of them).
export function promptRows(line: readonly StoredEvent[], turns: Turns): PromptRow[] {
  return promptRowsOf(
    line.filter(shownAsPrompt).map((p) => ({ id: p.id, seq: p.seq, text: String(p.data.text ?? "").trim().split("\n")[0]!, attachments: (p.data.images?.length ?? 0) > 0 })),
    new Set(line.filter((e) => e.kind === "turn_start").map((e) => e.seq)), turns);
}

// The rewind of the branch that can still be undone: its note is on the branch and no prompt came after it.
export function lastRewind(line: readonly StoredEvent[]): StoredEvent | undefined {
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    if (shownAsPrompt(e)) return undefined;
    if (e.kind === "note" && e.data.kind === "rewound") return e;
  }
  return undefined;
}
