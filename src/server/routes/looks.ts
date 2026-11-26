// The looks of the owner's pages (src/core/look.ts): the newest of each kind of client, kept across
// restarts. A page says its look on its socket (src/server/live.ts, op "look"); the pictures of a change
// read the owner's look from here (src/pictures/run.ts), and so can an e2e run (test/e2e/shots.ts).
//
// GET /api/looks -> { looks: [KeptLook], owner: KeptLook | null }
import type { Store } from "../../core/store.ts";
import { lookKind, ownerLook, readLook, type KeptLook } from "../../core/look.ts";
import type { RouteModule } from "../app.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS looks (kind TEXT PRIMARY KEY, look TEXT NOT NULL, at_ms INTEGER NOT NULL);`;

let store: Store | undefined;
// What each kind said last, so a look said again unchanged writes nothing.
const last = new Map<string, { text: string; at: number }>();
// A look changed in the last minute is written; one said again unchanged moves its time at most once a minute.
const TOUCH_MS = 60_000;

export function keepLook(v: unknown, now = Date.now()): KeptLook | undefined {
  const look = readLook(v);
  if (!look || !store) return undefined;
  const kind = lookKind(look);
  const text = JSON.stringify(look);
  const was = last.get(kind);
  if (was && was.text === text && now - was.at < TOUCH_MS) return { ...look, kind, at_ms: was.at };
  last.set(kind, { text, at: now });
  try { store.db.run("INSERT INTO looks (kind, look, at_ms) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET look = excluded.look, at_ms = excluded.at_ms", [kind, text, now]); }
  catch { /* a store that takes no writes now: the next look says it again */ }
  return { ...look, kind, at_ms: now };
}

export function keptLooks(): KeptLook[] {
  if (!store) return [];
  try {
    return store.db.query<{ kind: string; look: string; at_ms: number }, []>("SELECT kind, look, at_ms FROM looks ORDER BY at_ms DESC").all().flatMap((r) => {
      const l = readLook(JSON.parse(r.look));
      return l ? [{ ...l, kind: r.kind, at_ms: r.at_ms }] : [];
    });
  } catch { return []; }
}

export const theOwnersLook = (): KeptLook | undefined => ownerLook(keptLooks());

export const lookRoutes: RouteModule = (deps) => {
  store = deps.store;
  last.clear();
  store.migrate(SCHEMA);
  return {
    "/api/looks": { GET: () => { const looks = keptLooks(); return Response.json({ looks, owner: ownerLook(looks) ?? null }); } },
  };
};
