// What of a session is a copy of another harness's transcript, and which of its prompts are the owner's words.
// Every event up to the import link's `through` (the last seq the copy wrote) is the copy's, whatever its date; a link
// that keeps no seq (a table made before it) counts the events dated up to its `synced_ms`
// (src/integrations/import/service.ts). All of it is outside content, but for one case: a copy of a session the owner
// ran in a store of their own on this machine (Claude Code, Codex) keeps a prompt its reader found typed by a person
// with `typed: true` in its data, and only such a copy's marks are read. A copy from another machine, of another
// store, or of a Keel session (which copies its source's data as it is) counts none.
import type { Store } from "../core/store.ts";
import { sourceMachine } from "../integrations/import/types.ts";

export type Imported = { until: number; through?: number; own: boolean };

const OWN_STORES = new Set(["claude", "codex"]);

type LinkRow = { synced_ms: number; harness: string; source_path: string; through?: number | null };
export function importOf(store: Store, sessionId: string): Imported {
  let link: LinkRow | null = null;
  try {
    link = store.db.query<LinkRow, [string]>("SELECT * FROM import_links WHERE session_id = ?").get(sessionId);
  } catch {} // nothing was imported here
  if (!link) return { until: 0, own: false };
  const own = OWN_STORES.has(link.harness) && !sourceMachine(String(link.source_path ?? ""));
  return { until: link.synced_ms ?? 0, ...(typeof link.through === "number" && link.through > 0 ? { through: link.through } : {}), own };
}

// Whether a stored event is the copy's.
export const inCopy = (imp: Imported, e: { seq: number; ts: number }): boolean =>
  imp.through !== undefined ? e.seq <= imp.through : imp.until > 0 && e.ts <= imp.until;

// A stored prompt of the copy that is the owner's words: marked typed, in a copy that counts the marks, and nothing
// else on it (a kind or an origin is the harness's).
export const ownersImported = (imp: Imported, d: { typed?: unknown; kind?: unknown; origin?: unknown } | undefined): boolean =>
  imp.own && !!d && d.typed === true && !d.kind && !d.origin;
