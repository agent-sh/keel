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

// A far machine's Keel, told the digests of a send into a session it may copy: set by the fleet
// (src/server/routes/fleet.ts). "told": it keeps them; "old": a paired Keel of a build before the route, which
// keeps no typed marks at all; "none": no Keel the fleet can reach there (a machine reached over ssh, or a host
// the fleet does not know). It throws when that machine's Keel could not be reached. `quiet`: a catch-up, not a
// send.
export type FarAnswer = "told" | "old" | "none";
let far: ((host: string, digests: string[], quiet: boolean) => Promise<FarAnswer>) | undefined;
export const onFarSent = (fn: typeof far) => { far = fn; };

// The teller the fleet sets: `machine` is the fleet's machine a host names, `post` gives it the digests (a LinkError
// with the status of an answer that is not ok). A Keel of a build before the route answers 404. A machine reached
// over ssh with no daemon runs no Keel that could copy the session. A host the fleet does not know is told to the
// owner (`unknown`, an Errors row) on a send: a Keel there, paired or not, was not told.
export function farTeller(o: { machine: (host: string) => { id: string; ssh: boolean } | undefined; post: (id: string, digests: string[]) => Promise<unknown>; unknown: (host: string) => void }) {
  return async (host: string, digests: string[], quiet: boolean): Promise<FarAnswer> => {
    const m = o.machine(host);
    if (!m) { if (!quiet) o.unknown(host); return "none"; }
    if (m.ssh) return "none";
    try {
      await o.post(m.id, digests);
      return "told";
    } catch (e) {
      if ((e as { status?: number }).status === 404) return "old";
      throw e;
    }
  };
}

// What waits for a far machine's Keel: kept with the host the send went to until that Keel took it, so a Keel that
// could not keep it yet (an older build) gets it once it can, before it copies a session the drive sent into.
const FAR = "CREATE TABLE IF NOT EXISTS drive_sends_far (host TEXT NOT NULL, digest TEXT NOT NULL, sent_ms INTEGER NOT NULL, PRIMARY KEY (host, digest))";
const PART = 4096; // what the route takes at once (noteDigests)

// A send into a session on `host`: its digests wait for that host's Keel, which is told them (and whatever else
// waits for it) before the words go. The send may go unless this throws.
export async function farSent(store: Store, host: string, digests: string[]): Promise<FarAnswer | undefined> {
  if (!host || !digests.length || !far) return undefined;
  store.migrate(FAR);
  const q = store.db.query("INSERT OR IGNORE INTO drive_sends_far (host, digest, sent_ms) VALUES (?, ?, ?)");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(host, d, now); })();
  return pushFar(store, host, false);
}

async function pushFar(store: Store, host: string, quiet: boolean): Promise<FarAnswer | undefined> {
  if (!far) return undefined;
  const waiting = store.db.query<{ digest: string }, [string]>("SELECT digest FROM drive_sends_far WHERE host = ? ORDER BY sent_ms").all(host).map((r) => r.digest);
  let answer: FarAnswer = "told";
  for (let i = 0; i < waiting.length; i += PART) {
    const part = waiting.slice(i, i + PART);
    answer = await far(host, part, quiet);
    if (answer !== "told") return answer;
    const del = store.db.query("DELETE FROM drive_sends_far WHERE host = ? AND digest = ?");
    store.db.transaction(() => { for (const d of part) del.run(host, d); })();
  }
  return answer;
}

// Every host whose Keel still waits for digests and that `reached` says a link to it just came up: told again.
// A host still out of reach or still too old waits for its next link.
export async function farCatchUp(store: Store, reached: (host: string) => boolean) {
  let hosts: string[];
  try { hosts = store.db.query<{ host: string }, []>("SELECT DISTINCT host FROM drive_sends_far").all().map((r) => r.host); } catch { return; } // nothing ever waited
  for (const h of hosts.filter(reached)) {
    try { await pushFar(store, h, true); } catch {} // out of reach again: its next link tries
  }
}
