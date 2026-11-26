// What the views that show instruction files say a session gets (Settings > Instructions' As loaded,
// the session profile): the chain as the prompt renders it (engine/turn.ts instructionsMade), not each
// file read again on its own. Each file's fate (whole, cut, not loaded, the same as another, every
// section said above, held by its trust pin, the version last trusted), its text as the prompt
// carries it, and the window the render is for: a session's model's, or for a folder with no session
// a prediction on the model a new session there starts on, which the report names.
import type { ChainMade, InstructionFact } from "./turn.ts";

export type FileReport = Omit<InstructionFact, "text"> & { loaded: string; loaded_tokens: number; note: string | null };
export type ChainReport = {
  // The model the render is for, and its window (null: none stated, counted as 200K as a start does).
  model: string | null; window: number | null; prediction: boolean;
  // One file's bound and the whole chain's, in characters; what the chain carries.
  limit: number; room: number; carried: number; files: FileReport[]; warnings: string[];
};

const n = (x: number) => x.toLocaleString("en-US");

// What a file's fate is, in a line; null for a file carried whole and as it is on disk.
export function factNote(f: Omit<InstructionFact, "text">): string | null {
  const parts: string[] = [];
  switch (f.state) {
    case "cut": parts.push(`cut at ${n(f.at ?? f.carried)} of ${n(f.chars)} characters; the prompt says where the rest starts`); break;
    case "out": parts.push("not loaded: the files above fill the room the window gives the chain; the prompt names it to read"); break;
    case "same": parts.push(f.imports ? `only imports ${f.same_of}, carried once` : `the same as ${f.same_of}, carried once`); break;
    case "repeats": parts.push("every section of it is said by a file above"); break;
    case "unread": parts.push("could not be read; the prompt says so"); break;
    case "held": parts.push("left out until you trust it"); break;
    case "had": parts.push("already in the session's prompt"); break;
  }
  if (f.trust === "as_trusted") parts.push("the version you last trusted, not the file as it is now");
  if (f.left_out && f.state !== "repeats") parts.push(`${f.left_out} run${f.left_out === 1 ? "" : "s"} of sections said by a file above left out`);
  return parts.length ? parts.join("; ") : null;
}

export function chainReport(made: ChainMade, o: { model?: string | null; prediction: boolean }): ChainReport {
  const files = made.files.map(({ text, ...f }) => ({ ...f, loaded: text ?? "", loaded_tokens: Math.ceil((text?.length ?? 0) / 4), note: factNote(f) }));
  const windowWords = made.window ? `a ${n(made.window)}-token window` : "a window of unstated size (counted as 200,000 tokens)";
  const on = `${o.model ?? "the model"}, ${windowWords}`;
  const warnings = files.filter((f) => f.state === "cut" || f.state === "out" || f.state === "held" || f.state === "unread" || f.trust === "as_trusted").map((f) => `${f.path}: ${f.note} (on ${on})`);
  return { model: o.model ?? null, window: made.window ?? null, prediction: o.prediction, limit: made.limit, room: made.room, carried: files.reduce((s, f) => s + f.carried, 0), files, warnings };
}
