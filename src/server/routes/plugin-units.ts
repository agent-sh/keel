// Plugins installed as one unit (src/plugins/installer.ts): Settings >
// Plugins and `keel plugin install|list|enable|disable|update|remove`.
// Reading a plugin runs nothing; installing one that runs something takes
// the owner's yes to exactly the lines shown, and from a remote device the
// passkey too.
import type { McpManager } from "../../mcp/manager.ts";
import { Installer, type Plan } from "../../plugins/installer.ts";
import { fillLine, runsOf } from "../../plugins/manifest.ts";
import { installedUnits, pluginsHome, registryPath, unitOf, type Unit } from "../../plugins/registry.ts";
import { valuesOf } from "../../plugins/settings.ts";
import type { RouteModule } from "../app.ts";
import { presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, any>;

export const pluginUnitRoutes: RouteModule = (deps) => {
  const mcp = () => (globalThis as { __keelMcp?: McpManager }).__keelMcp;
  const installer = new Installer({
    mcpTaken: (except) => mcp()?.takenNames(except) ?? new Set(),
    setServers: (id, servers) => mcp()?.setPluginServers(id, servers),
  });
  installer.startAll();
  const cwdOf = (req: Request, b?: Record<string, any>) => String(b?.cwd || new URL(req.url).searchParams.get("cwd") || deps.workspace);
  const needs = (req: Request) => (!presence || presence.allows(req, "plugins-install") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "plugins-install" } }, 428));
  const attempt = async (f: () => Promise<Response>) => {
    try { return await f(); } catch (e) {
      const status = (e as any).status;
      if (status) return bad((e as Error).message, status);
      const rec = deps.errors.capture("server", e, { at: "plugins" });
      return json({ error: (e as Error).message, error_id: rec.id }, 500);
    }
  };

  // A plugin as the page and the command line show it, with its servers as they are now.
  const view = (u: Unit) => {
    // Its settings: a plain value as given, a sensitive one only whether it was given.
    const v = valuesOf(u);
    const hold = u.enabled && v.missing.length > 0;
    const settings = Object.entries(v.specs).map(([key, o]) => ({
      key, ...o, ...(o.sensitive ? { set: (u.secrets ?? []).includes(key) } : { value: u.values?.[key] ?? null, set: u.values?.[key] !== undefined }),
    }));
    const live = new Map((mcp()?.list() ?? []).filter((s) => s.plugin === u.id).map((s) => [s.name, s]));
    const servers = (mcp()?.list() ?? []).filter((s) => s.plugin === u.id);
    return {
      id: u.id, name: u.name, version: u.version, description: u.description ?? null, author: u.author ?? null, homepage: u.homepage ?? null,
      source: u.source.input, entry: u.source.entry ?? null, commit: u.commit ?? null, dir: u.dir, data: u.data,
      enabled: u.enabled, installed: u.installed, updated: u.updated, offered_by: u.offeredBy ?? null,
      skills: u.skills.map((s) => `${u.id}:${s.name}`),
      commands: u.commands.filter((c) => !u.skills.some((s) => s.name === c.name)).map((c) => `${u.id}:${c.name}`),
      agents: u.agents.map((a) => `${u.id}:${a.name}`),
      hooks: runsOf(u.hooks ?? {}, {}).map((r) => ({ event: (r as any).event, matcher: (r as any).matcher ?? null, what: r.what })),
      mcp: u.mcp.map((m) => {
        const s = live.get(m.label) ?? servers.find((x) => x.name.startsWith(`${u.id}-${m.name}`));
        return { name: m.name, label: s?.name ?? m.label, what: runsOf({}, { [m.label]: m.config })[0]?.what ?? "", state: !u.enabled ? "disabled" : hold ? "waiting" : s?.state ?? "missing", tools: s?.tool_names ?? [], error: s?.error ?? null };
      }),
      settings, waiting: hold ? v.missing : [],
      not_taken: u.notTaken, notes: u.notes, runs: u.consent.lines.map((l) => fillLine(l, { root: u.dir, data: u.data })),
    };
  };
  const listing = (cwd: string) => ({ plugins: installedUnits().map(view), offers: installer.offers(cwd), home: pluginsHome(), registry: registryPath() });

  return {
    "/api/plugins/installed": {
      GET: (req: Request) => json(listing(cwdOf(req))),
    },
    // { input, entry?, cwd?, offered_by? }: the plugin read and said, nothing of it run.
    "/api/plugins/prepare": {
      POST: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const input = String(b.input ?? "").trim();
        if (!input) return bad("give a folder, a git URL or owner/repo");
        return json(await installer.prepare({ input, ...(b.entry ? { entry: String(b.entry) } : {}), cwd: cwdOf(req, b), ...(b.offered_by ? { offeredBy: String(b.offered_by) } : {}), signal: req.signal }));
      }),
    },
    // { token, consent }: `consent` is the key of the lines the owner said yes to.
    "/api/plugins/install": {
      POST: (req: Request) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const u = await installer.install(String(b.token ?? ""), typeof b.consent === "string" ? b.consent : null);
        return json({ plugin: view(u), ...listing(cwdOf(req, b)) });
      }),
    },
    "/api/plugins/discard": {
      POST: async (req: Request) => { installer.discard(String((await body(req)).token ?? "")); return json({ ok: true }); },
    },
    // { enabled }: everything it brought starts or stops at once.
    "/api/plugins/installed/:id/enable": {
      POST: (req: any) => attempt(async () => {
        const b = await body(req);
        if (b.enabled !== false) { const guard = needs(req); if (guard) return guard; }
        const u = await installer.setEnabled(req.params.id, b.enabled !== false);
        return json({ plugin: view(u), ...listing(cwdOf(req, b)) });
      }),
    },
    // { values: { KEY: value } }: the owner's values for its settings; an empty one takes the owner's back.
    "/api/plugins/installed/:id/settings": {
      POST: (req: any) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (!b.values || typeof b.values !== "object" || Array.isArray(b.values)) return bad("give the values as an object of setting to value");
        const u = await installer.setValues(req.params.id, b.values);
        return json({ plugin: view(u), ...listing(cwdOf(req, b)) });
      }),
    },
    // What its source holds now, said before anything changes; installing the answer applies it.
    "/api/plugins/installed/:id/update": {
      POST: (req: any) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const p = await installer.update(req.params.id, cwdOf(req, b), req.signal);
        if (p.kind === "plugin" && (p as Plan).update?.same) installer.discard(p.token);
        return json(p);
      }),
    },
    "/api/plugins/installed/:id": {
      GET: (req: any) => { const u = unitOf(req.params.id); return u ? json({ plugin: view(u) }) : bad(`no plugin ${req.params.id} is installed`, 404); },
      DELETE: (req: any) => attempt(async () => {
        const guard = needs(req);
        if (guard) return guard;
        const u = await installer.remove(req.params.id);
        return json({ removed: u.id, ...listing(cwdOf(req)) });
      }),
    },
  };
};
