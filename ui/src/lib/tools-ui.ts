// The tools lane's entries in the workbench: the MCP servers sheet from the
// palette and the /mcp command.
import { setMcpOpen } from "../components/McpPanel.tsx";
import { slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";

registerCommand({ id: "mcp", label: "MCP servers", group: "General", words: "tools servers mcp plugins connect", run: () => setMcpOpen(true) });
slash.add({ id: "mcp", label: "Manage tool servers", run: () => setMcpOpen(true) });
