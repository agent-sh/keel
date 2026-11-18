// Import of other harnesses' sessions (Claude Code, Codex, the Rust Keel) and
// export of a session: to read, to import into another keel-bun, or to resume
// in Claude Code or Codex.
import { existsSync, statSync } from "node:fs";
import type { RouteModule } from "../app.ts";
import { lineage } from "../../core/tree.ts";
import { Drive } from "../../drive/drive.ts";
import { exportTo, parseKeelJsonl, redact, redactDeep, toKeelJsonl, toMarkdown } from "../../integrations/export.ts";
import { HARNESSES, Imports } from "../../integrations/import/service.ts";
import type { Found, Harness } from "../../integrations/import/types.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const isHarness = (h: unknown): h is Harness => HARNESSES.some((x) => x.harness === h);
// A model id without its provider and region prefixes: bedrock:global.anthropic.claude-x-5 -> claude-x-5.
const bare = (id: string) => id.replace(/^[\w-]+:/, "").replace(/^(us|eu|apac|global)\./, "").replace(/^(anthropic|openai|google|meta|mistral)\./, "");
const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

// The newest messages of a read, for a preview.
function tail(events: { kind: string; data: any }[], n = 6) {
  const out: { role: string; text: string }[] = [];
  for (const e of events) {
    if (e.kind === "user") out.push({ role: "user", text: e.data.text });
    else if (e.kind === "assistant") {
      const t = (e.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      if (t) out.push({ role: "assistant", text: t });
    }
  }
  return out.slice(-n).map((m) => ({ ...m, text: m.text.length > 1200 ? m.text.slice(0, 1199) + "…" : m.text }));
}

export const importRoutes: RouteModule = (deps) => {
  const { store, bus, providers } = deps;
  const imports = new Imports(store);
  imports.refresh().catch((e) => deps.errors.capture("server", e, { at: "import index" }));
  const events = (id: string) => lineage(store.events(id), store.session(id)?.head ?? null);
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

  // A session the drive list shows (by its id there): imported from the
  // transcript the agent view names. A read-only copy; the original runs on.
  const drive = new Drive();
  const target = async (b: any): Promise<Found | Response> => {
    if (b.outside) {
      let f;
      try { f = await drive.find(String(b.outside)); } catch (e) { return bad((e as Error).message, (e as any).status ?? 404); }
      const harness = f.row.kind === "claude" || f.row.kind === "codex" ? f.row.kind : null;
      if (!harness) return bad(`sessions of ${f.row.kind} cannot be imported yet`, 409);
      if (f.row.host || !f.raw.transcript || !existsSync(f.raw.transcript)) return bad("the agent view names no transcript on this machine for this session", 409);
      b = { path: f.raw.transcript, harness };
    }
    if (b.path) {
      if (typeof b.path !== "string" || !b.path.startsWith("/")) return bad("path must be absolute");
      if (b.harness && !isHarness(b.harness)) return bad(`unknown harness ${b.harness}`);
      if (!existsSync(b.path)) return bad(`no file at ${b.path}`, 404);
      return imports.byPath(b.path, b.harness) ?? bad("no reader recognises this file", 409);
    }
    if (!isHarness(b.harness)) return bad(b.harness ? `unknown harness ${b.harness}` : "give harness and id, or path");
    if (typeof b.id !== "string" || !b.id) return bad("give the session's id");
    return imports.find(b.harness, b.id) ?? bad(`${b.harness} has no session ${b.id}`, 404);
  };

  return {
    "/api/import/sessions": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const harness = u.get("harness") || undefined;
        if (harness && !isHarness(harness)) return bad(`unknown harness ${harness}`);
        const sort = u.get("sort") || undefined;
        if (sort && !["updated", "size", "title"].includes(sort)) return bad(`unknown sort ${sort}`);
        if (u.has("refresh")) imports.invalidate();
        await imports.fresh(u.has("refresh") ? 10_000 : 1000);
        const limit = u.get("limit") ? Number(u.get("limit")) : undefined;
        if (limit !== undefined && !(limit > 0)) return bad("limit must be a number above 0");
        const r = imports.list({ harness: harness as Harness | undefined, q: u.get("q") ?? undefined, cwd: u.get("cwd") ?? undefined, show: u.get("show") ?? undefined, sort: sort as any, limit, cursor: Number(u.get("cursor") ?? 0) || 0 });
        return json({ ...r, harnesses: imports.harnesses() });
      },
    },
    "/api/import/index": {
      GET: () => json({ building: false, complete: imports.complete, harnesses: imports.harnesses() }),
      POST: async (req: Request) => {
        const b = await body(req);
        if (b.action !== "refresh" && b.action !== "rebuild") return bad("action is refresh or rebuild");
        if (b.action === "rebuild") store.db.run("DELETE FROM import_index");
        imports.refresh().catch((e) => deps.errors.capture("server", e, { at: "import index" }));
        return json({ building: true, complete: false, harnesses: imports.harnesses() });
      },
    },
    "/api/import/preview": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const f = await target({ harness: u.get("harness") ?? undefined, id: u.get("id") ?? undefined, path: u.get("path") ?? undefined });
        if (f instanceof Response) return f;
        const r = await imports.read(f);
        return json({
          session: { ...f, cwd_exists: isDir(f.cwd) },
          counts: r.counts,
          notes: r.notes,
          tail: tail(r.events),
          links: imports.links(f.harness, f.id).map((l) => ({ session_id: l.session_id, imported_ms: l.imported_ms, synced_ms: l.synced_ms })),
        });
      },
    },
    "/api/import": {
      POST: async (req: Request) => {
        const b = await body(req);
        const f = await target(b);
        if (f instanceof Response) return f;
        if (b.mode && !["new", "update", "open"].includes(b.mode)) return bad(`unknown mode ${b.mode}`);
        const prior = imports.links(f.harness, f.id)[0];
        if (prior && !b.mode) return json({ error: "this session was imported before: open it, update it, or make a new copy", session_id: prior.session_id }, 409);
        if (!prior && (b.mode === "update" || b.mode === "open")) return bad("this session was never imported", 404);
        let model = b.model;
        if (!model) {
          // The source's model when this daemon lists it, else the default one.
          const listed = await providers.models().catch(() => []);
          const want = f.model && bare(f.model);
          model = (want && (listed as any[]).find((m) => m.id === f.model || bare(m.id) === want)?.id) || (await providers.defaultModel());
        }
        if (!model) return bad("no model is available: no provider has credentials", 409);
        if (b.cwd && !isDir(b.cwd)) return bad(`not a directory: ${b.cwd}`);
        const workspace = b.cwd || (isDir(f.cwd) ? f.cwd! : deps.workspace);
        const r = await imports.import(f, { mode: b.mode, model, workspace, title: b.title });
        bus.emit({ t: "session", session: r.session });
        return json({ action: r.action, session: r.session, imported_events: r.imported_events, counts: r.read.counts, notes: r.read.notes }, r.action === "created" ? 201 : 200);
      },
    },
    "/api/sessions/:id/origin": {
      GET: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const l = imports.link(req.params.id);
        if (!l) return json({ origin: null });
        let source: { exists: boolean; grew: boolean } = { exists: false, grew: false };
        try {
          const st = statSync(l.harness === "keel" ? l.source_path.split("#")[0]! : l.source_path);
          source = { exists: true, grew: st.size !== l.source_size || Math.round(st.mtimeMs) !== l.source_mtime };
        } catch {}
        return json({ origin: { ...l, label: HARNESSES.find((h) => h.harness === l.harness)?.label }, source });
      },
    },
    "/api/sessions/:id/export": {
      GET: (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const u = new URL(req.url).searchParams;
        const format = u.get("format") ?? "md";
        const include = new Set((u.get("include") ?? "").split(",").filter(Boolean));
        for (const p of include) if (!["reasoning", "tools", "diffs"].includes(p)) return bad(`unknown part ${p}`);
        const name = (s.title || "session").replace(/[^\w.-]+/g, "-").slice(0, 60);
        const headers = (type: string, ext: string) => ({ "content-type": type, "content-disposition": `attachment; filename="${name}.${ext}"`, "x-keel-redacted": "1" });
        if (format === "md") return new Response(redact(toMarkdown(s, events(s.id), include)), { headers: headers("text/markdown; charset=utf-8", "md") });
        if (format === "jsonl") {
          const evs = events(s.id).map((e) => ({ ...e, data: redactDeep(e.data) }));
          return new Response(toKeelJsonl({ ...s, title: redact(s.title) }, evs), { headers: headers("application/x-ndjson", "jsonl") });
        }
        return bad(`unknown format ${format}`);
      },
    },
    "/api/sessions/:id/export-to": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        const b = await body(req);
        if (b.format !== "claude_code" && b.format !== "codex") return bad("format is claude_code or codex");
        if (deps.engine.isRunning(s.id)) return bad("a turn is running: export when it ends", 409);
        const evs = events(s.id);
        if (!evs.some((e) => e.kind === "user")) return bad("the session has no conversation yet", 409);
        return json(exportTo(b.format, s, evs));
      },
    },
    "/api/sessions/import": {
      POST: async (req: Request) => {
        const parsed = parseKeelJsonl(await req.text());
        if (!parsed) return bad("the body is not a keel-bun export");
        const listed = await providers.models().catch(() => []);
        const model = (listed as any[]).some((m) => m.id === parsed.header.model) ? parsed.header.model : await providers.defaultModel();
        if (!model) return bad("no model is available: no provider has credentials", 409);
        const s = store.createSession({ title: parsed.header.title, model, workspace: isDir(parsed.header.workspace) ? parsed.header.workspace : deps.workspace });
        for (const e of parsed.events) store.append(s.id, e.kind, e.data);
        const out = store.session(s.id)!;
        bus.emit({ t: "session", session: out });
        return json({ session: out, events_imported: parsed.events.length }, 201);
      },
    },
  };
};
