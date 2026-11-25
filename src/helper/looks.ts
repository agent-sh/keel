// The helper's looks at errors, kept and run (the rules are error-look.ts). A new row of the Errors list is read
// once its burst settles; the first row of a cause costs one small request (the owner's small models, else the
// helper's own: Engine.small), shown on the look with its cost. Nothing here starts an agent: a task a look offers
// waits for the owner's press (the page asks for it, POST /api/debug/fix).
import { conceal } from "../core/conceal.ts";
import { logLines } from "../admin/logs.ts";
import { errorState } from "../admin/error-rows.ts";
import { priceOf } from "../providers/pricing.ts";
import type { ErrorRecord, Session } from "../core/types.ts";
import type { Deps } from "../server/app.ts";
import { causeOf, decide, eventLine, type Look, LOOK_OUTPUT, LOOK_SYSTEM, lookPrompt, parseLook, type Row, SETTLE_MS, startedWithin, toolOf, type Where } from "./error-look.ts";

const KEPT = 200;
const SHOWN = 60;
const LOG_AROUND_MS = 5_000;

export class Looks {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<unknown> = Promise.resolve();
  private on = true;

  constructor(
    private deps: Deps,
    private helper: { session(): Session | undefined; on(): boolean; isHelper(id: string | null | undefined): boolean },
    private told: (look: Look) => void,
  ) {
    deps.store.migrate("CREATE TABLE IF NOT EXISTS helper_looks (cause TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL)");
    // A look that was under way when the daemon went down never finished: it is said so, and is the owner's to ask again.
    for (const l of this.all()) if (l.state === "looking") this.put({ ...l, state: "failed", error: "the daemon stopped before the look ended" });
  }

  private all(): Look[] {
    return this.deps.store.db.query<{ data: string }, []>("SELECT data FROM helper_looks ORDER BY ts DESC").all().flatMap((r) => { try { return [JSON.parse(r.data) as Look]; } catch { return []; } });
  }
  list(): Look[] {
    return this.all().slice(0, SHOWN);
  }
  get(cause: string): Look | undefined {
    const r = this.deps.store.db.query<{ data: string }, [string]>("SELECT data FROM helper_looks WHERE cause = ?").get(cause);
    try { return r ? (JSON.parse(r.data) as Look) : undefined; } catch { return undefined; }
  }
  private put(l: Look) {
    const db = this.deps.store.db;
    db.query("INSERT INTO helper_looks (cause, ts, data) VALUES (?, ?, ?) ON CONFLICT(cause) DO UPDATE SET ts = excluded.ts, data = excluded.data").run(l.cause, l.ts, JSON.stringify(l));
    db.query("DELETE FROM helper_looks WHERE cause NOT IN (SELECT cause FROM helper_looks ORDER BY ts DESC LIMIT ?)").run(KEPT);
    this.told(l);
  }

  // A new row was captured: it is read once its burst has settled.
  note(c: { id: string; source: string; session_id?: string; turnSession?: string; context?: unknown; repeat?: true }) {
    if (c.repeat || !this.helper.on() || !this.helper.session()) return;
    if (this.helper.isHelper(c.session_id) || this.helper.isHelper(c.turnSession) || (c.context as { notice?: unknown } | undefined)?.notice === true) return;
    if (this.timers.has(c.id)) return;
    const t = setTimeout(() => { this.timers.delete(c.id); this.settle(c.id, false).catch((e) => this.deps.errors.capture("server", e, { at: "helper look" })); }, SETTLE_MS);
    t.unref?.();
    this.timers.set(c.id, t);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.on = false;
  }

  private row(id: string): ErrorRecord | undefined {
    return this.deps.errors.unwritten().find((r) => r.id === id) ?? this.deps.store.error(id);
  }

  // What to do with the row now: nothing, add it to its cause's look, hold it, or look.
  async settle(id: string, asked: boolean): Promise<Look | undefined> {
    const rec = this.row(id);
    if (!rec || !this.on) return undefined;
    // Resolved, or healed by a retry: it asks nothing of the owner.
    if (!asked && errorState(rec) !== "open") return undefined;
    const cause = causeOf(rec);
    const have = this.get(cause);
    const now = Date.now();
    const v = decide(have, startedWithin(this.all(), now), { on: this.helper.on() && !!this.helper.session(), asked, helperRow: this.helper.isHelper(rec.session_id) });
    if (v.act === "skip") return have;
    if (v.act === "known") {
      if (have && !have.error_ids.includes(id)) this.put({ ...have, error_ids: [...have.error_ids, id].slice(-20) });
      return have;
    }
    const base: Look = { cause, state: "held", error_ids: [...new Set([...(have?.error_ids ?? []), id])].slice(-20), ts: now, title: have?.title ?? rec.message.split("\n")[0]!.slice(0, 160), ...(rec.session_id ? { session_id: rec.session_id } : {}), ...(asked ? { asked: true as const } : {}) };
    if (v.act === "held") { this.put(base); return base; }
    const looking: Look = { ...base, state: "looking" };
    this.put(looking);
    // One look at a time: a burst of different causes is read in turn, not at once.
    const run = this.chain.then(() => this.run(rec, looking));
    this.chain = run.catch(() => {});
    return run;
  }

  // The owner pressed Look now or Look again on a look: its first row is read again, whatever the hour's count.
  async ask(cause: string): Promise<Look | undefined> {
    const have = this.get(cause);
    if (!have || have.state === "looking") return have;
    const id = [...have.error_ids].reverse().find((i) => this.row(i));
    if (!id) throw Object.assign(new Error("the error is no longer in the list"), { status: 404 });
    return this.settle(id, true);
  }

  private async where(rec: ErrorRecord, sid: string | undefined): Promise<Where> {
    const s = sid ? this.deps.store.session(sid) : undefined;
    let lines: string[] = [];
    if (s) {
      try {
        await this.deps.store.warm(s.id);
        lines = this.deps.store.lineage(s.id).slice(-80).flatMap((e) => { const l = eventLine(e); return l ? [l] : []; }).slice(-8);
      } catch {}
    }
    let log: string[] = [];
    try {
      log = logLines({ since: rec.ts - LOG_AROUND_MS, until: rec.ts + LOG_AROUND_MS / 2, level: "warn", limit: 6 }).map((l) => `${l.level} ${l.text}`);
    } catch {}
    return { title: s?.title, model: s?.model, workspace: s?.workspace, tool: toolOf(rec.context, lines), lines, log };
  }

  private async run(rec: ErrorRecord, look: Look): Promise<Look> {
    const helper = this.helper.session();
    if (!helper) { const l = { ...look, state: "failed" as const, error: "the helper is off", ts: Date.now() }; this.put(l); return l; }
    const row: Row = { id: rec.id, source: rec.source, message: rec.message, stack: rec.stack, context: rec.context, count: rec.count, ts: rec.ts, session_id: rec.session_id };
    try {
      const prompt = conceal(lookPrompt(row, await this.where(rec, rec.session_id)), helper.id);
      const r = await this.deps.engine.small(helper.id, helper.model, { system: LOOK_SYSTEM, prompt, out: LOOK_OUTPUT, signal: AbortSignal.timeout(90_000), at: "helper error look", holds: (t) => !!parseLook(t, row) });
      if (!r) throw new Error("no model gave a look at it");
      const said = parseLook(r.text, row)!;
      const info = this.deps.providers.cachedModel(r.model);
      const price = info?.price ?? this.deps.providers.catalog.lookup(info?.model ?? r.model)?.price;
      const cost = info && info.billing !== "per_token" ? null : priceOf(r.usage, price) ?? null;
      const done: Look = { ...look, ...said, state: "done", ts: Date.now(), model: info?.name ?? r.model, cost, tokens: r.usage.input + r.usage.output + r.usage.cache_read + r.usage.cache_write };
      this.put(done);
      return done;
    } catch (e) {
      const failed: Look = { ...look, state: "failed", ts: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 300) };
      this.put(failed);
      return failed;
    }
  }
}
