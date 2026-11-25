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
import { digestsOf, farDigest, sentBy, type SentAsk } from "./sent-read.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS drive_sends (digest TEXT PRIMARY KEY, sent_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_sends_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_sends_caught (daemon_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`;

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
  keep(store, digests.filter((d): d is string => typeof d === "string" && farDigest(d)).slice(0, 4096));
}

// A paired daemon said it has told this Keel every send it made into a session here (farCatchUp, on each of its
// links; the fleet's paired route).
export function noteCaughtUp(store: Store, daemonId: string) {
  store.migrate(SCHEMA);
  store.db.query("INSERT OR REPLACE INTO drive_sends_caught (daemon_id, at) VALUES (?, ?)").run(daemonId, Date.now());
}

// Whether a paired daemon has not yet said it told every send (a Keel of a build before the word never does: a pair
// with one keeps every copy here unmarked, failing closed).
function pairNotCaughtUp(store: Store): boolean {
  if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fleet_pairs'").get()) return false;
  return !!store.db.query("SELECT 1 FROM fleet_pairs p WHERE NOT EXISTS (SELECT 1 FROM drive_sends_caught c WHERE c.daemon_id = p.daemon_id) LIMIT 1").get();
}

// Whether a recorded prompt is words a model sent through the drive. True while the history's sends are not read
// yet, and while a paired daemon has not said it told this Keel its sends: a prompt is the owner's only once it is
// known that no model sent it.
export function wasSent(store: Store, text: string): boolean {
  try {
    if (!store.db.query("SELECT 1 FROM drive_sends_state WHERE k = 'backfilled'").get()) return true;
    if (pairNotCaughtUp(store)) return true;
    const q = store.db.query<unknown, [string]>("SELECT 1 FROM drive_sends WHERE digest = ? LIMIT 1");
    const heads = store.db.query<{ digest: string }, [string, string]>("SELECT digest FROM drive_sends WHERE digest >= ? AND digest < ?");
    return sentBy(text, (d) => !!q.get(d), (h) => heads.all(`h:${h}:`, `h:${h};`).map((r) => Number(r.digest.slice(h.length + 3))));
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
// (src/server/routes/fleet.ts). `machine`: the paired machine whose Keel a host names, or none (a machine reached
// over ssh runs no Keel that could copy the session; a host the fleet does not know is told to the owner on a send,
// not on a catch-up: `quiet`). `post` gives that Keel digests, and with `caughtUp` says nothing more waits for it;
// "old": a Keel of a build before the route, which keeps no typed marks at all. It throws when that Keel could not
// be reached.
export type FarAnswer = "told" | "old" | "none";
type Far = { machine: (host: string, quiet: boolean) => string | undefined; post: (id: string, digests: string[], caughtUp: boolean) => Promise<"told" | "old"> };
let far: Far | undefined;
export const onFarSent = (fn: Far | undefined) => { far = fn; };

// The teller the fleet sets: `machine` is the fleet's machine a host names, `post` gives it the digests (a LinkError
// with the status of an answer that is not ok). A Keel of a build before the route answers 404.
export function farTeller(o: { machine: (host: string) => { id: string; ssh: boolean } | undefined; post: (id: string, digests: string[], caughtUp: boolean) => Promise<unknown>; unknown: (host: string) => void }): Far {
  return {
    machine: (host, quiet) => {
      const m = o.machine(host);
      if (!m) { if (!quiet) o.unknown(host); return undefined; }
      return m.ssh ? undefined : m.id;
    },
    post: async (id, digests, caughtUp) => {
      try {
        await o.post(id, digests, caughtUp);
        return "told";
      } catch (e) {
        if ((e as { status?: number }).status === 404) return "old";
        throw e;
      }
    },
  };
}

// What waits for a far machine's Keel: kept with the host the send went to (as the fleet names it, in lower case)
// until that Keel took it, so a Keel that could not keep it yet (an older build) gets it once it can, before it
// copies a session the drive sent into. A host with no Keel the fleet reaches keeps its digests too: a Keel paired
// there later is told them.
const FAR = "CREATE TABLE IF NOT EXISTS drive_sends_far (host TEXT NOT NULL, digest TEXT NOT NULL, sent_ms INTEGER NOT NULL, PRIMARY KEY (host, digest))";
const PART = 4096; // what the route takes at once (noteDigests)

// A send into a session on `host`: its digests wait for that host's Keel, which is told them (and whatever else
// waits for it) before the words go. The send may go unless this throws.
export async function farSent(store: Store, host: string, digests: string[]): Promise<FarAnswer | undefined> {
  if (!host || !digests.length || !far) return undefined;
  const h = host.toLowerCase();
  store.migrate(FAR);
  const q = store.db.query("INSERT OR IGNORE INTO drive_sends_far (host, digest, sent_ms) VALUES (?, ?, ?)");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(h, d, now); })();
  const id = far.machine(host, false);
  return id ? pushFar(store, far, h, id) : "none";
}

// What waits for the host, a part at a time from its index (an older Keel's host can gather many): each part is
// read, told and removed before the next is read.
async function pushFar(store: Store, to: Far, host: string, id: string): Promise<"told" | "old"> {
  const read = store.db.query<{ digest: string }, [string, number]>("SELECT digest FROM drive_sends_far WHERE host = ? LIMIT ?");
  const del = store.db.query("DELETE FROM drive_sends_far WHERE host = ? AND digest = ?");
  for (;;) {
    const part = read.all(host, PART).map((r) => r.digest);
    if (!part.length) return "told";
    if ((await to.post(id, part, false)) === "old") return "old";
    store.db.transaction(() => { for (const d of part) del.run(host, d); })();
    if (part.length < PART) return "told";
  }
}

// A link to machine `id` came up (`hosts`: the names the fleet knows it by): its Keel is told what still waits for
// it, then that nothing more does (caught up), even when nothing waited. Until every Keel paired with it has said
// so, a Keel counts no prompt of a copy as the owner's (wasSent): a send it was not told of may be in its sessions.
// Throws when that Keel is out of reach again: its next link tries.
export async function farCatchUp(store: Store, id: string, hosts: string[]) {
  const to = far;
  if (!to) return;
  store.migrate(FAR);
  for (const h of new Set(hosts.filter(Boolean).map((x) => x.toLowerCase()))) if ((await pushFar(store, to, h, id)) === "old") return;
  await to.post(id, [], true);
}
