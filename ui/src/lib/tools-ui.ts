// The tools lane's entries in the workbench: Settings > MCP servers from the
// palette and /mcp, one slash command per skill the session can run, and one
// per MCP prompt (/server:prompt, Claude Code's form; /mcp__server__prompt too).
import { slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { api, reportError } from "./store.ts";
import { navigate } from "./ui.ts";

const openMcp = () => navigate({ name: "settings", section: "mcp" });

registerCommand({ id: "mcp", label: "MCP servers", group: "General", words: "tools servers mcp plugins connect", run: openMcp });
slash.add({ id: "mcp", label: "Manage tool servers", run: openMcp });

type SkillInfo = { name: string; description: string; user_invocable: boolean; enabled: boolean; argument_hint?: string };
const byFolder = new Map<string, Set<string>>();

// Skills differ per folder (project skills): load a folder's once, show each
// only in sessions of a folder that has it.
export async function loadSkillCommands(workspace: string) {
  if (byFolder.has(workspace)) return;
  byFolder.set(workspace, new Set());
  try {
    const { skills } = await api<{ skills: SkillInfo[] }>(`/api/skills?cwd=${encodeURIComponent(workspace)}`);
    const names = byFolder.get(workspace)!;
    for (const s of skills.filter((x) => x.user_invocable && x.enabled)) {
      names.add(s.name);
      if (slash.all().some((i) => i.id === s.name && i.run)) continue; // a working built-in command keeps its name
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

type PromptInfo = { server: string; name: string; description: string; arguments: { name: string; required?: boolean }[] };
let promptsAt = 0;
let promptsLoading: Promise<void> | null = null;
const promptIds = new Set<string>();

// The servers' prompts, read again when the slash menu opens and the last
// read is older than half a minute (servers come and go; prompts change).
export function loadMcpPrompts(): Promise<void> {
  if (promptsLoading) return promptsLoading;
  if (Date.now() - promptsAt < 30_000) return Promise.resolve();
  promptsLoading = (async () => {
    try {
      const { prompts } = await api<{ prompts: PromptInfo[] }>("/api/mcp/prompts");
      promptsAt = Date.now();
      const now = new Set<string>();
      for (const p of prompts) {
        const id = `${p.server}:${p.name}`;
        const alias = `mcp__${p.server.replace(/[^A-Za-z0-9_-]/g, "_")}__${p.name}`;
        now.add(id); now.add(alias);
        if (slash.all().some((i) => i.id === id && i.run && !promptIds.has(id))) continue; // a working built-in keeps its name
        const run = async (arg: string, { session }: { session?: { id: string } }) => {
          if (!session) throw Object.assign(new Error("Open a session first."), { usage: true });
          if (!promptIds.has(id)) throw Object.assign(new Error(`${p.server} no longer offers ${p.name}.`), { usage: true });
          try {
            await api(`/api/sessions/${session.id}/mcp-prompt`, { method: "POST", body: JSON.stringify({ server: p.server, prompt: p.name, args: arg }) });
          } catch (e) {
            if ((e as { body?: { usage?: boolean } }).body?.usage) throw Object.assign(new Error((e as Error).message), { usage: true });
            throw e;
          }
        };
        const hint = p.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ") || undefined;
        const live = () => promptIds.has(id);
        slash.add(
          { id, label: `${p.description ? p.description.slice(0, 80) : `${p.name} prompt`} (MCP)`, hint, when: ({ session }) => !!session && live(), run },
          // Typed in full it runs; the menu lists the short form only.
          { id: alias, label: `${p.server}:${p.name} (MCP)`, hint, when: () => false, run },
        );
      }
      promptIds.clear();
      for (const id of now) promptIds.add(id);
    } catch (e) {
      reportError(e, { at: "mcp prompts" });
    } finally {
      promptsLoading = null;
    }
  })();
  return promptsLoading;
}
