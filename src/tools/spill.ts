import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { conceal } from "../core/conceal.ts";

// Token efficiency: a tool output past the cap goes to a file; the model gets
// the head, the tail and the path, and can Read or Grep the rest on demand.
export const OUTPUT_CAP = 30_000;

// `cap`: the characters kept inline (OUTPUT_CAP unless the result was sized
// by what carrying it costs, src/tools/carry.ts); `head`: the share of them
// taken from the start, the rest from the end (a cap at OUTPUT_CAP keeps the
// tenth between the two as room, as it always did).
export async function spill(text: string, dir: string, label: string, cap = OUTPUT_CAP, head = 0.6): Promise<string> {
  if (text.length <= cap) return text;
  mkdirSync(dir, { recursive: true });
  // The file keeps placeholders, as the stored result does.
  text = conceal(text);
  // Two outputs of one millisecond and label get a file each: the name ends
  // in random characters, and the file is created only when no file has it.
  let path = "";
  for (let n = 0; ; n++) {
    path = join(dir, `${Date.now()}-${label.replace(/[^\w.-]/g, "_").slice(0, 40)}-${crypto.randomUUID().slice(0, 8)}.txt`);
    try {
      await writeFile(path, text, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 8) throw e;
    }
  }
  const [a, b] = cut(cap, head);
  const start = text.slice(0, a), end = text.slice(-b);
  const lines = text.split("\n").length;
  return `${start}\n\n[... ${text.length - start.length - end.length} chars cut; full output (${lines} lines) saved to ${path} ...]\n\n${end}`;
}

// The characters kept from the start and from the end of a result cut to `cap`.
const cut = (cap: number, head: number): [number, number] =>
  cap >= OUTPUT_CAP ? [OUTPUT_CAP * 0.6, OUTPUT_CAP * 0.3] : [Math.floor(cap * head), cap - Math.floor(cap * head)];

const NOTE_ROOM = 2_000;
// The line a cut output names its file with (spill's, and the shell tool's for an output too large).
const SAVED = /chars cut; full output \(\d+ lines\) saved to \S+ \.\.\.\]|Full output saved to: \S+/;

// The one cap every tool's result is held to, enforced by the engine on what
// a tool returned (the tool may have cut its output already: a result within
// the cap passes as it is). Text past it goes through the spill: the model
// gets the head, the tail and the file. A tool that bounds its own result
// for a stated reason names another cap (Tool.resultCap): a file reader pages
// what it returns, a skill's instructions come whole.
// `dir` undefined (the call ran on another machine, where this file could
// not be read): the middle is cut with nothing saved, and the result says so.
// `sized`: the cap the session's carrying cost sets for this result (src/tools/carry.ts), with the
// share of it kept from the start; a result past it is cut to it.
export async function capResult<B extends { type: string }>(content: string | B[], cap: number, dir: string | undefined, label: string, sized?: { cap: number; head: number }): Promise<string | B[]> {
  // A tool that cut its output to the cap adds a line or two around it (the
  // exit code, the folder it ended in, where the log is): those pass.
  // With no folder to keep the rest in (a call run on another machine), the size is not lowered: what is cut is lost.
  if (!dir) sized = undefined;
  const keep = sized && sized.cap < cap ? sized : { cap: OUTPUT_CAP, head: 0.6 };
  cap = (sized && sized.cap < cap ? sized.cap : cap) + NOTE_ROOM;
  const hold = async (text: string) => {
    if (text.length <= cap) return text;
    // Cut and saved by the tool itself already (an MCP result): cut again, the line naming its file would go.
    if (keep === sized && text.length <= OUTPUT_CAP + NOTE_ROOM && SAVED.test(text)) return text;
    if (dir) return spill(text, dir, label, keep.cap, keep.head);
    const [a, b] = cut(keep.cap, keep.head);
    const head = text.slice(0, a), tail = text.slice(-b);
    return `${head}\n\n[... ${text.length - head.length - tail.length} chars cut and not kept: narrow the call to see them ...]\n\n${tail}`;
  };
  if (typeof content === "string") return hold(content);
  // Blocks: the cap is for all the text of the result, not for each block.
  // Past it the texts become one, cut through the spill, where the first of
  // them stood; what is not text (an image, a tool reference) stays.
  const textOf = (b: B) => (b.type === "text" ? ((b as unknown as { text: string }).text ?? "") : undefined);
  const texts = content.map(textOf).filter((t): t is string => t !== undefined);
  if (texts.reduce((n, t) => n + t.length, 0) <= cap) return content;
  const one = await hold(texts.join("\n"));
  const first = content.findIndex((b) => b.type === "text");
  return content.flatMap((b, i) => (b.type !== "text" ? [b] : i === first ? [{ ...b, text: one }] : []));
}

// --- Spilled output the storage retention removed (src/admin/retention.ts) ---
// The retention writes down what it removed in the session's spill folder:
// a result in the transcript still names the file, and whoever reads it
// later (the model, the transcript row, the Terminal panel) is told what
// became of it, not that there never was such a file.
export const REMOVED_NOTE = ".retention.json";
type RemovedNote = { removed_ms: number; kept_days: number; files: number; bytes: number; names: string[] };

// `names`: paths inside `dir` (the session's spill folder) that were removed now.
export function noteRemoved(dir: string, names: string[], bytes: number, keptDays: number, now = Date.now()) {
  let was: RemovedNote | undefined;
  try { was = JSON.parse(readFileSync(join(dir, REMOVED_NOTE), "utf8")); } catch {} // the first removal here
  mkdirSync(dir, { recursive: true });
  const note: RemovedNote = { removed_ms: now, kept_days: keptDays, files: (was?.files ?? 0) + names.length, bytes: (was?.bytes ?? 0) + bytes, names: [...new Set([...(was?.names ?? []), ...names])] };
  writeFileSync(join(dir, REMOVED_NOTE), JSON.stringify(note), { mode: 0o600 });
}

// What to say of a path under a session's spill folder that is not there
// because the retention removed it; undefined for any other path.
export function removedNote(path: string, spillDir: string): string | undefined {
  if (!spillDir) return;
  const rel = relative(spillDir, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || existsSync(path)) return;
  let note: RemovedNote;
  try { note = JSON.parse(readFileSync(join(spillDir, REMOVED_NOTE), "utf8")); } catch { return; }
  if (!Array.isArray(note.names) || !note.names.includes(rel)) return;
  return `${path} was removed by the storage retention on ${new Date(note.removed_ms).toISOString().slice(0, 10)}: spilled output is kept ${note.kept_days} days after its session was last used (Settings, Storage). Run the command again to get its output.`;
}
