// What a memory lookup returns decides whether it is made: the pure rules.
//
// Before a tool. The store answers a tool call from facts tied to the paths
// it writes and from areas tied to its tool or its command. A kind of call
// (a shell command, a file write, one MCP server's tools) is asked on every
// call while the store answers it now and then. A kind the store has not
// answered for QUIET_AFTER calls in a row is quiet. A quiet kind's call is
// still asked when it names the store (it records a step of its own), when
// the store has ever answered a call of its family or none of the family was
// ever asked (a rule tied to `git push` is found by the first `git` call, and
// every `git` call after it is asked once the store has answered one; a
// program the store never answered is asked once and then only in the
// sample; callFamilies), and as one call in SAMPLE_EVERY, so a store that
// starts answering the kind or the family is seen. A
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
import { dirname } from "node:path";
import { splitCommand } from "../safety/shell.ts";
import { name as baseName, unwrap } from "../safety/risk-words.ts";
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

// What an answer of the store speaks for: the program each command of a shell
// line runs, the folder of each file a write touches, an MCP tool by its name.
// A call is of the families its programs are; the store ties a fact to a
// command, a file or an area, and a family is the widest group a fact of one
// kind has been seen to cover.
// A shell line's programs are read as the safety gate reads it (splitCommand,
// then unwrap for `sudo make`, `uv run x`): a here-document's lines are text a
// program reads, not commands, and a quoted script or an argument is one word
// of its program, so none of their words is a family (a word of a script was
// once a family of its own: `this`, `250`, a commit id, a scratch folder).
// A word that can be a program: not a path, a file or a flag.
const PROGRAM = /^[a-z0-9][\w-]*$/;
// Words a shell reads itself (loops, builtins that only steer the line): no program runs under them.
const SYNTAX = new Set(["for", "while", "until", "select", "do", "done", "if", "then", "else", "elif", "fi", "case", "esac", "in", "function", "break", "continue", "return", "exit", "shift", "local", "export", "unset", "read", "set", "eval", "true", "false", "declare", "typeset", "readonly", "let", "wait", "trap"]);
// A function the line defines is not a program either (`p() { sed -n 1p x; }; p a`).
const FUNCTION = /(?:^|[;&|{(\n])\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)/g;
function shellPrograms(command: string): string[] {
  const parts = splitCommand(command);
  // Not a line a shell would run: its first word, if that can be a program.
  if (!parts) { const w = words(command)[0]; return w && PROGRAM.test(baseName(w)) ? [baseName(w)] : []; }
  const out = new Set<string>(), defined = new Set([...command.matchAll(FUNCTION)].map((m) => m[1]!.toLowerCase()));
  for (const p of parts) {
    if (p.heredoc) continue;
    const prog = baseName(unwrap(p.words).words[0]).toLowerCase();
    if (PROGRAM.test(prog) && !SYNTAX.has(prog) && !defined.has(prog)) out.add(prog);
  }
  return [...out];
}
export function callFamilies(call: StoreCall): string[] {
  if (call.tool_name.startsWith("mcp__")) return [call.tool_name];
  if (call.tool_name === "Bash" || (call.tool_name === "apply_patch" && !filesOf(call).length)) return shellPrograms(String(call.tool_input?.command ?? ""));
  return [...new Set(filesOf(call).map((f) => dirname(f)))];
}

// How a kind has answered: calls answered in a row with nothing (`quiet`),
// and quiet calls passed over since the last one asked (`passed`).
export type KindYield = { quiet: number; passed: number };
export const freshYield = (): KindYield => ({ quiet: 0, passed: 0 });

// full: asked and waited for as before; light: asked, not waited for; skip: not asked.
export type ToolAsk = "full" | "light" | "skip";
// `known`: the store has answered a call of the call's family, or none of the family was asked yet.
export function toolAsk(y: KindYield, known: boolean, namesStore: boolean, quietAfter = QUIET_AFTER, every = SAMPLE_EVERY): ToolAsk {
  if (namesStore || y.quiet < quietAfter) return "full";
  if (known || y.passed + 1 >= every) return "light";
  return "skip";
}
// The kind's count after a decision and, for a call that was asked, its answer.
export function afterAsk(y: KindYield, ask: ToolAsk): KindYield {
  return ask === "skip" ? { ...y, passed: y.passed + 1 } : ask === "light" ? { ...y, passed: 0 } : y;
}
export function afterAnswer(y: KindYield, gaveFact: boolean): KindYield {
  return gaveFact ? { quiet: 0, passed: 0 } : { ...y, quiet: y.quiet + 1 };
}
