// `keel mcp`: the MCP servers the daemon connects to, and whether the events
// a server pushes are taken (src/mcp/channel.ts), off by default.
import { command, EXIT, line, printJson, usageError } from "./client.ts";

const USAGE = `usage: keel mcp [list] [--session ID] [--json]
       keel mcp channel NAME on|off [--session ID] [--json]

list      each server: its state, its tools, whether it is a channel and where its events go
channel   take the events NAME pushes, or stop:
            on|off              the server's switch (off keeps the sessions named for it)
            on|off --session ID that session takes its events, or stops; on also turns the switch on
          A server an editor passed with a session has the one switch: name its session.

Each event goes into the sessions that take it: a working one reads it at its next step,
an idle one starts a turn, one you stopped keeps it until you go on.`;

type Server = { name: string; state: string; tools: number; session?: string; bundled?: string; channel: { on: boolean; declared: boolean; sessions?: { id: string; title: string }[] } };

export const mcpCmd = command("mcp", USAGE, { session: { type: "string" } }, async (v, pos, c) => {
  const [sub = "list", name, onOff] = pos;
  let session: string | undefined;
  if (v.session) session = (await c.resolve(String(v.session))).id;
  let servers: Server[];
  if (sub === "list") servers = (await c.get<{ servers: Server[] }>(session ? `/api/sessions/${session}/mcp` : "/api/mcp/servers")).servers;
  else if (sub === "channel") {
    if (!name || (onOff !== "on" && onOff !== "off")) return usageError("mcp", "keel mcp channel NAME on|off", USAGE);
    servers = (await c.post<{ servers: Server[] }>(`/api/mcp/servers/${encodeURIComponent(name)}/channel`, { on: onOff === "on", ...(session ? { session } : {}) })).servers;
    servers = servers.filter((s) => s.name === name);
  } else return usageError("mcp", `unknown: keel mcp ${sub}`, USAGE);
  if (v.json) return (printJson({ servers }), EXIT.ok);
  for (const s of servers) {
    const ch = s.bundled ? "" : !s.channel.on ? "channel off" : s.session ? "channel on, into its session" : s.channel.sessions?.length ? `channel on, into ${s.channel.sessions.map((x) => line(x.title || x.id)).join(", ")}` : "channel on, no session takes its events yet";
    console.log([line(s.name), s.state, `${s.tools} tools`, s.channel.declared ? "declares a channel" : "", ch].filter(Boolean).join("  ·  "));
  }
  return EXIT.ok;
});
