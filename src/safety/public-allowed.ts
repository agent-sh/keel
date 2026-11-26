// What the owner allowed once to go to a public place is his answer for the same words there until the session ends
// (public-send.ts holds the call, gate.ts asks): a push that failed and is sent again, or the same commits rebased
// onto a moved base, carry the lines his card already quoted, and asked him about each again.
//
// What is kept is what he saw and allowed, never more: one row for a finding his card quoted (the first `SHOWN`; one
// the card only counted is asked about next time), keyed by where it goes (the repositories of the send, all of them),
// the place without the commit's id (the file, or "commit message"), the kind, the word and the line's text. A later
// send is not asked about a finding with the same key; any other finding, another repository, and whatever could not be
// read ask as before, and the card then lists only what is new. Never kept: a secret (a token's shape, a value the
// vault holds: its line is hidden, so its key would be the same for another secret in that place), a line too long to
// show whole (its key would not be its text), a sentence of his that runs past the line quoted (the card shows its
// first line and its first six words: another sentence that opens the same way and wraps at the same word has the same
// line and the same words), and a send whose repository is not known.
import { createHash } from "node:crypto";
import type { Store } from "../core/store.ts";
import { SHOWN, type Finding } from "./private-words.ts";
import type { Held } from "./public-send.ts";

const SCHEMA = "CREATE TABLE IF NOT EXISTS public_allowed (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (session_id, key))";
// Findings kept for one session: past it the oldest are asked about again.
export const ALLOWED_MAX = 2_000;

// The key of a finding bound for `to`, or null when it is not one to keep.
export function hitKey(to: readonly string[], f: Pick<Finding, "kind" | "word" | "where" | "text" | "past">): string | null {
  if (!to.length || f.kind === "secret" || f.past || f.text.endsWith("...")) return null;
  const place = f.where.replace(/^commit [0-9a-f]{4,64}(?=[ :])/, "commit");
  return createHash("sha256").update(JSON.stringify([[...new Set(to)].sort(), place, f.kind, f.word.toLowerCase(), f.text])).digest("hex").slice(0, 40);
}

// A hold without the findings already allowed: null when nothing of it is left to ask about.
export function left(h: Held, allowed: ReadonlySet<string>): Held | null {
  if (!allowed.size || !h.to?.length) return h;
  const found = h.found.filter((f) => { const k = hitKey(h.to!, f); return k === null || !allowed.has(k); });
  if (found.length === h.found.length) return h;
  if (!found.length && !h.unread.length) return null;
  return { ...h, found, again: (h.again ?? 0) + h.found.length - found.length };
}

// The keys of what a card quotes of a hold: the findings the owner's answer is kept for.
function quoted(h: Held): string[] {
  if (!h.to?.length) return [];
  return [...new Set(h.found.slice(0, SHOWN).map((f) => hitKey(h.to!, f)).filter((k): k is string => k !== null))];
}

// What the card says of the answer it asks for, when any of it will be kept.
export function remembered(h: Held): string {
  const n = quoted(h).length;
  if (!n) return "";
  if (n === h.found.length) return "Allowing it is remembered until this session ends: the same words going to the same place are not asked about again.";
  return `Allowing it is remembered until this session ends for ${n} of the findings quoted above: the same words going to the same place are not asked about again. A secret, a line too long to show whole, words of yours that run past the line quoted and what is not quoted here are asked about each time.`;
}

export class PublicAllowed {
  constructor(private store: Store) { store.migrate(SCHEMA); }

  // What is left of a hold for the owner of this session to answer.
  left(sessionId: string, h: Held): Held | null {
    if (!h.to?.length || !h.found.length) return h;
    const rows = this.store.db.query<{ key: string }, [string]>("SELECT key FROM public_allowed WHERE session_id = ?").all(sessionId);
    return left(h, new Set(rows.map((r) => r.key)));
  }

  // The owner allowed the call that held these: what his card quoted is kept.
  allow(sessionId: string, h: Held): void {
    const keys = quoted(h);
    if (!keys.length) return;
    const now = Date.now();
    const add = this.store.db.query("INSERT OR IGNORE INTO public_allowed (session_id, key, created) VALUES (?, ?, ?)");
    this.store.db.transaction(() => {
      for (const k of keys) add.run(sessionId, k, now);
      this.store.db.query("DELETE FROM public_allowed WHERE session_id = ?1 AND rowid NOT IN (SELECT rowid FROM public_allowed WHERE session_id = ?1 ORDER BY created DESC, rowid DESC LIMIT ?2)").run(sessionId, ALLOWED_MAX);
    })();
  }
}
