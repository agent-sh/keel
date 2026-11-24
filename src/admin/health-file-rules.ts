// What is wrong with a skill, command or agent file, from its text alone. These
// rules say what Keel's own readers do with the file (src/tools/skills.ts for
// skills and commands, src/automation/agents.ts for agents): a finding is a
// file that is not loaded, or loads with part of what it says lost. Light on
// purpose: the read thread runs them (src/admin/health-files.ts).
import { AGENT_FILE_MAX } from "../core/agent-file.ts";
import { yamlWithin } from "../core/yaml-bound.ts";
import type { Level } from "./health-rows.ts";

export type FileKind = "skill" | "command" | "agent" | "codex agent";
export type Finding = { level: Level; why: string; fix: string };

// The front matter a skill or command file opens with, and the body after it.
// A file that opens with --- and never closes it has none: the whole text is body.
function front(text: string): { head: string; body: string } | "open" | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "open";
  return { head: text.slice(text.indexOf("\n") + 1, end), body: text.slice(text.indexOf("\n", end + 1) + 1) };
}

const hasKey = (head: string, key: string) => new RegExp(`^${key}:`, "m").test(head);
const unquote = (v: string) => v.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");

export function fileFindings(kind: FileKind, text: string, size = Buffer.byteLength(text)): Finding[] {
  const out: Finding[] = [];
  if (kind === "codex agent") {
    if (size > AGENT_FILE_MAX) return [{ level: "broken", why: `the file is larger than ${AGENT_FILE_MAX / 1024} KB, so Keel does not read it`, fix: "shorten developer_instructions, or keep long text in a file the instructions name" }];
    let t: Record<string, unknown>;
    try { t = Bun.TOML.parse(text) as Record<string, unknown>; } catch (e) { return [{ level: "broken", why: `it is not valid TOML: ${(e as Error).message.split("\n")[0]}`, fix: "fix the TOML syntax of the file" }]; }
    const missing = ["name", "description", "developer_instructions"].filter((k) => typeof t[k] !== "string" || !(t[k] as string).trim());
    if (missing.length) out.push({ level: "broken", why: `a Codex agent file needs ${missing.join(", ")}`, fix: `add ${missing.join(", ")} to the file` });
    return out;
  }
  if (kind === "agent") {
    if (size > AGENT_FILE_MAX) return [{ level: "broken", why: `the file is larger than ${AGENT_FILE_MAX / 1024} KB, so Keel does not read it`, fix: "shorten the file: the prompt should be a page, not a manual" }];
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return [{ level: "broken", why: "it has no front matter between two --- lines, so Keel skips the file", fix: "start the file with --- , then name and description, then a closing ---" }];
    const r = yamlWithin(m[1]!, AGENT_FILE_MAX);
    const meta = "value" in r && r.value && typeof r.value === "object" && !Array.isArray(r.value) ? (r.value as Record<string, unknown>) : undefined;
    if (!meta) out.push({ level: "warning", why: `the front matter is not valid YAML (${"problem" in r ? r.problem : "not a map"}): Keel reads it line by line and can lose fields that nest`, fix: "fix the YAML of the front matter" });
    if (!(meta ? typeof meta.description === "string" && meta.description.trim() : hasKey(m[1]!, "description"))) out.push({ level: "warning", why: "it has no description, so the model cannot tell when to start this agent", fix: "add a description line to the front matter" });
    return out;
  }
  // A skill folder's SKILL.md, or a command file.
  const f = front(text);
  if (f === "open") return [{ level: "broken", why: "its front matter opens with --- and never closes, so its name, description and settings are ignored", fix: "add a closing --- line after the front matter" }];
  if (f) {
    const name = /^name:[ \t]*(.*)$/m.exec(f.head)?.[1];
    if (kind === "skill" && name !== undefined && /[<>\u200b]/.test(unquote(name))) out.push({ level: "broken", why: `the name ${JSON.stringify(unquote(name))} has characters Keel does not load (< > or a zero-width space), so the skill is not listed`, fix: "rename the skill with letters, digits and dashes" });
    if (!hasKey(f.head, "description") && !f.body.split("\n").some((l) => l.trim())) out.push({ level: "warning", why: "it has no description and no text, so the model cannot tell when to use it", fix: "add a description line to the front matter" });
  } else if (!text.split("\n").some((l) => l.trim())) out.push({ level: "warning", why: "the file is empty", fix: "write the skill's text, or delete the file" });
  return out;
}
