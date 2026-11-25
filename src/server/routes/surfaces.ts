// What the daemon loads from files, readable and writable from Settings:
// skills, agent definitions, instruction files, the owner's hooks file and
// plugins.toml. Each write goes to a file the listing named (or the one place
// a new one belongs), a repository file the owner wrote here is trusted at
// that content, and from a remote device a write takes the passkey.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { RouteModule } from "../app.ts";
import { definitions } from "../../automation/agents.ts";
import { expandImports, instructionLimit, instructionPaths } from "../../engine/turn.ts";
import { ownerHooksPath, parseHooks } from "../../integrations/hooks.ts";
import { configDir, inConfigDir } from "../../providers/config.ts";
import { writeOwnFile } from "../../core/ownfile.ts";
import { pluginsFile } from "../../providers/plugins/config.ts";
import { rootOf } from "../../safety/trust.ts";
import { discoverSkills, listingBudget, listingOf, setSkillOff, setSkillUsage, type Skill } from "../../tools/skills.ts";
import { presence } from "./permissions.ts";
import { trustRef } from "./trust.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
// Whole or not at all. A file of Keel's own config folder keeps what it held
// as <name>.prev; a project's or another agent's folder gets no extra file.
const write = (p: string, text: string, own = inConfigDir(p)) => { writeOwnFile(p, text, { prev: own }); };
// The agentskills.io name rule, also used for agent definitions.
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_TEXT = 256 * 1024;

export const surfaceRoutes: RouteModule = (deps) => {
  const cwdOf = (req: Request, b?: Record<string, any>) => String(b?.cwd || new URL(req.url).searchParams.get("cwd") || deps.workspace);
  const needs = (req: Request) =>
    !presence || presence.allows(req, "surfaces-edit") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "surfaces-edit" } }, 428);
  // Where a trust pin stands for a repository file; null outside a repository.
  const trustOf = (cwd: string, path: string) => (rootOf(dirname(path)) ? trustRef?.files(cwd).find((f) => f.path === path)?.state ?? null : null);
  // The owner wrote it here: the repository's copy is trusted at this content.
  const pin = (cwd: string, path: string) => {
    if (!trustRef || !rootOf(dirname(path))) return;
    const f = trustRef.files(cwd).find((x) => x.path === path);
    if (f?.sha256 && f.state !== "trusted") trustRef.trust(cwd, path, f.sha256);
  };
  const text = (b: Record<string, any>) => {
    const t = b.text;
    if (typeof t !== "string") throw Object.assign(new Error("text is the file's content"), { status: 400 });
    if (t.length > MAX_TEXT) throw Object.assign(new Error(`a file here is at most ${MAX_TEXT / 1024} KB`), { status: 400 });
    return t;
  };
  const attempt = async (f: () => Response | Promise<Response>) => {
    try { return await f(); } catch (e) {
      const status = (e as any).status;
      if (status) return bad((e as Error).message, status);
      const rec = deps.errors.capture("server", e, { at: "settings file" });
      return json({ error: (e as Error).message, error_id: rec.id }, 500);
    }
  };

  // --- skills
  // How often each skill was loaded: the listing keeps the descriptions of the ones in use.
  const { store } = deps;
  store.migrate("CREATE TABLE IF NOT EXISTS skill_uses (name TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL)");
  setSkillUsage({
    uses: () => new Map(store.db.query<{ name: string; count: number }, []>("SELECT name, count FROM skill_uses").all().map((r) => [r.name, r.count])),
    record: (name) => void store.db.query("INSERT INTO skill_uses (name, count, last) VALUES (?, 1, ?) ON CONFLICT(name) DO UPDATE SET count = count + 1, last = excluded.last").run(name, Date.now()),
  });
  // The listing's budget follows the model's window: Settings shows it for the
  // default model a new session starts on (a session on another model gets its own).
  let shownFor: { model: string; window?: number } | null = null;
  const refreshShownFor = async () => {
    try {
      const id = await deps.providers.defaultModel();
      const m = (await deps.providers.models()).find((x) => x.id === id);
      shownFor = m ? { model: m.id, window: m.context_assumed ? undefined : m.context } : null;
    } catch { /* no model yet: the budget of an unstated window */ }
    return shownFor;
  };
  const skillView = (cwd: string, nameOnly: Set<string> = new Set(listingOf(cwd, shownFor?.window).nameOnly)) => (s: Skill) => ({
    name: s.name, description: s.description, scope: s.scope, kind: s.kind, root: s.root, dir: s.dir, file: s.file, enabled: s.enabled,
    user_invocable: s.userInvocable, model_invocable: s.modelInvocable, argument_hint: s.argumentHint,
    trust: s.scope === "project" ? trustOf(cwd, held(s)) : null,
    // What it costs: its line in every session's listing, and its body when loaded (about 4 characters a token).
    // A second copy of a skill file is not listed: the name of the first, and no cost.
    same: s.same ?? null,
    listing_tokens: s.modelInvocable && !s.same ? Math.ceil((s.name.length + s.description.length + 4) / 4) : 0,
    // Past the listing's budget its description is left out (the least loaded first).
    name_only: s.modelInvocable && s.enabled && !s.same && nameOnly.has(s.name),
  });
  const held = (s: Skill) => (s.kind === "command" ? s.file : s.dir);
  const skillHome = (cwd: string, scope: string) => (scope === "project" ? join(rootOf(cwd) ?? cwd, ".agents", "skills") : join(configDir(), "skills"));
  const findSkill = (cwd: string, name: string) => discoverSkills(cwd).find((s) => s.name === name);

  // --- agent definitions
  const agentView = (cwd: string) => definitions(cwd).map((d) => ({
    name: d.name, description: d.description, source: d.source, file: d.file ?? null, model: d.model ?? null,
    tools: d.tools ?? null, disallowed: d.disallowed ?? null, permission_mode: d.permissionMode ?? null, isolation: d.isolation ?? null,
    read_only: !!d.readOnly, trust: d.file && d.source === "project" ? trustOf(cwd, d.file) : null,
    format: d.format ?? "markdown", effort: d.effort ?? null,
    max_turns: d.maxTurns ?? null, skills: d.skills ?? null, mcp_servers: d.mcpServers ?? null, own_servers: d.ownServers ?? null, memory: d.memory ?? null, not_carried: d.notTaken ?? null,
  }));
  // A Codex agent file is checked before it is written: TOML with its three required keys.
  const codexFault = (t: string) => {
    try {
      const v = Bun.TOML.parse(t) as Record<string, unknown>;
      const missing = ["name", "description", "developer_instructions"].filter((k) => typeof v[k] !== "string" || !(v[k] as string).trim());
      return missing.length ? `a Codex agent file needs ${missing.join(", ")}` : null;
    } catch (e) { return `not TOML: ${(e as Error).message}`; }
  };

  // --- instruction files
  const instructionView = (cwd: string) => {
    const files = instructionPaths(cwd).map(({ path, scope }) => {
      const t = read(path) ?? "";
      // What the prompt carries of it: its @path lines brought in (outside a repository), cut where a 200K window cuts it (instructionLimit).
      const loaded = rootOf(dirname(path)) ? t : expandImports(t, path);
      return {
        path, scope, text: t, sha256: sha(t), bytes: Buffer.byteLength(t), loaded: loaded.slice(0, instructionLimit()), loaded_tokens: Math.ceil(Math.min(loaded.length, instructionLimit()) / 4),
        imports: loaded !== t, truncated: loaded.length > instructionLimit(), trust: scope === "owner" ? null : trustOf(cwd, path),
      };
    });
    const create: { path: string; scope: string }[] = [];
    const own = join(configDir(), "AGENTS.md");
    if (!files.some((f) => f.path === own)) create.push({ path: own, scope: "owner" });
    if (!files.some((f) => f.scope === "folder")) create.push({ path: join(cwd, "AGENTS.md"), scope: "folder" });
    return { cwd, files, create };
  };

  // --- plugins.toml
  const pluginView = () => {
    const own = join(configDir(), "plugins.toml");
    const file = pluginsFile();
    return { file, own, text: file ? read(file) ?? "" : "", borrowed: !!file && file !== own, error: deps.providers.plugins.error ?? null };
  };

  return {
    "/api/skills": {
      GET: async (req: Request) => {
        const cwd = cwdOf(req);
        const f = await refreshShownFor();
        const fit = listingOf(cwd, f?.window);
        return json({
          cwd, skills: discoverSkills(cwd).map(skillView(cwd, new Set(fit.nameOnly))), homes: { personal: skillHome(cwd, "personal"), project: skillHome(cwd, "project") },
          listing: { model: f?.model ?? null, window: f?.window ?? null, budget: listingBudget(f?.window), name_only: fit.nameOnly.length },
        });
      },
      // { cwd, name, scope: personal | project, description }: a new SKILL.md.
      POST: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const cwd = cwdOf(req, b);
        const name = String(b.name ?? "").trim();
        if (!NAME.test(name)) return bad("a skill name is lower-case letters, digits and hyphens, up to 64");
        if (findSkill(cwd, name)) return bad(`a skill named ${name} exists already`, 409);
        const description = String(b.description ?? "").trim().replace(/\s+/g, " ");
        if (!description) return bad("say when the skill applies: the model reads only that before it loads one");
        const file = join(skillHome(cwd, b.scope === "project" ? "project" : "personal"), name, "SKILL.md");
        if (existsSync(file)) return bad(`${file} exists already`, 409);
        write(file, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${String(b.body ?? "").trim() || "What to do, step by step, when this skill applies."}\n`);
        pin(cwd, dirname(file));
        return json({ skill: skillView(cwd)(findSkill(cwd, name)!) });
      }),
    },
    "/api/skills/:name": {
      GET: (req: any) => {
        const cwd = cwdOf(req);
        const s = findSkill(cwd, req.params.name);
        if (!s) return bad(`no skill named ${req.params.name}`, 404);
        const t = read(s.file) ?? "";
        return json({ skill: skillView(cwd)(s), text: t, sha256: sha(t), body_tokens: Math.ceil(t.length / 4) });
      },
      PUT: (req: any) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const cwd = cwdOf(req, b);
        const s = findSkill(cwd, req.params.name);
        if (!s) return bad(`no skill named ${req.params.name}`, 404);
        write(s.file, text(b));
        if (s.scope === "project") pin(cwd, held(s));
        const t = read(s.file) ?? "";
        return json({ skill: skillView(cwd)(findSkill(cwd, req.params.name) ?? s), text: t, sha256: sha(t) });
      }),
    },
    "/api/skills/:name/toggle": {
      POST: (req: any) => attempt(async () => {
        const b = await body(req);
        const cwd = cwdOf(req, b);
        if (!findSkill(cwd, req.params.name)) return bad(`no skill named ${req.params.name}`, 404);
        setSkillOff(req.params.name, b.enabled === false);
        return json({ skills: discoverSkills(cwd).map(skillView(cwd)) });
      }),
    },

    "/api/agents/files": {
      GET: (req: Request) => {
        const cwd = cwdOf(req);
        return json({ cwd, agents: agentView(cwd), homes: { owner: join(configDir(), "agents"), project: join(rootOf(cwd) ?? cwd, ".claude", "agents") } });
      },
      // { cwd, name, scope: owner | project, description }: a new definition file.
      POST: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const cwd = cwdOf(req, b);
        const name = String(b.name ?? "").trim();
        if (!NAME.test(name)) return bad("an agent name is lower-case letters, digits and hyphens, up to 64");
        if (definitions(cwd).some((d) => d.name === name)) return bad(`an agent named ${name} exists already`, 409);
        const description = String(b.description ?? "").trim().replace(/\s+/g, " ");
        if (!description) return bad("say when to use the agent: the model picks agents by it");
        const file = b.scope === "project" ? join(rootOf(cwd) ?? cwd, ".claude", "agents", `${name}.md`) : join(configDir(), "agents", `${name}.md`);
        write(file, `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${String(b.body ?? "").trim() || "You are a subagent. Your task and how to report it."}\n`);
        pin(cwd, file);
        return json({ agents: agentView(cwd) });
      }),
      // { cwd, name, text }: the definition's file, rewritten.
      PUT: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const cwd = cwdOf(req, b);
        const d = definitions(cwd).find((x) => x.name === b.name);
        if (!d) return bad(`no agent named ${b.name}`, 404);
        if (!d.file) return bad(`${d.name} is built in: write a file of the same name to change it`, 409);
        const fault = d.format === "codex" ? codexFault(text(b)) : null;
        if (fault) return bad(fault);
        write(d.file, text(b));
        if (d.source === "project") pin(cwd, d.file);
        return json({ agents: agentView(cwd) });
      }),
    },
    "/api/agents/file": {
      GET: (req: Request) => {
        const cwd = cwdOf(req);
        const name = new URL(req.url).searchParams.get("name");
        const d = definitions(cwd).find((x) => x.name === name);
        if (!d) return bad(`no agent named ${name}`, 404);
        return json({ name: d.name, file: d.file ?? null, text: d.file ? read(d.file) ?? "" : `${d.description}\n\n${d.body ?? ""}`.trim() });
      },
    },

    "/api/instructions": {
      GET: (req: Request) => json(instructionView(cwdOf(req))),
      // { cwd, path, text }: a file the session loads, or the one place a new one goes.
      PUT: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const cwd = cwdOf(req, b);
        const v = instructionView(cwd);
        const path = String(b.path ?? "");
        const hit = v.files.find((f) => f.path === path) ?? v.create.find((f) => f.path === path);
        if (!hit) return bad("that file is not one this folder's sessions load", 404);
        write(path, text(b));
        if (hit.scope !== "owner") pin(cwd, path);
        return json(instructionView(cwd));
      }),
    },

    // The owner's hooks file: JSON in the hooks.json shape, checked before it is written.
    "/api/hooks/owner": {
      GET: () => {
        const path = ownerHooksPath();
        return json({ path, text: read(path), template: `{\n  "hooks": {\n    "PreToolUse": [\n      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo checked" }] }\n    ]\n  }\n}\n` });
      },
      PUT: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const t = text(await body(req));
        try { JSON.parse(t); } catch (e) { return bad(`not JSON: ${(e as Error).message}`); }
        const { problems, notes } = parseHooks(t);
        write(ownerHooksPath(), t, true);
        return json({ path: ownerHooksPath(), text: t, problems, notes });
      }),
    },

    // plugins.toml (protocol v1). Without keel-bun's own file the Rust Keel's
    // is read; saving writes keel-bun's own, and the plugins restart from it.
    "/api/plugins": {
      GET: () => json(pluginView()),
      PUT: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const t = text(await body(req));
        try { Bun.TOML.parse(t); } catch (e) { return bad(`not TOML: ${(e as Error).message}`); }
        write(join(configDir(), "plugins.toml"), t);
        await deps.providers.refresh();
        return json(pluginView());
      }),
    },
  };
};
