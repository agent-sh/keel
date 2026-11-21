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
