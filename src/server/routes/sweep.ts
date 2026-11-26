// The daily sweep of the memory systems (src/helper/sweep.ts): the latest card, running it now, and
// the offers on it, each applied only by a request that names it.
//   GET  /api/memory/sweep                      the latest card, the helped share of earlier ones, whether one runs
//   POST /api/memory/sweep/run                  sweep now (at most one a minute)
//   POST /api/memory/sweep/offers/:id/apply     do what the offer says; for a note to the memory store, the
//                                               command it would run, to be confirmed
//   POST /api/memory/sweep/offers/:id/confirm   { confirm } run that command, once
//   POST /api/memory/sweep/offers/:id/dismiss   leave it
import * as activity from "../../automation/activity.ts";
import { dropNote, sweep, sweepLine, Sweeps, tidyIndex, DAY, type Card, type Offer } from "../../helper/sweep.ts";
import { nativeLog } from "../../integrations/native-log.ts";
import { MemoryStore } from "../../integrations/memory-store.ts";
import { readsOf } from "../reads.ts";
import { helperNow } from "./helper.ts";
import type { Deps } from "../app.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });
const bad = (error: string, status = 400) => json({ error }, status);

// A sweep is made when the last is over this old: a day, less the slack of the check that finds it.
const DUE_MS = DAY - 3_600_000;
const CHECK_MS = 30 * 60_000;
const FIRST_MS = 3 * 60_000;
const MIN_GAP_MS = 60_000;

const g = globalThis as { __keelSweepTimer?: ReturnType<typeof setInterval>; __keelSweepFirst?: ReturnType<typeof setTimeout> };

export function sweepRoutes({ store, errors }: Deps, mem: MemoryStore, tacit: { on: () => boolean }, momentum: { on: () => boolean }): Record<string, any> {
  const sweeps = new Sweeps(store);
  nativeLog(store);
  store.migrate("CREATE TABLE IF NOT EXISTS momentum_acts (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, action TEXT NOT NULL); CREATE INDEX IF NOT EXISTS momentum_acts_ts ON momentum_acts(ts)");
  let running: Promise<Card> | null = null;

  const run = (): Promise<Card> => {
    if (running) return running;
    const falls = store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM admin_meta WHERE key LIKE 'memory_fell:%'").get()?.n ?? 0;
    running = sweep({ sql: (q, p) => readsOf(store).sql(q, p), store, tacit: { on: tacit.on(), falls }, momentum: { on: momentum.on() } })
      .then((card) => {
        const prev = sweeps.latest();
        sweeps.save(card);
        nativeLog(store).prune();
        // One quiet line for the helper; it is woken (and may tell the owner) only when a number moved.
        const h = helperNow?.();
        const said = sweepLine(card, prev);
        h?.record("memory_sweep", null, said.moved.length ? "Memory sweep: a number moved" : "Memory sweep", `${said.line}; details in Settings > Usage > Memory.`, said.moved.length ? "wake" : "feed");
        return card;
      })
      .finally(() => { running = null; });
    return running;
  };

  const due = () => { const last = sweeps.latest(); return !last || Date.now() - last.ts >= DUE_MS; };
  const look = () => { if (due()) run().catch((e) => errors.capture("server", e, { at: "memory sweep" })); };
  clearInterval(g.__keelSweepTimer); clearTimeout(g.__keelSweepFirst);
  g.__keelSweepTimer = setInterval(look, CHECK_MS);
  g.__keelSweepFirst = setTimeout(look, FIRST_MS);
  g.__keelSweepTimer.unref?.(); g.__keelSweepFirst.unref?.();

  const seenDirs = () => new Set(store.db.query<{ file: string }, [number]>("SELECT DISTINCT file FROM native_memory_log WHERE action = 'loaded' AND file != '' AND ts >= ?").all(Date.now() - 90 * DAY).map((r) => r.file));
  const find = (id: string): { o: Offer } | { error: Response } => {
    const o = sweeps.get(id.slice(0, Math.max(0, id.lastIndexOf(":"))))?.offers.find((x) => x.id === id);
    return o ? { o } : { error: bad("no such offer", 404) };
  };
  const done = (o: Offer, text: string) => {
    const next = sweeps.setOffer(o.id, { state: "applied", done: text, at: Date.now() })!;
    activity.record("memory", "sweep offer", null, `${o.title}: ${text}`, { offer: o.id, kind: o.kind });
    return next;
  };

  return {
    "/api/memory/sweep": {
      GET: () => json({ card: sweeps.latest(), history: sweeps.history(), running: !!running }),
    },
    "/api/memory/sweep/run": {
      POST: async () => {
        const last = sweeps.latest();
        if (!running && last && Date.now() - last.ts < MIN_GAP_MS) return json({ card: last, history: sweeps.history(), running: false });
        const card = await run();
        return json({ card, history: sweeps.history(), running: false });
      },
    },
    "/api/memory/sweep/offers/:id/apply": {
      POST: async (req: any) => {
        const f = find(req.params.id);
        if ("error" in f) return f.error;
        const o = f.o;
        if (o.state !== "open") return bad(`the offer is ${o.state}`, 409);
        try {
          if (o.kind === "drop_record") {
            const r = helperNow?.().records.forget(o.target.key!);
            return json({ offer: done(o, r ? `forgot ${o.target.key}` : `${o.target.key} was gone already`) });
          }
          if (o.kind === "tidy_index" || o.kind === "drop_note") {
            // A folder a session was seen to load: an offer never reaches anywhere else.
            if (!o.target.dir || !seenDirs().has(o.target.dir)) return bad("that folder is not one a session loaded", 409);
            const text = o.kind === "tidy_index" ? tidyIndex(o.target.dir, o.target.add ?? [], o.target.remove ?? []) : dropNote(o.target.dir, o.target.file!);
            return json({ offer: done(o, text) });
          }
          // A note to the memory store: its command is shown, and a second request runs it.
          const p = await mem.preview(o.target.name!, o.target.text!, { page: !!req.headers.get("origin"), body: `Raised by Keel's daily memory sweep and sent by the owner. The owner has not called ${o.target.name} wrong; Keel measured it. ${o.target.text}` });
          return json({ offer: o, preview: p });
        } catch (e) {
          return bad((e as Error).message, 409);
        }
      },
    },
    "/api/memory/sweep/offers/:id/confirm": {
      POST: async (req: any) => {
        const f = find(req.params.id);
        if ("error" in f) return f.error;
        if (f.o.kind !== "tacit_note" || f.o.state !== "open") return bad("nothing to confirm", 409);
        const b = ((await req.json().catch(() => ({}))) ?? {}) as { confirm?: unknown };
        const r = await mem.confirm(b.confirm);
        if (r.state !== "ok") return json({ state: r.state, error: r.error, offer: f.o });
        return json({ state: "ok", offer: done(f.o, `sent a note about ${f.o.target.name} to the memory store${r.where ? ` (${r.where})` : ""}`) });
      },
    },
    "/api/memory/sweep/offers/:id/dismiss": {
      POST: (req: any) => {
        const f = find(req.params.id);
        if ("error" in f) return f.error;
        if (f.o.state !== "open") return bad(`the offer is ${f.o.state}`, 409);
        return json({ offer: sweeps.setOffer(f.o.id, { state: "dismissed", at: Date.now() }) });
      },
    },
  };
}
