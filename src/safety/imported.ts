// What of a session is a copy of another harness's transcript, and which of its prompts are the owner's words.
// Every event up to the import link's `synced_ms` is the copy's (src/integrations/import/service.ts dates none
// later). All of it is outside content, but for one case: a copy of a session the owner ran in a store of their own
// on this machine (Claude Code, Codex, Antigravity) keeps a prompt its reader found typed by a person with
// `typed: true` in its data, and only such a copy's marks are read. A copy from another machine, of another store,
// or of a Keel session (which copies its source's data as it is) counts none.
import type { Store } from "../core/store.ts";
import { sourceMachine } from "../integrations/import/types.ts";

export type Imported = { until: number; own: boolean };

const OWN_STORES = new Set(["claude", "codex", "agy"]);

export function importOf(store: Store, sessionId: string): Imported {
  let link: { synced_ms: number; harness: string; source_path: string } | null = null;
  try {
    link = store.db.query<{ synced_ms: number; harness: string; source_path: string }, [string]>("SELECT synced_ms, harness, source_path FROM import_links WHERE session_id = ?").get(sessionId);
  } catch {} // nothing was imported here
  if (!link) return { until: 0, own: false };
  return { until: link.synced_ms ?? 0, own: OWN_STORES.has(link.harness) && !sourceMachine(String(link.source_path ?? "")) };
}

// A stored prompt of the copy that is the owner's words: marked typed, in a copy that counts the marks, and nothing
// else on it (a kind or an origin is the harness's).
export const ownersImported = (imp: Imported, d: { typed?: unknown; kind?: unknown; origin?: unknown } | undefined): boolean =>
  imp.own && !!d && d.typed === true && !d.kind && !d.origin;
