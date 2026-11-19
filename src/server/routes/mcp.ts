import type { RouteModule } from "../app.ts";
import { McpManager } from "../../mcp/manager.ts";
import { installMcpTools } from "../../mcp/tools.ts";
import { installChromeBridge } from "../../integrations/chrome.ts";
import { installPhone } from "../../integrations/phone.ts";
import { readConfig, type McpServerConfig } from "../../mcp/config.ts";
import { importHome } from "../../mcp/sources.ts";
import { catalogSources, catalogTools } from "../../tools/catalog.ts";
import { score } from "../../mcp/tools.ts";
import { presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);

const page = (title: string, text: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
      `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p style="opacity:.7">${text}</p></div>` +
      `<script>setTimeout(() => window.close(), 1500)</script>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const mcpRoutes: RouteModule = (deps) => {
  // Under `bun --hot` this module runs again: close the old servers first.
  const g = globalThis as { __keelMcp?: McpManager };
  g.__keelMcp?.dispose();
  const m = new McpManager(deps.errors, deps.store.stateDir, deps.workspace);
  g.__keelMcp = m;
  installMcpTools(m);
  installChromeBridge(m);
  installPhone(m);
  m.start();
  // A deleted or archived session lets go of what a bundled server held for it (tabs).
  (g as any).__keelMcpOff?.();
  (g as any).__keelMcpOff = deps.bus.on((f) => { if (f.t === "session" && f.session.archived) m.releaseSession(f.session.id); });

  const servers = () => json({ servers: m.list() });
  const known = (name: string) => (m.has(name) ? null : bad(`no MCP server named ${name}`, 404));
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  // A server that is a command runs a program as the owner: from a remote device that takes the passkey.
  const needs = (req: Request) => (!presence || presence.allows(req, "mcp-command") ? null : json({ error: "this needs your passkey from a remote device", presence: { action: "mcp-command" } }, 428));

  return {
    "/api/mcp/servers": {
      GET: servers,
      POST: async (req: Request) => {
        const b = await body(req);
        if (b.command) { const guard = needs(req); if (guard) return guard; }
        const cfg: McpServerConfig = b.command
          ? { command: b.command, args: b.args, env: b.env, cwd: b.cwd }
          : { url: b.url, headers: b.headers, bearer_env: b.bearer_env, oauth: b.oauth, headers_helper: typeof b.headers_helper === "string" && b.headers_helper.trim() ? b.headers_helper : undefined };
        // A headers helper is a command too: from a remote device it takes the passkey.
        if (cfg.headers_helper) { const guard = needs(req); if (guard) return guard; }
        if (b.enabled === false) cfg.enabled = false;
        if (b.timeout_secs) cfg.timeout_secs = Number(b.timeout_secs);
        if (b.tool_timeout_secs ?? b.max_timeout_secs) cfg.tool_timeout_secs = Number(b.tool_timeout_secs ?? b.max_timeout_secs);
        for (const k of Object.keys(cfg) as (keyof McpServerConfig)[]) if (cfg[k] === undefined) delete cfg[k];
        if (b.command && b.url) return bad("give either command or url");
        const err = m.add(String(b.name ?? ""), cfg);
        return err ? bad(err) : servers();
      },
    },
    "/api/mcp/servers/:name": {
      DELETE: (req: any) =>
        known(req.params.name) ?? (m.isBundled(req.params.name) ? bad(`${req.params.name} is built in: turn it off instead`, 409) : (m.remove(req.params.name), servers())),
    },
    // The owner marks tools of a server as reads; a remote device needs the passkey.
    "/api/mcp/servers/:name/reads": {
      PUT: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        if (!Array.isArray(b.tools)) return bad("tools is a list of tool names");
        try { m.setReads(req.params.name, b.tools); } catch (e) { return bad((e as Error).message, 409); }
        return servers();
      },
    },
    "/api/mcp/servers/:name/toggle": {
      POST: async (req: any) => known(req.params.name) ?? (m.toggle(req.params.name, (await body(req)).enabled !== false), servers()),
    },
    "/api/mcp/servers/:name/reconnect": {
      POST: async (req: any) => known(req.params.name) ?? (await m.reconnect(req.params.name), servers()),
    },
    "/api/mcp/servers/:name/sign-in": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const s = m.list().find((x) => x.name === req.params.name)!;
        if (!s.sign_in) return bad(`${s.name} has no sign-in`);
        const origin = new URL(req.url).origin;
        return json({ url: await m.signIn(s.name, `${origin}/api/mcp/oauth/callback`) });
      },
    },
    "/api/mcp/servers/:name/sign-out": {
      POST: (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        if (!m.list().find((x) => x.name === req.params.name)!.sign_in) return bad(`${req.params.name} has no sign-in`);
        m.signOut(req.params.name);
        return servers();
      },
    },
    "/api/mcp/oauth/callback": {
      GET: async (req: Request) => {
        try {
          const name = await m.finishSignIn(new URL(req.url).searchParams);
          return page("Signed in", `${escape(name)} is connected. You can close this tab.`);
        } catch (e) {
          deps.errors.capture("server", e, { at: "mcp oauth callback" });
          return page("Sign-in failed", escape((e as Error).message));
        }
      },
    },
    // The redirect pasted by hand (a browser on another device).
    "/api/mcp/sign-in/finish": {
      POST: async (req: Request) => {
        const r = String((await body(req)).redirect ?? "");
        const q = new URLSearchParams(r.includes("?") ? r.slice(r.indexOf("?") + 1) : r);
        if (!q.get("state")) return bad("the redirect carries no state");
        try {
          const server = await m.finishSignIn(q);
          return json({ server, servers: m.list() });
        } catch (e) {
          return bad((e as Error).message);
        }
      },
    },
    "/api/mcp/reload": {
      POST: async (req: Request) => {
        const b = await body(req);
        try {
          // a server only in the file may be reloaded into existence
          if (b.server && !m.has(b.server) && !(b.server in readConfig().servers)) return bad(`no MCP server named ${b.server}`, 404);
          const reload = m.reload(b.server || undefined);
          // Phone control has no file entry: a reload asks the gateway again.
          reload.servers.push(...(await m.checkLive(b.server || undefined)));
          const changed = reload.servers.filter((s) => s.change !== "unchanged");
          const line = changed.length ? `MCP reloaded: ${changed.map((s) => `${s.name} ${s.change}`).join(", ")}.` : "MCP reloaded: nothing changed.";
          return json({ reload, line, servers: m.list() });
        } catch (e) {
          return bad(`mcp.json: ${(e as Error).message}`);
        }
      },
    },
    "/api/mcp/search": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const offset = Number(u.get("offset") ?? 0);
        const limit = Number(u.get("limit") ?? 20);
        if (!Number.isFinite(offset) || !Number.isFinite(limit)) return bad("offset and limit are numbers");
        const q = u.get("q") ?? "";
        const all = (await catalogTools()).filter((t) => !t.hidden);
        const hits = all.map((t) => ({ t, s: score(t, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.t);
        const tools = hits.slice(offset, offset + limit).map((t) => ({ server: t.server, name: t.name, qualified_name: t.qualified, description: t.description, input_schema: t.input_schema }));
        const pending = catalogSources().flatMap((s) => s.pending?.() ?? []);
        return json({
          tools,
          total: hits.length,
          next_offset: hits.length > offset + limit ? offset + limit : undefined,
          pending_servers: pending.length ? pending : undefined,
          total_deferred: all.length,
        });
      },
    },
    // Env values can hold secrets: the listing names the keys, import copies the values server-side.
    "/api/mcp/importable": {
      // A listing also brings the copies in step (the watch can miss a folder made since).
      GET: () => { m.syncSources(); const failed: { file: string; error: string }[] = []; return json({
        failed,
        home: importHome(),
        servers: m.importable(failed).map((i) => ({
          ...i,
          config: { ...i.config, env: i.config.env ? Object.fromEntries(Object.keys(i.config.env).map((k) => [k, "***"])) : undefined, headers: i.config.headers ? Object.fromEntries(Object.keys(i.config.headers).map((k) => [k, "***"])) : undefined },
        })),
      }); },
    },
    "/api/mcp/import": {
      POST: async (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        const b = await body(req);
        const err = m.importFrom(String(b.source ?? ""), String(b.name ?? ""), b.as ? String(b.as) : undefined);
        return err ? bad(err) : servers();
      },
    },
    // Every server the other agents hold that Keel does not, in one step.
    "/api/mcp/import-all": {
      POST: (req: Request) => {
        const guard = needs(req);
        if (guard) return guard;
        return json({ ...m.importAll(), servers: m.list() });
      },
    },
    // Read the other agents' files now (the daemon also watches them).
    "/api/mcp/sync": {
      POST: () => {
        const changed = m.syncSources();
        return json({ changed, servers: m.list() });
      },
    },
    "/api/mcp/servers/:name/resources": {
      GET: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const q = new URL(req.url).searchParams;
        const list = q.get("list"), cursor = q.get("cursor");
        const from = cursor !== null && (list === "resources" || list === "templates") ? { list, cursor } as const : undefined;
        try { return json(await m.resources(req.params.name, req.signal, from)); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/resource": {
      GET: async (req: any) => {
        const uri = new URL(req.url).searchParams.get("uri");
        if (!uri) return bad("uri is required");
        const k = known(req.params.name);
        if (k) return k;
        try { return json({ uri, items: await m.readResource(req.params.name, uri, req.signal) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/prompts": {
      GET: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        try { return json({ prompts: await m.prompts(req.params.name) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    // Every connected server's prompts, for the slash menu (/server:prompt).
    "/api/mcp/prompts": {
      GET: async (req: Request) => json({ prompts: await m.allPrompts(req.signal) }),
    },
    // The owner runs a prompt as a command (/server:prompt args, Claude Code's
    // form; /mcp__server__prompt too). Words after it fill the prompt's
    // arguments in order, the last one taking the rest. What the server
    // returns reaches the model as a stored note just before the message; the
    // transcript shows the command.
    "/api/sessions/:id/mcp-prompt": {
      POST: async (req: any) => {
        const s = deps.store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        const server = String(b.server ?? ""), name = String(b.prompt ?? "");
        const k = known(server);
        if (k) return k;
        try {
          const p = (await m.prompts(server)).find((x: any) => x.name === name);
          if (!p) return bad(`${server} has no prompt named ${name}`, 404);
          const params: { name: string; required?: boolean }[] = Array.isArray(p.arguments) ? p.arguments : [];
          const words = String(b.args ?? "").trim().split(/\s+/).filter(Boolean);
          const args: Record<string, string> = {};
          params.forEach((a, i) => {
            const v = i === params.length - 1 ? words.slice(i).join(" ") : words[i];
            if (v) args[a.name] = v;
          });
          const missing = params.filter((a) => a.required && !args[a.name]).map((a) => a.name);
          if (missing.length) return json({ error: `/${server}:${name} needs ${missing.map((x) => `<${x}>`).join(" ")}`, usage: true }, 400);
          const text = await m.getPrompt(server, name, args, req.signal);
          const note = deps.store.append(s.id, "note", { text: `<mcp-prompt server="${server}" name="${name}">\n${text}\n</mcp-prompt>`, model: true, mcp_prompt: `${server}:${name}` });
          deps.bus.emit({ t: "event", event: note });
          const ev = deps.engine.send(s.id, `/${server}:${name}${words.length ? ` ${words.join(" ")}` : ""}`);
          return json({ event: ev }, 201);
        } catch (e) { return bad((e as Error).message, 409); }
      },
    },
    "/api/mcp/servers/:name/prompts/:prompt": {
      POST: async (req: any) => {
        const k = known(req.params.name);
        if (k) return k;
        const args = (await body(req)).arguments ?? {};
        if (typeof args !== "object" || Array.isArray(args)) return bad("arguments must be an object");
        try { return json({ name: req.params.prompt, messages: await m.promptMessages(req.params.name, req.params.prompt, args, req.signal) }); } catch (e) { return bad((e as Error).message, 409); }
      },
    },
  };
};
