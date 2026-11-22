// Settings > Plugins, the plugins installed as one unit: what each brought,
// on and off, an update said before it is applied, removal, and the install
// field with its consent step (src/plugins/installer.ts). Nothing a plugin
// runs starts before the owner said yes to its lines here.
import { ArrowUpCircle, PackagePlus, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, failed } from "../../lib/store.ts";
import { MarkDot, ReaderHead, tail, tilde, Toggle, type Mark } from "./kit.tsx";

export type UnitView = {
  id: string; name: string; version: string; description: string | null; author: string | null; homepage: string | null;
  source: string; entry: string | null; commit: string | null; dir: string; data: string; enabled: boolean; installed: number; updated: number; offered_by: string | null;
  skills: string[]; commands: string[]; agents: string[]; hooks: { event: string; matcher: string | null; what: string }[];
  mcp: { name: string; label: string; what: string; state: string; tools: string[]; error: string | null }[];
  not_taken: { part: string; why: string }[]; notes: string[]; runs: string[];
};
export type Offer = { key: string; plugin: string; marketplace: string; from: string; input?: string; installed?: string; problem?: string };
export type Units = { plugins: UnitView[]; offers: Offer[]; home: string; registry: string };
type PlanView = {
  kind: "plugin"; token: string; input: string; id: string; name: string; version: string; description?: string; author?: string; root: string;
  skills: string[]; commands: string[]; agents: string[]; hooks: { event: string; matcher?: string; what: string }[]; mcp: { name: string; label: string; what: string }[];
  runs: string[]; consent: string | null; not_taken: { part: string; why: string }[]; notes: string[]; problems: string[];
  update?: { id: string; from: string; changes: string[]; runs_changed: boolean; same: boolean };
};
type MarketView = { kind: "marketplace"; token: string; input: string; name: string; owner?: string; description?: string; plugins: { name: string; description?: string; version?: string; from: string; unsupported?: string }[] };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const unitMark = (u: UnitView): Mark => (!u.enabled ? "off" : u.mcp.some((m) => m.state === "error") ? "fail" : u.mcp.some((m) => m.state === "connecting") ? "work" : "on");
export const unitBrings = (u: { skills: unknown[]; commands: unknown[]; agents: unknown[]; hooks: unknown[]; mcp: unknown[] }) =>
  [[u.skills.length, "skill"], [u.commands.length, "command"], [u.agents.length, "agent"], [u.hooks.length, "hook"], [u.mcp.length, "MCP server"]].filter(([n]) => n).map(([n, w]) => plural(n as number, w as string)).join(", ") || "nothing Keel runs";
const mcpMarkOf = (state: string): Mark => (state === "ready" || state === "idle" ? "on" : state === "disabled" ? "off" : state === "connecting" ? "work" : state === "needs_auth" ? "need" : "fail");

// One row of what a plugin brings: the kind, then its names.
function Part({ what, children, testid }: { what: string; children: ReactNode; testid?: string }) {
  return <div className="contents" data-testid={testid}><dt>{what}</dt><dd>{children}</dd></div>;
}
const Chips = ({ names }: { names: string[] }) => <>{names.map((n) => <span key={n} className="k-chip font-mono">{n}</span>)}</>;

function NotTaken({ items, notes, testid }: { items: { part: string; why: string }[]; notes: string[]; testid: string }) {
  return (
    <>
      {items.length > 0 && (
        <div data-testid={`${testid}-not-taken`}>
          <div className="k-sub k-label">Not taken, and why</div>
          <ul className="k-plain-list">{items.map((n, i) => <li key={`${n.part}-${i}`}><code className="font-mono text-micro text-fg">{n.part}</code> <span>{n.why}</span></li>)}</ul>
        </div>
      )}
      {notes.length > 0 && (
        <div data-testid={`${testid}-notes`}>
          <div className="k-sub k-label">Names</div>
          <ul className="k-plain-list">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </>
  );
}

// What a prepared plugin is, its yes, and the button that installs or updates it.
function PlanBody({ plan, onDone, onCancel }: { plan: PlanView; onDone: (u: UnitView) => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const update = plan.update;
  const asks = plan.runs.length > 0 && (!update || update.runs_changed);
  const go = async () => {
    setBusy(true); setErr("");
    try {
      const r = await api<{ plugin: UnitView }>("/api/plugins/install", { method: "POST", body: JSON.stringify({ token: plan.token, consent: plan.consent }) });
      onDone(r.plugin);
    } catch (e) { setErr(failed(e, { at: "plugin install" })); } finally { setBusy(false); }
  };
  const word = update ? "Update" : "Install";
  return (
    <div className="k-reader-body" data-testid="plugin-plan" data-id={plan.id} data-asks={asks || undefined}>
      {update && (
        <div data-testid="plan-changes">
          <div className="k-sub k-label">What changes, from {update.from} to {plan.version}</div>
          {update.changes.length ? <ul className="k-plain-list">{update.changes.map((c) => <li key={c} className="font-mono text-micro">{c}</li>)}</ul> : <p className="text-caption text-muted">The same parts and the same commands, in a new copy.</p>}
        </div>
      )}
      <dl className="k-parts" data-testid="plan-parts">
        {plan.skills.length > 0 && <Part what="Skills"><Chips names={plan.skills} /></Part>}
        {plan.commands.length > 0 && <Part what="Commands"><Chips names={plan.commands} /></Part>}
        {plan.agents.length > 0 && <Part what="Agents"><Chips names={plan.agents} /></Part>}
        {plan.mcp.length > 0 && <Part what="MCP servers"><Chips names={plan.mcp.map((m) => (m.label === m.name ? m.name : `${m.name} as ${m.label}`))} /></Part>}
        {plan.hooks.length > 0 && <Part what="Hooks"><Chips names={[...new Set(plan.hooks.map((h) => h.event))]} /></Part>}
        {!plan.skills.length && !plan.commands.length && !plan.agents.length && !plan.mcp.length && !plan.hooks.length && <Part what="Parts"><span className="text-caption text-faint">Nothing Keel takes.</span></Part>}
      </dl>
      {plan.runs.length > 0 && (
        <section className="k-runs" data-testid="plan-runs" data-asks={asks || undefined}>
          <h4>{asks ? "It runs these on this machine, as you" : "It runs what you agreed to before"}</h4>
          <p>{asks ? "Each line starts a program with your files and shell: a hook at its event, a server while the plugin is on. Nothing of it runs before you say yes." : "These lines are the ones you said yes to: no new yes is needed."} <code className="font-mono">{"${CLAUDE_PLUGIN_ROOT}"}</code> is <code className="font-mono">{tilde(plan.root)}</code>.</p>
          <ol>{plan.runs.map((r) => <li key={r} data-testid="plan-run">{r}</li>)}</ol>
        </section>
      )}
      <NotTaken items={plan.not_taken} notes={plan.notes} testid="plan" />
      {plan.problems.length > 0 && <ul className="k-issue" data-testid="plan-problems">{plan.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {err && <p className="k-issue" data-testid="plan-error">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="k-btn" data-ink disabled={busy || plan.problems.length > 0} data-testid="plan-install" onClick={go}>
          {update ? <ArrowUpCircle /> : <PackagePlus />} {asks ? `${word} and let it run ${plan.runs.length === 1 ? "this" : `these ${plan.runs.length}`}` : word}
        </button>
        <button type="button" className="k-btn" data-quiet data-testid="plan-cancel" onClick={onCancel}><X /> Cancel</button>
      </div>
    </div>
  );
}

const planHead = (p: PlanView, extra: [string, ReactNode][] = []) => (
  <ReaderHead
    title={p.id}
    desc={p.description ?? "A plugin, read and not yet installed."}
    path={p.input}
    facts={[["Version", p.update ? `${p.update.from} to ${p.version}` : p.version], ...(p.author ? [["Author", p.author] as [string, string]] : []), ["Brings", unitBrings(p)], ...extra]}
  />
);

const discard = (token: string) => void api("/api/plugins/discard", { method: "POST", body: JSON.stringify({ token }) }).catch(() => {});

// The install field: a folder, a git URL or owner/repo, read before anything is installed.
export function InstallReader({ folder, onDone }: { folder: string; onDone: (u: UnitView) => void }) {
  const [input, setInput] = useState("");
  const [got, setGot] = useState<PlanView | MarketView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const read = async (entry?: string) => {
    setBusy(true); setErr("");
    try {
      const prev = got;
      setGot(await api<PlanView | MarketView>("/api/plugins/prepare", { method: "POST", body: JSON.stringify({ input: input.trim(), cwd: folder, ...(entry ? { entry } : {}) }) }));
      if (prev) discard(prev.token);
    } catch (e) { setErr(failed(e, { at: "plugin prepare" })); } finally { setBusy(false); }
  };
  const reset = () => { if (got) discard(got.token); setGot(null); };
  if (got?.kind === "plugin") return <>{planHead(got)}<PlanBody plan={got} onCancel={reset} onDone={(u) => { setGot(null); setInput(""); onDone(u); }} /></>;
  return (
    <>
      <ReaderHead title="Install a plugin" desc="A folder, a git URL (a branch, tag or commit after #) or a GitHub owner/repo, in the Claude Code plugin format. Keel reads it and says what it brings and what it would run; nothing of it runs until you say yes." />
      <div className="k-reader-body" data-testid="plugin-install">
        <form className="k-form" onSubmit={(e) => { e.preventDefault(); if (input.trim()) void read(); }}>
          <label>Where it is<input data-mono data-testid="install-source" value={input} onChange={(e) => { setInput(e.target.value); reset(); }} placeholder="~/plugins/review-kit or https://example.com/kit.git#v2" /></label>
          {err && <p className="k-form-err" data-testid="install-error">{err}</p>}
          <div><button type="submit" className="k-btn" data-ink disabled={!input.trim() || busy} data-testid="install-read">{busy ? "Reading" : "Read it"}</button></div>
        </form>
        {got?.kind === "marketplace" && (
          <div data-testid="plugin-market" data-name={got.name}>
            <div className="k-sub k-label">{got.name}: a marketplace of {plural(got.plugins.length, "plugin")}{got.owner ? `, from ${got.owner}` : ""}</div>
            <div className="k-market">
              {got.plugins.map((e) => (
                <div key={e.name} className="k-market-row" data-testid="market-entry" data-name={e.name}>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2"><b>{e.name}</b>{e.version && <span className="text-micro text-faint tabular-nums">{e.version}</span>}</div>
                    <p>{e.unsupported ?? e.description ?? e.from}</p>
                  </div>
                  <button type="button" className="k-btn" disabled={!!e.unsupported || busy} data-testid="market-pick" onClick={() => read(e.name)}>Read</button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// A plugin a folder's repository names: offered, and installed only with a yes.
export function OfferReader({ o, folder, onDone }: { o: Offer; folder: string; onDone: (u: UnitView) => void }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true); setErr("");
    try {
      const p = await api<PlanView | MarketView>("/api/plugins/prepare", { method: "POST", body: JSON.stringify({ input: o.input, entry: o.plugin, cwd: folder, offered_by: o.from }) });
      if (p.kind === "plugin") setPlan(p); else { discard(p.token); setErr(`${o.input} lists no plugin ${o.plugin}`); }
    } catch (e) { setErr(failed(e, { at: "plugin offer" })); } finally { setBusy(false); }
  };
  if (plan) return <>{planHead(plan, [["Offered by", <span title={o.from}>{tail(o.from, 56)}</span>]])}<PlanBody plan={plan} onCancel={() => { discard(plan.token); setPlan(null); }} onDone={onDone} /></>;
  return (
    <>
      <ReaderHead title={o.plugin} path={o.from} desc={`This folder's settings name ${o.plugin} from the marketplace ${o.marketplace || "(none)"}. It stays offered, not installed, until you read it and say yes.`} facts={[["Marketplace", o.marketplace || "none"], ["Source", o.input ? tilde(o.input) : "not given"]]} />
      <div className="k-reader-body" data-testid="plugin-offer" data-key={o.key}>
        {o.problem ? <p className="k-issue" data-tone="need">{o.problem}</p> : <div><button type="button" className="k-btn" data-ink disabled={busy} data-testid="offer-read" onClick={read}>{busy ? "Reading" : "Read it"}</button></div>}
        {err && <p className="k-issue">{err}</p>}
      </div>
    </>
  );
}

// An installed plugin: what it brought, on or off, an update, removal.
export function UnitReader({ u, folder, onChange }: { u: UnitView; folder: string; onChange: (removed?: boolean) => void }) {
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [current, setCurrent] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const act = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErr("");
    try { await f(); } catch (e) { setErr(failed(e, { at: `plugin ${what}` })); } finally { setBusy(""); }
  };
  const base = `/api/plugins/installed/${encodeURIComponent(u.id)}`;
  if (plan) return <>{planHead(plan)}<PlanBody plan={plan} onCancel={() => { discard(plan.token); setPlan(null); }} onDone={() => { setPlan(null); onChange(); }} /></>;
  return (
    <>
      <ReaderHead
        title={u.id}
        desc={u.description ?? undefined}
        path={u.dir}
        right={<Toggle testid="unit-toggle" on={u.enabled} label={`Turn ${u.id} ${u.enabled ? "off" : "on"}`} onChange={(on) => act("toggle", async () => { await api(`${base}/enable`, { method: "POST", body: JSON.stringify({ enabled: on, cwd: folder }) }); onChange(); })} />}
        facts={[
          ["State", u.enabled ? "on" : "off: nothing of it runs or is offered"],
          ["Version", u.version],
          ["Source", <span title={u.source}>{tail(u.source, 56)}{u.entry ? ` · ${u.entry}` : ""}</span>],
          ...(u.commit ? [["Commit", u.commit.slice(0, 12)] as [string, string]] : []),
          ["Installed", new Date(u.installed).toLocaleDateString(undefined, { dateStyle: "medium" })],
          ...(u.offered_by ? [["Offered by", tilde(u.offered_by)] as [string, string]] : []),
        ]}
      >
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <button type="button" className="k-btn" disabled={!!busy} data-testid="unit-update" onClick={() => act("update", async () => {
            setCurrent(false);
            const p = await api<PlanView>(`${base}/update`, { method: "POST", body: JSON.stringify({ cwd: folder }) });
            if (p.update?.same) setCurrent(true); else setPlan(p);
          })}><ArrowUpCircle /> {busy === "update" ? "Reading its source" : "Check for an update"}</button>
          {!confirm && <button type="button" className="k-btn" data-quiet disabled={!!busy} data-testid="unit-remove" onClick={() => setConfirm(true)}><Trash2 /> Remove</button>}
        </div>
        {current && <p className="k-issue mt-3" data-tone="quiet" data-testid="unit-current">Its source holds {u.version}, the version installed.</p>}
        {confirm && (
          <div className="k-issue mt-3 flex flex-wrap items-center gap-2" data-tone="need" data-testid="unit-remove-ask">
            <span className="mr-auto">Remove {u.id}? Its skills, commands, agents, hooks and servers go with it; your own files stay as they are.</span>
            <button type="button" className="k-btn" data-ink disabled={!!busy} data-testid="unit-remove-confirm" onClick={() => act("remove", async () => { await api(base, { method: "DELETE" }); onChange(true); })}>Remove</button>
            <button type="button" className="k-btn" data-quiet onClick={() => setConfirm(false)}>Keep it</button>
          </div>
        )}
        {err && <p className="k-issue mt-3">{err}</p>}
      </ReaderHead>
      <div className="k-reader-body" data-testid="unit-reader" data-id={u.id} data-enabled={u.enabled}>
        <dl className="k-parts" data-testid="unit-parts">
          {u.skills.length > 0 && <Part what="Skills" testid="unit-skills"><Chips names={u.skills} /></Part>}
          {u.commands.length > 0 && <Part what="Commands" testid="unit-commands"><Chips names={u.commands} /></Part>}
          {u.agents.length > 0 && <Part what="Agents" testid="unit-agents"><Chips names={u.agents} /></Part>}
          {!u.skills.length && !u.commands.length && !u.agents.length && <Part what="Parts"><span className="text-caption text-faint">No skills, commands or agents.</span></Part>}
        </dl>
        {u.hooks.length > 0 && (
          <div data-testid="unit-hooks">
            <div className="k-sub k-label">Hooks{u.enabled ? "" : ", not running"}</div>
            <ul className="k-plain-list">{u.hooks.map((h, i) => <li key={i}><b className="font-medium text-fg">{h.event}{h.matcher ? ` (${h.matcher})` : ""}</b> <code className="font-mono text-micro">{h.what}</code></li>)}</ul>
          </div>
        )}
        {u.mcp.length > 0 && (
          <div data-testid="unit-servers">
            <div className="k-sub k-label">MCP servers</div>
            {u.mcp.map((m) => (
              <div key={m.name} className="k-server-row" data-testid="unit-mcp" data-name={m.label} data-state={m.state}>
                <MarkDot m={mcpMarkOf(m.state)} label={m.state} />
                <span className="shrink-0 whitespace-nowrap font-medium">{m.label}</span>
                <code className="min-w-0 truncate font-mono text-micro text-faint" title={m.what}>{tilde(m.what)}</code>
                <span className="ml-auto shrink-0 whitespace-nowrap text-caption tabular-nums text-muted">{m.state === "ready" ? plural(m.tools.length, "tool") : m.state.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        )}
        <NotTaken items={u.not_taken} notes={u.notes} testid="unit" />
      </div>
    </>
  );
}
