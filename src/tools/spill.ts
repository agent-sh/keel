import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conceal } from "../core/conceal.ts";

// Token efficiency: a tool output past the cap goes to a file; the model gets
// the head, the tail and the path, and can Read or Grep the rest on demand.
export const OUTPUT_CAP = 30_000;

export async function spill(text: string, dir: string, label: string): Promise<string> {
  if (text.length <= OUTPUT_CAP) return text;
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
  const head = text.slice(0, OUTPUT_CAP * 0.6);
  const tail = text.slice(-OUTPUT_CAP * 0.3);
  const lines = text.split("\n").length;
  return `${head}\n\n[... ${text.length - head.length - tail.length} chars cut; full output (${lines} lines) saved to ${path} ...]\n\n${tail}`;
}

const NOTE_ROOM = 2_000;

// The one cap every tool's result is held to, enforced by the engine on what
// a tool returned (the tool may have cut its output already: a result within
// the cap passes as it is). Text past it goes through the spill: the model
// gets the head, the tail and the file. A tool that bounds its own result
// for a stated reason names another cap (Tool.resultCap): a file reader pages
// what it returns, a skill's instructions come whole.
// `dir` undefined (the call ran on another machine, where this file could
// not be read): the middle is cut with nothing saved, and the result says so.
export async function capResult<B extends { type: string }>(content: string | B[], cap: number, dir: string | undefined, label: string): Promise<string | B[]> {
  // A tool that cut its output to the cap adds a line or two around it (the
  // exit code, the folder it ended in, where the log is): those pass.
  cap += NOTE_ROOM;
  const hold = async (text: string) => {
    if (text.length <= cap) return text;
    if (dir) return spill(text, dir, label);
    const head = text.slice(0, OUTPUT_CAP * 0.6), tail = text.slice(-OUTPUT_CAP * 0.3);
    return `${head}\n\n[... ${text.length - head.length - tail.length} chars cut and not kept: narrow the call to see them ...]\n\n${tail}`;
  };
  if (typeof content === "string") return hold(content);
  if (!content.some((b) => b.type === "text" && ((b as unknown as { text: string }).text?.length ?? 0) > cap)) return content;
  return Promise.all(content.map(async (b) => (b.type === "text" ? { ...b, text: await hold((b as unknown as { text: string }).text ?? "") } : b)));
}
