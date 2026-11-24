// Routes (provider and model) that answered a request with a system message among the turns
// as malformed. No listing says which models take one, so the daemon learns it from the
// provider's answer and keeps it: a refusing route costs one request, not one per start.
// The fact is tried again after a day, and when the build that learned it is not the running
// one, since either may have changed what the route takes. Memory only until `attach`.
import type { Database } from "bun:sqlite";
import { buildId } from "../core/build.ts";

export const REFUSAL_TTL_MS = 24 * 3_600_000;

type Entry = { ts: number; build: string };

export class RouteRefusals {
  private known = new Map<string, Entry>();
  private db: Database | null = null;

  // Reads what an earlier start learned and keeps what comes after in the store.
  attach(store: { db: Database; migrate(sql: string): void }) {
    store.migrate("CREATE TABLE IF NOT EXISTS route_refusals (route TEXT PRIMARY KEY, ts INTEGER NOT NULL, build TEXT NOT NULL)");
    this.db = store.db;
    for (const r of store.db.query<{ route: string; ts: number; build: string }, []>("SELECT route, ts, build FROM route_refusals").all()) {
      if (!this.known.has(r.route)) this.known.set(r.route, { ts: r.ts, build: r.build });
    }
  }

  has(route: string, now = Date.now()): boolean {
    const e = this.known.get(route);
    return !!e && now - e.ts < REFUSAL_TTL_MS && e.build === buildId();
  }

  add(route: string, now = Date.now()) {
    const e = { ts: now, build: buildId() };
    this.known.set(route, e);
    try { this.db?.query("INSERT OR REPLACE INTO route_refusals (route, ts, build) VALUES (?, ?, ?)").run(route, e.ts, e.build); } catch {}
  }

  // The route took one after all (the entry was old): it is not kept.
  forget(route: string) {
    if (!this.known.delete(route)) return;
    try { this.db?.query("DELETE FROM route_refusals WHERE route = ?").run(route); } catch {}
  }
}

export const routeRefusals = new RouteRefusals();

// A 400 that says the system role or a system message is what it refuses. Other 400s (too long,
// a damaged image, a bad parameter) are the request's own fault and are not sent twice.
const NAMES_SYSTEM = /\bsystem[ -](role|messages?)\b|\brole\b[^\n]{0,80}\bsystem\b|\bsystem\b[^\n]{0,80}\brole\b|messages\.\d+\.role|'user' or 'assistant'|\broles? must alternate/i;
export function namesSystemMessage(text: string): boolean {
  return NAMES_SYSTEM.test(text);
}
