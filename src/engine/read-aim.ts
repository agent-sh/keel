// What a session is doing, for a reader that reads a file for it when the
// read states no aim (src/tools/reading.ts): its task and what it last said,
// shortened. And whether what it was given names a file: one the owner, an
// agent's task or its parent's message pointed at is read as it is. Read off
// the branch's stored events, no model.
import type { StoredEvent } from "../core/types.ts";
import { ownerPrompt, PEER_PREFIX } from "../core/owner.ts";

// Each part of the aim, in characters: enough for a task's subject and the
// model's last few sentences; the reader's request is its own cost.
export const AIM_PART = 500;

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
// The start of a text (a task says what it is about first), cut at a word.
const head = (s: string, n: number) => { const t = flat(s); if (t.length <= n) return t; const cut = t.lastIndexOf(" ", n); return `${t.slice(0, cut > n / 2 ? cut : n)}...`; };
// The end of a text (what a model says last before a call is why it makes it), cut at a word.
const tail = (s: string, n: number) => { const t = flat(s); if (t.length <= n) return t; const cut = t.indexOf(" ", t.length - n); return `...${t.slice(cut >= 0 && cut < t.length - n / 2 ? cut + 1 : t.length - n)}`; };

// What a session was given to work on, as one event's words: the owner's own prompt,
// and for an agent its task (after the harness's own words about being an agent) and a message sent to it
// while it works (its parent's, a peer's). Not a report, a wake, a note of the harness.
function given(e: StoredEvent): string | undefined {
  if (e.kind !== "user" || typeof e.data.text !== "string") return undefined;
  if (e.data.kind === "task") { const at = e.data.text.indexOf("\nTask:\n"); return (at >= 0 ? e.data.text.slice(at + 7) : e.data.text).trim() || undefined; }
  if (e.data.kind === "steer") return e.data.text.trim() || undefined;
  return ownerPrompt(e.data) && !e.data.text.startsWith(PEER_PREFIX) && !e.data.text.startsWith("[harness]") ? e.data.text.trim() || undefined : undefined;
}
// All of them on a branch, oldest first.
export const givenPrompts = (line: readonly StoredEvent[]): string[] => line.map(given).filter((t): t is string => !!t);

export function readAim(line: readonly StoredEvent[]): string {
  // The newest task or owner prompt, any later message from its parent, and what it last said since then.
  let prompt = "", later = "", said = "";
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    const text = given(e);
    if (text) {
      if (e.data.kind !== "steer") { prompt = text; break; }
      if (e.data.from_agent === undefined && !later) later = text;
    }
    if (e.kind === "assistant" && !said && !later) said = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => String(b.text ?? "")).join("\n").trim();
  }
  // (A task carried in a prompt with no kind of its own, as an imported agent's is.)
  const at = prompt.indexOf("\nTask:\n");
  const task = head(at >= 0 ? prompt.slice(at + 7) : prompt, AIM_PART);
  return [
    task ? `Its task (shortened): ${task}` : "",
    later ? `A later message to it: ${head(later, AIM_PART)}` : "",
    said ? `What it said before this read (shortened): ${tail(said, AIM_PART)}` : "",
  ].filter(Boolean).join("\n");
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
export const readNamed = (line: readonly StoredEvent[], paths: readonly string[]) => namedIn(givenPrompts(line), paths);
