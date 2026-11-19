// Agent Skills (SKILL.md folders, the agentskills.io format Claude Code and
// Codex share). The session's system prompt lists each skill's name and
// description once (frozen, so cached); the body loads only when the model
// calls the skill tool, with Claude Code's argument substitution.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configDir } from "../providers/config.ts";
import { registerHooks } from "../engine/hooks.ts";
import { fail, ok, type Tool, type ToolContext } from "./types.ts";
import { SessionMap } from "../core/session-map.ts";

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
  kind: "skill" | "command"; // a SKILL.md folder, or a command file (<name>.md)
  root: string; // the folder it was found in (~/.claude/skills, <repo>/.agents/skills)
  enabled: boolean; // the owner can turn a skill off without deleting it
};

// Skills the owner turned off, by name: <config>/skills.json { "off": [...] }.
const offFile = () => join(configDir(), "skills.json");
export function skillsOff(): Set<string> {
  try { return new Set((JSON.parse(readFileSync(offFile(), "utf8")).off ?? []).map(String)); } catch { return new Set(); }
}
export function setSkillOff(name: string, off: boolean) {
  const set = skillsOff();
  if (off) set.add(name); else set.delete(name);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(offFile(), JSON.stringify({ off: [...set].sort() }, null, 2) + "\n");
}

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
    { dir: join(configDir(), "skills"), scope: "personal" },
  ];
  const top = gitRoot(cwd) ?? cwd;
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) for (const sub of [".claude/skills", ".agents/skills"]) roots.push({ dir: join(d, sub), scope: "project" });
    if (d === top || dirname(d) === d) break;
  }
  return roots;
}

// A feature may hold back a repository's skill (one changed since it was trusted).
export const skillFilter: { allow?: (dir: string) => boolean } = {};

// Other harnesses install their built-in skills into the shared personal
// folders (~/.agents/skills): skills that drive that harness's own product,
// settings or tools, which Keel cannot run. A personal skill is left out when
// its name or description names such a product, or its body uses that
// harness's own config folder or tool names. Project skills always load.
const FOREIGN_TITLE = /\b(codex|cursor|bugbot)\b/i;
const FOREIGN_BODY = /(^|[\s"'`(~/])\.(cursor|codex)\/|\bcursor-[a-z]+-[a-z_-]+|<\/?cursor-[a-z]/m;
export const foreignSkill = (name: string, description: string, body: string) =>
  FOREIGN_TITLE.test(`${name} ${description}`) || FOREIGN_BODY.test(body);

// Command files, the older form of a skill Claude Code still reads
// (<folder>/<name>.md, the same frontmatter): the owner's, then the
// project's from the working directory up to the repository root.
export function commandRoots(cwd: string): { dir: string; scope: Skill["scope"] }[] {
  const home = homedir();
  const roots: { dir: string; scope: Skill["scope"] }[] = [
    { dir: join(home, ".claude/commands"), scope: "personal" },
    { dir: join(configDir(), "commands"), scope: "personal" },
  ];
  const top = gitRoot(cwd) ?? cwd;
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) roots.push({ dir: join(d, ".claude/commands"), scope: "project" });
    if (d === top || dirname(d) === d) break;
  }
  return roots;
}

export function discoverSkills(cwd: string): Skill[] {
  const out = new Map<string, Skill>();
  const off = skillsOff();
  const seenReal = new Set<string>();
  // `held` is what the trust pin decides on: a skill's folder, a command's file.
  const add = (file: string, held: string, fallback: string, root: string, scope: Skill["scope"], kind: Skill["kind"]) => {
    let real: string;
    try { if (!statSync(file).isFile()) return; real = realpathSync(file); } catch { return; }
    if (seenReal.has(real)) return;
    if (scope === "project" && skillFilter.allow && !skillFilter.allow(held)) return;
    seenReal.add(real);
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { return; }
    const { data, body } = frontmatter(text);
    const name = String((kind === "skill" && data.name) || fallback);
    if (out.has(name) || /[<>​]/.test(name)) return;
    const desc = [data.description || body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") || "", data.when_to_use || ""]
      .filter(Boolean).join(" ").slice(0, 1536);
    if (scope === "personal" && foreignSkill(name, desc, body)) return;
    const args = Array.isArray(data.arguments) ? data.arguments : typeof data.arguments === "string" ? data.arguments.split(/\s+/).filter(Boolean) : [];
    out.set(name, {
      name, description: desc, dir: dirname(file), file, scope, kind,
      userInvocable: data["user-invocable"] !== false,
      modelInvocable: data["disable-model-invocation"] !== true,
      argumentHint: data["argument-hint"] || undefined,
      arguments: args,
      root,
      enabled: !off.has(name),
    });
  };
  const list = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
  for (const { dir, scope } of skillRoots(cwd)) {
    for (const n of list(dir)) if (!n.startsWith(".") && n !== "synced") add(join(dir, n, "SKILL.md"), join(dir, n), n, dir, scope, "skill");
  }
  // A skill wins a name over a command file, as in Claude Code.
  for (const { dir, scope } of commandRoots(cwd)) {
    for (const n of list(dir)) if (n.endsWith(".md") && !n.startsWith(".")) add(join(dir, n), join(dir, n), n.slice(0, -3), dir, scope, "command");
  }
  // By name: the listing in the shared, cached prompt prefix stays byte-stable.
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

// session -> rendered texts already sent; a session that dropped out gets a skill's text once more.
const loaded = new SessionMap<Set<string>>(64);

export function loadSkill(name: string, args: string, ctx: ToolContext) {
  const skill = discoverSkills(ctx.cwd).filter((s) => s.enabled).find((s) => s.name === name || s.name === name.replace(/^\//, ""));
  if (!skill) {
    const names = discoverSkills(ctx.cwd).filter((s) => s.modelInvocable && s.enabled).map((s) => s.name);
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

// The owner invoking a skill from the message box: same rendering, and skills
// hidden from the model are allowed; ones marked not user-invocable are not.
export function renderForOwner(name: string, args: string, cwd: string, sessionId: string): { skill: Skill; text: string } | { error: string } {
  const skill = discoverSkills(cwd).find((s) => s.name === name);
  if (!skill) return { error: `no skill named ${name}` };
  if (!skill.userInvocable) return { error: `${name} is not meant to be invoked by hand` };
  if (!skill.enabled) return { error: `${name} is turned off in Settings > Skills` };
  const { body } = frontmatter(readFileSync(skill.file, "utf8"));
  const text = renderSkill(body, args, skill.arguments, {
    CLAUDE_SKILL_DIR: skill.dir, KEEL_SKILL_DIR: skill.dir, CLAUDE_PROJECT_DIR: gitRoot(cwd) ?? cwd,
    CLAUDE_SESSION_ID: sessionId, KEEL_SESSION_ID: sessionId,
  });
  return { skill, text: `Base directory for this skill: ${skill.dir}\n\n${text.trim()}` };
}

// The listing: every name, descriptions while they fit the budget.
const LISTING_BUDGET = 8_000;
export function skillListing(cwd: string): string {
  const skills = discoverSkills(cwd).filter((s) => s.modelInvocable && s.enabled);
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
