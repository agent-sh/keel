// Sessions another harness runs on this machine, in Keel's record while they
// run (src/integrations/outside/service.ts).
//
// GET  /api/outside                          -> what is watched and what that cost so far
// GET  /api/sessions/:id/outside             -> its files, its usage by model with cost, its source;
//                                               the transcript is brought up to date first
// POST /api/sessions/:id/outside/copy        -> a Keel session that goes on with it (the import path:
//                                               its copy brought up to date, else a new copy)
// POST /api/sessions/:id/outside/send        -> { text, client_id, again? }: the text sent to that session
//                                               in its own harness (Codex: codex-app.ts, Claude Code:
//                                               claude-code.ts), stored first
//                                               and delivered once; refused while another process holds it,
//                                               except a terminal the agent view lists: typed into it there
//                                               (terminal.ts)
// DELETE /api/sessions/:id/outside/sends/:send -> a send that was lost or refused, put away
// POST /api/sessions/:id/outside/interrupt   -> the turn Keel runs in it, stopped
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { Outside } from "../../integrations/outside/service.ts";
import { CodexApp } from "../../integrations/outside/codex-app.ts";
import { ClaudeCode } from "../../integrations/outside/claude-code.ts";
import { codexHome } from "../../integrations/import/codex.ts";
import { claudeRoot } from "../../integrations/import/claude.ts";
import { waitPlan } from "./plan.ts";
import { Through } from "../../integrations/outside/terminal.ts";
import { sharedDrive } from "../../drive/drive.ts";
import { allHooks } from "../../engine/hooks.ts";
import { ownerEnv, ownerLookup } from "../../core/paths.ts";
import { gate } from "./permissions.ts";
import { modelFor, sharedImports } from "../../integrations/import/service.ts";
import { record } from "../../automation/failures.ts";
import { closeAsks } from "../../automation/alerts.ts";
import { isOutside } from "../../core/outside.ts";
import { classOf } from "../../automation/failure-groups.ts";
import type { RouteModule } from "../app.ts";
import { seesOutside } from "../admission.ts";
import "../../integrations/outside/settings.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const isDir = (p?: string) => { try { return !!p && statSync(p).isDirectory(); } catch { return false; } };

export let outside: Outside | undefined;
export let codexApp: CodexApp | undefined;
export let claudeCode: ClaudeCode | undefined;

// The codex program a Codex session is answered with: KEEL_CODEX_BIN, else the owner's codex on his PATH.
const codexBin = () => process.env.KEEL_CODEX_BIN?.trim() || Bun.which("codex", { PATH: ownerLookup("PATH") ?? "" }) || undefined;
// The claude program a Claude Code session is answered with: KEEL_CLAUDE_BIN, else the owner's claude on his PATH.
const claudeBin = () => process.env.KEEL_CLAUDE_BIN?.trim() || Bun.which("claude", { PATH: ownerLookup("PATH") ?? "" }) || undefined;
// Claude Code's folder for the child, when it is not its default: the folder the mirror reads.
const claudeConfig = () => (process.env.KEEL_IMPORT_CLAUDE_DIR ? dirname(claudeRoot()) : ownerEnv("CLAUDE_CONFIG_DIR"));

// The driver of a session Keel only reads: nothing is sent, stopped or answered there.
const READ_ONLY = {
  route: (_id: string, _holder?: unknown) => "none" as const,
  running: (_id: string) => false,
  sends: (_id: string) => [] as never[],
  notes: (_id: string) => [] as string[],
  answers: (_id: string) => ({}),
  send: (_id: string, _text: string, _key: string, _again?: string) => ({ error: "this session is read-only here: copy it into Keel to work on it", status: 409, holder: undefined }),
  dismiss: (_id: string, _send: string) => false,
  interrupt: async (_id: string) => false,
};

export const outsideRoutes: RouteModule = (deps) => {
  const { store, bus, engine, providers, errors } = deps;
  const g = globalThis as any;
  // A hot reload makes the module again: the watches of the one before go first.
  g.__keelOutside?.stop();
  g.__keelCodexApp?.stop();
  g.__keelClaudeCode?.stop();
  outside = g.__keelOutside = new Outside({
    store, bus, workspace: deps.workspace,
    price: (model, h) => providers.catalog.lookup(model, h === "claude" ? "anthropic" : h === "agy" ? "google" : "openai")?.price,
    viewed: (id) => !!engine.viewed?.(id),
    // The session's failures, grouped by cause as its own would be; nothing is owed to a model (none runs here).
    failed: (id, f) => { record(id, { kind: f.kind, cls: f.kind === "tool" ? f.tool : classOf(f.text), message: f.text }); },
    trouble: (e, at) => errors.capture("server", e, { at }),
    // A source with a copy in Keel shows on the copy, not as a session of its own.
    copied: (h, id) => sharedImports(store).links(h, id).length > 0,
    ours: (id) => !!codexApp?.ours(id) || !!claudeCode?.ours(id),
  });
  const tell = (f: (h: ReturnType<typeof allHooks>[number]) => void) => { for (const h of allHooks()) try { f(h); } catch (e) { errors.capture("server", e, { at: "a question of a session answered in place" }); } };
  const app = codexApp = g.__keelCodexApp = new CodexApp({
    store, bus, outside,
    gate: () => gate,
    bin: codexBin,
    home: codexHome,
    trouble: (e, at) => errors.capture("server", e, { at }),
    asked: (sid, call, text, ask) => tell((h) => h.ownerAsked?.(sid, call, text, ask)),
    answered: (sid, call, answered, ask) => tell((h) => h.ownerAnswered?.(sid, call, answered, ask)),
    cutAsks: () => void closeAsks("codex-", (id) => isOutside(store.session(id))),
  });
  const claude = claudeCode = g.__keelClaudeCode = new ClaudeCode({
    store, bus, outside,
    gate: () => gate,
    bin: claudeBin,
    configDir: claudeConfig,
    runningDir: () => outside!.roots().claudeRunning,
    trouble: (e, at) => errors.capture("server", e, { at }),
    asked: (sid, call, text, ask) => tell((h) => h.ownerAsked?.(sid, call, text, ask)),
    answered: (sid, call, answered, ask) => tell((h) => h.ownerAnswered?.(sid, call, answered, ask)),
    plan: waitPlan,
    cutAsks: () => void closeAsks("claude-", (id) => isOutside(store.session(id))),
  });
  sharedImports(store).onCopy("outside", (h, id) => { if (h === "claude" || h === "codex" || h === "agy") outside?.copiedNow(h, id); });
  outside.start();
  app.start();
  claude.start();
  const o = outside;
  // The driver that answers a session in place: its harness's. Antigravity has none: Keel only reads its sessions.
  const driver = (id: string) => { const h = o.row(id)?.harness; return h === "claude" ? claude : h === "agy" ? READ_ONLY : app; };
  // A session a terminal holds is typed into that terminal by the agent view, when it lists the session.
  const through = new Through({ store, drive: sharedDrive(), source: (id) => o.row(id) });
  const terminal = (id: string, holder: { kind: string } | undefined, route: string) =>
    route === "held" && holder?.kind === "terminal" && (o.row(id)?.harness === "claude" || o.row(id)?.harness === "codex");
  // What the bar shows besides the transcript's facts: who holds it, what a send does now, the sends not yet delivered.
  const inPlace = (id: string, base = o.holderNow(id)) => {
    const d = driver(id);
    // (Claude Code takes no lock: its driver says who holds it as a send decides, a write no record explains too.)
    const holder = d instanceof ClaudeCode ? d.holder(id, base) : base;
    const way = o.row(id) ? d.route(id, holder) : "none";
    const route = terminal(id, holder, way) && through.listed(id) ? "terminal" : way;
    return { holder, route, turn: d.running(id), sends: d.sends(id), notes: d.notes(id), answers: d.answers(id) };
  };
  return {
    // (The owner's alone, as the sessions are: peer-scope.ts blindTo.)
    "/api/outside": { GET: (req: Request) => (seesOutside(req) ? json(o.status()) : bad("not found", 404)) },
    "/api/sessions/:id/outside": {
      GET: async (req: Request & { params: { id: string } }) => {
        const d = await o.details(req.params.id);
        if (d?.holder?.kind === "terminal") await through.fresh();
        return d ? json({ ...d, ...inPlace(req.params.id, d.holder) }) : bad("not a session of another harness", 404);
      },
    },
    "/api/sessions/:id/outside/send": {
      POST: async (req: Request & { params: { id: string } }) => {
        const b = (await req.json().catch(() => null)) as { text?: unknown; client_id?: unknown; again?: unknown } | null;
        if (typeof b?.text !== "string") return bad("text is the message to send");
        const key = typeof b.client_id === "string" && b.client_id ? b.client_id.slice(0, 200) : crypto.randomUUID();
        const now = inPlace(req.params.id);
        if (through.on() && terminal(req.params.id, now.holder, now.route === "terminal" ? "held" : now.route)) {
          const t = await through.send(req.params.id, b.text, key);
          return "error" in t ? json({ error: t.error, holder: now.holder }, t.status) : json({ sent: t.sent, ...inPlace(req.params.id) }, 202);
        }
        const r = driver(req.params.id).send(req.params.id, b.text, key, typeof b.again === "string" ? b.again : undefined);
        return "error" in r ? json({ error: r.error, ...(r.holder ? { holder: r.holder } : {}) }, r.status) : json({ send: r.send, ...inPlace(req.params.id) }, 202);
      },
    },
    "/api/sessions/:id/outside/sends/:send": {
      DELETE: (req: Request & { params: { id: string; send: string } }) => (driver(req.params.id).dismiss(req.params.id, req.params.send) ? json({ ok: true }) : bad("no such send to put away", 404)),
    },
    "/api/sessions/:id/outside/interrupt": {
      POST: async (req: Request & { params: { id: string } }) => json({ stopped: await driver(req.params.id).interrupt(req.params.id) }),
    },
    "/api/sessions/:id/outside/copy": {
      POST: async (req: Request & { params: { id: string } }) => {
        const f = o.source(req.params.id);
        if (!f) return bad("its transcript is no longer where it was, or holds another session", 409);
        const imports = sharedImports(store);
        const model = await modelFor(providers, f);
        if (!model) return bad("no model is available: no provider has credentials", 409);
        const workspace = isDir(f.cwd) ? f.cwd! : deps.workspace;
        const prior = imports.links(f.harness, f.id, f.path)[0];
        const seq = prior ? store.lastSeq(prior.session_id) : 0;
        // The copy made before, brought up to date; a new one where it went on here or its source rewound.
        let r;
        if (prior && !imports.wentOn(prior.session_id)) {
          r = await imports.import(f, { mode: "update", model, workspace, session_id: prior.session_id, owner: true }).catch((e) => ((e as any)?.status === 409 ? undefined : Promise.reject(e)));
        }
        r ??= await imports.import(f, { mode: "new", model, workspace, owner: true });
        if (r.action === "updated") for (const e of store.events(r.session.id, seq)) bus.emit({ t: "event", event: e });
        bus.emit({ t: "session", session: r.session });
        return json({ action: r.action, session: r.session, imported_events: r.imported_events }, r.action === "created" ? 201 : 200);
      },
    },
  };
};
