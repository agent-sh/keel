// The sealed record's daily root (src/core/seal.ts says what it covers). Once a day, soon after the UTC day
// closes, the heads of every session that moved since the last root are kept as the day's leaves, and their
// Merkle root (with the root before it) is the day's root. The root is written where no session can write
// it: a file in the daemon's state folder, outside the writable set of every sandbox a command runs in and
// outside every folder a session is given, and a copy at the path the owner names in `seal.mirror`
// (a synced or mounted folder, which puts the root off this machine). A session that rewrites the whole
// store, chain and heads included, still does not make the roots in the file.
import { readFileSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dayRoot, hex, leaf, merkle } from "../core/seal.ts";
import type { Store } from "../core/store.ts";
import { timed } from "./stall.ts";
import { registerSettings, settings } from "./settings.ts";

registerSettings("seal", { mirror: "" }, (v) => (typeof v.mirror === "string" && (v.mirror === "" || v.mirror.startsWith("/")) ? undefined : "mirror is an absolute file path, or empty for none"));

export const DAY_MS = 86_400_000;
const LOOK_MS = 600_000;
export const rootsPath = (stateDir: string) => join(stateDir, "seal", "roots.jsonl");
// The UTC day a root is made for: the one that has just closed.
export const closedDay = (now: number) => new Date(now - DAY_MS).toISOString().slice(0, 10);

export type RootLine = { day: string; at: number; root: string; prev: string | null; sessions: number };
// The roots a text holds (a line that is not one is skipped: the verifier then finds the day missing).
function parseRoots(text: string): RootLine[] {
  const out: RootLine[] = [];
  for (const l of text.split("\n")) {
    try {
      const r = JSON.parse(l) as RootLine;
      if (typeof r?.day === "string" && typeof r.root === "string") out.push(r);
    } catch {}
  }
  return out;
}
// The roots a file holds, null when there is none. Synchronous: for a command's own process and tests, never the daemon's loop.
export function readRoots(path: string): RootLine[] | null {
  try { return parseRoots(readFileSync(path, "utf8")); } catch { return null; }
}

// A file that lives on a stale network or FUSE mount can hold a call for as long as the mount does: the
// daemon reads and writes these files through the thread pool, never on the loop, and gives each call this long.
export const LIMIT_MS = 10_000;
function limited<T>(p: Promise<T>, what: string, ms = LIMIT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  p.catch(() => {});
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error(`${what} did not answer in ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}
// The roots a file holds: null when there is no such file; throws when it cannot be read in time.
export async function loadRoots(path: string, ms = LIMIT_MS): Promise<RootLine[] | null> {
  try { return parseRoots(await limited(readFile(path, "utf8"), path, ms)); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
}
async function writeLine(path: string, line: RootLine, ms = LIMIT_MS) {
  await limited((async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const f = await open(path, "a", 0o600);
    try { await f.appendFile(`${JSON.stringify(line)}\n`); await f.sync(); } finally { await f.close(); }
  })(), path, ms);
}

export class SealRoots {
  private timer?: ReturnType<typeof setInterval>;
  // The copies may be behind the store: at a start, after a root is made, after a copy failed, after the mirror changed.
  // Only then are they looked at: a mirror is not read every ten minutes for nothing.
  private owed = true;
  private busy = false;
  private mirrored = "";
  constructor(private store: Store, private failed: (e: unknown, what: string) => void) {}

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), LOOK_MS);
    this.timer.unref?.();
    setTimeout(() => void this.tick(), 30_000).unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }

  // Makes the day's root when it is due, then brings the copies up to the store when they are owed. Never throws.
  async tick(now = Date.now()): Promise<string | null> {
    let made: string | null = null;
    try {
      made = timed(() => "the sealed record's daily root", () => this.make(now), true);
    } catch (e) {
      this.failed(e, "the sealed record's daily root");
    }
    if (made) this.owed = true;
    if (String(settings().seal?.mirror ?? "") !== this.mirrored) this.owed = true;
    if (this.owed) await this.copy();
    return made;
  }

  // The root of `closedDay(now)` over the heads of the sessions that moved since the last root; null when it is not due or nothing moved.
  make(now: number): string | null {
    const db = this.store.db;
    const day = closedDay(now);
    const last = db.query<{ day: string; at: number; root: Uint8Array }, []>("SELECT day, at, root FROM seal_roots ORDER BY day DESC LIMIT 1").get();
    if (last && last.day >= day) return null;
    const since = last?.at ?? 0;
    return db.transaction(() => {
      const ins = db.query("INSERT INTO seal_days (day, session_id, events, cards, egress) SELECT ?1, id, seal, (SELECT head FROM seal_heads h WHERE h.session_id = s.id AND h.kind = 'cards'), (SELECT head FROM seal_heads h WHERE h.session_id = s.id AND h.kind = 'egress') FROM sessions s WHERE (s.seal IS NOT NULL AND s.updated >= ?2) OR EXISTS (SELECT 1 FROM seal_heads h WHERE h.session_id = s.id AND h.at >= ?2)");
      ins.run(day, since);
      // (The outward rows that name no session are a leaf of their own, session ''.)
      db.query("INSERT INTO seal_days (day, session_id, events, cards, egress) SELECT ?1, '', NULL, NULL, head FROM seal_heads WHERE session_id = '' AND kind = 'egress' AND at >= ?2").run(day, since);
      const leaves = db.query<{ session_id: string; events: Uint8Array | null; cards: Uint8Array | null; egress: Uint8Array | null }, [string]>("SELECT session_id, events, cards, egress FROM seal_days WHERE day = ? ORDER BY session_id").all(day);
      if (!leaves.length) return null;
      const root = dayRoot(day, last?.root ?? null, merkle(leaves.map((l) => leaf({ session: l.session_id, events: l.events, cards: l.cards, egress: l.egress }))).root);
      db.query("INSERT INTO seal_roots (day, at, root, prev_root, sessions) VALUES (?, ?, ?, ?, ?)").run(day, now, root, last?.root ?? null, leaves.length);
      return day;
    })();
  }

  // The file and the mirror hold every root the store holds, in order. A path that cannot be reached in time is
  // reported once and tried again at the next look.
  async copy() {
    if (this.busy) return;
    this.busy = true;
    this.owed = false;
    try {
      const rows = this.store.db.query<{ day: string; at: number; root: Uint8Array; prev_root: Uint8Array | null; sessions: number }, []>("SELECT day, at, root, prev_root, sessions FROM seal_roots ORDER BY day").all();
      const mirror = String(settings().seal?.mirror ?? "");
      this.mirrored = mirror;
      for (const path of [rootsPath(this.store.stateDir), ...(mirror ? [mirror] : [])]) {
        try {
          const have = new Set(((await loadRoots(path)) ?? []).map((r) => r.day));
          for (const r of rows) if (!have.has(r.day)) await writeLine(path, { day: r.day, at: r.at, root: hex(r.root)!, prev: hex(r.prev_root), sessions: r.sessions });
        } catch (e) {
          this.owed = true;
          this.failed(e, path === mirror ? "the sealed record's mirror" : "the sealed record's roots file");
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
