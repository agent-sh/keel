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
import { Cell, Disclosure, Empty, Group, Page, Row, SettingRow, Table, type Col } from "./settings/kit.tsx";
import { useSettings } from "./StoragePanel.tsx";

type Rule = { default: string[] | null; folders: Record<string, string[]> };
type Report = Seen & { since_ms: number; rule: Rule };

// One toggle per provider; `any` adds the choice of no limit (the default's null).
function Providers({ value, ids, label, onChange, any }: { value: string[] | null; ids: { id: string; label: string }[]; label: string; onChange: (v: string[] | null) => void; any?: boolean }) {
  return (
    <div role="group" aria-label={label} className="flex max-w-[36rem] flex-wrap gap-1.5 sm:justify-end" data-testid="route-providers">
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
  const C: Record<string, Col> = { session: { head: "Session", grow: true }, purpose: { head: "Purpose", minor: true }, provider: { head: "Provider", minor: true }, calls: { head: "Calls", end: true }, outside: { head: "Outside the rule", end: true } };
  return (
    <Page testid="content-routes">
      <Group title="Providers per folder" hint="Which providers may see the content of the sessions in a folder, and the agents they start.">
        <SettingRow label="Every other folder" hint="The providers that may see the content of sessions in a folder not named below. Any provider: nothing is held back.">
          <Providers any value={rule.default} ids={ids} label="Providers for every other folder" onChange={(v) => save({ default: v })} />
        </SettingRow>
        {folders.map(([path, providers]) => (
          <SettingRow key={path} testid="route-folder" data-name={path} label={<span className="flex"><PathText path={path} className="font-mono text-ui font-medium" /></span>}
            hint={`Its sessions, and the agents they start, send content to ${allowedWords(providers)} only.`}>
            <div className="flex items-center gap-2">
              <Providers value={providers} ids={ids} label={`Providers for ${path}`} onChange={(v) => save({ folders: { [path]: v ?? [] } })} />
              <button type="button" className="grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-fg" aria-label={`Remove ${path}`} onClick={() => save({ folders: { [path]: null } })}>
                <X className="size-3.5" />
              </button>
            </div>
          </SettingRow>
        ))}
        <SettingRow label="Add a folder" hint="A folder covers the folders under it; the deepest one named decides.">
          <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input className="k-field w-72 max-w-full font-mono" placeholder="/path/to/folder or ~/folder" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder" data-testid="route-folder-path" />
            <button type="submit" className="k-btn k-btn-lg" disabled={!folder.trim()}>Add</button>
          </form>
        </SettingRow>
      </Group>

      <Group testid="content-seen" title="Who saw what" bare
        hint={<span data-testid="content-seen-total">{seen ? <>{seen.calls.toLocaleString()} model call{seen.calls === 1 ? "" : "s"} in the last 30 days{seen.crossing ? <>, <span className="text-danger">{seen.crossing.toLocaleString()} outside today's rule</span></> : ", none outside today's rule"}.</> : "Reading the ledger."}</span>}
        actions={<button type="button" className="k-btn" onClick={() => void load()} disabled={busy}><RefreshCw className={cn(busy && "animate-spin")} />Refresh</button>}>
        {seen && !seen.folders.length && <Group><Empty>No model calls in the last 30 days.</Empty></Group>}
        {seen?.folders.map((f) => (
          <Group key={f.folder || "none"} testid="seen-folder" data-folder={f.folder}
            title={f.folder ? <PathText path={f.folder} className="font-mono text-ui font-medium" /> : <span className="text-ui text-muted">A removed session</span>}
            hint={`allowed: ${allowedWords(f.allowed)}${f.by && f.by !== f.folder ? ` (by ${f.by})` : ""}`}>
            <Table cols={Object.values(C)} label={`Content seen from ${f.folder || "removed sessions"}`}>
              {f.sessions.flatMap((s) => s.rows.map((r, i) => (
                <Row key={`${s.id}-${r.purpose}-${r.provider}`} testid="seen-row" data-crossing={r.crossing ? "" : undefined} data-purpose={r.purpose} data-provider={r.provider}
                  name={i === 0 ? (
                    <button type="button" className="k-link max-w-full truncate text-left text-accent hover:underline" onClick={() => navigate({ name: "session", id: s.id })}>
                      {sessions[s.id]?.title || s.title || s.id.slice(-12)}{s.agents ? <span className="text-faint"> and {s.agents} agent{s.agents === 1 ? "" : "s"}</span> : null}
                    </button>
                  ) : null}>
                  <Cell col={C.purpose!} className="text-muted">{r.purpose}</Cell>
                  <Cell col={C.provider!} className={r.crossing ? "text-danger" : "text-muted"}>{labels[r.provider] ?? r.provider}</Cell>
                  <Cell col={C.calls!}>{r.calls.toLocaleString()}</Cell>
                  <Cell col={C.outside!} className={r.crossing ? "font-medium text-danger" : "text-faint"}>{r.crossing ? r.crossing.toLocaleString() : "none"}</Cell>
                </Row>
              )))}
            </Table>
          </Group>
        ))}
      </Group>

      <Group title="How a rule works" bare>
        <Disclosure testid="route-instead" summary="When a call would cross">
          <p>It is not sent, and the session's failures say so once, with the purpose and the provider. Then, by purpose:</p>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1">
            {(Object.keys(INSTEAD) as RoutePurpose[]).map((p) => <div key={p} className="contents"><dt className="font-medium">{p}</dt><dd className="text-muted">{INSTEAD[p]}</dd></div>)}
          </dl>
        </Disclosure>
        <Disclosure testid="route-scope" summary="What a folder's rule covers">
          <ul className="flex list-disc flex-col gap-1 pl-5">
            <li>Sessions opened in the folder or a folder under it, and every agent they start.</li>
            <li>A session in a worktree made from the folder, the agents' worktrees included: it counts as the folder it was made from.</li>
            <li>A folder reached through a link is its real folder: the rule holds either way it is written.</li>
            <li>Not a session opened in a parent folder of a named one: it follows the parent's rule, or the one for every other folder, even when it reads files inside the named folder.</li>
            <li>Not a session on another machine of the fleet: it follows that machine's own rule.</li>
          </ul>
        </Disclosure>
      </Group>
    </Page>
  );
}
