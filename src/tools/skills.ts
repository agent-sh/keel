// Agent Skills (SKILL.md folders, the agentskills.io format Claude Code and
// Codex share). The session's system prompt lists each skill's name and
// description once (frozen, so cached); the body loads only when the model
// calls the skill tool, with Claude Code's argument substitution.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "../providers/config.ts";
import { writeOwnFile } from "../core/ownfile.ts";
import { registerHooks, type SystemBlock } from "../engine/hooks.ts";
import { enabledUnits, unitOf } from "../plugins/registry.ts";
import { fillContent } from "../plugins/options.ts";
import { foreignSkill, frontmatter, skillDescription } from "./skill-text.ts";
export { foreignSkill, frontmatter };
import { valuesOf } from "../plugins/settings.ts";
import { claudeAllow } from "../integrations/port-permissions.ts";
import type { RuleKind } from "../safety/policy.ts";
import { fail, ok, type Tool, type ToolContext, type ToolOutput } from "./types.ts";
import { offerToSandbox } from "../safety/sandbox-view.ts";
import { holdChoice } from "./skill-turn.ts";
import { contains } from "../core/paths.ts";
import { yamlWithin } from "../core/yaml-bound.ts";
import { homeDir } from "../core/paths";

export type Skill = {
  name: string;
  description: string;
  dir: string;
  file: string;
  scope: "personal" | "project" | "plugin";
  userInvocable: boolean;
  modelInvocable: boolean;
  argumentHint?: string;
  arguments: string[];
  kind: "skill" | "command"; // a SKILL.md folder, or a command file (<name>.md)
  root: string; // the folder it was found in (~/.claude/skills, <repo>/.agents/skills)
  enabled: boolean; // the owner can turn a skill off without deleting it
  data?: string; // a plugin's folder that outlives its updates (${CLAUDE_PLUGIN_DATA})
  plugin?: string; // the installed plugin it came with
  // Claude Code's frontmatter for how it runs (code.claude.com/docs/en/skills):
  allowedTools?: string[]; // run without asking in the turn that invoked it
  model?: string;          // the model the rest of the turn runs on (with context: fork, the agent's)
  effort?: string;         // the effort the rest of the turn runs at (with context: fork, the agent's)
  disallowed?: string[];   // tools that do not run for the rest of the turn (with context: fork, in the agent)
  fork?: { agent?: string; background: boolean }; // context: fork: it runs as an agent of its own
};

// A list field as Claude Code takes it: a YAML list, or one string split at spaces and commas
// (outside a rule's parentheses: "Bash(git add *) Read" is two).
export function listField(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((x) => x.trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  const out: string[] = [];
  let cur = "", depth = 0;
  for (const c of v) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (!depth && (c === " " || c === ",")) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// <config>/skills.json: the skills the owner turned off, by name ("off"), the
// other folders Keel reads skills from ("roots", e.g. Codex's), and the Claude
// Code plugins whose skills, commands and agents Keel carries ("plugins": the
// id and Claude Code's folder; the install path is looked up on each read, so
// a plugin update is followed). `keel port` writes the last two.
export type SkillRoot = { dir: string; label?: string; nested?: boolean; exclude?: string[] };
export type PluginRef = { id: string; claude: string };
export type SkillsConfig = { off?: string[]; roots?: SkillRoot[]; plugins?: PluginRef[] };
const offFile = () => join(configDir(), "skills.json");
export function skillsConfig(): SkillsConfig {
  try { const c = JSON.parse(readFileSync(offFile(), "utf8")); return c && typeof c === "object" ? c : {}; } catch { return {}; }
}
export function writeSkillsConfig(c: SkillsConfig) {
  writeOwnFile(offFile(), JSON.stringify(c, null, 2) + "\n");
}
export function skillsOff(): Set<string> {
  return new Set((skillsConfig().off ?? []).map(String));
}
export function setSkillOff(name: string, off: boolean) {
  const c = skillsConfig();
  const set = new Set((c.off ?? []).map(String));
  if (off) set.add(name); else set.delete(name);
  writeSkillsConfig({ ...c, off: [...set].sort() });
}

// A carried plugin's folder now: Claude Code's installed_plugins.json (v2:
// { plugins: { "<name>@<marketplace>": [{ scope, installPath }] } }), the
// user-scope install first. Null when it is no longer installed.
export function pluginDir(p: PluginRef): { name: string; dir: string } | null {
  try {
    const all = JSON.parse(readFileSync(join(p.claude, "plugins", "installed_plugins.json"), "utf8")).plugins?.[p.id];
    const hit = (Array.isArray(all) ? all : []).sort((a: any, b: any) => (a.scope === "user" ? -1 : 0) - (b.scope === "user" ? -1 : 0))[0];
    if (!hit?.installPath || !existsSync(hit.installPath)) return null;
    return { name: p.id.split("@")[0]!, dir: hit.installPath };
  } catch {
    return null;
  }
}
export const carriedPlugins = () => (skillsConfig().plugins ?? []).map(pluginDir).filter((x): x is { name: string; dir: string } => !!x);

function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

// Where skills live: the owner's folders first (they win a name), then the
// project's, from the working directory up to the repository root.
// The walk up from the folder ends at the repository's root, or at `stop` when that is nearer (a machine
// serving its skills to another walks no higher than the directory it granted).
function topOf(cwd: string, stop?: string): string {
  const g = gitRoot(cwd) ?? cwd;
  return stop && !contains(stop, g) ? stop : g;
}

export function skillRoots(cwd: string, stop?: string): { dir: string; scope: Skill["scope"] }[] {
  const home = homeDir();
  const roots: { dir: string; scope: Skill["scope"] }[] = [
    { dir: join(home, ".claude/skills"), scope: "personal" },
    { dir: join(home, ".agents/skills"), scope: "personal" },
    { dir: join(configDir(), "skills"), scope: "personal" },
  ];
  const top = topOf(cwd, stop);
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) for (const sub of [".claude/skills", ".agents/skills"]) roots.push({ dir: join(d, sub), scope: "project" });
    if (d === top || dirname(d) === d) break;
  }
  return roots;
}

// The owner's own skill and command folders are what a session is told to
// read and run from: a sandboxed command sees them, read-only (the project's
// are in the workspace already).
offerToSandbox(() => [
  join(homeDir(), ".claude/skills"), join(homeDir(), ".agents/skills"), join(configDir(), "skills"), join(homeDir(), ".claude/commands"), join(configDir(), "commands"),
  // The other folders the owner had Keel read skills from, and the plugins it carries.
  ...(skillsConfig().roots ?? []).map((r) => r.dir).filter((d): d is string => typeof d === "string" && d.startsWith("/")),
  ...carriedPlugins().map((p) => p.dir),
]);

// A feature may hold back a repository's skill (one changed since it was trusted).
// `ownerTrusted`: the owner pinned that repository skill himself (not on first sight).
// `ownerDigest`: the digest he pinned it at, while it is still that; `digest`: its digest now (src/safety/trust.ts).
// `held`: why a repository's skill the filter holds back does not load, said to the model that asks for it.
export const skillFilter: { allow?: (dir: string) => boolean; held?: (dir: string) => string | null; ownerTrusted?: (dir: string) => boolean; ownerDigest?: (dir: string) => string | null; digest?: (dir: string) => string | null } = {};

// Whether a skill's allowed-tools may run without asking: the owner's own
// skills and his plugins' do; a repository's only once the owner trusted that
// skill himself, as it is now. A repository's skill is the repository's
// words: a clone must not grant itself the shell by being loaded.
export function mayGrant(skill: Skill): boolean {
  if (skill.scope !== "project") return true;
  return !!skillFilter.ownerTrusted?.(skill.kind === "command" ? skill.file : skill.dir);
}

// Command files, the older form of a skill Claude Code still reads
// (<folder>/<name>.md, the same frontmatter): the owner's, then the
// project's from the working directory up to the repository root.
export function commandRoots(cwd: string, stop?: string): { dir: string; scope: Skill["scope"] }[] {
  const home = homeDir();
  const roots: { dir: string; scope: Skill["scope"] }[] = [
    { dir: join(home, ".claude/commands"), scope: "personal" },
    { dir: join(configDir(), "commands"), scope: "personal" },
  ];
  const top = topOf(cwd, stop);
  for (let d = cwd; ; d = dirname(d)) {
    if (d !== home) roots.push({ dir: join(d, ".claude/commands"), scope: "project" });
    if (d === top || dirname(d) === d) break;
  }
  return roots;
}

// What a skill's own frontmatter says it may do and how it runs: the one reading of it, used for a skill
// found on this machine and for one of another machine (taken from its text there, never from that
// machine's account of it).
export function frontFields(data: Record<string, any>): Pick<Skill, "userInvocable" | "modelInvocable" | "allowedTools" | "model" | "effort" | "disallowed" | "fork"> {
  return {
    userInvocable: data["user-invocable"] !== false,
    modelInvocable: data["disable-model-invocation"] !== true,
    ...(listField(data["allowed-tools"]).length ? { allowedTools: listField(data["allowed-tools"]) } : {}),
    ...(typeof data.model === "string" && data.model.trim() && data.model.trim() !== "inherit" ? { model: data.model.trim() } : {}),
    ...(typeof data.effort === "string" && data.effort.trim() ? { effort: data.effort.trim().toLowerCase() } : {}),
    ...(listField(data["disallowed-tools"]).length ? { disallowed: listField(data["disallowed-tools"]) } : {}),
    ...(data.context === "fork" ? { fork: { ...(typeof data.agent === "string" && data.agent.trim() ? { agent: data.agent.trim() } : {}), background: data.background !== false } } : {}),
  };
}

// `heldBack`: the repository skills the filter holds back are added to it, by the name they would have.
export function discoverSkills(cwd: string, heldBack?: { name: string; dir: string }[], stop?: string): Skill[] {
  const out = new Map<string, Skill>();
  const off = skillsOff();
  const seenReal = new Set<string>();
  // `held` is what the trust pin decides on: a skill's folder, a command's file.
  const add = (file: string, held: string, fallback: string, root: string, scope: Skill["scope"], kind: Skill["kind"], prefix = "", chosen = false, unit?: { id: string; data: string }) => {
    let real: string;
    try { if (!statSync(file).isFile()) return; real = realpathSync(file); } catch { return; }
    if (seenReal.has(real)) return;
    if (scope === "project" && skillFilter.allow && !skillFilter.allow(held)) {
      if (heldBack) { try { heldBack.push({ name: prefix + String((kind === "skill" && frontmatter(readFileSync(file, "utf8")).data.name) || fallback), dir: held }); } catch {} }
      return;
    }
    seenReal.add(real);
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { return; }
    const { data, body } = frontmatter(text);
    const name = prefix + String((kind === "skill" && data.name) || fallback);
    if (out.has(name) || /[<>​]/.test(name)) return;
    const desc = skillDescription(data, body);
    // A folder the owner chose (another harness's skills, a plugin) keeps every skill it holds.
    if (scope === "personal" && !chosen && foreignSkill(name, desc, body)) return;
    const args = Array.isArray(data.arguments) ? data.arguments : typeof data.arguments === "string" ? data.arguments.split(/\s+/).filter(Boolean) : [];
    out.set(name, {
      name, description: desc, dir: dirname(file), file, scope, kind,
      argumentHint: data["argument-hint"] || undefined,
      arguments: args,
      root,
      enabled: !off.has(name),
      ...(unit ? { data: unit.data, plugin: unit.id } : {}),
      ...frontFields(data),
    });
  };
  const list = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
  const roots = skillRoots(cwd, stop);
  const own = roots.filter((r) => r.scope === "personal");
  const cfg = skillsConfig();
  for (const { dir, scope } of own) {
    for (const n of list(dir)) if (!n.startsWith(".") && n !== "synced") add(join(dir, n, "SKILL.md"), join(dir, n), n, dir, scope, "skill");
  }
  // Folders the owner added (another harness's skills): a skill folder, or a
  // category folder of them (Hermes keeps skills by category), minus the
  // names the root leaves out.
  for (const r of cfg.roots ?? []) {
    const skip = new Set(r.exclude ?? []);
    const walk = (dir: string, depth: number) => {
      for (const n of list(dir)) {
        if (n.startsWith(".") || skip.has(n)) continue;
        const d = join(dir, n);
        if (existsSync(join(d, "SKILL.md"))) add(join(d, "SKILL.md"), d, n, r.dir, "personal", "skill", "", true);
        else if (r.nested && depth < 3) walk(d, depth + 1);
      }
    };
    walk(r.dir, 0);
  }
  // The plugins Keel installed, while they are enabled, then the Claude Code
  // plugins the owner carried: <plugin>:<skill>, as Claude Code names them.
  const units = enabledUnits();
  for (const u of units) for (const k of u.skills) add(join(k.dir, "SKILL.md"), k.dir, basename(k.dir), u.dir, "plugin", "skill", `${u.id}:`, true, u);
  for (const p of carriedPlugins()) {
    for (const n of list(join(p.dir, "skills"))) if (!n.startsWith(".")) add(join(p.dir, "skills", n, "SKILL.md"), join(p.dir, "skills", n), n, p.dir, "plugin", "skill", `${p.name}:`);
  }
  for (const { dir, scope } of roots.filter((r) => r.scope !== "personal")) {
    for (const n of list(dir)) if (!n.startsWith(".") && n !== "synced") add(join(dir, n, "SKILL.md"), join(dir, n), n, dir, scope, "skill");
  }
  // A skill wins a name over a command file, as in Claude Code.
  for (const { dir, scope } of commandRoots(cwd, stop)) {
    for (const n of list(dir)) if (n.endsWith(".md") && !n.startsWith(".")) add(join(dir, n), join(dir, n), n.slice(0, -3), dir, scope, "command");
  }
  for (const u of units) for (const c of u.commands) add(c.file, c.file, c.name, u.dir, "plugin", "command", `${u.id}:`, true, u);
  for (const p of carriedPlugins()) {
    for (const n of list(join(p.dir, "commands"))) if (n.endsWith(".md") && !n.startsWith(".")) add(join(p.dir, "commands", n), join(p.dir, "commands", n), n.slice(0, -3), p.dir, "plugin", "command", `${p.name}:`);
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
  out = out.replace(/\$\{(CLAUDE_SKILL_DIR|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|KEEL_SKILL_DIR|KEEL_SESSION_ID)\}/g, (all, k) => vars[k] ?? all);
  // A plugin's settings (src/plugins/options.ts): a plain value, or the placeholder of a sensitive one.
  out = out.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, k) => vars[`user_config.${k}`] ?? all);
  if (args.trim() && !used) out = `${out.trimEnd()}\n\nARGUMENTS: ${args}`;
  return out;
}

// What ${...} stands for in a skill's text and in its allowed-tools rules.
function varsOf(skill: Skill, cwd: string, sessionId: string): Record<string, string> {
  return {
    CLAUDE_SKILL_DIR: skill.dir, KEEL_SKILL_DIR: skill.dir, ...(skill.scope === "plugin" ? { CLAUDE_PLUGIN_ROOT: skill.root, ...(skill.data ? { CLAUDE_PLUGIN_DATA: skill.data } : {}) } : {}), CLAUDE_PROJECT_DIR: gitRoot(cwd) ?? cwd,
    CLAUDE_SESSION_ID: sessionId, KEEL_SESSION_ID: sessionId,
    ...(skill.scope === "plugin" && skill.plugin ? settingVars(skill.plugin) : {}),
  };
}

// ${user_config.KEY} of a plugin's skill: each setting as fillContent gives it (a sensitive one is never its value).
function settingVars(id: string): Record<string, string> {
  const u = unitOf(id);
  if (!u?.options) return {};
  const { specs, text } = valuesOf(u);
  return Object.fromEntries(Object.keys(specs).map((k) => [`user_config.${k}`, fillContent(`\${user_config.${k}}`, specs, text)]));
}

// A skill's allowed-tools as Keel's rules: each one maps as a Claude Code
// allow rule does (src/integrations/port-permissions.ts), with the skill's
// variables filled in (Claude Code does so in Bash rules). A write tool is an
// edit rule (Keel has one rule for every edit tool). Reads need no rule. What
// cannot be held the same way is named, never widened.
export function skillRules(skill: Skill, vars: Record<string, string>): { rules: { kind: RuleKind; pattern: string }[]; left: string[] } {
  const rules: { kind: RuleKind; pattern: string }[] = [];
  const left: string[] = [];
  for (const raw of skill.allowedTools ?? []) {
    const rule = raw.replace(/\$\{([A-Z_]+)\}/g, (m, k) => vars[k] ?? m).replace(/^(Write|MultiEdit|NotebookEdit)\b/, "Edit");
    const m = claudeAllow(rule, vars.CLAUDE_PROJECT_DIR);
    if ("kind" in m) rules.push({ kind: m.kind, pattern: m.pattern });
    else if ("skip" in m) left.push(`${raw} (${m.skip})`);
  }
  return { rules, left };
}

// Where the daemon gives a skill what it asks for beyond its text: a turn's
// grant of its allowed-tools (the permission gate), and an agent of its own
// for one with context: fork (the agents). Unset, a skill loads as text alone.
export const skillRun: {
  grant?: (sessionId: string, rules: { kind: RuleKind; pattern: string }[], from: string, next: boolean, cmd?: string) => void;
  drop?: (sessionId: string) => void;
  fork?: (ctx: ToolContext, skill: Skill, prompt: string) => Promise<ToolOutput>;
  // Registers the hooks of a skill's frontmatter for the session (src/integrations/hooks.ts, Skills).
  hooks?: (sessionId: string, skill: { name: string; scope: Skill["scope"]; dir: string; file: string }, hooks: unknown) => { events: string[]; problems: string[]; notes: string[]; held?: string };
} = {};

// A skill's frontmatter hooks: nested YAML (events, matchers, handlers), which the small reader
// above does not take, so the frontmatter is read again as YAML when it names hooks.
export function hooksOf(text: string): { hooks?: Record<string, unknown>; problem?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m || !/^hooks\s*:/m.test(m[1]!)) return {};
  // Within what Keel shows of a hooks file whole (SHOWN_MAX in src/integrations/hooks.ts), aliases counted.
  const y = yamlWithin(m[1]!, HOOKS_SHOWN_MAX);
  if ("problem" in y) return { problem: `its frontmatter: ${y.problem}` };
  const h = (y.value as any)?.hooks;
  if (h === undefined || h === null || h === "") return {};
  return h && typeof h === "object" && !Array.isArray(h) ? { hooks: h } : { problem: "its hooks are not a map of events" };
}
const HOOKS_SHOWN_MAX = 400_000;

// The hooks a skill registers when it is invoked, said back with its text.
function hooksSaid(skill: Skill, text: string, sessionId: string): string {
  const { hooks, problem } = hooksOf(text);
  if (problem) return `Its hooks are not registered: ${problem}.`;
  if (!hooks) return "";
  if (!skillRun.hooks) return "Its hooks are not registered: nothing here runs them.";
  const r = skillRun.hooks(sessionId, { name: skill.name, scope: skill.scope, dir: skill.kind === "command" ? skill.file : skill.dir, file: skill.file }, hooks);
  const out: string[] = [];
  if (r.events.length) out.push(r.held ? `Its hooks (${r.events.join(", ")}) are kept for this session and run none yet: ${r.held}.` : `Its hooks (${r.events.join(", ")}) run for the rest of this session.`);
  if (r.problems.length) out.push(`Of its hooks, these are not taken: ${r.problems.join("; ")}.`);
  if (r.notes.length) out.push(`${r.notes.join("; ")}.`);
  return out.join(" ");
}

// What a skill's frontmatter did besides its text, said with it (to the model
// or the owner): which of its allowed-tools run without asking, and which ask.
function said(skill: Skill, granted: string[], left: string[], held?: string, hooks = ""): string {
  const out: string[] = [];
  if (!skill.fork && skill.disallowed?.length) out.push(`For the rest of this turn these do not run, as the skill's disallowed-tools say: ${skill.disallowed.join(", ")}.`);
  if (hooks) out.push(hooks);
  if (granted.length) out.push(`For this turn these run without asking, as the skill's allowed-tools say: ${granted.join(", ")}.`);
  if (held && skill.allowedTools?.length) out.push(`Its allowed-tools (${skill.allowedTools.join(", ")}) ask as usual: ${held}.`);
  if (left.length) out.push(`Its allowed-tools Keel cannot hold the same way, so they ask as usual: ${left.join("; ")}.`);
  if (!skill.fork && (skill.model || skill.effort)) out.push(`The rest of this turn runs ${[skill.model && `on the model it names (${skill.model})`, skill.effort && `at effort ${skill.effort}`].filter(Boolean).join(" ")}, as far as that model is listed and lists that effort; the session's own come back with the owner's next message.`);
  return out.length ? `\n\n[keel] ${out.join(" ")}` : "";
}

// The model and effort an inline skill names for the rest of its turn (src/tools/skill-turn.ts).
const choiceOf = (skill: Skill) => ({ ...(skill.model ? { model: skill.model } : {}), ...(skill.effort ? { effort: skill.effort } : {}), ...(skill.disallowed ? { disallowed: skill.disallowed } : {}) });

// The grant a skill makes, or why it makes none.
const NOT_TRUSTED = "it is this repository's own skill, and its tools run without asking only once the owner trusts it himself (the session's Trust panel)";
function grantOf(skill: Skill, vars: Record<string, string>, grantable = mayGrant(skill), why = NOT_TRUSTED): { rules: { kind: RuleKind; pattern: string }[]; granted: string[]; left: string[]; held?: string } {
  if (!skill.allowedTools?.length) return { rules: [], granted: [], left: [] };
  if (!grantable) return { rules: [], granted: [], left: [], held: why };
  if (!skillRun.grant) return { rules: [], granted: [], left: [], held: "nothing here grants them" };
  const { rules, left } = skillRules(skill, vars);
  const leftNames = new Set(left.map((l) => l.slice(0, l.indexOf(" (")).trim()));
  return { rules, granted: skill.allowedTools.filter((t) => !leftNames.has(t)), left };
}

// Skills of a session whose tools run on another machine come from that
// machine (src/fleet/skills.ts is the link to it): this machine's skills name
// files and commands that are not where the session's commands run, and a
// local-only skill must not be offered there. `of` answers null for a session
// on this machine.
export type SkillHome = {
  machine: string; // its name, as the owner sees it
  id: string; // what the owner's trust of its skills is kept under (a rename keeps it, a machine paired again loses it)
  list(): Promise<{ skills: Skill[] } | { error: string }>;
  get(name: string): Promise<PeerSkill | { missing: { names: string[]; held?: string } } | { error: string }>;
};
export const skillHome: { of?: (sessionId: string) => SkillHome | null } = {};
// A skill as the machine that holds it read it: its text and the variables of its text.
// What it may do on this machine is decided here, never by that machine.
export type PeerSkill = { skill: Skill; raw: string; vars: Record<string, string> };

// A skill of another machine grants nothing here, ever: its allowed-tools are shown and ask as usual,
// its model, effort and fork are never taken and its hooks are never registered. What this machine
// would grant to it is not a thing a machine can be asked.
const peerHeld = (machine: string) => `its tools ask: it is on ${machine}`;

// What a machine serves of its skills to a session placed on it (the hands routes): what it
// discovers for the folder, under its own trust and scan rules, and a skill's text with its variables.
// `stop`: the directory it granted: the folder's own skills are read from it and below, no higher.
export function servedSkills(cwd: string, stop?: string): Skill[] {
  return discoverSkills(cwd, undefined, stop).filter((s) => s.enabled);
}
export function servedSkill(cwd: string, name: string, sessionId: string, stop?: string): PeerSkill | { missing: { names: string[]; held?: string } } {
  const want = (n: string) => n === name || n === name.replace(/^\//, "");
  const skill = discoverSkills(cwd, undefined, stop).filter((s) => s.enabled).find((s) => want(s.name));
  if (!skill) {
    const heldBack: { name: string; dir: string }[] = [];
    const names = discoverSkills(cwd, heldBack, stop).filter((s) => s.modelInvocable && s.enabled).map((s) => s.name);
    const held = heldBack.find((h) => want(h.name));
    return { missing: { names, ...(held ? { held: heldText(held) } : {}) } };
  }
  return { skill, raw: readFileSync(skill.file, "utf8"), vars: varsOf(skill, cwd, sessionId) };
}
const heldText = (h: { name: string; dir: string }) => `The skill "${h.name}" is this repository's and does not load: ${(skillFilter.held?.(h.dir) ?? "the owner has not trusted it").replace(/\.?$/, ".")}`;

// A skill found for a session: here, or on the machine its tools run on.
// `held`: why its allowed-tools ask (a skill of another machine).
type Found = PeerSkill & { grantable: boolean; machine?: string; held?: string };

// A skill of another machine as this one takes it. Its text and variables are the machine's own. What
// the text says (allowed-tools to show, disallowed-tools, who may invoke it) is read here, from the
// text, by the same reading as a skill on this machine; the machine's own account of those fields is
// never used. Nothing it names raises what runs unasked, or steers the turn: no grant, no model, no
// effort, no fork.
export function adoptPeer(home: { machine: string; id: string }, r: PeerSkill): Found {
  const { allowedTools, disallowed, userInvocable, modelInvocable } = frontFields(frontmatter(r.raw).data);
  const skill: Skill = { ...r.skill, userInvocable, modelInvocable, model: undefined, effort: undefined, fork: undefined, allowedTools: undefined, disallowed: undefined,
    ...(allowedTools ? { allowedTools } : {}), ...(disallowed ? { disallowed } : {}) };
  for (const k of ["model", "effort", "fork", "allowedTools", "disallowed"] as const) if (skill[k] === undefined) delete skill[k];
  return { ...r, skill, grantable: false, machine: home.machine, held: peerHeld(home.machine) };
}
async function findSkill(ctx: { sessionId: string; cwd: string }, name: string): Promise<{ found: Found } | { error: string }> {
  const home = skillHome.of?.(ctx.sessionId);
  if (home) {
    const r = await home.get(name);
    if ("error" in r) return { error: `The skills on ${home.machine}, where this session's tools run, could not be read: ${r.error}. None are offered; this machine's skills are not used there.` };
    if ("missing" in r) return { error: r.missing.held ?? `No skill named "${name}" on ${home.machine}. Available: ${r.missing.names.join(", ") || "none"}.` };
    return { found: adoptPeer(home, r) };
  }
  const want = (n: string) => n === name || n === name.replace(/^\//, "");
  const skill = discoverSkills(ctx.cwd).filter((s) => s.enabled).find((s) => want(s.name));
  if (!skill) {
    const heldBack: { name: string; dir: string }[] = [];
    const names = discoverSkills(ctx.cwd, heldBack).filter((s) => s.modelInvocable && s.enabled).map((s) => s.name);
    // A repository's skill held back by its trust: the model is told why, not that it does not exist.
    const held = heldBack.find((h) => want(h.name));
    if (held) return { error: heldText(held) };
    return { error: `No skill named "${name}". Available: ${names.join(", ") || "none"}.` };
  }
  return { found: { skill, raw: readFileSync(skill.file, "utf8"), vars: varsOf(skill, ctx.cwd, ctx.sessionId), grantable: mayGrant(skill) } };
}

// The hooks a skill of another machine names are not registered here: they run commands on this machine.
function peerHooksSaid(raw: string, machine: string, vars: Record<string, string> = {}): string {
  const { hooks, problem } = hooksOf(raw);
  // The variables are the machine's: they name its paths, and are put into the skill's text only.
  const known = Object.keys(vars).filter((k) => /^(CLAUDE_SKILL_DIR|KEEL_SKILL_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|KEEL_SESSION_ID|user_config\.[A-Za-z0-9_.-]{1,64})$/.test(k));
  const said = known.length ? ` Its variables (${known.join(", ")}) are those of ${machine}, put into its text only.` : "";
  if (problem) return `Its hooks are not registered: ${problem}.${said}`;
  return (hooks ? `Its hooks are not registered: the skill is on ${machine}, and hooks run on this machine.` : "") + (hooks ? said : said.trim());
}

export async function loadSkill(name: string, args: string, ctx: ToolContext): Promise<ToolOutput> {
  const r = await findSkill(ctx, name);
  if ("error" in r) return fail(r.error);
  const { skill, raw, vars, grantable, machine, held } = r.found;
  if (!skill.modelInvocable) return fail(`The skill "${skill.name}" is only for the owner to invoke.`);
  const { body } = frontmatter(raw);
  const text = renderSkill(body, args ?? "", skill.arguments, vars);
  // context: fork: the skill is an agent's task, not this conversation's text.
  if (skill.fork && skillRun.fork) {
    usage?.record(skill.name);
    return skillRun.fork(ctx, skill, `Base directory for this skill: ${skill.dir}\n\n${text.trim()}`);
  }
  // Sent again unless the model can still see it: after a clear, a rewind or
  // another branch it is gone from the context even though it was loaded.
  // (Loading it again grants its tools again, for this turn: Claude Code re-applies them.)
  const g = grantOf(skill, vars, grantable, held);
  if (g.rules.length) skillRun.grant!(ctx.sessionId, g.rules, skill.name, false);
  holdChoice(ctx.sessionId, choiceOf(skill), skill.name, grantable, false);
  const extra = said(skill, g.rules.length ? g.granted : [], g.left, g.held, machine ? peerHooksSaid(raw, machine, vars) : hooksSaid(skill, raw, ctx.sessionId));
  if (ctx.inContext?.(text.trim())) return ok(`The skill "${skill.name}" is already loaded above; follow it.${extra}`);
  usage?.record(skill.name);
  return ok(`Base directory for this skill: ${skill.dir}\n\n${text.trim()}${extra}`);
}

// A skill an agent's definition preloads (Claude Code's sub-agent `skills`):
// its whole content, rendered as the skill tool renders it with no
// arguments. One only the owner invokes is not preloaded, as there. Its
// allowed-tools grant nothing: the agent did not invoke it.
export function preloadSkill(name: string, cwd: string, sessionId: string): { text: string } | { error: string } {
  const skill = discoverSkills(cwd).find((s) => s.name === name);
  if (!skill) return { error: "no skill of that name here" };
  if (!skill.enabled) return { error: "it is turned off in Settings > Skills" };
  if (!skill.modelInvocable) return { error: "only the owner invokes it (disable-model-invocation)" };
  const { body } = frontmatter(readFileSync(skill.file, "utf8"));
  usage?.record(skill.name);
  return { text: `Skill ${skill.name} (base directory ${skill.dir}):\n\n${renderSkill(body, "", skill.arguments, varsOf(skill, cwd, sessionId)).trim()}` };
}

// The same for an agent that may be placed on another machine: what it preloads is read there.
export async function preloadSkillIn(name: string, cwd: string, sessionId: string): Promise<{ text: string } | { error: string }> {
  const home = skillHome.of?.(sessionId);
  if (!home) return preloadSkill(name, cwd, sessionId);
  const r = await home.get(name);
  if ("error" in r) return { error: `the skills on ${home.machine}, where its tools run, could not be read: ${r.error}` };
  if ("missing" in r) return { error: `no skill of that name on ${home.machine}` };
  const { skill, raw, vars } = r;
  if (!skill.enabled) return { error: `it is turned off on ${home.machine}` };
  if (!frontFields(frontmatter(raw).data).modelInvocable) return { error: "only the owner invokes it (disable-model-invocation)" };
  usage?.record(skill.name);
  return { text: `Skill ${skill.name} (base directory ${skill.dir}, on ${home.machine}):\n\n${renderSkill(frontmatter(raw).body, "", skill.arguments, vars).trim()}` };
}

// The owner invoking a skill from the message box: same rendering, and skills
// hidden from the model are allowed; ones marked not user-invocable are not.
// Its allowed-tools hold for the turn the owner's command starts (`grant`).
// `grant`: "next" when the command starts a turn, "now" when it is steered into the running one; `cmd` its text.
export function renderForOwner(name: string, args: string, cwd: string, sessionId: string, opts: { grant?: "next" | "now"; cmd?: string; count?: boolean } = {}): { skill: Skill; text: string } | { error: string } {
  const skill = discoverSkills(cwd).find((s) => s.name === name);
  if (!skill) return { error: `no skill named ${name}` };
  return ownerText({ skill, raw: readFileSync(skill.file, "utf8"), vars: varsOf(skill, cwd, sessionId), grantable: mayGrant(skill) }, args, sessionId, opts);
}

// The same for a session that may be placed on another machine: the skill is read there.
export async function renderForOwnerIn(name: string, args: string, s: { id: string; workspace: string }, opts: { grant?: "next" | "now"; cmd?: string; count?: boolean } = {}): Promise<{ skill: Skill; text: string } | { error: string }> {
  const home = skillHome.of?.(s.id);
  if (!home) return renderForOwner(name, args, s.workspace, s.id, opts);
  const r = await home.get(name);
  if ("error" in r) return { error: `the skills on ${home.machine}, where this session's tools run, could not be read: ${r.error}` };
  if ("missing" in r || r.skill.name !== name) return { error: `no skill named ${name} on ${home.machine}` };
  return ownerText(adoptPeer(home, r), args, s.id, opts);
}

function ownerText(f: Found, args: string, sessionId: string, opts: { grant?: "next" | "now"; cmd?: string; count?: boolean }): { skill: Skill; text: string } | { error: string } {
  const { skill, raw, vars, grantable, machine, held } = f;
  const name = skill.name;
  if (!skill.userInvocable) return { error: `${name} is not meant to be invoked by hand` };
  if (!skill.enabled) return { error: `${name} is turned off in Settings > Skills` };
  const { body } = frontmatter(raw);
  const text = renderSkill(body, args, skill.arguments, vars);
  if (opts.count !== false) usage?.record(skill.name);
  let extra = "";
  if (opts.grant && !skill.fork) {
    const g = grantOf(skill, vars, grantable, held);
    if (g.rules.length) skillRun.grant!(sessionId, g.rules, skill.name, opts.grant === "next", opts.cmd);
    holdChoice(sessionId, choiceOf(skill), skill.name, grantable, opts.grant === "next", opts.cmd);
    extra = said(skill, g.rules.length ? g.granted : [], g.left, g.held, machine ? peerHooksSaid(raw, machine, vars) : hooksSaid(skill, raw, sessionId));
  }
  return { skill, text: `Base directory for this skill: ${skill.dir}\n\n${text.trim()}${extra}` };
}

// The listing, as Claude Code keeps it (code.claude.com/docs/en/skills,
// 2026-11-19): every name always; each description cut at 1,536 characters;
// past the budget, descriptions go first from the skills loaded least, so the
// ones in use keep their text; and a line says some are listed by name only.
// The budget is 1% of the model's context window at 4 characters a token
// (Claude Code 2.1.328: 8,000 characters for 200,000 tokens, 40,000 for a
// million); a window nobody stated counts as 200,000. A small window still
// gets the floor, about 500 tokens of names and descriptions.
export const LISTING_SHARE = 0.01;
export const LISTING_WINDOW = 200_000;
export const LISTING_FLOOR = 2_000;
export const listingBudget = (window?: number) => Math.max(LISTING_FLOOR, Math.floor((window || LISTING_WINDOW) * 4 * LISTING_SHARE));
export const LISTING_BUDGET = listingBudget();
export const DESCRIPTION_CAP = 1_536;
export type ListingEntry = { name: string; description: string; uses: number };
export function fitListing(entries: ListingEntry[], budget = LISTING_BUDGET): { lines: string[]; nameOnly: string[] } {
  const full = entries.map((e) => {
    const d = e.description.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
    return `- ${e.name}: ${d.length > DESCRIPTION_CAP ? `${d.slice(0, DESCRIPTION_CAP - 3)}...` : d}`;
  });
  // Every name is kept; the budget is spent on descriptions, most used first.
  let used = entries.reduce((n, e) => n + e.name.length + 3, 0);
  const keep = new Set<number>();
  for (const i of entries.map((_, i) => i).sort((a, b) => entries[b]!.uses - entries[a]!.uses || a - b)) {
    const extra = full[i]!.length - (entries[i]!.name.length + 2);
    if (used + extra > budget) continue;
    used += extra;
    keep.add(i);
  }
  return { lines: entries.map((e, i) => (keep.has(i) ? full[i]! : `- ${e.name}`)), nameOnly: entries.filter((_, i) => !keep.has(i)).map((e) => e.name) };
}

// How often each skill was loaded (the daemon keeps the counts; none: all equal).
let usage: { uses(): Map<string, number>; record(name: string): void } | null = null;
// (It gives back the counts it replaces.)
export const setSkillUsage = (u: typeof usage) => { const was = usage; usage = u; return was; };

// `window`: the context window of the session's model, in tokens.
// `byUse` false: cut as if no skill was ever loaded.
export function listingOf(cwd: string, window?: number, byUse = true, skills = discoverSkills(cwd).filter((s) => s.modelInvocable && s.enabled)) {
  const uses = (byUse ? usage?.uses() : undefined) ?? new Map<string, number>();
  return fitListing(skills.map((s) => ({ name: s.name, description: s.description, uses: uses.get(s.name) ?? 0 })), listingBudget(window));
}

export function skillListing(cwd: string, window?: number, byUse = true, skills?: Skill[], machine?: string): string {
  const { lines, nameOnly } = listingOf(cwd, window, byUse, skills);
  if (!lines.length) return "";
  const note = nameOnly.length ? `\n(${nameOnly.length} of them are listed by name only, to keep this list short: load one by name to read what it is for.)` : "";
  const head = machine ? `Skills on ${machine}, where your tools run, that you can load with the skill tool when a task matches one (the body comes back as its result; this machine's own skills are not offered)` : "Skills you can load with the skill tool when a task matches one (the body comes back as its result)";
  return `${head}:\n${lines.join("\n")}${note}`;
}

// Built with the session's system prompt, which stays frozen: the budget is the window of the model it runs on (made again when the session switches model).
// The skills themselves are the owner's side of the block (hooks.ts SystemBlock); how the listing was cut to fit is not.
// Which descriptions a listing past its budget keeps follows how often each skill was loaded: that
// is no change of the skills, so the block is compared as cut with no use counted, and a kept
// prompt is not made again because a skill was loaded since (it takes the new cut when it is made
// again for another reason).
// A session whose tools run on another machine lists that machine's skills, read there under its own
// trust and scan rules. One that does not answer gives no skills and one line saying so, never this
// machine's.
const BLOCK = "Skills you can load with the skill tool when a t";
registerHooks({
  system: (s, model) => {
    const window = model && !model.context_assumed ? model.context : undefined;
    if (s.machine) return peerBlock(s, window);
    const skills = discoverSkills(s.workspace).filter((k) => k.modelInvocable && k.enabled);
    return {
      name: BLOCK,
      text: skillListing(s.workspace, window, true, skills),
      data: JSON.stringify(skills.map((k) => [k.name, k.description])),
      same: skillListing(s.workspace, window, false, skills),
    };
  },
});

async function peerBlock(s: { id: string; workspace: string }, window: number | undefined): Promise<SystemBlock> {
  const home = skillHome.of?.(s.id);
  const r = home ? await home.list().catch((e) => ({ error: (e as Error).message })) : { error: "the machine is not in the fleet" };
  const where = home?.machine ?? "the machine where its tools run";
  if ("error" in r) {
    return { name: BLOCK, text: `The skills on ${where}, where your tools run, could not be read just now, so no skills are offered in this session (this machine's own skills are not used there).`, data: JSON.stringify(["unreadable", where]) };
  }
  const skills = r.skills.filter((k) => k.modelInvocable && k.enabled);
  return {
    name: BLOCK,
    text: skillListing(s.workspace, window, true, skills, where),
    data: JSON.stringify(skills.map((k) => [k.name, k.description])),
    same: skillListing(s.workspace, window, false, skills, where),
  };
}

export const skillTool = (name: string, nameKey: string, argsKey: string | null, description?: string): Tool => ({
  name,
  readOnly: true,
  resultCap: Infinity, // instructions to follow: they come whole, or their middle is missing
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
