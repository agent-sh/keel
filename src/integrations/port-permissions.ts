// Permission rules from the other harnesses, as Keel's gate rules where the
// meaning maps one to one (src/safety/policy.ts: shell patterns, edit folders,
// tool names). Keel's rules only allow; its own high-risk checks ask whatever a
// rule says. Nothing is loosened: a rule Keel cannot hold the same way is left
// out with the reason, and an allow rule of a tool the owner also denies or
// asks for there is left out too (Keel has no deny rule to keep the carve-out).
//
// Claude Code's syntax (code.claude.com/docs/en/permissions, 2026-11-19):
// `Tool` or `Tool(specifier)`; deny, then ask, then allow; `Bash(x *)` and
// `Bash(x:*)` match x and x followed by a space; `*` anywhere stands in for any
// text; compound commands match only part by part; Read and Edit paths are
// gitignore patterns anchored by `//` (root), `~/` (home), `/` (the settings
// file's folder) or nothing (relative); MCP allows are `mcp__server__tool`, or
// a glob after a literal `mcp__server__` prefix.
import { homedir } from "node:os";
import type { RuleKind } from "../safety/policy.ts";
import { splitCommand } from "../safety/shell.ts";

export type Mapped = { kind: RuleKind; pattern: string } | { done: string } | { skip: string };

// Tools Keel runs without asking in every mode but read-only's own limits.
const READS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "NotebookRead"]);

// The tool a rule names and its specifier.
export function parseRule(rule: string): { tool: string; spec?: string } | null {
  const m = rule.trim().match(/^([A-Za-z_][\w*-]*)(?:\((.*)\))?$/s);
  return m ? { tool: m[1]!, spec: m[2] } : null;
}

// A command as Keel's matcher sees it: the parsed words, joined (quotes gone).
// Null when it is not one simple command.
function words(cmd: string): string | null {
  const parts = splitCommand(cmd);
  if (!parts || parts.length !== 1 || parts[0]!.redirects) return null;
  const w = parts[0]!.words;
  return w.length && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!) ? w.join(" ") : null;
}

function shell(spec: string | undefined): Mapped {
  if (spec === undefined || spec.trim() === "*") return { kind: "shell", pattern: "*" };
  const s = spec.replace(/\\([()])/g, "$1").trim();
  const stars = (s.match(/\*/g) ?? []).length;
  const prefix = s.match(/^(.*?)(?: \*|:\*)$/s);
  if (prefix && stars === 1) {
    const w = words(prefix[1]!);
    return w ? { kind: "shell", pattern: `${w} *` } : { skip: "it names more than one command (or a redirect): Claude Code matches each part on its own, so the rule never matched as written" };
  }
  if (!stars) {
    const w = words(s);
    return w ? { kind: "shell", pattern: w } : { skip: "it names more than one command (or a redirect): Claude Code matches each part on its own, so the rule never matched as written" };
  }
  // A wildcard inside: the same text only when nothing is quoted (Keel matches the parsed words).
  if (/["'\\]/.test(s)) return { skip: "a wildcard inside quoted text: Keel matches the parsed words, so it would not cover the same commands" };
  const w = words(s.replace(/\*/g, "KEELSTAR"));
  return w ? { kind: "shell", pattern: w.replace(/KEELSTAR/g, "*") } : { skip: "it names more than one command (or a redirect): Claude Code matches each part on its own, so the rule never matched as written" };
}

// An edit rule: a folder and everything below it, written from the root or the home.
// In a project's settings `/path` is from the project's root (`base`).
function edit(spec: string | undefined, base?: string): Mapped {
  if (spec === undefined || spec === "*" || spec === "**") return { kind: "edit", pattern: base ?? "/" };
  const m = spec.match(base ? /^(\/\/|~\/|\/)(.*?)\/\*\*$/ : /^(\/\/|~\/)(.*?)\/\*\*$/);
  if (!m || /[*?[\]!]/.test(m[2]!) || m[2]!.split("/").includes("..")) return { skip: `only a folder written from the root (//path/**)${base ? ", the project (/path/**)" : ""} or the home (~/path/**) maps to Keel's edit rules, which cover a folder and all below it` };
  const dir = m[1] === "//" ? `/${m[2]}` : m[1] === "~/" ? `${homedir()}/${m[2]}` : `${base}/${m[2]}`;
  return { kind: "edit", pattern: dir.replace(/\/+$/, "") || "/" };
}

// One allow rule of Claude Code; `base`, for a project's settings, is its root.
export function claudeAllow(rule: string, base?: string): Mapped {
  const p = parseRule(rule);
  if (!p) return { skip: "not a rule Claude Code reads" };
  if (p.tool === "Bash") return shell(p.spec);
  if (p.tool === "Edit") return edit(p.spec, base);
  if (p.tool === "Write" || p.tool === "NotebookEdit" || p.tool === "MultiEdit") return { skip: `${p.tool} has no rule of its own in Keel: an edit rule would also allow every other edit tool` };
  if (READS.has(p.tool)) return { done: "Keel runs reads and web lookups without asking" };
  const mcp = p.tool.match(/^mcp__([^_*][^*]*?)__([^*]+)$/);
  if (mcp && p.spec === undefined) return { kind: "tool", pattern: `${mcp[1]}__${mcp[2]}` };
  if (p.tool.startsWith("mcp__")) return { skip: "a whole server or a pattern of its tools: Keel's tool rules name one tool" };
  return { skip: `Keel has no rule for ${p.tool}` };
}

// Whether a deny or ask rule of Claude Code can hold a call an allow rule
// would let through, so the allow cannot be carried without its exception
// (Keel's rules only allow). Two rules of one tool overlap unless their
// specifiers can be told apart: two shell rules whose fixed starts (the text
// before any wildcard) neither begins the other, or two edit rules on
// folders neither holds the other. Whatever cannot be told apart overlaps.
// `allowBase`, `heldBase`: the project roots the rules were written in.
export function overlaps(allow: string, held: string, allowBase?: string, heldBase?: string): boolean {
  const a = parseRule(allow), h = parseRule(held);
  if (!a || !h) return true;
  const sameTool = a.tool === h.tool || (h.tool.endsWith("*") && a.tool.startsWith(h.tool.slice(0, -1))) || (h.tool.startsWith("mcp__") && a.tool.startsWith(`${h.tool}__`));
  if (!sameTool) return false;
  if (h.spec === undefined || h.spec.trim() === "*" || a.spec === undefined || a.spec.trim() === "*") return true;
  if (a.tool === "Bash") {
    const head = (spec: string) => {
      const s = spec.replace(/\\([()])/g, "$1").replace(/:\*$/, " *");
      const w = words(s.slice(0, s.indexOf("*") >= 0 ? s.indexOf("*") : s.length).trim());
      return w === null ? null : w.trim();
    };
    const x = head(a.spec), y = head(h.spec);
    if (x === null || y === null || !x || !y) return true;
    const begins = (long: string, short: string) => long === short || long.startsWith(`${short} `) || (!/\s$/.test(short) && long.startsWith(short));
    return begins(x, y) || begins(y, x);
  }
  if (a.tool === "Edit") {
    const x = edit(a.spec, allowBase), y = edit(h.spec, heldBase);
    if (!("kind" in x) || !("kind" in y)) return true;
    const within = (p: string, d: string) => d === "/" || p === d || p.startsWith(`${d}/`);
    return within(x.pattern, y.pattern) || within(y.pattern, x.pattern);
  }
  return true;
}

// A rule the Rust Keel stored (its "always" answers: kind, pattern, scope folder).
export function rustRule(kind: string, pattern: string): Mapped {
  switch (kind) {
    case "shell_prefix": { const w = words(pattern); return w ? { kind: "shell", pattern: `${w} *` } : { skip: "not one simple command" }; }
    case "shell_exact": { const w = words(pattern); return w ? { kind: "shell", pattern: w } : { skip: "not one simple command" }; }
    case "edit_workspace": return { kind: "edit", pattern: "" }; // the scope folder itself
    case "path_write": return pattern.startsWith("/") ? { kind: "edit", pattern } : { skip: "not an absolute folder" };
    case "mcp_tool": return /^[^*]+__[^*]+$/.test(pattern) ? { kind: "tool", pattern } : { skip: "not one tool" };
    case "path_read": case "web_host": return { done: "Keel runs reads and web lookups without asking" };
    case "net_host": return { skip: "Keel's sandbox has network on or off, not per host" };
    case "workspace_trust": return { skip: "Keel asks for trust in each folder itself (its hooks and files run code)" };
    default: return { skip: `Keel has no rule like the Rust Keel's ${kind}` };
  }
}
