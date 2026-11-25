// The fleet: this daemon's identity, the machines it knows, their links and
// checks, the relay of each linked daemon's live frames, and each machine's job
// queue. One owner, several machines, one view.
import { hostname } from "node:os";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Frame, Session } from "../core/types.ts";
import type { SessionState } from "../core/watch.ts";
import { type Facts, type MachineRow, meta, migrate } from "./db.ts";
import { freeCores, localFacts, VERSION } from "./facts.ts";
import { CONNECT_MS, freePort, LinkError, linkFetch, linkJson, listenerUids, loopbackUrl, newKey, whyUnreached, type Peer } from "./link.ts";
import { place, type Place, type Rule, type Want } from "./placement.ts";
import { groupOf, hostGroups, plainAlias, SSH_BASE, SSH_ONE_SHOT, sshProgram } from "./sshconfig.ts";
import { loginCommand, parseProbe, PROBE_SCRIPT, SshLink } from "./sshlink.ts";
import { join } from "node:path";
import { chunks, readText } from "../core/proc.ts";

export type DaemonLink = { state: "linked" | "offline" | "connecting" | "none"; reason?: string; daemon_id?: string; server_name?: string; version?: string; retry_at_ms?: number };

type Questions = Extract<Frame, { t: "questions" }>;
// `states`: each of that daemon's sessions' state as it tells it (src/core/watch.ts), kept current by its frames.
// `statesRev`: that daemon's bus rev the states reflect (its snapshot's, then its newest state frame's).
// `cut`: why its last stream was lost, when that stream had opened and did not hold (RELAY_STEADY_MS).
// `silence`: how long its stream may say nothing before it is taken for dead (from the ping interval it states).
type Relay = { abort: AbortController; sessions: Map<string, Session>; states: Map<string, SessionState>; statesRev?: number; questions?: Questions; live: boolean; stale: boolean; retry: number; retryAt?: number; timer?: Timer; cut?: string; silence?: number };
type Tunnel = { proc: Bun.Subprocess; port: number };
type Queue = { running: number; waiting: { resolve: () => void; reject: (e: Error) => void }[] };

// Every ssh -L this process opened, across hot reloads: closed when the
// daemon exits (each is its own ssh process and would outlive it).
const g = globalThis as { __keelTunnels?: Set<Bun.Subprocess>; __keelTunnelsExit?: boolean };
const openTunnels = (g.__keelTunnels ??= new Set());
if (!g.__keelTunnelsExit) {
  g.__keelTunnelsExit = true;
  process.on("exit", () => { for (const p of openTunnels) try { p.kill(); } catch {} });
}

const RELAY_MAX_BACKOFF = 60_000; // a relay cut as it opens is reopened after 1, 2, 4 s ... up to a minute
// The wait before a machine that does not answer is asked again, from how long it has been out.
export const relayRetry = (outMs: number) => Math.min(RELAY_MAX_BACKOFF, Math.max(1000, Math.round(outMs / 10)));
// The wait before a lost stream is opened again.
// - `cut`: the far daemon ended a stream that had just opened. That backs off twice as long each
//   time (`times` so far): a reader it cuts again and again must not hammer it.
// - Anything else is the link (the machine did not answer, or its stream went silent): asked
//   again a tenth of the absence after the last try was made, not after it gave up. A try into a
//   dead link takes its whole five seconds to say so, and waiting again after it left a machine
//   out of reach for up to half a minute after its link was back (a silence was also counted as
//   a cut, with the doubled wait).
export const relayWait = (o: { cut: boolean; times: number; outMs: number; triedMs: number }) =>
  o.cut ? Math.min(1000 * 2 ** o.times, RELAY_MAX_BACKOFF) : Math.max(250, relayRetry(o.outMs) - o.triedMs);
// A stream's liveness. The far daemon says how often it pings (RELAY_PING_MS,
// in its first frame): two pings missed and a second of grace, and the stream
// is dead, so a machine that went silent without closing anything (its
// network, a tunnel) is known within about six seconds. A daemon that does
// not say (an older build) pings every 5 s and keeps the long bound it had.
export const RELAY_PING_MS = 2_500;
const RELAY_SILENCE_MS = 45_000;
const RELAY_GRACE_MS = 1_000;
const RELAY_LATE_MS = 250; // a watchdog that ran this late was held up: chunks may wait behind it
export const relaySilence = (pingMs: unknown) => (typeof pingMs === "number" && pingMs >= 500 && pingMs <= 60_000 ? 2 * pingMs + RELAY_GRACE_MS : RELAY_SILENCE_MS);
const RELAY_STEADY_MS = 30_000; // a stream that lived this long was being read: losing it starts the backoff over
// A machine heard again counts as back once it has stayed heard this long (the same bound): until
// then it is still shown out of reach, so one that comes and goes is one absence, said once.
export const steadyMs = () => Number(process.env.KEEL_FLEET_STEADY_MS) || RELAY_STEADY_MS;
const FACTS_FRESH_MS = 60_000; // load1 averages a minute: a queue limit older than that is read again

// What a page needs of a session to draw its row: checked of every session another daemon sends.
const SESSION_ID = /^[\w-]{1,128}$/;
export function soundSession(s: any): s is Session {
  return !!s && typeof s === "object" && typeof s.id === "string" && SESSION_ID.test(s.id) && typeof s.title === "string" && typeof s.model === "string"
    && typeof s.workspace === "string" && Number.isFinite(s.updated) && Number.isFinite(s.created) && typeof s.phase === "string"
    && !!s.settings && typeof s.settings === "object" && !!s.usage && typeof s.usage === "object";
}

export class Fleet {
  readonly id: string;
  readonly name: string;
  private relays = new Map<string, Relay>();
  private stopped = false;
  private pairing = new Map<string, Promise<void>>();
  private tunnels = new Map<string, Promise<Tunnel>>();
  private queues = new Map<string, Queue>();
  private links = new Map<string, DaemonLink>();
  private localFactsCache?: Facts;
  private localFactsAt?: number;
  private ssh = new Map<string, SshLink>();
  private sockDir: string;
  // What each ssh host said at its last reach (the offered list shows it).
  private reached = new Map<string, { state: string; reason?: string; facts?: Facts; route?: string; machine_id?: string; checked_ms: number }>();

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker) {
    migrate(store);
    this.id = meta(store, "daemon_id", () => `d${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`);
    this.name = process.env.KEEL_SERVER_NAME || meta(store, "server_name", () => hostname());
    // A unix socket path has room for about 100 bytes (ssh adds 17 to its control path while it starts).
    const dir = join(store.stateDir, "ssh");
    this.sockDir = dir.length < 60 ? dir : join(process.env.XDG_RUNTIME_DIR || "/run/user/" + process.getuid!(), `keel-ssh-${this.id}`);
  }

  // A machine reached over ssh with no daemon of its own: its tools go to the
  // helper the daemon puts there (src/fleet/sshlink.ts).
  isSsh(m: MachineRow) { return m.source === "ssh" && !m.daemon_port; }

  sshLink(m: MachineRow): SshLink {
    let l = this.ssh.get(m.id);
    if (!l) {
      const alias = m.ssh_host!;
      l = new SshLink(m.id, () => groupOf(alias)?.routes ?? [alias], this.sockDir, (msg) => console.error(`keel fleet: ${msg}`));
      this.ssh.set(m.id, l);
    }
    return l;
  }

  // One request to a machine's hands: over the paired link of its daemon, or to
  // the helper of an ssh machine. Throws LinkError when it cannot be reached.
  async hands(id: string, path: string, init: RequestInit & { timeout?: number; retryMs?: number; idempotent?: boolean } = {}): Promise<Response> {
    const m = this.row(id);
    if (!m) throw new LinkError("no such machine");
    if (this.isSsh(m)) return this.sshLink(m).fetch(path, init);
    return linkFetch(await this.peer(id), path, init);
  }

  // The same, read as JSON; an answer that is not ok is a LinkError with its words and its status.
  async handsJson<T = any>(id: string, path: string, init: RequestInit & { timeout?: number; idempotent?: boolean } = {}): Promise<T> {
    const r = await this.hands(id, path, init);
    const body = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw Object.assign(new LinkError(body.error ?? `HTTP ${r.status}`), { status: r.status });
    return body as T;
  }

  start() {
    // Heard again when the last daemon stopped, before it had stayed heard: the wait starts over.
    for (const m of this.rows()) if (m.offline_since && m.state !== "offline" && !this.settling.has(m.id)) this.settle(m.id, m.reason);
    for (const m of this.rows()) if (m.auto_connect) this.check(m.id).catch((e) => this.errors.capture("server", e, { at: "fleet auto_connect", machine: m.id }));
  }

  stop() {
    this.stopped = true;
    const relays = [...this.relays.values()];
    this.relays.clear(); // first: an aborted relay that is no longer listed does not reopen
    for (const r of relays) { r.abort.abort(); clearTimeout(r.timer); }
    for (const t of this.settling.values()) clearTimeout(t);
    this.settling.clear();
    for (const t of this.tunnels.values()) t.then((t) => t.proc.kill()).catch(() => {});
    this.tunnels.clear();
    for (const l of this.ssh.values()) l.close();
    this.ssh.clear();
  }

  // ---- records

  rows(): MachineRow[] {
    return this.store.db.query<MachineRow, []>("SELECT * FROM fleet_machines ORDER BY created").all();
  }
  row(id: string): MachineRow | undefined {
    return this.store.db.query<MachineRow, [string]>("SELECT * FROM fleet_machines WHERE id = ?").get(id) ?? undefined;
  }
  byName(name: string): MachineRow | undefined {
    const n = name.toLowerCase();
    return this.rows().find((m) => m.id === name || m.name.toLowerCase() === n || m.link_daemon_id === name);
  }
  private set(id: string, patch: Partial<MachineRow>) {
    // Out of reach, and back: since when is kept with the machine (across a
    // restart of this daemon). It is back once it has stayed heard a while
    // (steadyMs), not at the first word: until then the absence goes on, so a
    // machine that comes and goes is out of reach once, and said once each way.
    let told: (() => void) | undefined;
    if (patch.state !== undefined) {
      const was = this.row(id);
      if (was && patch.state === "offline") {
        clearTimeout(this.settling.get(id));
        this.settling.delete(id);
        if (!was.offline_since) {
          const since = patch.offline_since ?? Date.now();
          patch = { ...patch, offline_since: since };
          told = () => this.onReach?.(this.row(id) ?? was, { state: "offline", since });
        } else {
          // Out again before it had stayed heard: the same absence, told again as such when it had seemed over.
          const since = was.offline_since;
          patch = { ...patch, offline_since: since };
          if (was.state !== "offline") told = () => this.onReach?.(this.row(id) ?? was, { state: "offline", since });
        }
      } else if (was?.offline_since && ["ready", "busy", "starting"].includes(patch.state)) {
        delete patch.offline_since;
        if (!this.settling.has(id)) this.settle(id, was.reason);
      }
    }
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.store.db.query(`UPDATE fleet_machines SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(patch) as any[]), id);
    try { told?.(); } catch (e) { this.errors.capture("server", e, { at: "fleet reach", machine: id }); }
  }

  // A machine heard again: back once it has stayed heard. `why`: what kept it out, which its row no longer says.
  private settling = new Map<string, Timer>();
  private settle(id: string, why: string | null) {
    this.settling.set(id, setTimeout(() => {
      this.settling.delete(id);
      if (this.stopped) return;
      try {
        const m = this.row(id);
        if (!m?.offline_since || m.state === "offline") return;
        const since = m.offline_since;
        this.store.db.query("UPDATE fleet_machines SET offline_since = NULL WHERE id = ?").run(id);
        this.emitMachines();
        this.onReach?.({ ...m, offline_since: null, reason: why }, { state: "back", since });
      } catch (e) {
        this.errors.capture("server", e, { at: "fleet reach", machine: id });
      }
    }, steadyMs()));
  }

  // How long a machine is heard before it counts as back: its absence ended that long before the word.
  steadyFor() { return steadyMs(); }
  // A machine went out of reach (`since`: when it was last heard), or is back (`since`: from when it was out).
  onReach?: (m: MachineRow, change: { state: "offline" | "back"; since: number }) => void;

  add(m: { name: string; source: "daemon" | "ssh"; daemon_url?: string; ssh_host?: string; daemon_port?: number; workspace_root?: string }): MachineRow {
    const id = `m${Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex")}`;
    this.store.db
      .query("INSERT INTO fleet_machines (id, name, source, daemon_url, ssh_host, daemon_port, workspace_root, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, m.name, m.source, m.daemon_url ?? null, m.ssh_host ?? null, m.daemon_port ?? null, m.workspace_root ?? null, Date.now());
    return this.row(id)!;
  }

  update(id: string, patch: Partial<Pick<MachineRow, "name" | "auto_connect" | "colour" | "daemon_url" | "daemon_port" | "messages" | "max_jobs" | "workspace_root">>) {
    const m = this.row(id)!;
    const relink = ("daemon_url" in patch && patch.daemon_url !== m.daemon_url) || ("daemon_port" in patch && patch.daemon_port !== m.daemon_port);
    this.set(id, relink ? { ...patch, link_daemon_id: null, link_key: null } : patch);
    if (relink) this.unlink(id);
    return this.row(id)!;
  }

  async remove(id: string) {
    const m = this.row(id);
    if (m && this.isSsh(m)) await this.sshLink(m).stopHelpers().catch(() => {}); // unreachable: it ends by itself after a day
    this.unlink(id);
    this.setRules(this.rules().filter((r) => r.machine !== id)); // a rule for a machine that is gone sends nothing
    this.store.db.query("DELETE FROM fleet_machines WHERE id = ?").run(id);
    this.store.db.query("DELETE FROM fleet_listing WHERE machine_id = ?").run(id);
  }

  private unlink(id: string) {
    const r = this.relays.get(id);
    if (r) { r.abort.abort(); clearTimeout(r.timer); this.relays.delete(id); }
    clearTimeout(this.settling.get(id));
    this.settling.delete(id);
    const t = this.tunnels.get(id);
    if (t) { t.then((t) => t.proc.kill()).catch(() => {}); this.tunnels.delete(id); }
    this.links.delete(id);
    this.ssh.get(id)?.close();
    this.ssh.delete(id);
    this.emitMachines();
  }

  // Hosts of the ssh configuration not enabled yet, offered as `ssh:<alias>`.
  // One per box: aliases of one host are its routes, and a host that answered
  // with the machine id of an enabled one is that machine.
  offered(): string[] {
    return this.offeredGroups().map((g) => g.alias);
  }
  offeredGroups() {
    const enabled = new Set(this.rows().flatMap((m) => (m.ssh_host ? groupOf(m.ssh_host)?.routes ?? [m.ssh_host] : [])));
    const ids = new Set(this.rows().map((m) => this.facts(m.id) as (Facts & { machine_id?: string }) | undefined).map((f) => f?.machine_id).filter(Boolean));
    const seen = new Set<string>();
    return hostGroups().filter((g) => {
      if (g.routes.some((r) => enabled.has(r))) return false;
      const mid = this.reached.get(g.alias)?.machine_id;
      if (mid && (ids.has(mid) || seen.has(mid))) return false;
      if (mid) seen.add(mid);
      return true;
    });
  }
  offeredView() {
    return this.offeredGroups().map((g) => {
      const r = this.reached.get(g.alias);
      return { id: `ssh:${g.alias}`, name: g.alias, source: "ssh", enabled: false, state: r?.state ?? "unknown", reason: r?.reason, facts: r?.facts, checked_ms: r?.checked_ms, ssh_host: g.alias, routes: g.routes, route: r?.route, detail: r?.facts ? `${r.facts.os} ${r.facts.arch}, ${r.facts.cpus} cores` : undefined };
    });
  }

  // The public shape of a machine: never the link key.
  view(m: MachineRow) {
    const q = this.queues.get(m.id);
    const facts = m.facts ? (JSON.parse(m.facts) as Facts) : undefined;
    const link = this.links.get(m.id) ?? { state: m.link_key ? "offline" : "none", reason: m.link_key ? "not checked since the daemon started" : undefined };
    return {
      id: m.id, name: m.name, source: m.source, enabled: true, state: m.state, auto_connect: !!m.auto_connect, messages: m.messages,
      queue: { running: q?.running ?? 0, waiting: q?.waiting.length ?? 0, limit: this.limitOf(m) },
      reason: m.reason ?? undefined, checked_ms: m.checked_ms ?? undefined, offline_since_ms: m.offline_since ?? undefined, facts,
      daemon: { ...link, daemon_id: m.link_daemon_id ?? link.daemon_id },
      ssh_host: m.ssh_host ?? undefined, workspace_root: m.workspace_root ?? undefined, colour: m.colour ?? undefined,
      daemon_url: m.daemon_url ?? undefined, daemon_port: m.daemon_port ?? undefined, max_jobs: m.max_jobs ?? undefined,
      ...(this.isSsh(m) ? { transport: "ssh", routes: groupOf(m.ssh_host!)?.routes ?? [m.ssh_host!], route: this.ssh.get(m.id)?.route, helper: this.ssh.get(m.id)?.installed } : { transport: "daemon" }),
    };
  }

  async localView() {
    this.localFactsCache = await localFacts();
    this.localFactsAt = Date.now();
    return { id: "local", name: this.name, source: "local", enabled: true, state: "ready", auto_connect: true, messages: "allow", queue: { running: 0, waiting: 0 }, facts: this.localFactsCache, daemon: { state: "linked", daemon_id: this.id, server_name: this.name, version: VERSION } };
  }

  identity() {
    return { daemon_id: this.id, server_name: this.name, version: VERSION };
  }

  // The serving side of a link: a key made for the daemon that links to this
  // one (pairing again replaces it), and the lookup every linked request uses.
  pairWith(daemonId: string, name?: string): string {
    const key = newKey();
    this.store.db.query("INSERT OR REPLACE INTO fleet_pairs (daemon_id, name, key, created) VALUES (?, ?, ?, ?)").run(daemonId, name ?? null, key, Date.now());
    return key;
  }
  keyOf = (daemonId: string): string | undefined =>
    this.store.db.query<{ key: string }, [string]>("SELECT key FROM fleet_pairs WHERE daemon_id = ?").get(daemonId)?.key;
  pairs() {
    return this.store.db.query<{ daemon_id: string; name: string | null; created: number }, []>("SELECT daemon_id, name, created FROM fleet_pairs ORDER BY created").all();
  }
  unpair(daemonId: string) {
    this.store.db.query("DELETE FROM fleet_pairs WHERE daemon_id = ?").run(daemonId);
  }

  // ---- reaching a machine's daemon

  private async tunnel(m: MachineRow): Promise<Tunnel> {
    const have = this.tunnels.get(m.id);
    if (have) {
      const t = await have.catch(() => null);
      if (t && t.proc.exitCode === null) return t;
      this.tunnels.delete(m.id);
    }
    const p = this.openTunnel(m);
    this.tunnels.set(m.id, p);
    p.catch(() => this.tunnels.delete(m.id));
    return p;
  }

  // ssh -L from a free loopback port here to the daemon's loopback port there,
  // owned by this daemon: no agent, no shared master connection.
  private async openTunnel(m: MachineRow): Promise<Tunnel> {
    if (!m.ssh_host || !plainAlias(m.ssh_host) || !m.daemon_port) throw new LinkError("the machine has no ssh host and daemon port");
    const port = freePort();
    const proc = Bun.spawn(
      [sshProgram(), "-N", ...SSH_BASE, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:127.0.0.1:${m.daemon_port}`, m.ssh_host],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    openTunnels.add(proc);
    proc.exited.then(() => openTunnels.delete(proc));
    const deadline = Date.now() + CONNECT_MS + 5000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        const err = (await readText(proc.stderr)).trim().split("\n").pop();
        throw new LinkError(`ssh -L to ${m.ssh_host} ended: ${err || `exit ${proc.exitCode}`}`);
      }
      const uids = listenerUids(port);
      if (uids?.length) {
        if (uids.some((u) => u !== process.getuid!())) { proc.kill(); throw new LinkError(`another user listens on 127.0.0.1:${port}`); }
        return { proc, port };
      }
      await Bun.sleep(150);
    }
    proc.kill();
    throw new LinkError(`ssh -L to ${m.ssh_host} did not open within ${(CONNECT_MS + 5000) / 1000} s`);
  }

  private async baseUrl(m: MachineRow): Promise<string> {
    if (m.daemon_url) return m.daemon_url.replace(/\/$/, "");
    const t = await this.tunnel(m).catch((e) => {
      if (e instanceof LinkError) throw e;
      throw new LinkError(`cannot open ssh tunnel to ${m.ssh_host}: ${(e as Error).message}`);
    });
    return `http://127.0.0.1:${t.port}`;
  }

  // Before the first link, the port must belong to the owner's own user: here
  // for a daemon URL, over there for a port behind ssh.
  private async ownerListens(m: MachineRow, url: string): Promise<string | null> {
    if (m.daemon_url) {
      const u = loopbackUrl(url)!;
      const uids = listenerUids(Number(u.port || 80));
      if (uids === null) return null; // no /proc here: the loopback address is all there is to go on
      if (!uids.length) return `nothing listens on ${u.host}`;
      return uids.every((x) => x === process.getuid!()) ? null : `${u.host} is listened on by another user`;
    }
    const script = `p=${m.daemon_port}; hp=$(printf ':%04X' "$p"); for t in /proc/net/tcp /proc/net/tcp6; do [ -r "$t" ] && awk -v p="$hp" '$4=="0A" && substr($2, length($2)-4)==p {print "uid=" $8}' "$t"; done; command -v lsof >/dev/null 2>&1 && [ ! -r /proc/net/tcp ] && lsof -nP -iTCP:$p -sTCP:LISTEN -Fu 2>/dev/null | sed -n 's/^u/uid=/p'; echo "me=$(id -u)"`;
    const proc = Bun.spawn([sshProgram(), ...SSH_ONE_SHOT, m.ssh_host!, script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, code] = await Promise.all([readText(proc.stdout), proc.exited]);
    if (code !== 0) return `cannot read the listeners on ${m.ssh_host}`;
    const me = out.match(/me=(\d+)/)?.[1];
    const uids = [...out.matchAll(/uid=(\d+)/g)].map((x) => x[1]);
    if (!uids.length) return `nothing listens on port ${m.daemon_port} on ${m.ssh_host}`;
    return uids.every((u) => u === me) ? null : `port ${m.daemon_port} on ${m.ssh_host} is listened on by another user`;
  }

  // The paired peer of a machine, pairing at the first link. One pairing at a
  // time for a machine: a second one would replace, over there, the key the
  // first is about to keep here, and the link would answer 403 from then on.
  async peer(id: string): Promise<Peer> {
    let m = this.row(id);
    if (!m) throw new LinkError("no such machine");
    const url = await this.baseUrl(m);
    if (!m.link_key || !m.link_daemon_id) {
      let p = this.pairing.get(id);
      if (!p) {
        p = this.pair(m, url).finally(() => this.pairing.delete(id));
        this.pairing.set(id, p);
      }
      await p;
      m = this.row(id);
      if (!m?.link_key || !m.link_daemon_id) throw new LinkError("no such machine");
    }
    return { url, myId: this.id, key: m.link_key, daemonId: m.link_daemon_id };
  }

  private async pair(m: MachineRow, url: string) {
    if (this.row(m.id)?.link_key) return; // paired while this call waited for its address
    const name = m.name;
    const why = await this.ownerListens(m, url).catch((e) => {
      throw new LinkError(`cannot check the listener for ${name}: ${(e as Error).message}`);
    });
    if (why) throw new LinkError(why);
    const r = await fetch(`${url}/api/fleet/pair`, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "manual",
      body: JSON.stringify({ daemon_id: this.id, name: this.name }), signal: AbortSignal.timeout(CONNECT_MS),
    }).catch((e) => { throw new LinkError(`cannot reach ${url}: ${whyUnreached(e, CONNECT_MS)}`); });
    const b = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !b.key || !b.daemon_id) throw new LinkError(`pairing refused: ${b.error ?? `HTTP ${r.status}`}`);
    if (b.daemon_id === this.id) throw new LinkError("that is this daemon: a daemon is never linked to itself");
    this.set(m.id, { link_daemon_id: b.daemon_id, link_key: b.key });
  }

  // ---- checks

  // `owner`: the owner asked for this check. A relay waiting out a backoff is
  // then opened at once: they are looking, and a check that reached the
  // machine should not leave it offline for the rest of the wait. (A stream
  // cut again goes on backing off from where it was.)
  async check(id: string, opts: { owner?: boolean } = {}): Promise<MachineRow> {
    const m = this.row(id)!;
    if (this.isSsh(m)) return this.checkSshMachine(m);
    this.set(id, { state: m.state === "unknown" ? "starting" : m.state });
    this.links.set(id, { state: "connecting" });
    this.emitMachines();
    try {
      const p = await this.peer(id);
      const who = await linkJson<{ daemon_id: string; server_name: string; version: string }>(p, "/api/fleet/identity");
      const facts = await linkJson<Facts>(p, `/api/fleet/facts${m.workspace_root ? `?root=${encodeURIComponent(m.workspace_root)}` : ""}`);
      if (this.stopped) return m; // stopped while the machine answered: nothing is recorded
      const q = this.queues.get(id);
      const busy = (q?.waiting.length ?? 0) > 0 || facts.load1 >= facts.cpus;
      const measured = { checked_ms: Date.now(), facts: JSON.stringify({ ...facts, measured_ms: Date.now() }) };
      const waiting = this.heldRelay(id);
      if (waiting && opts.owner) waiting.cut = undefined;
      const held = opts.owner ? undefined : waiting;
      if (held) {
        // The machine answers, and its stream is still cut as it opens: the
        // loss stands, with its reason and the time of the next try.
        this.set(id, { state: "offline", reason: held.cut, ...measured });
        this.links.set(id, { state: "offline", reason: held.cut, retry_at_ms: held.retryAt, daemon_id: who.daemon_id, server_name: who.server_name, version: who.version });
      } else {
        this.set(id, { state: busy ? "busy" : "ready", reason: null, ...measured });
        this.links.set(id, { state: "linked", daemon_id: who.daemon_id, server_name: who.server_name, version: who.version });
        this.ensureRelay(id);
      }
    } catch (e) {
      if (this.stopped) return m; // its store may be closed by now
      const reason = (e as Error).message;
      this.set(id, { state: "offline", reason, checked_ms: Date.now() });
      this.links.set(id, { state: "offline", reason });
      if (!(e instanceof LinkError)) this.errors.capture("server", e, { at: "fleet check", machine: id });
      const r = this.relays.get(id);
      if (r) { clearTimeout(r.timer); r.retry = 0; r.cut = undefined; r.retryAt = undefined; }
    }
    this.emitMachines();
    return this.row(id)!;
  }

  // An enabled ssh machine: its facts over its master connection, on the
  // first route that answers. Nothing is installed by a check.
  private async checkSshMachine(m: MachineRow): Promise<MachineRow> {
    const id = m.id;
    this.set(id, { state: m.state === "unknown" ? "starting" : m.state });
    this.emitMachines();
    try {
      const l = this.sshLink(m);
      const p = await l.readFacts();
      const q = this.queues.get(id);
      const busy = (q?.waiting.length ?? 0) > 0 || p.load1 >= p.cpus;
      const { platform: _p, ...facts } = p;
      this.set(id, { state: busy ? "busy" : "ready", reason: null, checked_ms: Date.now(), facts: JSON.stringify({ ...facts, root: m.workspace_root ?? undefined, measured_ms: Date.now() }) });
      this.links.set(id, { state: "linked", server_name: l.route });
    } catch (e) {
      const reason = (e as Error).message;
      this.set(id, { state: "offline", reason, checked_ms: Date.now() });
      this.links.set(id, { state: "offline", reason });
      if (!(e instanceof LinkError)) this.errors.capture("server", e, { at: "fleet ssh check", machine: id });
    }
    this.emitMachines();
    return this.row(id)!;
  }

  // An ssh host not enabled: one connection per route in order, no master
  // kept, nothing installed; the facts when it answers.
  async checkSsh(alias: string) {
    const g = groupOf(alias);
    const errs: string[] = [];
    for (const route of g?.routes ?? [alias]) {
      if (!plainAlias(route)) continue;
      const p = Bun.spawn([sshProgram(), ...SSH_ONE_SHOT, route, loginCommand(PROBE_SCRIPT)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => p.kill(), 15_000);
      const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
      clearTimeout(timer);
      if (code === 0 && /^os=/m.test(out)) {
        const { platform: _p, ...facts } = parseProbe(out);
        this.reached.set(g?.alias ?? alias, { state: "ready", facts: { ...facts, measured_ms: Date.now() }, route, machine_id: facts.machine_id, checked_ms: Date.now() });
        return { ...this.offeredView().find((o) => o.name === (g?.alias ?? alias)), id: `ssh:${alias}`, state: "ready", route, facts };
      }
      errs.push(`${route}: ${(err.trim().split("\n").pop() || (code === null || p.killed ? "no answer within 15 s" : `ssh exited ${code}`)).slice(0, 200)}`);
    }
    const reason = errs.join("; ");
    this.reached.set(g?.alias ?? alias, { state: "offline", reason, checked_ms: Date.now() });
    return { id: `ssh:${alias}`, name: alias, source: "ssh", enabled: false, state: "offline", reason, routes: g?.routes };
  }

  facts(id: string): Facts | undefined {
    const m = this.row(id);
    return m?.facts ? JSON.parse(m.facts) : undefined;
  }

  // ---- relay: the far daemon's live frames, and the sessions it shows

  // A relay whose stream opened and was lost before it held, waiting out its
  // backoff. A check that reaches the machine meanwhile says nothing new about
  // the stream (the machine was reachable when it was cut): it does not open
  // the relay sooner. A snapshot of an offline machine starts such a check, so
  // without this a stream cut right after its snapshot was opened again as
  // soon as the check came back, every other time with no wait at all.
  private heldRelay(id: string): Relay | undefined {
    const r = this.relays.get(id);
    return r && !r.live && r.cut && r.retryAt && r.retryAt > Date.now() ? r : undefined;
  }

  private ensureRelay(id: string) {
    const r = this.relays.get(id);
    if (r?.live || this.heldRelay(id)) return;
    if (r) { clearTimeout(r.timer); r.abort.abort(); }
    this.openRelay(id, r);
  }

  private openRelay(id: string, prev?: Relay) {
    if (this.stopped) return; // a check that ended after a hot reload replaced this fleet opens nothing
    const relay: Relay = { abort: new AbortController(), sessions: prev?.sessions ?? new Map(), states: prev?.states ?? new Map(), statesRev: prev?.statesRev, live: false, stale: !!prev?.sessions.size, retry: prev?.retry ?? 0 };
    this.relays.set(id, relay);
    const tried = Date.now();
    let opened = 0;
    // When the stream last said anything: a stream that goes silent was last heard then, not when it is given up.
    let heard = 0;
    let silent = false;
    let unanswered = false;
    const lost = (reason: string) => {
      if (relay.abort.signal.aborted && this.relays.get(id) !== relay) return;
      relay.live = false;
      relay.stale = true;
      // A stream that opens and is lost at once (a reader the far daemon cuts
      // again and again) keeps backing off; one that held starts over.
      const held = opened && Date.now() - opened >= RELAY_STEADY_MS;
      if (held) relay.retry = 0;
      // Its own daemon ended it. A stream that went silent, or never opened, is the link's doing.
      relay.cut = opened && !held && !silent ? reason : undefined;
      this.set(id, { state: "offline", reason, ...(silent && heard ? { offline_since: heard } : {}) });
      // A stream cut as it opens backs off twice as long each time. A machine
      // that simply does not answer is asked again a tenth of the time it has
      // been out after the last try (a second at least): one that was out half
      // a minute is heard within about five seconds of its return (the time a
      // try made into the dead link takes to give up), one out for hours once a minute.
      const out = Date.now() - (this.row(id)?.offline_since ?? Date.now());
      const wait = relayWait({ cut: !!relay.cut, times: relay.retry, outMs: out, triedMs: Date.now() - tried });
      if (relay.cut) relay.retry++;
      relay.retryAt = Date.now() + wait;
      this.links.set(id, { ...this.links.get(id), state: "offline", reason, retry_at_ms: relay.retryAt });
      this.emitMachines();
      relay.timer = setTimeout(() => { if (this.relays.get(id) === relay && this.row(id)) this.openRelay(id, relay); }, wait);
    };
    (async () => {
      const p = await this.peer(id);
      // The stream itself has no end, but its start has a bound like any connection: a try made
      // into a dead link (a network that changed under it) would otherwise wait for good, and the
      // machine stayed out of reach long after its link was back.
      const starting = setTimeout(() => { unanswered = true; relay.abort.abort(); }, CONNECT_MS);
      const res = await linkFetch(p, "/api/fleet/stream", { signal: relay.abort.signal, timeout: 2 ** 31 - 1 }).finally(() => clearTimeout(starting));
      if (!res.ok || !res.body) throw new LinkError(`the stream answered HTTP ${res.status}`);
      relay.live = true;
      opened = Date.now();
      relay.retryAt = undefined;
      const dec = new TextDecoder();
      let buf = "";
      heard = Date.now();
      let watchdog: Timer | undefined;
      const give = () => { silent = true; relay.abort.abort(); };
      const arm = () => {
        const bound = relay.silence ?? RELAY_SILENCE_MS;
        const due = Date.now() + bound;
        // A watchdog this daemon ran late (it was busy) looks once more a moment later: what the stream sent may wait behind it.
        watchdog = setTimeout(() => {
          if (Date.now() - due <= RELAY_LATE_MS) return give();
          watchdog = setTimeout(() => { if (Date.now() - heard >= bound) give(); else arm(); }, RELAY_GRACE_MS);
        }, bound);
      };
      arm();
      for await (const value of chunks(res.body)) {
        heard = Date.now();
        clearTimeout(watchdog);
        arm();
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith(": stalled")) throw new LinkError("its daemon ended the stream: this one fell too far behind reading it");
          const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) this.onRelayFrame(id, relay, JSON.parse(data));
        }
      }
      clearTimeout(watchdog);
      throw new LinkError("the stream ended");
    })().catch((e) => {
      if (this.relays.get(id) !== relay) return;
      lost(unanswered ? `no answer within ${CONNECT_MS / 1000} s` : relay.abort.signal.aborted && !(e instanceof LinkError) ? "the stream went silent" : (e as Error).message);
    });
  }

  // Called when a linked daemon has messages waiting for this one (its outbox).
  onOutbox?: (machineId: string) => void;

  // The relay to a machine's daemon is open now.
  relayLive(id: string): boolean {
    return this.relays.get(id)?.live ?? false;
  }
  // Whether that machine's daemon lists the session (as of its last word, when it is out of reach).
  remoteHas(id: string, session: string): boolean {
    return this.relays.get(id)?.sessions.has(session) ?? false;
  }

  private onRelayFrame(id: string, relay: Relay, f: any) {
    if (f.t === "feature" && f.name === "fleet_outbox") { this.onOutbox?.(id); return; }
    if (f.t === "snapshot") {
      this.onOutbox?.(id);
      relay.sessions = new Map((Array.isArray(f.sessions) ? f.sessions : []).filter(soundSession).map((s: Session) => [s.id, s]));
      relay.stale = false;
      relay.silence = relaySilence(f.ping_ms);
      const link = this.links.get(id);
      this.links.set(id, { state: "linked", daemon_id: link?.daemon_id, server_name: link?.server_name, version: link?.version });
      // The stream proves the link, not spare capacity: a machine that was
      // offline is measured again before it counts as ready or busy.
      const m = this.row(id);
      if (m?.state === "offline") {
        this.set(id, { state: "starting", reason: null });
        this.check(id).catch((e) => this.errors.capture("server", e, { at: "fleet check", machine: id }));
      }
      this.emitMachines();
      this.bus.emit({ t: "feature", name: "fleet_sessions", data: { machine: id } });
      return;
    }
    if (f.t === "states") {
      relay.states = new Map(Object.entries((f.states ?? {}) as Record<string, SessionState>));
      relay.statesRev = typeof f.rev === "number" ? f.rev : undefined;
    }
    if (f.t === "session") {
      // A session that is not whole (an id alone, as a daemon that is not this build may send) is no
      // row a page can draw: only its going is taken from such a frame.
      const id = f.session?.id;
      if (typeof id !== "string" || !SESSION_ID.test(id)) return;
      if (f.deleted || f.session.archived) relay.sessions.delete(id);
      else if (soundSession(f.session)) relay.sessions.set(id, f.session);
      else return;
    }
    if (f.t === "feature" && f.name === "state" && f.session_id) {
      if (f.data) relay.states.set(f.session_id, f.data as SessionState); else relay.states.delete(f.session_id);
      if (typeof f.rev === "number") relay.statesRev = Math.max(relay.statesRev ?? 0, f.rev);
    }
    if (f.t === "questions") relay.questions = f;
    this.bus.emit({ t: "feature", name: "fleet_frame", data: { machine: id, frame: f as Frame } });
  }

  remoteSessions(id: string): { sessions: Session[]; states?: Record<string, SessionState>; states_rev?: number; questions?: Questions; stale: boolean; retry_at_ms?: number } {
    const row = this.row(id);
    if (row && this.isSsh(row)) return { sessions: [], stale: false }; // its sessions are this daemon's
    const r = this.relays.get(id);
    if (!r) {
      const m = this.row(id);
      if (m?.link_key) this.ensureRelay(id); // nobody opened it yet: in the background
      return { sessions: [], stale: true };
    }
    return { sessions: [...r.sessions.values()].sort((a, b) => b.updated - a.updated), states: Object.fromEntries(r.states), states_rev: r.statesRev, questions: r.questions, stale: r.stale || !r.live, retry_at_ms: r.retryAt };
  }

  emitMachines() {
    this.bus.emit({ t: "feature", name: "fleet_machines", data: {} });
  }

  // ---- placement rules (kept in order, as the owner wrote them)

  rules(): Rule[] {
    const r = this.store.db.query<{ value: string }, [string]>("SELECT value FROM fleet_meta WHERE key = ?").get("placement");
    return r ? JSON.parse(r.value) : [];
  }
  setRules(rules: Rule[]) {
    this.store.db.query("INSERT OR REPLACE INTO fleet_meta (key, value) VALUES ('placement', ?)").run(JSON.stringify(rules));
  }
  async placeWork(want: Want): Promise<Place | string> {
    // The age of a reading is from when it was taken, not from when it was last used.
    const fresh = this.localFactsCache && Date.now() - (this.localFactsAt ?? 0) < FACTS_FRESH_MS;
    const lf = fresh ? this.localFactsCache! : await localFacts();
    if (!fresh) { this.localFactsCache = lf; this.localFactsAt = Date.now(); }
    return place(want, this.rules(), {
      local: { id: "local", name: this.name, state: "ready" },
      localBusy: lf.load1 >= lf.cpus,
      machine: (id) => { const m = this.row(id) ?? this.byName(id); return m ? { id: m.id, name: m.name, state: m.state } : undefined; },
    });
  }

  // ---- which machine ran a call (the transcript labels the tool row)

  step(sessionId: string, callId: string | undefined, machine: string) {
    if (!callId) return;
    this.store.db.query("INSERT OR REPLACE INTO fleet_steps (session_id, call_id, machine) VALUES (?, ?, ?)").run(sessionId, callId, machine);
    this.bus.emit({ t: "feature", name: "fleet_step", session_id: sessionId, data: { call_id: callId, machine, name: this.row(machine)?.name ?? machine } });
  }

  steps(sessionId: string): Record<string, { machine: string; name: string }> {
    const names = new Map(this.rows().map((m) => [m.id, m.name]));
    const rows = this.store.db.query<{ call_id: string; machine: string }, [string]>("SELECT call_id, machine FROM fleet_steps WHERE session_id = ?").all(sessionId);
    return Object.fromEntries(rows.map((r) => [r.call_id, { machine: r.machine, name: names.get(r.machine) ?? r.machine }]));
  }

  // ---- the job queue of a machine (commands of keel__run_on)

  limitOf(m: MachineRow): number | undefined {
    if (m.max_jobs) return m.max_jobs;
    const f = m.facts ? (JSON.parse(m.facts) as Facts) : undefined;
    return f ? freeCores(f) : undefined;
  }

  async acquire(id: string, signal: AbortSignal): Promise<() => void> {
    let m = this.row(id)!;
    if (!m.max_jobs && (!m.checked_ms || Date.now() - m.checked_ms > FACTS_FRESH_MS)) m = await this.check(id);
    const q = this.queues.get(id) ?? { running: 0, waiting: [] };
    this.queues.set(id, q);
    const limit = this.limitOf(m) ?? 1;
    if (q.running >= limit) {
      await new Promise<void>((resolve, reject) => {
        const w = { resolve, reject };
        q.waiting.push(w);
        this.emitMachines();
        signal.addEventListener("abort", () => {
          const i = q.waiting.indexOf(w);
          if (i >= 0) { q.waiting.splice(i, 1); reject(new Error("cancelled while waiting for a slot")); this.emitMachines(); }
        }, { once: true });
      });
    }
    q.running++;
    this.emitMachines();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      q.running--;
      const next = q.waiting.shift();
      if (next) next.resolve();
      this.emitMachines();
    };
  }
}
