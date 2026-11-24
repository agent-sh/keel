// Settings > Plugins, the plugins installed as one unit: what each brought,
// on and off, an update said before it is applied, removal, and the install
// field with its consent step (src/plugins/installer.ts). Nothing a plugin
// runs starts before the owner said yes to its lines here.
import { ArrowUpCircle, KeyRound, PackagePlus, Save, Trash2, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, failed } from "../../lib/store.ts";
import { fmtSize } from "../../lib/utils.ts";
import { Select } from "../Select.tsx";
import { MarkDot, ReaderHead, tail, tilde, Toggle, type Mark } from "./kit.tsx";

// A setting of a plugin (its userConfig option); `value` is never sent for a sensitive one.
type Setting = {
  key: string; type: "string" | "number" | "boolean" | "directory" | "file"; title: string; description: string;
  required?: boolean; default?: string | number | boolean | string[]; options?: string[]; multiple?: boolean; sensitive?: boolean; min?: number; max?: number;
  value?: string | number | boolean | string[] | null; set?: boolean;
};
export type UnitView = {
  id: string; name: string; version: string; description: string | null; author: string | null; homepage: string | null;
  source: string; entry: string | null; commit: string | null; dir: string; data: string; enabled: boolean; installed: number; updated: number; offered_by: string | null;
  skills: string[]; commands: string[]; agents: string[]; hooks: { event: string; matcher: string | null; what: string }[];
  mcp: { name: string; label: string; what: string; state: string; tools: string[]; error: string | null }[];
  not_taken: { part: string; why: string }[]; notes: string[]; runs: string[];
  settings?: Setting[]; waiting?: { key: string; title: string; why: string }[];
};
export type Offer = { key: string; plugin: string; marketplace: string; from: string; input?: string; installed?: string; problem?: string };
export type Units = { plugins: UnitView[]; offers: Offer[]; home: string; registry: string };
type PlanView = {
  kind: "plugin"; token: string; input: string; id: string; name: string; version: string; description?: string; author?: string; root: string;
  skills: string[]; commands: string[]; agents: string[]; hooks: { event: string; matcher?: string; what: string }[]; mcp: { name: string; label: string; what: string }[];
  runs: string[]; consent: string | null; not_taken: { part: string; why: string }[]; notes: string[]; problems: string[];
  fetched: string[]; bytes: number;
  settings?: Setting[];
  update?: { id: string; from: string; changes: string[]; runs_changed: boolean; same: boolean };
};
type MarketView = { kind: "marketplace"; token: string; input: string; name: string; owner?: string; description?: string; plugins: { name: string; description?: string; version?: string; from: string; unsupported?: string }[] };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// Where a plugin comes from, as the owner reads it: a local repository by its folder.
export const sourceLabel = (s: string) => (s.startsWith("file://") ? `${tilde(s.slice(7))} (git)` : tilde(s));
export const unitMark = (u: UnitView): Mark => (!u.enabled ? "off" : u.waiting?.length ? "need" : u.mcp.some((m) => m.state === "error") ? "fail" : u.mcp.some((m) => m.state === "connecting") ? "work" : "on");
export const unitBrings = (u: { skills: unknown[]; commands: unknown[]; agents: unknown[]; hooks: unknown[]; mcp: unknown[] }) =>
  [[u.skills.length, "skill"], [u.commands.length, "command"], [u.agents.length, "agent"], [u.hooks.length, "hook"], [u.mcp.length, "MCP server"]].filter(([n]) => n).map(([n, w]) => plural(n as number, w as string)).join(", ") || "nothing Keel runs";
const mcpMarkOf = (state: string): Mark => (state === "ready" || state === "idle" ? "on" : state === "disabled" ? "off" : state === "connecting" ? "work" : state === "needs_auth" || state === "waiting" ? "need" : "fail");
const shownValue = (v: Setting["default"]) => (Array.isArray(v) ? v.join(", ") : String(v));
const flags = (o: Setting) => [o.required && "required", o.sensitive && "sensitive", o.default !== undefined && `default ${shownValue(o.default)}`].filter(Boolean).join(" · ");

// The settings a plugin asks for, as the plan says them: given after it is installed.
function PlanSettings({ settings }: { settings: Setting[] }) {
  return (
    <div data-testid="plan-settings">
      <div className="k-sub k-label">Settings it asks for</div>
      <p className="text-caption text-muted">You give their values after it is installed. A sensitive one goes to the system keyring, never to a file.</p>
      <ul className="k-plugset-list">
        {settings.map((o) => (
          <li key={o.key} data-testid="plan-setting" data-key={o.key}>
            <b>{o.title}</b> <code className="font-mono text-micro text-faint">{o.key}</code>{flags(o) && <span className="text-micro text-faint"> · {flags(o)}</span>}
            {o.description && <p>{o.description}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// The owner's values for a plugin's settings. Only what changed is sent; a
// sensitive value is typed, saved to the keyring and never shown back.
function UnitSettings({ u, folder, onChange }: { u: UnitView; folder: string; onChange: () => void }) {
  const settings = u.settings ?? [];
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const shown = (o: Setting): string | boolean => {
    if (o.key in draft) return draft[o.key]!;
    if (o.sensitive) return "";
    const v = o.value ?? null;
    if (o.type === "boolean") return v === null ? o.default === true : v === true;
    return v === null ? "" : Array.isArray(v) ? v.join("\n") : String(v);
  };
  const set = (k: string, v: string | boolean) => { setSaved(false); setDraft((d) => ({ ...d, [k]: v })); };
  const save = async (values: Record<string, string | boolean | null>) => {
    setBusy(true); setErr("");
    try {
      await api(`/api/plugins/installed/${encodeURIComponent(u.id)}/settings`, { method: "POST", body: JSON.stringify({ values, cwd: folder }) });
      setDraft({}); setSaved(true); onChange();
    } catch (e) { setErr(failed(e, { at: "plugin settings" })); } finally { setBusy(false); }
  };
  const changed = Object.keys(draft).filter((k) => !(settings.find((o) => o.key === k)?.sensitive && draft[k] === ""));
  const field = "h-ctl-lg w-full rounded-sm border border-line-strong bg-bg px-2.5 text-ui";
  return (
    <div data-testid="unit-settings">
      <div className="k-sub k-label">Settings</div>
      <form className="k-form k-plugset-form" noValidate onSubmit={(e) => { e.preventDefault(); if (changed.length) void save(Object.fromEntries(changed.map((k) => [k, draft[k]!]))); }}>
        {settings.map((o) => {
          const v = shown(o);
          const id = `setting-${u.id}-${o.key}`;
          const missing = u.waiting?.some((w) => w.key === o.key);
          return (
            <div key={o.key} className="k-plugset" data-testid="setting" data-key={o.key} data-missing={missing || undefined}>
              <label htmlFor={id}>
                <span className="flex items-baseline gap-2">
                  <span className="text-fg">{o.title}</span>
                  {o.required && <span className="k-chip" data-tone={missing ? "need" : undefined}>required</span>}
                  {o.sensitive && <span className="k-chip"><KeyRound /> {o.set ? "saved in the keyring" : "sensitive"}</span>}
                </span>
              </label>
              {o.type === "boolean" ? (
                <div className="k-form-row"><Toggle testid="setting-input" on={v === true} label={o.title} onChange={(on) => set(o.key, on)} /><span className="text-caption text-muted">{v === true ? "on" : "off"}</span></div>
              ) : o.options ? (
                <Select value={String(v)} onChange={(e) => set(o.key, e.target.value)} aria-label={o.title} data-testid="setting-input" className={field}>
                  {!o.required && <option value="">{o.default !== undefined ? `The default (${shownValue(o.default)})` : "None"}</option>}
                  {o.required && v === "" && <option value="" disabled>Pick one</option>}
                  {o.options.map((x) => <option key={x} value={x}>{x}</option>)}
                </Select>
              ) : o.multiple ? (
                <textarea id={id} data-testid="setting-input" value={String(v)} onChange={(e) => set(o.key, e.target.value)} placeholder={o.default !== undefined ? shownValue(o.default) : "One a line"} />
              ) : (
                <input
                  id={id} data-testid="setting-input" autoComplete="off" spellCheck={false}
                  type={o.sensitive ? "password" : o.type === "number" ? "number" : "text"}
                  {...(o.type === "number" ? { min: o.min, max: o.max } : {})}
                  data-mono={o.type === "directory" || o.type === "file" || undefined}
                  value={String(v)} onChange={(e) => set(o.key, e.target.value)}
                  placeholder={o.sensitive ? (o.set ? "Saved: type to replace it" : "Type it to save it to the keyring") : o.default !== undefined ? `The default: ${shownValue(o.default)}` : o.type === "directory" ? "/full/path/to/a/folder" : o.type === "file" ? "/full/path/to/a/file" : ""}
                />
              )}
              <p className="k-form-hint">{o.description}{o.type === "number" && (o.min !== undefined || o.max !== undefined) ? ` From ${o.min ?? "any"} to ${o.max ?? "any"}.` : ""}</p>
              {o.sensitive && o.set && <div><button type="button" className="k-btn" data-quiet disabled={busy} data-testid="setting-forget" onClick={() => save({ [o.key]: null })}><Trash2 /> Forget it</button></div>}
            </div>
          );
        })}
        {err && <p className="k-form-err" data-testid="settings-error">{err}</p>}
        <div className="k-form-row">
          <button type="submit" className="k-btn" data-ink disabled={busy || !changed.length} data-testid="settings-save"><Save /> {busy ? "Saving" : "Save"}</button>
          {saved && !changed.length && <span className="text-caption text-muted" data-testid="settings-saved">Saved</span>}
        </div>
      </form>
    </div>
  );
}

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

// What of Keel's environment the programs get: a command hook all of it, a server it
// starts all but the names that look like credentials or a provider's or
// Keel's settings (the MCP manager's serverEnv).
const envWords = (p: PlanView) => {
  const hook = p.hooks.length > 0, server = p.mcp.length > 0;
  if (hook && server) return "A command hook gets Keel's environment; a server started as a program gets it without the names that look like credentials or a provider's or Keel's settings.";
  if (hook) return "A command hook gets Keel's environment.";
  if (server) return "A server started as a program gets Keel's environment, without the names that look like credentials or a provider's or Keel's settings.";
  return "";
};

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
          {update.changes.length ? <ul className="k-plain-list">{update.changes.map((c, i) => <li key={i} className="font-mono text-micro">{c}</li>)}</ul> : <p className="text-caption text-muted">The same parts and the same commands, in a new copy.</p>}
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
          <p>{asks ? "Each line starts a program with your files and shell: a hook at its event, a server while the plugin is on. Nothing of it runs before you say yes." : "These lines are the ones you said yes to: no new yes is needed."} {envWords(plan) && <span data-testid="plan-env">{envWords(plan)} </span>}Its folder will be <code className="font-mono">{tilde(plan.root)}</code>.</p>
          {/* Two hooks can run the same line: each line is its own row. */}
          <ol>{plan.runs.map((r, i) => <li key={i} data-testid="plan-run">{r}</li>)}</ol>
        </section>
      )}
      {plan.settings && plan.settings.length > 0 && <PlanSettings settings={plan.settings} />}
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
    path={sourceLabel(p.input)}
    facts={[["Version", p.update ? `${p.update.from} to ${p.version}` : p.version], ...(p.author ? [["Author", p.author] as [string, string]] : []), ["Brings", unitBrings(p)], ["Size", fmtSize(p.bytes)], ...extra]}
  >
    <ul className="k-plain-list mt-2.5" data-testid="plan-fetched">{p.fetched.map((f) => <li key={f}>{f.replace(/(folder |from )(\/\S+)/, (_m, w, path) => `${w}${tilde(path)}`)}</li>)}</ul>
  </ReaderHead>
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
          ["Source", <span title={u.source}>{tail(sourceLabel(u.source), 56)}{u.entry ? ` · ${u.entry}` : ""}</span>],
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
        {u.enabled && u.waiting && u.waiting.length > 0 && (
          <p className="k-issue" data-tone="need" data-testid="unit-waiting">
            Its servers and hooks wait for {u.waiting.length === 1 ? "a value" : "values"}: {u.waiting.map((w) => `${w.title} (${w.why})`).join(", ")}. Give {u.waiting.length === 1 ? "it" : "them"} below.
          </p>
        )}
        {u.settings && u.settings.length > 0 && <UnitSettings key={`${u.id}-${u.updated}`} u={u} folder={folder} onChange={() => onChange()} />}
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
                <span className="ml-auto shrink-0 whitespace-nowrap text-caption tabular-nums text-muted">{m.state === "ready" || m.state === "idle" ? plural(m.tools.length, "tool") : m.state.replace("_", " ")}</span>
              </div>
            ))}
          </div>
        )}
        <NotTaken items={u.not_taken} notes={u.notes} testid="unit" />
      </div>
    </>
  );
}
