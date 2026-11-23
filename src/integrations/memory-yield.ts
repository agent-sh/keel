// What a memory lookup returns decides whether it is made: the pure rules.
//
// Before a tool. The store answers a tool call from facts tied to the paths
// it writes and from areas tied to its tool or its command. A kind of call
// (a shell command, a file write, one MCP server's tools) is asked on every
// call while the store answers it now and then. A kind the store has not
// answered for QUIET_AFTER calls in a row is quiet. A quiet kind's call is
// still asked when it names the store (it records a step of its own), when
// the session has not asked about its command or its file yet (a rule the
// store ties to `git push` comes with the session's first `git push`, one
// tied to `git push origin main` with its first such push; one tied to a
// file with its first write of it; callTopics), and as one call
// in SAMPLE_EVERY, so a store that starts answering the kind is seen. A
// quiet kind's asks are not waited for: their answer, if any, joins the next
// request. One answer with a fact makes the kind asked in full again. An
// answer counts when it carries a fact, used or not: a rule before an action
// works by what the model does not do, which no word count can see.
//
// Prompts and the facts given are not gated by use. Replayed over two busy
// days, a prompt not waited for left the owner's own lines a step behind, and
// every note given unused many times in a repository was one of the owner's
// standards, decisions or past mistakes, or given as a title: no use count
// sees what the model does not do because of those.
import { filesOf, type StoreCall } from "./tacit-tools.ts";

// Edits in the measured stores answer about one call in 150; QUIET_AFTER is
// long enough that such a kind stays asked in full (no answer in 1,000 such
// calls is one chance in a thousand), and a kind that never answers stops
// within an hour of a busy day's calls.
export const QUIET_AFTER = 1000;
// One quiet call in 50 is asked: a store that starts answering a kind at one
// call in a hundred is noticed within about 5,000 calls of it.
export const SAMPLE_EVERY = 50;
// The kind of a call, as the store's answers differ by it.
export function toolKind(call: StoreCall): string {
  if (call.tool_name.startsWith("mcp__")) return `mcp:${call.tool_name.split("__")[1] ?? ""}`;
  if (call.tool_name === "Bash") return "shell";
  return "edit";
}

// What a call is about within its kind, as the store ties facts to it: a
// shell line by each of its commands, a write by each file it touches, an MCP
// tool by its name. A command is its words as the store's own match of a
// fact's command reads them (tacit's commandMatch): the line split at its
// separators, here-documents' lines included, each part lowercased, its
// FOO=1 assignments skipped and its program by base name; and the same from
// its second word on, when that is not a flag (a program that runs the next
// word, as in `sudo make`, runs that command). A fact's command matches a
// part when it is how the part starts, so two calls of one topic match the
// same facts: the first call of each topic is asked. A topic keeps the first
// TOPIC_WORDS words; a fact's command longer than that (1 in a store of
// 33,965) can match a later call of a topic and not its first.
export const TOPIC_WORDS = 8;
const CMD_BOUNDARY = /&&|\|\||[;|&()\n]|\$\(|`/;
const words = (s: string) => s.toLowerCase().split(/\s+/).filter(Boolean);
const topic = (w: string[]) => [w[0]!.split("/").pop(), ...w.slice(1, TOPIC_WORDS)].join(" ");
export function callTopics(call: StoreCall): string[] {
  if (call.tool_name.startsWith("mcp__")) return [call.tool_name];
  if (call.tool_name === "Bash" || (call.tool_name === "apply_patch" && !filesOf(call).length)) {
    const out = new Set<string>();
    for (const part of String(call.tool_input?.command ?? "").split(CMD_BOUNDARY)) {
      let w = words(part);
      while (w.length && w[0]!.includes("=") && !w[0]!.startsWith("-")) w = w.slice(1);
      if (!w.length) continue;
      out.add(topic(w));
      if (w.length > 1 && !w[1]!.startsWith("-")) out.add(topic(w.slice(1)));
    }
    return [...out];
  }
  return [...new Set(filesOf(call))];
}

// How a kind has answered: calls answered in a row with nothing (`quiet`),
// and quiet calls passed over since the last one asked (`passed`).
export type KindYield = { quiet: number; passed: number };
export const freshYield = (): KindYield => ({ quiet: 0, passed: 0 });

// full: asked and waited for as before; light: asked, not waited for; skip: not asked.
export type ToolAsk = "full" | "light" | "skip";
export function toolAsk(y: KindYield, first: boolean, namesStore: boolean, quietAfter = QUIET_AFTER, every = SAMPLE_EVERY): ToolAsk {
  if (namesStore || y.quiet < quietAfter) return "full";
  if (first || y.passed + 1 >= every) return "light";
  return "skip";
}
// The kind's count after a decision and, for a call that was asked, its answer.
export function afterAsk(y: KindYield, ask: ToolAsk): KindYield {
  return ask === "skip" ? { ...y, passed: y.passed + 1 } : ask === "light" ? { ...y, passed: 0 } : y;
}
export function afterAnswer(y: KindYield, gaveFact: boolean): KindYield {
  return gaveFact ? { quiet: 0, passed: 0 } : { ...y, quiet: y.quiet + 1 };
}
