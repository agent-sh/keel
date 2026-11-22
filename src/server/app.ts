import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import { firstAt, leafCount, lineage, pageOf, pageOfLine, replyBefore } from "../core/tree.ts";
import { shownAsPrompt } from "../core/owner.ts";
import type { StoredEvent } from "../core/types.ts";
import type { Session } from "../core/types.ts";
import type { Engine } from "../engine/turn.ts";
import type { Providers } from "../providers/registry.ts";
import { jobsOf, leftText, jobLive, stopJobs } from "../tools/jobs.ts";
import { admit, initAccess } from "./admission.ts";
import { Live } from "./live.ts";
import index from "../../ui/index.html";
import { speedOffer } from "../providers/registry.ts";
import { carrySettings, commitSwitch } from "./switch.ts";
import { bundleRoutes, compressJson } from "./compress.ts";
import { daemonApi, embeddedBuilt, stamp, UiBundles } from "./ui-bundle.ts";
import { fitted } from "../engine/image-fit.ts";
import { bytesPerToken } from "../engine/compact.ts";
import { KEEL_FILE_MAX } from "../core/keel-file.ts";
import { inFlight, timed } from "../admin/stall.ts";
import { routeTable } from "./stable-api.ts";
import { ownPort } from "../safety/net-proxy.ts";

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
    for (const [path, methods] of Object.entries(m(deps))) {
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

const json = (data: unknown, status = 200) => Response.json(data, { status });
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
      try {
        const refused = await admit(req, srv);
        if (refused) return refused;
        const res = await timed(label, () => h(req, srv));
        return await timed(label, () => compressJson(req, res));
      } catch (e) {
        const st = (e as any)?.status;
        // `code`: a machine-readable reason, when the refusal has one (off_branch).
        if (typeof st === "number" && st >= 400 && st < 500) return json({ error: (e as Error).message, ...((e as any).code ? { code: (e as any).code } : {}) }, st);
        const rec = errors.capture("server", e, { url: new URL(req.url).pathname, method: req.method });
        return json({ error: rec.message, error_id: rec.id }, 500);
      } finally {
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
          return json({ sessions: store.sessions({ archived: q.has("archived") }).filter((s) => fs.every((f) => f(s, q))), level: bus.sessionsLevel(), rev: bus.rev() });
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
          // A transcript that is not in memory is brought in a part at a time,
          // so a long one does not hold every other session while it is read.
          // What is answered is read after that, in one piece. A reader that
          // asks for a part has the events brought in without their bodies.
          if (!bare) await store.warm(req.params.id, page <= 0);
          // The rest runs in one piece after that wait, where the handler is no
          // longer timed as a whole: reading a long branch out and writing it
          // as JSON is named, should it hold the loop (src/admin/stall.ts).
          return timed(() => `answering GET /api/sessions/${req.params.id} (reading the session out and writing it as JSON)`, () => {
            const s = session(req.params.id);
            if (!s) return bad("no such session", 404);
            const events = bare ? undefined : page > 0 ? pageOfLine(store.lineage(s.id), { limit: page }, (parent) => store.versions(s.id, parent), s.head, true).events : store.events(s.id);
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
          const moving = body.model && body.model !== s.model ? (await providers.resolve(body.model)).info : undefined;
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
            if (settings.fallback) await providers.resolve(settings.fallback);
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
            await engine.interrupt(s.id);
            // While its commands are stopped nothing that comes due starts a turn in it (a command's end, a
            // report), and it is archived in the same step the stop ends in.
            const left = await engine.whileClosing([s.id], async () => {
              const left = await stopJobs(jobs, "was stopped: its session was archived");
              while (engine.isRunning(s.id)) await engine.interrupt(s.id);
              if (!left.length) store.updateSession(s.id, { archived: true });
              return left;
            });
            if (left.length) return json({ error: `the session was not archived: ${left.length > 1 ? "these commands" : "this command"} would not stop: ${leftText(left)}`, jobs: left.map((j) => ({ id: j.id, command: j.command, pids: j.left })) }, 409);
          }
          const core = body.title !== undefined || body.model !== undefined || body.archived !== undefined || body.settings !== undefined;
          const patch = { title: body.title?.trim(), archived: body.archived, settings };
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
          for (const id of family) await engine.interrupt(id);
          // While their commands are stopped nothing that comes due starts a turn in one of them, and
          // each is removed with no turn of its own running (one the owner started meanwhile is stopped).
          return engine.whileClosing(family, async () => {
            const left = await stopJobs(family.flatMap((id) => jobsOf(id).filter(jobLive)), "was stopped: its session was deleted");
            if (left.length) return json({ error: `the session was not deleted: ${left.length > 1 ? "these commands" : "this command"} would not stop: ${leftText(left)}`, jobs: left.map((j) => ({ id: j.id, command: j.command, session_id: j.sessionId, pids: j.left })) }, 409);
            for (const id of family) {
              while (engine.isRunning(id)) await engine.interrupt(id);
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
        GET: wrap((req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
          const limit = Math.min(Number(q.get("limit")) || 200, 2000);
          const head = q.get("head") || undefined, around = q.get("around") || undefined;
          const ask = { limit, before: num("before"), after: num("after") };
          const own = (at?: number) => json(pageOfLine(store.lineage(s.id), { ...ask, at }, (parent) => store.versions(s.id, parent), s.head, true));
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
      // holds only the branch's end needs of the rest (the plan in force). One
      // walk back from there, which ends at the call.
      "/api/sessions/:id/last-call": {
        GET: wrap((req) => {
          const s = session(req.params.id);
          if (!s) return bad("no such session", 404);
          const q = new URL(req.url).searchParams;
          const names = new Set((q.get("names") ?? "").split(",").filter(Boolean));
          const line = store.lineage(s.id);
          // A result is stored after its call: going back, the results come first.
          const ok = new Set<string>();
          for (let i = (q.has("before") ? firstAt(line, Number(q.get("before"))) : line.length) - 1; i >= 0; i--) {
            const e = line[i]!;
            if (e.kind === "tool_result") { for (const r of e.data.results) if (!r.is_error) ok.add(r.tool_use_id); continue; }
            if (e.kind !== "assistant") continue;
            for (let k = e.data.blocks.length - 1; k >= 0; k--) {
              const b = e.data.blocks[k];
              if (b.type === "tool_use" && names.has(b.name) && ok.has(b.id)) return json({ call: { name: b.name, input: b.input, seq: e.seq } });
            }
          }
          return json({ call: null });
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
          // `by`: who asked (the workbench sends "owner"), kept on the turn's end.
          const body = (await req.json().catch(() => ({}))) as { by?: unknown };
          await engine.interrupt(req.params.id, typeof body.by === "string" && /^[a-z-]{1,24}$/.test(body.by) ? body.by : undefined);
          return json({ ok: true });
        }),
      },

      "/api/health": { GET: () => json({ ok: true, pid: process.pid }) },

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
  return server;
}
