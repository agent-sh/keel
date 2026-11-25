// What a session is doing, for a reader that reads a file for it when the
// read states no aim (src/tools/reading.ts): its task and what it last said,
// shortened. And whether its own prompts name a file: one the owner or a task
// pointed at is read as it is. Read off the branch's stored events, no model.
import type { StoredEvent } from "../core/types.ts";
import { ownerPrompts } from "./title.ts";

// Each part of the aim, in characters: enough for a task's subject and the
// model's last few sentences; the reader's request is its own cost.
export const AIM_PART = 500;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
// The start of a text (a task says what it is about first), cut at a word.
const head = (s: string, n: number) => { const t = flat(s); if (t.length <= n) return t; const cut = t.lastIndexOf(" ", n); return `${t.slice(0, cut > n / 2 ? cut : n)}...`; };
// The end of a text (what a model says last before a call is why it makes it), cut at a word.
const tail = (s: string, n: number) => { const t = flat(s); if (t.length <= n) return t; const cut = t.indexOf(" ", t.length - n); return `...${t.slice(cut >= 0 && cut < t.length - n / 2 ? cut + 1 : t.length - n)}`; };

export function readAim(line: readonly StoredEvent[]): string {
  // The newest prompt: the owner's, or for an agent its task (after the harness's own words about being one).
  const prompt = ownerPrompts(line).at(-1) ?? "";
  const at = prompt.indexOf("\nTask:\n");
  const task = head(at >= 0 ? prompt.slice(at + 7) : prompt, AIM_PART);
  // What it last said: the newest reply with words in it, since that prompt at the earliest.
  let said = "";
  for (let i = line.length - 1; i >= 0 && !said; i--) {
    const e = line[i]!;
    if (e.kind === "user" && !e.data.kind && typeof e.data.text === "string" && !e.data.text.startsWith("[harness]")) break;
    if (e.kind === "assistant") said = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => String(b.text ?? "")).join("\n").trim();
  }
  return [task ? `Its task (shortened): ${task}` : "", said ? `What it said before this read (shortened): ${tail(said, AIM_PART)}` : ""].filter(Boolean).join("\n");
}

// Whether a prompt names the file: its path as given (`paths`: the file's own, and as the session's folder
// sees it), or its name where a file name stands (not inside a longer name).
const NAME_CHAR = /[A-Za-z0-9_-]/;
export function namedIn(prompts: readonly string[], paths: readonly string[]): boolean {
  const name = (paths[0] ?? "").slice((paths[0] ?? "").lastIndexOf("/") + 1);
  if (!name) return false;
  for (const text of prompts) {
    if (paths.some((p) => p.includes("/") && text.includes(p))) return true;
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      const before = text[at - 1] ?? " ", after = text[at + name.length] ?? " ", then = text[at + name.length + 1] ?? " ";
      if (NAME_CHAR.test(before) || before === "." || NAME_CHAR.test(after) || (after === "." && NAME_CHAR.test(then))) continue;
      return true;
    }
  }
  return false;
}
export const readNamed = (line: readonly StoredEvent[], paths: readonly string[]) => namedIn(ownerPrompts(line), paths);
