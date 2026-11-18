// The fleet: this daemon's identity, the machines it knows, their links and
// checks, the relay of each linked daemon's live frames, and each machine's job
// queue. One owner, several machines, one view.
import { hostname } from "node:os";
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import type { Store } from "../core/store.ts";
import type { Frame, Session } from "../core/types.ts";
import { type Facts, type MachineRow, meta, migrate } from "./db.ts";
import { freeCores, localFacts, VERSION } from "./facts.ts";
import { CONNECT_MS, freePort, LinkError, linkFetch, linkJson, listenerUids, loopbackUrl, newKey, type Peer } from "./link.ts";
import { plainAlias, SSH_BASE, SSH_ONE_SHOT, sshHosts, sshProgram, sshReach } from "./sshconfig.ts";

export type DaemonLink = { state: "linked" | "offline" | "connecting" | "none"; reason?: string; daemon_id?: string; server_name?: string; version?: string; retry_at_ms?: number };

type Relay = { abort: AbortController; sessions: Map<string, Session>; live: boolean; stale: boolean; retry: number; retryAt?: number; timer?: Timer };
type Tunnel = { proc: Bun.Subprocess; port: number };
type Queue = { running: number; waiting: { resolve: () => void; reject: (e: Error) => void }[] };

const RELAY_MAX_BACKOFF = 60_000; // a lost relay is reopened after 1, 2, 4 s ... up to a minute
const RELAY_SILENCE_MS = 45_000; // the far daemon pings every 15 s: three missed pings and the stream is dead
const FACTS_FRESH_MS = 60_000; // load1 averages a minute: a queue limit older than that is read again

export class Fleet {
  readonly id: string;
  readonly name: string;
  private relays = new Map<string, Relay>();
  private tunnels = new Map<string, Promise<Tunnel>>();
  private queues = new Map<string, Queue>();
  private links = new Map<string, DaemonLink>();
  private localFactsCache?: Facts;

  constructor(private store: Store, private bus: Bus, private errors: ErrorTracker) {
    migrate(store);
    this.id = meta(store, "daemon_id", () => `d${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`);
    this.name = process.env.KEEL_SERVER_NAME || meta(store, "server_name", () => hostname());
  }

  start() {
    for (const m of this.rows()) if (m.auto_connect) this.check(m.id).catch((e) => this.errors.capture("server", e, { at: "fleet auto_connect", machine: m.id }));
  }

  stop() {
    for (const r of this.relays.values()) { r.abort.abort(); clearTimeout(r.timer); }
    for (const t of this.tunnels.values()) t.then((t) => t.proc.kill()).catch(() => {});
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
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.store.db.query(`UPDATE fleet_machines SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(Object.values(patch) as any[]), id);
  }

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

  remove(id: string) {
    this.unlink(id);
    this.store.db.query("DELETE FROM fleet_machines WHERE id = ?").run(id);
  }

  private unlink(id: string) {
    const r = this.relays.get(id);
    if (r) { r.abort.abort(); clearTimeout(r.timer); this.relays.delete(id); }
    const t = this.tunnels.get(id);
    if (t) { t.then((t) => t.proc.kill()).catch(() => {}); this.tunnels.delete(id); }
    this.links.delete(id);
    this.emitMachines();
  }

  // Hosts of the ssh configuration not enabled yet, offered as `ssh:<alias>`.
  offered(): string[] {
    const enabled = new Set(this.rows().map((m) => m.ssh_host).filter(Boolean));
    return sshHosts().filter((h) => !enabled.has(h));
  }

  // The public shape of a machine: never the link key.
  view(m: MachineRow) {
    const q = this.queues.get(m.id);
    const facts = m.facts ? (JSON.parse(m.facts) as Facts) : undefined;
    const link = this.links.get(m.id) ?? { state: m.link_key ? "offline" : "none", reason: m.link_key ? "not checked since the daemon started" : undefined };
    return {
      id: m.id, name: m.name, source: m.source, enabled: true, state: m.state, auto_connect: !!m.auto_connect, messages: m.messages,
      queue: { running: q?.running ?? 0, waiting: q?.waiting.length ?? 0, limit: this.limitOf(m) },
      reason: m.reason ?? undefined, checked_ms: m.checked_ms ?? undefined, facts,
      daemon: { ...link, daemon_id: m.link_daemon_id ?? link.daemon_id },
      ssh_host: m.ssh_host ?? undefined, workspace_root: m.workspace_root ?? undefined, colour: m.colour ?? undefined,
      daemon_url: m.daemon_url ?? undefined, daemon_port: m.daemon_port ?? undefined, max_jobs: m.max_jobs ?? undefined,
    };
  }

  async localView() {
    this.localFactsCache = await localFacts();
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
    const deadline = Date.now() + CONNECT_MS + 5000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        const err = (await new Response(proc.stderr).text()).trim().split("\n").pop();
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
    return `http://127.0.0.1:${(await this.tunnel(m)).port}`;
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
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return `cannot read the listeners on ${m.ssh_host}`;
    const me = out.match(/me=(\d+)/)?.[1];
    const uids = [...out.matchAll(/uid=(\d+)/g)].map((x) => x[1]);
    if (!uids.length) return `nothing listens on port ${m.daemon_port} on ${m.ssh_host}`;
    return uids.every((u) => u === me) ? null : `port ${m.daemon_port} on ${m.ssh_host} is listened on by another user`;
  }

  // The paired peer of a machine, pairing at the first link.
  async peer(id: string): Promise<Peer> {
    let m = this.row(id);
    if (!m) throw new LinkError("no such machine");
    const url = await this.baseUrl(m);
    if (!m.link_key || !m.link_daemon_id) {
      const why = await this.ownerListens(m, url);
      if (why) throw new LinkError(why);
      const r = await fetch(`${url}/api/fleet/pair`, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "manual",
        body: JSON.stringify({ daemon_id: this.id, name: this.name }), signal: AbortSignal.timeout(CONNECT_MS),
      }).catch((e) => { throw new LinkError(`cannot reach ${url}: ${(e as Error).message}`); });
      const b = (await r.json().catch(() => ({}))) as any;
      if (!r.ok || !b.key || !b.daemon_id) throw new LinkError(`pairing refused: ${b.error ?? `HTTP ${r.status}`}`);
      if (b.daemon_id === this.id) throw new LinkError("that is this daemon: a daemon is never linked to itself");
      this.set(id, { link_daemon_id: b.daemon_id, link_key: b.key });
      m = this.row(id)!;
    }
    return { url, myId: this.id, key: m.link_key!, daemonId: m.link_daemon_id! };
  }

  // ---- checks

  async check(id: string): Promise<MachineRow> {
    const m = this.row(id)!;
    this.set(id, { state: m.state === "unknown" ? "starting" : m.state });
    this.links.set(id, { state: "connecting" });
    this.emitMachines();
    try {
      const p = await this.peer(id);
      const who = await linkJson<{ daemon_id: string; server_name: string; version: string }>(p, "/api/fleet/identity");
      const facts = await linkJson<Facts>(p, `/api/fleet/facts${m.workspace_root ? `?root=${encodeURIComponent(m.workspace_root)}` : ""}`);
      const q = this.queues.get(id);
      const busy = (q?.waiting.length ?? 0) > 0 || facts.load1 >= facts.cpus;
      this.set(id, { state: busy ? "busy" : "ready", reason: null, checked_ms: Date.now(), facts: JSON.stringify(facts) });
      this.links.set(id, { state: "linked", daemon_id: who.daemon_id, server_name: who.server_name, version: who.version });
      this.ensureRelay(id);
    } catch (e) {
      const reason = (e as Error).message;
      this.set(id, { state: "offline", reason, checked_ms: Date.now() });
      this.links.set(id, { state: "offline", reason });
      if (!(e instanceof LinkError)) this.errors.capture("server", e, { at: "fleet check", machine: id });
      const r = this.relays.get(id);
      if (r) { clearTimeout(r.timer); r.retry = 0; }
    }
    this.emitMachines();
    return this.row(id)!;
  }

  async checkSsh(alias: string) {
    const r = await sshReach(alias);
    return r.ok ? { id: `ssh:${alias}`, name: alias, source: "ssh", enabled: false, state: "ready", detail: r.detail } : { id: `ssh:${alias}`, name: alias, source: "ssh", enabled: false, state: "offline", reason: r.reason };
  }

  facts(id: string): Facts | undefined {
    const m = this.row(id);
    return m?.facts ? JSON.parse(m.facts) : undefined;
  }

  // ---- relay: the far daemon's live frames, and the sessions it shows

  private ensureRelay(id: string) {
    const r = this.relays.get(id);
    if (r?.live) return;
    if (r) { clearTimeout(r.timer); r.abort.abort(); }
    this.openRelay(id, r);
  }

  private openRelay(id: string, prev?: Relay) {
    const relay: Relay = { abort: new AbortController(), sessions: prev?.sessions ?? new Map(), live: false, stale: !!prev?.sessions.size, retry: prev?.retry ?? 0 };
    this.relays.set(id, relay);
    const lost = (reason: string) => {
      if (relay.abort.signal.aborted && this.relays.get(id) !== relay) return;
      relay.live = false;
      relay.stale = true;
      const wait = Math.min(1000 * 2 ** relay.retry++, RELAY_MAX_BACKOFF);
      relay.retryAt = Date.now() + wait;
      this.links.set(id, { ...this.links.get(id), state: "offline", reason, retry_at_ms: relay.retryAt });
      this.set(id, { state: "offline", reason });
      this.emitMachines();
      relay.timer = setTimeout(() => { if (this.relays.get(id) === relay && this.row(id)) this.openRelay(id, relay); }, wait);
    };
    (async () => {
      const p = await this.peer(id);
      const res = await linkFetch(p, "/api/fleet/stream", { signal: relay.abort.signal, timeout: 2 ** 31 - 1 });
      if (!res.ok || !res.body) throw new LinkError(`the stream answered HTTP ${res.status}`);
      relay.live = true;
      relay.retry = 0;
      relay.retryAt = undefined;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let watchdog = setTimeout(() => relay.abort.abort(), RELAY_SILENCE_MS);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => relay.abort.abort(), RELAY_SILENCE_MS);
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) this.onRelayFrame(id, relay, JSON.parse(data));
        }
      }
      clearTimeout(watchdog);
      throw new LinkError("the stream ended");
    })().catch((e) => {
      if (this.relays.get(id) !== relay) return;
      lost(relay.abort.signal.aborted && !(e instanceof LinkError) ? "the stream went silent" : (e as Error).message);
    });
  }

  private onRelayFrame(id: string, relay: Relay, f: any) {
    if (f.t === "snapshot") {
      relay.sessions = new Map((f.sessions as Session[]).map((s) => [s.id, s]));
      relay.stale = false;
      const link = this.links.get(id);
      this.links.set(id, { state: "linked", daemon_id: link?.daemon_id, server_name: link?.server_name, version: link?.version });
      const m = this.row(id);
      if (m?.state === "offline") this.set(id, { state: "ready", reason: null });
      this.emitMachines();
      this.bus.emit({ t: "feature", name: "fleet_sessions", data: { machine: id } });
      return;
    }
    if (f.t === "session") {
      if (f.session.archived) relay.sessions.delete(f.session.id);
      else relay.sessions.set(f.session.id, f.session);
    }
    this.bus.emit({ t: "feature", name: "fleet_frame", data: { machine: id, frame: f as Frame } });
  }

  remoteSessions(id: string): { sessions: Session[]; stale: boolean; retry_at_ms?: number } {
    const r = this.relays.get(id);
    if (!r) {
      const m = this.row(id);
      if (m?.link_key) this.ensureRelay(id); // nobody opened it yet: in the background
      return { sessions: [], stale: true };
    }
    return { sessions: [...r.sessions.values()].sort((a, b) => b.updated - a.updated), stale: r.stale || !r.live, retry_at_ms: r.retryAt };
  }

  emitMachines() {
    this.bus.emit({ t: "feature", name: "fleet_machines", data: {} });
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
