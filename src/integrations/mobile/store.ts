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
};

const nowSecs = () => Date.now() / 1000;
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n)).toHex();
type DevRow = { id: string; name: string; pub: string; apub: string; nolock: number; revoked: number; created_secs: number; last_seen_secs: number };
const toDevice = (r: DevRow): Device => ({
  id: r.id, name: r.name, pub: r.pub, apub: r.apub, nolock: !!r.nolock, revoked: !!r.revoked, created: r.created_secs, last_seen: r.last_seen_secs,
});
const toPush = (r: any): PushRecord => ({ ...r, ok: !!r.ok });

export class MobileStore implements ReplayStore {
  constructor(private store: Pick<Store, "db" | "migrate">) {
    store.migrate(SCHEMA);
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
  recordPush(r: PushRecord) {
    this.db.query("INSERT OR REPLACE INTO pushes (id, device_id, kind, session_id, sent_ms, ok, error, acked_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.id, r.device_id, r.kind, r.session_id ?? null, r.sent_ms, r.ok ? 1 : 0, r.error ?? null, r.acked_ms ?? null);
    // A month of records is plenty to say whether pushes arrive.
    this.db.query("DELETE FROM pushes WHERE sent_ms < ?").run(Date.now() - 30 * 86_400_000);
  }
  // Only the device a push went to can confirm it.
  ackPush(deviceId: string, pushId: string): boolean {
    return this.db.query("UPDATE pushes SET acked_ms = COALESCE(acked_ms, ?) WHERE id = ? AND device_id = ?").run(Date.now(), pushId, deviceId).changes > 0;
  }
  // Whether the phone has a token, its newest push, and how many accepted pushes
  // it has not confirmed since the last one it did.
  pushStatus(deviceId: string) {
    const registered = !!this.db.query("SELECT 1 FROM push_devices WHERE device_id = ?").get(deviceId);
    const last = this.db.query<any, [string]>("SELECT * FROM pushes WHERE device_id = ? ORDER BY sent_ms DESC, rowid DESC LIMIT 1").get(deviceId);
    const { n } = this.db.query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM pushes WHERE device_id = ? AND ok = 1 AND acked_ms IS NULL
         AND sent_ms > COALESCE((SELECT MAX(sent_ms) FROM pushes WHERE device_id = ? AND acked_ms IS NOT NULL), 0)`,
    ).get(deviceId, deviceId)!;
    return { registered, last: last ? toPush(last) : null, unacknowledged: n, warning: n >= 3 };
  }

  // --- global sequence ---------------------------------------------------------

  globalSeq(): number {
    return this.db.query<{ n: number | null }, []>("SELECT MAX(gseq) AS n FROM event_gseq").get()!.n ?? 0;
  }
  gseqOf(eventId: string): number {
    return this.db.query<{ gseq: number }, [string]>("SELECT gseq FROM event_gseq WHERE event_id = ?").get(eventId)?.gseq ?? 0;
  }
  // Events after a global cursor across all sessions, oldest first.
  eventsAfter(since: number, limit: number): (StoredEvent & { gseq: number })[] {
    return this.db
      .query<any, [number, number]>(
        "SELECT e.*, g.gseq FROM event_gseq g JOIN events e ON e.id = g.event_id WHERE g.gseq > ? ORDER BY g.gseq LIMIT ?",
      )
      .all(since, limit)
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }
}
