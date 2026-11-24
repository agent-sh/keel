// Bring the owner's setup from the other harnesses into Keel in one pass:
// instructions, memory (into tacit), skills, plugins, MCP servers, hooks,
// sessions and the Rust Keel's settings. `plan()` reads and writes nothing: it
// lists every item found, what an apply does with it, and what is skipped and
// why. `apply()` runs the picked items. Sources are only read; what is written
// goes to Keel's own config folder, Keel's own state, tacit (through
// tacit's own importer) and a project's own .keel/hooks.json (its Claude Code
// hooks, which run only once the owner pins that file). Running it again changes nothing that is already
// there: each item knows its own result in Keel and says "done".
//
// Shaped after Codex's external-agent migration (detect items by type, import
// the selected ones; sessions of the last 30 days, at most 50, whose folder
// still exists) and Hermes's import-agent (a per-item plan, a dry run that
// never writes, merges that never replace, conflicts skipped, a broken source
// file an error of its own item). Unlike both, Keel reads skills and plugins
// where they are (a root or a plugin reference, not a copy), so an update in
// the other harness reaches Keel without another import.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir, inConfigDir } from "../providers/config.ts";
import { writeOwnFile } from "../core/ownfile.ts";
import { expandImports } from "../engine/turn.ts";
import { carriedPlugins, discoverSkills, frontmatter, pluginDir, skillsConfig, writeSkillsConfig, type SkillRoot } from "../tools/skills.ts";
import { EVENTS, ownerHooksPath, parseHooks, portable, projectRoot } from "./hooks.ts";
import { configPath, importable, readConfig, writeConfig, type McpServerConfig } from "../mcp/config.ts";
import { identity, importHome } from "../mcp/sources.ts";
import { findBin } from "./tacit.ts";
import { collect } from "../core/proc.ts";
import { HARNESSES, modelFor, type Imports } from "./import/service.ts";
import { inDatabase, type Found, type Harness } from "./import/types.ts";
import type { Store } from "../core/store.ts";
import type { RuleKind } from "../safety/policy.ts";
import { Database } from "bun:sqlite";
import { claudeAllow, overlaps, parseRule, rustRule, type Mapped } from "./port-permissions.ts";
import { keelDb } from "./import/keel.ts";
import { homeDir, ownerEnv, ownerHome } from "../core/paths";

export type Area = "instructions" | "memory" | "skills" | "plugins" | "mcp" | "hooks" | "permissions" | "sessions" | "settings";
export const AREAS: Area[] = ["instructions", "memory", "skills", "plugins", "mcp", "hooks", "permissions", "sessions", "settings"];

// new: an apply brings it; update: it is in Keel and the source changed;
// done: already in Keel (or Keel reads it itself); skip: not brought, with the reason.
export type Item = { id: string; area: Area; source: string; title: string; detail?: string; state: "new" | "update" | "done" | "skip" | "error"; reason?: string; pick: boolean; path?: string };
type Planned = Item & { run?: () => Promise<string> };
export type Plan = { home: string; config: string; items: Item[] };
export type Applied = Item & { ok: boolean; result?: string; error?: string };

export type PortDeps = {
  store: Store;
  imports: Imports;
  providers: { models(): Promise<any[]>; defaultModel(): Promise<string | undefined | null> };
  workspace: string;
  // The daemon's MCP manager (it connects what is added); without one the config file is written.
  mcp?: { importFrom(source: string, name: string): string | null };
  // The gate's standing rules: what a scope holds, and adding one (permissions).
  grants?: { has(kind: RuleKind, pattern: string, scope: string): boolean; add(kind: RuleKind, pattern: string, scope: string): void };
  emit?: (session: any) => void;
};

// The home whose harness folders are read (a scratch home for tests).
export const portHome = importHome;
const realHome = () => portHome() === homeDir();

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const tilde = (p: string) => (p.startsWith(homeDir() + "/") ? "~" + p.slice(homeDir().length) : p);
const list = (d: string) => { try { return readdirSync(d).sort(); } catch { return []; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const hash = (s: string) => Bun.hash(s).toString(36);

// Whole or not at all; a file of Keel's own config keeps what it held as <name>.prev.
const writeAtomic = (path: string, text: string, own = inConfigDir(path)) => { writeOwnFile(path, text, { prev: own }); };

// ---- instructions -----------------------------------------------------------

const BEGIN = (id: string) => `<!-- keel port: ${id} -->`;
const END = (id: string) => `<!-- /keel port: ${id} -->`;
const BLOCK = /<!-- keel port: ([\w:.-]+) -->\n([\s\S]*?)\n?<!-- \/keel port: \1 -->\n?/g;

export function blocksOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(BLOCK)) out.set(m[1]!, m[2]!.trim());
  return out;
}

// A file cut at its headings: [heading line or "", body].
export function sections(text: string): { head: string; body: string }[] {
  const out: { head: string; body: string }[] = [];
  let cur = { head: "", body: "" };
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line)) {
      if (cur.head || cur.body.trim()) out.push(cur);
      cur = { head: line.trim(), body: "" };
    } else cur.body += line + "\n";
  }
  if (cur.head || cur.body.trim()) out.push(cur);
  return out;
}
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const headKey = (h: string) => norm(h.replace(/^#+\s*/, ""));

const HARNESS_WORDS: Record<string, RegExp> = {
  "Claude Code": /\bclaude( code)?\b/i,
  Codex: /\bcodex\b/i,
  Hermes: /\bhermes\b/i,
  "the Rust Keel": /\bkeel\b/i,
};
const ONLY = /\b(claude code|claude|codex|hermes|cursor|gemini|agy|antigravity|opencode|grok)\b[^\n]*\bonly\b/i;

type InstrSource = { id: string; label: string; harness: string; path: string; text?: string };

// What each source adds to the owner's instruction file: its `@` imports not
// brought yet, and its sections that are not already there (the same text, or
// a section of the same heading a brought file holds), not written for one
// harness only, and not about that harness itself.
export function instructionBlocks(own: string, ownPath: string, srcs: InstrSource[]) {
  const outside = own.replace(BLOCK, "");
  const carried = new Set<string>();
  const heads = new Map<string, string>(); // heading -> where it is carried from
  const take = (text: string, from: string) => {
    for (const s of sections(text)) {
      carried.add(norm(s.head + "\n" + s.body));
      if (s.head) heads.set(headKey(s.head), from);
    }
  };
  take(expandImports(outside, ownPath), "Keel's own instructions");
  const refs = new Set<string>();
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  for (const m of outside.matchAll(/^@(\S+)[ \t]*$/gm)) refs.add(real(m[1]!.startsWith("~/") ? join(homeDir(), m[1]!.slice(2)) : m[1]!));
  return srcs.map((src) => {
    const text = (src.text ?? "").replace(/<!--[\s\S]*?-->/g, "");
    const lines: string[] = [];
    const skipped: string[] = [];
    let dups = 0;
    const body = text.replace(/^@(\S+)[ \t]*$/gm, (_l, ref: string) => {
      const abs = ref.startsWith("~/") ? join(portHome(), ref.slice(2)) : ref.startsWith("/") ? ref : join(dirname(src.path), ref);
      if (refs.has(real(abs))) { dups++; return ""; }
      refs.add(real(abs));
      lines.push(`@${tilde(abs)}`);
      try { take(expandImports(readFileSync(abs, "utf8"), abs), tilde(abs)); } catch {}
      return "";
    });
    for (const s of sections(body)) {
      if (!s.body.trim() && !s.head) continue;
      const key = norm(s.head + "\n" + s.body);
      const title = s.head.replace(/^#+\s*/, "") || "the opening text";
      if (ONLY.test(s.head)) { skipped.push(`"${title}" (written for one harness only)`); continue; }
      if (carried.has(key) || (s.head && heads.has(headKey(s.head)))) { dups++; continue; }
      const first = s.head || s.body.trim().split("\n")[0] || "";
      if (HARNESS_WORDS[src.harness]?.test(first)) { skipped.push(`"${title}" (about ${src.harness} itself)`); continue; }
      carried.add(key);
      if (s.head) heads.set(headKey(s.head), src.label);
      lines.push(`${s.head}\n${s.body}`.trim());
    }
    return { src, block: lines.join("\n\n").trim(), skipped, dups };
  });
}

// Claude Code's built-in output styles, in the words its documentation gives
// each (code.claude.com/docs/en/output-styles, read 2026-11-19).
const BUILTIN_STYLES: Record<string, string> = {
  Concise: "Lead every response with what happened or what the answer is. Leave out the lead-in, step-by-step narration and the closing recap; answer a simple question in one to three sentences. Do the engineering work as thoroughly as ever.",
  Proactive: "Start work right away and make reasonable assumptions instead of asking about routine decisions; the owner corrects course when an assumption is wrong.",
  Explanatory: "Do the task as usual and add short Insight blocks in the conversation, before or after the code they are about, that explain the choices behind it. Never write them into files as comments.",
  Learning: "Add short Insight blocks that explain your choices, and where a piece has a real design decision, leave a few lines for the owner to write, saying what they should do.",
};

function outputStyle(claude: string): { name: string; text: string; from: string } | null {
  let name: string | undefined;
  for (const f of ["settings.json", "settings.local.json"]) { try { name = readJson(join(claude, f)).outputStyle ?? name; } catch {} }
  if (!name || name === "Default") return null;
  if (BUILTIN_STYLES[name]) return { name, text: BUILTIN_STYLES[name]!, from: "Claude Code's built-in style" };
  const dirs = [join(claude, "output-styles"), ...carriedPlugins().map((p) => join(p.dir, "output-styles"))];
  for (const d of dirs) for (const n of list(d)) {
    if (!n.endsWith(".md")) continue;
    const { data, body } = frontmatter(readFileSync(join(d, n), "utf8"));
    if ((data.name || n.slice(0, -3)) === name) return { name, text: body.trim(), from: tilde(join(d, n)) };
  }
  return { name, text: "", from: "" };
}

function planInstructions(items: Planned[]) {
  const H = portHome();
  const ownPath = join(configDir(), "AGENTS.md");
  const own = existsSync(ownPath) ? readFileSync(ownPath, "utf8") : "";
  const existing = blocksOf(own);
  const srcs: InstrSource[] = [
    { id: "instructions:claude", label: "Claude Code", harness: "Claude Code", path: join(H, ".claude", "CLAUDE.md") },
    { id: "instructions:codex", label: "Codex", harness: "Codex", path: join(codexDir(), "AGENTS.md") },
    { id: "instructions:hermes", label: "Hermes", harness: "Hermes", path: join(H, ".hermes", "SOUL.md") },
    { id: "instructions:keel", label: "Keel (Rust)", harness: "the Rust Keel", path: join(rustConfig(), "AGENTS.md") },
  ].filter((s) => existsSync(s.path));
  for (const s of srcs) {
    try { s.text = readFileSync(s.path, "utf8"); } catch (e) { items.push({ id: s.id, area: "instructions", source: s.label, title: tilde(s.path), state: "error", reason: (e as Error).message, pick: false, path: s.path }); }
  }
  const style = outputStyle(join(H, ".claude"));
  const results = instructionBlocks(own, ownPath, srcs.filter((s) => s.text !== undefined));
  const blocks: { id: string; text: string }[] = [];
  for (const r of results) {
    const lines = r.block.split("\n");
    const refs = lines.filter((l) => l.startsWith("@"));
    const secs = lines.filter((l) => /^#{1,6}\s/.test(l)).length + (r.block && !/^(@|#)/.test(r.block) ? 1 : 0);
    const parts = [[refs.length ? refs.join(", ") : "", secs ? plural(secs, "section") : ""].filter(Boolean).join(" and ")];
    if (r.dups) parts.push(`${plural(r.dups, "part")} already there`);
    if (r.skipped.length) parts.push(`leaves out ${r.skipped.join(", ")}`);
    const detail = parts.filter(Boolean).join("; ");
    const was = existing.get(r.src.id);
    if (!r.block) {
      items.push({ id: r.src.id, area: "instructions", source: r.src.label, title: tilde(r.src.path), detail, state: was ? "done" : "skip", reason: was ? undefined : "everything in it is already in Keel's instructions or is for that harness only", pick: false, path: r.src.path });
      continue;
    }
    blocks.push({ id: r.src.id, text: r.block });
    const state = was === undefined ? "new" : was === r.block ? "done" : "update";
    items.push({ id: r.src.id, area: "instructions", source: r.src.label, title: tilde(r.src.path), detail, state, pick: state !== "done", path: r.src.path });
  }
  if (style) {
    const id = "instructions:claude-style";
    if (!style.text) items.push({ id, area: "instructions", source: "Claude Code", title: `Output style "${style.name}"`, state: "skip", reason: "no file of that style was found", pick: false });
    else {
      const text = `Response style (Claude Code's "${style.name}" output style):\n${style.text}`;
      blocks.push({ id, text });
      const was = existing.get(id);
      const state = was === undefined ? "new" : was === text ? "done" : "update";
      items.push({ id, area: "instructions", source: "Claude Code", title: `Output style "${style.name}"`, detail: `from ${style.from}`, state, pick: state !== "done" });
    }
  }
  // One writer for every picked block: each replaces its own earlier block in
  // place; the owner's own text and blocks not picked stay as they are.
  const write = async (picked: Set<string>) => {
    let text = existsSync(ownPath) ? readFileSync(ownPath, "utf8") : "";
    for (const b of blocks) {
      if (!picked.has(b.id)) continue;
      const block = `${BEGIN(b.id)}\n${b.text}\n${END(b.id)}\n`;
      let found = false;
      text = text.replace(BLOCK, (all, id) => (id === b.id ? ((found = true), block) : all));
      if (!found) text = (text.trim() ? text.replace(/\n*$/, "\n\n") : "") + block;
    }
    writeAtomic(ownPath, text);
  };
  for (const it of items) if (it.area === "instructions" && (it.state === "new" || it.state === "update")) {
    it.run = async () => { await write(new Set([it.id])); return `written to ${tilde(ownPath)}`; };
  }
}

// ---- memory (tacit) -----------------------------------------------------------

async function tacitImport(kind: "claude" | "codex", dirs: string[]): Promise<string> {
  const bin = findBin("TACIT_BIN", "tacit");
  if (!bin) throw new Error("tacit is not installed");
  const store = process.env.KEEL_TACIT_STORE ? ["--store", process.env.KEEL_TACIT_STORE] : [];
  const p = Bun.spawn([bin, "import", ...store, kind, ...dirs], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 10 * 60_000);
  const { out, err, code } = await collect(p, "tacit import").finally(() => clearTimeout(timer));
  const line = `${out}\n${err}`.trim().split("\n").filter(Boolean).pop() ?? "";
  if (code !== 0) throw new Error(`tacit import ${kind} failed (exit ${code}): ${line}`);
  return line;
}

// What tacit took last time, by item: a digest of the files' names, sizes and
// times. tacit leaves what it holds unchanged anyway; the digest lets the plan
// say "done" instead of running tacit's import again on the same files.
function marks(store: Store) {
  store.migrate("CREATE TABLE IF NOT EXISTS port_marks (id TEXT PRIMARY KEY, digest TEXT NOT NULL, at INTEGER NOT NULL);");
  return {
    get: (id: string) => store.db.query<{ digest: string; at: number }, [string]>("SELECT digest, at FROM port_marks WHERE id = ?").get(id),
    set: (id: string, digest: string) => store.db.query("INSERT INTO port_marks (id, digest, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET digest = excluded.digest, at = excluded.at").run(id, digest, Date.now()),
  };
}
const filesDigest = (dirs: string[]) => hash(dirs.flatMap((d) => list(d).filter((f) => f.endsWith(".md")).map((f) => { const st = statSync(join(d, f)); return `${join(d, f)}:${st.size}:${Math.round(st.mtimeMs)}`; })).join("\n"));

function planMemory(items: Planned[], store: Store) {
  const mk = marks(store);
  const H = portHome();
  const tacit = findBin("TACIT_BIN", "tacit");
  const projects = join(H, ".claude", "projects");
  const dirs = list(projects).map((p) => join(projects, p, "memory")).filter((d) => list(d).some((f) => f.endsWith(".md")));
  const files = dirs.reduce((n, d) => n + list(d).filter((f) => f.endsWith(".md")).length, 0);
  const why = "Keel's memory is tacit: tacit's own importer takes them into its inbox, where its reviewer judges each note before it is curated";
  const memory = (id: string, source: string, title: string, detail: string, kind: "claude" | "codex", ds: string[]) => {
    const digest = filesDigest(ds);
    const last = mk.get(id);
    if (last?.digest === digest) return items.push({ id, area: "memory", source, title, detail, state: "done", reason: `tacit took these files on ${new Date(last.at).toISOString().slice(0, 10)}; none changed since`, pick: false });
    items.push({
      id, area: "memory", source, title, detail: `${detail}; ${why}. What tacit holds already stays unchanged.`,
      state: tacit ? (last ? "update" : "new") : "skip", reason: tacit ? undefined : "tacit is not installed", pick: !!tacit,
      run: async () => { const out = await tacitImport(kind, ds); mk.set(id, digest); return out; },
    });
  };
  if (dirs.length) memory("memory:claude", "Claude Code", "Auto memory", `${plural(files, "file")} in ${plural(dirs.length, "project")}`, "claude", dirs);
  const cm = join(codexDir(), "memories");
  if (list(cm).some((f) => f.endsWith(".md"))) memory("memory:codex", "Codex", "Memories", tilde(cm), "codex", [cm]);
  if (list(join(H, ".hermes", "memories")).some((f) => f.endsWith(".md"))) items.push({
    id: "memory:hermes", area: "memory", source: "Hermes", title: "MEMORY.md and USER.md", state: "skip", pick: false,
    reason: "tacit has no importer for Hermes's files; it takes Hermes's memory writes as they happen once installed for Hermes (tacit install hermes)",
  });
}

// ---- skills and plugins ------------------------------------------------------

const codexDir = () => (process.env.KEEL_IMPORT_HOME ? join(portHome(), ".codex") : ownerEnv("CODEX_HOME") ?? join(ownerHome(), ".codex"));
const rustConfig = () => (process.env.KEEL_IMPORT_HOME ? join(portHome(), ".config", "keel") : join(ownerEnv("XDG_CONFIG_HOME")?.startsWith("/") ? ownerEnv("XDG_CONFIG_HOME")! : join(ownerHome(), ".config"), "keel"));
const skillDirs = (d: string) => list(d).filter((n) => !n.startsWith(".") && existsSync(join(d, n, "SKILL.md")));

function addRoot(dir: string, label: string, extra: Partial<SkillRoot> = {}) {
  const c = skillsConfig();
  const roots = (c.roots ?? []).filter((r) => r.dir !== dir);
  writeSkillsConfig({ ...c, roots: [...roots, { dir, label, ...extra }] });
}

// What a Claude Code plugin brings to Keel, and what it holds that Keel cannot run.
const NATIVE: [RegExp, string][] = [
  [/\bparlar\b/, "Keel has voice through parlar built in"],
  [/\btacit\s+hook\b/, "Keel runs tacit's hooks itself"],
  [/\btacit\s+mcp\b/, "Keel brings tacit's tools itself (the tacit server in MCP servers)"],
];
const native = (s: string) => NATIVE.find(([re]) => re.test(s))?.[1];

function pluginParts(dir: string) {
  const json = (p: string) => { try { return readJson(p); } catch { return undefined; } };
  const manifest = json(join(dir, ".claude-plugin", "plugin.json")) ?? {};
  const mcp: Record<string, any> = { ...(json(join(dir, ".mcp.json"))?.mcpServers ?? {}), ...(typeof manifest.mcpServers === "object" ? manifest.mcpServers : {}) };
  const hooksFile = json(join(dir, "hooks", "hooks.json")) ?? {};
  return {
    skills: skillDirs(join(dir, "skills")).length,
    commands: list(join(dir, "commands")).filter((n) => n.endsWith(".md")).length,
    agents: list(join(dir, "agents")).filter((n) => n.endsWith(".md")).length,
    styles: list(join(dir, "output-styles")).filter((n) => n.endsWith(".md")).length,
    mcp,
    hooks: (hooksFile.hooks ?? {}) as Record<string, any[]>,
    modules: Array.isArray(hooksFile.modules) && hooksFile.modules.length > 0,
    lsp: !!(manifest.lspServers || existsSync(join(dir, ".lsp.json"))),
  };
}

const expandRoot = (v: any, root: string): any =>
  typeof v === "string" ? v.replaceAll("${CLAUDE_PLUGIN_ROOT}", root) : Array.isArray(v) ? v.map((x) => expandRoot(x, root)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandRoot(x, root)])) : v;

function planSkills(items: Planned[], hookPlan: HookCandidate[]) {
  const H = portHome();
  const cfg = skillsConfig();
  const rooted = new Set((cfg.roots ?? []).map((r) => r.dir));
  const have = new Set(discoverSkills(H).map((s) => s.name));
  for (const [dir, label] of [[join(H, ".claude", "skills"), "Claude Code"], [join(H, ".agents", "skills"), "Agent Skills (~/.agents)"]] as const) {
    const n = skillDirs(dir).length;
    if (!n) continue;
    const id = `skills:${label === "Claude Code" ? "claude" : "agents"}`;
    if (realHome() || rooted.has(dir)) items.push({ id, area: "skills", source: label, title: tilde(dir), detail: plural(n, "skill"), state: "done", reason: realHome() ? "Keel reads this folder itself" : undefined, pick: false });
    else items.push({ id, area: "skills", source: label, title: tilde(dir), detail: plural(n, "skill"), state: "new", pick: true, run: async () => (addRoot(dir, label), `Keel reads ${tilde(dir)}`) });
  }
  // Codex: its own skills folder; the .system folder holds Codex's built-ins.
  const cs = join(codexDir(), "skills");
  const own = skillDirs(cs);
  if (own.length) {
    const clash = own.filter((n) => have.has(n) && !rooted.has(cs));
    items.push({
      id: "skills:codex", area: "skills", source: "Codex", title: tilde(cs), path: cs,
      detail: `${plural(own.length, "skill")}${clash.length ? `; ${clash.length} share a name with a skill Keel has, which wins (${clash.slice(0, 6).join(", ")})` : ""}`,
      state: rooted.has(cs) ? "done" : "new", pick: !rooted.has(cs), run: async () => (addRoot(cs, "Codex", { exclude: [".system"] }), `Keel reads ${tilde(cs)}`),
    });
  }
  const sys = skillDirs(join(cs, ".system"));
  if (sys.length) items.push({ id: "skills:codex-system", area: "skills", source: "Codex", title: `${tilde(cs)}/.system`, detail: plural(sys.length, "skill"), state: "skip", reason: "Codex's built-in skills drive Codex itself", pick: false });
  // Hermes keeps its library by category; the bundled ones and its copies of
  // other harnesses' skills are left out. Its own are written for its tools
  // and jobs, so they come only when picked.
  const hs = join(H, ".hermes", "skills");
  if (isDir(hs)) {
    const bundled = new Set<string>();
    try { for (const l of readFileSync(join(hs, ".bundled_manifest"), "utf8").split("\n")) { const n = l.split(":")[0]?.trim(); if (n) bundled.add(n); } } catch {}
    const imports = list(hs).filter((n) => /-imports$/.test(n));
    let count = 0;
    const walk = (d: string, depth: number) => { for (const n of list(d)) { if (n.startsWith(".") || bundled.has(n) || imports.includes(n)) continue; const p = join(d, n); if (existsSync(join(p, "SKILL.md"))) count++; else if (depth < 3 && isDir(p)) walk(p, depth + 1); } };
    walk(hs, 0);
    if (count) items.push({
      id: "skills:hermes", area: "skills", source: "Hermes", title: tilde(hs), path: hs,
      detail: `${plural(count, "skill")} of its own (${plural(bundled.size, "bundled skill")} and its copies in ${imports.join(", ") || "no import folder"} left out)`,
      state: rooted.has(hs) ? "done" : "new", reason: rooted.has(hs) ? undefined : "written for Hermes's tools and scheduled jobs: brought only when picked", pick: false,
      run: async () => (addRoot(hs, "Hermes", { nested: true, exclude: [...bundled, ...imports] }), `Keel reads ${plural(count, "skill")} from ${tilde(hs)}`),
    });
  }
  // Claude Code plugins: the ones turned on.
  const claude = join(H, ".claude");
  let enabled: Record<string, boolean> = {};
  try { enabled = readJson(join(claude, "settings.json")).enabledPlugins ?? {}; } catch (e) { if (existsSync(join(claude, "settings.json"))) items.push({ id: "plugins:settings", area: "plugins", source: "Claude Code", title: "settings.json", state: "error", reason: (e as Error).message, pick: false }); }
  const carried = new Set((cfg.plugins ?? []).map((p) => p.id));
  const off = Object.entries(enabled).filter(([, on]) => !on).map(([id]) => id);
  if (off.length) items.push({ id: "plugins:off", area: "plugins", source: "Claude Code", title: plural(off.length, "plugin") + " turned off", detail: off.join(", "), state: "skip", reason: "turned off in Claude Code", pick: false });
  for (const id of Object.keys(enabled).filter((k) => enabled[k]).sort()) {
    const ref = { id, claude };
    const at = pluginDir(ref);
    const item = { id: `plugins:${id}`, area: "plugins" as const, source: "Claude Code", title: id };
    if (!at) { items.push({ ...item, state: "skip", reason: "turned on but not installed", pick: false }); continue; }
    const parts = pluginParts(at.dir);
    const why = native(JSON.stringify(parts.mcp) + JSON.stringify(parts.hooks));
    if (why) { items.push({ ...item, path: at.dir, state: "skip", reason: why, pick: false }); continue; }
    const brings = [parts.skills && plural(parts.skills, "skill"), parts.commands && plural(parts.commands, "command"), parts.agents && plural(parts.agents, "agent"), parts.styles && plural(parts.styles, "output style")].filter(Boolean) as string[];
    const leaves: string[] = [];
    if (parts.modules) leaves.push("modules that run inside Claude Code's own process");
    if (parts.lsp) leaves.push("language servers (Keel has no LSP client)");
    const elsewhere = [Object.keys(parts.mcp).length ? `its MCP servers under MCP servers (${Object.keys(parts.mcp).join(", ")})` : "", Object.keys(parts.hooks).length ? "its hooks under Hooks" : ""].filter(Boolean);
    for (const [event, groups] of Object.entries(parts.hooks)) for (const g of groups ?? []) for (const h of g?.hooks ?? []) hookPlan.push({ source: `plugin ${id}`, event, matcher: g.matcher, hook: expandRoot(h, at.dir) });
    if (!brings.length && !Object.keys(parts.hooks).length && !Object.keys(parts.mcp).length) { items.push({ ...item, path: at.dir, detail: leaves.join("; ") || undefined, state: "skip", reason: "nothing Keel can run: it extends Claude Code's own interface", pick: false }); continue; }
    const state = carried.has(id) ? "done" : "new";
    items.push({
      ...item, path: at.dir, detail: [brings.join(", "), leaves.length ? `leaves out ${leaves.join(", ")}` : "", elsewhere.length ? `lists ${elsewhere.join(" and ")}` : ""].filter(Boolean).join("; "),
      state, pick: state === "new",
      run: async () => {
        const c = skillsConfig();
        if (!(c.plugins ?? []).some((p) => p.id === id)) writeSkillsConfig({ ...c, plugins: [...(c.plugins ?? []), ref] });
        return `Keel carries ${brings.filter((b) => !b.startsWith("MCP")).join(", ") || "it"} from ${tilde(at.dir)}`;
      },
    });
  }
  // Plugin folders Claude Code loads by path (CLAUDE_CODE_PLUGIN_DIRS).
  let dirsVar = "";
  try { dirsVar = readJson(join(claude, "settings.json")).env?.CLAUDE_CODE_PLUGIN_DIRS ?? ""; } catch {}
  const byPath = dirsVar.split(":").filter(Boolean).map((d) => (d.startsWith("~/") ? join(H, d.slice(2)) : d)).filter(isDir);
  if (byPath.length) {
    const runnable = byPath.filter((d) => { const p = pluginParts(d); return p.skills || p.commands || p.agents || Object.keys(p.mcp).length; });
    items.push({ id: "plugins:by-path", area: "plugins", source: "Claude Code", title: plural(byPath.length, "plugin folder") + " loaded by path", detail: byPath.map((d) => basename(d)).join(", "), state: "skip", pick: false,
      reason: runnable.length ? `only ${runnable.map((d) => basename(d)).join(", ")} hold skills or servers; folders loaded by path have no install record Keel can follow` : "they hold modules that run inside Claude Code's own process (its hooks and interface), which Keel cannot load" });
  }
}

// ---- MCP servers ---------------------------------------------------------------

// The servers of every other agent, as the MCP import reads them
// (src/mcp/sources.ts); a brought one follows its source from then on.
function planMcp(items: Planned[], deps: PortDeps) {
  const failed: { file: string; error: string }[] = [];
  let mine: Record<string, McpServerConfig> = {};
  try { mine = readConfig(configPath()).servers; } catch {}
  const all = importable(portHome(), mine, failed).filter((s) => !s.project);
  for (const f of failed) items.push({ id: `mcp:error:${f.file}`, area: "mcp", source: "MCP", title: tilde(f.file), state: "error", reason: f.error, pick: false });
  const seen = new Map<string, string>(); // name -> label it is brought from
  const sameAs = new Map<string, string>(); // endpoint and account -> name
  for (const [name, c] of Object.entries(mine)) sameAs.set(identity(c), name);
  for (const c of all) {
    const env = Object.keys(c.config.env ?? {});
    const item = { id: `mcp:${c.source}:${c.name}`, area: "mcp" as const, source: c.label, title: c.name, detail: [c.endpoint.slice(0, 120), env.length ? `env ${env.join(", ")}` : ""].filter(Boolean).join("; ") };
    const why = native(c.endpoint);
    if (why) { items.push({ ...item, state: "skip", reason: why, pick: false }); continue; }
    const own = env.find((k) => /^(CODEX|CLAUDE|HERMES)_/.test(k));
    if (own) { items.push({ ...item, state: "skip", reason: `it is wired to that agent itself (${own})`, pick: false }); continue; }
    const id = identity(c.config);
    if (c.configured || mine[c.name]) { items.push({ ...item, state: "done", reason: mine[c.name] && identity(mine[c.name]!) !== id ? "Keel has a server of that name (kept as it is)" : undefined, pick: false }); seen.set(c.name, "Keel"); continue; }
    if (seen.has(c.name)) { items.push({ ...item, state: "skip", reason: `same name as the server brought from ${seen.get(c.name)}`, pick: false }); continue; }
    if (sameAs.has(id)) { items.push({ ...item, state: "skip", reason: `the same server as ${sameAs.get(id)}`, pick: false }); continue; }
    seen.set(c.name, c.label);
    sameAs.set(id, c.name);
    items.push({
      ...item, state: "new", pick: true, ...(c.other_account ? { reason: `same server as ${c.other_account}, another account` } : {}),
      run: async () => {
        if (deps.mcp) { const err = deps.mcp.importFrom(c.source, c.name); if (err) throw new Error(err); }
        else { const cfg = readConfig(configPath()); if (!cfg.servers[c.name]) { cfg.servers[c.name] = { ...c.config, sync: { source: c.source, name: c.name } }; writeConfig(cfg, configPath()); } }
        return "added to Keel's MCP servers; it follows its source";
      },
    });
  }
}

// ---- hooks ------------------------------------------------------------------------

type HookCandidate = { source: string; event: string; matcher?: string; hook: any };

// The script a command runs (after an interpreter), when it is a file.
function scriptOf(command: string): string | undefined {
  const words = command.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
  const w = words.find((x, i) => (i === 0 && !/^(bash|sh|python3?|node|bun|\/usr\/bin\/python3?|\/usr\/bin\/env)$/.test(basename(x))) || /\.(py|sh|js|mjs|ts)$/.test(x)) ?? words[0];
  const p = w?.startsWith("~/") ? join(portHome(), w.slice(2)) : w;
  try { return p && statSync(p).isFile() ? p : undefined; } catch { return undefined; }
}

function planHooks(items: Planned[], fromPlugins: HookCandidate[]) {
  const H = portHome();
  const cands: HookCandidate[] = [];
  const take = (source: string, path: string) => {
    if (!existsSync(path)) return;
    let hooks: Record<string, any[]>;
    try { hooks = readJson(path).hooks ?? {}; } catch (e) { items.push({ id: `hooks:error:${path}`, area: "hooks", source, title: tilde(path), state: "error", reason: (e as Error).message, pick: false }); return; }
    for (const [event, groups] of Object.entries(hooks)) for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks ?? []) cands.push({ source, event, matcher: g.matcher, hook: h });
  };
  take("Claude Code", join(H, ".claude", "settings.json"));
  take("Claude Code", join(H, ".claude", "settings.local.json"));
  take("Codex", join(codexDir(), "hooks.json"));
  cands.push(...fromPlugins);
  const ownPath = ownerHooksPath();
  let ownText = "";
  try { ownText = readFileSync(ownPath, "utf8"); } catch {}
  const mine = parseHooks(ownText || "{}").groups as Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  const has = (event: string, matcher: string | undefined, command: string) => (mine[event] ?? []).some((g) => (g.matcher ?? "") === (matcher ?? "") && g.hooks.some((h) => h.command === command));
  const scripts = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of cands) {
    const command = String(c.hook?.command ?? "");
    const id = `hooks:${c.source}:${c.event}:${hash(`${c.matcher ?? ""}\n${command}`)}`;
    const item = { id, area: "hooks" as const, source: c.source, title: `${c.event}${c.matcher ? ` (${c.matcher})` : ""}`, detail: command.slice(0, 160) || c.hook?.type };
    if (c.hook?.type !== "command" || !command) { items.push({ ...item, state: "skip", reason: `a ${c.hook?.type ?? "untyped"} hook runs inside ${c.source}`, pick: false }); continue; }
    const why = native(command);
    if (why) { items.push({ ...item, state: "skip", reason: why, pick: false }); continue; }
    if (!(EVENTS as readonly string[]).includes(c.event)) { items.push({ ...item, state: "skip", reason: `Keel has no ${c.event} point`, pick: false }); continue; }
    const script = scriptOf(command);
    if (script && statSync(script).size < 256 * 1024 && /CLAUDE_ENV_FILE/.test(readFileSync(script, "utf8"))) { items.push({ ...item, state: "skip", reason: "it writes Claude Code's CLAUDE_ENV_FILE, which Keel does not have", pick: false }); continue; }
    if (has(c.event, c.matcher, command)) { items.push({ ...item, state: "done", pick: false }); if (script) scripts.set(`${c.event}\n${script}`, "Keel"); continue; }
    const key = `${c.event}\n${c.matcher ?? ""}\n${command}`;
    if (seen.has(key)) { items.push({ ...item, state: "skip", reason: "the same hook is brought from another source", pick: false }); continue; }
    if (script && scripts.has(`${c.event}\n${script}`)) { items.push({ ...item, state: "skip", reason: `the same script is brought from ${scripts.get(`${c.event}\n${script}`)}`, pick: false }); continue; }
    seen.add(key);
    if (script) scripts.set(`${c.event}\n${script}`, c.source);
    items.push({
      ...item, state: "new", pick: true,
      run: async () => {
        let text = "";
        try { text = readFileSync(ownPath, "utf8"); } catch {}
        const file = text.trim() ? JSON.parse(text) : {};
        file.hooks ??= {};
        const groups: any[] = (file.hooks[c.event] ??= []);
        if (!groups.some((g) => (g.matcher ?? "") === (c.matcher ?? "") && (g.hooks ?? []).some((h: any) => h.command === command))) {
          // (With what else of it Keel reads: its args, timeout, if, onFailure, async and asyncRewake.)
          groups.push({ ...(c.matcher ? { matcher: c.matcher } : {}), hooks: [portable(c.hook)] });
          writeAtomic(ownPath, JSON.stringify(file, null, 2) + "\n", true);
        }
        return `added to ${tilde(ownPath)}`;
      },
    });
  }
}

// A project's Claude Code hooks go to its own .keel/hooks.json, which runs
// nothing until the owner pins it (Settings > Hooks): bringing them never
// trusts them. The personal settings.local.json stays out: .keel/hooks.json
// is the repository's file, which it may share.
function planProjectHooks(items: Planned[], deps: PortDeps) {
  const source = "Claude Code (project)";
  for (const f of claudeFiles(deps)) {
    if (!f.root) continue;
    const at = tilde(f.root);
    if (f.error) { if (f.file === "settings.json") items.push({ id: `hooks:error:${f.path}`, area: "hooks", source, title: tilde(f.path), state: "error", reason: f.error, pick: false }); continue; }
    const target = join(f.root, ".keel", "hooks.json");
    let mine: Record<string, any[]> = {};
    try { mine = readJson(target).hooks ?? {}; } catch {}
    const has = (event: string, matcher: string | undefined, command: string) => (mine[event] ?? []).some((g: any) => (g.matcher ?? "") === (matcher ?? "") && (g.hooks ?? []).some((h: any) => h.command === command));
    for (const [event, groups] of Object.entries<any>(f.hooks ?? {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of g?.hooks ?? []) {
      const command = String(h?.command ?? "");
      const id = `hooks:${source}:${hash(f.root)}:${f.file}:${event}:${hash(`${g.matcher ?? ""}\n${command}`)}`;
      const item = { id, area: "hooks" as const, source, title: `${event}${g.matcher ? ` (${g.matcher})` : ""} in ${at}`, detail: command.slice(0, 160) || h?.type };
      const skip = (reason: string) => items.push({ ...item, state: "skip", reason, pick: false });
      if (f.file === "settings.local.json") { skip("a personal hook of this project (settings.local.json): Keel's project hooks are the repository's .keel/hooks.json, which it may share; add it to your own hooks to keep it"); continue; }
      if (h?.type !== "command" || !command) { skip(`a ${h?.type ?? "untyped"} hook runs inside Claude Code`); continue; }
      const why = native(command);
      if (why) { skip(why); continue; }
      if (!(EVENTS as readonly string[]).includes(event)) { skip(`Keel has no ${event} point`); continue; }
      const script = scriptOf(command.replace(/"?\$\{?CLAUDE_PROJECT_DIR\}?"?/g, f.root));
      if (script && statSync(script).size < 256 * 1024 && /CLAUDE_ENV_FILE/.test(readFileSync(script, "utf8"))) { skip("it writes Claude Code's CLAUDE_ENV_FILE, which Keel does not have"); continue; }
      if (has(event, g.matcher, command)) { items.push({ ...item, state: "done", reason: `in ${tilde(target)}`, pick: false }); continue; }
      const root = f.root;
      items.push({
        ...item, state: "new", pick: true,
        run: async () => {
          let text = "";
          try { text = readFileSync(target, "utf8"); } catch {}
          const file = text.trim() ? JSON.parse(text) : {};
          file.hooks ??= {};
          const list: any[] = (file.hooks[event] ??= []);
          if (!list.some((x) => (x.matcher ?? "") === (g.matcher ?? "") && (x.hooks ?? []).some((y: any) => y.command === command))) {
            list.push({ ...(g.matcher ? { matcher: g.matcher } : {}), hooks: [portable(h)] });
            writeAtomic(target, JSON.stringify(file, null, 2) + "\n");
          }
          return `added to ${tilde(join(root, ".keel", "hooks.json"))}: it runs once you pin it in Settings > Hooks`;
        },
      });
    }
  }
}

// ---- sessions -----------------------------------------------------------------------

// Codex's defaults for what an import of another agent's sessions takes.
export const SESSION_DAYS = 30;
export const SESSION_MAX = 50;

async function planSessions(items: Planned[], deps: PortDeps, opts: { days: number; max: number }) {
  const im = deps.imports;
  await im.refresh(); // the whole index: a plan is the same however soon it is asked
  const since = Date.now() - opts.days * 86_400_000;
  for (const h of HARNESSES) {
    const all = im.all(h.harness as Harness).filter((f) => f.kind === "interactive");
    if (!all.length) continue;
    // The Rust Keel is the one Keel replaces: all of its own sessions come.
    // The others go on in their own harness: the recent ones come, the rest
    // stay listed in Import.
    const want = h.harness === "keel" ? all : all.filter((f) => f.updated_ms >= since && !f.archived && !f.path.includes("/archived_sessions/") && (!f.cwd || isDir(f.cwd))).sort((a, b) => b.updated_ms - a.updated_ms).slice(0, opts.max);
    const left = all.length - want.length;
    if (left > 0) items.push({ id: `sessions:${h.harness}:rest`, area: "sessions", source: h.label, title: `${plural(left, "other session")}`, state: "skip", pick: false, reason: `older than ${opts.days} days, beyond the newest ${opts.max}, archived or in a folder that is gone; they stay listed in Import` });
    for (const f of want) {
      const link = im.links(f.harness, f.id)[0];
      // A file grew or changed; a session kept in a database went on after the last copy.
      const db = inDatabase(f.harness);
      const st = db ? null : (() => { try { const s = statSync(f.path); return { size: s.size, mtime: Math.round(s.mtimeMs) }; } catch { return null; } })();
      const grew = !!link && (db ? f.updated_ms > link.synced_ms : !!st && (st.size !== link.source_size || st.mtime !== link.source_mtime));
      const wentOn = !!link && im.wentOn(link.session_id);
      const item = { id: `sessions:${f.harness}:${f.id}`, area: "sessions" as const, source: h.label, title: f.title, detail: [f.cwd && tilde(f.cwd), new Date(f.updated_ms).toISOString().slice(0, 10), f.archived ? "archived" : ""].filter(Boolean).join(" · ") };
      if (link && (!grew || wentOn)) { items.push({ ...item, state: "done", reason: wentOn && grew ? "the Keel copy went on; the original's later turns stay there" : undefined, pick: false }); continue; }
      items.push({
        ...item, state: link ? "update" : "new", pick: true,
        run: async () => {
          const model = link ? "" : (await modelFor(deps.providers, f)) ?? "";
          if (!link && !model) throw Object.assign(new Error("no model is set up"), { status: 409 });
          const r = await im.import(f, { mode: link ? "update" : undefined, model, workspace: f.cwd || deps.workspace });
          if (r.action === "created" && f.archived) deps.store.updateSession(r.session.id, { archived: true });
          deps.emit?.(deps.store.session(r.session.id));
          return `${r.action} ${r.session.id} (${plural(r.imported_events, "event")})`;
        },
      });
    }
  }
}

// ---- settings of the Rust Keel and of Claude Code that Keel does not take -----------

function planSettings(items: Planned[], deps: PortDeps) {
  const rc = rustConfig();
  const drive = join(rc, "drive.json");
  const mine = join(configDir(), "drive.json");
  if (existsSync(drive)) {
    const same = existsSync(mine) && readFileSync(mine, "utf8") === readFileSync(drive, "utf8");
    items.push({ id: "settings:keel-drive", area: "settings", source: "Keel (Rust)", title: "drive.json (the agent view Keel drives other sessions through)", path: drive,
      state: same ? "done" : existsSync(mine) ? "skip" : "new", reason: !same && existsSync(mine) ? "Keel has its own drive.json (kept as it is)" : undefined, pick: !existsSync(mine),
      run: async () => (writeAtomic(mine, readFileSync(drive, "utf8")), `copied to ${tilde(mine)}`) });
  }
  if (existsSync(join(rc, "plugins.toml"))) items.push({ id: "settings:keel-plugins", area: "settings", source: "Keel (Rust)", title: "plugins.toml (provider plugins)", state: "done", reason: existsSync(join(configDir(), "plugins.toml")) ? "Keel has its own plugins.toml" : "Keel reads it while it has none of its own", pick: false });
  const H = portHome();
  let s: any = {};
  try { s = readJson(join(H, ".claude", "settings.json")); } catch {}
  // An env block: its names only (values may be keys). Not brought: Keel has no
  // environment of its own per folder or per user setting; its commands run with
  // the environment Keel was started with, and many of these set Claude Code itself.
  for (const f of claudeFiles(deps)) {
    const names = f.env && typeof f.env === "object" ? Object.keys(f.env) : [];
    if (!names.length) continue;
    items.push({ id: `settings:claude-env:${hash(f.path)}`, area: "settings", source: f.root ? "Claude Code (project)" : "Claude Code", title: `Environment in ${tilde(f.path)}`, detail: names.slice(0, 12).join(", ") + (names.length > 12 ? `, ${names.length - 12} more` : ""),
      state: "skip", pick: false, reason: "Keel's commands run with the environment Keel was started with, and has no per-folder environment: set what a project needs in its own tooling (an .envrc)" });
  }
  if (s.statusLine) items.push({ id: "settings:claude-statusline", area: "settings", source: "Claude Code", title: "Status line", detail: String(s.statusLine.command ?? "").slice(0, 120), state: "skip", reason: "it reads Claude Code's own state; Keel shows model, context and spend in its header", pick: false });
}

// ---- Claude Code's settings files --------------------------------------------------------
// The user's (~/.claude/settings.json and settings.local.json) and each
// project's, for the folders Keel knows (its sessions' folders and its own, at
// their repository root, where Claude Code reads them): the shared
// .claude/settings.json and the personal .claude/settings.local.json.
type ClaudeFile = { file: string; path: string; root?: string; permissions?: any; hooks?: any; env?: any; error?: string };
const knownRoots = (deps: PortDeps) => [...new Set(deps.store.sessions({}).map((x) => x.workspace).concat(deps.workspace).filter(isDir).map(projectRoot))].sort();
function claudeFiles(deps: PortDeps): ClaudeFile[] {
  const H = portHome();
  const out: ClaudeFile[] = [];
  const read = (dir: string, root?: string) => {
    for (const file of ["settings.json", "settings.local.json"]) {
      const path = join(dir, ".claude", file);
      if (!existsSync(path)) continue;
      try {
        const j = readJson(path);
        out.push({ file, path, root, permissions: j?.permissions, hooks: j?.hooks, env: j?.env });
      } catch (e) { out.push({ file, path, root, error: (e as Error).message }); }
    }
  };
  read(H);
  for (const r of knownRoots(deps)) if (r !== H && r !== homeDir()) read(r, r);
  return out;
}
const rulesOf = (p: any, k: string): string[] => (p && Array.isArray(p[k]) ? p[k].filter((x: unknown) => typeof x === "string") : []);

// ---- permission rules ------------------------------------------------------------------
// Claude Code's user rules (they hold in every folder: scope /), each known
// project's rules (its repository: the owner's pick in the preview is the trust
// Claude Code asks for before a project's allow rules apply) and the Rust Keel's
// stored answers (their own folder), as Keel's gate rules (port-permissions.ts).
function planPermissions(items: Planned[], deps: PortDeps) {
  const H = portHome();
  const rc = rustConfig();
  const add = (id: string, source: string, title: string, m: Mapped, scope: string) => {
    const base = { id, area: "permissions" as const, source, title };
    if ("skip" in m) return items.push({ ...base, state: "skip", reason: m.skip, pick: false });
    if ("done" in m) return items.push({ ...base, state: "done", reason: m.done, pick: false });
    const shown = `${m.kind} ${m.pattern}${scope === "/" ? ", in every folder" : `, in ${tilde(scope)}`}`;
    if (deps.grants?.has(m.kind, m.pattern, scope)) return items.push({ ...base, detail: shown, state: "done", pick: false });
    items.push({ ...base, detail: shown, state: "new", pick: true, run: async () => {
      if (!deps.grants) throw new Error("the permission gate is not running");
      deps.grants.add(m.kind, m.pattern, scope);
      return `allowed: ${shown}`;
    } });
  };
  // Claude Code merges the rule lists of every level: a deny or ask anywhere
  // (the user's files or a project's) holds over an allow at any level, so an
  // allow of a tool held where it would apply stays out (Keel could not keep
  // the exception). User rules hold in every folder, project rules in their
  // repository (Claude Code reads them at the root).
  const files = claudeFiles(deps);
  const user = files.filter((f) => !f.root);
  const projects = files.filter((f) => f.root);
  const heldIn = (files: ClaudeFile[]) => {
    const out: { rule: string; root?: string; where: string }[] = [];
    for (const f of files) for (const r of [...rulesOf(f.permissions, "deny"), ...rulesOf(f.permissions, "ask")]) out.push({ rule: r, root: f.root, where: f.root ? tilde(f.root) : "your user settings" });
    return out;
  };
  // Only a deny or ask that can hold what the allow lets through keeps it out (overlaps).
  const holds = (held: { rule: string; root?: string; where: string }[], allow: string, base?: string) => held.find((h) => overlaps(allow, h.rule, base, h.root));
  const userHeld = heldIn(user);
  // The MCP server names Keel has or brings, to read the server a rule names.
  const servers = new Set<string>();
  try { for (const n of Object.keys(readConfig(configPath()).servers)) servers.add(n); } catch {}
  try { for (const c of importable(portHome(), {}, [])) servers.add(c.name); } catch {}
  for (const f of [...user, ...projects]) {
    const scope = f.root ?? "/";
    const source = f.root ? "Claude Code (project)" : "Claude Code";
    const key = f.root ? `claude-project:${hash(f.root)}:${f.file}` : `claude:${f.file}`;
    const where = f.root ? ` (${tilde(f.root)})` : "";
    // A user allow is held by a deny or ask in any project too: it would hold there.
    const held = f.root ? [...heldIn(projects.filter((x) => x.root === f.root)), ...userHeld] : [...userHeld, ...heldIn(projects)]; // its own level named first
    for (const kind of ["deny", "ask"] as const) for (const r of rulesOf(f.permissions, kind))
      add(`permissions:${key}:${kind}:${hash(r)}`, source, `${kind} ${r}${where}`, { skip: kind === "deny" ? "Keel's rules only allow: a call no rule allows asks, and its own checks ask for risky ones whatever the rules say" : "Keel's rules only allow: a call no rule allows asks already" }, scope);
    for (const r of rulesOf(f.permissions, "allow")) {
      const h = holds(held, r, f.root);
      const m: Mapped = h ? { skip: `${h.rule} (a deny or ask rule${h.where === (f.root ? tilde(f.root) : "your user settings") ? " there" : ` in ${h.where}`}) can hold what it allows, which Keel could not keep` } : claudeAllow(r, f.root, servers);
      add(`permissions:${key}:allow:${hash(r)}`, source, `${r}${where}`, m, scope);
    }
  }
  // The Rust Keel: its stored "always" answers, and what gate.json sets.
  if (existsSync(keelDb())) {
    let rows: { kind: string; pattern: string; scope: string }[] = [];
    try {
      const db = new Database(keelDb(), { readonly: true });
      try { rows = db.query<{ kind: string; pattern: string; scope: string }, []>("SELECT kind, pattern, scope FROM permission_rules ORDER BY created_ms").all(); } finally { db.close(); }
    } catch (e) { if (!/no such table/.test((e as Error).message)) throw e; }
    for (const r of rows) {
      const m = rustRule(r.kind, r.pattern);
      add(`permissions:keel:${hash(`${r.scope}\u0000${r.kind}\u0000${r.pattern}`)}`, "Keel (Rust)", `${r.kind} ${r.pattern}`, "kind" in m && m.kind === "edit" && !m.pattern ? { kind: "edit", pattern: r.scope } : m, r.scope);
    }
  }
  let g: any = null;
  try { g = readJson(join(rc, "gate.json")); } catch {}
  if (g?.default_mode) items.push({ id: "permissions:keel-mode", area: "permissions", source: "Keel (Rust)", title: `Default mode ${g.default_mode}`, state: "skip", pick: false, reason: "a mode, not a rule: a new session's mode stays what Settings > Permissions sets" });
  if (g?.reviewer) items.push({ id: "permissions:keel-reviewer", area: "permissions", source: "Keel (Rust)", title: `Reviewer ${g.reviewer.provider ?? ""} ${g.reviewer.model ?? ""}`.trim(), state: "skip", pick: false, reason: "a model of the Rust Keel's providers: choose Keel's reviewer in Settings > Permissions" });
}

// ---- the plan and the apply ------------------------------------------------------------

// The plan area by area, each handed to `onPart` as soon as it is read (the
// sessions index of a fresh state takes the longest: it reads meanwhile, and
// comes last). A part names the areas it covers, so the page knows what is left.
export type Part = { areas: Area[]; items: Planned[]; ms: number };
export const PARTS: Area[][] = [["instructions"], ["memory"], ["skills", "plugins"], ["mcp"], ["hooks"], ["permissions"], ["settings"], ["sessions"]];

// `only`: the areas wanted (a run of picked items reads only theirs); hooks
// need the skills part (plugins carry hooks), so it is read for them too.
export async function planParts(deps: PortDeps, opts: { days?: number; max?: number; only?: Area[] } = {}, onPart: (p: Part) => void = () => {}): Promise<Planned[]> {
  const all: Planned[] = [];
  const hooks: HookCandidate[] = [];
  const want = (areas: Area[]) => !opts.only || areas.some((a) => opts.only!.includes(a) || (a === "skills" && opts.only!.includes("hooks")));
  const part = async (areas: Area[], f: (items: Planned[]) => void | Promise<void>) => {
    if (!want(areas)) return;
    const t0 = Date.now();
    const items: Planned[] = [];
    try { await f(items); } catch (e) { items.push({ id: `${areas[0]}:error`, area: areas[0]!, source: "Keel", title: `Reading ${areas[0]}`, state: "error", reason: (e as Error).message, pick: false }); }
    all.push(...items);
    onPart({ areas, items, ms: Date.now() - t0 });
  };
  const sessions = part(["sessions"], (items) => planSessions(items, deps, { days: opts.days ?? SESSION_DAYS, max: opts.max ?? SESSION_MAX }));
  await part(["instructions"], (items) => planInstructions(items));
  await part(["memory"], (items) => planMemory(items, deps.store));
  await part(["skills", "plugins"], (items) => planSkills(items, hooks));
  await part(["mcp"], (items) => planMcp(items, deps));
  await part(["hooks"], (items) => { planHooks(items, hooks); planProjectHooks(items, deps); });
  await part(["permissions"], (items) => planPermissions(items, deps));
  await part(["settings"], (items) => planSettings(items, deps));
  await sessions;
  // The order the page shows: by area, as AREAS lists them.
  return all.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area));
}

export const planned = (deps: PortDeps, opts: { days?: number; max?: number } = {}) => planParts(deps, opts);

export const strip = ({ run: _, ...it }: Planned): Item => it;

export async function plan(deps: PortDeps, opts: { days?: number; max?: number } = {}): Promise<Plan> {
  return { home: portHome(), config: configDir(), items: (await planned(deps, opts)).map(strip) };
}

// `ids`: the items to run (default: the ones the plan picks). An item that
// fails does not stop the others.
export async function apply(deps: PortDeps, o: { ids?: string[]; areas?: Area[]; days?: number; max?: number } = {}): Promise<{ items: Applied[]; counts: Record<string, number> }> {
  // Picked items name their areas (ids start with one): only those are read again.
  const named = o.ids ? [...new Set(o.ids.map((id) => id.split(":")[0] as Area).filter((a) => AREAS.includes(a)))] : undefined;
  const only = named && o.areas ? named.filter((a) => o.areas!.includes(a)) : named ?? o.areas;
  const all = await planParts(deps, { ...o, only });
  const want = o.ids ? new Set(o.ids) : null;
  const out: Applied[] = [];
  const counts: Record<string, number> = { applied: 0, failed: 0, done: 0, skipped: 0 };
  for (const it of all) {
    const chosen = (want ? want.has(it.id) : it.pick) && (!o.areas || o.areas.includes(it.area));
    if (!chosen || !it.run || (it.state !== "new" && it.state !== "update")) {
      counts[it.state === "done" ? "done" : "skipped"]!++;
      out.push({ ...strip(it), ok: it.state !== "error" });
      continue;
    }
    try {
      out.push({ ...strip(it), ok: true, result: await it.run() });
      counts.applied!++;
    } catch (e) {
      out.push({ ...strip(it), ok: false, error: (e as Error).message });
      counts.failed!++;
    }
  }
  return { items: out, counts };
}

export const _test = { instructionBlocks, sections, blocksOf };
export type { Found };
