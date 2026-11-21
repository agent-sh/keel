// What the command line needs beyond the workbench's routes.
//
// POST /api/run              { text, images?, session_id? | continue?, cwd?, model?, provider?,
//                              permission_mode?, effort?, worktree?, mode?, idempotency_key? }
//                            -> { session_id, replayed, after_seq, event_id?, queued? }
//   One prompt to a new or existing session, settings first. With a key, a
//   retry gets the first answer back and starts neither a session nor a turn.
// GET  /api/cli/state/:id               -> running, queue, open cards and questions, background work
// GET  /api/cli/resolve?id=PREFIX       -> { session } (a unique prefix of an id)
// GET  /api/cli/model?model=&provider=  -> { model } (an id, a bare model name or a listed name)
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelInfo } from "../../providers/types.ts";
import { isMode } from "../../safety/policy.ts";
import type { Deps, RouteModule } from "../app.ts";
import { asksLess, gate, presence } from "./permissions.ts";
import { carrySettings, commitSwitch } from "../switch.ts";
import * as agents from "../../automation/agents.ts";
import { owedWake } from "../../automation/failures.ts";
import * as waits from "../../automation/waits.ts";
import { pendingQuestions } from "../../tools/interact.ts";
import { jobsOf, running } from "../../tools/jobs.ts";
import { fitPromptImages } from "../../engine/image-fit.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS cli_runs (key TEXT PRIMARY KEY, session_id TEXT NOT NULL, after_seq INTEGER NOT NULL, event_id TEXT, created INTEGER NOT NULL);`;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

// A model named loosely: the full id, the provider's own name, or the listed
// display name; narrowed by provider. Several matches are refused with their ids.
export function pickModel(models: ModelInfo[], want: string, provider?: string): string {
  const pool = provider ? models.filter((m) => m.provider === provider) : models;
  if (provider && !pool.length) throw fail(`no provider ${provider} lists models`);
  const lc = want.toLowerCase();
  for (const test of [
    (m: ModelInfo) => m.id === want || (provider && m.id === `${provider}:${want}`),
    (m: ModelInfo) => m.model === want || m.name.toLowerCase() === lc,
    (m: ModelInfo) => m.model.endsWith(`.${want}`) || m.model.endsWith(`/${want}`),
  ]) {
    const hit = pool.filter(test);
    if (hit.length === 1) return hit[0]!.id;
    if (hit.length > 1) throw fail(`${want} names ${hit.length} models: ${hit.map((m) => m.id).join(", ")}; pass the full id or --provider`);
  }
  throw fail(`no listed model is ${want}${provider ? ` on ${provider}` : ""} (keel models lists them)`);
}

export function resolveSession(deps: Deps, id: string) {
  const exact = deps.store.session(id);
  if (exact) return exact;
  if (!/^[0-9a-f-]{4,}$/i.test(id)) throw fail(`no session ${id}`, 404);
  const rows = deps.store.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE id LIKE ? || '%' LIMIT 6").all(id.toLowerCase());
  if (!rows.length) throw fail(`no session ${id}`, 404);
  if (rows.length > 1) throw fail(`${id} names more than one session: ${rows.map((r) => r.id).join(", ")}`, 409);
  return deps.store.session(rows[0]!.id)!;
}

const lastSeq = (deps: Deps, id: string) =>
  deps.store.db.query<{ n: number | null }, [string]>("SELECT max(seq) AS n FROM events WHERE session_id = ?").get(id)?.n ?? 0;

export const runRoutes: RouteModule = (deps) => {
  const { store, bus, engine, providers } = deps;
  store.migrate(SCHEMA);
  // What the first request with a key asked for (a retry must ask the same),
  // and the queued prompt it became when the session was busy.
  if (!store.columnExists("cli_runs", "fingerprint")) store.migrate("ALTER TABLE cli_runs ADD COLUMN fingerprint TEXT");
  if (!store.columnExists("cli_runs", "queue_id")) store.migrate("ALTER TABLE cli_runs ADD COLUMN queue_id TEXT");

  const model = async (want?: string, provider?: string) => {
    if (!want) {
      const d = await providers.defaultModel();
      if (!d) throw fail("no model is available: no provider has credentials", 409);
      if (provider && !d.startsWith(`${provider}:`)) throw fail(`the default model ${d} is not on ${provider}: pass --model`);
      return d;
    }
    const id = pickModel(await providers.models(), want, provider);
    await providers.resolve(id);
    return id;
  };

  // A session and its subagents' sessions, all the way down.
  const family = (id: string) =>
    store.db.query<{ id: string }, [string]>(
      "WITH RECURSIVE t(id) AS (SELECT ?1 UNION SELECT s.id FROM sessions s JOIN t ON s.parent_id = t.id) SELECT id FROM t",
    ).all(id).map((r) => r.id);

  return {
    // What a command that stays needs on every tick, without the transcript.
    "/api/cli/state/:id": {
      GET: (req: any) => {
        const s = resolveSession(deps, req.params.id);
        const ids = family(s.id);
        const approvals = (gate?.approvals({ pending: true }) ?? []).filter((a) => ids.includes(a.session_id));
        const questions = ids.flatMap((id) => pendingQuestions(id).map((call_id) => ({ session_id: id, call_id })));
        // An agent that ended but whose report has not reached the session yet
        // still counts: its report starts the turn that uses it.
        // (A failure notice that stands in for failed agents' reports counts the same.)
        const agentsLive = agents.list(s.id).filter((a) => a.status === "running" || a.status === "waiting" || a.handback).length + (owedWake(s.id) ? 1 : 0);
        const waitsLive = waits.list(s.id, 0).filter((w) => w.status === "active").length;
        const jobsLive = jobsOf(s.id).filter((j) => j.background && running(j)).length;
        return json({
          session: s,
          last_seq: lastSeq(deps, s.id),
          running: engine.isRunning(s.id),
          queue: store.queue(s.id).length,
          held: engine.isHeld(s.id),
          status: engine.statusOf(s.id),
          approvals,
          questions,
          background: { agents: agentsLive, waits: waitsLive, jobs: jobsLive },
        });
      },
    },
    "/api/cli/resolve": {
      GET: (req: Request) => json({ session: resolveSession(deps, new URL(req.url).searchParams.get("id") ?? "") }),
    },
    "/api/cli/model": {
      GET: async (req: Request) => {
        const u = new URL(req.url).searchParams;
        return json({ model: await model(u.get("model") || undefined, u.get("provider") || undefined) });
      },
    },
    "/api/run": {
      POST: async (req: Request) => {
        const b = ((await req.json().catch(() => null)) ?? {}) as any;
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!text) throw fail("the prompt is empty");
        const key = typeof b.idempotency_key === "string" && b.idempotency_key ? b.idempotency_key.slice(0, 200) : null;
        // The caller's request as given (not the defaults it resolves to): a
        // retry sends the same, a reused key with another prompt or place is a
        // mistake to refuse, as Stripe's idempotency keys do.
        const fingerprint = key
          ? String(Bun.hash(JSON.stringify([text, b.images ?? [], b.session_id ?? null, !!b.continue, b.session_id ? null : resolve(b.cwd || deps.workspace), b.model ?? null, b.provider ?? null, b.permission_mode ?? null, b.effort ?? null, b.worktree ?? null, b.peer ?? null, b.mode ?? null])))
          : null;
        if (key) {
          const prior = store.db.query<{ session_id: string; after_seq: number; event_id: string | null; queue_id: string | null; fingerprint: string | null }, [string]>("SELECT session_id, after_seq, event_id, queue_id, fingerprint FROM cli_runs WHERE key = ?").get(key);
          if (prior && store.session(prior.session_id)) {
            if (prior.fingerprint && prior.fingerprint !== fingerprint) throw fail("this idempotency key was used for a different request (another prompt, files, session or option); use a new key", 409);
            const { fingerprint: _f, queue_id, ...receipt } = prior;
            return json({ ...receipt, ...(queue_id ? { queue_id, queued: true } : {}), replayed: true });
          }
        }
        if (b.permission_mode !== undefined && !isMode(b.permission_mode)) throw fail(`unknown permission mode ${b.permission_mode}`);
        if (b.mode !== undefined && !["send", "steer", "queue"].includes(b.mode)) throw fail(`unknown mode ${b.mode}`);

        let s;
        if (b.session_id) s = resolveSession(deps, String(b.session_id));
        else if (b.continue) {
          const cwd = resolve(b.cwd || deps.workspace);
          s = store.sessions({ archived: false }).find((x) => !x.parent_id && x.workspace === cwd);
          if (!s) throw fail(`no session in ${cwd} to continue`, 404);
        }
        // A mode that asks less than the session's (or the default) is an
        // authority change: from a remote device it takes the passkey.
        if (b.permission_mode && gate && presence && asksLess(b.permission_mode, s ? gate.perm(s.id).mode : gate.defaultMode()) && !presence.allows(req, `perm:${s?.id ?? "new"}`)) {
          return json({ error: "this needs your passkey from a remote device", presence: { action: `perm:${s?.id ?? "new"}` } }, 428);
        }
        if (s?.archived) throw fail("the session is archived", 409);
        // The model and effort the run will use are checked before the session
        // is changed or made: a refused run leaves no new session and no new model.
        const target = s && !b.model ? s.model : await model(b.model, b.provider);
        const info = (await providers.models()).find((m) => m.id === target);
        if (b.effort && info && !info.efforts.includes(b.effort)) throw fail(`${info.name} does not take effort ${b.effort} (it takes ${info.efforts.join(", ") || "none"})`);
        if (s) {
          if (target !== s.model && info) s = await commitSwitch(store, bus, providers, s, info, { settings: carrySettings(s.settings, info) }, { by: "cli" });
          else if (target !== s.model) s = store.updateSession(s.id, { model: target });
        } else {
          const workspace = resolve(b.cwd || deps.workspace);
          if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw fail(`not a directory: ${workspace}`);
          const m = target;
          if (typeof b.worktree === "string") {
            // The worktree route makes the session in a fresh worktree of the folder's repository.
            const r = await fetch(new URL("/api/worktrees", req.url), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ workspace, model: m, title: b.worktree || text.split("\n")[0]!.slice(0, 80) }),
            });
            const w = (await r.json()) as any;
            if (!r.ok) throw fail(w.error ?? `the worktree was not made (HTTP ${r.status})`, r.status);
            s = store.session(w.session.id)!;
          } else {
            s = store.createSession({ model: m, workspace });
            bus.emit({ t: "session", session: s });
          }
        }
        if (b.effort) s = store.updateSession(s.id, { settings: { ...s.settings, effort: b.effort } });
        if (b.permission_mode) gate?.setPerm(s.id, { mode: b.permission_mode });
        bus.emit({ t: "session", session: store.session(s.id)! });
        // Its tools run on a peer machine: the fleet moves the session there first.
        if (b.peer && (s.machine ?? "local") !== b.peer) {
          const at = (p: string) => new URL(p, req.url);
          const { machines } = (await (await fetch(at("/api/fleet/machines"))).json()) as { machines: { id: string; name: string }[] };
          const m = machines.find((x) => x.id === b.peer || x.name === b.peer);
          if (!m) throw fail(`no fleet machine ${b.peer} (the Fleet settings list them)`, 404);
          if ((s.machine ?? "local") !== m.id) {
            const r = await fetch(at(`/api/sessions/${s.id}/handoff`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machine_id: m.id, carry: "none" }) });
            const h = (await r.json()) as any;
            if (!r.ok) throw fail(`the session could not move to ${m.name}: ${h.error ?? r.status}`, r.status);
            for (let i = 0; i < 240; i++) {
              const { handoff } = (await (await fetch(at(`/api/sessions/${s.id}/handoff`))).json()) as any;
              if (handoff?.state === "done") break;
              if (handoff?.state === "failed") throw fail(`the session could not move to ${m.name}: ${handoff.error ?? "the move failed"}`, 409);
              await Bun.sleep(250);
            }
          }
        }

        const after_seq = lastSeq(deps, s.id);
        const r = engine.send(s.id, text, { mode: b.mode, images: await fitPromptImages(b.images) });
        const event_id = "event" in r && r.event ? r.event.id : null;
        const queue_id = "queued" in r && r.queued ? r.queued.id : null;
        if (key) store.db.run("INSERT OR REPLACE INTO cli_runs (key, session_id, after_seq, event_id, created, fingerprint, queue_id) VALUES (?, ?, ?, ?, ?, ?, ?)", [key, s.id, after_seq, event_id, Date.now(), fingerprint, queue_id]);
        return json({ session_id: s.id, replayed: false, after_seq, event_id, ...(queue_id ? { queue_id, queued: true } : {}) }, 201);
      },
    },
  };
};
