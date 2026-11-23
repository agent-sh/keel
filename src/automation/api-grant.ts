// Whether a session's commands may read the daemon's read-only lists through
// its API (src/server/peer-scope.ts says which routes those are). A top-level
// session's commands do. An agent's do only when its parent granted it at its
// start (`api: "read"` in the spawn), and only while every agent above it
// holds its own grant up to a top-level session: the chain starts at a
// top-level session, an agent passes the grant on only by naming it in a
// spawn of its own, and nothing an agent does changes its own grant. The owner
// revokes a grant from the agent's card; the agents below it lose theirs with
// it. Writes and secrets are refused to every session's commands whatever this
// says.
//
// Read at every request a session's command makes (never kept), so a revoke
// takes effect at the next one. The walk reads one row of each table per level,
// by their keys, a few levels at most.
import type { Database } from "bun:sqlite";
import type { ListReach } from "../server/peer-scope.ts";

// "read": granted at its start; "revoked": the owner took it back.
export type ApiGrant = "read" | "revoked";
export const isApiGrant = (v: unknown): v is ApiGrant => v === "read" || v === "revoked";

// The deepest a tree goes is bounded by the agents' depth; this bounds a broken table's loop.
const MAX_WALK = 32;

export function listReach(db: Database, session: string): ListReach {
  const parentOf = db.query<{ parent_id: string | null }, [string]>("SELECT parent_id FROM sessions WHERE id = ?");
  let s = session;
  for (let level = 0; level < MAX_WALK; level++) {
    const row = parentOf.get(s);
    if (!row) return { reads: false, why: level === 0 ? "its session is gone" : `the session above it (${s}) is gone` };
    if (!row.parent_id) return { reads: level === 0 ? "top" : "granted" };
    let g: { id: string; api: string | null } | null;
    // (No agents table or column yet: no agent holds a grant.)
    try { g = db.query<{ id: string; api: string | null }, [string]>("SELECT id, api FROM agents WHERE session_id = ?").get(s); } catch { g = null; }
    if (g?.api !== "read") {
      const revoked = g?.api === "revoked";
      if (level > 0) return { reads: false, why: `the agent above it (${g?.id ?? s}) ${revoked ? "had its grant revoked by the owner" : "holds no grant"}` };
      return { reads: false, why: revoked ? "the owner revoked its grant to read the daemon's lists" : `an agent's commands read the daemon's lists only when its parent granted it at its start (api: "read")` };
    }
    s = row.parent_id;
  }
  return { reads: false, why: "its chain of parents is longer than any tree of agents" };
}
