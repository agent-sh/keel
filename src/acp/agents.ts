// The ACP agents keel-bun can drive, listed as the models of the "acp"
// provider: every agent of the ACP registry (cdn.agentclientprotocol.com)
// whose program is installed here, plus the owner's own entries in
// <config>/acp-agents.json (Zed's custom agents: command, args, env). Nothing
// is hard-coded: a registry agent counts when its binary is on PATH; one the
// registry ships through npx or uvx is offered to add (it downloads on first run).
import { configRefused } from "../core/named-config.ts";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../providers/config.ts";
import { writeOwnFile } from "../core/ownfile.ts";
import { choicesOf, listedOf, type Learned } from "./choices.ts";
import { readFolders } from "./confine.ts";
import { AcpConnection } from "./rpc.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderResult } from "../providers/types.ts";

export const REGISTRY_URL = () => process.env.KEEL_ACP_REGISTRY ?? "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
export const agentsPath = () => process.env.KEEL_ACP_AGENTS ?? join(configDir(), "acp-agents.json");

export type AgentCommand = { command: string; args: string[]; env?: Record<string, string> };
export type CustomAgent = AgentCommand & { name?: string };
// One agent as the picker and the runner see it.
export type AcpAgent = {
  id: string;            // the model name under the acp provider
  name: string;
  description?: string;
  version?: string;
  source: "registry" | "custom";
  run?: AgentCommand;    // how to start it here; absent: not installed
  add?: AgentCommand;    // a registry agent offered through npx or uvx
  website?: string;
  folders?: string[];    // the owner's writable folders for it (confine.ts); absent: the guess
};

type Registry = { version?: string; agents: any[] };

const PLATFORM = `${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

// Pure: the registry joined with what is on PATH and the owner's entries.
export function joinAgents(reg: Registry | null, custom: Record<string, CustomAgent>, which: (bin: string) => string | null): AcpAgent[] {
  const out: AcpAgent[] = [];
  for (const a of reg?.agents ?? []) {
    if (!a?.id || typeof a.id !== "string") continue;
    const d = a.distribution ?? {};
    const bin = d.binary?.[PLATFORM];
    const local = bin?.cmd ? which(basename(String(bin.cmd))) : null;
    let run: AgentCommand | undefined = local ? { command: local, args: (bin.args ?? []).map(String) } : undefined;
    // Two registry entries for one installed program (a v1 and a v2 entry) are one agent here: the first.
    if (run && out.some((o) => o.run && o.run.command === run!.command && o.run.args.join("\0") === run!.args.join("\0"))) run = undefined;
    const add = d.npx?.package && which("npx")
      ? { command: "npx", args: ["-y", String(d.npx.package), ...(d.npx.args ?? []).map(String)] }
      : d.uvx?.package && which("uvx") ? { command: "uvx", args: [String(d.uvx.package), ...(d.uvx.args ?? []).map(String)] } : undefined;
    out.push({ id: a.id, name: String(a.name ?? a.id), description: a.description, version: a.version, website: a.website ?? a.repository, source: "registry", run, add });
  }
  for (const [id, c] of Object.entries(custom)) {
    if (!c?.command) continue;
    const i = out.findIndex((x) => x.id === id);
    const agent: AcpAgent = { id, name: c.name ?? out[i]?.name ?? id, description: out[i]?.description, source: "custom", run: { command: c.command, args: c.args ?? [], env: c.env } };
    if (i >= 0) out[i] = agent; else out.push(agent);
  }
  return out;
}

export function readCustom(path = agentsPath()): Record<string, CustomAgent> {
  // (A file a variable puts inside a folder a session works in is not loaded: src/core/named-config.ts.)
  if (configRefused("KEEL_ACP_AGENTS", path)) return {};
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const agents = raw.agents ?? raw.agent_servers ?? {};
  const out: Record<string, CustomAgent> = {};
  for (const [id, c] of Object.entries<any>(agents)) {
    if (!c || typeof c.command !== "string") continue;
    out[id] = { command: c.command, args: Array.isArray(c.args) ? c.args.map(String) : [], env: c.env && typeof c.env === "object" ? c.env : undefined, name: typeof c.name === "string" ? c.name : undefined };
  }
  return out;
}

export function writeCustom(agents: Record<string, CustomAgent>, path = agentsPath()) {
  writeOwnFile(path, JSON.stringify({ agents }, null, 2) + "\n");
}

// How long a probe of an agent's choices is given: its start, initialize and
// session/new. An agent run through npx or uvx downloads its package on its
// first start, which takes a minute or more on a slow link; past this the
// probe is a failure, kept until the agent's program changes.
const PROBE_MS = 180_000;

// Which program an agent is now: its command, arguments and the command's
// file time (an upgrade in place changes it). What it stated is kept under this.
export function programKey(run: AgentCommand): string {
  const path = run.command.includes("/") ? run.command : Bun.which(run.command);
  let mtime = 0;
  try { if (path) mtime = statSync(path).mtimeMs; } catch {}
  return JSON.stringify([run.command, run.args, mtime]);
}

export class AcpAgents {
  private reg: Registry | null = null;
  private fetched = 0;
  private known: Record<string, Learned> = {};
  private queue: AcpAgent[] = [];
  private probing = false;
  error?: string;
  // Told when an agent's choices changed (the route lists the provider again).
  onLearned?: () => void;
  // How a probe's agent runs in `cwd`: its argv (the route confines it as a new session's would be).
  argvOf: (a: AcpAgent, cwd: string) => string[] = (a) => [a.run!.command, ...a.run!.args];

  constructor(private stateDir: string) {
    try { this.reg = JSON.parse(readFileSync(this.cacheFile, "utf8")); } catch {}
    try { this.known = JSON.parse(readFileSync(this.choicesFile, "utf8")); } catch {}
  }

  private get cacheFile() { return join(this.stateDir, "acp-registry.json"); }
  private get choicesFile() { return join(this.stateDir, "acp-choices.json"); }

  // What an agent stated in its last session setup, if anything was learned.
  learned(id: string): Learned | undefined {
    return this.known[id];
  }

  // A session setup result of an agent (a session it opened, or a probe): its choices, kept.
  learn(a: AcpAgent, result: unknown) {
    this.keep(a.id, { ...choicesOf(result), key: programKey(a.run!), at: Date.now() });
  }

  private keep(id: string, l: Learned) {
    const was = this.known[id];
    this.known[id] = l;
    try { writeFileSync(this.choicesFile, JSON.stringify(this.known)); } catch (e) { this.error = `saving ${this.choicesFile}: ${(e as Error).message}`; }
    const same = (x?: Learned) => JSON.stringify(x ? { ...x, at: 0 } : null);
    if (same(was) !== same(l)) this.onLearned?.();
  }

  // Agents whose choices are not known for the program they are now: asked in
  // the background, one at a time (nothing waits for them, and each is a
  // process of its own).
  ask(agents: AcpAgent[]) {
    for (const a of agents) if (a.run && this.known[a.id]?.key !== programKey(a.run) && !this.queue.some((q) => q.id === a.id)) this.queue.push(a);
    if (!this.probing) void this.drain();
  }

  private async drain() {
    this.probing = true;
    try {
      for (let a = this.queue.shift(); a; a = this.queue.shift()) await this.probe(a);
    } finally {
      this.probing = false;
    }
  }

  // One agent started to read what it offers: initialize, session/new in a
  // folder of Keel's own, then the session closed (and deleted where the agent
  // can) and the process ended. Its choices, or why there are none, are kept.
  private async probe(a: AcpAgent) {
    const cwd = join(this.stateDir, "acp-probe");
    mkdirSync(cwd, { recursive: true });
    let conn: AcpConnection | undefined;
    const key = programKey(a.run!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      conn = new AcpConnection(this.argvOf(a, cwd), { cwd, env: a.run!.env });
      const c = conn;
      const work = (async () => {
        const init = await c.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "keel", title: "Keel", version: "0.1.0" } });
        const caps = init?.agentCapabilities ?? {};
        const r = await c.request("session/new", { cwd, mcpServers: [] });
        const id = r?.sessionId;
        if (id && caps.sessionCapabilities?.close) await c.request("session/close", { sessionId: id }).catch(() => {});
        if (id && caps.sessionCapabilities?.delete) await c.request("session/delete", { sessionId: id }).catch(() => {});
        return r;
      })();
      const r = await Promise.race([work, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`no answer in ${PROBE_MS / 1000} s`)), PROBE_MS); })]);
      this.keep(a.id, { ...choicesOf(r), key, at: Date.now() });
    } catch (e) {
      const code = (e as any)?.code;
      this.keep(a.id, { key, at: Date.now(), error: code === -32000 ? "it needs its own sign-in first" : (e as Error).message });
    } finally {
      clearTimeout(timer);
      conn?.close();
    }
  }

  // The registry asked again on each listing refresh; its last good copy is kept.
  async refresh(): Promise<void> {
    try {
      const url = REGISTRY_URL();
      const res = url.startsWith("/") ? new Response(Bun.file(url)) : await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reg = (await res.json()) as Registry;
      if (!Array.isArray(reg.agents)) throw new Error("no agents list");
      this.reg = reg;
      this.fetched = Date.now();
      this.error = undefined;
      writeFileSync(this.cacheFile, JSON.stringify(reg));
    } catch (e) {
      this.error = `the ACP registry: ${(e as Error).message}`;
    }
  }

  list(): AcpAgent[] {
    let custom: Record<string, CustomAgent> = {};
    try { custom = readCustom(); } catch (e) { this.error = `${agentsPath()}: ${(e as Error).message}`; }
    let folders: Record<string, string[]> = {};
    try { folders = readFolders(); } catch (e) { this.error = `${(e as Error).message}`; }
    return joinAgents(this.reg, custom, (b) => Bun.which(b)).map((a) => (folders[a.id] ? { ...a, folders: folders[a.id] } : a));
  }

  get(id: string): AcpAgent | undefined {
    return this.list().find((a) => a.id === id);
  }

  get registryFetched() { return this.fetched; }
}

// The "acp" provider: the installed agents as models. A turn of such a session
// is run by the ACP runner (src/acp/external.ts), never by this stream.
export class AcpProvider implements Provider {
  readonly id = "acp";
  readonly label = "ACP agents";
  readonly family = "other" as const;
  readonly agents: AcpAgents;

  constructor(stateDir: string) {
    this.agents = new AcpAgents(stateDir);
  }

  available() {
    return true;
  }

  // Each installed agent, and each model (else mode) it stated it offers
  // (choices.ts); one whose choices are not known yet is asked in the background.
  async list(): Promise<ListedModel[]> {
    await this.agents.refresh();
    const installed = this.agents.list().filter((a) => a.run);
    this.agents.ask(installed);
    return installed.flatMap((a) => listedOf(a, this.agents.learned(a.id)));
  }

  async stream(_req: ProviderRequest, _onDelta: (d: Delta) => void): Promise<ProviderResult> {
    throw Object.assign(new Error("an ACP agent answers only the turns of its own session (no side questions or summaries)"), { expected: true });
  }
}
