// Paired phones, pair codes, claimed signatures, push tokens and push records,
// and the global event sequence the phone syncs by. All in the daemon's store.
import type { Store } from "../../core/store.ts";
import type { StoredEvent } from "../../core/types.ts";
import { sha256Hex, type ReplayStore } from "./sig.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, pub TEXT NOT NULL, apub TEXT NOT NULL,
  nolock INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_secs REAL NOT NULL, last_seen_secs REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_pair_codes (code_hash TEXT PRIMARY KEY, expires_secs REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signature_replays (identity TEXT PRIMARY KEY, expires_secs INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS signature_replays_exp ON signature_replays(expires_secs);
CREATE TABLE IF NOT EXISTS push_devices (device_id TEXT PRIMARY KEY, token TEXT NOT NULL, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, sent_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL, error TEXT, acked_ms INTEGER);
CREATE INDEX IF NOT EXISTS pushes_device ON pushes(device_id, sent_ms);
CREATE TABLE IF NOT EXISTS event_gseq (gseq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL);
CREATE TRIGGER IF NOT EXISTS event_gseq_ins AFTER INSERT ON events BEGIN INSERT INTO event_gseq (event_id) VALUES (new.id); END;
CREATE TRIGGER IF NOT EXISTS event_gseq_del AFTER DELETE ON events BEGIN DELETE FROM event_gseq WHERE event_id = old.id; END;
`;

export type Device = {
  id: string; name: string; pub: string; apub: string; nolock: boolean; revoked: boolean; created: number; last_seen: number;
};
export type PushRecord = {
  id: string; device_id: string; kind: string; session_id?: string | null; sent_ms: number; ok: boolean; error?: string | null; acked_ms?: number | null;
  token_hash?: string | null;
};

const nowSecs = () => Date.now() / 1000;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n)).toHex();
type DevRow = { id: string; name: string; pub: string; apub: string; nolock: number; revoked: number; created_secs: number; last_seen_secs: number };
const toDevice = (r: DevRow): Device => ({
  id: r.id, name: r.name, pub: r.pub, apub: r.apub, nolock: !!r.nolock, revoked: !!r.revoked, created: r.created_secs, last_seen: r.last_seen_secs,
});
const toPush = ({ token_hash, ...r }: any): PushRecord => ({ ...r, ok: !!r.ok });

export class MobileStore implements ReplayStore {
  constructor(private store: Pick<Store, "db" | "migrate">) {
    store.migrate(SCHEMA);
    // Which token a push went to: a phone's new registration starts its own record.
    if (!store.db.query("SELECT 1 FROM pragma_table_info('pushes') WHERE name = 'token_hash'").get()) store.migrate("ALTER TABLE pushes ADD COLUMN token_hash TEXT");
    // Events stored before this table existed get their places in order, once.
    store.db.run("INSERT OR IGNORE INTO event_gseq (event_id) SELECT id FROM events WHERE id NOT IN (SELECT event_id FROM event_gseq) ORDER BY ts, rowid");
  }
  private get db() { return this.store.db; }

  setting(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM mobile_settings WHERE key = ?").get(key)?.value;
  }
  setSetting(key: string, value: string) {
    this.db.query("INSERT INTO mobile_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // --- pairing -------------------------------------------------------------

  createPairCode(ttlSecs: number): string {
    const code = rand(18);
    const now = nowSecs();
    this.db.query("DELETE FROM mobile_pair_codes WHERE expires_secs < ?").run(now);
    this.db.query("INSERT INTO mobile_pair_codes (code_hash, expires_secs) VALUES (?, ?)").run(sha256Hex(code), now + Math.max(60, ttlSecs));
    return code;
  }

  pairCodes(): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM mobile_pair_codes WHERE expires_secs >= ?").get(nowSecs())!.n;
  }

  // A code is good once: claiming it deletes it and makes the device.
  claimPairCode(code: string, name: string, pub: string, apub: string, nolock: boolean): { device_id: string; token: string } | null {
    const now = nowSecs();
    return this.db.transaction(() => {
      const hash = sha256Hex(code);
      const row = this.db.query<{ expires_secs: number }, [string]>("SELECT expires_secs FROM mobile_pair_codes WHERE code_hash = ?").get(hash);
      this.db.query("DELETE FROM mobile_pair_codes WHERE code_hash = ? OR expires_secs < ?").run(hash, now);
      if (!row || row.expires_secs < now) return null;
      const token = rand(32);
      const id = `dev_${rand(8)}`;
      this.db.query("INSERT INTO mobile_devices (id, name, token_hash, pub, apub, nolock, revoked, created_secs, last_seen_secs) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .run(id, name.slice(0, 120), sha256Hex(token), pub, apub, nolock ? 1 : 0, now, now);
      return { device_id: id, token };
    }).immediate();
  }

  deviceForToken(token: string): Device | null {
    if (!token.trim()) return null;
    const r = this.db.query<DevRow, [string]>("SELECT * FROM mobile_devices WHERE token_hash = ? AND revoked = 0").get(sha256Hex(token.trim()));
    if (!r) return null;
    this.db.query("UPDATE mobile_devices SET last_seen_secs = ? WHERE id = ?").run(nowSecs(), r.id);
    return toDevice(r);
  }

  device(id: string): Device | null {
    const r = this.db.query<DevRow, [string]>("SELECT * FROM mobile_devices WHERE id = ?").get(id);
    return r ? toDevice(r) : null;
  }

  isActive(id: string): boolean {
    return this.db.query<{ revoked: number }, [string]>("SELECT revoked FROM mobile_devices WHERE id = ?").get(id)?.revoked === 0;
  }

  devices(): Device[] {
    return this.db.query<DevRow, []>("SELECT * FROM mobile_devices ORDER BY created_secs DESC").all().map(toDevice);
  }

  // Revoking also forgets the push token: nothing is sent to a revoked phone.
  revoke(id: string): boolean {
    const n = this.db.query("UPDATE mobile_devices SET revoked = 1 WHERE id = ?").run(id).changes;
    this.db.query("DELETE FROM push_devices WHERE device_id = ?").run(id);
    return n > 0;
  }

  // --- replay ----------------------------------------------------------------

  claim(identity: string, expiresSecs: number): boolean {
    const now = Math.floor(nowSecs());
    if (expiresSecs < now) return false;
    return this.db.transaction(() => {
      this.db.query("DELETE FROM signature_replays WHERE expires_secs < ?").run(now);
      return this.db.query("INSERT OR IGNORE INTO signature_replays (identity, expires_secs) VALUES (?, ?)").run(identity, expiresSecs).changes === 1;
    }).immediate();
  }

  // --- push ------------------------------------------------------------------

  setPushToken(deviceId: string, token: string) {
    if (!token.trim()) this.db.query("DELETE FROM push_devices WHERE device_id = ?").run(deviceId);
    else this.db.query("INSERT INTO push_devices (device_id, token, updated_ms) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token = excluded.token, updated_ms = excluded.updated_ms")
      .run(deviceId, token.trim(), Date.now());
  }
  dropPushToken(token: string) {
    this.db.query("DELETE FROM push_devices WHERE token = ?").run(token);
  }
  // Active devices with a token, or one of them.
  pushTargets(deviceId?: string): { device_id: string; token: string }[] {
    return this.db
      .query<{ device_id: string; token: string }, [string | null]>(
        "SELECT p.device_id, p.token FROM push_devices p JOIN mobile_devices d ON d.id = p.device_id WHERE d.revoked = 0 AND (?1 IS NULL OR p.device_id = ?1) ORDER BY p.device_id",
      )
      .all(deviceId ?? null);
  }
  // A push is recorded before it is sent, so a receipt that beats the push
  // service's answer finds its row; the answer then fills in the outcome and
  // keeps the receipt. Rows are in send order (rowid).
  recordPush(r: PushRecord) {
    this.db.query(
      `INSERT INTO pushes (id, device_id, kind, session_id, sent_ms, ok, error, acked_ms, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET ok = excluded.ok, error = excluded.error, acked_ms = COALESCE(pushes.acked_ms, excluded.acked_ms)`,
    ).run(r.id, r.device_id, r.kind, r.session_id ?? null, r.sent_ms, r.ok ? 1 : 0, r.error ?? null, r.acked_ms ?? null, r.token_hash ?? null);
    // A month of records is plenty to say whether pushes arrive.
    this.db.query("DELETE FROM pushes WHERE sent_ms < ?").run(Date.now() - 30 * 86_400_000);
  }
  // Only the device a push went to can confirm it.
  ackPush(deviceId: string, pushId: string): boolean {
    return this.db.query("UPDATE pushes SET acked_ms = COALESCE(acked_ms, ?) WHERE id = ? AND device_id = ?").run(Date.now(), pushId, deviceId).changes > 0;
  }
  // Whether the phone has a token; the newest push to that token and how many
  // accepted pushes to it are unconfirmed since the last one it confirmed. A
  // new token starts untested; the old token's pushes stay as `previous`. An
  // app that never confirmed any push may not send receipts at all: then there
  // is no warning, only `receipts: false`.
  pushStatus(deviceId: string) {
    const tok = this.db.query<{ token: string }, [string]>("SELECT token FROM push_devices WHERE device_id = ?").get(deviceId);
    const th = tok ? sha256Hex(tok.token) : null;
    const receipts = !!this.db.query("SELECT 1 FROM pushes WHERE device_id = ? AND acked_ms IS NOT NULL").get(deviceId);
    const current = "device_id = ?1 AND (token_hash = ?2 OR (token_hash IS NULL AND ?2 IS NULL))";
    const last = this.db.query<any, [string, string | null]>(`SELECT * FROM pushes WHERE ${current} ORDER BY rowid DESC LIMIT 1`).get(deviceId, th);
    const previous = this.db.query<any, [string, string | null]>("SELECT * FROM pushes WHERE device_id = ?1 AND token_hash IS NOT ?2 ORDER BY rowid DESC LIMIT 1").get(deviceId, th);
    const { n } = this.db.query<{ n: number }, [string, string | null]>(
      `SELECT COUNT(*) AS n FROM pushes WHERE ${current} AND ok = 1 AND acked_ms IS NULL
         AND rowid > COALESCE((SELECT MAX(rowid) FROM pushes WHERE ${current} AND acked_ms IS NOT NULL), 0)`,
    ).get(deviceId, th)!;
    return { registered: !!tok, last: last ? toPush(last) : null, previous: previous ? toPush(previous) : null, unacknowledged: n, receipts, warning: receipts && n >= 3 };
  }

  // --- global sequence ---------------------------------------------------------

  globalSeq(): number {
    return this.db.query<{ n: number | null }, []>("SELECT MAX(gseq) AS n FROM event_gseq").get()!.n ?? 0;
  }
  gseqOf(eventId: string): number {
    return this.db.query<{ gseq: number }, [string]>("SELECT gseq FROM event_gseq WHERE event_id = ?").get(eventId)?.gseq ?? 0;
  }
  // Events after a global cursor across all sessions, oldest first; only the
  // given kinds when named.
  eventsAfter(since: number, limit: number, kinds?: string[]): (StoredEvent & { gseq: number })[] {
    const only = kinds?.length ? ` AND e.kind IN (${kinds.map(() => "?").join(", ")})` : "";
    return this.db
      .query<any, any[]>(`SELECT e.*, g.gseq FROM event_gseq g JOIN events e ON e.id = g.event_id WHERE g.gseq > ?${only} ORDER BY g.gseq LIMIT ?`)
      .all(since, ...(kinds ?? []), limit)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
  // When the event at a cursor was stored (the newest one at or before it).
  tsOfGseq(gseq: number): number | undefined {
    return this.db.query<{ ts: number }, [number]>("SELECT e.ts FROM event_gseq g JOIN events e ON e.id = g.event_id WHERE g.gseq <= ? ORDER BY g.gseq DESC LIMIT 1").get(gseq)?.ts;
  }
}
