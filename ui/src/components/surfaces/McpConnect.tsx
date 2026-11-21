// Settings > MCP servers > Connect an app: the vendors' own remote servers
// (GitHub, Gmail, Calendar, Drive, Slack, Notion, Linear), each with what it
// takes to sign in as read from the server, and the official MCP registry to
// find any other. Adding writes Keel's mcp.json; sign-in is the server's own.
import { ExternalLink, Globe, KeyRound, Plus, Search, SquareTerminal } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { Access, Connector, RegistryServer } from "../../../../src/mcp/connectors.ts";
import type { McpServerState } from "../../../../src/mcp/manager.ts";
import { api, failed } from "../../lib/store.ts";

type Card = Connector & { access: Access; added?: string; gh?: boolean };
type Hit = RegistryServer & { suggested_name: string; added: boolean };
type Done = (servers: McpServerState[], name: string) => void;

const NEEDS: Record<Access["kind"], string> = {
  open: "No sign-in",
  sign_in: "Sign in with your account",
  client_id: "Needs an OAuth client of yours",
  unreachable: "No answer",
};

async function signIn(name: string) {
  const r = await api<{ url: string }>(`/api/mcp/servers/${encodeURIComponent(name)}/sign-in`, { method: "POST" });
  window.open(r.url, "_blank", "noopener");
}

function ConnectorCard({ c, redirect, onDone }: { c: Card; redirect: string; onDone: Done }) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [secretEnv, setSecretEnv] = useState("");
  const [err, setErr] = useState("");
  const add = async (body: Record<string, unknown> = {}) => {
    setErr("");
    try {
      const r = await api<{ name: string; servers: McpServerState[] }>(`/api/mcp/connectors/${c.id}`, { method: "POST", body: JSON.stringify(body) });
      onDone(r.servers, r.name);
      if (c.access.kind !== "open" && !(c.via === "gh" && c.gh && !body.client_id)) await signIn(r.name).catch(() => {});
    } catch (x) { setErr(failed(x, { at: "McpConnect" })); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); add({ client_id: clientId.trim(), client_secret_env: secretEnv.trim() || undefined }); };
  const viaGh = c.via === "gh" && c.gh;
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-0" data-testid="mcp-connector" data-id={c.id} data-access={c.access.kind}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <Globe className="size-3.5 shrink-0 text-faint" />
        <span className="shrink-0 text-ui font-medium">{c.name}</span>
        <span className="min-w-40 flex-1 truncate text-caption text-faint">{c.what}</span>
        <span className="k-chip" data-testid="mcp-connector-access" title={c.access.issuer ? `Signs in at ${c.access.issuer}` : c.access.error}>{viaGh ? "Your GitHub CLI sign-in" : NEEDS[c.access.kind]}</span>
        <a className="k-btn" data-quiet href={c.docs} target="_blank" rel="noopener" aria-label={`${c.name} documentation`}><ExternalLink /></a>
        {c.added ? <span className="w-28 shrink-0 text-right text-caption text-faint" data-testid="mcp-connector-added">In Keel as {c.added}</span>
          : c.access.kind === "client_id" && !viaGh ? (
            <button type="button" className="k-btn w-28 justify-center" data-testid="mcp-connector-setup" onClick={() => setOpen(!open)}><KeyRound /> Set up</button>
          ) : (
            <button type="button" className="k-btn w-28 justify-center" data-testid="mcp-connector-add" disabled={c.access.kind === "unreachable"} onClick={() => add()}><Plus /> {c.access.kind === "sign_in" ? "Connect" : "Add"}</button>
          )}
      </div>
      {open && !c.added && (
        <form onSubmit={submit} className="k-form ml-6" data-testid="mcp-connector-form">
          <p className="k-form-hint">
            {c.access.issuer ?? "This provider"} registers no apps on the fly: create an OAuth client in its console
            (see the documentation), allow the redirect <code className="font-mono">{redirect}</code>, and give its id here.
            A secret, when the client has one, is read from an environment variable and never enters the file.
          </p>
          <label>Client ID<input data-mono data-testid="mcp-connector-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
          <label>Client secret from the variable<input data-mono value={secretEnv} onChange={(e) => setSecretEnv(e.target.value)} placeholder="optional, for example MCP_CLIENT_SECRET" /></label>
          <div><button type="submit" className="k-btn" data-ink disabled={!clientId.trim()}>Add and sign in</button></div>
        </form>
      )}
      {err && <p className="k-form-err ml-6" data-testid="mcp-connector-error">{err}</p>}
    </div>
  );
}

function RegistryHit({ h, onDone }: { h: Hit; onDone: Done }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const kind = h.remote ? "remote" : "package";
  const vars = h.remote ? h.remote.headers : h.package?.env ?? [];
  const add = async () => {
    setErr("");
    try {
      const r = await api<{ name: string; servers: McpServerState[] }>("/api/mcp/registry/add", { method: "POST", body: JSON.stringify({ server: h.name, kind, values }) });
      onDone(r.servers, r.name);
    } catch (x) { setErr(failed(x, { at: "McpConnect" })); }
  };
  const target = h.remote?.url ?? [h.package?.command, ...(h.package?.args ?? [])].join(" ");
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-2.5 last:border-0" data-testid="mcp-registry-hit" data-name={h.name}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {h.remote ? <Globe className="size-3.5 shrink-0 text-faint" /> : <SquareTerminal className="size-3.5 shrink-0 text-faint" />}
        <span className="shrink-0 text-ui font-medium">{h.title ?? h.suggested_name}</span>
        <span className="min-w-0 shrink truncate font-mono text-micro text-faint" title={h.name}>{h.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-faint" title={target}>{target}</span>
        {h.repository && <a className="k-btn" data-quiet href={h.repository} target="_blank" rel="noopener" aria-label="Source"><ExternalLink /></a>}
        {h.added ? <span className="w-20 shrink-0 text-right text-caption text-faint">In Keel</span> : (
          <button type="button" className="k-btn w-20 justify-center" data-testid="mcp-registry-add" onClick={add}><Plus /> Add</button>
        )}
      </div>
      {h.description && <p className="ml-6 text-caption text-muted">{h.description}</p>}
      {!h.added && vars.length > 0 && (
        <div className="k-form ml-6">
          {vars.map((v) => (
            <label key={v.name} title={v.description}>
              {v.name}{v.required ? "" : " (optional)"}
              <input data-mono type={v.secret ? "password" : "text"} value={values[v.name] ?? ""} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      {err && <p className="k-form-err ml-6">{err}</p>}
    </div>
  );
}

export function Connect({ onDone }: { onDone: Done }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [redirect, setRedirect] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => api<{ connectors: Card[]; redirect_uri: string }>("/api/mcp/connectors").then((r) => { setCards(r.connectors); setRedirect(r.redirect_uri); }).catch((x) => setErr(failed(x, { at: "McpConnect" })));
  useEffect(() => { load(); }, []);
  const done: Done = (servers, name) => { onDone(servers, name); load(); setHits((h) => h && h.map((x) => (x.suggested_name === name ? { ...x, added: true } : x))); };
  const search = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try { setHits((await api<{ servers: Hit[] }>(`/api/mcp/registry?q=${encodeURIComponent(q.trim())}`)).servers); }
    catch (x) { setErr(failed(x, { at: "McpConnect" })); }
  };
  return (
    <div data-testid="mcp-connect">
      <div className="k-sub k-label">Apps, through their makers' own servers</div>
      {cards ? cards.map((c) => <ConnectorCard key={c.id} c={c} redirect={redirect} onDone={done} />) : <p className="text-caption text-faint">Asking each server what it needs to sign in.</p>}
      <div className="k-sub mt-5">Any other, from the MCP registry</div>
      <form onSubmit={search} className="k-form" data-testid="mcp-registry-search"><div className="flex items-center gap-2">
        <input className="min-w-0 flex-1" data-testid="mcp-registry-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, for example io.github.github or notion" />
        <button type="submit" className="k-btn" disabled={!q.trim()}><Search /> Search</button>
      </div></form>
      {err && <p className="k-form-err mt-2" data-testid="mcp-connect-error">{err}</p>}
      {hits && (hits.length ? <div className="mt-2">{hits.map((h) => <RegistryHit key={h.name} h={h} onDone={done} />)}</div> : <p className="mt-2 text-caption text-faint">The registry has no server Keel can add by that name.</p>)}
    </div>
  );
}
