// Import of other harnesses' sessions (Claude Code, Codex, the Rust Keel) and
// export of a session: to read, to import into another keel-bun, or to resume
// in Claude Code or Codex.
import { existsSync, readFileSync, statSync } from "node:fs";
import { readsOf } from "../reads.ts";
import type { RouteModule } from "../app.ts";
import { lineage } from "../../core/tree.ts";
import { sharedDrive } from "../../drive/drive.ts";
import { noteOutward } from "../../safety/egress.ts";
import { loopbackHost } from "../../safety/egress-count.ts";
import { exportTo, KeelFileTooLarge, parseKeelJsonl, redact, redactDeep, rowsOf, toKeelJsonl, toMarkdown } from "../../integrations/export.ts";
import { KEEL_FILE_MAX } from "../../core/keel-file.ts";
import { HARNESSES, modelFor as pickModel, sharedImports, sourceMachine, WENT_ON } from "../../integrations/import/service.ts";
import { cursorGiven, CursorError, offered, scrub, tail } from "../../integrations/import/offer.ts";
import { inDatabase, type Found, type Harness, type Read } from "../../integrations/import/types.ts";
import { callerOf, LinkError, proven } from "../../fleet/link.ts";
import { contains } from "../../core/paths.ts";
import { attachmentPath, dropAttachment, saveAttachment } from "../../engine/attachments.ts";
import { fleet } from "./fleet.ts";
import { takeover } from "./takeover.ts";
import { grantedMachine, resumes } from "./resume.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const isHarness = (h: unknown): h is Harness => HARNESSES.some((x) => x.harness === h);
const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

export const importRoutes: RouteModule = (deps) => {
  const { store, bus, providers } = deps;
  // The index is built on first use (the import sheet), not at start: walking
  // tens of thousands of other harnesses' files costs every start CPU and memory.
  const imports = sharedImports(store);
  imports.insideFailed ??= (e) => deps.errors.capture("server", e, { at: "import search inside" });
  const reads = readsOf(store);
  // An import has its exchange already: a model titles it now when its title is only the source's first prompt.
  // (Set again by each app: the index is one per process, the engine is the app's own.)
  imports.created = (id) => { try { deps.engine.adoptImport(id); } catch (e) { deps.errors.capture("server", e, { session: id, at: "import title" }); } };
  imports.offRead ??= (sql, params) => reads.sql(sql, params);
  const events = (id: string) => lineage(store.events(id), store.session(id)?.head ?? null);
  // The source's model when this daemon lists it, else the default one.
  const modelFor = (f: Found) => pickModel(providers, f);
  const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;
  // Where a copy goes on: the folder chosen, else the source's own even when
  // it is gone (the session then says so and is moved by the owner, never
  // bound silently to another folder), else the daemon's.
  const workspaceOf = (f: Found, chosen?: string) => chosen || f.cwd || deps.workspace;

  // A session the drive list shows (by its id there): imported from the
  // transcript the agent view names. A read-only copy; the original runs on.
  const drive = sharedDrive();
  const target = async (b: any): Promise<Found | Response> => {
    if (b.outside) {
      let f;
      try { f = await drive.find(String(b.outside)); } catch (e) { return bad((e as Error).message, (e as any).status ?? 404); }
      const harness = (["claude", "codex", "agy"] as const).find((k) => k === f.row.kind);
      if (!harness) return bad(`sessions of ${f.row.kind} cannot be imported yet`, 409);
      // An Antigravity conversation is found in its stores by its id when the row names no file.
      if (harness === "agy" && !f.row.host && !f.raw.transcript && typeof f.raw.session === "string") b = { harness, id: f.raw.session };
      else if (f.row.host || !f.raw.transcript || !existsSync(f.raw.transcript)) return bad("the agent view names no transcript on this machine for this session", 409);
      else b = { path: f.raw.transcript, harness };
    }
    // A store of one database names a session `<database>#<id>`: it is found by its harness and id.
    if (b.path && isHarness(b.harness) && inDatabase(b.harness) && typeof b.id === "string" && b.id) b = { harness: b.harness, id: b.id };
    if (b.path) {
      if (typeof b.path !== "string" || !b.path.startsWith("/")) return bad("path must be absolute");
      if (b.harness && !isHarness(b.harness)) return bad(`unknown harness ${b.harness}`);
      if (!existsSync(b.path)) return bad("its file moved or was removed since the list was read: look at the list again", 404);
      const f = imports.byPath(b.path, b.harness);
      if (!f) return bad(b.harness ? `no ${b.harness} reader recognises this file` : "no reader recognises this file", 409);
      // The row the list showed is the file and the session id together: the
      // same id in another file is another transcript.
      if (b.id && f.id !== b.id) return bad(`the file at ${b.path} now holds another session (${f.id}): look at the list again`, 409);
      return f;
    }
    if (!isHarness(b.harness)) return bad(b.harness ? `unknown harness ${b.harness}` : "give harness and id, or path");
    if (typeof b.id !== "string" || !b.id) return bad("give the session's id");
    return imports.find(b.harness, b.id) ?? (imports.invalidate(), imports.find(b.harness, b.id)) ?? bad(`${b.harness} has no session ${b.id}`, 404);
  };

  // What an update appended to a copy goes to the pages that show it: the
  // copy's last event before the update, then every event after it.
  const lastSeq = (id?: string) => (id ? store.lastSeq(id) : 0);
  const emitGained = (id: string, after: number) => {
    for (const e of store.events(id, after)) bus.emit({ t: "event", event: e });
  };

  // A page of a listing; a cursor this list did not give is the caller's mistake (400).
  const listed = <T,>(f: () => T): T | Response => {
    try { return f(); } catch (e) { if (e instanceof CursorError) return bad(e.message); throw e; }
  };

  // ---- transcripts on another machine of the fleet (its daemon reads them)

  // What a paired daemon may ask: this machine's transcripts, read only,
  // never one under a credentials folder or name, titles scrubbed.
  const paired = (h: (req: Request) => Promise<Response>) => async (req: Request) => {
    const c = fleet ? callerOf(req, fleet.keyOf) : null;
    if (!c) return proven(bad("not a paired daemon", 403), null, fleet?.id ?? "");
    return proven(await h(req), c, fleet!.id);
  };

  // A machine's own read of its transcripts: its daemon over the paired link,
  // or the helper of a machine reached over ssh.
  const machineOf = grantedMachine;
  const ask = async <T,>(mid: string, path: string): Promise<T | Response> => {
    try {
      return await fleet!.handsJson<T>(mid, path, { timeout: 30_000, idempotent: true });
    } catch (e) {
      if (!(e instanceof LinkError)) throw e;
      // The machine answered and refused what was asked (a cursor it did not give): the caller's mistake, in its words.
      if ((e as { status?: number }).status === 400) return bad((e as Error).message);
      return bad(`${fleet!.row(mid)?.name ?? mid} did not answer: ${(e as Error).message}`, 409);
    }
  };

  const fleetRoutes = {
    "/api/fleet/hands/transcripts": {
      GET: paired(async (req) => {
        const u = new URL(req.url).searchParams;
        const harness = u.get("harness") || undefined;
        if (harness && !isHarness(harness)) return bad(`unknown harness ${harness}`);
        const cursor = cursorGiven(u.get("cursor"));
        await imports.fresh(u.has("refresh") ? 10_000 : 1000, u.has("refresh") || !cursor);
        // Only what this machine offers is counted and cut into pages: a row
        // left out never takes a place in a page, however long the list.
        const r = listed(() => imports.list({ harness: harness as Harness | undefined, q: u.get("q") ?? undefined, show: u.get("show") ?? undefined, sort: (u.get("sort") as any) || undefined, limit: Number(u.get("limit") ?? 50) || 50, cursor, offered: true }, 200));
        if (r instanceof Response) return r;
        const tools = ["claude", "codex", "agy"].filter((t) => Bun.which(t));
        return json({
          sessions: r.sessions.filter(offered).map(({ imported: _, ...f }) => scrub(f as Found)),
          total: r.total, next_cursor: r.next_cursor, changed: r.changed,
          index: r.index, harnesses: imports.harnesses().map(({ store: _, ...h }) => h), tools_present: tools,
        });
      }),
    },
    "/api/fleet/hands/transcript": {
      GET: paired(async (req) => {
        const u = new URL(req.url).searchParams;
        const h = u.get("harness");
        if (!isHarness(h) || !u.get("id")) return bad("give harness and id");
        const f = imports.find(h, u.get("id")!);
        if (!f || !offered(f)) return bad(`${h} has no session ${u.get("id")}`, 404);
        const r = await imports.read(f);
        return json({ session: { ...scrub(f), cwd_exists: isDir(f.cwd) }, read: u.has("full") ? r : { counts: r.counts, notes: r.notes, events: [] }, tail: tail(r.events) });
      }),
    },

    // This daemon's view of one machine's transcripts.
    "/api/fleet/machines/:id/transcripts": {
      GET: async (req: any) => {
        const m = machineOf(req.params.id);
        if (m instanceof Response) return m;
        const u = new URL(req.url).searchParams;
        if (u.has("limit") && !(Number(u.get("limit")) > 0)) return bad("limit must be a number above 0");
        const r = await ask<any>(m.id, `/api/fleet/hands/transcripts?${u}`);
        if (r instanceof Response) return r;
        return json({
          machine_id: m.id, machine: m.name, has_agent_view: false, tools_present: r.tools_present, transport: fleet!.isSsh(m) ? "ssh" : "daemon",
          sessions: r.sessions.map((f: Found) => {
            const l = imports.links(f.harness, f.id, undefined, m.id)[0];
            return {
              ...f,
              imported: l ? { session_id: l.session_id, synced_ms: l.synced_ms, grew: f.size_bytes !== l.source_size || Math.round(f.updated_ms) !== l.source_mtime, went_on: imports.wentOn(l.session_id) } : undefined,
              // A resume that waits for the original to be idle shows on its row.
              wait: resumes?.waitOf(m.id, f.harness, f.id),
            };
          }),
          total: r.total, next_cursor: r.next_cursor, changed: r.changed, index: r.index, harnesses: r.harnesses,
        });
      },
    },
    "/api/fleet/machines/:id/transcripts/preview": {
      GET: async (req: any) => {
        const m = machineOf(req.params.id);
        if (m instanceof Response) return m;
        const u = new URL(req.url).searchParams;
        const r = await ask<any>(m.id, `/api/fleet/hands/transcript?harness=${encodeURIComponent(u.get("harness") ?? "")}&id=${encodeURIComponent(u.get("id") ?? "")}`);
        if (r instanceof Response) return r;
        const f = r.session as Found;
        return json({ session: { ...r.session, cwd_exists: r.session.cwd_exists }, counts: r.read.counts, notes: r.read.notes, tail: r.tail, links: imports.links(f.harness, f.id, undefined, m.id).map((l) => ({ session_id: l.session_id, imported_ms: l.imported_ms, synced_ms: l.synced_ms })) });
      },
    },
    // A transcript of that machine goes on here, its tools running there: in
    // its own folder when that is inside the granted directory, else in it.
    "/api/fleet/machines/:id/transcripts/import": {
      POST: async (req: any) => {
        const m = machineOf(req.params.id);
        if (m instanceof Response) return m;
        const b = await body(req);
        if (!isHarness(b.harness) || !b.id) return bad("give harness and id");
        if (b.mode && !["new", "update", "open"].includes(b.mode)) return bad(`unknown mode ${b.mode}`);
        const prior = imports.links(b.harness, String(b.id), undefined, m.id)[0];
        if (prior && !b.mode) return json({ error: "this session was imported before: open it, update it, or make a new copy", session_id: prior.session_id }, 409);
        if (prior && b.mode === "open") return json({ action: "opened", session: store.session(prior.session_id) });
        const r = await ask<{ session: Found & { cwd_exists: boolean }; read: Read }>(m.id, `/api/fleet/hands/transcript?harness=${b.harness}&id=${encodeURIComponent(String(b.id))}&full=1`);
        if (r instanceof Response) return r;
        const f = r.session;
        const model = b.model || (await modelFor(f));
        if (!model) return bad("no model is available: no provider has credentials", 409);
        const workspace = f.cwd && r.session.cwd_exists && contains(m.workspace_root!, f.cwd) ? f.cwd : m.workspace_root!;
        const seq = lastSeq(prior?.session_id);
        let out;
        try {
          out = await imports.import(f, { mode: b.mode, model, workspace, title: b.title, from: { machine: m.id, read: r.read } });
        } catch (e) {
          // The copy went on while that machine read its transcript, or the transcript rewound.
          if ((e as any)?.status === 409) return json({ error: (e as Error).message, session_id: (e as any).session_id, reason: (e as any).reason }, 409);
          throw e;
        }
        if (out.action === "created" && workspace !== f.cwd) store.append(out.session.id, "note", { text: `Its folder ${f.cwd ?? "(none)"} is not inside the directory granted on ${m.name}; it goes on in ${workspace} there.` });
        if (out.action === "updated") emitGained(out.session.id, seq);
        bus.emit({ t: "session", session: store.session(out.session.id)! });
        // A copy of a conversation whose harness still runs there is told so.
        if (out.action === "created" && fleet!.isSsh(m)) await resumes?.copied(m, out.session.id, b.harness, String(b.id));
        return json({ action: out.action, session: store.session(out.session.id), imported_events: out.imported_events, counts: r.read.counts, notes: r.read.notes }, out.action === "created" ? 201 : 200);
      },
    },
  };

  return {
    ...fleetRoutes,
    "/api/import/sessions": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        const harness = u.get("harness") || undefined;
        if (harness && !isHarness(harness)) return bad(`unknown harness ${harness}`);
        const sort = u.get("sort") || undefined;
        if (sort && !["updated", "size", "title"].includes(sort)) return bad(`unknown sort ${sort}`);
        if (u.has("refresh")) imports.invalidate();
        // Opening the list walks the stores again (`opened`: the sheet's first listing, which may
        // already search); a search typed key by key or the next page reads the index the opening built.
        const cursor = cursorGiven(u.get("cursor"));
        await imports.fresh(u.has("refresh") ? 10_000 : 1000, u.has("refresh") || u.has("opened") || (!u.get("q") && !cursor));
        const limit = u.get("limit") ? Number(u.get("limit")) : undefined;
        if (limit !== undefined && !(limit > 0)) return bad("limit must be a number above 0");
        // `inside`: the words are looked for in what the transcripts say too, not only in their titles,
        // folders and prompts. The answer says which harnesses' text was searched and which was not.
        const q = u.get("q") ?? undefined;
        const found = u.has("inside") && q?.trim() ? await imports.inside(q, { harness: harness as Harness | undefined, show: u.get("show") ?? undefined, signal: req.signal }) : undefined;
        const r = listed(() => imports.list({ harness: harness as Harness | undefined, q, cwd: u.get("cwd") ?? undefined, show: u.get("show") ?? undefined, sort: sort as any, limit, cursor, inside: found?.paths ?? undefined, insideRows: found?.rows }));
        if (r instanceof Response) return r;
        return json({ ...r, harnesses: imports.harnesses(), ...(found ? { inside: { searched: found.searched, not: found.not } } : {}) });
      },
    },
    "/api/import/index": {
      // What the index is doing now; reading it starts no walk.
      GET: () => json({ ...imports.status(), harnesses: imports.harnesses() }),
      POST: async (req: Request) => {
        const b = await body(req);
        if (b.action !== "refresh" && b.action !== "rebuild") return bad("action is refresh or rebuild");
        (b.action === "rebuild" ? imports.rebuild() : imports.refresh()).catch((e) => deps.errors.capture("server", e, { at: "import index" }));
        return json({ ...imports.status(), harnesses: imports.harnesses() });
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
          // Every copy, with its own title and last activity: Open names one of them.
          links: imports.links(f.harness, f.id, f.path).map((l) => { const c = store.session(l.session_id)!; return { session_id: l.session_id, title: c.title, updated_ms: c.updated, imported_ms: l.imported_ms, synced_ms: l.synced_ms }; }),
        });
      },
    },
    "/api/import": {
      POST: async (req: Request) => {
        let b = await body(req);
        if (b.mode && !["new", "update", "open"].includes(b.mode)) return bad(`unknown mode ${b.mode}`);
        // Open names the copy: it opens whether or not the original can still be read.
        if (b.mode === "open" && typeof b.session_id === "string") {
          const l = imports.link(b.session_id);
          const s = l && store.session(l.session_id);
          if (!l || !s || (b.harness && l.harness !== b.harness) || (b.id && l.source_id !== b.id)) return bad("no such copy", 404);
          return json({ action: "opened", session: s, imported_events: 0 });
        }
        // Update names the copy too (a copy's own Export dialog): that copy is
        // brought up to date from its own source, whichever copy is the newest.
        let named: string | undefined;
        if (b.mode === "update" && b.session_id !== undefined) {
          const l = typeof b.session_id === "string" ? imports.link(b.session_id) : undefined;
          if (!l || !store.session(l.session_id) || (b.harness && l.harness !== b.harness) || (b.id && l.source_id !== b.id)) return bad("no such copy", 404);
          if (sourceMachine(l.source_path)) return bad("this copy's original is on another machine: update it from that machine's list", 409);
          named = l.session_id;
          b = { ...b, harness: l.harness, id: l.source_id, path: b.path ?? (l.harness === "claude" || l.harness === "codex" ? l.source_path : undefined) };
        }
        const f = await target(b);
        if (f instanceof Response) return f;
        const copies = imports.links(f.harness, f.id, f.path);
        const prior = named ? copies.find((l) => l.session_id === named) : copies[0];
        if (named && !prior) return bad("no such copy", 404);
        if (prior && !b.mode) return json({ error: "this session was imported before: open it, update it, or make a new copy", session_id: prior.session_id }, 409);
        if (!prior && (b.mode === "update" || b.mode === "open")) return bad("this session was never imported", 404);
        // The original's later turns would land after the copy's own.
        if (prior && b.mode === "update" && takeover?.wentOn(prior.session_id)) return json({ error: WENT_ON, session_id: prior.session_id, reason: "went_on" }, 409);
        const model = b.mode === "open" ? "" : b.model || (await modelFor(f));
        if (!model && b.mode !== "open") return bad("no model is available: no provider has credentials", 409);
        if (b.cwd && !isDir(b.cwd)) return bad(`not a directory: ${b.cwd}`);
        const seq = lastSeq(prior?.session_id);
        let r;
        try {
          r = await imports.import(f, { mode: b.mode, model, workspace: workspaceOf(f, b.cwd), title: b.title, session_id: named });
        } catch (e) {
          if ((e as any)?.status === 409) return json({ error: (e as Error).message, session_id: (e as any).session_id, reason: (e as any).reason }, 409);
          throw e;
        }
        // A page that shows the copy gets the events it gained.
        if (r.action === "updated") emitGained(r.session.id, seq);
        bus.emit({ t: "session", session: r.session });
        // A copy of a session that still runs is told so, once the agent view's list is read.
        if (r.action !== "opened") takeover?.noteLiveLater(r.session.id);
        return json({ action: r.action, session: r.session, imported_events: r.imported_events, counts: r.read?.counts, notes: r.read?.notes ?? [] }, r.action === "created" ? 201 : 200);
      },
    },
    // Many at once, one after another; one that fails does not stop the others,
    // and one imported before is opened (or updated with mode "update"), never doubled.
    "/api/import/batch": {
      POST: async (req: Request) => {
        const b = await body(req);
        if (!Array.isArray(b.items) || !b.items.length) return bad("give items");
        if (b.items.length > 200) return bad("at most 200 items at once");
        const results: any[] = [];
        const counts: Record<string, number> = {};
        for (const item of b.items) {
          const f = await target(item);
          if (f instanceof Response) {
            results.push({ ...item, ok: false, status: f.status, error: ((await f.json()) as any).error });
            counts.failed = (counts.failed ?? 0) + 1;
            continue;
          }
          const fail = (status: number, error: string, more: Record<string, unknown> = {}) => {
            results.push({ harness: f.harness, id: f.id, path: f.path, title: f.title, ok: false, status, error, ...more });
            counts.failed = (counts.failed ?? 0) + 1;
          };
          try {
            const prior = imports.links(f.harness, f.id, f.path)[0];
            const mode = prior ? (b.mode === "new" ? "new" : b.mode === "update" ? "update" : "open") : "new";
            // The same rule as one import: a copy that went on is not updated.
            if (prior && mode === "update" && takeover?.wentOn(prior.session_id)) { fail(409, WENT_ON, { session_id: prior.session_id, reason: "went_on" }); continue; }
            const model = mode === "open" && prior ? "" : b.model ?? (await modelFor(f));
            if (!model && !(mode === "open" && prior)) { fail(409, "no model is available: no provider has credentials", { reason: "no_model" }); continue; }
            const seq = lastSeq(prior?.session_id);
            const r = await imports.import(f, { mode: prior ? mode : undefined, model, workspace: workspaceOf(f) });
            if (r.action === "updated") emitGained(r.session.id, seq);
            if (r.action !== "opened") bus.emit({ t: "session", session: r.session });
            results.push({ harness: f.harness, id: f.id, title: f.title, ok: true, action: r.action, session_id: r.session.id, imported_events: r.imported_events });
            counts[r.action] = (counts[r.action] ?? 0) + 1;
          } catch (e) {
            if ((e as any)?.status === 409) { fail(409, (e as Error).message, { ...((e as any).session_id ? { session_id: (e as any).session_id } : {}), ...((e as any).reason ? { reason: (e as any).reason } : {}) }); continue; }
            fail(500, (e as Error).message);
            deps.errors.capture("server", e, { at: "import batch", harness: f.harness, id: f.id });
          }
        }
        return json({ results, counts });
      },
    },
    "/api/sessions/:id/origin": {
      GET: (req: any) => {
        if (!store.session(req.params.id)) return bad("no such session", 404);
        const l = imports.link(req.params.id);
        if (!l) return json({ origin: null });
        let source: { exists: boolean; grew: boolean } = { exists: false, grew: false };
        try {
          const st = statSync(inDatabase(l.harness) ? l.source_path.split("#")[0]! : l.source_path);
          source = { exists: true, grew: st.size !== l.source_size || Math.round(st.mtimeMs) !== l.source_mtime };
        } catch {}
        // A copy of a transcript read on another machine names that machine (its link is "<machine>:<path>").
        const far = sourceMachine(l.source_path);
        const fm = far ? fleet?.row(far) : undefined;
        const machine = fm ? { id: fm.id, name: fm.name, ssh: fleet!.isSsh(fm) } : undefined;
        // `went_on`: the copy took a turn here (or runs one now), so it no longer takes the original's later turns.
        const went_on = takeover ? takeover.wentOn(l.session_id) : imports.wentOn(l.session_id);
        return json({ origin: { ...l, label: HARNESSES.find((h) => h.harness === l.harness)?.label, live_source: imports.liveSource(l.session_id), machine, went_on }, source });
      },
    },
    "/api/sessions/:id/export": {
      GET: (req: any, srv?: { requestIP?: (r: Request) => { address: string; port: number } | null }) => {
        const s = store.session(req.params.id);
        if (!s) return bad("no such session", 404);
        // A session's whole text leaves the daemon for whoever asked: a row of the outward ledger, by their address.
        // An export to a page on this machine leaves nothing: it is no row.
        const sent = (text: string) => {
          const to = srv?.requestIP?.(req)?.address;
          if (to && !loopbackHost(to)) noteOutward({ tool: "export", via: format, session: s.id, host: to, bytes: Buffer.byteLength(text) });
          return text;
        };
        const u = new URL(req.url).searchParams;
        const format = u.get("format") ?? "md";
        const include = new Set((u.get("include") ?? "").split(",").filter(Boolean));
        // The parts the Markdown writer has text for. An edit's change is in its
        // tool call: there is no part of diffs, and asking for one is refused
        // instead of answered with a file that silently has none.
        if (include.has("diffs")) return bad("the export has no diffs part: an edit's change is in its tool call (include=tools); the parts are reasoning and tools");
        for (const p of include) if (!["reasoning", "tools"].includes(p)) return bad(`unknown part ${p}: the parts are reasoning and tools`);
        // The download name: the title on one line, in its own script where the
        // browser reads filename*, an ASCII name of the session's own otherwise.
        // The title is cut at a whole character: a cut between the two halves
        // of one outside the basic plane (an emoji, a rare letter) leaves a
        // half no encoding accepts.
        const title = (s.title || "").replace(/\s+/g, " ").trim().toWellFormed();
        const named = title.slice(0, 80).replace(/[\uD800-\uDBFF]$/, "");
        const ascii = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || `session-${s.id.slice(-8)}`;
        const headers = (type: string, ext: string) => ({
          "content-type": type,
          "content-disposition": `attachment; filename="${ascii}.${ext}"${title ? `; filename*=UTF-8''${encodeURIComponent(`${named}.${ext}`)}` : ""}`,
          "x-keel-redacted": "1",
        });
        // The files the prompts name travel inside the Keel file when asked for.
        const withFiles = u.get("attachments") === "1";
        if (withFiles && format !== "jsonl") return bad("attached files travel in the Keel file: format=jsonl");
        // The Keel file holds the branch shown, or every branch when asked for.
        const scope = u.get("scope") ?? "branch";
        if (scope !== "branch" && scope !== "tree") return bad(`unknown scope ${scope}`);
        if (scope === "tree" && format !== "jsonl") return bad("every branch travels in the Keel file: format=jsonl");
        const all = store.events(s.id);
        const shown = events(s.id);
        const leaves = all.filter((e) => !all.some((x) => x.parent === e.id)).length;
        const otherBranches = Math.max(0, leaves - 1);
        if (format === "md") return new Response(sent(redact(toMarkdown(s, shown, include, { otherBranches }))), { headers: headers("text/markdown; charset=utf-8", "md") });
        if (format === "jsonl") {
          // The Keel file is whole, for another Keel to continue: there is no part to choose.
          if (include.size) return bad("the Keel file always holds every part of the branch; include applies to Markdown");
          const evs = (scope === "tree" ? all : shown).map((e) => ({ ...e, data: redactDeep(e.data) }));
          const blob = (id: string) => { const p = attachmentPath(id); return p ? new Uint8Array(readFileSync(p)) : undefined; };
          const size = (id: string) => { const p = attachmentPath(id); return p ? statSync(p).size : undefined; };
          // A file another Keel would not take is refused before a stored file is read, with what it would weigh.
          let file;
          try {
            file = toKeelJsonl({ ...s, title: redact(s.title) }, evs, { max: KEEL_FILE_MAX, ...(withFiles ? { blob, size } : {}), ...(scope === "tree" ? { tree: { head: s.head } } : {}) });
          } catch (e) {
            if (e instanceof KeelFileTooLarge) return json({ error: e.message, bytes: e.bytes, files_bytes: e.files_bytes, max: e.max }, 413);
            throw e;
          }
          return new Response(sent(file), { headers: headers("application/x-ndjson", "jsonl") });
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
        if (!parsed.ok) return bad(parsed.error);
        const { header } = parsed;
        const notes = [...parsed.notes];
        // The exported model when this daemon lists it; else the default, said as a substitution.
        const listed = await providers.models().then((m) => m as any[], () => null);
        const exact = !!listed?.some((m) => m.id === header.model);
        const model = exact ? header.model : await providers.defaultModel();
        if (!model) return bad("no model is available: no provider has credentials", 409);
        const reason = exact ? "listed" : listed ? "not_listed" : "listing_failed";
        if (!exact && header.model) notes.push(`Exported with ${header.model}; the next reply will use ${model}: ${listed ? `${header.model} is not listed here` : "the model listing failed"}.`);
        const workspace = isDir(header.workspace) ? header.workspace : deps.workspace;
        if (header.workspace && workspace !== header.workspace) notes.push(`The folder ${header.workspace} is not on this machine: the session works in ${workspace}.`);
        // New ids; an event that names another one of the file names its copy.
        const { rows, head } = rowsOf(parsed);
        // The session and its events first, then the bytes a self-contained
        // file carries (checked against their digests when it was read), stored
        // once each under the first name a prompt gives them. One step: when
        // any of it fails, the session and what was stored for it are removed.
        let out;
        const stored: string[] = [];
        try {
          out = store.createWithEvents({ title: typeof header.title === "string" ? header.title : "", model, workspace }, rows, head);
          for (const r of rows) if (r.kind === "user") for (const b of r.data?.images ?? []) {
            const bytes = b?.type === "attachment" && !attachmentPath(b.id) ? parsed.blobs.get(b.id) : undefined;
            if (!bytes) continue;
            stored.push(b.id);
            saveAttachment(bytes, b.name, b.media_type ?? "", b.charset);
          }
        } catch (e) {
          if (out) store.deleteSession(out.id);
          for (const id of stored) dropAttachment(id);
          throw e;
        }
        // Files the prompts name and this machine does not hold.
        const missing = new Set<string>();
        for (const r of rows) if (r.kind === "user") for (const b of r.data?.images ?? []) if (b?.type === "attachment" && !attachmentPath(b.id)) missing.add(b.name);
        if (missing.size) notes.push(`${[...missing].join(", ")} ${missing.size === 1 ? "is" : "are"} not stored on this machine: the model is told ${missing.size === 1 ? "it is" : "they are"} missing.`);
        bus.emit({ t: "session", session: out });
        return json({ session: out, events_imported: rows.length, files_imported: parsed.blobs.size, model: { exported: header.model ?? null, used: model, reason }, notes }, 201);
      },
    },
  };
};
