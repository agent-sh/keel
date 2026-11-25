// An agent says its slash commands after it answered session/new, in its own time (ACP slash commands). The probe
// that asks an agent what it offers waits for that, not for as long as one round trip took.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgents } from "./agents.ts";

const AGENT = `
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\\n")) >= 0; ) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } }, authMethods: [] } });
    else if (m.method === "session/new") {
      out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
      setTimeout(() => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "late", description: "Said late" }] } } }), 300);
    } else if (m.method === "session/close") out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`;

test("a command an agent advertises a moment after its session was made is learned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-probe-"));
  try {
    writeFileSync(join(dir, "agent.js"), AGENT);
    const agents = new AcpAgents(join(dir, "state"));
    agents.ask([{ id: "late", name: "late", source: "custom", run: { command: "bun", args: [join(dir, "agent.js")] } }]);
    const end = Date.now() + 20_000;
    while (!agents.learned("late") && Date.now() < end) await Bun.sleep(25);
    expect(agents.learned("late")?.commands?.map((c) => c.name)).toEqual(["late"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
