// The words a model sent into another harness's session through the drive (src/drive/tools.ts). That harness
// records them as typed at its prompt, the way it records the owner's own, so a copy of that session made later
// must not count them as the owner's words (Imports.copy reads this before it keeps a prompt's `typed` mark).
// Only a digest of the words is kept, never the words. What the owner sends from the page is theirs and is not
// kept here.
import type { Store } from "../core/store.ts";
import { outsideText } from "./text.ts";

const SCHEMA = "CREATE TABLE IF NOT EXISTS drive_sent (digest TEXT PRIMARY KEY, sent_ms INTEGER NOT NULL)";

// The words as a harness records what was pasted at its prompt: spacing may differ, the words do not.
const digestOf = (text: string) => String(Bun.hash(text.replace(/\s+/g, " ").trim()));

// Kept before the words are sent, as the harness will receive them (outsideText: the characters a delivery drops are
// dropped here too, so a character the paste loses does not make other words of the same text).
export function noteSent(store: Store, text: string) {
  let body: string;
  try { body = outsideText(text).text; } catch { return; } // nothing would be sent
  store.migrate(SCHEMA);
  store.db.query("INSERT INTO drive_sent (digest, sent_ms) VALUES (?, ?) ON CONFLICT(digest) DO UPDATE SET sent_ms = excluded.sent_ms").run(digestOf(body), Date.now());
}

export function wasSent(store: Store, text: string): boolean {
  try {
    return !!store.db.query("SELECT 1 FROM drive_sent WHERE digest = ?").get(digestOf(text));
  } catch {
    return false; // no table: nothing was ever sent
  }
}
