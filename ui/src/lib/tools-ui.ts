// The tools lane's entries in the workbench: the MCP servers sheet from the
// palette and /mcp, and one slash command per skill the session can run.
import { setMcpOpen } from "../components/McpPanel.tsx";
import { slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { api, reportError } from "./store.ts";

registerCommand({ id: "mcp", label: "MCP servers", group: "General", words: "tools servers mcp plugins connect", run: () => setMcpOpen(true) });
slash.add({ id: "mcp", label: "Manage tool servers", run: () => setMcpOpen(true) });

type SkillInfo = { name: string; description: string; user_invocable: boolean; argument_hint?: string };
const byFolder = new Map<string, Set<string>>();

// Skills differ per folder (project skills): load a folder's once, show each
// only in sessions of a folder that has it.
export async function loadSkillCommands(workspace: string) {
  if (byFolder.has(workspace)) return;
  byFolder.set(workspace, new Set());
  try {
    const { skills } = await api<{ skills: SkillInfo[] }>(`/api/skills?cwd=${encodeURIComponent(workspace)}`);
    const names = byFolder.get(workspace)!;
    for (const s of skills.filter((x) => x.user_invocable)) {
      names.add(s.name);
      if (slash.all().some((i) => i.id === s.name && !i.id.startsWith("skill:"))) continue; // a built-in command keeps its name
      slash.add({
        id: s.name,
        label: s.description.slice(0, 90) || `Run the ${s.name} skill`,
        hint: s.argument_hint,
        when: ({ session }) => !!session && !!byFolder.get(session.workspace)?.has(s.name),
        run: (arg, { session }) => api(`/api/sessions/${session!.id}/skill`, { method: "POST", body: JSON.stringify({ name: s.name, args: arg }) }).then(() => {}),
      });
    }
  } catch (e) {
    byFolder.delete(workspace);
    reportError(e, { at: "skills" });
  }
}
