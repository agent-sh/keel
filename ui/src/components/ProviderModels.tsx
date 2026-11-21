// One provider's models with what each can do and costs: the window, tool
// calls, images, thinking and the prompt cache, each with where it is known
// from (the owner, a probe, the listing, the catalog). Probe asks the model;
// an endpoint's models take the owner's own window, capabilities and price.
import { Loader2, Pencil, Radar, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { actions, api, failed, useStore, type ListedModel } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";
import { Select } from "./Select.tsx";

type Cap = "tools" | "images" | "reasoning" | "caching";
const CAPS: { k: Cap; label: string }[] = [
  { k: "tools", label: "Tools" }, { k: "images", label: "Images" }, { k: "reasoning", label: "Thinks" }, { k: "caching", label: "Cache" },
];
const FROM: Record<string, string> = { owner: "you said so", probe: "a probe found it", listing: "the endpoint's listing says so", catalog: "the catalog says so" };

function Chip({ m, k, label }: { m: ListedModel; k: Cap; label: string }) {
  const v = m[k];
  const from = m.known_from?.[k];
  return (
    <span
      data-cap={k}
      data-value={v === undefined ? "unknown" : String(v)}
      title={v === undefined ? `${label}: not known` : `${label}: ${v ? "yes" : "no"}, ${FROM[from ?? ""] ?? ""}`}
      className={cn("rounded-xs px-1.5 py-px text-micro", v === true ? "bg-sunken text-fg" : v === false ? "text-faint line-through" : "text-faint")}
    >
      {label}{v === undefined ? "?" : ""}
    </span>
  );
}

const price = (m: ListedModel) =>
  m.billing === "subscription" ? "plan" : !m.price ? "no price" : m.price.input === 0 && m.price.output === 0 ? "free" : `$${m.price.input} / $${m.price.output}`;

type Override = { context?: number; tools?: boolean; images?: boolean; reasoning?: boolean; price?: { input: number; output: number; cache_read?: number } };

function Editor({ m, provider, onDone }: { m: ListedModel; provider: string; onDone: () => void }) {
  const [o, setO] = useState({
    context: m.context_assumed ? "" : String(m.context), input: m.price ? String(m.price.input) : "", output: m.price ? String(m.price.output) : "",
    cache_read: m.price?.cache_read !== undefined ? String(m.price.cache_read) : "",
    tools: m.known_from?.tools === "owner" ? String(m.tools) : "", images: m.known_from?.images === "owner" ? String(m.images) : "",
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErr("");
    try {
      const { config } = await api<any>(`/api/providers/endpoints/${encodeURIComponent(provider)}`);
      const { source: _s, ...c } = config;
      const mine: Override = {};
      if (o.context && Number(o.context) !== m.context) mine.context = Number(o.context);
      if (o.tools) mine.tools = o.tools === "true";
      if (o.images) mine.images = o.images === "true";
      if (o.input !== "" && o.output !== "") mine.price = { input: Number(o.input), output: Number(o.output), ...(o.cache_read !== "" ? { cache_read: Number(o.cache_read) } : {}) };
      const models = { ...(c.model ?? {}) };
      if (Object.keys(mine).length) models[m.model] = mine; else delete models[m.model];
      await api(`/api/providers/endpoints/${encodeURIComponent(provider)}`, { method: "PUT", body: JSON.stringify({ config: { ...c, model: models } }) });
      await actions.loadModels();
      onDone();
    } catch (e) { setErr(failed(e, { at: "saving a model's details" })); } finally { setBusy(false); }
  };
  const input = "h-7 w-full rounded-md border border-line-strong bg-raised px-2 text-ui outline-none focus:border-accent";
  const tri = (k: "tools" | "images", label: string) => (
    <label className="block"><span className="text-micro text-faint">{label}</span>
      <Select className={input} data-testid={`model-${k}`} value={o[k]} onChange={(e) => setO({ ...o, [k]: e.target.value })}>
        <option value="">as found</option><option value="true">yes</option><option value="false">no</option>
      </Select>
    </label>
  );
  return (
    <div className="mt-2 grid grid-cols-6 items-end gap-2 rounded-md border border-line bg-sunken p-2.5" data-testid="model-editor">
      <label className="block"><span className="text-micro text-faint">Window</span><input className={input} inputMode="numeric" value={o.context} onChange={(e) => setO({ ...o, context: e.target.value })} /></label>
      <label className="block"><span className="text-micro text-faint">Input $/M</span><input className={input} data-testid="model-price-input" inputMode="decimal" value={o.input} onChange={(e) => setO({ ...o, input: e.target.value })} /></label>
      <label className="block"><span className="text-micro text-faint">Output $/M</span><input className={input} data-testid="model-price-output" inputMode="decimal" value={o.output} onChange={(e) => setO({ ...o, output: e.target.value })} /></label>
      <label className="block"><span className="text-micro text-faint">Cache read $/M</span><input className={input} inputMode="decimal" value={o.cache_read} onChange={(e) => setO({ ...o, cache_read: e.target.value })} /></label>
      {tri("tools", "Tools")}
      {tri("images", "Images")}
      <div className="col-span-6 flex items-center gap-2">
        {err && <span className="text-caption text-danger">{err}</span>}
        <button type="button" onClick={onDone} className="ml-auto h-7 rounded-md px-2.5 text-ui hover:bg-hover">Cancel</button>
        <button type="button" data-testid="model-editor-save" disabled={busy} onClick={save} className="h-7 rounded-md bg-accent px-2.5 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">Save</button>
      </div>
    </div>
  );
}

export function ProviderModels({ provider, editable }: { provider: string; editable: boolean }) {
  const all = useStore((s) => s.models);
  const [q, setQ] = useState("");
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState("");
  const mine = useMemo(() => all.filter((m) => m.provider === provider), [all, provider]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (t ? mine.filter((m) => `${m.model} ${m.name}`.toLowerCase().includes(t)) : mine).slice(0, 40);
  }, [mine, q]);

  const runProbe = async (m: ListedModel) => {
    setProbing((p) => ({ ...p, [m.id]: true }));
    try {
      const r = await api<any>("/api/providers/probe", { method: "POST", body: JSON.stringify({ model: m.id }) });
      setNotes((n) => ({ ...n, [m.id]: r.result.ok ? `${Object.entries<any>(r.result.found).map(([k, f]) => `${k}: ${f.note}`).join("; ")} (${r.result.usage.input + r.result.usage.output} tokens)` : `No answer: ${r.result.error}` }));
      await actions.loadModels();
    } catch (e) { setNotes((n) => ({ ...n, [m.id]: failed(e, { at: "probe" }) })); } finally { setProbing((p) => ({ ...p, [m.id]: false })); }
  };

  if (!mine.length) return <div className="k-empty py-2">No models listed yet.</div>;
  return (
    <div className="mt-2" data-testid="provider-models">
      {mine.length > 12 && (
        <div className="mb-1 flex h-7 items-center gap-2 rounded-md border border-line bg-sunken px-2 text-faint">
          <Search className="size-3.5" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${mine.length} models`} className="w-full bg-transparent text-ui text-fg outline-none placeholder:text-faint" />
        </div>
      )}
      {shown.map((m) => (
        <div key={m.id} className="border-b border-line py-1.5 last:border-0" data-testid="provider-model" data-model={m.id}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-ui text-fg" title={m.model}>{m.name}</span>
            <span className="shrink-0 text-micro tabular-nums text-faint" title={m.context_assumed ? "not stated: assumed" : undefined}>{fmtTokens(m.context)}{m.context_assumed ? "?" : ""}</span>
            <span className="flex shrink-0 gap-0.5">{CAPS.map((c) => <Chip key={c.k} m={m} k={c.k} label={c.label} />)}</span>
            <span className="ml-auto shrink-0 text-micro tabular-nums text-muted" data-testid="model-price">{price(m)}</span>
            <button type="button" data-testid="model-probe" onClick={() => runProbe(m)} disabled={probing[m.id]} title="Ask the model what it can do (a few short requests)" className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-micro text-accent-ink hover:bg-hover disabled:opacity-50">
              {probing[m.id] ? <Loader2 className="size-3 animate-spin" /> : <Radar className="size-3" />} Probe
            </button>
            {editable && (
              <button type="button" data-testid="model-edit" onClick={() => setEditing(editing === m.id ? "" : m.id)} aria-label={`Edit ${m.name}`} className="grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><Pencil className="size-3" /></button>
            )}
          </div>
          {notes[m.id] && <div className="mt-0.5 text-micro text-muted" data-testid="model-probe-note">{notes[m.id]}</div>}
          {editing === m.id && <Editor m={m} provider={provider} onDone={() => setEditing("")} />}
        </div>
      ))}
      {mine.length > shown.length && <div className="pt-1 text-micro text-faint">{mine.length - shown.length} more: search to find one.</div>}
    </div>
  );
}
