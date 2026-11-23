// What an approval card shows of a call that is neither a command, nor file
// paths, nor a message to a session: the start of its input. Shared by the
// gate, which cuts it, and the page, which says so. No imports: the page
// loads this file too.

// The input is shown up to this many characters.
export const SUMMARY_LIMIT = 400;

// The kinds whose summary is the whole of what they do (the command, the paths, the message).
const WHOLE = ["shell", "edit", "drive", "send"];

// The card shows only the start of its input: it says so, opens to all the
// daemon kept, and is answered alone. A card written before cards were marked
// has no flag: one whose summary is exactly as long as the cut is taken for cut.
export const shownInPart = (a: { cut?: boolean; kind: string; summary: string }): boolean =>
  !!a.cut || (!WHOLE.includes(a.kind) && a.summary.length === SUMMARY_LIMIT);
