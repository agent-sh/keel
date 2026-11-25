// The words a model sent into another harness's session through the drive (src/drive/tools.ts). That harness
// records them as typed at its prompt, the way it records the owner's own, so a copy of that session made later
// must not count them as the owner's words (Imports.copy asks wasSent before it keeps a prompt's `typed` mark).
// Only digests of the words are kept, never the words (src/drive/sent-read.ts): of the whole and of each line.
// What the owner sends from the page is theirs and is not kept here.
//
// The sends made before this record began are read once from the stored history, on the read thread
// (backfillSent); until that read is done no prompt of a copy counts as typed. A send to a session on another
// machine is told to that machine's Keel before it goes (farSent), since a copy made there reads its own record.
// A digest is dropped once the transcript it went into is gone from its store (pruneSent): no copy can be made of
// it any more. Not by its age alone: a session the owner resumes keeps writing the transcript it began, which can
// outlive any age (Claude Code removes a transcript only when it was not written for its cleanup period). One whose
// transcript the drive did not name is kept.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Store } from "../core/store.ts";
import { digestsOf, sentBy, type SentAsk } from "./sent-read.ts";
import { codexHome } from "../integrations/import/codex.ts";

const DAY = 24 * 3600_000;

const SCHEMA = `CREATE TABLE IF NOT EXISTS drive_sends (digest TEXT NOT NULL, transcript TEXT NOT NULL DEFAULT '', sent_ms INTEGER NOT NULL, PRIMARY KEY (digest, transcript));
CREATE TABLE IF NOT EXISTS drive_sends_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`;

function keep(store: Store, digests: string[], transcript: string) {
  if (!digests.length) return;
  store.migrate(SCHEMA);
  const q = store.db.query("INSERT INTO drive_sends (digest, transcript, sent_ms) VALUES (?, ?, ?) ON CONFLICT(digest, transcript) DO UPDATE SET sent_ms = excluded.sent_ms");
  const now = Date.now();
  store.db.transaction(() => { for (const d of digests) q.run(d, transcript, now); })();
}

// Kept before the words are sent, with the transcript the session writes when the drive names it. Returns the
// digests, for a far machine's Keel.
export function noteSent(store: Store, text: string, transcript?: string): string[] {
  const digests = digestsOf(text);
  keep(store, digests, transcript ?? "");
  pruneSent(store);
  return digests;
}

// Digests another machine's Keel sent for a send into a session here (the fleet's paired route).
export function noteDigests(store: Store, digests: unknown[]) {
  keep(store, digests.filter((d): d is string => typeof d === "string" && /^\d{1,24}$/.test(d)).slice(0, 4096), "");
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
      keep(store, r.digests, "");
      if (r.next === null) break;
      after = r.next;
    }
  }
  store.db.query("INSERT OR REPLACE INTO drive_sends_state (k, v) VALUES ('backfilled', ?)").run(Date.now());
}

// A transcript's file in its store, where its harness may have moved it (Codex moves an archived rollout).
const present = (path: string) => existsSync(path) || (/\/rollout-[^/]+\.jsonl$/.test(path) && existsSync(join(codexHome(), "archived_sessions", basename(path))));

// Drops the digests whose transcript is gone, at most once a day; a digest sent within the day stays (its file may
// not be written yet).
export function pruneSent(store: Store, now = Date.now()) {
  try {
    const last = store.db.query<{ v: number }, []>("SELECT v FROM drive_sends_state WHERE k = 'pruned'").get()?.v ?? 0;
    if (now - last < DAY) return;
    const paths = store.db.query<{ transcript: string }, [number]>("SELECT DISTINCT transcript FROM drive_sends WHERE transcript != '' AND sent_ms < ?").all(now - DAY).map((r) => r.transcript);
    const gone = paths.filter((p) => !present(p));
    const del = store.db.query("DELETE FROM drive_sends WHERE transcript = ? AND sent_ms < ?");
    store.db.transaction(() => {
      for (const p of gone) del.run(p, now - DAY);
      store.db.query("INSERT OR REPLACE INTO drive_sends_state (k, v) VALUES ('pruned', ?)").run(now);
    })();
  } catch {} // no table yet: nothing to prune
}

// Tells the Keel of the machine an outside session runs on (its agent view's host name) the digests of a send,
// before the send: set by the fleet (src/server/routes/fleet.ts). It throws when that machine runs a Keel that could
// not be told; it does nothing for a host with no Keel the fleet knows.
let far: ((host: string, digests: string[]) => Promise<void>) | undefined;
export const onFarSent = (fn: typeof far) => { far = fn; };
export async function farSent(host: string, digests: string[]) {
  if (host && digests.length && far) await far(host, digests);
}
