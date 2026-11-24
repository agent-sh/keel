// Settings > Content routes: which providers may see each folder's content
// (src/safety/content-routes.ts), and from the ledger which provider saw which
// session's content, by purpose, held against that rule
// (GET /api/content-routes).
import { RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { INSTEAD, type RoutePurpose } from "../../../src/safety/route-rule.ts";
import type { Seen } from "../../../src/safety/route-seen.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { PathText } from "./PathText.tsx";
import { Card, SettingRow } from "./Settings.tsx";
import { useSettings } from "./StoragePanel.tsx";

type Rule = { default: string[] | null; folders: Record<string, string[]> };
type Report = Seen & { since_ms: number; rule: Rule };

const th = "px-4 py-1.5 font-normal whitespace-nowrap";
const td = "px-4 py-1.5 tabular-nums whitespace-nowrap";

// One toggle per provider; `any` adds the choice of no limit (the default's null).
function Providers({ value, ids, label, onChange, any }: { value: string[] | null; ids: { id: string; label: string }[]; label: string; onChange: (v: string[] | null) => void; any?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex max-w-[36rem] flex-wrap justify-end gap-1.5" data-testid="route-providers">
      {any && (
        <button type="button" role="checkbox" aria-checked={value === null} className="k-chip-pick" onClick={() => onChange(null)} data-testid="route-any">
          <span className="k-chip-pick-name">Any provider</span>
        </button>
      )}
      {ids.map((p) => {
        const on = !!value?.includes(p.id);
        return (
          <button key={p.id} type="button" role="checkbox" aria-checked={on} title={p.id} className="k-chip-pick" data-provider={p.id}
            onClick={() => onChange(on ? value!.filter((x) => x !== p.id) : [...(value ?? []), p.id])}>
            <span className="k-chip-pick-name">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const allowedWords = (a: string[] | null) => (a === null ? "any provider" : a.length ? a.join(", ") : "no provider");

export function ContentRoutes() {
  const [settings, patch] = useSettings();
  const report = useStore((s) => s.providers);
  const labels = useStore((s) => s.providerLabels);
  const sessions = useStore((s) => s.sessions);
  const [seen, setSeen] = useState<Report | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => { setBusy(true); return api<Report>("/api/content-routes").then(setSeen).catch(reportError).finally(() => setBusy(false)); };
  useEffect(() => { if (!report) actions.loadProviders().catch(reportError); void load(); }, []);
  const rule: Rule = settings?.content_routes ?? { default: null, folders: {} };
  // The providers to choose from: those that can answer, and any the rule or the ledger names.
  const ids = useMemo(() => {
    const out = new Map<string, string>();
    for (const p of report?.providers ?? []) if (p.available) out.set(p.id, p.label);
    const named = [...(rule.default ?? []), ...Object.values(rule.folders).flat(), ...(seen?.folders ?? []).flatMap((f) => Object.keys(f.providers))];
    for (const id of named) if (id && !out.has(id)) out.set(id, labels[id] ?? id);
    return [...out].map(([id, label]) => ({ id, label }));
  }, [report, labels, rule, seen]);
  if (!settings) return null;
  const save = (change: Partial<Record<"default" | "folders", unknown>>) => patch({ content_routes: change }).then(load).catch(reportError);
  const add = () => {
    const f = folder.trim();
    if (!f) return;
    // It starts as every other folder does: the default's providers, else every one that can answer.
    save({ folders: { [f]: rule.default ?? (report?.providers ?? []).filter((p) => p.available).map((p) => p.id) } }).then(() => setFolder(""));
  };
  const folders = Object.entries(rule.folders).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="flex flex-col gap-6" data-testid="content-routes">
      <Card>
        <SettingRow label="Every other folder" hint="The providers that may see the content of sessions in a folder not named below. Any provider: nothing is held back.">
          <Providers any value={rule.default} ids={ids} label="Providers for every other folder" onChange={(v) => save({ default: v })} />
        </SettingRow>
        {folders.map(([path, providers]) => (
          <div key={path} className="k-setting flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:gap-8" data-testid="route-folder" data-name={path}>
            <div className="min-w-0 flex-1">
              <div className="flex"><PathText path={path} className="font-mono text-ui font-medium" /></div>
              <div className="mt-0.5 text-ui text-muted">Its sessions, and the agents they start, send content to {allowedWords(providers)} only.</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Providers value={providers} ids={ids} label={`Providers for ${path}`} onChange={(v) => save({ folders: { [path]: v ?? [] } })} />
              <button type="button" className="grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg" aria-label={`Remove ${path}`} onClick={() => save({ folders: { [path]: null } })}>
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
        <SettingRow label="Add a folder" hint="A folder covers the folders under it; the deepest one named decides.">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="k-field w-72 font-mono" placeholder="/path/to/folder or ~/folder" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder" data-testid="route-folder-path" />
            <button type="submit" className="k-btn k-btn-lg" disabled={!folder.trim()}>Add</button>
          </form>
        </SettingRow>
      </Card>


      <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="content-seen">
        <div className="mb-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-medium">Who saw what</h3>
            <div className="text-ui text-muted" data-testid="content-seen-total">
              {seen ? <>{seen.calls.toLocaleString()} model call{seen.calls === 1 ? "" : "s"} in the last 30 days{seen.crossing ? <>, <span className="text-danger">{seen.crossing.toLocaleString()} outside today's rule</span></> : ", none outside today's rule"}.</> : "Reading the ledger."}
            </div>
          </div>
          <button type="button" className="k-btn" onClick={() => void load()} disabled={busy}><RefreshCw className={cn(busy && "animate-spin")} />Refresh</button>
        </div>
        {seen && !seen.folders.length && <p className="k-empty">No model calls in the last 30 days.</p>}
        {seen?.folders.map((f) => (
          <div key={f.folder || "none"} className="border-t border-line pt-3 pb-2" data-testid="seen-folder" data-folder={f.folder}>
            <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
              <span className="flex min-w-0 flex-1">{f.folder ? <PathText path={f.folder} className="font-mono text-ui font-medium" /> : <span className="text-ui text-muted">A removed session</span>}</span>
              <span className="text-caption text-faint">allowed: {allowedWords(f.allowed)}{f.by && f.by !== f.folder ? ` (by ${f.by})` : ""}</span>
            </div>
            <div className="-mx-4 overflow-x-auto">
              <table className="w-full text-ui">
                <thead>
                  <tr className="border-b border-line text-left text-caption text-faint">
                    <th className={th}>Session</th><th className={th}>Purpose</th><th className={th}>Provider</th><th className={cn(th, "text-right")}>Calls</th><th className={cn(th, "text-right")}>Outside the rule</th>
                  </tr>
                </thead>
                <tbody>
                  {f.sessions.flatMap((s) => s.rows.map((r, i) => (
                    <tr key={`${s.id}-${r.purpose}-${r.provider}`} className="border-b border-line/60 last:border-0" data-testid="seen-row" data-crossing={r.crossing ? "" : undefined} data-purpose={r.purpose} data-provider={r.provider}>
                      <td className={cn(td, "max-w-72")}>
                        {i === 0 && (
                          <button type="button" className="k-link block max-w-full truncate text-left text-accent hover:underline" onClick={() => navigate({ name: "session", id: s.id })}>
                            {sessions[s.id]?.title || s.title || s.id.slice(-12)}{s.agents ? <span className="text-faint"> and {s.agents} agent{s.agents === 1 ? "" : "s"}</span> : null}
                          </button>
                        )}
                      </td>
                      <td className={cn(td, "text-muted")}>{r.purpose}</td>
                      <td className={cn(td, r.crossing ? "text-danger" : "text-muted")}>{labels[r.provider] ?? r.provider}</td>
                      <td className={cn(td, "text-right")}>{r.calls.toLocaleString()}</td>
                      <td className={cn(td, "text-right", r.crossing ? "font-medium text-danger" : "text-faint")}>{r.crossing ? r.crossing.toLocaleString() : "none"}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </section>

      <details className="rounded-lg border border-line bg-raised px-5 py-3 shadow-1" data-testid="route-instead">
        <summary className="cursor-pointer text-base font-medium">When a call would cross</summary>
        <p className="mt-1 text-ui text-muted">It is not sent, and the session's failures say so once, with the purpose and the provider. Then, by purpose:</p>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-ui">
          {(Object.keys(INSTEAD) as RoutePurpose[]).map((p) => <div key={p} className="contents"><dt className="font-medium">{p}</dt><dd className="text-muted">{INSTEAD[p]}</dd></div>)}
        </dl>
      </details>
    </div>
  );
}
