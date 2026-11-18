// Agent Skills (SKILL.md folders, the agentskills.io format Claude Code and
// Codex share). The session's system prompt lists each skill's name and
// description once (frozen, so cached); the body loads only when the model
// calls the skill tool, with Claude Code's argument substitution.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { registerHooks } from "../engine/hooks.ts";
import { fail, ok, type Tool, type ToolContext } from "./types.ts";

export type Skill = {
  name: string;
  description: string;
  dir: string;
  file: string;
  scope: "personal" | "project";
  userInvocable: boolean;
  modelInvocable: boolean;
  argumentHint?: string;
  arguments: string[];
};

// Small YAML subset: scalars, quoted strings, [a, b] and "- a" lists, | and > blocks.
export function frontmatter(text: string): { data: Record<string, any>; body: string } {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const lines = text.slice(text.indexOf("\n") + 1, end).split("\n");
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const data: Record<string, any> = {};
  const unq = (v: string) => v.replace(/^(["'])([\s\S]*)\1$/, "$2");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (/^[|>][-+]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!.trim());
      data[key] = raw.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (raw === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) items.push(unq(lines[++i]!.replace(/^\s*-\s+/, "").trim()));
      data[key] = items.length ? items : "";
    } else if (/^\[.*\]$/.test(raw)) data[key] = raw.slice(1, -1).split(",").map((s) => unq(s.trim())).filter(Boolean);
    else if (raw === "true" || raw === "false") data[key] = raw === "true";
    else data[key] = unq(raw.trim());
  }
  return { data, body };
}

function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

// Where skills live: the owner's folders first (they win a name), then the
// project's, from the working directory up to the repository root.
export function skillRoots(cwd: string): { dir: string; scope: Skill["scope"] }[] {
  const home = homedir();
  const roots: { dir: string; scope: Skill["scope"] }[] = [
    { dir: join(home, ".claude/skills"), scope: "personal" },
    { dir: join(home, ".agents/skills"), scope: "personal" },
    { dir: join(home, ".config/keel-bun/skills"), scope: "personal" },
  ];
  const top = gitRoot(cwd) ?? cwd;
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) for (const sub of [".claude/skills", ".agents/skills"]) roots.push({ dir: join(d, sub), scope: "project" });
    if (d === top || dirname(d) === d) break;
  }
  return roots;
}

export function discoverSkills(cwd: string): Skill[] {
  const out = new Map<string, Skill>();
  const seenReal = new Set<string>();
  for (const { dir, scope } of skillRoots(cwd)) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names.sort()) {
      if (n.startsWith(".") || n === "synced") continue;
      const file = join(dir, n, "SKILL.md");
      let real: string;
      try { if (!statSync(file).isFile()) continue; real = realpathSync(file); } catch { continue; }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const { data, body } = frontmatter(text);
      const name = String(data.name || n);
      if (out.has(name) || /[<>​]/.test(name)) continue;
      const desc = [data.description || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "", data.when_to_use || ""]
        .filter(Boolean).join(" ").slice(0, 1536);
      const args = Array.isArray(data.arguments) ? data.arguments : typeof data.arguments === "string" ? data.arguments.split(/\s+/).filter(Boolean) : [];
      out.set(name, {
        name, description: desc, dir: dirname(file), file, scope,
        userInvocable: data["user-invocable"] !== false,
        modelInvocable: data["disable-model-invocation"] !== true,
        argumentHint: data["argument-hint"] || undefined,
        arguments: args,
      });
    }
  }
  return [...out.values()];
}

// Shell-style split: "hello world" second -> [hello world, second].
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(s)); ) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]!));
  return out;
}

// Claude Code's substitution: $ARGUMENTS, $ARGUMENTS[N], $N, $name; an
// argument's own text is never expanded again; \$ escapes; when nothing took
// the arguments they are appended as ARGUMENTS: ...
export function renderSkill(body: string, args: string, names: string[], vars: Record<string, string>): string {
  const list = splitArgs(args);
  let used = false;
  // The placeholder at body[i] (just after a "$"), or null.
  const token = (i: number): { len: number; value: string | undefined; named: boolean } | null => {
    const rest = body.slice(i);
    let m = /^ARGUMENTS\[(\d+)\]/.exec(rest);
    if (m) return { len: m[0].length, value: list[Number(m[1])], named: false };
    if (rest.startsWith("ARGUMENTS")) return { len: 9, value: args, named: false };
    m = /^\d+/.exec(rest);
    if (m) return { len: m[0].length, value: list[Number(m[0])], named: false };
    for (const [k, n] of names.entries()) {
      if (rest.startsWith(n) && !/[\w-]/.test(rest[n.length] ?? "")) return { len: n.length, value: list[k] ?? "", named: true };
    }
    return null;
  };
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\" && body[i + 1] === "\\") { out += "\\\\"; i++; continue; }
    if (c === "\\" && body[i + 1] === "$" && token(i + 2)) { const t = token(i + 2)!; out += "$" + body.slice(i + 2, i + 2 + t.len); i += 1 + t.len; continue; }
    if (c === "$") {
      const t = token(i + 1);
      if (t && t.value !== undefined) { used = true; out += t.value; i += t.len; continue; }
    }
    out += c;
  }
  out = out.replace(/\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|KEEL_SKILL_DIR|KEEL_SESSION_ID)\}/g, (all, k) => vars[k] ?? all);
  if (args.trim() && !used) out = `${out.trimEnd()}\n\nARGUMENTS: ${args}`;
  return out;
}

const loaded = new Map<string, Set<string>>(); // session -> rendered texts already sent

export function loadSkill(name: string, args: string, ctx: ToolContext) {
  const skill = discoverSkills(ctx.cwd).find((s) => s.name === name || s.name === name.replace(/^\//, ""));
  if (!skill) {
    const names = discoverSkills(ctx.cwd).filter((s) => s.modelInvocable).map((s) => s.name);
    return fail(`No skill named "${name}". Available: ${names.join(", ") || "none"}.`);
  }
  if (!skill.modelInvocable) return fail(`The skill "${skill.name}" is only for the owner to invoke.`);
  const { body } = frontmatter(readFileSync(skill.file, "utf8"));
  const text = renderSkill(body, args ?? "", skill.arguments, {
    CLAUDE_SKILL_DIR: skill.dir, KEEL_SKILL_DIR: skill.dir, CLAUDE_PROJECT_DIR: gitRoot(ctx.cwd) ?? ctx.cwd,
    CLAUDE_SESSION_ID: ctx.sessionId, KEEL_SESSION_ID: ctx.sessionId,
  });
  const sent = loaded.get(ctx.sessionId) ?? new Set();
  loaded.set(ctx.sessionId, sent);
  if (sent.has(text)) return ok(`The skill "${skill.name}" is already loaded above; follow it.`);
  sent.add(text);
  return ok(`Base directory for this skill: ${skill.dir}\n\n${text.trim()}`);
}

// The listing: every name, descriptions while they fit the budget.
const LISTING_BUDGET = 8_000;
export function skillListing(cwd: string): string {
  const skills = discoverSkills(cwd).filter((s) => s.modelInvocable);
  if (!skills.length) return "";
  let used = 0;
  const lines = skills.map((s) => {
    const d = s.description.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ");
    const line = `- ${s.name}: ${d}`;
    if (used + line.length > LISTING_BUDGET) return `- ${s.name}`;
    used += line.length;
    return line;
  });
  return `Skills you can load with the skill tool when a task matches one (the body comes back as its result):\n${lines.join("\n")}`;
}

registerHooks({ system: (s) => skillListing(s.workspace) });

export const skillTool = (name: string, nameKey: string, argsKey: string | null, description?: string): Tool => ({
  name,
  readOnly: true,
  description: description ?? "Load a skill listed in the system prompt by name. Its instructions come back as the result; follow them.",
  input_schema: {
    type: "object",
    properties: {
      [nameKey]: { type: "string", description: "The skill name" },
      ...(argsKey ? { [argsKey]: { type: "string", description: "Optional arguments for the skill" } } : {}),
    },
    required: [nameKey],
    additionalProperties: false,
  },
  run: async (input, ctx) => loadSkill(String(input[nameKey] ?? ""), argsKey ? String(input[argsKey] ?? "") : "", ctx),
});
