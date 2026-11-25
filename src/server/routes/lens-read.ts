// What the Conversation lens reads beside the branch's index (src/core/lens.ts), on the read thread:
// a few named fields of the inputs and turn ends it is asked about (never their words), how
// the landing entries an outcome names ended, the cards that asked the owner in its span, and
// the bodies of the events it shows. Imports nothing of the daemon.
import type { Database } from "bun:sqlite";
import { PEER_PREFIX } from "../../core/owner.ts";
import type { EndFacts, InputFacts } from "../../core/lens.ts";

export type LensAsk = { users: string[]; ends: string[]; sessions: string[]; from: number; to: number };
export type LensFacts = { users: Record<string, InputFacts>; ends: Record<string, EndFacts>; asks: { at: number; waiting: boolean }[] };

const has = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
const list = (s: string | null): any[] => { try { const v = s ? JSON.parse(s) : null; return Array.isArray(v) ? v : []; } catch { return []; } };
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function lensFacts(db: Database, a: LensAsk): LensFacts {
  const users: LensFacts["users"] = {}, ends: LensFacts["ends"] = {};
  const u = db.query<{ origin: string | null; kind: string | null; status: string | null; parts: string | null; entries: string | null; landed: unknown; left: unknown; peer: number }, [string, string]>(
    `SELECT data ->> '$.origin' AS origin, data ->> '$.kind' AS kind, data ->> '$.status' AS status,
            data -> '$.parts' AS parts, data -> '$.entries' AS entries, data ->> '$.landed' AS landed, data ->> '$.left' AS left,
            substr(COALESCE(data ->> '$.text', ''), 1, ${PEER_PREFIX.length}) = ? AS peer
       FROM events WHERE id = ?`);
  const landing = has(db, "landing_queue") ? db.query<{ state: string }, [string]>("SELECT state FROM landing_queue WHERE id = ?") : undefined;
  for (const id of a.users) {
    const r = u.get(PEER_PREFIX, id);
    if (!r) continue;
    const parts = list(r.parts).map((p) => ({ kind: typeof p?.kind === "string" ? p.kind : undefined, status: typeof p?.status === "string" ? p.status : undefined, entries: Array.isArray(p?.entries) ? p.entries.filter((x: unknown) => typeof x === "string") : undefined, landed: num(p?.landed), left: num(p?.left) }));
    const f: InputFacts = { origin: r.origin, kind: r.kind, status: r.status, peer: !!r.peer || r.kind === "peer", ...(parts.length ? { parts: parts.map(({ kind, status }) => ({ kind, status })) } : {}) };
    const entries = [...list(r.entries), ...parts.flatMap((p) => p.entries ?? [])].filter((x): x is string => typeof x === "string");
    // An outcome says how many landed; one from before it did is read from the queue while its entries are kept.
    const told = [{ landed: num(r.landed), left: num(r.left) }, ...parts].filter((p) => p.landed !== null || p.left !== null);
    if (told.length) {
      const landed = told.reduce((n, p) => n + (p.landed ?? 0), 0), left = told.reduce((n, p) => n + (p.left ?? 0), 0);
      if (landed) f.landed = landed;
      if (left) f.left = left;
    } else if (entries.length && landing) {
      let landed = 0, left = 0;
      for (const e of entries) { const s = landing.get(e)?.state; if (s === "landed") landed++; else if (s === "left") left++; }
      if (landed) f.landed = landed;
      if (left) f.left = left;
    }
    users[id] = f;
  }
  const e = db.query<{ reason: string | null; cost: unknown; ms: unknown; by: string | null }, [string]>(
    "SELECT data ->> '$.reason' AS reason, data ->> '$.usage.cost' AS cost, data ->> '$.ms' AS ms, data ->> '$.stopped_by' AS by FROM events WHERE id = ?");
  for (const id of a.ends) {
    const r = e.get(id);
    if (r) ends[id] = { reason: r.reason, cost: num(r.cost), ms: num(r.ms), stopped_by: r.by };
  }
  const asks: LensFacts["asks"] = [];
  if (has(db, "approvals") && a.sessions.length) {
    const rows = db.query<{ created: number; state: string }, [string, number, number]>(
      "SELECT created, state FROM approvals WHERE session_id IN (SELECT value FROM json_each(?)) AND created >= ? AND created <= ?").all(JSON.stringify(a.sessions), a.from, a.to);
    for (const r of rows) asks.push({ at: r.created, waiting: r.state === "pending" });
  }
  return { users, ends, asks };
}

// The stored bodies of the events the lens shows (the owner's messages and the replies to them), as stored.
export function lensBodies(db: Database, a: { ids: string[] }): Record<string, string> {
  const q = db.query<{ data: string }, [string]>("SELECT data FROM events WHERE id = ?");
  const out: Record<string, string> = {};
  for (const id of a.ids) { const r = q.get(id); if (r) out[id] = r.data; }
  return out;
}
