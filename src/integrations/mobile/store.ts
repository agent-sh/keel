// Paired phones, pair codes, claimed signatures, push tokens and push records,
// and the global event sequence the phone syncs by. All in the daemon's store.
import type { Store } from "../../core/store.ts";
import type { StoredEvent } from "../../core/types.ts";
import { sha256Hex, type ReplayStore } from "./sig.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, pub TEXT NOT NULL, apub TEXT NOT NULL,
  nolock INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, created_secs REAL NOT NULL, last_seen_secs REAL NOT NULL);
CREATE TABLE IF NOT EXISTS mobile_pair_codes (code_hash TEXT PRIMARY KEY, expires_secs REAL NOT NULL, device_id TEXT);
CREATE TABLE IF NOT EXISTS mobile_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signature_replays (identity TEXT PRIMARY KEY, expires_secs INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS signature_replays_exp ON signature_replays(expires_secs);
CREATE TABLE IF NOT EXISTS push_devices (device_id TEXT PRIMARY KEY, token TEXT NOT NULL, updated_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pushes (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, sent_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL, error TEXT, acked_ms INTEGER);
CREATE INDEX IF NOT EXISTS pushes_device ON pushes(device_id, sent_ms);
CREATE TABLE IF NOT EXISTS mobile_sends (
  device_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  event_id TEXT, queue_id TEXT, receipt TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (device_id, client_id));
CREATE TABLE IF NOT EXISTS event_gseq (gseq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL);
CREATE TRIGGER IF NOT EXISTS event_gseq_ins AFTER INSERT ON events BEGIN INSERT INTO event_gseq (event_id) VALUES (new.id); END;
CREATE TRIGGER IF NOT EXISTS event_gseq_del AFTER DELETE ON events BEGIN DELETE FROM event_gseq WHERE event_id = old.id; END;
CREATE TABLE IF NOT EXISTS mobile_branch (session_id TEXT PRIMARY KEY, gseq INTEGER NOT NULL);
DROP TRIGGER IF EXISTS mobile_branch_mark;
CREATE TRIGGER mobile_branch_mark AFTER UPDATE OF head ON sessions
WHEN old.head IS NOT NULL AND new.head IS NOT old.head AND (new.head IS NULL OR (SELECT parent FROM events WHERE id = new.head) IS NOT old.head
  OR (SELECT gseq FROM event_gseq WHERE event_id = new.head) < COALESCE((SELECT gseq FROM mobile_branch WHERE session_id = new.id), 0))
BEGIN
  INSERT OR REPLACE INTO event_gseq (event_id) VALUES ('head:' || new.id);
  INSERT OR REPLACE INTO mobile_branch (session_id, gseq) VALUES (new.id, last_insert_rowid());
  DELETE FROM event_gseq WHERE event_id = 'head:' || new.id;
END;
CREATE TRIGGER IF NOT EXISTS mobile_branch_del AFTER DELETE ON sessions BEGIN DELETE FROM mobile_branch WHERE session_id = old.id; END;
`;

export type Device = {
  id: string; name: string; pub: string; apub: string; nolock: boolean; revoked: boolean; created: number; last_seen: number;
  token_used?: boolean;
};
export type PushRecord = {
  id: string; device_id: string; kind: string; session_id?: string | null; sent_ms: number; ok: boolean; error?: string | null; acked_ms?: number | null;
  token_hash?: string | null;
};

// A prompt a phone sent under an id of its own making, and what it was told.
export type SendRecord = { session_id: string; fingerprint: string; event_id: string | null; queue_id: string | null; receipt: string };

const nowSecs = () => Date.now() / 1000;
export const hostOf = (u?: string | null) => { try { return u ? new URL(u).host : null; } catch { return null; } };
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n)).toHex();
type DevRow = { id: string; name: string; pub: string; apub: string; nolock: number; revoked: number; created_secs: number; last_seen_secs: number; token_used: number };
const toDevice = (r: DevRow): Device => ({
  id: r.id, name: r.name, pub: r.pub, apub: r.apub, nolock: !!r.nolock, revoked: !!r.revoked, created: r.created_secs, last_seen: r.last_seen_secs,
  token_used: !!r.token_used,
});
const toPush = ({ token_hash, ...r }: any): PushRecord => ({ ...r, ok: !!r.ok });

export class MobileStore implements ReplayStore {
  constructor(private store: Pick<Store, "db" | "migrate">) {
    store.migrate(SCHEMA);
    // Which token a push went to: a phone's new registration starts its own record.
    if (!store.db.query("SELECT 1 FROM pragma_table_info('pushes') WHERE name = 'token_hash'").get()) store.migrate("ALTER TABLE pushes ADD COLUMN token_hash TEXT");
    // A redeemed code names its device until it expires (a pairing retry); a
    // device's token is marked once it authenticated a request.
    if (!store.db.query("SELECT 1 FROM pragma_table_info('mobile_pair_codes') WHERE name = 'device_id'").get()) store.migrate("ALTER TABLE mobile_pair_codes ADD COLUMN device_id TEXT");
    if (!store.db.query("SELECT 1 FROM pragma_table_info('mobile_devices') WHERE name = 'token_used'").get()) store.migrate("ALTER TABLE mobile_devices ADD COLUMN token_used INTEGER NOT NULL DEFAULT 0");
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

  // The address the phone reaches this machine at, from a pair link. Each one
  // given is remembered: a phone paired through it keeps passing the Host check
  // after a new link names another address.
  setPublicUrl(url: string) {
    this.setSetting("public_url", url);
    const h = hostOf(url);
    if (h && !this.pairHosts().includes(h)) this.setSetting("pair_hosts", JSON.stringify([...this.pairHosts(), h]));
  }
  pairHosts(): string[] {
    try { return JSON.parse(this.setting("pair_hosts") ?? "[]"); } catch { return []; }
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
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM mobile_pair_codes WHERE expires_secs >= ? AND device_id IS NULL").get(nowSecs())!.n;
  }

  // A code is good once: claiming it makes the device. A phone that lost the
  // answer may ask again with the same code until it expires, and only with
  // `proven` (it signed this request with the device's own key over a body
  // naming this server): the same keys get the same device and a new token,
  // as long as the first token never authenticated a request. Anything else
  // with a used code fails.
  claimPairCode(code: string, name: string, pub: string, apub: string, nolock: boolean, proven = false): { device_id: string; token: string; reissued?: boolean } | null {
    const now = nowSecs();
    return this.db.transaction(() => {
      const hash = sha256Hex(code);
      this.db.query("DELETE FROM mobile_pair_codes WHERE expires_secs < ?").run(now);
      const row = this.db.query<{ expires_secs: number; device_id: string | null }, [string]>("SELECT expires_secs, device_id FROM mobile_pair_codes WHERE code_hash = ?").get(hash);
      if (!row || row.expires_secs < now) return null;
      const token = rand(32);
      if (row.device_id) {
        if (!proven) return null;
        const n = this.db.query("UPDATE mobile_devices SET token_hash = ?, last_seen_secs = ? WHERE id = ? AND revoked = 0 AND pub = ? AND apub = ? AND token_used = 0")
          .run(sha256Hex(token), now, row.device_id, pub, apub).changes;
        return n === 1 ? { device_id: row.device_id, token, reissued: true } : null;
      }
      const id = `dev_${rand(8)}`;
      this.db.query("UPDATE mobile_pair_codes SET device_id = ? WHERE code_hash = ?").run(id, hash);
      this.db.query("INSERT INTO mobile_devices (id, name, token_hash, pub, apub, nolock, revoked, created_secs, last_seen_secs) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
        .run(id, name.slice(0, 120), sha256Hex(token), pub, apub, nolock ? 1 : 0, now, now);
      return { device_id: id, token };
    }).immediate();
  }

  // The token authenticated a request: no pairing retry may replace it now.
  // Bound to the token, so a request that raced a re-issue marks nothing.
  markTokenUsed(id: string, token: string): boolean {
    return this.db.query("UPDATE mobile_devices SET token_used = 1 WHERE id = ? AND token_hash = ? AND revoked = 0").run(id, sha256Hex(token.trim())).changes === 1;
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

  // --- sends ------------------------------------------------------------------

  // What a phone was told for a prompt it sent under `clientId`, if it sent one.
  sendOf(deviceId: string, clientId: string): SendRecord | undefined {
    return this.db.query<SendRecord, [string, string]>("SELECT session_id, fingerprint, event_id, queue_id, receipt FROM mobile_sends WHERE device_id = ? AND client_id = ?").get(deviceId, clientId) ?? undefined;
  }
  // Written in the transaction that stores the prompt (the caller's), so a
  // prompt and its receipt are there together or not at all. A phone that
  // kept a send retries it when it is next opened: a month covers that.
  recordSend(deviceId: string, clientId: string, r: SendRecord) {
    this.db.query("INSERT INTO mobile_sends (device_id, client_id, session_id, fingerprint, event_id, queue_id, receipt, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(deviceId, clientId, r.session_id, r.fingerprint, r.event_id, r.queue_id, r.receipt, Date.now());
    this.db.query("DELETE FROM mobile_sends WHERE created_ms < ?").run(Date.now() - 30 * 86_400_000);
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

  // The newest place given out. It never goes back while this store lives,
  // also when the newest events are deleted with their session: a phone's
  // cursor above it was given by another store (a restored backup).
  globalSeq(): number {
    return this.db.query<{ n: number | null }, []>("SELECT seq AS n FROM sqlite_sequence WHERE name = 'event_gseq'").get()?.n ?? 0;
  }
  // A session's shown branch changed when its head moved anywhere but onto a
  // new event below the old head: another branch was picked, a prompt was
  // edited into a sibling, the conversation was rewound or cleared, or an
  // event that was already there below the head is shown again after a rewind
  // (it is older than the session's last move, so no append). Each such
  // move takes a place in the global sequence (the trigger above), so a cursor
  // says which of them a phone has not seen. Only the newest per session is kept.
  branchSeq(sessionId: string): number {
    return this.db.query<{ gseq: number }, [string]>("SELECT gseq FROM mobile_branch WHERE session_id = ?").get(sessionId)?.gseq ?? 0;
  }
  branchesAfter(since: number): string[] {
    return this.db.query<{ session_id: string }, [number]>("SELECT session_id FROM mobile_branch WHERE gseq > ? ORDER BY gseq").all(since).map((r) => r.session_id);
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
