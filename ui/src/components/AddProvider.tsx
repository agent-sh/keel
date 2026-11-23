// Adding (or editing) a provider by hand: pick a starting point (a local
// server, a blank compatible endpoint, one of the catalog's hosted providers,
// a plan sign-in), fill in the address and where the key is, test the
// connection (the address, the key, the models it offers), save. Asking one of
// its models for a word is a second action of its own: it costs tokens. A typed
// key goes to the system keyring; the endpoint file only names it.
import { Dialog } from "@base-ui/react/dialog";
import { Check, CircleAlert, KeyRound, Loader2, Plus, Radar, Search, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { actions, api, failed } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { Segmented } from "./Settings.tsx";
import { Select } from "./Select.tsx";

type Wire = "chat_completions" | "openai_responses" | "anthropic_messages" | "gemini_generate_content";
type Template = { id: string; label: string; group: "local" | "hosted"; wire: Wire; base_url: string; key_env?: string; billing?: string; catalog?: string; note?: string; doc?: string; models?: number };
type Setup = { local: Template[]; hosted: Template[]; taken: string[]; plans: { id: string; label: string; available: boolean; detail?: string; sign_in?: { command?: string; route?: string } }[]; keyring: { service: string; ready: boolean }; dir: string };
type Step = { id: string; ok: boolean; detail: string; problem?: string; fix?: string };
type TestResult = { ok: boolean; steps: Step[]; models: { model: string; name?: string }[]; server?: string; suggest?: { base_url: string } };
type KeyMode = "none" | "env" | "keyring";
type Form = {
  id: string; label: string; wire: Wire; base_url: string; key: KeyMode; key_env: string; key_cred: string; secret: string;
  auth: string; billing: string; catalog: string; headers: { name: string; value: string }[]; models: string; note?: string; doc?: string;
};

const BLANK: Form = { id: "", label: "", wire: "chat_completions", base_url: "", key: "env", key_env: "", key_cred: "", secret: "", auth: "", billing: "per_token", catalog: "", headers: [], models: "" };

const WIRES: { value: Wire; label: string }[] = [
  { value: "chat_completions", label: "OpenAI chat" },
  { value: "openai_responses", label: "Responses" },
  { value: "anthropic_messages", label: "Anthropic" },
  { value: "gemini_generate_content", label: "Gemini" },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function fromTemplate(t: Template, taken: string[]): Form {
  let id = slug(t.id);
  for (let i = 2; taken.includes(id); i++) id = `${slug(t.id)}-${i}`;
  const keyless = t.group === "local" && !t.key_env;
  return { ...BLANK, id, label: t.label, wire: t.wire, base_url: t.base_url, key: keyless ? "none" : "env", key_env: t.key_env ?? "", billing: t.billing ?? "per_token", catalog: t.catalog ?? "", note: t.note, doc: t.doc };
}

function fromConfig(c: any): Form {
  return {
    ...BLANK, id: c.id, label: c.label ?? "", wire: c.wire ?? "chat_completions", base_url: c.base_url, auth: c.auth ?? "",
    key: c.key_env ? "env" : c.key_cred ? "keyring" : "none", key_env: c.key_env ?? "", key_cred: c.key_cred ?? "",
    billing: c.billing ?? "per_token", catalog: c.catalog ?? "", models: (c.models ?? []).join(", "),
    headers: Object.entries<string>(c.headers ?? {}).map(([name, value]) => ({ name, value })),
  };
}

// The body the daemon takes: only what the form says, the key by name.
function toConfig(f: Form, keep?: any) {
  const headers = Object.fromEntries(f.headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value.trim()]));
  return {
    ...(keep ?? {}),
    id: f.id, label: f.label || undefined, wire: f.wire, base_url: f.base_url.trim(),
    key_env: f.key === "env" ? f.key_env || undefined : undefined,
    key_cred: f.key === "keyring" ? f.key_cred || undefined : undefined,
    auth: f.key === "none" ? undefined : f.auth || undefined,
    billing: f.billing === "per_token" ? undefined : f.billing, catalog: f.catalog || undefined,
    headers: Object.keys(headers).length ? headers : undefined,
    models: f.models.split(/[\s,]+/).filter(Boolean),
  };
}

// ---- open from anywhere ----

let openState: { edit?: string } | null = null;
const subs = new Set<() => void>();
export const openAddProvider = (edit?: string) => { openState = { edit }; subs.forEach((f) => f()); };
const closeAdd = () => { openState = null; subs.forEach((f) => f()); };

export function AddProviderHost() {
  const s = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => openState);
  return (
    <Dialog.Root open={!!s} onOpenChange={(o) => !o && closeAdd()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="add-provider"
          className="fixed inset-x-4 top-[5vh] bottom-[5vh] z-50 mx-auto flex max-w-5xl flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-3 transition-[transform,opacity] duration-200 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0"
        >
          {s && <AddProvider key={s.edit ?? ""} edit={s.edit} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const field = "h-8 w-full rounded-md border border-line-strong bg-raised px-2.5 text-ui outline-none placeholder:text-faint focus:border-accent";
const label = "k-label mb-1 block";

function Label({ text, hint, children }: { text: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={label}>{text}</span>
      {children}
      {hint && <span className="mt-1 block text-micro text-faint">{hint}</span>}
    </label>
  );
}

function Starts({ setup, pick, chosen }: { setup: Setup | null; pick: (t: Template | "blank") => void; chosen?: string }) {
  const [q, setQ] = useState("");
  const [scan, setScan] = useState<{ busy: boolean; found?: { template: string; label: string; base_url: string; models: string[]; configured?: string }[] }>({ busy: false });
  const hosted = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all = setup?.hosted ?? [];
    return (t ? all.filter((x) => `${x.id} ${x.label}`.toLowerCase().includes(t)) : all).slice(0, t ? 60 : 24);
  }, [setup, q]);
  // A hosted provider already set up (a preset, or one added before) opens its own
  // settings. So does a server the scan found at the address of an endpoint that
  // is set up, under whatever id that endpoint has (`found.configured`).
  const row = (t: Template, extra?: string, found?: { configured?: string }) => {
    const had = found ? found.configured : t.group === "hosted" && setup?.taken.includes(t.id) ? t.id : undefined;
    return (
    <button
      key={`${found ? "found" : t.group}-${t.id}-${t.base_url}`}
      type="button"
      data-testid="provider-start"
      data-start={t.id}
      onClick={() => (had ? openAddProvider(had) : pick(t))}
      className={cn("flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-hover", chosen === t.id && "k-picked")}
    >
      <span className="truncate text-ui text-fg">{t.label}</span>
      <span className="ml-auto shrink-0 truncate text-micro text-faint">{had ? (found ? `set up as ${had}: edit` : "set up: edit") : extra ?? (t.base_url ? t.base_url.replace(/^https?:\/\//, "") : "address in its docs")}</span>
    </button>
    );
  };
  const runScan = async () => {
    setScan({ busy: true });
    try { setScan({ busy: false, found: (await api<any>("/api/providers/scan", { method: "POST", body: "{}" })).found }); }
    catch (e) { failed(e, { at: "scan" }); setScan({ busy: false, found: [] }); }
  };
  const head = (t: string) => <div className="px-2.5 pt-4 pb-1 k-label first:pt-1">{t}</div>;
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto border-r border-line bg-sunken p-2" data-testid="provider-starts">
      {head("Compatible endpoint")}
      <button type="button" data-testid="provider-start" data-start="blank" onClick={() => pick("blank")} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui hover:bg-hover", chosen === "blank" && "bg-hover")}>
        <Plus className="size-3.5 text-faint" /> Any OpenAI, Anthropic or Gemini compatible server
      </button>
      {head("On this machine")}
      <button type="button" data-testid="provider-scan" onClick={runScan} disabled={scan.busy} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-ui text-accent-ink hover:bg-hover disabled:opacity-60">
        {scan.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />} Find running servers
      </button>
      {scan.found && !scan.found.length && <div className="k-empty px-2.5 py-1">Nothing answers at the usual ports.</div>}
      {scan.found?.map((f) => {
        const t = setup?.local.find((x) => x.id === f.template);
        return t ? row({ ...t, base_url: f.base_url }, `${f.models.length} model${f.models.length === 1 ? "" : "s"} running`, { configured: f.configured }) : null;
      })}
      {setup?.local.map((t) => row(t))}
      {setup?.plans.length ? head("Plan sign-in") : null}
      {setup?.plans.map((p) => (
        <div key={p.id} className="flex items-baseline gap-2 px-2.5 py-1.5 text-ui" data-testid="provider-plan">
          <span className="text-fg">{p.label}</span>
          <span className="ml-auto truncate text-micro text-faint">{p.available ? "signed in" : p.sign_in?.command ? `run ${p.sign_in.command}` : "sign in on its row"}</span>
        </div>
      ))}
      {head(`Hosted and aggregators (${setup?.hosted.length ?? 0})`)}
      <div className="mx-1 mb-1 flex h-8 items-center gap-2 rounded-md border border-line bg-raised px-2 text-faint">
        <Search className="size-3.5" />
        <input data-testid="provider-start-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog" className="w-full bg-transparent text-ui text-fg outline-none placeholder:text-faint" />
      </div>
      {hosted.map((t) => row(t))}
    </div>
  );
}

function Steps({ r, onUse }: { r: TestResult; onUse: (url: string) => void }) {
  return (
    <div className="mt-4 rounded-lg border border-line bg-raised" data-testid="provider-test">
      {r.steps.map((s) => (
        <div key={s.id} className="flex gap-2.5 border-b border-line px-3 py-2 last:border-0" data-testid="provider-test-step" data-step={s.id} data-ok={s.ok}>
          {s.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />}
          <div className="min-w-0 text-ui">
            <span className="k-label mr-2">{s.id}</span>
            <span className="break-words text-fg">{s.detail}</span>
            {!s.ok && s.problem && <div className="mt-0.5 text-danger">{s.problem}</div>}
            {!s.ok && s.fix && <div className="mt-0.5 text-muted">{s.fix}</div>}
          </div>
        </div>
      ))}
      {r.suggest && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-ui">
          <span className="text-muted">It answered at <code className="rounded-xs bg-code px-1 font-mono">{r.suggest.base_url}</code>.</span>
          <button type="button" data-testid="provider-use-suggest" onClick={() => onUse(r.suggest!.base_url)} className="ml-auto h-7 rounded-md border border-line-strong px-2.5 text-ui font-medium hover:bg-hover">Use it</button>
        </div>
      )}
    </div>
  );
}

function AddProvider({ edit }: { edit?: string }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [kept, setKept] = useState<any>(null); // fields of an edited endpoint the form does not show (model overrides, extra_body)
  const [chosen, setChosen] = useState<string>();
  const [test, setTest] = useState<TestResult | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "model" | "save" | "remove">("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<Setup>("/api/providers/setup").then(setSetup).catch((e) => setError(failed(e, { at: "providers setup" })));
    if (edit) api<any>(`/api/providers/endpoints/${encodeURIComponent(edit)}`).then((r) => {
      const { source: _s, ...c } = r.config;
      setForm(fromConfig(c));
      setKept({ model: c.model, extra_body: c.extra_body, effort_field: c.effort_field, replay_reasoning: c.replay_reasoning, system_prompt: c.system_prompt, session_header: c.session_header, listing: c.listing, price: c.price, stream_idle_timeout_ms: c.stream_idle_timeout_ms });
    }).catch((e) => setError(failed(e, { at: "reading an endpoint" })));
  }, [edit]);

  const set = (p: Partial<Form>) => { setForm((f) => (f ? { ...f, ...p } : f)); setTest(null); };
  const pick = (t: Template | "blank") => {
    setChosen(t === "blank" ? "blank" : t.id);
    setForm(t === "blank" ? { ...BLANK } : fromTemplate(t, setup?.taken ?? []));
    setTest(null); setError(""); setModel("");
  };

  const runTest = async () => {
    if (!form) return;
    setBusy("test"); setError("");
    try {
      const r = await api<TestResult>("/api/providers/test", { method: "POST", body: JSON.stringify({ config: toConfig(form, kept), key: form.key === "keyring" ? form.secret || undefined : undefined }) });
      setTest(r);
      if (r.models[0] && !r.models.some((m) => m.model === model)) setModel(r.models[0].model);
    } catch (e) { setError(failed(e, { at: "testing a provider" })); } finally { setBusy(""); }
  };

  // One short request to the model picked: its step joins the steps the connection test left.
  // It goes to the address the connection test answered at (the /v1 it found), where the listing came from.
  const testModel = async () => {
    if (!form || !test || !model) return;
    setBusy("model"); setError("");
    try {
      const r = await api<TestResult>("/api/providers/test", { method: "POST", body: JSON.stringify({ config: { ...toConfig(form, kept), ...(test.suggest ? { base_url: test.suggest.base_url } : {}) }, key: form.key === "keyring" ? form.secret || undefined : undefined, model, only: "model" }) });
      const asked = r.steps.filter((s) => s.id === "model");
      // The address or the key failed this time: what it said replaces the earlier steps.
      const steps = asked.length ? [...test.steps.filter((s) => s.id !== "model"), ...asked] : r.steps;
      setTest({ ...test, steps, ok: steps.every((s) => s.ok) });
    } catch (e) { setError(failed(e, { at: "testing a model" })); } finally { setBusy(""); }
  };

  const save = async () => {
    if (!form) return;
    setBusy("save"); setError("");
    try {
      await api(`/api/providers/endpoints/${encodeURIComponent(form.id)}`, { method: "PUT", body: JSON.stringify({ config: toConfig(form, kept), key: form.key === "keyring" ? form.secret || undefined : undefined }) });
      await Promise.all([actions.loadProviders(), actions.loadModels()]);
      closeAdd();
    } catch (e) { setError(failed(e, { at: "saving a provider" })); } finally { setBusy(""); }
  };

  const remove = async () => {
    if (!edit) return;
    setBusy("remove");
    try {
      await api(`/api/providers/endpoints/${encodeURIComponent(edit)}?forget_key=1`, { method: "DELETE" });
      await Promise.all([actions.loadProviders(), actions.loadModels()]);
      closeAdd();
    } catch (e) { setError(failed(e, { at: "removing a provider" })); } finally { setBusy(""); }
  };

  const keyHint = form?.key === "none" ? "Nothing is sent: a local server, or a gateway that signs requests itself."
    : form?.key === "env" ? "The daemon reads this variable from its environment."
    : setup?.keyring.ready === false ? "This machine has no system keyring: use a variable instead."
    : `Saved in the system keyring (service ${setup?.keyring.service ?? "keel-bun"}); the file holds only the name.`;

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <Server className="size-4 text-faint" />
        <Dialog.Title className="font-semibold">{edit ? `Edit ${edit}` : "Add a provider"}</Dialog.Title>
        {setup && <span className="truncate text-caption text-faint">Saved to {setup.dir}/{form?.id || "<id>"}.toml</span>}
        <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" aria-label="Close"><X className="size-4" /></Dialog.Close>
      </div>
      <div className={cn("grid min-h-0 flex-1", edit ? "grid-cols-1" : "grid-cols-[19rem_minmax(0,1fr)]")}>
        {!edit && <Starts setup={setup} pick={pick} chosen={chosen} />}
        <div className="min-h-0 overflow-y-auto px-6 pt-5">
          {!form && (
            <div className="k-empty p-6">
              <div>
                <b>No provider chosen</b>
                Pick a starting point. Every field stays editable; the models come from the endpoint's own listing.
              </div>
            </div>
          )}
          {form && (
            <form className="mx-auto max-w-2xl space-y-4" data-testid="provider-form" onSubmit={(e) => { e.preventDefault(); runTest(); }}>
              {form.note && <p className="rounded-md border border-line bg-sunken px-3 py-2 text-caption text-muted">{form.note}</p>}
              <div className="grid grid-cols-2 gap-3">
                <Label text="Name"><input className={field} data-testid="provider-label" value={form.label} onChange={(e) => set({ label: e.target.value, ...(edit || chosen !== "blank" ? {} : { id: slug(e.target.value) }) })} placeholder="My server" /></Label>
                <Label text="Id" hint="Models are named id:model."><input className={cn(field, "font-mono")} data-testid="provider-id" value={form.id} disabled={!!edit} onChange={(e) => set({ id: slug(e.target.value) })} placeholder="my-server" /></Label>
              </div>
              <div>
                <span className={label}>Speaks</span>
                <Segmented<Wire> label="Wire" value={form.wire} onChange={(w) => set({ wire: w })} options={WIRES} />
              </div>
              <Label text="Base URL" hint={form.wire === "anthropic_messages" ? "The part before /v1/messages." : form.wire === "gemini_generate_content" ? "The part before /v1beta/models." : "The part before /chat/completions, usually ending in /v1."}>
                <input className={cn(field, "font-mono")} data-testid="provider-base-url" value={form.base_url} onChange={(e) => set({ base_url: e.target.value })} placeholder="http://127.0.0.1:8000/v1" />
              </Label>
              <div>
                <span className={label}>Key</span>
                <Segmented<KeyMode> label="Key" value={form.key} onChange={(k) => set({ key: k })} options={[{ value: "none", label: "None" }, { value: "env", label: "Variable" }, { value: "keyring", label: "Keyring" }]} />
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {form.key === "env" && <input className={cn(field, "font-mono")} data-testid="provider-key-env" value={form.key_env} onChange={(e) => set({ key_env: e.target.value.trim() })} placeholder="MY_SERVER_API_KEY" />}
                  {form.key === "keyring" && (
                    <>
                      <input className={cn(field, "font-mono")} data-testid="provider-key-cred" value={form.key_cred} onChange={(e) => set({ key_cred: e.target.value.trim() })} placeholder={`${form.id || "id"}-api-key`} />
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-faint" />
                        <input type="password" autoComplete="off" className={cn(field, "pl-8")} data-testid="provider-key-secret" value={form.secret} onChange={(e) => set({ secret: e.target.value })} placeholder={edit ? "Paste a new key to replace it" : "Paste the key to save it"} />
                      </div>
                    </>
                  )}
                  {form.key !== "none" && (
                    <Select className={field} data-testid="provider-auth" value={form.auth} onChange={(e) => set({ auth: e.target.value })} aria-label="Key header">
                      <option value="">Key header: the wire's own</option>
                      <option value="bearer">Authorization: Bearer</option>
                      <option value="x-api-key">x-api-key</option>
                      <option value="x-goog-api-key">x-goog-api-key</option>
                    </Select>
                  )}
                </div>
                <div className="mt-1 text-micro text-faint">{keyHint}</div>
              </div>
              <div>
                <span className={label}>Billing</span>
                <Segmented label="Billing" value={form.billing} onChange={(b) => set({ billing: b })} options={[{ value: "per_token", label: "Per token" }, { value: "subscription", label: "Plan" }, { value: "free", label: "Free" }]} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Label text="Catalog section" hint="The models.dev section with its prices and windows. Prices can also be set per model.">
                  <input className={cn(field, "font-mono")} data-testid="provider-catalog" value={form.catalog} onChange={(e) => set({ catalog: e.target.value.trim() })} placeholder="none" />
                </Label>
                <Label text="Models by hand" hint="Offered only when the endpoint has no listing.">
                  <input className={cn(field, "font-mono")} data-testid="provider-models" value={form.models} onChange={(e) => set({ models: e.target.value })} placeholder="model-a, model-b" />
                </Label>
              </div>
              <div>
                <span className={label}>Headers</span>
                {form.headers.map((h, i) => (
                  <div key={i} className="mb-1.5 grid grid-cols-[12rem_minmax(0,1fr)_2rem] gap-2">
                    <input className={cn(field, "font-mono")} value={h.name} placeholder="x-title" onChange={(e) => set({ headers: form.headers.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                    <input className={cn(field, "font-mono")} value={h.value} placeholder="Keel, or {env:TEAM_KEY}" onChange={(e) => set({ headers: form.headers.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)) })} />
                    <button type="button" aria-label="Remove header" onClick={() => set({ headers: form.headers.filter((_, k) => k !== i) })} className="grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
                <button type="button" onClick={() => set({ headers: [...form.headers, { name: "", value: "" }] })} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui text-accent-ink hover:bg-hover"><Plus className="size-3.5" /> Header</button>
                <div className="text-micro text-faint">A secret part is written as {"{env:NAME}"} or {"{keyring:NAME}"} and filled in when sent.</div>
              </div>
              {test && <Steps r={test} onUse={(u) => set({ base_url: u })} />}
              {error && <p className="text-ui text-danger" data-testid="provider-error">{error}</p>}
              <div className="sticky bottom-0 -mx-6 flex items-center gap-2 border-t border-line bg-bg px-6 py-3">
                <button type="submit" data-testid="provider-test-run" disabled={!!busy || !form.base_url} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50">
                  {busy === "test" && <Loader2 className="size-3.5 animate-spin" />} Test connection
                </button>
                {test?.models.length ? (
                  <div className="flex items-center" data-testid="provider-test-model-group">
                    <Select className={cn(field, "w-56 rounded-r-none")} data-testid="provider-test-model" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model to ask">
                      {test.models.slice(0, 500).map((m) => <option key={m.model} value={m.model}>{m.name ?? m.model}</option>)}
                    </Select>
                    <button type="button" data-testid="provider-test-model-run" onClick={testModel} disabled={!!busy || !model} title="Sends one short request to this model" className="-ml-px inline-flex h-8 shrink-0 items-center gap-1.5 rounded-r-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50">
                      {busy === "model" && <Loader2 className="size-3.5 animate-spin" />} Ask it
                    </button>
                  </div>
                ) : null}
                {edit && <button type="button" data-testid="provider-remove" onClick={remove} disabled={!!busy} className="h-8 rounded-md px-3 text-ui text-danger hover:bg-hover disabled:opacity-50">Remove</button>}
                <button type="button" data-testid="provider-save" onClick={save} disabled={!!busy || !form.id || !form.base_url} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">
                  {busy === "save" && <Loader2 className="size-3.5 animate-spin" />} {!test || test.ok ? "Save" : "Save anyway"}
                </button>
              </div>
              {form.doc && <a className="block text-caption text-accent-ink hover:underline" href={form.doc} target="_blank" rel="noreferrer">Its documentation</a>}
            </form>
          )}
        </div>
      </div>
    </>
  );
}
