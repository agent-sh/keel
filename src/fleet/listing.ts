// The other harnesses' sessions on a fleet machine, as the import sheet lists
// them: read over the machine's link (its daemon, or the helper of an ssh
// machine, both run the importers there and send the rows back), and kept, so
// the sheet opens on the last list at once and a machine that does not answer
// still shows what it last had, dated.
//
// Why the importers run on the far side and the daemon reads no files over
// ssh: a store holds tens of thousands of transcripts, and only the far side
// can read a file when it changed (size and mtime) instead of fetching it. One
// page of rows crosses the link, and one transcript when it is imported.
import type { Store } from "../core/store.ts";
import { select } from "../integrations/import/offer.ts";
import type { Found } from "../integrations/import/types.ts";
import { LinkError } from "./link.ts";

export const LISTING_SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_listing (
  machine_id TEXT NOT NULL,
  harness TEXT NOT NULL,           -- '' when the list was not narrowed to one
  show_all TEXT NOT NULL,          -- the \`show\` of the list ('' for the default)
  at_ms INTEGER NOT NULL,          -- when the machine gave it
  body TEXT NOT NULL,              -- its answer: the first page, its total, its harnesses
  PRIMARY KEY (machine_id, harness, show_all)
);
`;

// What the far side answers to a listing (src/fleet/hands-sessions.ts).
export type Listed = {
  sessions: (Found & { original?: unknown })[];
  total: number;
  next_cursor?: string;
  changed?: boolean;
  index?: { complete?: boolean; building?: boolean };
  harnesses?: unknown[];
  tools_present?: string[];
};

export type Query = { harness?: string; q?: string; show?: string; sort?: string; cursor?: string; limit?: number; peek?: boolean; refresh?: boolean };
export type Answer = { body: Listed; cached_ms?: number; stale?: { reason: string } };

// A list that is the head of the machine's whole one: the same for any asker,
// so it can stand in for the machine's own answer.
const keepable = (q: Query) => !q.cursor && !q.q && !q.peek && (!q.sort || q.sort === "updated");

export class Listings {
  constructor(
    private store: Store,
    // One request to the machine's link, read as JSON (Fleet.handsJson).
    private ask: (machine: string, path: string) => Promise<Listed>,
    // True while the machine is known not to answer: its last list is served without waiting for a timeout.
    private down: (machine: string) => string | undefined,
  ) {}

  last(machine: string, q: Query): { at_ms: number; body: Listed } | undefined {
    const r = this.store.db.query<{ at_ms: number; body: string }, [string, string, string]>("SELECT at_ms, body FROM fleet_listing WHERE machine_id = ? AND harness = ? AND show_all = ?").get(machine, q.harness ?? "", q.show ?? "");
    return r ? { at_ms: r.at_ms, body: JSON.parse(r.body) as Listed } : undefined;
  }

  private keep(machine: string, q: Query, body: Listed) {
    this.store.db.query("INSERT OR REPLACE INTO fleet_listing (machine_id, harness, show_all, at_ms, body) VALUES (?, ?, ?, ?, ?)").run(machine, q.harness ?? "", q.show ?? "", Date.now(), JSON.stringify(body));
  }

  forget(machine: string) {
    this.store.db.query("DELETE FROM fleet_listing WHERE machine_id = ?").run(machine);
  }

  // What the kept list holds that the query asks for: its words matched over
  // the rows it has, and no later page.
  private served(c: { at_ms: number; body: Listed }, q: Query): Answer["body"] {
    if (q.cursor) return { ...c.body, sessions: [], next_cursor: undefined, total: c.body.total };
    const words = q.q?.trim();
    const rows = words ? select(c.body.sessions, { q: words, show: q.show }) : c.body.sessions;
    const limit = Math.max(1, Math.min(q.limit ?? 50, 200));
    // A search over the rows kept counts what they hold; the whole list's count stays while none is typed.
    return { ...c.body, sessions: rows.slice(0, limit), total: words ? rows.length : c.body.total, next_cursor: undefined };
  }

  // Only what is kept, for a sheet that is opening: no link is touched.
  cached(machine: string, q: Query): Answer | undefined {
    const c = this.last(machine, q);
    return c ? { body: this.served(c, q), cached_ms: c.at_ms } : undefined;
  }

  // The machine's own answer; the kept list, with its date and why, when it
  // gives none. A refusal (a cursor it did not give) is the caller's and passes.
  async list(machine: string, q: Query): Promise<Answer> {
    const c = this.last(machine, q);
    const down = this.down(machine);
    if (down && c && !q.refresh) return { body: this.served(c, q), cached_ms: c.at_ms, stale: { reason: down } };
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && v !== false) u.set(k, v === true ? "1" : String(v));
    try {
      const body = await this.ask(machine, `/api/fleet/hands/transcripts?${u}`);
      if (keepable(q)) this.keep(machine, q, body);
      return { body };
    } catch (e) {
      if (!(e instanceof LinkError) || (e as { status?: number }).status !== undefined) throw e;
      if (!c) throw e;
      return { body: this.served(c, q), cached_ms: c.at_ms, stale: { reason: e.message } };
    }
  }
}
