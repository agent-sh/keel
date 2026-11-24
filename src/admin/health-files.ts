// The health check's walk over the owner's skill, command, agent and plugin
// files: what each folder holds, what is wrong with a file (health-file-rules.ts),
// and which file hides another of the same name. It runs on the read thread
// (src/server/read-tasks.ts, "health.files"), so a large skills folder never
// holds the loop. The folders come from the daemon in the order its readers
// walk them (src/tools/skills.ts, src/automation/agents.ts); nothing here
// writes, and nothing runs what a file says.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readPlugin } from "../plugins/manifest.ts";
import { fileFindings, type FileKind } from "./health-file-rules.ts";
import type { Level } from "./health-rows.ts";

export type Folder = {
  dir: string;
  kind: FileKind;
  // Where it comes from: personal, project, plugin, or a folder the owner added.
  layer: string;
  // A folder of folders of skills (the owner's category folders), walked three deep.
  nested?: boolean;
  exclude?: string[];
  // A plugin's names come with its prefix: `<plugin>:<name>`.
  prefix?: string;
};
export type PluginAsk = { id: string; dir: string; files: { kind: FileKind; file: string; name: string }[] };
export type FilesAsk = {
  folders: Folder[];
  plugins: PluginAsk[];
  // Names of the agents Keel brings itself: a repository's file never takes one.
  builtins: string[];
  // The owner's JSON config files: each, when it is there, must be a JSON object.
  json?: string[];
  // The most files read in one check.
  max?: number;
};
export type FileFinding = {
  // `settings`: one file hides another; `files`: a file that is wrong.
  group: "files" | "settings";
  level: Level;
  kind: FileKind | "plugin" | "config";
  path: string;
  name: string;
  layer: string;
  why: string;
  fix: string;
};
export type FilesResult = { findings: FileFinding[]; counts: Record<"skill" | "command" | "agent" | "plugin" | "config", number>; truncated: boolean };

const MAX_FILES = 5000;
const READ_MAX = 1_000_000;
const list = (dir: string): string[] => { try { return readdirSync(dir).sort(); } catch { return []; } };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const nameOf = (text: string): string | undefined => {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  const m = /^name:[ \t]*(.*)$/m.exec(end < 0 ? "" : text.slice(0, end));
  return m?.[1]?.trim().replace(/^(["'])([\s\S]*)\1$/, "$2") || undefined;
};

type Item = { kind: FileKind; file: string; layer: string; fallback: string; prefix: string };

// The files a folder holds, in the order the readers take them.
function itemsOf(f: Folder): Item[] {
  const out: Item[] = [];
  const prefix = f.prefix ?? "";
  if (f.kind === "skill") {
    const skip = new Set(f.exclude ?? []);
    const walk = (dir: string, depth: number) => {
      for (const n of list(dir)) {
        if (n.startsWith(".") || n === "synced" || skip.has(n)) continue;
        const d = join(dir, n);
        if (isFile(join(d, "SKILL.md"))) out.push({ kind: "skill", file: join(d, "SKILL.md"), layer: f.layer, fallback: n, prefix });
        else if (f.nested && depth < 3) walk(d, depth + 1);
      }
    };
    walk(f.dir, 0);
  } else {
    const ext = f.kind === "codex agent" ? ".toml" : ".md";
    for (const n of list(f.dir)) if (n.endsWith(ext) && !n.startsWith(".")) out.push({ kind: f.kind, file: join(f.dir, n), layer: f.layer, fallback: n.slice(0, -ext.length), prefix });
  }
  return out;
}

export function scanFiles(ask: FilesAsk): FilesResult {
  const findings: FileFinding[] = [];
  const counts = { skill: 0, command: 0, agent: 0, plugin: 0, config: 0 };
  const max = ask.max ?? MAX_FILES;
  let read = 0, truncated = false;
  const text = (file: string): { text: string; size: number } | { error: string } => {
    try {
      const size = statSync(file).size;
      const t = readFileSync(file, "utf8");
      return { text: size > READ_MAX ? t.slice(0, READ_MAX) : t, size };
    } catch (e) { return { error: (e as Error).message }; }
  };
  // Check one file; returns the name it goes by.
  const check = (it: { kind: FileKind; file: string; layer: string; fallback: string; prefix: string }): string | undefined => {
    if (read >= max) { truncated = true; return undefined; }
    read++;
    const t = text(it.file);
    if ("error" in t) {
      findings.push({ group: "files", level: "broken", kind: it.kind, path: it.file, name: it.fallback, layer: it.layer, why: `it cannot be read: ${t.error}`, fix: "fix the file's permissions, or delete it" });
      return undefined;
    }
    counts[it.kind === "codex agent" ? "agent" : it.kind]++;
    const name = it.prefix + ((it.kind === "skill" || it.kind === "agent" ? nameOf(t.text) : undefined) ?? it.fallback);
    for (const f of fileFindings(it.kind, t.text, t.size)) findings.push({ group: "files", level: f.level, kind: it.kind, path: it.file, name, layer: it.layer, why: f.why, fix: f.fix });
    return name;
  };

  // Skills and commands: a name is taken by the first file that holds it (a skill before a command).
  const taken = new Map<string, string>();
  const seenReal = new Set<string>();
  const agents: { name: string; file: string; layer: string; r: string }[] = [];
  for (const folder of ask.folders) {
    for (const it of itemsOf(folder)) {
      const r = real(it.file);
      if (it.kind === "skill" || it.kind === "command") {
        if (seenReal.has(r)) continue;
        seenReal.add(r);
        const name = check(it);
        if (!name) continue;
        const first = taken.get(name);
        if (first) findings.push({ group: "settings", level: "warning", kind: it.kind, path: it.file, name, layer: it.layer, why: `${name} is never offered: ${first} has the same name and is read first`, fix: "rename or delete one of the two" });
        else taken.set(name, it.file);
      } else {
        const name = check(it);
        if (!name) continue;
        if (it.layer === "project" && ask.builtins.includes(name)) {
          findings.push({ group: "settings", level: "warning", kind: it.kind, path: it.file, name, layer: it.layer, why: `${name} is ignored: a repository's file never takes the name of an agent Keel brings itself`, fix: "give the agent another name" });
          continue;
        }
        agents.push({ name, file: it.file, layer: it.layer, r });
      }
    }
  }
  // Agents: a later file takes the name from an earlier one (the owner's, then the repository's, nearest last).
  const last = new Map<string, { file: string; r: string }>();
  for (const a of agents) last.set(a.name, { file: a.file, r: a.r });
  for (const a of agents) {
    const l = last.get(a.name)!;
    if (l.r !== a.r) findings.push({ group: "settings", level: "warning", kind: "agent", path: a.file, name: a.name, layer: a.layer, why: `${a.name} is replaced by ${l.file}, which has the same name and is read later`, fix: "rename or delete one of the two" });
  }

  // The JSON files of the owner's config folder.
  for (const path of ask.json ?? []) {
    const t = text(path);
    if ("error" in t) { if (isFile(path)) findings.push({ group: "files", level: "broken", kind: "config", path, name: basename(path), layer: "owner", why: `it cannot be read: ${t.error}`, fix: "fix the file's permissions" }); continue; }
    counts.config++;
    let v: unknown;
    try { v = JSON.parse(t.text); } catch (e) {
      findings.push({ group: "files", level: "broken", kind: "config", path, name: basename(path), layer: "owner", why: `it is not valid JSON: ${(e as Error).message}`, fix: "fix the JSON, or move the file aside: Keel then uses its defaults" });
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) findings.push({ group: "files", level: "broken", kind: "config", path, name: basename(path), layer: "owner", why: "it is JSON, but not an object", fix: "make the file one JSON object, or move it aside" });
  }

  // Plugins Keel installed: the folder, the manifest, and each file it lists.
  for (const p of ask.plugins) {
    counts.plugin++;
    if (!isDir(p.dir)) {
      findings.push({ group: "files", level: "broken", kind: "plugin", path: p.dir, name: p.id, layer: "plugin", why: "its folder is gone", fix: "remove the plugin and install it again" });
      continue;
    }
    try {
      for (const why of readPlugin(p.dir).problems) findings.push({ group: "files", level: "broken", kind: "plugin", path: p.dir, name: p.id, layer: "plugin", why, fix: "update the plugin, or remove it and install it again" });
    } catch (e) {
      findings.push({ group: "files", level: "broken", kind: "plugin", path: p.dir, name: p.id, layer: "plugin", why: `its manifest cannot be read: ${(e as Error).message}`, fix: "update the plugin, or remove it and install it again" });
    }
    for (const f of p.files) {
      if (!isFile(f.file)) { findings.push({ group: "files", level: "broken", kind: f.kind, path: f.file, name: `${p.id}:${f.name}`, layer: "plugin", why: "the plugin lists this file and it is gone", fix: "update the plugin, or remove it and install it again" }); continue; }
      check({ kind: f.kind, file: f.file, layer: "plugin", fallback: f.name, prefix: `${p.id}:` });
    }
  }
  return { findings, counts, truncated };
}

