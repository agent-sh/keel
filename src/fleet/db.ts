// Fleet records: this daemon's identity, the machines it knows, the daemons it
// gave a key to, cross-daemon messages and placement rules. All in keel.db.
import type { Store } from "../core/store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fleet_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'daemon' (a loopback URL) or 'ssh' (a host alias, daemon behind ssh -L)
  daemon_url TEXT,
  ssh_host TEXT,
  daemon_port INTEGER,
  workspace_root TEXT,             -- the directory granted on that machine
  auto_connect INTEGER NOT NULL DEFAULT 1,
  colour TEXT,
  messages TEXT NOT NULL DEFAULT 'allow',
  max_jobs INTEGER,
  link_daemon_id TEXT,             -- the far daemon's id, kept from pairing
  link_key TEXT,                   -- the secret it gave us; never returned by a route
  facts TEXT,
  state TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT,
  checked_ms INTEGER,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fleet_pairs (daemon_id TEXT PRIMARY KEY, name TEXT, key TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_messages (
  id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL,
  state TEXT NOT NULL,             -- queued | delivered | handled | held | outbound | dropped (message-state.ts)
  to_session TEXT NOT NULL,
  to_daemon TEXT,                  -- set for outbound messages
  text TEXT NOT NULL,
  wake INTEGER NOT NULL DEFAULT 1,
  sender TEXT NOT NULL,            -- JSON: { session_id, title, daemon_id, machine, mode, sandbox }
  reason TEXT
);
CREATE INDEX IF NOT EXISTS fleet_messages_to ON fleet_messages(to_session, created_ms DESC);
CREATE TABLE IF NOT EXISTS fleet_steps (session_id TEXT NOT NULL, call_id TEXT NOT NULL, machine TEXT NOT NULL, PRIMARY KEY (session_id, call_id));
`;

export type Facts = {
  hostname: string; os: string; arch: string; cpus: number; load1: number;
  mem_total_mb: number; mem_available_mb?: number; gpu?: string; tools: string[];
  sandbox: boolean; keel_version: string; root?: string;
  measured_ms?: number; // when this daemon took the reading (a failed check later keeps it)
};

export type MachineRow = {
  id: string; name: string; source: "daemon" | "ssh"; daemon_url: string | null; ssh_host: string | null;
  daemon_port: number | null; workspace_root: string | null; auto_connect: number; colour: string | null;
  messages: "allow" | "hold"; max_jobs: number | null; link_daemon_id: string | null; link_key: string | null;
  facts: string | null; state: string; reason: string | null; checked_ms: number | null; created: number;
  offline_since: number | null; // when it was last heard before it went out of reach; null while it answers
};

export function migrate(store: Store) {
  store.migrate(SCHEMA);
  if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  // What the receiving daemon called the session of a refused outbox message.
  if (!store.columnExists("fleet_messages", "to_title")) store.migrate("ALTER TABLE fleet_messages ADD COLUMN to_title TEXT");
  // The machine a session's own message went to: the sender's copy of it (messages.ts keepSent).
  if (!store.columnExists("fleet_messages", "state_ms")) store.migrate("ALTER TABLE fleet_messages ADD COLUMN state_ms INTEGER");
  if (!store.columnExists("fleet_messages", "sent_to")) store.migrate("ALTER TABLE fleet_messages ADD COLUMN sent_to TEXT");
  if (!store.columnExists("fleet_machines", "offline_since")) store.migrate("ALTER TABLE fleet_machines ADD COLUMN offline_since INTEGER");
}

export function meta(store: Store, key: string, make: () => string): string {
  const r = store.db.query<{ value: string }, [string]>("SELECT value FROM fleet_meta WHERE key = ?").get(key);
  if (r) return r.value;
  const v = make();
  store.db.query("INSERT INTO fleet_meta (key, value) VALUES (?, ?)").run(key, v);
  return v;
}
