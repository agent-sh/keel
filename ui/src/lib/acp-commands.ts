// The slash commands of a session's ACP agent (ACP v1 slash-commands): what
// the agent advertised, offered in the message box of its sessions, and sent
// as typed (`/name input`) for the agent to read.
import { slash } from "./extend.ts";
import { api, getState, reportError } from "./store.ts";

type Command = { name: string; description: string; hint?: string };
const offered = new Map<string, Set<string>>(); // session id -> the command names its agent offers
const asking = new Map<string, Promise<void>>();

// Read again each time the menu opens in an agent's session: the agent changes its list as it goes.
export function loadAgentCommands(sessionId: string): Promise<void> {
  const s = getState().sessions[sessionId];
  if (!s?.model.startsWith("acp:")) return Promise.resolve();
  const was = asking.get(sessionId);
  if (was) return was;
  const p = (async () => {
    try {
      const r = await api<{ commands: Command[]; agent?: string }>(`/api/acp/sessions/${sessionId}/commands`);
      offered.set(sessionId, new Set(r.commands.map((c) => c.name)));
      slash.add(...r.commands.map((c) => ({
        id: `acp:${r.agent}:${c.name}`,
        word: c.name,
        label: `${c.description || c.name} (${r.agent})`,
        hint: c.hint,
        typed: true as const,
        sends: true as const,
        run: () => {},
        when: ({ session }: { session?: { id: string; model: string } }) => !!session && session.model.split("/")[0] === `acp:${r.agent}` && !!offered.get(session.id)?.has(c.name),
      })));
    } catch (e) {
      reportError(e, { at: "acp commands" });
    } finally {
      asking.delete(sessionId);
    }
  })();
  asking.set(sessionId, p);
  return p;
}
