// The words a model sent into another harness's session through the drive (src/drive/tools.ts). That harness
// records them as typed at its prompt, the way it records the owner's own, so a copy of that session made later
// must not count them as the owner's words (Imports.copy asks wasSent before it keeps a prompt's `typed` mark).
// Only digests of the words are kept, never the words (src/drive/sent-read.ts): of the whole and of each line.
// What the owner sends from the page is theirs and is not kept here.
//
// The sends made before this record began are read once from the stored history, on the read thread
// (backfillSent); until that read is done no prompt of a copy counts as typed. A send to a session on another
// machine is told to that machine's Keel before it goes (farSent), since a copy made there reads its own record.
// The digests are kept: a few a send, and a transcript the drive sent into can be copied for as long as it lives,
// wherever its folder moves.
import type { Store } from "../core/store.ts";
import { digestsOf, sentBy, type SentAsk } from "./sent-read.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS drive_sends (digest TEXT PRIMARY KEY, sent_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_sends_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`;

function keep(store: Store, digests: string[]) {
  if (!digests.length) return;
  store.migrate(SCHEMA);
  const q = store.db.query("INSERT OR IGNORE INTO drive_sends (digest, sent_ms) VALUES (?, ?)");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(d, now); })();
}

// Kept before the words are sent. Returns the digests, for a far machine's Keel.
export function noteSent(store: Store, text: string): string[] {
  const digests = digestsOf(text);
  keep(store, digests);
  return digests;
}

// Digests another machine's Keel sent for a send into a session here (the fleet's paired route).
export function noteDigests(store: Store, digests: unknown[]) {
  keep(store, digests.filter((d): d is string => typeof d === "string" && /^\d{1,24}$/.test(d)).slice(0, 4096));
}

// Whether a recorded prompt is words a model sent through the drive. True while the history's sends are not read
// yet: a prompt is the owner's only once it is known that no model sent it.
export function wasSent(store: Store, text: string): boolean {
  try {
    if (!store.db.query("SELECT 1 FROM drive_sends_state WHERE k = 'backfilled'").get()) return true;
    const q = store.db.query<unknown, [string]>("SELECT 1 FROM drive_sends WHERE digest = ? LIMIT 1");
    return sentBy(text, (d) => !!q.get(d));
  } catch {
    return true; // no table: the history was never read
  }
}

// The sends of the stored history, read once on the read thread a part at a time (`run`: Reads.run): the replies'
// calls, then the calls programs made inside run_code.
export async function backfillSent(store: Store, run: (a: SentAsk) => Promise<{ digests: string[]; next: number | null }>, span = 20_000) {
  store.migrate(SCHEMA);
  if (store.db.query("SELECT 1 FROM drive_sends_state WHERE k = 'backfilled'").get()) return;
  for (const table of ["events", "code_calls"] as const) {
    for (let after = 0; ; ) {
      const r = await run({ after, span, table });
      keep(store, r.digests);
      if (r.next === null) break;
      after = r.next;
    }
  }
  store.db.query("INSERT OR REPLACE INTO drive_sends_state (k, v) VALUES ('backfilled', ?)").run(Date.now());
}

// Tells the Keel of the machine an outside session runs on (its agent view's host name) the digests of a send,
// before the send: set by the fleet (src/server/routes/fleet.ts). It throws when that machine runs a Keel that could
// not be told; it does nothing for a host with no Keel the fleet knows.
let far: ((host: string, digests: string[]) => Promise<void>) | undefined;
export const onFarSent = (fn: typeof far) => { far = fn; };
export async function farSent(host: string, digests: string[]) {
  if (host && digests.length && far) await far(host, digests);
}
