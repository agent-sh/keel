// The words a model sent into another harness's session through the drive (src/drive/tools.ts). That harness
// records them as typed at its prompt, the way it records the owner's own, so a copy of that session made later
// must not count them as the owner's words (Imports.import asks ownerTexts before a copy keeps a prompt's `typed` mark).
// Only keys of the words are kept, never the words (src/drive/sent-read.ts): of each run of a few words.
// What the owner sends from the Elsewhere panel is theirs and is not kept here. What the composer of a session a
// terminal holds types into that terminal is (src/integrations/outside/terminal.ts): Keel typed it, not a person there.
//
// The sends made before this record began are read once from the stored history, on the read thread
// (backfillSent); until that read is done no prompt of a copy counts as typed. A send to a session on another
// machine is told to that machine's Keel before it goes (farSent), since a copy made there reads its own record.
// The keys are kept (about one a word sent): a transcript the drive sent into can be copied for as long as it lives,
// wherever its folder moves.
import type { Store } from "../core/store.ts";
import { digestsOf, farDigest, sentOf, type SentAsk } from "./sent-read.ts";

const SCHEMA = `CREATE TABLE IF NOT EXISTS drive_sends (digest TEXT PRIMARY KEY, sent_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_sends_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drive_sends_caught (daemon_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`;
// The state row that says the history's sends were read, in the keys of this build (sent-read.ts: loose keys).
const READ = "read_runs_loose";

function keep(store: Store, digests: string[]) {
  if (!digests.length) return;
  store.migrate(SCHEMA);
  const q = store.db.query("INSERT OR IGNORE INTO drive_sends (digest, sent_ms) VALUES (?, ?)");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(d, now); })();
}

// Kept before the words are sent (`loose`: the session's input box was not read empty, sent-read.ts keysInto).
// Returns the digests, for a far machine's Keel.
export function noteSent(store: Store, text: string, loose = false): string[] {
  const digests = digestsOf(text, loose);
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

// Why no prompt of a copy can count as the owner's now, if one holds: the history's sends are not read yet, or a
// paired daemon has not said it told this Keel its sends (a Keel of a build before the word never does: a pair with
// one keeps every copy here unmarked, failing closed). `daemon`: that daemon, and its name.
export function typedHeld(store: Store): { daemon?: { id: string; name: string | null } } | undefined {
  try {
    if (!store.db.query("SELECT 1 FROM drive_sends_state WHERE k = ?").get(READ)) return {};
  } catch {
    return {}; // no table: the history was never read
  }
  if (!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fleet_pairs'").get()) return undefined;
  const p = store.db.query<{ daemon_id: string; name: string | null }, []>("SELECT daemon_id, name FROM fleet_pairs p WHERE NOT EXISTS (SELECT 1 FROM drive_sends_caught c WHERE c.daemon_id = p.daemon_id) ORDER BY daemon_id LIMIT 1").get();
  return p ? { daemon: { id: p.daemon_id, name: p.name } } : undefined;
}

// The prompts of `texts` that are the owner's: none while typedHeld holds (`held` is told of a daemon that holds
// it), else each that holds no run of words a model sent (sent-read.ts). `off`: where the check runs, the read thread
// (a long prompt has many keys to look up); unset, here.
export async function ownerTexts(store: Store, texts: string[], o: { off?: (texts: string[]) => Promise<boolean[]>; held?: (daemon: { id: string; name: string | null }) => void } = {}): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...new Set(texts)];
  if (!list.length) return out;
  const why = typedHeld(store);
  if (why) { if (why.daemon) o.held?.(why.daemon); return out; }
  const sent = o.off ? await o.off(list) : sentOf(store.db, { texts: list });
  list.forEach((t, i) => { if (sent[i] === false) out.add(t); });
  return out;
}

// The sends of the stored history, read once on the read thread a part at a time (`run`: Reads.run): the replies'
// calls, then the calls programs made inside run_code.
export async function backfillSent(store: Store, run: (a: SentAsk) => Promise<{ digests: string[]; next: number | null }>, span = 20_000) {
  store.migrate(SCHEMA);
  if (store.db.query("SELECT 1 FROM drive_sends_state WHERE k = ?").get(READ)) return;
  for (const table of ["events", "code_calls"] as const) {
    for (let after = 0; ; ) {
      const r = await run({ after, span, table });
      keep(store, r.digests);
      if (r.next === null) break;
      after = r.next;
    }
  }
  store.db.query("INSERT OR REPLACE INTO drive_sends_state (k, v) VALUES (?, ?)").run(READ, Date.now());
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

// What waits for a far machine's Keel: kept until that Keel took it, so a Keel that could not keep it yet (an older
// build) gets it once it can, before it copies a session the drive sent into. Kept by the machine's id when the
// fleet knew the host (`m:<id>`: a later name of the machine finds it), else by the host as the agent view named it
// (`h:<host>`, in lower case: a Keel paired there later, under that name, is told it).
const FAR = "CREATE TABLE IF NOT EXISTS drive_far_waiting (target TEXT NOT NULL, digest TEXT NOT NULL, sent_ms INTEGER NOT NULL, PRIMARY KEY (target, digest))";
const PART = 4096; // what the route takes at once (noteDigests)

// A send into a session on `host`: its digests wait for that host's Keel, which is told them (and whatever else
// waits for it) before the words go. The send may go unless this throws.
export async function farSent(store: Store, host: string, digests: string[]): Promise<FarAnswer | undefined> {
  if (!host || !digests.length || !far) return undefined;
  const id = far.machine(host, false);
  const target = id ? `m:${id}` : `h:${host.toLowerCase()}`;
  store.migrate(FAR);
  const q = store.db.query("INSERT OR IGNORE INTO drive_far_waiting (target, digest, sent_ms) VALUES (?, ?, ?)");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(target, d, now); })();
  return id ? pushFar(store, far, target, id) : "none";
}

// What waits under `target`, a part at a time from its index (an older Keel's machine can gather many): each part
// is read, told and removed before the next is read.
async function pushFar(store: Store, to: Far, target: string, id: string): Promise<"told" | "old"> {
  const read = store.db.query<{ digest: string }, [string, number]>("SELECT digest FROM drive_far_waiting WHERE target = ? LIMIT ?");
  const del = store.db.query("DELETE FROM drive_far_waiting WHERE target = ? AND digest = ?");
  for (;;) {
    const part = read.all(target, PART).map((r) => r.digest);
    if (!part.length) return "told";
    if ((await to.post(id, part, false)) === "old") return "old";
    store.db.transaction(() => { for (const d of part) del.run(target, d); })();
    if (part.length < PART) return "told";
  }
}

// A link to machine `id` came up (`hosts`: the names the fleet knows it by now): its Keel is told what waits for it
// by its id and under each of those names, then that nothing more does (caught up), even when nothing waited. Until
// every Keel paired with it has said so, a Keel counts no prompt of a copy as the owner's (typedHeld): a send it was
// not told of may be in its sessions. Throws when that Keel is out of reach again: its next link tries.
export async function farCatchUp(store: Store, id: string, hosts: string[]) {
  const to = far;
  if (!to) return;
  store.migrate(FAR);
  const targets = [`m:${id}`, ...new Set(hosts.filter(Boolean).map((x) => `h:${x.toLowerCase()}`))];
  for (const t of targets) if ((await pushFar(store, to, t, id)) === "old") return;
  await to.post(id, [], true);
}
