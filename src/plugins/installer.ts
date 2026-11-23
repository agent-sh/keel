// A plugin installed, enabled, disabled, updated and removed as one unit.
//
// prepare: the source is fetched into a folder of Keel's own and read; what
//   the plugin gives (skills, commands, agents, hooks, MCP servers), what it
//   holds that Keel does not take, how its names stand beside the owner's,
//   and every line of what it would run is said. Nothing of it runs.
// install: with the owner's yes to exactly those lines (a plugin that runs
//   nothing needs none), its copy goes under <config>/plugins/<id>/ and its
//   record into plugins.json, and its servers start.
// disable / enable: everything it brought stops or comes back at once: its
//   hooks are not read, its servers stop, its skills, commands and agents
//   are not offered.
// update: the source fetched again and what changes said first; a change
//   of what it runs asks again.
// remove: its record and its folder go. Nothing of the owner's is written:
//   not mcp.json, not hooks.json, not skills.json.
// settings: the values of its userConfig, given by the owner after it is
//   installed (src/plugins/settings.ts); its servers start with them filled
//   in, and while a required one has no value neither its servers nor its
//   hooks run.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs";
import { contains } from "../core/paths.ts";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { definitions } from "../automation/agents.ts";
import { parseHooks, projectRoot } from "../integrations/hooks.ts";
import { parseConfig, validate, type McpServerConfig } from "../mcp/config.ts";
import { carriedPlugins, discoverSkills } from "../tools/skills.ts";
import { cloneInto, copyFolder, folderDigest, folderSize, parseSource, type Source } from "./fetch.ts";
import { changes, chooseId, consentKey, entrySource, fill, fillLine, versionProblem, readMarketplace, readPlugin, resolveNames, runLine, runsOf, type HookGroups, type MarketEntry, type NotTaken, type Plugin, type Run, type Summary } from "./manifest.ts";
import { checkValue, hookRefusal, serverRefusal, shownValues, substitute, type OptionSpec, type OptionValue } from "./options.ts";
import { installedUnits, pluginsHome, readRegistry, unitOf, writeRegistry, type Unit, type UnitSource } from "./registry.ts";
import { dropSecret, forgetPlugin, loadSecrets, putSecret, valuesOf } from "./settings.ts";

// What the daemon gives the installer: the MCP servers' names and the way to start and stop a plugin's.
export type Host = {
  // Every MCP server name taken now (the owner's, the built-in ones, every plugin's), but this plugin's own.
  mcpTaken(except?: string): Set<string>;
  // `shown` on each: its config as the owner may see it, a sensitive setting not filled in.
  setServers(id: string, servers: (Unit["mcp"][number] & { shown?: Record<string, unknown> })[]): void;
  mcpState?(label: string): { state: string; tools: string[]; error?: string } | undefined;
};

export type Market = { kind: "marketplace"; token: string; input: string; name: string; owner?: string; description?: string; plugins: { name: string; description?: string; version?: string; from: string; unsupported?: string }[] };
export type Plan = {
  kind: "plugin"; token: string; input: string; id: string; name: string; version: string; description?: string; author?: string; homepage?: string;
  root: string; skills: string[]; commands: string[]; agents: string[];
  hooks: { event: string; matcher?: string; what: string }[]; mcp: { name: string; label: string; what: string }[];
  runs: string[]; consent: string | null; not_taken: NotTaken[]; notes: string[]; problems: string[];
  fetched: string[]; bytes: number;
  // The settings it asks for (its userConfig), given after it is installed.
  settings: (OptionSpec & { key: string })[];
  update?: { id: string; from: string; changes: string[]; runs_changed: boolean; same: boolean };
};

type Staged = {
  token: string; at: number; dir: string; pluginDir: string; plugin: Plugin; source: UnitSource; commit?: string; version: string; id: string;
  hooks: HookGroups; mcp: { name: string; label: string; config: McpServerConfig }[]; runs: Run[]; notTaken: NotTaken[]; notes: string[]; problems: string[];
  update?: string; offeredBy?: string; fetched: string[]; bytes: number;
};

// A prepared plugin waits this long for the owner's answer; then its copy is let go.
const STAGED_MS = 60 * 60_000;
const ROOT_WORD = "${CLAUDE_PLUGIN_ROOT}";
// A folder named on this machine is copied whole: one larger than this is not a
// plugin's folder (a home or a build tree named by mistake) and would fill the disk.
export const FOLDER_MOST = 512 * 1024 * 1024;
const safe = (v: string) => v.replace(/[^\w.+-]/g, "_").slice(0, 80);
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export class Installer {
  private staged = new Map<string, Staged | { market: true; token: string; at: number; dir: string; input: string; source: Source; commit?: string }>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private host: Host) {
    // A daemon before this one may have left a prepared copy, and a copy or a
    // version folder no record names (it stopped between the move and the write).
    void rm(join(pluginsHome(), ".staging"), { recursive: true, force: true }).catch(() => {});
    this.orphans();
  }

  private orphans() {
    const home = pluginsHome();
    let names: string[];
    try { names = readdirSync(home); } catch { return; }
    const units = new Map(installedUnits().map((u) => [u.id, u]));
    for (const n of names) {
      if (n === ".staging") continue;
      const u = units.get(n);
      if (!u) { void rm(join(home, n), { recursive: true, force: true }).catch(() => {}); continue; }
      let versions: string[] = [];
      try { versions = readdirSync(join(home, n, "versions")); } catch {}
      for (const v of versions) if (join(home, n, "versions", v) !== u.dir) void rm(join(home, n, "versions", v), { recursive: true, force: true }).catch(() => {});
    }
  }

  // One change of the record at a time: two installs never write it over each
  // other. Only the writes wait here: a read of a plugin's source (a clone that
  // can take minutes) runs beside them, so a disable is never held behind one.
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => {});
    return run;
  }

  // Every installed plugin's servers started (the daemon's start).
  startAll() {
    for (const u of installedUnits()) void this.start(u);
  }

  // A plugin's servers as its record and its settings say: none while it is
  // off or a required setting has no value, else each with the values filled in.
  private async start(u: Unit) {
    if (!u.enabled) return this.host.setServers(u.id, []);
    if (u.secrets?.length) await loadSecrets(u);
    // The record may have changed while the keyring answered: the newest one decides.
    const now = unitOf(u.id);
    if (!now || !now.enabled) return this.host.setServers(u.id, []);
    const v = valuesOf(now);
    if (v.missing.length) return this.host.setServers(u.id, []);
    this.host.setServers(u.id, now.options ? now.mcp.map((m) => ({ ...m, config: substitute(m.config, v.text), shown: substitute(m.config, shownValues(v.specs, v.text)) })) : now.mcp);
  }

  // The owner's values for a plugin's settings. `values`: key to value; an
  // empty value takes the owner's back (the default holds again). A sensitive
  // value goes to the keyring only; the record keeps that it was given.
  setValues(id: string, given: Record<string, unknown>): Promise<Unit> {
    return this.serial(async () => {
      const u = unitOf(id);
      if (!u) throw fail(404, `no plugin ${id} is installed`);
      const options = u.options ?? {};
      const values = { ...u.values };
      const secrets = new Set(u.secrets ?? []);
      const secret: [string, string | null][] = [];
      for (const [k, raw] of Object.entries(given)) {
        const o = options[k];
        if (!o) throw fail(400, `${id} has no setting ${k}`);
        const c = checkValue(o, raw);
        if (c.error) throw fail(400, `${o.title}: the value ${c.error}`);
        if (c.value !== undefined && (o.type === "directory" || o.type === "file")) {
          const path = String(c.value);
          let ok = false;
          try { const st = statSync(path); ok = o.type === "directory" ? st.isDirectory() : st.isFile(); } catch {}
          if (!path.startsWith("/") || !ok) throw fail(400, `${o.title}: ${path} is not ${o.type === "directory" ? "a folder" : "a file"} on this machine (give its full path)`);
        }
        if (o.sensitive) secret.push([k, c.value === undefined ? null : String(c.value)]);
        else if (c.value === undefined) delete values[k];
        else values[k] = c.value;
      }
      for (const [k, v] of secret) {
        if (v === null) { await dropSecret(id, k); secrets.delete(k); continue; }
        try { await putSecret(id, k, v); } catch (e) {
          throw fail(409, `the keyring did not take ${options[k]!.title} (${(e as Error).message}): a sensitive setting is kept only in the system keyring, and this machine has none that answers`);
        }
        secrets.add(k);
      }
      const reg = readRegistry();
      const next: Unit = { ...u };
      delete next.values; delete next.secrets;
      if (Object.keys(values).length) next.values = values;
      if (secrets.size) next.secrets = [...secrets].sort();
      writeRegistry({ plugins: reg.plugins.map((x) => (x.id === id ? next : x)) });
      await this.start(next);
      return next;
    });
  }

  private sweep() {
    const now = Date.now();
    for (const [t, s] of this.staged) if (now - s.at > STAGED_MS) { this.staged.delete(t); void rm(s.dir, { recursive: true, force: true }).catch(() => {}); }
  }

  private async fetch(src: Source, into: string, signal?: AbortSignal): Promise<{ commit?: string; left: string[] }> {
    if ("path" in src) {
      const n = await folderSize(src.path, FOLDER_MOST);
      if (n > FOLDER_MOST) throw fail(413, `${src.path} holds more than ${mb(FOLDER_MOST)}: that is not a plugin's folder, so it is not copied`);
      return { left: await copyFolder(src.path, into) };
    }
    return cloneInto(src.git, src.ref, into, signal);
  }

  // `input`: a folder, a git URL or owner/repo. `entry`: the plugin to take from a marketplace.
  // `signal`: the request's; when it goes away, a clone under way is ended.
  prepare(o: { input: string; entry?: string; cwd: string; update?: string; offeredBy?: string; signal?: AbortSignal }): Promise<Plan | Market> {
    return (async () => {
      this.sweep();
      const src = parseSource(o.input, o.cwd);
      if ("error" in src) throw fail(400, src.error);
      const token = randomUUID();
      const dir = join(pluginsHome(), ".staging", token);
      mkdirSync(dir, { recursive: true });
      try {
        const got = await this.fetch(src, join(dir, "source"), o.signal);
        const root = join(dir, "source");
        const fetched = ["path" in src ? `copied from the folder ${src.path}` : `cloned from ${src.git}${src.ref ? ` at ${src.ref}` : ""}`];
        const mk = readMarketplace(root);
        if (mk?.error) throw fail(400, mk.error);
        let pluginDir = root, entry: MarketEntry | undefined, commit = got.commit, sub: string | undefined;
        if (mk?.market) {
          const m = mk.market;
          if (!o.entry) {
            this.staged.set(token, { market: true, token, at: Date.now(), dir, input: o.input, source: src, commit });
            return {
              kind: "marketplace", token, input: o.input, name: m.name, ...(m.owner ? { owner: m.owner } : {}), ...(m.description ? { description: m.description } : {}),
              plugins: m.plugins.map((e) => {
                const s = entrySource(e, root, m.pluginRoot);
                return { name: e.name, ...(e.description ? { description: e.description } : {}), ...(e.version ? { version: e.version } : {}), from: "dir" in s ? relative(root, s.dir) || "." : "git" in s ? s.git : "", ...("unsupported" in s ? { unsupported: s.unsupported } : {}) };
              }),
            } satisfies Market;
          }
          entry = m.plugins.find((e) => e.name === o.entry);
          if (!entry) throw fail(404, `the marketplace ${m.name} lists no plugin named ${o.entry}`);
          const s = entrySource(entry, root, m.pluginRoot);
          if ("unsupported" in s) throw fail(400, `${entry.name}: ${s.unsupported}`);
          let top = root;
          // The links taken out of what was fetched, by where they were.
          let dropped = got.left.map((l) => join(root, l));
          if ("dir" in s) pluginDir = s.dir;
          else {
            const at = (top = join(dir, "entry"));
            const c = await cloneInto(s.git, s.ref, at, o.signal);
            commit = c.commit;
            dropped = c.left.map((l) => join(at, l));
            got.left = c.left.filter((l) => contains(resolve(at, s.sub ?? "."), join(at, l))).map((l) => relative(resolve(at, s.sub ?? "."), join(at, l)));
            fetched.push(`its plugin cloned from ${s.git}${s.ref ? ` at ${s.ref}` : ""}${s.sub ? `, the folder ${s.sub}` : ""}`);
            pluginDir = s.sub ? resolve(at, s.sub) : at;
            sub = s.sub;
          }
          // Where the folder really is, after every link: inside what was fetched, or it is not taken.
          let real: string | null = null;
          try { real = realpathSync(pluginDir); } catch {}
          if (!real) {
            // A folder that was a link out of what was fetched was not taken: that is the reason, not its absence.
            const shown = relative(top, pluginDir) || ".";
            if (dropped.some((d) => contains(d, pluginDir))) throw fail(400, `${entry.name}: its folder ${shown} is a link that leads out of what was fetched, so it was not taken`);
            throw fail(400, `${entry.name}: ${shown} is not in ${"dir" in s ? "the marketplace" : "the repository its entry names"}`);
          }
          if (!contains(realpathSync(top), real)) throw fail(400, `${entry.name}: its folder leads out of what was fetched`);
          // The links taken out of the marketplace that were the plugin's: named from its own folder.
          if ("dir" in s) got.left = got.left.filter((l) => contains(pluginDir, join(root, l))).map((l) => relative(pluginDir, join(root, l)));
        } else if (o.entry) throw fail(400, `${o.input} is a plugin, not a marketplace: it has no plugin named ${o.entry} to pick`);
        const plugin = readPlugin(pluginDir, entry);
        const bytes = await folderSize(pluginDir, Infinity);
        const version = plugin.version ?? (commit ? commit.slice(0, 12) : await folderDigest(pluginDir));
        const source: UnitSource = { input: o.input, ...("path" in src ? { path: src.path } : { git: src.git, ...(src.ref ? { ref: src.ref } : {}) }), ...(entry ? { entry: entry.name } : {}), ...(sub ? { sub } : {}) };
        // The same plugin from the same place is an update of the one installed.
        const same = installedUnits().find((u) => u.id === o.update || (!o.update && u.name === plugin.name && u.source.input === o.input && u.source.entry === source.entry));
        const others = new Set([...installedUnits().filter((u) => u !== same).map((u) => u.id), ...carriedPlugins().map((p) => p.name)]);
        const id = same?.id ?? chooseId(plugin.name, others);
        const s = this.plan({ token, at: Date.now(), dir, pluginDir, plugin, source, commit, version, id, update: same?.id, offeredBy: o.offeredBy ?? same?.offeredBy, fetched, bytes }, o.cwd, got.left);
        this.staged.set(token, s);
        return this.view(s);
      } catch (e) {
        this.staged.delete(token);
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    })();
  }

  // What the plugin brings, its names beside the owner's, and what it runs.
  private plan(b: Omit<Staged, "hooks" | "mcp" | "runs" | "notTaken" | "notes" | "problems">, cwd: string, left: string[]): Staged {
    const p = b.plugin;
    const notTaken = [...p.notTaken, ...left.map((f) => ({ part: f, why: "a link out of the plugin's folder: not copied" }))];
    const problems = [...p.problems];
    const vbad = versionProblem(b.version);
    if (vbad && !problems.includes(vbad)) problems.push(vbad);
    const own = discoverSkills(cwd).filter((s) => s.scope !== "plugin").map((s) => s.name);
    const ownAgents = definitions(cwd).filter((d) => !d.name.includes(":")).map((d) => d.name);
    const names = resolveNames({ id: b.id, skills: p.skills.map((s) => s.name), commands: p.commands.map((c) => c.name), agents: p.agents.map((a) => a.name), mcp: Object.keys(p.mcp) }, { skills: new Set(own), agents: new Set(ownAgents), mcp: this.host.mcpTaken(b.update) });
    // The plugin's servers as Keel starts them: Claude Code's shape read as mcp.json reads it.
    const mcp: Staged["mcp"] = [];
    for (const [name, raw] of Object.entries(p.mcp)) {
      const refused = serverRefusal(raw);
      if (refused) { notTaken.push({ part: `MCP server ${name}`, why: refused }); continue; }
      let config: McpServerConfig;
      try { config = parseConfig(JSON.stringify({ servers: { [name]: raw } })).servers[name]!; } catch (e) { notTaken.push({ part: `MCP server ${name}`, why: (e as Error).message }); continue; }
      // Which tools run without asking is the owner's word, never a plugin's; and a plugin's server follows no other agent's entry.
      if (config.read_tools) notTaken.push({ part: `MCP server ${name}: read_tools`, why: "which tools run without asking is yours to mark in Settings > MCP servers" });
      delete config.read_tools;
      delete config.sync;
      if ((raw as any).type === "ws") { notTaken.push({ part: `MCP server ${name}`, why: "a WebSocket server, which Keel's MCP client does not speak" }); continue; }
      const label = names.mcp[name]!;
      const bad = validate(label, config);
      if (bad) { notTaken.push({ part: `MCP server ${name}`, why: bad }); continue; }
      mcp.push({ name, label, config });
    }
    // An mcp_tool hook names a server of the plugin by its own name or by
    // Claude Code's plugin:<name>:<server>: it is held to that server of this
    // plugin (plugin:<id>:<server>, found when the hook runs), so a server of
    // the owner's that later takes the name is never the one it calls.
    const byName = new Map(mcp.flatMap((s) => [[s.name, `plugin:${b.id}:${s.name}`], [`plugin:${p.name}:${s.name}`, `plugin:${b.id}:${s.name}`]] as [string, string][]));
    // A hook that names a setting where a shell would read it again does not run (plugins-reference, "Fields that run through a shell").
    const allowed = (ev: string) => (h: any) => {
      const why = hookRefusal(h);
      if (why) notTaken.push({ part: `hook on ${ev}`, why });
      return !why;
    };
    const mapped: HookGroups = Object.fromEntries(Object.entries(p.hooks).map(([ev, groups]) => [ev, groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter(allowed(ev)).map((h: any) => (h?.type === "mcp_tool" && byName.has(h.server) ? { ...h, server: byName.get(h.server) } : h)) })).filter((g) => g.hooks.length)]));
    const parsed = parseHooks(JSON.stringify({ hooks: mapped }));
    for (const x of [...parsed.problems, ...parsed.notes]) notTaken.push({ part: "hooks", why: x });
    const hooks = parsed.groups as HookGroups;
    const runs = runsOf(hooks, Object.fromEntries(mcp.map((s) => [s.label, s.config as Record<string, unknown>])));
    return { ...b, hooks, mcp, runs, notTaken, notes: names.notes, problems };
  }

  private final(s: { id: string; version: string }) {
    const versions = join(pluginsHome(), s.id, "versions");
    const dir = join(versions, safe(s.version));
    // A folder of its own under versions/, whatever the version says.
    if (!safe(s.version) || dirname(dir) !== versions) throw fail(400, `${JSON.stringify(s.version)} is not a version Keel can keep`);
    return { dir, data: join(pluginsHome(), s.id, "data") };
  }

  private summary(u: Pick<Unit, "version" | "skills" | "commands" | "agents" | "mcp" | "notTaken" | "consent">): Summary {
    return { version: u.version, skills: u.skills.map((x) => x.name), commands: u.commands.map((x) => x.name), agents: u.agents.map((x) => x.name), mcp: u.mcp.map((x) => x.label), runs: u.consent.lines, notTaken: u.notTaken.map((n) => n.part) };
  }

  private view(s: Staged): Plan {
    const lines = s.runs.map(runLine);
    let f: { dir: string; data: string };
    try { f = this.final(s); } catch { f = { dir: "(none: its version is refused)", data: "(none)" }; }
    const shown = (l: string) => fillLine(l, { root: f.dir, data: f.data });
    const p = s.plugin;
    const ns = (n: string) => `${s.id}:${n}`;
    const plan: Plan = {
      kind: "plugin", token: s.token, input: s.source.input, id: s.id, name: p.name, version: s.version,
      ...(p.description ? { description: p.description } : {}), ...(p.author ? { author: p.author } : {}), ...(p.homepage ? { homepage: p.homepage } : {}),
      root: f.dir,
      skills: p.skills.map((x) => ns(x.name)), commands: p.commands.filter((c) => !p.skills.some((k) => k.name === c.name)).map((x) => ns(x.name)), agents: p.agents.map((x) => ns(x.name)),
      hooks: s.runs.filter((r) => r.kind === "hook").map((r) => ({ event: (r as any).event, ...((r as any).matcher ? { matcher: (r as any).matcher } : {}), what: shown(r.what) })),
      mcp: s.mcp.map((m) => ({ name: m.name, label: m.label, what: shown(s.runs.find((r) => r.kind === "mcp" && r.name === m.label)?.what ?? "") })),
      // The lines with the plugin's folders filled in; the key is of the lines as the plugin wrote them, so a new version folder is no new consent.
      runs: lines.map(shown), consent: lines.length ? consentKey(lines) : null, not_taken: s.notTaken, notes: s.notes, problems: s.problems,
      fetched: s.fetched, bytes: s.bytes,
      settings: Object.entries(p.options).map(([key, o]) => ({ key, ...o })),
    };
    if (s.update) {
      const u = unitOf(s.update)!;
      const next = this.summary({ version: s.version, skills: p.skills, commands: p.commands, agents: p.agents, mcp: s.mcp, notTaken: s.notTaken, consent: { at: 0, lines } });
      const c = changes(this.summary(u), next);
      plan.update = { id: u.id, from: u.version, changes: c.lines.map(shown), runs_changed: c.runsChanged, same: !c.lines.length && u.version === s.version };
    }
    return plan;
  }

  // The owner said yes (`consent`: the key of the lines they were shown), or the plugin runs nothing.
  install(token: string, consent: string | null | undefined): Promise<Unit> {
    return this.serial(async () => {
      const s = this.staged.get(token);
      if (!s || "market" in s) throw fail(404, "that plugin is no longer prepared: read it again");
      if (s.problems.length) throw fail(400, `it cannot be installed: ${s.problems.join("; ")}`);
      const lines = s.runs.map(runLine);
      const prev = s.update ? unitOf(s.update) : undefined;
      // The record may have changed while the owner read: an update of a plugin removed since, or another install under this id.
      if (s.update && !prev) throw fail(409, `${s.update} was removed meanwhile: read it again`);
      if (!s.update && unitOf(s.id)) throw fail(409, `another plugin was installed as ${s.id} meanwhile: read it again`);
      // An update that runs exactly what was agreed to keeps that yes.
      const agreed = prev && prev.consent.lines.join("\n") === lines.join("\n");
      if (lines.length && !agreed && consent !== consentKey(lines)) throw fail(409, `it runs ${lines.length} thing${lines.length === 1 ? "" : "s"} on this machine: say yes to exactly what was shown`);
      const { dir, data } = this.final(s);
      const vars = { root: dir, data };
      const at = (p: string) => join(dir, relative(s.pluginDir, p));
      // The copy goes in whole under its own name; a copy of the same version is replaced.
      mkdirSync(dirname(dir), { recursive: true });
      mkdirSync(data, { recursive: true });
      const trash = existsSync(dir) ? `${dir}.old-${s.token}` : null;
      if (trash) renameSync(dir, trash);
      renameSync(s.pluginDir, dir);
      const now = Date.now();
      const unit: Unit = {
        id: s.id, name: s.plugin.name, version: s.version,
        ...(s.plugin.description ? { description: s.plugin.description } : {}), ...(s.plugin.author ? { author: s.plugin.author } : {}), ...(s.plugin.homepage ? { homepage: s.plugin.homepage } : {}),
        source: s.source, ...(s.commit ? { commit: s.commit } : {}), dir, data,
        enabled: prev ? prev.enabled : true, installed: prev?.installed ?? now, updated: now,
        skills: s.plugin.skills.map((x) => ({ name: x.name, dir: at(x.dir) })),
        commands: s.plugin.commands.map((x) => ({ name: x.name, file: at(x.file) })),
        agents: s.plugin.agents.map((x) => ({ name: x.name, file: at(x.file) })),
        hooks: fill(s.hooks, vars),
        mcp: s.mcp.map((m) => {
          const c = fill(m.config, vars) as McpServerConfig;
          return { name: m.name, label: m.label, config: { ...c, env: { ...c.env, CLAUDE_PLUGIN_ROOT: dir, CLAUDE_PLUGIN_DATA: data } } as Record<string, unknown> };
        }),
        notTaken: s.notTaken, notes: s.notes,
        consent: { at: agreed ? prev!.consent.at : now, lines },
        ...(s.offeredBy ? { offeredBy: s.offeredBy } : {}),
      };
      // Its settings: the values given before that the new version still takes.
      const options = s.plugin.options;
      const dropped: string[] = [];
      if (Object.keys(options).length) {
        unit.options = options;
        const values: Record<string, OptionValue> = {};
        for (const [k, v] of Object.entries(prev?.values ?? {})) {
          const o = options[k];
          const c = o && !o.sensitive ? checkValue(o, v) : null;
          if (c?.value !== undefined) values[k] = c.value;
        }
        if (Object.keys(values).length) unit.values = values;
        const secrets = (prev?.secrets ?? []).filter((k) => options[k]?.sensitive);
        if (secrets.length) unit.secrets = secrets;
      }
      for (const k of prev?.secrets ?? []) if (!unit.secrets?.includes(k)) dropped.push(k);
      const reg = readRegistry();
      try {
        writeRegistry({ plugins: [...reg.plugins.filter((u) => u.id !== unit.id), unit] });
      } catch (e) {
        // The record was not written: the copy goes back as it was.
        renameSync(dir, s.pluginDir);
        if (trash) renameSync(trash, dir);
        throw e;
      }
      this.staged.delete(token);
      for (const k of dropped) await dropSecret(unit.id, k).catch(() => {});
      await this.start(unit);
      if (prev && prev.dir !== dir) await rm(prev.dir, { recursive: true, force: true }).catch(() => {});
      if (trash) await rm(trash, { recursive: true, force: true }).catch(() => {});
      await rm(s.dir, { recursive: true, force: true }).catch(() => {});
      return unit;
    });
  }

  // Let a prepared copy go without installing it.
  discard(token: string) {
    const s = this.staged.get(token);
    if (!s) return;
    this.staged.delete(token);
    void rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  setEnabled(id: string, enabled: boolean): Promise<Unit> {
    return this.serial(async () => {
      const reg = readRegistry();
      const u = reg.plugins.find((x) => x.id === id);
      if (!u) throw fail(404, `no plugin ${id} is installed`);
      const next = { ...u, enabled };
      if (u.enabled !== enabled) writeRegistry({ plugins: reg.plugins.map((x) => (x.id === id ? next : x)) });
      await this.start(next);
      return next;
    });
  }

  update(id: string, cwd: string, signal?: AbortSignal): Promise<Plan | Market> {
    const u = unitOf(id);
    if (!u) return Promise.reject(fail(404, `no plugin ${id} is installed`));
    return this.prepare({ input: u.source.input, entry: u.source.entry, cwd, update: id, signal });
  }

  remove(id: string): Promise<Unit> {
    return this.serial(async () => {
      const reg = readRegistry();
      const u = reg.plugins.find((x) => x.id === id);
      if (!u) throw fail(404, `no plugin ${id} is installed`);
      this.host.setServers(id, []);
      writeRegistry({ plugins: reg.plugins.filter((x) => x.id !== id) });
      for (const k of u.secrets ?? []) await dropSecret(id, k).catch(() => {});
      forgetPlugin(id);
      await rm(join(pluginsHome(), id), { recursive: true, force: true });
      return u;
    });
  }

  // The plugins a folder's repository names (Claude Code's project settings:
  // enabledPlugins, with the marketplaces they come from in
  // extraKnownMarketplaces). Offered only: one is installed when the owner says yes.
  offers(cwd: string): Offer[] {
    const root = projectRoot(cwd);
    const out: Offer[] = [];
    for (const f of [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")]) {
      let v: any;
      try { v = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
      const markets = v?.extraKnownMarketplaces && typeof v.extraKnownMarketplaces === "object" ? v.extraKnownMarketplaces : {};
      for (const [key, on] of Object.entries<any>(v?.enabledPlugins ?? {})) {
        if (on !== true || out.some((o) => o.key === key)) continue;
        const at = key.lastIndexOf("@");
        const plugin = at > 0 ? key.slice(0, at) : key, market = at > 0 ? key.slice(at + 1) : "";
        const base = { key, plugin, marketplace: market, from: f };
        const src = markets[market]?.source;
        const input = !src ? null
          : src.source === "directory" && typeof src.path === "string" ? resolve(root, src.path)
          : src.source === "github" && typeof src.repo === "string" ? `https://github.com/${src.repo}.git${src.ref ? `#${src.ref}` : ""}`
          : src.source === "git" && typeof src.url === "string" ? `${src.url}${src.ref ? `#${src.ref}` : ""}`
          : null;
        if (!input) { out.push({ ...base, problem: !market ? "it names no marketplace" : !src ? `the repository names the marketplace ${market} without saying where it is` : `the marketplace ${market} is a ${src.source} source, which Keel cannot fetch` }); continue; }
        const done = installedUnits().find((u) => u.name === plugin && u.source.entry === plugin && (u.source.input === input || u.source.path === input));
        out.push({ ...base, input, ...(done ? { installed: done.id } : {}) });
      }
    }
    return out;
  }
}

export type Offer = { key: string; plugin: string; marketplace: string; from: string; input?: string; installed?: string; problem?: string };
export { ROOT_WORD };
