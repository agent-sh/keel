// The Chrome bridge (agent-chrome-bridge) as a server Keel brings itself.
//
// The bridge is an MCP stdio server (`node bin/mcp-server.js`) that drives the
// owner's own Chrome through its extension. Every session is offered it with no
// config entry: its tool list ships with Keel (chrome_bridge_tools.json, made
// by scripts/chrome-bridge-manifest.ts from the bridge's own registry), so a
// search finds its tools without starting anything, and the process starts at
// the first call. Like every MCP tool it is deferred: the request's tool list
// never changes.
//
// Two things are Keel's, not the server's claims:
// - which tools only read: the bridge's set of tools that act ships with the
//   list; a tool the list does not know (a newer bridge) counts as one that acts,
//   so it goes to the permission gate.
// - which session drives which tab: an acting call names a tab (or is given the
//   active one, looked up first), and a tab one session acts on is refused to
//   every other session until the first closes it.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { McpManager } from "../mcp/manager.ts";
import type { McpTool } from "../mcp/client.ts";
import type { ToolOutput } from "../tools/types.ts";
import shipped from "./chrome_bridge_tools.json" with { type: "json" };
import { ownerHome } from "../core/paths";

export const CHROME_SERVER = "chrome";

export type ChromeBridge = { node: string; entry: string };

const isFile = (p: string) => {
  try { return statSync(p).isFile(); } catch { return false; }
};

const entryIn = (dir: string) => [join(dir, "bin/mcp-server.js"), join(dir, "mcp-server.js")].find(isFile);

function which(program: string, env: (k: string) => string | undefined) {
  for (const dir of (env("PATH") ?? "").split(delimiter)) if (dir && isFile(join(dir, program))) return join(dir, program);
}

// Where the bridge is, in order: KEEL_CHROME_BRIDGE (its bin/mcp-server.js or
// folder); the copy its `setup` installs; the folder of the native messaging
// host registered for Chrome, Chromium or Brave; `agent-chrome-bridge` on PATH.
// Node: KEEL_CHROME_BRIDGE_NODE, else node on PATH, else the newest nvm node.
export function discoverChromeBridge(home: string, env: (k: string) => string | undefined): ChromeBridge | { error: string } {
  const set = (k: string) => env(k)?.trim() || undefined;
  const entry = (() => {
    const given = set("KEEL_CHROME_BRIDGE");
    if (given) return isFile(given) ? given : entryIn(given);
    const data = set("XDG_DATA_HOME") ?? join(home, ".local/share");
    for (const root of [set("AGENT_CHROME_BRIDGE_HOME"), join(data, "agent-chrome-bridge"), join(home, ".local/share/agent-chrome-bridge")]) {
      const hit = root && entryIn(join(root, "app"));
      if (hit) return hit;
    }
    const config = set("XDG_CONFIG_HOME") ?? join(home, ".config");
    for (const dir of [
      join(config, "google-chrome/NativeMessagingHosts"),
      join(config, "chromium/NativeMessagingHosts"),
      join(config, "BraveSoftware/Brave-Browser/NativeMessagingHosts"),
      join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
    ]) {
      try {
        const host = JSON.parse(readFileSync(join(dir, "dev.agent_chrome_bridge.json"), "utf8")).path;
        const e = typeof host === "string" && join(dirname(host), "mcp-server.js");
        if (e && isFile(e)) return e;
      } catch {}
    }
    const cli = which("agent-chrome-bridge", env);
    if (cli) {
      const e = join(dirname(realpathSync(cli)), "mcp-server.js");
      if (isFile(e)) return e;
    }
  })();
  if (!entry) return { error: "The Chrome bridge is not installed: run `npx @agent-sh/chrome-bridge@latest setup`, or set KEEL_CHROME_BRIDGE to its bin/mcp-server.js." };
  const node = (() => {
    const given = set("KEEL_CHROME_BRIDGE_NODE");
    if (given) return isFile(given) ? given : undefined;
    const onPath = which("node", env);
    if (onPath) return onPath;
    const dir = join(home, ".nvm/versions/node");
    if (!existsSync(dir)) return;
    const versions = readdirSync(dir)
      .map((v) => ({ v: v.replace(/^v/, "").split(".").map(Number), node: join(dir, v, "bin/node") }))
      .filter((x) => x.v.every(Number.isFinite) && isFile(x.node))
      .sort((a, b) => { for (let i = 0; i < 3; i++) if (a.v[i] !== b.v[i]) return (a.v[i] ?? 0) - (b.v[i] ?? 0); return 0; });
    return versions.at(-1)?.node;
  })();
  if (!node) return { error: "node was not found for the Chrome bridge: put it on PATH or set KEEL_CHROME_BRIDGE_NODE." };
  return { node, entry };
}

// ---- tabs, per session ----

export class TabClaims {
  private byTab = new Map<number, string>();
  claim(tab: number, session: string): string | null {
    const owner = this.byTab.get(tab);
    if (owner && owner !== session)
      return `Error [TAB_IN_USE]: tab ${tab} is driven by another Keel session. Open a tab of your own with chrome_new_tab, or act on a tab no other session uses.`;
    this.byTab.set(tab, session);
    return null;
  }
  release(tab: number, session: string) {
    if (this.byTab.get(tab) === session) this.byTab.delete(tab);
  }
  releaseSession(session: string) {
    for (const [t, s] of this.byTab) if (s === session) this.byTab.delete(t);
  }
}

export function tabArg(args: any): number | undefined {
  const v = args?.tabId;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

// `{ tab: { id } }`, `{ tabId }` or `{ id }`.
export function tabOfResult(out: ToolOutput): number | undefined {
  const text = typeof out.content === "string" ? out.content : out.content.find((b) => b.type === "text")?.text ?? "";
  try {
    const v = JSON.parse(text.trim());
    const id = v?.tab?.id ?? v?.tabId ?? v?.id;
    return Number.isInteger(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export function installChromeBridge(m: McpManager, home = ownerHome(), env: (k: string) => string | undefined = (k) => process.env[k]) {
  const found = discoverChromeBridge(home, env);
  const tools = shipped.tools as McpTool[];
  const known = new Set(tools.map((t) => t.name));
  const acts = new Set(shipped.mutating);
  const takesTab = new Set(tools.filter((t: any) => t.inputSchema?.properties?.tabId).map((t) => t.name));
  const claims = new TabClaims();
  m.addBundled(CHROME_SERVER, {
    label: "Chrome bridge",
    config: "error" in found ? null : { command: found.node, args: [found.entry] },
    missing: "error" in found ? found.error : undefined,
    tools,
    instructions: shipped.instructions,
    reads: (tool) => known.has(tool) && !acts.has(tool),
    async call(tool, input, ctx, run) {
      if (!acts.has(tool) && known.has(tool)) return run(tool, input);
      const args = { ...(input ?? {}) };
      if (takesTab.has(tool)) {
        let tab = tabArg(args);
        if (tab === undefined) {
          // Name the active tab so the action cannot land on another session's tab.
          const active = await run("chrome_active_tab", {});
          tab = active.is_error ? undefined : tabOfResult(active);
          if (tab === undefined) return active.is_error ? active : { content: "Could not find the active tab: pass tabId.", is_error: true };
          args.tabId = tab;
        }
        const refused = claims.claim(tab, ctx.sessionId);
        if (refused) return { content: refused, is_error: true };
      }
      const out = await run(tool, args);
      if (!out.is_error) {
        const tab = tabOfResult(out) ?? tabArg(args);
        if (tool === "chrome_close_tab" && tab !== undefined) claims.release(tab, ctx.sessionId);
        else if (tool === "chrome_new_tab" && tab !== undefined) claims.claim(tab, ctx.sessionId);
      }
      return out;
    },
    released: (session) => claims.releaseSession(session),
  });
}
