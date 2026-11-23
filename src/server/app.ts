import { existsSync, rmSync, statSync } from "node:fs";
import { asAsker } from "../core/asker.ts";
import { checkpointerOf } from "../core/checkpoint.ts";
import { join, resolve } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import { diskFull, refusedWrite, STORE_REFUSES, type Store } from "../core/store.ts";
import { firstAt, leafCount, lineage, pageOf, pageOfLine, pageRange, replyBefore } from "../core/tree.ts";
import { shownAsPrompt } from "../core/owner.ts";
import type { StoredEvent } from "../core/types.ts";
import type { Session } from "../core/types.ts";
import type { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import { jobsOf, leftText, jobLive, stopJobs } from "../tools/jobs.ts";
import { admit, initAccess } from "./admission.ts";
import { agentsUnder, leanSessions } from "./session-list.ts";
import { Live } from "./live.ts";
import { readsOf } from "./reads.ts";
import { lastCall } from "./routes/calls-read.ts";
import index from "../../ui/index.html";
import { ModelLookupError, speedOffer } from "../providers/registry.ts";
import { carrySettings, commitSwitch, resolveSwitchModel } from "./switch.ts";
import { bundleRoutes, codingOf, compressJson } from "./compress.ts";
import { daemonApi, embeddedBuilt, stamp, UiBundles } from "./ui-bundle.ts";
import { fitted } from "../engine/image-fit.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { KEEL_FILE_MAX } from "../core/keel-file.ts";
import { inFlight, timed } from "../admin/stall.ts";
import { moduleTook } from "../core/start-trace.ts";
import { routeTable } from "./stable-api.ts";
import { onProxyTrouble, ownPort } from "../safety/net-proxy.ts";
import { onConfigRefused, refusedSentence, sessionFoldersOf, setSessionFolders } from "../core/named-config.ts";

// The seqs of the prompts of a branch, kept while the branch is the same array
// (the store gives a new one when the branch grows or the head moves).
const promptSeqs = new WeakMap<readonly StoredEvent[], number[]>();

// A feature module adds its routes here instead of editing this file.
export type RouteModule = (deps: Deps) => Record<string, any>;

// A module that upgrades a request to its own WebSocket (the portal's dev
// server sockets) passes `data: { kind }` to `srv.upgrade` and registers the
// kind here; every other socket is a page's frame stream.
export type SocketHandler = { open?(ws: Bun.ServerWebSocket<any>): void; message?(ws: Bun.ServerWebSocket<any>, m: string | Buffer): void; close?(ws: Bun.ServerWebSocket<any>, code: number, reason: string): void };
const socketKinds = new Map<string, SocketHandler>();
export const registerSocket = (kind: string, h: SocketHandler) => void socketKinds.set(kind, h);
const socketKind = (ws: Bun.ServerWebSocket<any>) => (ws.data && typeof ws.data === "object" ? socketKinds.get((ws.data as any).kind) : undefined);

export type Deps = { store: Store; bus: Bus; engine: Engine; providers: Providers; errors: ErrorTracker; workspace: string };

// Fields of `PATCH /api/sessions/:id` a feature module owns (marks, memory
// switches, a step budget). Every `check` runs before anything changes and
// refuses by throwing an Error with a `status`; `apply` runs after the core
// fields are written. `id` keeps one entry per module across hot reloads.
export type SessionPatch = { id: string; fields: string[]; check?(s: Session, body: any): void | Promise<void>; apply(s: Session, body: any): void | Promise<void> };
const patchers = new Map<string, SessionPatch>();
export const registerSessionPatch = (p: SessionPatch) => void patchers.set(p.id, p);
// Filters of `GET /api/sessions` a module owns (`?tag=`, `?pinned=1`).
const listFilters = new Map<string, (s: Session, q: URLSearchParams) => boolean>();
export const registerListFilter = (id: string, f: (s: Session, q: URLSearchParams) => boolean) => void listFilters.set(id, f);

// The core routes plus every module's. Two modules may share a path with
// different methods; a core path, or the same path and method twice, is a
// startup error, never a silent overwrite of one lane's handler by another's.
// A dev daemon stops at a clash so the lane that made it sees it at once; a
// built one records it in the errors table and keeps the first handler.
function withModules(core: Record<string, any>, modules: RouteModule[], deps: Deps, wrap: (h: any) => any, strict: boolean) {
  const clash = (msg: string) => {
    if (strict) throw new Error(msg);
    deps.errors.capture("server", new Error(msg), { at: "routes" });
  };
  const out: Record<string, any> = {};
  const owner: Record<string, string> = {};
  modules.forEach((m, i) => {
    const name = m.name || `module ${i}`;
    const t0 = performance.now();
    const routes = m(deps);
    moduleTook(name, performance.now() - t0);
    for (const [path, methods] of Object.entries(routes)) {
      if (path in core) { clash(`route clash: ${name} redefines core path ${path}`); continue; }
      const table = typeof methods === "function" ? { ALL: methods } : (methods as Record<string, any>);
      const slot = (out[path] ??= {});
      for (const [verb, h] of Object.entries(table)) {
        const taken = slot[verb] ? verb : slot.ALL ? "ALL" : verb === "ALL" ? Object.keys(slot)[0] : undefined;
        if (taken) { clash(`route clash: ${verb} ${path} in ${name}, already defined by ${owner[`${taken} ${path}`]}`); continue; }
        slot[verb] = wrap(h);
        owner[`${verb} ${path}`] = name;
      }
    }
  });
  // A bare handler stays a bare handler (Bun serves it for every method).
  return { ...core, ...Object.fromEntries(Object.entries(out).map(([p, t]) => [p, t.ALL ?? t])) };
}

// The UI's pages; the client routes the rest.
const PAGES = ["/", "/s/:id", "/p/:id", "/settings", "/settings/:section"];

// The route a request matched, as it is registered: each value of its path is its parameter's name.
function routeOf(req: Request & { params?: Record<string, string> }): string {
  const values = new Map(Object.entries(req.params ?? {}).map(([k, v]) => [v, k] as const));
  const parts = new URL(req.url).pathname.split("/").map((p) => { let d = p; try { d = decodeURIComponent(p); } catch {} return values.has(d) ? `:${values.get(d)}` : p; });
  return `${req.method} ${parts.join("/")}`;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
// The size of the parts a whole session's answer is sent in.
const WHOLE_PART = 1 << 20;
// Bun's default idle timeout, and the point where a handler counts as slow.
const IDLE_S = 10;
const SLOW_MS = 8_000;
const bad = (message: string, status = 400) => json({ error: message }, status);

export function serve(deps: Deps, opts: { hostname: string; port: number; development?: boolean }, modules: RouteModule[] = []) {
  const { store, bus, engine, providers, errors } = deps;
  initAccess(store.stateDir);
  // Bun's publish writes a frame to every subscribed tab natively, serialized once.
  const live = new Live(store, bus, (topic, data) => server.publish(topic, data));
  live.state = (id) => ({ queue: engine.queued(id), held: engine.isHeld(id), status: engine.statusOf(id) });

  const session = (id: string) => store.session(id);
  // The session's own branch as the store keeps it, when `head` names it or
  // an event on it (a reader in the middle of the branch names the last event
  // it holds): the routes below then walk nothing. Null: another branch.
  const keptLine = (s: Session, head?: string | null): readonly StoredEvent[] | null => {
    if (!head || head === s.head) return store.lineage(s.id);
    const e = store.event(head);
    if (!e || e.session_id !== s.id) return null;
    const line = store.lineage(s.id);
    return line[firstAt(line, e.seq)]?.id === e.id ? line : null;
  };

  // The bodies of the part of a session's shown branch that a page asks for, in memory before the
  // part is read out: a session at rest gave its bodies back, and reading them back on the loop
  // waits for the disk (Store.warmBodies reads them on the read thread).
  const warmPart = async (id: string, ask: { limit: number; before?: number; after?: number; at?: number }) => {
    const line = store.lineage(id);
    const [a, b] = pageRange(line, ask);
    if (b > a) await store.warmBodies(id, line[a]!.seq, line[b - 1]!.seq).catch(() => {});
  };

  const wrap = (h: (req: Request & { params: any }, srv: Bun.Server<unknown>) => Promise<Response> | Response) =>
    async (req: any, srv: any) => {
      // Bun closes a connection whose request has had no bytes for its idle
      // timeout (10 s), even while the handler still works: a DELETE waiting
      // for a turn to wind down, a compaction, a drain ended as a connection
      // reset. A handler still running at 8 s turns that off for its request;
      // the idle timeout comes back for the keep-alive wait after it answers.
      let slow = false;
      const timer = setTimeout(() => { slow = true; srv.timeout(req, 0); }, SLOW_MS);
      // What the daemon was answering, should it stop responding meanwhile (src/admin/stall.ts).
      const label = () => `answering ${req.method} ${new URL(req.url).pathname}`;
      const answered = inFlight(req, label);
      // (The session a request names stays in memory until it is answered: Store.hold.)
      let release: (() => void) | undefined;
      try {
        const refused = await admit(req, srv);
        if (refused) return refused;
        // A request that names a session reads it, most of them whole and in
        // one piece (its branch, its events). One that is not in memory is
        // brought in first, off the loop and a part at a time (store.warm),
        // so no handler reads tens of thousands of rows where the loop
        // waits for it. Not for a read that asks for no event (`events=0`,
        // a cursor): those read a row or a part, and bring nothing in.
        const sid = req.params?.id;
        if (typeof sid === "string" && !store.isKept(sid)) {
          const url = new URL(req.url);
          // (Nor for the whole session, which the read thread writes from the table.)
          const whole = req.method === "GET" && url.pathname === `/api/sessions/${sid}` && !(Number(url.searchParams.get("page")) > 0);
          // (Nor before a session is deleted.)
          if (req.method !== "DELETE" && url.pathname.startsWith("/api/sessions/") && url.searchParams.get("events") !== "0" && !url.searchParams.has("after") && !whole && store.session(sid)) await store.warm(sid, false);
        }
        if (typeof sid === "string" && store.isKept(sid)) release = store.hold(sid);
        // Who asks, for a read that holds the loop all the same: the route as it is registered, its values left out (src/core/asker.ts).
        const res = await asAsker(routeOf(req), () => timed(label, () => h(req, srv)));
        return await timed(label, () => compressJson(req, res));
      } catch (e) {
        // A write the store refused (it takes none right now): the refusal's own answer, not a failure of the daemon's.
        if (refusedWrite(e) || diskFull(e)) return json({ error: checkpointerOf(store)?.refusalSays ?? STORE_REFUSES, store_refusing: true }, 503);
        const st = (e as any)?.status;
        // `code`: a machine-readable reason, when the refusal has one (off_branch).
        if (typeof st === "number" && st >= 400 && st < 500) return json({ error: (e as Error).message, ...((e as any).code ? { code: (e as any).code } : {}) }, st);
        const rec = errors.capture("server", e, { url: new URL(req.url).pathname, method: req.method });
        return json({ error: rec.message, error_id: rec.id }, 500);
      } finally {
        release?.();
        answered();
        clearTimeout(timer);
        if (slow) srv.timeout(req, IDLE_S);
      }
    };

  // The page: the one embedded in the binary, or a bundle installed since (ui-bundle.ts).
  // A built binary serves its bundle compressed (compress.ts); the dev
  // server bundles on request with HMR and serves the files itself.
  const uiError = (e: Error) => errors.capture("server", e, { at: "ui bundle" });
  const built = embeddedBuilt();
  const ui = new UiBundles(store.stateDir, daemonApi(), { version: built ? String(built) : "dev", built: built || Date.now() }, uiError);
  const embeddedUi = bundleRoutes(index, PAGES, uiError, (h) => stamp(h, ui.embedded.version)) ?? Object.fromEntries(PAGES.map((p) => [p, index]));
  const swapUi = () => {
    server.reload({ ...options, routes: { ...ui.routes(PAGES, embeddedUi), ...routes } });
    bus.emit({ t: "ui", version: ui.active.version });
    return json(ui.status());
  };
  live.ui = () => ui.active.version;

  // The sends the page named (`client_id` on a message): each is stored once.
  store.migrate("CREATE TABLE IF NOT EXISTS sends (client_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, created_ms INTEGER NOT NULL)");
  const sendOf = store.db.query<{ fingerprint: string; receipt: string }, [string]>("SELECT fingerprint, receipt FROM sends WHERE client_id = ?");
  const sendIn = store.db.query<{ receipt: string }, [string, string]>("SELECT receipt FROM sends WHERE client_id = ? AND session_id = ?");
  const recordSend = store.db.query("INSERT INTO sends (client_id, session_id, fingerprint, receipt, created_ms) VALUES (?, ?, ?, ?, ?)");
  // The prune reads by age and a deleted session's rows go by session: an index for each.
  store.migrate("CREATE INDEX IF NOT EXISTS sends_created ON sends(created_ms)");
  store.migrate("CREATE INDEX IF NOT EXISTS sends_session ON sends(session_id)");
  const dropOldSends = store.db.query("DELETE FROM sends WHERE created_ms < ?");
  const dropSendsOf = store.db.query("DELETE FROM sends WHERE session_id = ?");

  const routes = withModules({
      // GET: what is served; POST: a bundle (.tar.gz) to serve now; rollback: the one before.
      "/api/ui": {
        GET: wrap(() => json(ui.status())),
        POST: wrap(async (req) => {
          await ui.install(new Uint8Array(await req.arrayBuffer()));
          return swapUi();
        }),
      },
      "/api/ui/rollback": { POST: wrap(() => (ui.rollback(), swapUi())) },

      "/api/models": {
        GET: wrap(async (req) => {
          const q = new URL(req.url).searchParams;
          const force = q.has("refresh");
          const models = providers.marked(await providers.models(force));
          // The providers by their names (a limit, a group of the picker): a page names one before it lists any model.
          const groups = providers.statuses().filter((p) => p.available).map((p) => ({ id: p.id, label: p.label }));
          // `brief`: what a page shows before anybody opens a list of models:
          // the default and the models its sessions run on (a few entries of
          // a listing that can hold hundreds), with how many there are in all.
          if (q.has("brief")) {
            const def = await providers.defaultModel();
            const shown = new Set<string>([def, ...store.sessions().map((s) => s.model), ...q.getAll("id")]);
            return json({ models: models.filter((m) => shown.has(m.id)), default: def, total: models.length, providers: groups });
          }
          const c = providers.choices();
          return json({ models, default: await providers.defaultModel(), pinned: (c.pinned ?? []).filter((id) => models.some((m) => m.id === id)), providers: groups });
        }),
      },

      "/api/sessions": {
        GET: wrap((req) => {
          const q = new URL(req.url).searchParams;
          const fs = [...listFilters.values()];
          // `level`: how far the list had moved when it was read (the socket's hello says the same of its open).
          // `rev`: the last frame the list reflects, so a page keeps what a newer frame told it of a row.
          const all = store.sessions({ archived: q.has("archived") }).filter((s) => fs.every((f) => f(s, q)));
          const at = { level: bus.sessionsLevel(), rev: bus.rev() };
          // Agents' sessions at rest are left out and counted (session-list.ts); the archive and `agents=all` carry every row.
          const of = q.get("agents_of");
          if (of) return json({ sessions: agentsUnder(all, of), ...at });
          if (q.has("archived") || q.get("agents") === "all") return json({ sessions: all, ...at });
          const live = new Set<string>();
          try { for (const r of store.db.query<{ session_id: string }, []>("SELECT session_id FROM agents WHERE status IN ('running', 'waiting')").all()) live.add(r.session_id); } catch {} // no agents table: no agent was ever started
          const lean = leanSessions(all, (id) => live.has(id) || engine.isRunning(id));
          return json({ sessions: lean.sessions, agents_left: lean.left, ...at });
        }),
        POST: wrap(async (req) => {
          const body = (await req.json().catch(() => ({}))) as any;
          const workspace = resolve(body.workspace || deps.workspace);
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) return bad(`not a directory: ${workspace}`);
          const model = body.model || (await providers.defaultModel());
          if (!model) return bad("no model is available: no provider has credentials", 409);
          // Nothing is made yet: a model that cannot be used is a refusal, not a failure.
          try { await providers.resolve(model); } catch (e) { return bad(`${(e as Error).message}: pick another model`, 409); }
          let s = store.createSession({ model, workspace, title: body.title });
          // Module fields given at creation (tags, max_steps, the memory switches) hold or refuse it.
          const mine = [...patchers.values()].filter((p) => p.fields.some((f) => body[f] !== undefined));
          try {
            for (const p of mine) await p.check?.(s, body);
            for (const p of mine) await p.apply(s, body);
          } catch (e) {
            store.deleteSession(s.id);
            throw e;
          }
          s = store.session(s.id)!;
          bus.emit({ t: "session", session: s });
          if (body.text || body.images?.length) await fitted(s.id, body.images, (images) => engine.send(s.id, String(body.text ?? "").trim(), { images }));
          return json({ session: store.session(s.id) }, 201);
        }),
      },

      "/api/sessions/:id": {
        GET: wrap(async (req) => {
          if (!session(req.params.id)) return bad("no such session", 404);
          // `events=0`: the session as it is now without its transcript, for a
          // page that holds the events and takes the ones after its cursor
          // from the socket (a reconnect). The transcript is not read at all.
          // `page=N`: the newest N events of its branch (see pageOf), for a
          // reader that takes the older ones as it needs them.
          const q = new URL(req.url).searchParams;
          const bare = q.get("events") === "0";
          const page = Number(q.get("page")) || 0;
          // The whole session (no `page`): every event of it, all branches. It
          // is written on the read thread from the rows as they are stored
          // (routes/session-read.ts): the loop reads, parses and compresses
          // none of it, and the session is not brought into memory for it.
          // What goes with the events is the session as it stands now; `seq`
          // is the newest of the events answered, so a reader that goes on
          // from it misses nothing stored meanwhile.
          if (!bare && page <= 0) {
            const s = session(req.params.id)!;
            const head = `{"session":${JSON.stringify(s)},"events":`;
            const tail = `,${JSON.stringify({ running: engine.isRunning(s.id), bytes_per_token: bytesPerToken(s.model), queue: engine.queued(s.id), held: engine.isHeld(s.id), status: engine.statusOf(s.id), draft: live.draft(s.id), rev: bus.rev() }).slice(1)}`;
            const whole = await readsOf(store).run("session.whole", { session: s.id, head, tail, coding: codingOf(req) });
            const headers = { "content-type": "application/json;charset=utf-8", ...(whole.coding ? { "content-encoding": whole.coding, vary: "Accept-Encoding" } : {}) };
            // A long answer goes out a part at a time, the loop free between the parts: tens of megabytes
            // handed to the socket in one piece are copied where every other session waits.
            if (whole.body.length <= WHOLE_PART) return new Response(whole.body, { headers });
            let at = 0;
            return new Response(new ReadableStream<Uint8Array>({
              pull(c) {
                c.enqueue(whole.body.subarray(at, (at += WHOLE_PART)));
                if (at >= whole.body.length) c.close();
              },
            }), { headers });
          }
          // A part of a transcript that is not in memory: its events are
          // brought in without their bodies, a part at a time, and what is
          // answered is read after that, in one piece.
          if (!bare) await store.warm(req.params.id, false);
          // And the bodies of the part asked for, which a session at rest gave back: read off the loop, not while it is written out.
          if (!bare && page > 0 && store.session(req.params.id)) await warmPart(req.params.id, { limit: page });
          // The rest runs in one piece after that wait, where the handler is no
          // longer timed as a whole: reading a long branch out and writing it
          // as JSON is named, should it hold the loop (src/admin/stall.ts).
          return timed(() => `answering GET /api/sessions/${req.params.id} (reading the session out and writing it as JSON)`, () => {
            const s = session(req.params.id);
            if (!s) return bad("no such session", 404);
            const events = bare ? undefined : pageOfLine(store.lineage(s.id), { limit: page }, (parent) => store.versions(s.id, parent), s.head, true).events;
            // `seq`: the session's newest seq on any branch, which a reader that
            // holds a part of the session resumes from (its own last event may
            // be far below it: the branch shown is not always the newest).
            // `paged`: the answer is a part, and the page routes give the rest.
            return json({ session: s, ...(events ? { events } : {}), seq: store.lastSeq(s.id), ...(page > 0 && !bare ? { paged: true } : {}), running: engine.isRunning(s.id), bytes_per_token: bytesPerToken(s.model), queue: engine.queued(s.id), held: engine.isHeld(s.id), status: engine.statusOf(s.id), draft: live.draft(s.id), rev: bus.rev() });
          });
        }),
        PATCH: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const body = (await req.json()) as any;
          if (body.title !== undefined && !String(body.title).trim()) return bad("the title cannot be empty");
          // The whole change is checked before anything is written: a refused
          // request leaves the model, the settings and the history as they were.
          const moving = body.model && body.model !== s.model ? await resolveSwitchModel(providers, body.model) : undefined;
          // A model switch keeps only what the new model takes (an effort or a
          // speed it does not list is dropped, as the profile POST does).
          let settings = moving ? carrySettings(s.settings, moving) : s.settings;
          if (body.settings) {
            settings = { ...settings };
            for (const [k, v] of Object.entries(body.settings)) {
              if (v === null || v === "") delete (settings as any)[k];
              else (settings as any)[k] = v;
            }
            const info = moving ?? (await providers.models()).find((m) => m.id === s.model);
            if (body.settings.effort && settings.effort && info && !info.efforts.includes(settings.effort)) return bad(`${info.name} does not take effort ${settings.effort}`);
            if (settings.fallback !== undefined) {
              if (typeof settings.fallback !== "string") return bad("fallback must be a model ID");
              try { await providers.resolve(settings.fallback); }
              catch (e) { if (e instanceof ModelLookupError) return bad(e.message); throw e; }
            }
            if (body.settings.speed && info && !speedOffer(info, settings.speed)) return bad(`${info.name} has no ${settings.speed} speed on ${info.provider}`);
            if (settings.compact_at !== undefined && !(Number(settings.compact_at) > 0)) return bad("compact_at must be a number of tokens above 0");
          }
          const mine = [...patchers.values()].filter((p) => p.fields.some((f) => body[f] !== undefined));
          for (const p of mine) await p.check?.(s, body);
          // Archiving stops the session: the turn is cut and its queue held. Its
          // background commands stop only when the request says so.
          if (body.archived === true && !s.archived) {
            const jobs = jobsOf(s.id).filter(jobLive);
            if (jobs.length && body.stop_shells !== true) return json({ error: `the session still runs ${jobs.length} background command${jobs.length > 1 ? "s" : ""}: ${jobs.map((j) => j.command.slice(0, 80)).join("; ")}. Archive with stop_shells to stop them.`, jobs: jobs.map((j) => ({ id: j.id, command: j.command })) }, 409);
            await engine.interrupt(s.id, "archive");
            // While its commands are stopped nothing that comes due starts a turn in it (a command's end, a
            // report), and it is archived in the same step the stop ends in.
            const left = await engine.whileClosing([s.id], async () => {
              const left = await stopJobs(jobs, "was stopped: its session was archived");
              while (engine.isRunning(s.id)) await engine.interrupt(s.id, "archive");
              if (!left.length) store.updateSession(s.id, { archived: true });
              return left;
            });
            if (left.length) return json({ error: `the session was not archived: ${left.length > 1 ? "these commands" : "this command"} would not stop: ${leftText(left)}`, jobs: left.map((j) => ({ id: j.id, command: j.command, pids: j.left })) }, 409);
          }
          const core = body.title !== undefined || body.model !== undefined || body.archived !== undefined || body.settings !== undefined;
          // A title the owner gives is theirs: no made title replaces it (src/engine/title.ts).
          const patch = { title: body.title?.trim(), ...(body.title !== undefined ? { title_by: "" as const } : {}), archived: body.archived, settings };
          let next = moving ? await commitSwitch(store, bus, providers, s, moving, patch, { running: engine.isRunning(s.id) }) : core ? store.updateSession(s.id, { ...patch, model: body.model }) : s;
          for (const p of mine) await p.apply(next, body);
          next = store.session(s.id)!;
          bus.emit({ t: "session", session: next });
          return json({ session: next });
        }),
        DELETE: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          // Its subagent sessions go with it (the rows cascade): each is
          // stopped first, deepest first, so no turn writes to a session
          // already gone. Their commands and spilled files go too; a command
          // that would not stop keeps the whole family.
          const family = [...store.descendants(s.id).reverse(), s.id];
          for (const id of family) await engine.interrupt(id, "delete");
          // While their commands are stopped nothing that comes due starts a turn in one of them, and
          // each is removed with no turn of its own running (one the owner started meanwhile is stopped).
          return engine.whileClosing(family, async () => {
            const left = await stopJobs(family.flatMap((id) => jobsOf(id).filter(jobLive)), "was stopped: its session was deleted");
            if (left.length) return json({ error: `the session was not deleted: ${left.length > 1 ? "these commands" : "this command"} would not stop: ${leftText(left)}`, jobs: left.map((j) => ({ id: j.id, command: j.command, session_id: j.sessionId, pids: j.left })) }, 409);
            for (const id of family) {
              while (engine.isRunning(id)) await engine.interrupt(id, "delete");
              const x = store.session(id);
              if (!x) continue;
              rmSync(join(store.stateDir, "spill", id), { recursive: true, force: true });
              store.deleteSession(id);
              dropSendsOf.run(id);
              bus.emit({ t: "session", session: { ...x, archived: true, phase: "idle" }, deleted: true });
            }
            return json({ ok: true });
          });
        }),
      },

      // A part of one branch of the session (see pageOf): older or newer than
      // a seq, or around an event, on the branch `head` ends (default: the
      // session's). The session's own branch is the one the store keeps: its
      // edges are found by halving, and nothing else of the session is read.
      "/api/sessions/:id/page": {
        GET: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
          const limit = Math.min(Number(q.get("limit")) || 200, 2000);
          const head = q.get("head") || undefined, around = q.get("around") || undefined;
          const ask = { limit, before: num("before"), after: num("after") };
          // (The part's bodies are read off the loop first: a session at rest holds none.)
          const own = async (at?: number) => { await warmPart(s.id, { ...ask, at }); return json(pageOfLine(store.lineage(s.id), { ...ask, at }, (parent) => store.versions(s.id, parent), s.head, true)); };
          if (around) {
            const e = store.event(around);
            if (!e || e.session_id !== s.id) return bad("no such event in this session", 404);
            const line = store.lineage(s.id);
            const at = firstAt(line, e.seq);
            if (line[at]?.id === e.id) return own(at);
          } else if (keptLine(s, head)) return own();
          const page = pageOf(store.events(s.id), s.head, { ...ask, head, around });
          return page ? json(page) : bad("no such event in this session", 404);
        }),
      },

      // How many prompts of a branch (as the transcript shows them) lie
      // outside the part a reader holds: older than `before`, newer than
      // `after` (both seqs). Counted once per state of the session's branch.
      "/api/sessions/:id/users": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const head = q.get("head") || s.head;
          const line = keptLine(s, head) ?? lineage(store.events(s.id), head);
          let seqs = promptSeqs.get(line);
          if (!seqs) promptSeqs.set(line, (seqs = line.filter(shownAsPrompt).map((e) => e.seq)));
          const below = (seq: number) => { let lo = 0, hi = seqs.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (seqs[mid]! >= seq) hi = mid; else lo = mid + 1; } return lo; };
          return json({ before: q.has("before") ? below(Number(q.get("before"))) : 0, after: q.has("after") ? seqs.length - below(Number(q.get("after")) + 1) : 0, total: seqs.length });
        }),
      },

      // The newest call of one of the named tools on the session's branch whose
      // result was not an error, older than `before` (a seq): what a reader that
      // holds only the branch's end needs of the rest (the plan in force). The
      // search index names the replies that hold such a call, and only they and
      // the results after them are read, a long read on the read thread: the
      // branch's bodies are not walked on the loop (routes/calls-read.ts).
      "/api/sessions/:id/last-call": {
        GET: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const names = [...new Set((q.get("names") ?? "").split(",").filter(Boolean))];
          const before = q.has("before") && Number.isFinite(Number(q.get("before"))) ? Number(q.get("before")) : null;
          const reads = readsOf(store);
          const call = await lastCall({ db: store.db, named: (a) => reads.run("calls.named", a), answered: (a) => reads.run("calls.answered", a), line: () => store.lineage(s.id) }, s.id, names, before);
          return json({ call });
        }),
      },

      // The whole reply of a turn, for a reader that holds only the end of it
      // (a turn longer than a part): the texts stored before `before` (a seq)
      // back to the turn's prompt. `last`: the newest reply with any text.
      // `head`: a branch other than the session's.
      "/api/sessions/:id/reply": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const head = q.get("head");
          const line = keptLine(s, head) ?? lineage(store.events(s.id), head);
          return json({ texts: replyBefore(line, q.has("before") ? firstAt(line, Number(q.get("before"))) : line.length, q.has("last")) });
        }),
      },

      // What an export leaves behind and what it would carry, counted here so
      // the dialog needs no event: the session's branches, and for the branch
      // shown and for every branch the sizes of the files its prompts name
      // and the bytes of its events as JSON (measured only when files are
      // named: it is what the size of a file with them inside is counted from).
      "/api/sessions/:id/branches": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const all = store.events(s.id);
          const carried = (list: readonly StoredEvent[]) => {
            const sizes = new Map<string, number>();
            for (const e of list) if (e.kind === "user") for (const b of e.data.images ?? []) if (b.type === "attachment") sizes.set(b.id, b.size ?? 0);
            return { sizes: [...sizes.values()], json: sizes.size ? Buffer.byteLength(JSON.stringify(list)) : 0 };
          };
          return json({ branches: leafCount(all), shown: carried(store.lineage(s.id)), all: carried(all) });
        }),
      },

      "/api/sessions/:id/events": {
        GET: wrap((req) => {
          const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
          return json({ events: store.events(req.params.id, after) });
        }),
      },

      "/api/sessions/:id/messages": {
        POST: wrap(async (req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          if (s.archived) return bad("the session is archived", 409);
          const body = (await req.json()) as any;
          const text = String(body.text ?? "").trim();
          // An image or a file may go without a caption; an edit needs words.
          if (!text && !(body.edit_of ? store.event(String(body.edit_of))?.data.images?.length : body.images?.length)) return bad("text cannot be empty");
          if (body.mode && !["send", "steer", "queue"].includes(body.mode)) return bad(`unknown mode ${body.mode}`);
          // A prompt to a session that is not in memory: its pages are read off the loop before the loop reads its branch.
          await store.warm(s.id, false);
          if (body.edit_of) return json(await engine.edit(s.id, String(body.edit_of), text), 201);
          // `client_id` names the send, made by the page and kept with the
          // message until an answer arrives. The same id again (the answer was
          // lost, or the daemon was away) gets the receipt of the prompt it
          // already stored and stores nothing. A send without one is a new
          // prompt each time.
          const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
          if (clientId.length > 80) return bad("the send id is longer than 80 characters");
          if (!clientId) return json(await fitted(s.id, body.images, (images) => engine.send(s.id, text, { mode: body.mode, images })), 201);
          const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([s.id, text, body.images ?? []])).digest("hex");
          const prior = () => {
            const r = sendOf.get(clientId);
            if (!r) return undefined;
            if (r.fingerprint !== fingerprint) throw Object.assign(new Error("this send id was used for another message; send this one under a new id"), { status: 409 });
            return { ...JSON.parse(r.receipt), replayed: true };
          };
          const had = prior();
          if (had) return json(had);
          // The prompt and its receipt are one write: a daemon that stops between
          // them has neither, and the retry stores the prompt once.
          const out = await fitted(s.id, body.images, (images) => store.atomic(s.id, () => {
            // Read again inside the write: the same send may have come in while the images were fitted.
            const now = prior();
            if (now) return now;
            const r = engine.send(s.id, text, { mode: body.mode, images });
            // The receipt names what was stored, without the images' bytes.
            const receipt = r.event ? { event: { id: r.event.id, seq: r.event.seq } } : { queued: { id: r.queued!.id }, steer: r.steer };
            recordSend.run(clientId, s.id, fingerprint, JSON.stringify(receipt), Date.now());
            dropOldSends.run(Date.now() - 30 * 86_400_000);
            return r;
          }));
          return json(out, "replayed" in out ? 200 : 201);
        }),
      },

      // What became of a send the page named: the receipt of the prompt it
      // stored (the event, or the queue entry it waits in), or that nothing
      // was stored under that id. A page whose answer was lost asks here, by
      // the send's own id: the words of a prompt say nothing about which
      // send it was.
      "/api/sessions/:id/sends/:send": {
        GET: wrap((req) => {
          if (!store.session(req.params.id)) return bad("no such session", 404);
          const r = sendIn.get(req.params.send, req.params.id);
          return json(r ? { stored: true, ...JSON.parse(r.receipt) } : { stored: false });
        }),
      },

      "/api/sessions/:id/interrupt": {
        POST: wrap(async (req) => {
          // `by`: who asked, kept on the turn's end. "owner" is the owner's own Stop (the page and the
          // command line send it): the queue then waits for the owner and a goal pauses. A caller that
          // names nobody stops the turn and nothing else, and its end never says the owner did it.
          const body = (await req.json().catch(() => ({}))) as { by?: unknown };
          await engine.interrupt(req.params.id, body.by === "owner" ? "owner" : "api");
          return json({ ok: true });
        }),
      },

      // `?link`: a page asking whether it reaches the daemon at all while its socket says nothing.
      // That answer's connection is closed after it, so the next such question never goes into a
      // connection the browser kept from before a network changed, which would say nothing either.
      // (`store`: the store's disk does not answer, or is slow: the same words the daemon's status has.)
      "/api/health": { GET: (req: Request) => {
        if (new URL(req.url).searchParams.has("link")) return Response.json({ ok: true, pid: process.pid }, { headers: { connection: "close", "cache-control": "no-store" } });
        const disk = checkpointerOf(store)?.said;
        return json({ ok: true, pid: process.pid, ...(disk ? { store: disk } : {}) });
      } },

      // What this daemon serves, with the methods a script may rely on (stable-api.ts).
      "/api/routes": { GET: wrap(() => json(routeTable(routes))) },
    }, modules, deps, wrap, !!opts.development);
  // A route a script may rely on is there under its documented path and
  // method. A rename that left the stable table behind fails a dev daemon's
  // start with this error: it serves nothing and binds no port (its process
  // stays, as a hot-reloading one does after any start error, and says why
  // once). A built daemon records the error and serves.
  const { missing } = routeTable(routes);
  if (missing.length) {
    const e = new Error(`stable routes not served: ${missing.join(", ")} (src/server/stable-api.ts lists them; docs/http-api.md is made from it)`);
    if (opts.development) throw e;
    errors.capture("server", e, { at: "routes" });
  }

  const options = {
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: IDLE_S,
    // The largest body a request may carry: Bun's own default, said here so an
    // upgrade cannot move it. A Keel file with its attached files is the
    // largest thing sent; the export refuses to write one over it.
    maxRequestBodySize: KEEL_FILE_MAX,
    reusePort: false, // one daemon per port (Bun 1.4 binds a taken port anyway: start.ts checks first)
    development: opts.development ? { hmr: true, console: true } : false,
    async fetch(req: Request, srv: Bun.Server<undefined>) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        const refused = await admit(req, srv);
        if (refused) return refused;
        if (srv.upgrade(req)) return;
        return bad("websocket upgrade failed");
      }
      return bad("not found", 404);
    },

    websocket: {
      open(ws) { const h = socketKind(ws); if (h) h.open?.(ws); else live.open(ws); },
      message(ws, m) { const h = socketKind(ws); timed(() => "handling a page's socket message", () => (h ? h.message?.(ws, m) : live.message(ws, m))); },
      close(ws, code, reason) { socketKind(ws)?.close?.(ws, code, reason); },
      // Pings while quiet; a client silent for 40 s is gone. One that stops
      // reading is closed instead of buffered without end: a page resumes on reconnect.
      idleTimeout: 40,
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
    },
  } satisfies Partial<Bun.Serve.Options<unknown>>;
  const server = Bun.serve({ ...options, routes: { ...ui.routes(PAGES, embeddedUi), ...routes } } as any);
  // The sandbox's proxy never connects here, whatever is listed for a sandbox (src/safety/net-proxy.ts).
  ownPort(server.port);
  // What goes wrong with the proxies' thread is in the Errors panel.
  onProxyTrouble((e, at) => errors.capture("server", e, { at }));
  // A configuration file a variable puts inside a session's folder is not loaded (src/core/named-config.ts): said once.
  setSessionFolders(() => sessionFoldersOf(store));
  onConfigRefused((r) => errors.capture("server", new Error(refusedSentence(r)), { at: "config" }));
  return server;
}
