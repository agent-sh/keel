// Rewinding from a prompt of the transcript (the dialog is components/RewindDialog.tsx): which prompts the
// branch shown holds and what each changed, and the rewind that can still be undone. Pure; the acts are in rewind-act.ts.
import { shownAsPrompt } from "../../../src/core/owner.ts";
import type { StoredEvent } from "../../../src/core/types.ts";

export type PromptRow = { id: string; text: string; files: number; seq: number };

// The prompts of a branch, oldest first, each with the files the turns it started changed: the turns whose
// start events stand on the branch between it and the next prompt (a turn of another branch is not its).
export function promptRows(line: readonly StoredEvent[], turns: readonly { turn: number; files: readonly unknown[] }[]): PromptRow[] {
  const starts = new Set(line.filter((e) => e.kind === "turn_start").map((e) => e.seq));
  const prompts = line.filter(shownAsPrompt);
  return prompts.map((p, i) => {
    const until = prompts[i + 1]?.seq ?? Infinity;
    const files = turns.filter((t) => t.turn > p.seq && t.turn < until && starts.has(t.turn)).reduce((n, t) => n + t.files.length, 0);
    const text = String(p.data.text ?? "").trim().split("\n")[0]!;
    return { id: p.id, text: text || ((p.data.images?.length ?? 0) > 0 ? "(attachments)" : "(no words)"), files, seq: p.seq };
  });
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
