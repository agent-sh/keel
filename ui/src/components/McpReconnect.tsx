// A call of an MCP server that failed because the server is down or signed out: a line under it offers
// to bring the server back from here (Reconnect, or Sign in for a server that needs one). Keel never runs
// the call again; once the server is ready, the session's model is told with its next input.
import { useEffect, useState } from "react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import type { McpServerState } from "../../../src/mcp/manager.ts";
import { api, failed } from "../lib/store.ts";

// The server a call is of: `mcp_call`'s tool, or the call's own name (`server__tool`, or `mcp__server__tool`).
export function serverOfCall(use: ToolUseBlock): string | null {
  const raw = use.name === "mcp_call" ? String((use.input as { tool?: unknown } | undefined)?.tool ?? "") : use.name;
  const name = raw.startsWith("mcp__") && raw.slice(5).includes("__") ? raw.slice(5) : raw;
  const at = name.indexOf("__");
  return at > 0 ? name.slice(0, at) : null;
}

const DOWN = new Set(["error", "unreachable", "needs_auth"]);
// One read of the list for every failed call on the page that asks within a moment.
let listed: { at: number; p: Promise<McpServerState[]> } | null = null;
const LIST_FOR_MS = 3000;
const servers = () => {
  if (!listed || Date.now() - listed.at > LIST_FOR_MS) listed = { at: Date.now(), p: api<{ servers: McpServerState[] }>("/api/mcp/servers").then((r) => r.servers, () => []) };
  return listed.p;
};

type Said = { kind: "down"; server: McpServerState } | { kind: "busy"; server: McpServerState } | { kind: "back"; name: string } | { kind: "still"; server: McpServerState; why: string };

export function McpReconnect({ use, result, sessionId }: { use: ToolUseBlock; result?: ToolResultBlock; sessionId?: string }) {
  const name = result?.is_error && sessionId ? serverOfCall(use) : null;
  const [said, setSaid] = useState<Said | null>(null);
  useEffect(() => {
    if (!name) return;
    let on = true;
    const look = () => servers().then((all) => {
      const s = all.find((x) => x.name === name);
      if (on && s && !s.session && DOWN.has(s.state)) setSaid((was) => (was?.kind === "busy" ? was : { kind: "down", server: s }));
      else if (on && s?.state === "ready") setSaid((was) => (was?.kind === "busy" || was?.kind === "still" ? { kind: "back", name: s.name } : was?.kind === "back" ? was : null));
    });
    void look();
    // Back from a sign-in in another tab: the list is read again.
    const back = () => { listed = null; void look(); };
    window.addEventListener("focus", back);
    return () => { on = false; window.removeEventListener("focus", back); };
  }, [name]);
  if (!said || !sessionId) return null;
  const server = "server" in said ? said.server : null;
  const signIn = server?.state === "needs_auth" && server.sign_in;
  const act = async () => {
    if (!server) return;
    setSaid({ kind: "busy", server });
    try {
      if (signIn) {
        const r = await api<{ url: string }>(`/api/mcp/servers/${encodeURIComponent(server.name)}/sign-in`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) });
        window.open(r.url, "_blank", "noopener");
        return;
      }
      const r = await api<{ servers: McpServerState[] }>(`/api/mcp/servers/${encodeURIComponent(server.name)}/reconnect`, { method: "POST", body: JSON.stringify({ session_id: sessionId }) });
      listed = null;
      const now = r.servers.find((x) => x.name === server.name);
      setSaid(now?.state === "ready" ? { kind: "back", name: server.name } : { kind: "still", server: now ?? server, why: (now?.error ?? "it did not connect").split("\n")[0]! });
    } catch (e) {
      setSaid({ kind: "still", server, why: failed(e, { at: "McpReconnect" }) });
    }
  };
  if (said.kind === "back") {
    return (
      <div className="k-line" data-testid="mcp-reconnect" data-state="back">
        <span className="k-line-text" data-wrap><span className="k-line-verb">Server</span> {said.name} is connected again. The call was not run again; the model hears it with your next message.</span>
      </div>
    );
  }
  const words = said.kind === "still" ? `Still not connected: ${said.why}` : server!.state === "needs_auth" ? "needs a sign-in" : "is not connected";
  return (
    <div className="k-line" data-testid="mcp-reconnect" data-state={said.kind}>
      <span className="k-line-text" data-wrap><span className="k-line-verb">Server</span> {server!.name} {said.kind === "still" ? `· ${words}` : words}</span>
      <button type="button" className="k-btn" data-quiet data-testid="mcp-reconnect-act" disabled={said.kind === "busy"} onClick={act}>
        {said.kind === "busy" ? (signIn ? "Signing in" : "Reconnecting") : signIn ? "Sign in" : "Reconnect"}
      </button>
    </div>
  );
}
