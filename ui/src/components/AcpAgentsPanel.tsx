// Settings > ACP agents: the agents keel-bun drives over the Agent Client
// Protocol (from the ACP registry and the owner's own entries), a new session
// with one, adding one, and how an editor drives Keel itself.
import { useEffect, useState } from "react";
import { actions, api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { Card, SettingRow } from "./Settings.tsx";

type Cmd = { command: string; args: string[] };
type Agent = { id: string; name: string; description?: string; version?: string; source: "registry" | "custom"; installed: boolean; model: string; run?: Cmd; add?: Cmd; website?: string };
type Listing = { agents: Agent[]; error?: string; running: { session: string; agent: string }[] };

const line = (c?: Cmd) => (c ? [c.command.replace(/^\/home\/[^/]+/, "~"), ...c.args].join(" ") : "");
const btn = "h-7 shrink-0 rounded-md border border-line px-2.5 text-caption font-medium text-fg hover:bg-hover disabled:opacity-40";

export function AcpAgentsSettings() {
  const [l, setL] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: "", command: "", args: "" });
  const load = (refresh = false) => api<Listing>(`/api/acp/agents${refresh ? "?refresh=1" : ""}`).then(setL).catch(reportError);
  useEffect(() => { void load(true); }, []);
  // An added or removed agent is a model added or removed: the picker reads the listing again.
  const act = (f: () => Promise<Listing>) => { setBusy(true); f().then((r) => { setL(r); return actions.loadModels(); }).catch(reportError).finally(() => setBusy(false)); };
  const start = async (a: Agent) => {
    try {
      const r = await api<{ session: { id: string } }>("/api/sessions", { method: "POST", body: JSON.stringify({ model: a.model }) });
      navigate({ name: "session", id: r.session.id });
    } catch (e) { reportError(e); }
  };
  const installed = l?.agents.filter((a) => a.installed) ?? [];
  const more = l?.agents.filter((a) => !a.installed) ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="acp-agents">
      <p className="text-ui text-muted">
        Agents that speak the Agent Client Protocol answer a session here: their replies, calls and plans show in the transcript, and what they ask permission for, or a file they read or write through Keel, goes through the session's permission mode and your grants. Each agent signs in and bills on its own account.
      </p>
      <Card>
        {installed.length === 0 && <SettingRow label="No agent installed" hint="Install one from the list below, or add your own command." ><span /></SettingRow>}
        {installed.map((a) => (
          <SettingRow key={a.id} label={a.name} hint={<span className="font-mono text-caption" data-testid="acp-agent-command">{line(a.run)}</span>}>
            <div className="flex items-center gap-2" data-testid={`acp-agent-${a.id}`}>
              <span className="text-caption text-faint">{a.source === "custom" ? "Yours" : "Registry"}</span>
              <button type="button" className={btn} onClick={() => void start(a)} data-testid="acp-agent-start">New session</button>
              {a.source === "custom" && <button type="button" className={btn} disabled={busy} onClick={() => act(() => api<Listing>(`/api/acp/agents/${a.id}`, { method: "DELETE" }))}>Remove</button>}
            </div>
          </SettingRow>
        ))}
      </Card>
      <Card>
        <div className="py-4">
          <div className="text-base font-medium">Add your own</div>
          <div className="mt-0.5 text-ui text-muted">A command that speaks ACP on stdio, as in Zed's custom agents.</div>
          <form
            className="mt-3 flex flex-wrap items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); act(() => api<Listing>("/api/acp/agents", { method: "POST", body: JSON.stringify({ id: form.id.trim(), command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [] }) })); setForm({ id: "", command: "", args: "" }); }}
          >
            <input aria-label="Agent id" placeholder="id" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} className="h-7 w-32 rounded-md border border-line bg-sunken px-2 text-caption" data-testid="acp-add-id" />
            <input aria-label="Command" placeholder="command" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} className="h-7 w-48 rounded-md border border-line bg-sunken px-2 font-mono text-caption" data-testid="acp-add-command" />
            <input aria-label="Arguments" placeholder="arguments" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} className="h-7 min-w-64 flex-1 rounded-md border border-line bg-sunken px-2 font-mono text-caption" data-testid="acp-add-args" />
            <button type="submit" className={btn} disabled={busy || !form.id.trim() || !form.command.trim()} data-testid="acp-add">Add</button>
          </form>
        </div>
      </Card>
      <Card>
        <div className="flex items-center gap-3 border-b border-line py-3">
          <span className="text-ui font-medium">From the ACP registry</span>
          <span className="text-caption text-faint" data-testid="acp-registry-count">{l ? `${l.agents.filter((a) => a.source === "registry").length} agents` : "..."}</span>
          {l?.error && <span className="text-caption text-danger">{l.error}</span>}
          <button type="button" className={`${btn} ml-auto`} disabled={busy} onClick={() => act(() => api<Listing>("/api/acp/agents?refresh=1"))}>Check again</button>
        </div>
        {more.map((a) => (
          <SettingRow key={a.id} label={a.name} hint={a.description}>
            {a.add
              ? <button type="button" className={btn} disabled={busy} title={line(a.add)} onClick={() => act(() => api<Listing>("/api/acp/agents", { method: "POST", body: JSON.stringify({ id: a.id }) }))}>Add with {a.add.command}</button>
              : <span className="text-caption text-faint">Not installed here</span>}
          </SettingRow>
        ))}
      </Card>
      <Card>
        <SettingRow label="Keel in an editor" hint="Zed and other ACP clients drive Keel itself: add this to Zed's agent_servers.">
          <code className="block rounded-md bg-sunken px-2 py-1 font-mono text-caption text-muted">{`"Keel": { "type": "custom", "command": "keel", "args": ["acp"] }`}</code>
        </SettingRow>
      </Card>
    </div>
  );
}
