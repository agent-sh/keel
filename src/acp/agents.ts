// The ACP agents keel-bun can drive, listed as the models of the "acp"
// provider: every agent of the ACP registry (cdn.agentclientprotocol.com)
// whose program is installed here, plus the owner's own entries in
// <config>/acp-agents.json (Zed's custom agents: command, args, env). Nothing
// is hard-coded: a registry agent counts when its binary is on PATH; one the
// registry ships through npx or uvx is offered to add (it downloads on first run).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { configDir } from "../providers/config.ts";
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ agents }, null, 2) + "\n");
  renameSync(tmp, path);
}

export class AcpAgents {
  private reg: Registry | null = null;
  private fetched = 0;
  error?: string;

  constructor(private stateDir: string) {
    try { this.reg = JSON.parse(readFileSync(this.cacheFile, "utf8")); } catch {}
  }

  private get cacheFile() { return join(this.stateDir, "acp-registry.json"); }

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
    return joinAgents(this.reg, custom, (b) => Bun.which(b));
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

  async list(): Promise<ListedModel[]> {
    await this.agents.refresh();
    return this.agents.list().filter((a) => a.run).map((a) => ({ model: a.id, name: a.name, billing: { kind: "subscription", plan: a.name }, images: true }));
  }

  async stream(_req: ProviderRequest, _onDelta: (d: Delta) => void): Promise<ProviderResult> {
    throw Object.assign(new Error("an ACP agent answers only the turns of its own session (no side questions or summaries)"), { expected: true });
  }
}
